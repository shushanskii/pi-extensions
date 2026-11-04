/**
 * pi-image — the lab's qwen-image as a tool the model can call.
 *
 * The box already draws. The lab's LLM host runs stable-diffusion.cpp's sd-server behind
 * llama-swap under the name `qwen-image`, and llama-swap forwards
 * /v1/images/generations to it the way it forwards /v1/audio/speech to piper. This
 * file is the other end: one POST, one PNG on disk, and the same PNG handed back as
 * an image block so the model that asked for it can look at what it asked for.
 *
 * Why a tool and not pi's built-in image-model path: pi can address an image model,
 * but only through codemode (`models.generateImages`), the only implementation it
 * ships is `openrouter-images`, and a self-hosted OpenAI-compatible endpoint still
 * needs an extension registering an `images` provider — plus codemode, which is off
 * by default. A tool is the smaller machine: one registration, no extra setting, and
 * the parameters the model may set are in its own declaration.
 *
 * Why the file is written before the block is returned: a terminal shows no picture,
 * and base64 in a transcript is not something anyone can open. The path is the
 * artifact; the image block exists only so the model can see it. A model whose
 * `input` in ~/.pi/agent/models.json omits "image" receives
 * "(tool image omitted: model does not support images)" in its place, and the file
 * is still on disk — so the path is never left out of the text.
 *
 * Why two endpoints. /v1/images/generations is the OpenAI-shaped one llama-swap
 * documents, and it carries prompt, n, size and output_format and nothing else.
 * Steps, seed and a negative prompt exist only on the SDAPI-shaped
 * /sdapi/v1/txt2img, which llama-swap forwards too. So the tool posts the OpenAI
 * body when the caller asks for nothing exotic, and switches to SDAPI when it names
 * a knob the OpenAI body has no field for. Both answer with base64; SDAPI always
 * answers with PNG whatever `format` says.
 *
 * Why no progress. sd-server reports sampling on /sdapi/v1/progress, but
 * llama-swap forwards txt2img, img2img and loras only, so a poll would have to go
 * through /upstream/qwen-image/ and start the model by itself. A call is one silent
 * wait, and the figures the guidelines quote are from this box: 19s at 256²/20 steps,
 * 57s at 512²/20, and the first call after five idle minutes also pays the weight
 * load, because the ttl in llama-swap.yaml is 300. 1024² is unmeasured and costs
 * about four times the latents per step.
 *
 * Config: ~/.pi/agent/image.json — the same directory and plaintext convention as
 * tts.json. `/image test` proves the whole path for the price of a 256² thumbnail.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "image.json");
const WIDGET = "pi-image";

interface Config {
	/** Root of the OpenAI-compatible API, /v1 included; the SDAPI route hangs off the origin. */
	baseUrl: string;
	/** The llama-swap model name. Its aliases ("image") route too. */
	model: string;
	/** Default "WIDTHxHEIGHT". Both sides stay divisible by 32 and at or under 2048. */
	size: string;
	/** png, jpeg or webp — the OpenAI route only; SDAPI returns PNG. */
	format: string;
	/** Sent on the SDAPI route; the OpenAI route uses the server's --cfg-scale. */
	cfgScale: number;
	/** Where the files go when the caller names no path. */
	dir: string;
	/**
	 * A generation is minutes, not milliseconds. Above ~300s this knob is not the
	 * binding limit: Node's own fetch abandons a response whose headers have not
	 * arrived at 300s (measured: `UND_ERR_HEADERS_TIMEOUT` at 301s). Raising this
	 * only means something once the transport stops being `fetch`.
	 */
	timeoutMs: number;
	/** Hand the finished file to the OS opener, the way the voice hands a WAV to afplay. */
	open: boolean;
}

const DEFAULTS: Config = {
	baseUrl: "https://llm.rezolver-zero.com/v1",
	model: "qwen-image",
	size: "1024x1024",
	format: "png",
	cfgScale: 6.0,
	dir: "~/Pictures/pi",
	timeoutMs: 900_000,
	open: false,
};

// Both sides of a size have to divide evenly into the model's latent grid.
const SIDE_DIVISOR = 32;
const MIN_SIDE = 256;
const MAX_SIDE = 2048;
// One request draws at most this many; the server holds four latents and no more.
const MIN_IMAGES = 1;
const MAX_IMAGES = 4;
// A file-name slug stops being readable well before it stops being unique.
const SLUG_MAX = 40;
// How much of a wrong response is quoted back before the quote stops being informative.
const DETAIL_CHARS = 400;
const PREVIEW_CHARS = 160;
const BYTES_PER_KIB = 1024;
const MS_PER_SECOND = 1000;
// The editor widget refreshes once a second: a generation takes tens of seconds, and a
// counter that moved every 100 ms would only make the wait look longer.
const TICK_MS = 1000;
// The server's own default; 4 steps came back as noise on this model, which is why the tool
// description tells the model not to lower it.
const DEFAULT_STEPS = 20;
// -1 is SDAPI's "pick one", so the default seed is a value rather than an absence.
const SEED_SERVER_PICKS = -1;

// `^1024x1024$`, with both sides named because both are read out of the match.
const SIZE_PATTERN = /^(?<width>\d{3,4})x(?<height>\d{3,4})$/iu;
const NOT_SLUG = /[^a-z0-9]+/gu;
const EDGE_DASHES = /^-+|-+$/gu;
const TRAILING_DASH = /-+$/u;
const TRAILING_SLASH = /\/$/u;
const WHITESPACE_RUN = /\s+/gu;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

// A string field of a parsed JSON body, if that is what it holds.
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

// The base64 payloads of a generation response: the OpenAI image route answers
// `{data: [{b64_json}]}`, SDAPI answers `{images: ["..."]}`. An unknown shape is read field
// by field instead of asserted, so a changed server produces "no image in the response"
// rather than a crash three levels down.
function base64Images(parsed: unknown): string[] {
	if (!isRecord(parsed)) {
		return [];
	}
	const found: string[] = [];
	if (Array.isArray(parsed.data)) {
		for (const item of parsed.data) {
			if (isRecord(item) && typeof item.b64_json === "string") {
				found.push(item.b64_json);
			}
		}
	}
	if (found.length === 0 && Array.isArray(parsed.images)) {
		for (const item of parsed.images) {
			if (typeof item === "string") {
				found.push(item);
			}
		}
	}
	return found;
}

// The three formats this server answers with. SDAPI's txt2img has no output_format and
// always returns PNG, so PNG is the fallback rather than a guess.
function mimeOf(format: string): string {
	if (format === "jpeg") {
		return "image/jpeg";
	}
	if (format === "webp") {
		return "image/webp";
	}
	return "image/png";
}

function extensionOf(mime: string): string {
	if (mime === "image/jpeg") {
		return ".jpg";
	}
	if (mime === "image/webp") {
		return ".webp";
	}
	return ".png";
}

// The file for one image of a batch: a single image whose target already names an extension
// is written where it was asked for, a batch gets a numbered suffix.
function pathFor(base: string, index: number, count: number, ext: string): string {
	if (count === 1 && extname(base)) {
		return base;
	}
	if (count === 1) {
		return `${base}${ext}`;
	}
	return `${base}-${index + 1}${ext}`;
}

// generate() throws when a response carries no image, so a generation that came back has at
// least one file; this names it without asserting it.
function firstPath(images: readonly { path: string }[]): string {
	const [first] = images;
	if (first) {
		return first.path;
	}
	return "(no file written)";
}

function loadConfig(): Config {
	let raw: Partial<Config> = {};
	try {
		raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
	} catch {
		/* no config file yet: the defaults are the working ones */
	}
	return { ...DEFAULTS, ...raw };
}

function expand(p: string): string {
	if (p.startsWith("~")) {
		return join(homedir(), p.slice(1));
	}
	return p;
}

/** "WIDTHxHEIGHT" with both sides usable by this model. Returns null with a reason. */
function parseSize(size: string): { width: number; height: number } | { error: string } {
	const m = SIZE_PATTERN.exec(size.trim());
	const widthText = m?.groups?.width;
	const heightText = m?.groups?.height;
	if (!(widthText && heightText)) {
		return { error: `size must look like 1024x1024, got "${size}"` };
	}
	const width = Number(widthText);
	const height = Number(heightText);
	for (const [name, v] of [
		["width", width],
		["height", height],
	] as const) {
		if (v % SIDE_DIVISOR !== 0) {
			return { error: `${name} ${v} is not divisible by ${SIDE_DIVISOR}` };
		}
		if (v < MIN_SIDE || v > MAX_SIDE) {
			return { error: `${name} ${v} is outside ${MIN_SIDE}..${MAX_SIDE}` };
		}
	}
	return { width, height };
}

function slug(text: string): string {
	return (
		text.toLowerCase().replace(NOT_SLUG, "-").replace(EDGE_DASHES, "").slice(0, SLUG_MAX).replace(TRAILING_DASH, "") ||
		"image"
	);
}

function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

interface Args {
	prompt: string;
	size?: string;
	n?: number;
	format?: string;
	path?: string;
	steps?: number;
	seed?: number;
	negativePrompt?: string;
	open?: boolean;
}

interface Generated {
	/** `data` stays out of `details`: details is written into the session file. */
	images: { path: string; bytes: number; mime: string; data: string }[];
	ms: number;
	route: string;
	echo: string;
}

/**
 * One generation. `signal` is pi's abort: Esc during a long wait has to reach fetch,
 * or the request keeps burning the GPU after the session has moved on.
 */
async function generate(cfg: Config, args: Args, signal: AbortSignal): Promise<Generated> {
	const size = parseSize(args.size ?? cfg.size);
	if ("error" in size) {
		throw new Error(size.error);
	}
	const n = Math.max(MIN_IMAGES, Math.min(MAX_IMAGES, Math.floor(args.n ?? 1)));
	const steps = args.steps ?? DEFAULT_STEPS;
	const seed = args.seed ?? SEED_SERVER_PICKS;

	// The OpenAI body has no field for steps, seed or a negative prompt. When one is
	// named the request moves to the SDAPI shape — which llama-swap serves off the
	// origin, not off the /v1 the OpenAI routes hang under, hence `origin`.
	const knobs = args.steps !== undefined || args.seed !== undefined || Boolean(args.negativePrompt);
	const api = cfg.baseUrl.replace(TRAILING_SLASH, "");
	// `negative_prompt`, `cfg_scale`, `batch_size` and `output_format` are the server's
	// vocabulary rather than this file's, so both shapes are built as maps: the keys are wire
	// data, and the naming rule is about the identifiers this file owns.
	const body: Record<string, unknown> = { model: cfg.model, prompt: args.prompt };
	let url: string;
	let route: string;
	if (knobs) {
		url = `${new URL(api).origin}/sdapi/v1/txt2img`;
		body.width = size.width;
		body.height = size.height;
		body.steps = steps;
		body.seed = seed;
		body.negative_prompt = args.negativePrompt ?? "";
		body.cfg_scale = cfg.cfgScale;
		body.batch_size = n;
		route = "sdapi/txt2img";
	} else {
		url = `${api}/images/generations`;
		body.n = n;
		body.size = `${size.width}x${size.height}`;
		body.output_format = args.format ?? cfg.format;
		route = "images/generations";
	}

	const started = Date.now();
	// pi's abort plus a ceiling of our own. Nothing else bounds this wait: pi's
	// httpIdleTimeoutMs governs provider requests, not a tool's own fetch, and neither
	// Caddy nor llama-swap times out an upstream generation.
	const timeout = AbortSignal.timeout(cfg.timeoutMs);
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.any([signal, timeout]),
	}).catch((err: Error) => {
		if (timeout.aborted) {
			throw new Error(
				`${cfg.model}: no answer from ${new URL(url).pathname} in ${Math.round(cfg.timeoutMs / MS_PER_SECOND)}s. ` +
					"The generation may still be running on the box — GET /running on the same host says what is loaded.",
			);
		}
		throw new Error(`${cfg.model}: ${url} — ${err.message}`);
	});

	const text = await res.text();
	if (!res.ok) {
		// sd-server answers {"error":"..."}, llama-swap {"src":"llama-swap","error":{...}}.
		const detail = text.slice(0, DETAIL_CHARS).replace(WHITESPACE_RUN, " ");
		throw new Error(`${cfg.model}: HTTP ${res.status} from ${new URL(url).pathname} — ${detail}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${cfg.model}: the response was not JSON (${text.slice(0, PREVIEW_CHARS)})`, { cause: error });
	}

	const b64 = base64Images(parsed);
	if (b64.length === 0) {
		throw new Error(`${cfg.model}: no image in the response (${text.slice(0, PREVIEW_CHARS)})`);
	}

	// SDAPI has no output_format on txt2img and always answers with PNG. What the server
	// says it produced is also what gets echoed back: a request for webp that comes back as
	// png has to be visible in the result, not papered over with the format asked for.
	const produced = stringField(parsed, "output_format") ?? "png";
	const mime = mimeOf(produced);
	const ext = extensionOf(mime);
	let echo: string;
	if (knobs) {
		echo = `steps ${steps}, cfg ${cfg.cfgScale}, seed ${seed}`;
	} else {
		echo = `size ${size.width}x${size.height}, ${produced}`;
	}

	let base: string;
	if (args.path) {
		base = resolve(expand(args.path));
	} else {
		base = join(expand(cfg.dir), `${stamp()}-${slug(args.prompt)}`);
	}
	mkdirSync(dirname(base), { recursive: true });

	const images = b64.map((data, i) => {
		const path = pathFor(base, i, b64.length, ext);
		const buf = Buffer.from(data, "base64");
		writeFileSync(path, buf);
		return { path, bytes: buf.length, mime, data };
	});

	return { images, ms: Date.now() - started, route, echo };
}

function openIn(path: string): void {
	let cmd = "xdg-open";
	let args = [path];
	if (process.platform === "darwin") {
		cmd = "open";
	} else if (process.platform === "win32") {
		// Windows needs the shell's own start, and the empty title argument that start wants.
		cmd = "cmd";
		args = ["/c", "start", "", path];
	}
	spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

export default function (pi: ExtensionAPI) {
	const cfg = loadConfig();

	const tool = defineTool({
		name: "generate_image",
		label: "Image",
		description:
			"Draw a picture with the lab's qwen-image and save it to a file. Describe the scene plainly; " +
			"one image per call. The result names the file and shows the picture back to you.",
		promptSnippet: "Draw a picture with the lab's qwen-image and save it to a file",
		promptGuidelines: [
			"generate_image is slow and shares the box with the model you are running: expect ~1 minute at 512x512 " +
				"and minutes at 1024x1024, plus a weight load on the first call after five idle minutes. Ask once, " +
				"look at the result, then refine — do not fire a batch of guesses.",
			"Say what is in the frame, the medium and the light. Leave steps alone unless the picture is almost " +
				"right: 20 is the server default and 4 does not resolve this model at all. Measured here: " +
				"256x256/20 = 19s, 512x512/20 = 57s.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "What to draw: subject, medium, light. English works best." }),
			size: Type.Optional(
				Type.String({ description: "WIDTHxHEIGHT, both divisible by 32, max 2048. Default 1024x1024." }),
			),
			n: Type.Optional(Type.Number({ description: "How many images, 1..4. Default 1." })),
			format: Type.Optional(
				Type.String({ description: "png (default), jpeg or webp. Ignored when steps/seed/negativePrompt are set." }),
			),
			path: Type.Optional(
				Type.String({ description: "Where to write. Default: the configured directory, named by time and prompt." }),
			),
			steps: Type.Optional(
				Type.Number({
					description: "Sampling steps. The server default is 20, and that is the floor: 4 steps came back as noise.",
				}),
			),
			seed: Type.Optional(Type.Number({ description: "Fix the seed to repeat or vary one composition." })),
			negativePrompt: Type.Optional(Type.String({ description: "What to push away from." })),
			open: Type.Optional(Type.Boolean({ description: "Open the finished file in the OS viewer." })),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
		async execute(_id, args, signal, _onUpdate, ctx) {
			const a = args as Args;
			const out = await generate(cfg, a, signal ?? new AbortController().signal);
			if (a.open ?? cfg.open) {
				for (const f of out.images) {
					openIn(f.path);
				}
			}

			const lines = out.images.map((f) => `${f.path} (${(f.bytes / BYTES_PER_KIB).toFixed(0)} KiB)`);
			const seconds = (out.ms / MS_PER_SECOND).toFixed(0);
			let note = "Generated";
			if (out.images.length > 1) {
				note += ` ${out.images.length}`;
			}
			note += ` in ${seconds}s via ${out.route}, ${out.echo}. Saved to:\n`;
			if (out.images.length === 1) {
				note += lines[0];
			} else {
				note += lines.join("\n");
			}
			// pi replaces the image block with a placeholder when the active model takes
			// text only, and a model that gets a placeholder will happily describe a
			// picture it never saw — observed on this machine with the default model.
			// This line survives either way, so the blindness is stated, not silently
			// papered over.
			const sees = (ctx.model?.input ?? []).includes("image");
			let blind = "";
			if (!sees) {
				blind = `\nYou have NOT seen these: the active model (${ctx.model?.id ?? "unknown"}) takes text input, so pi dropped the image block. The files are real; do not describe their contents from the prompt.`;
			}

			return {
				content: [
					{ type: "text", text: note + blind },
					...out.images.map((f) => ({ type: "image" as const, data: f.data, mimeType: f.mime })),
				],
				details: {
					files: out.images.map((f) => ({ path: f.path, bytes: f.bytes, mime: f.mime })),
					ms: out.ms,
					route: out.route,
					echo: out.echo,
					seenByModel: sees,
				},
			};
		},
	});

	pi.registerTool(tool);

	pi.registerCommand("image", {
		description: "qwen-image: test | config | <prompt>",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			const { ui } = ctx as unknown as ExtensionContext;

			if (arg === "config") {
				ui.notify(`image: ${cfg.baseUrl} · ${cfg.model} · ${cfg.size} · ${expand(cfg.dir)}`, "info");
				return;
			}

			let prompt = arg;
			if (arg === "test") {
				prompt = "a small red fox sitting in snow, watercolor";
			}
			if (!prompt) {
				ui.notify("usage: /image test | config | <prompt>", "info");
				return;
			}

			const small = arg === "test";
			// A test that can only pass is no test. `/image test` walks both routes, because
			// llama-swap dispatches them through different middleware and only the OpenAI one
			// hangs under /v1 — a single-route test would miss the other one entirely.
			const dir = tmpdir();
			const tag = stamp();
			let calls: Args[] = [{ prompt }];
			if (small) {
				calls = [
					{ prompt, size: "256x256", path: join(dir, `pi-image-test-${tag}.png`) },
					{ prompt, size: "256x256", steps: 12, path: join(dir, `pi-image-test-${tag}-sdapi.png`) },
				];
			}

			// A widget above the editor, not a notify: a notify is gone in seconds, and the
			// two generations take 20 s warm and more after a weight load, during which a
			// silent command reads as a hung one. The lines stay until the next turn starts.
			const lines: string[] = [];
			const show = (live?: string) => {
				if (live) {
					ui.setWidget(WIDGET, [...lines, live]);
				} else {
					ui.setWidget(WIDGET, [...lines]);
				}
			};
			const started = Date.now();
			let failed = false;
			for (const [i, call] of calls.entries()) {
				const knobs = call.steps !== undefined || call.seed !== undefined || Boolean(call.negativePrompt);
				let label = "images/generations";
				if (knobs) {
					label = "sdapi/txt2img";
				}
				if (calls.length > 1) {
					label = `${i + 1}/${calls.length} ${label}`;
				}
				const t0 = Date.now();
				const tick = () => show(`image: ${label} … ${((Date.now() - t0) / MS_PER_SECOND).toFixed(0)}s`);
				tick();
				const timer = setInterval(tick, TICK_MS);
				// Nothing aborts a command handler's call — there is no tool call to cancel.
				// The two routes are timed one after the other on purpose: there is one GPU, so a
				// parallel pair would measure each other waiting rather than themselves.
				try {
					// biome-ignore lint/performance/noAwaitInLoops: sequential awaits are the measurement
					const out = await generate(cfg, call, new AbortController().signal);
					const secs = (out.ms / MS_PER_SECOND).toFixed(0);
					lines.push(`image: ✓ ${label} ${secs}s — ${firstPath(out.images)} (${out.echo})`);
				} catch (err) {
					lines.push(`image: ✗ ${label} — ${(err as Error).message}`);
					failed = true;
				} finally {
					clearInterval(timer);
				}
				show();
				if (failed) {
					break;
				}
			}
			const total = ((Date.now() - started) / MS_PER_SECOND).toFixed(0);
			if (failed) {
				ui.notify(`image: failed after ${total}s — see the lines above the editor`, "error");
			} else {
				ui.notify(`image: done in ${total}s`, "info");
			}
		},
	});

	pi.on("before_agent_start", (_event, ctx) => {
		(ctx as unknown as ExtensionContext).ui.setWidget(WIDGET, undefined);
	});
}
