/**
 * pi-web — the lab's Crawl4AI as the tools the model reaches for without thinking.
 *
 * pi-searxng's `web_search` is used with confidence because it is the only way to
 * search: one tool, an obvious name, a short answer. Reading a page had four ways —
 * pi-searxng's `fetch_content` (plain fetch from this Mac, no JS), the seven `fetch_*`
 * tools the MCP adapter exposes from fetch.rezolver-zero.com, and curl through bash —
 * and none of them answered the question a search result list raises first: which of
 * these links are alive, and what are they. So the model wrote a curl loop for the
 * status codes and titles, then went to `fetch_md` for the survivors, and pages that
 * only render with JS came back as `<title>Search`.
 *
 * So the tools are split by the question, not by the endpoint:
 * - `web_peek` — many URLs, one call: status, final URL, title, description. It is
 *   POST /crawl, which already carries `status_code`, `redirected_url` and
 *   `metadata`; the tool throws away the rest (html, links, media — megabytes).
 * - `web_read` — one URL as markdown, cut to a window the model can page through.
 *   It is POST /md, which has the content filters /crawl lacks without a config.
 * - `web_screenshot`, `web_pdf` — a page as a PNG or a PDF on this machine. The
 *   server stores both as artifacts and answers with the bytes in base64 as well;
 *   the tools write those bytes to a file, because a path is something the user can
 *   open and an artifact id behind a token is not.
 *
 * Why /md falls back. A content filter answers an empty page with `success: true`
 * (srv02/services/README.md, Gotchas): bm25 with a query nothing matches, or fit on a
 * page Readability cannot shape. An empty answer is retried down bm25 → fit → raw
 * before it is reported as empty, and the filter that produced the text is named.
 *
 * Why the competitors are switched off here. A better tool next to the old ones is a
 * fifth way, not a replacement. pi-searxng's `fetch_content` is removed from the
 * active set on every session start. The fetcher's own MCP tools (`fetch_*`) are
 * removed too: everything they did that works is here, and `fetch_execute_js` never
 * worked — the server keeps that endpoint off on purpose (srv02/fetch/README.md) and
 * answers 403. Their adapter entry is gone from mcp-adapter.json; the names stay in
 * the list so that re-adding it does not bring back a second way. Bash stays; the
 * guidelines say what curl is still for.
 *
 * Config: ~/.pi/agent/web.json — the same directory and plaintext convention as
 * tts.json and image.json, and every key optional. Read on every call, like the
 * token file it names, so an edit or a rotation needs no restart. The token lives in
 * a file and never in the config: on this OS argv and env are readable by every
 * process of the same user, and a config gets pasted into chats.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "web.json");

type Config = {
	/** Origin of the Crawl4AI HTTP API. The LAN address skips the gateway: http://192.168.100.31:11235 */
	endpoint: string;
	/** File holding the bearer token, 0600. The name predates this extension: the MCP adapter read it first. */
	tokenFile: string;
	/** Where screenshots and PDFs go when the caller names no path. */
	dir: string;
};

const DEFAULTS: Config = {
	endpoint: "https://fetch.rezolver-zero.com",
	tokenFile: "~/.pi/agent/mcp/c4a.token",
	dir: "~/Downloads/pi-web",
};

function loadConfig(): Config {
	let raw: Partial<Config> = {};
	try {
		raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
	} catch {
		/* no config file: the defaults are the working ones */
	}
	const cfg = { ...DEFAULTS, ...raw };
	return { ...cfg, endpoint: cfg.endpoint.replace(/\/+$/, "") };
}

function expand(p: string): string {
	return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

const RETIRED = [
	"fetch_content",
	"fetch_md",
	"fetch_html",
	"fetch_crawl",
	"fetch_ask",
	"fetch_execute_js",
	"fetch_screenshot",
	"fetch_pdf",
];
const PEEK_MAX = 10;
const WINDOW = 30_000;
// A cold Chromium page plus a slow site: /crawl runs the URLs concurrently, so the
// batch costs about as much as its slowest member.
const TIMEOUT_MS = 120_000;

function token(cfg: Config): string {
	const file = expand(cfg.tokenFile);
	let t: string;
	try {
		t = readFileSync(file, "utf8").trim();
	} catch {
		throw new Error(`no fetcher token: ${file} is missing or unreadable (tokenFile in ${CONFIG_PATH})`);
	}
	if (!t) throw new Error(`no fetcher token: ${file} is empty`);
	return t;
}

async function post(path: string, body: unknown, signal: AbortSignal | undefined): Promise<any> {
	const cfg = loadConfig();
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const res = await fetch(cfg.endpoint + path, {
		method: "POST",
		headers: { Authorization: `Bearer ${token(cfg)}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	const text = await res.text();
	if (!res.ok) throw new HttpError(res.status, `${path} answered ${res.status}: ${text.slice(0, 300)}`);
	return JSON.parse(text);
}

class HttpError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

// The fetcher's SSRF guard says "URL blocked" for a name that does not resolve as
// well as for a private address, so the row says both.
function explain(message: string): string {
	return /URL blocked/i.test(message)
		? "blocked by the fetcher: the name does not resolve, or it points at a private address"
		: message;
}

type Peeked = {
	url: string;
	status: number | null;
	hop: number | null;
	final: string | null;
	title: string;
	description: string;
	error: string;
};

function clip(s: unknown, n: number): string {
	const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
	return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

async function crawl(urls: string[], signal: AbortSignal | undefined): Promise<any[]> {
	const data = await post("/crawl", { urls }, signal);
	return Array.isArray(data?.results) ? data.results : [];
}

async function peek(urls: string[], signal: AbortSignal | undefined): Promise<Peeked[]> {
	let results: any[];
	try {
		results = await crawl(urls, signal);
	} catch (e) {
		// /crawl refuses the whole request with 400 when one URL fails validation —
		// observed with a single name that does not resolve — so the batch is retried
		// per URL and only the bad one carries the error.
		if (!(e instanceof HttpError) || e.status !== 400) throw e;
		results = await Promise.all(
			urls.map((u) =>
				crawl([u], signal).then(
					(r) => r[0] ?? { url: u, success: false, error_message: "no result for this URL" },
					(err) => {
						if (!(err instanceof HttpError) || err.status !== 400) throw err;
						return { url: u, success: false, error_message: err.message };
					},
				),
			),
		);
	}
	return urls.map((u) => {
		const r = results.find((x) => x?.url === u) ?? {};
		const final =
			typeof r.redirected_url === "string" && r.redirected_url.replace(/\/$/, "") !== u.replace(/\/$/, "")
				? r.redirected_url
				: null;
		const first = typeof r.status_code === "number" ? r.status_code : null;
		// status_code is the first hop's (307 for http://go.dev); the page the model
		// would read is the one after the redirect.
		const last = final && typeof r.redirected_status_code === "number" ? r.redirected_status_code : first;
		return {
			url: u,
			status: last,
			hop: final && first !== last ? first : null,
			final,
			title: clip(r.metadata?.title, 160),
			description: clip(r.metadata?.description, 240),
			error:
				r.success === false || !results.length ? clip(explain(r.error_message || "no result for this URL"), 240) : "",
		};
	});
}

function formatPeek(rows: Peeked[]): string {
	return rows
		.map((r) => {
			const head = `${r.status ?? "---"} ${r.url}${r.final ? ` → ${r.final}` : ""}${r.hop ? ` (via ${r.hop})` : ""}`;
			const lines = [head];
			if (r.error) lines.push(`  error: ${r.error}`);
			if (r.title) lines.push(`  title: ${r.title}`);
			if (r.description) lines.push(`  description: ${r.description}`);
			return lines.join("\n");
		})
		.join("\n");
}

type Read = { markdown: string; filter: string };

// A cut at a fixed character count lands mid-line, mid-code-block ("ype SyncedBuffer"
// at offset 30000 of effective_go), so the window ends at the last blank line, or the
// last newline, in its final fifth — and the next offset starts exactly there.
function cut(md: string, offset: number): string {
	const end = offset + WINDOW;
	if (end >= md.length) return md.slice(offset);
	const floor = offset + Math.floor(WINDOW * 0.8);
	for (const sep of ["\n\n", "\n"]) {
		const at = md.lastIndexOf(sep, end);
		if (at >= floor) return md.slice(offset, at + sep.length);
	}
	return md.slice(offset, end);
}

async function read(
	url: string,
	query: string | undefined,
	raw: boolean,
	signal: AbortSignal | undefined,
): Promise<Read> {
	const chain = raw ? ["raw"] : query ? ["bm25", "fit", "raw"] : ["fit", "raw"];
	for (const f of chain) {
		const data = await post("/md", query && f === "bm25" ? { url, f, q: query } : { url, f }, signal);
		const md = typeof data?.markdown === "string" ? data.markdown : "";
		if (md.trim()) return { markdown: md, filter: f };
	}
	return { markdown: "", filter: chain[chain.length - 1] };
}

type Saved = { path: string; bytes: number; mime: string; data: string };

function slug(url: string): string {
	return (
		url
			.replace(/^https?:\/\//, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 50)
			.replace(/-+$/, "") || "page"
	);
}

function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** POST /screenshot or /pdf and write the base64 the server returns alongside its artifact id. */
async function capture(
	kind: "screenshot" | "pdf",
	url: string,
	body: Record<string, unknown>,
	path: string | undefined,
	signal: AbortSignal | undefined,
): Promise<Saved> {
	const data = await post(`/${kind}`, { url, ...body }, signal);
	const b64 = typeof data?.[kind] === "string" ? data[kind] : "";
	if (!b64) throw new Error(`/${kind} answered without ${kind} bytes: ${clip(JSON.stringify(data), 200)}`);
	const ext = kind === "pdf" ? ".pdf" : ".png";
	const mime = kind === "pdf" ? "application/pdf" : "image/png";
	const target = path ? resolve(expand(path)) : join(expand(loadConfig().dir), `${stamp()}-${slug(url)}`);
	const file = extname(target) ? target : target + ext;
	mkdirSync(dirname(file), { recursive: true });
	const buf = Buffer.from(b64, "base64");
	writeFileSync(file, buf);
	return { path: file, bytes: buf.length, mime, data: b64 };
}

function kib(n: number): string {
	return `${(n / 1024).toFixed(0)} KiB`;
}

function retire(pi: ExtensionAPI) {
	const active = pi.getActiveTools();
	const kept = active.filter((n) => !RETIRED.includes(n));
	if (kept.length !== active.length) pi.setActiveTools(kept);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "web_peek",
			label: "Web Peek",
			description:
				"Check up to 10 URLs in one call through the lab's Crawl4AI (a real browser, JS rendered): " +
				"HTTP status, final URL after redirects, page title and meta description. No page content.",
			promptSnippet: "Check many URLs at once: status, redirect, title, description",
			promptGuidelines: [
				"Use web_peek to triage links from web_search before reading any of them — which are alive, which " +
					"redirect, what each page is. Pass all candidates in one call instead of looping.",
				"Use web_peek and web_read instead of curl, wget or any fetch-like tool for web pages. curl is only " +
					"for raw HTTP work these tools do not cover: custom headers, methods, APIs that answer JSON.",
			],
			parameters: Type.Object({
				urls: Type.Array(Type.String(), {
					description: `1..${PEEK_MAX} absolute http(s) URLs`,
					minItems: 1,
					maxItems: PEEK_MAX,
				}),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
			async execute(_id, args, signal) {
				const urls = [...new Set((args as { urls: string[] }).urls.map((u) => u.trim()).filter(Boolean))].slice(
					0,
					PEEK_MAX,
				);
				const rows = await peek(urls, signal);
				const alive = rows.filter((r) => r.status !== null && r.status < 400).length;
				return {
					content: [{ type: "text", text: formatPeek(rows) }],
					details: { count: rows.length, alive, rows },
				};
			},
			renderCall(args: any, theme: any) {
				const n = Array.isArray(args?.urls) ? args.urls.length : 0;
				const first = n ? String(args.urls[0]) : "";
				const shown = first.length > 50 ? first.slice(0, 47) + "..." : first;
				return new Text(
					theme.fg("toolTitle", "peek ") + theme.fg("accent", shown) + (n > 1 ? theme.fg("muted", ` +${n - 1}`) : ""),
					0,
					0,
				);
			},
			renderResult(result: any, _opts: any, theme: any) {
				const d = result.details;
				if (!d?.count) return new Text(theme.fg("error", clip(result.content?.[0]?.text ?? "failed", 100)), 0, 0);
				return new Text(theme.fg("success", `${d.alive}/${d.count} alive`), 0, 0);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "web_read",
			label: "Web Read",
			description:
				"Read one web page as markdown through the lab's Crawl4AI (a real browser, JS rendered). " +
				`Returns up to ${WINDOW} characters starting at \`offset\`; the result says when more remains. ` +
				"With `query`, keeps only the parts relevant to it (BM25).",
			promptSnippet: "Read a web page as markdown (JS rendered), with optional relevance filter",
			promptGuidelines: [
				"web_read cleans the page to its main content by default. If the result looks like it lost what you " +
					"need — tables, navigation, code listings — call it again with raw: true.",
				"Use query only to pull one fact out of a long page. To learn what a page is or contains, read it without " +
					"query: BM25 on a landing page keeps a few hundred characters and loses the structure.",
				"For a long page, read on with the offset the result names instead of guessing.",
			],
			parameters: Type.Object({
				url: Type.String({ description: "Absolute http(s) URL" }),
				query: Type.Optional(Type.String({ description: "Keep only passages relevant to this query" })),
				raw: Type.Optional(Type.Boolean({ description: "Whole page converted as-is, no content filter" })),
				offset: Type.Optional(
					Type.Number({ description: "Character offset to start from, for paging a long page. Default 0." }),
				),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
			async execute(_id, args, signal) {
				const a = args as { url: string; query?: string; raw?: boolean; offset?: number };
				const query = a.query?.trim() || undefined;
				const r = await read(a.url.trim(), query, a.raw === true, signal);
				const total = r.markdown.length;
				if (!total) {
					return {
						content: [
							{
								type: "text",
								text: `Empty page: every filter returned nothing for ${a.url}. Check it with web_peek — a dead link and an unrenderable page look the same here.`,
							},
						],
						details: { url: a.url, filter: r.filter, length: 0, offset: 0, shown: 0 },
					};
				}
				const offset = Math.max(0, Math.min(Math.floor(a.offset ?? 0), total));
				const chunk = cut(r.markdown, offset);
				const end = offset + chunk.length;
				const head =
					`[filter=${r.filter}, ${total} characters` +
					(offset || end < total ? `, showing ${offset}–${end}` : "") +
					"]" +
					(query && r.filter !== "bm25" ? ` [nothing matched the query; fell back to ${r.filter}]` : "");
				const tail = end < total ? `\n\n[continue with offset: ${end}]` : "";
				return {
					content: [{ type: "text", text: head + "\n\n" + chunk + tail }],
					details: { url: a.url, filter: r.filter, length: total, offset, shown: chunk.length },
				};
			},
			renderCall(args: any, theme: any) {
				const url = String(args?.url ?? "");
				const shown = url.length > 50 ? url.slice(0, 47) + "..." : url;
				const extra = args?.query ? theme.fg("muted", ` "${clip(args.query, 30)}"`) : "";
				return new Text(theme.fg("toolTitle", "read ") + theme.fg("accent", shown) + extra, 0, 0);
			},
			renderResult(result: any, _opts: any, theme: any) {
				const d = result.details;
				if (!d) return new Text(theme.fg("error", clip(result.content?.[0]?.text ?? "failed", 100)), 0, 0);
				if (!d.length) return new Text(theme.fg("warning", "empty"), 0, 0);
				const more = d.offset + d.shown < d.length ? theme.fg("warning", ` of ${d.length}`) : "";
				return new Text(theme.fg("success", `${d.shown} chars`) + more + theme.fg("muted", ` ${d.filter}`), 0, 0);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "web_screenshot",
			label: "Web Screenshot",
			description:
				"Take a full-page PNG screenshot of a web page through the lab's Crawl4AI (a real browser) and save it " +
				"to a file. The result names the file and shows the picture back to you.",
			promptSnippet: "Screenshot a web page to a PNG file",
			promptGuidelines: [
				"Use web_screenshot when the layout or a picture matters — what a page looks like, a chart, a broken " +
					"render. For what a page says, web_read is cheaper and exact.",
			],
			parameters: Type.Object({
				url: Type.String({
					description: "Absolute http(s) URL of a page (not an image file: the browser renders pages)",
				}),
				wait: Type.Optional(Type.Number({ description: "Seconds to wait after load before the capture. Default 2." })),
				images: Type.Optional(Type.Boolean({ description: "Wait for images to finish loading" })),
				path: Type.Optional(
					Type.String({ description: "Where to write. Default: the configured directory, named by time and URL." }),
				),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
			async execute(_id, args, signal, _onUpdate, ctx) {
				const a = args as { url: string; wait?: number; images?: boolean; path?: string };
				const body: Record<string, unknown> = {};
				if (a.wait !== undefined) body.screenshot_wait_for = a.wait;
				if (a.images !== undefined) body.wait_for_images = a.images;
				const out = await capture("screenshot", a.url.trim(), body, a.path, signal);
				// pi swaps the image block for a placeholder when the model takes text only,
				// and a model handed a placeholder describes a picture it never saw (pi-image).
				const sees = (ctx.model?.input ?? []).includes("image");
				const blind = sees
					? ""
					: `\nYou have NOT seen this: the active model (${ctx.model?.id ?? "unknown"}) takes text input, so pi dropped the image block. The file is real; do not describe its contents.`;
				return {
					content: [
						{ type: "text", text: `Saved ${a.url} to:\n${out.path} (${kib(out.bytes)})${blind}` },
						{ type: "image", data: out.data, mimeType: out.mime },
					],
					details: { url: a.url, path: out.path, bytes: out.bytes, seen_by_model: sees },
				};
			},
			renderCall(args: any, theme: any) {
				const url = String(args?.url ?? "");
				return new Text(
					theme.fg("toolTitle", "screenshot ") + theme.fg("accent", url.length > 50 ? url.slice(0, 47) + "..." : url),
					0,
					0,
				);
			},
			renderResult(result: any, _opts: any, theme: any) {
				const d = result.details;
				if (!d) return new Text(theme.fg("error", clip(result.content?.[0]?.text ?? "failed", 100)), 0, 0);
				return new Text(theme.fg("success", kib(d.bytes)) + theme.fg("muted", ` ${d.path}`), 0, 0);
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "web_pdf",
			label: "Web PDF",
			description:
				"Print a web page to a PDF file through the lab's Crawl4AI (a real browser). The result names the file.",
			promptSnippet: "Save a web page as a PDF file",
			parameters: Type.Object({
				url: Type.String({ description: "Absolute http(s) URL of a page" }),
				path: Type.Optional(
					Type.String({ description: "Where to write. Default: the configured directory, named by time and URL." }),
				),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
			async execute(_id, args, signal) {
				const a = args as { url: string; path?: string };
				const out = await capture("pdf", a.url.trim(), {}, a.path, signal);
				return {
					content: [{ type: "text", text: `Saved ${a.url} to:\n${out.path} (${kib(out.bytes)})` }],
					details: { url: a.url, path: out.path, bytes: out.bytes },
				};
			},
			renderCall(args: any, theme: any) {
				const url = String(args?.url ?? "");
				return new Text(
					theme.fg("toolTitle", "pdf ") + theme.fg("accent", url.length > 50 ? url.slice(0, 47) + "..." : url),
					0,
					0,
				);
			},
			renderResult(result: any, _opts: any, theme: any) {
				const d = result.details;
				if (!d) return new Text(theme.fg("error", clip(result.content?.[0]?.text ?? "failed", 100)), 0, 0);
				return new Text(theme.fg("success", kib(d.bytes)) + theme.fg("muted", ` ${d.path}`), 0, 0);
			},
		}),
	);

	// What the model is actually offered, read from pi and not from the model: a long
	// session remembers tool names from before a change, and a model asked "what tools
	// do you have" answers from that memory (observed: fetch_screenshot listed and
	// "called" as text after its server was gone, web_screenshot denied).
	pi.registerCommand("web", {
		description: "pi-web: which web tools the model is offered, and the config in force",
		handler: async (_args, ctx) => {
			const cfg = loadConfig();
			const active = new Set(pi.getActiveTools());
			const ours = ["web_peek", "web_read", "web_screenshot", "web_pdf"];
			const missing = ours.filter((n) => !active.has(n));
			const leftover = [...active].filter((n) => RETIRED.includes(n) || /^mcp__fetch/.test(n));
			let tok = "ok";
			try {
				token(cfg);
			} catch (e) {
				tok = (e as Error).message;
			}
			const lines = [
				missing.length ? `inactive: ${missing.join(", ")}` : `active: ${ours.join(", ")}`,
				leftover.length
					? `still offered (should not be): ${leftover.join(", ")}`
					: "no fetch_* / mcp__fetch tools offered",
				`endpoint ${cfg.endpoint} · token ${tok} · dir ${expand(cfg.dir)}`,
			];
			(ctx as unknown as ExtensionContext).ui.notify(
				lines.join("\n"),
				missing.length || leftover.length || tok !== "ok" ? "warning" : "info",
			);
		},
	});

	pi.on("session_start", (_event, _ctx: ExtensionContext) => retire(pi));
	// The MCP adapter connects after load, so its tools can arrive after session_start.
	pi.on("before_agent_start", () => {
		retire(pi);
	});
}
