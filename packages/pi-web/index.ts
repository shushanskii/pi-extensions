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
 * (the fetch service's README, Gotchas): bm25 with a query nothing matches, or fit on a
 * page Readability cannot shape. An empty answer is retried down the chain — bm25 → fit
 * → raw with a query, fit → raw without one, raw alone when asked for — before it is
 * reported as empty, and the header of every answer names the filter that produced it.
 *
 * Why the competitors are switched off here. A better tool next to the old ones is a
 * fifth way, not a replacement. `retire()` drops the retired names from the active tool
 * set on every session start, and again before every agent start because the MCP adapter
 * connects after load. The names it drops are pi-searxng's `fetch_content` and the seven
 * `fetch_*` the fetcher's MCP adapter exposed: everything they did that works is here,
 * and `fetch_execute_js` never worked — the server keeps that endpoint off on purpose
 * (the fetch service's README) and answers 403. Their adapter entry is gone from
 * mcp-adapter.json; the names stay in the list so that re-adding it does not bring back
 * a second way, and `/web` names any survivor — under these names, or under an
 * `mcp__fetch…` prefix this file does not match — rather than keeping silent about a
 * tool it did not remove. Bash stays; the guidelines say what curl is still for.
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
import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "web.json");

interface Config {
	/** Origin of the Crawl4AI HTTP API. A LAN address instead of the domain skips the gateway. */
	endpoint: string;
	/** File holding the bearer token, 0600. The name predates this extension: the MCP adapter read it first. */
	tokenFile: string;
	/** Where screenshots and PDFs go when the caller names no path. */
	dir: string;
}

const DEFAULTS: Config = {
	endpoint: "https://fetch.rezolver-zero.com",
	tokenFile: "~/.pi/agent/mcp/c4a.token",
	dir: "~/Downloads/pi-web",
};

// How much of a server error body is quoted back before the quote stops being useful.
const ERROR_BODY_CHARS = 300;
// One-line clips in the peek table: a long title pushes the following row off the screen.
const TITLE_CHARS = 160;
const DESCRIPTION_CHARS = 240;
const ERROR_CHARS = 240;
const FAILURE_CHARS = 100;
const CAPTURE_CHARS = 200;
// A URL in a tool header; the front of a URL is the part that identifies it.
const URL_CHARS = 50;
// A query quoted next to a read's URL; it only has to say which search this was.
const QUERY_CHARS = 30;
// A file-name slug made from a URL.
const SLUG_MAX = 50;
const BYTES_PER_KIB = 1024;
// The boundary a window may end at is sought in the last fifth of that window; looking
// earlier would shrink the window for one stray blank line.
const CUT_TAIL_RATIO = 0.8;

const TRAILING_SLASH = /\/$/u;
const TRAILING_SLASHES = /\/+$/u;
const URL_PREFIX = /^https?:\/\//u;
const NOT_SLUG = /[^a-z0-9]+/gu;
const EDGE_DASHES = /^-+|-+$/gu;
const TRAILING_DASH = /-+$/u;
const WHITESPACE_RUN = /\s+/gu;
const BLOCKED = /URL blocked/iu;
// The adapter's other possible spelling, read by `/web` only: a tool matching it is a
// second way to read a page still on the menu, and `retire()` cannot match it to remove it.
const MCP_FETCH_TOOL = /^mcp__fetch/u;

// The fetcher's answers are JSON of a shape this file does not own, so they are read field by
// field. The snake_case keys are its wire names and appear only as string keys, never as
// identifiers of this file.
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const raw = value[key];
	if (typeof raw === "string") {
		return raw;
	}
	return undefined;
}

function numberField(value: unknown, key: string): number | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const raw = value[key];
	if (typeof raw === "number") {
		return raw;
	}
	return undefined;
}

// The one-line shape of a thrown value, for a notice.
function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

// Cut to `max` characters, marking that something was cut.
function shorten(value: string, max: number, mark = "..."): string {
	if (value.length <= max) {
		return value;
	}
	return `${value.slice(0, max - mark.length)}${mark}`;
}

// The first text block of a tool result: where an answer that is not a result puts its
// sentence, and the only thing worth showing when a renderer has no details.
function firstText(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}
	const [first] = content;
	return stringField(first, "text") ?? "";
}

function failureLine(theme: Theme, content: unknown): Text {
	return new Text(theme.fg("error", clip(firstText(content) || "failed", FAILURE_CHARS)), 0, 0);
}

// A tool's one-line header: the verb in the title colour, the target in the accent colour.
function toolHeader(theme: Theme, verb: string, target: string): Text {
	return new Text(theme.fg("toolTitle", verb) + theme.fg("accent", shorten(target, URL_CHARS)), 0, 0);
}

// A capture's details, read rather than assumed: pi's defineTool does not infer the details
// type for the two capture tools, so their renderers ask the object instead of trusting it.
function savedDetails(details: unknown): { path: string; bytes: number } | undefined {
	const path = stringField(details, "path");
	const bytes = numberField(details, "bytes");
	if (!path || bytes === undefined) {
		return undefined;
	}
	return { path, bytes };
}

function loadConfig(): Config {
	let raw: Partial<Config> = {};
	try {
		raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
	} catch {
		/* no config file: the defaults are the working ones */
	}
	const cfg = { ...DEFAULTS, ...raw };
	return { ...cfg, endpoint: cfg.endpoint.replace(TRAILING_SLASHES, "") };
}

function expand(p: string): string {
	if (p.startsWith("~")) {
		return join(homedir(), p.slice(1));
	}
	return p;
}

// Tools this file replaces, dropped from the active set by `retire()`: pi-searxng's
// fetch_content plus the seven fetch_* the fetcher's MCP adapter exposed. The match is on
// whole names, so a tool that arrives under another spelling is not removed here — `/web`
// reports it instead of pretending otherwise.
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
// Below this a peek counts the page as alive; 400 is also the one status the fetcher uses to
// refuse a whole batch, which is what makes peek retry URL by URL.
const STATUS_BAD_REQUEST = 400;

function token(cfg: Config): string {
	const file = expand(cfg.tokenFile);
	let t: string;
	try {
		t = readFileSync(file, "utf8").trim();
	} catch (error) {
		throw new Error(`no fetcher token: ${file} is missing or unreadable (tokenFile in ${CONFIG_PATH})`, {
			cause: error,
		});
	}
	if (!t) {
		throw new Error(`no fetcher token: ${file} is empty`);
	}
	return t;
}

async function post(path: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
	const cfg = loadConfig();
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	let abortSignal = timeout;
	if (signal) {
		// Both: pi's abort, so Esc reaches fetch, and our own ceiling, so a hung browser cannot
		// outlive the tool call.
		abortSignal = AbortSignal.any([signal, timeout]);
	}
	const res = await fetch(cfg.endpoint + path, {
		method: "POST",
		// Header names travel as pairs: they are wire data, and as object keys they would look
		// like identifiers this file owns.
		headers: [
			["Authorization", `Bearer ${token(cfg)}`],
			["Content-Type", "application/json"],
		],
		body: JSON.stringify(body),
		signal: abortSignal,
	});
	const text = await res.text();
	if (!res.ok) {
		throw new HttpError(res.status, `${path} answered ${res.status}: ${text.slice(0, ERROR_BODY_CHARS)}`);
	}
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
	if (BLOCKED.test(message)) {
		return "blocked by the fetcher: the name does not resolve, or it points at a private address";
	}
	return message;
}

interface Peeked {
	url: string;
	status: number | null;
	hop: number | null;
	final: string | null;
	title: string;
	description: string;
	error: string;
}

function clip(value: unknown, max: number): string {
	let text = "";
	if (typeof value === "string") {
		text = value.replace(WHITESPACE_RUN, " ").trim();
	}
	return shorten(text, max, "…");
}

async function crawl(urls: string[], signal: AbortSignal | undefined): Promise<unknown[]> {
	const data = await post("/crawl", { urls }, signal);
	if (!(isRecord(data) && Array.isArray(data.results))) {
		return [];
	}
	return data.results;
}

// One URL asked alone. This is the retry path for a batch the fetcher refused wholesale, so a
// refusal of a single bad URL is turned into that URL's own error row.
async function crawlOne(url: string, signal: AbortSignal | undefined): Promise<unknown> {
	try {
		const [first] = await crawl([url], signal);
		if (first) {
			return first;
		}
		return { url, refused: true, reason: "no result for this URL" } satisfies Refusal;
	} catch (error) {
		if (!(error instanceof HttpError) || error.status !== STATUS_BAD_REQUEST) {
			throw error;
		}
		return { url, refused: true, reason: error.message } satisfies Refusal;
	}
}

async function peek(urls: string[], signal: AbortSignal | undefined): Promise<Peeked[]> {
	let results: unknown[];
	try {
		results = await crawl(urls, signal);
	} catch (error) {
		// /crawl refuses the whole request with 400 when one URL fails validation —
		// observed with a single name that does not resolve — so the batch is retried
		// per URL and only the bad one carries the error.
		if (!(error instanceof HttpError) || error.status !== STATUS_BAD_REQUEST) {
			throw error;
		}
		results = await Promise.all(urls.map((u) => crawlOne(u, signal)));
	}
	return urls.map((u) => rowFor(u, results));
}

// A row the fetcher never produced: this URL was refused, and this is why. It is a value of
// this file rather than the fetcher's row wearing the fetcher's key names, which is what keeps
// the two shapes from being mistaken for one another.
interface Refusal {
	url: string;
	refused: true;
	reason: string;
}

function isRefusal(value: unknown): value is Refusal {
	return isRecord(value) && value.refused === true;
}

// One row of the peek table.
function rowFor(url: string, results: unknown[]): Peeked {
	const found = results.find((entry) => isRecord(entry) && entry.url === url);
	let r: Record<string, unknown> = {};
	if (isRecord(found)) {
		r = found;
	}
	const redirected = stringField(r, "redirected_url");
	let final: string | null = null;
	if (redirected && redirected.replace(TRAILING_SLASH, "") !== url.replace(TRAILING_SLASH, "")) {
		final = redirected;
	}
	const first = numberField(r, "status_code") ?? null;
	// status_code is the first hop's (307 for http://go.dev); the page the model would read is
	// the one after the redirect.
	const afterRedirect = numberField(r, "redirected_status_code");
	let last = first;
	if (final && afterRedirect !== undefined) {
		last = afterRedirect;
	}
	let hop: number | null = null;
	if (final && first !== last) {
		hop = first;
	}
	const { metadata } = r;
	let meta: Record<string, unknown> = {};
	if (isRecord(metadata)) {
		meta = metadata;
	}
	let error = "";
	if (isRefusal(found)) {
		error = clip(explain(found.reason), ERROR_CHARS);
	} else if (r.success === false || results.length === 0) {
		error = clip(explain(stringField(r, "error_message") ?? "no result for this URL"), ERROR_CHARS);
	}
	return {
		url,
		status: last,
		hop,
		final,
		title: clip(stringField(meta, "title"), TITLE_CHARS),
		description: clip(stringField(meta, "description"), DESCRIPTION_CHARS),
		error,
	};
}

function formatPeek(rows: Peeked[]): string {
	const blocks: string[] = [];
	for (const r of rows) {
		let head = `${r.status ?? "---"} ${r.url}`;
		if (r.final) {
			head += ` → ${r.final}`;
		}
		if (r.hop) {
			head += ` (via ${r.hop})`;
		}
		const lines = [head];
		if (r.error) {
			lines.push(`  error: ${r.error}`);
		}
		if (r.title) {
			lines.push(`  title: ${r.title}`);
		}
		if (r.description) {
			lines.push(`  description: ${r.description}`);
		}
		blocks.push(lines.join("\n"));
	}
	return blocks.join("\n");
}

interface Read {
	markdown: string;
	filter: string;
}

// A cut at a fixed character count lands mid-line, mid-code-block ("ype SyncedBuffer"
// at offset 30000 of effective_go), so the window ends at the last blank line, or the
// last newline, in its final fifth — and the next offset starts exactly there.
function cut(md: string, offset: number): string {
	const end = offset + WINDOW;
	if (end >= md.length) {
		return md.slice(offset);
	}
	const floor = offset + Math.floor(WINDOW * CUT_TAIL_RATIO);
	for (const sep of ["\n\n", "\n"]) {
		const at = md.lastIndexOf(sep, end);
		if (at >= floor) {
			return md.slice(offset, at + sep.length);
		}
	}
	return md.slice(offset, end);
}

// The filter chain for a request: `raw` wants the page as converted, a query starts at bm25.
function chainFor(raw: boolean, query: string | undefined): string[] {
	if (raw) {
		return ["raw"];
	}
	if (query) {
		return ["bm25", "fit", "raw"];
	}
	return ["fit", "raw"];
}

async function read(
	url: string,
	query: string | undefined,
	raw: boolean,
	signal: AbortSignal | undefined,
): Promise<Read> {
	const chain = chainFor(raw, query);
	// The chain is a ladder of fallbacks: each rung is asked only because the one before it
	// answered with an empty page, so the awaits cannot be run together.
	for (const filter of chain) {
		const request: Record<string, unknown> = { url, f: filter };
		if (query && filter === "bm25") {
			request.q = query;
		}
		// biome-ignore lint/performance/noAwaitInLoops: each rung waits for the one before it
		const data = await post("/md", request, signal);
		const md = stringField(data, "markdown") ?? "";
		if (md.trim()) {
			return { markdown: md, filter };
		}
	}
	return { markdown: "", filter: chain.at(-1) ?? "" };
}

interface Saved {
	path: string;
	bytes: number;
	mime: string;
	data: string;
}

function slug(url: string): string {
	return (
		url
			.replace(URL_PREFIX, "")
			.toLowerCase()
			.replace(NOT_SLUG, "-")
			.replace(EDGE_DASHES, "")
			.slice(0, SLUG_MAX)
			.replace(TRAILING_DASH, "") || "page"
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
	const b64 = stringField(data, kind) ?? "";
	if (!b64) {
		throw new Error(`/${kind} answered without ${kind} bytes: ${clip(JSON.stringify(data), CAPTURE_CHARS)}`);
	}
	const ext = extensionFor(kind);
	const mime = mimeFor(kind);
	let target: string;
	if (path) {
		target = resolve(expand(path));
	} else {
		target = join(expand(loadConfig().dir), `${stamp()}-${slug(url)}`);
	}
	let file = target;
	if (!extname(target)) {
		file = target + ext;
	}
	mkdirSync(dirname(file), { recursive: true });
	const buf = Buffer.from(b64, "base64");
	writeFileSync(file, buf);
	return { path: file, bytes: buf.length, mime, data: b64 };
}

// What a capture is called on disk, and how it is typed to the model.
function extensionFor(kind: "screenshot" | "pdf"): string {
	if (kind === "pdf") {
		return ".pdf";
	}
	return ".png";
}

function mimeFor(kind: "screenshot" | "pdf"): string {
	if (kind === "pdf") {
		return "application/pdf";
	}
	return "image/png";
}

function kib(n: number): string {
	return `${(n / BYTES_PER_KIB).toFixed(0)} KiB`;
}

function retire(pi: ExtensionAPI) {
	const active = pi.getActiveTools();
	const kept = active.filter((n) => !RETIRED.includes(n));
	if (kept.length !== active.length) {
		pi.setActiveTools(kept);
	}
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
				const alive = rows.filter((r) => r.status !== null && r.status < STATUS_BAD_REQUEST).length;
				return {
					content: [{ type: "text", text: formatPeek(rows) }],
					details: { count: rows.length, alive, rows },
				};
			},
			renderCall(args, theme) {
				const { urls } = args;
				let listed: unknown[] = [];
				if (Array.isArray(urls)) {
					listed = urls;
				}
				let shown = "";
				if (listed.length > 0) {
					shown = shorten(String(listed[0]), URL_CHARS);
				}
				let line = theme.fg("toolTitle", "peek ") + theme.fg("accent", shown);
				if (listed.length > 1) {
					line += theme.fg("muted", ` +${listed.length - 1}`);
				}
				return new Text(line, 0, 0);
			},
			renderResult(result, _opts, theme) {
				const d = result.details;
				if (!d?.count) {
					return failureLine(theme, result.content);
				}
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
				let head = `[filter=${r.filter}, ${total} characters`;
				if (offset || end < total) {
					head += `, showing ${offset}–${end}`;
				}
				head += "]";
				if (query && r.filter !== "bm25") {
					head += ` [nothing matched the query; fell back to ${r.filter}]`;
				}
				let tail = "";
				if (end < total) {
					tail = `\n\n[continue with offset: ${end}]`;
				}
				return {
					content: [{ type: "text", text: `${head}\n\n${chunk}${tail}` }],
					details: { url: a.url, filter: r.filter, length: total, offset, shown: chunk.length },
				};
			},
			renderCall(args, theme) {
				let line = theme.fg("toolTitle", "read ") + theme.fg("accent", shorten(String(args.url ?? ""), URL_CHARS));
				if (args.query) {
					line += theme.fg("muted", ` "${clip(args.query, QUERY_CHARS)}"`);
				}
				return new Text(line, 0, 0);
			},
			renderResult(result, _opts, theme) {
				const d = result.details;
				if (!d) {
					return failureLine(theme, result.content);
				}
				if (d.length === 0) {
					return new Text(theme.fg("warning", "empty"), 0, 0);
				}
				let line = theme.fg("success", `${d.shown} chars`);
				if (d.offset + d.shown < d.length) {
					line += theme.fg("warning", ` of ${d.length}`);
				}
				return new Text(line + theme.fg("muted", ` ${d.filter}`), 0, 0);
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
				if (a.wait !== undefined) {
					body.screenshot_wait_for = a.wait;
				}
				if (a.images !== undefined) {
					body.wait_for_images = a.images;
				}
				const out = await capture("screenshot", a.url.trim(), body, a.path, signal);
				// pi swaps the image block for a placeholder when the model takes text only,
				// and a model handed a placeholder describes a picture it never saw (pi-image).
				const sees = (ctx.model?.input ?? []).includes("image");
				let blind = "";
				if (!sees) {
					blind = `\nYou have NOT seen this: the active model (${ctx.model?.id ?? "unknown"}) takes text input, so pi dropped the image block. The file is real; do not describe its contents.`;
				}
				return {
					content: [
						{ type: "text", text: `Saved ${a.url} to:\n${out.path} (${kib(out.bytes)})${blind}` },
						{ type: "image", data: out.data, mimeType: out.mime },
					],
					details: { url: a.url, path: out.path, bytes: out.bytes, seenByModel: sees },
				};
			},
			renderCall(args, theme) {
				return toolHeader(theme, "screenshot ", String(args.url ?? ""));
			},
			renderResult(result, _opts, theme) {
				const saved = savedDetails(result.details);
				if (!saved) {
					return failureLine(theme, result.content);
				}
				return new Text(theme.fg("success", kib(saved.bytes)) + theme.fg("muted", ` ${saved.path}`), 0, 0);
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
			renderCall(args, theme) {
				return toolHeader(theme, "pdf ", String(args.url ?? ""));
			},
			renderResult(result, _opts, theme) {
				const saved = savedDetails(result.details);
				if (!saved) {
					return failureLine(theme, result.content);
				}
				return new Text(theme.fg("success", kib(saved.bytes)) + theme.fg("muted", ` ${saved.path}`), 0, 0);
			},
		}),
	);

	// What the model is actually offered, read from pi and not from the model: a long
	// session remembers tool names from before a change, and a model asked "what tools
	// do you have" answers from that memory (observed: fetch_screenshot listed and
	// "called" as text after its server was gone, web_screenshot denied).
	pi.registerCommand("web", {
		description: "pi-web: which web tools the model is offered, and the config in force",
		// pi types a command handler as Promise-returning; this one only reads state and prints
		// it, so there is nothing to wait for.
		// biome-ignore lint/suspicious/useAwait: the handler type demands a promise, not a wait
		handler: async (_args, ctx) => {
			const cfg = loadConfig();
			const active = new Set(pi.getActiveTools());
			const ours = ["web_peek", "web_read", "web_screenshot", "web_pdf"];
			const missing = ours.filter((n) => !active.has(n));
			const leftover = [...active].filter((n) => RETIRED.includes(n) || MCP_FETCH_TOOL.test(n));
			let tok = "ok";
			try {
				token(cfg);
			} catch (error) {
				tok = messageOf(error);
			}

			let offered = `active: ${ours.join(", ")}`;
			if (missing.length > 0) {
				offered = `inactive: ${missing.join(", ")}`;
			}
			let competing = "no fetch_* / mcp__fetch tools offered";
			if (leftover.length > 0) {
				competing = `still offered (should not be): ${leftover.join(", ")}`;
			}
			const lines = [offered, competing, `endpoint ${cfg.endpoint} · token ${tok} · dir ${expand(cfg.dir)}`];

			let level: "info" | "warning" = "info";
			if (missing.length > 0 || leftover.length > 0 || tok !== "ok") {
				level = "warning";
			}
			(ctx as unknown as ExtensionContext).ui.notify(lines.join("\n"), level);
		},
	});

	pi.on("session_start", (_event, _ctx: ExtensionContext) => retire(pi));
	// The MCP adapter connects after load, so its tools can arrive after session_start.
	pi.on("before_agent_start", () => {
		retire(pi);
	});
}
