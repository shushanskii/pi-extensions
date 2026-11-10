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
 * Why two endpoints, and why SDAPI is the default. /v1/images/generations is the
 * OpenAI-shaped one llama-swap documents; it carries prompt, n, size and output_format
 * and nothing else — and sd-server leaves its progress status empty for calls arriving
 * on it (measured 2026-11-10: job '' step 0/0 through a whole 512² generation). Steps,
 * seed and a negative prompt exist only on the SDAPI-shaped /sdapi/v1/txt2img, which
 * llama-swap forwards too and which does report sampling. So the tool posts SDAPI
 * unless the caller named jpeg or webp, the one thing only the OpenAI shape carries;
 * that call then has no progress line. Both answer with base64; SDAPI always answers
 * with PNG whatever `format` says.
 *
 * Why the progress poll goes through /upstream/. sd-server reports sampling on
 * /sdapi/v1/progress, but llama-swap forwards txt2img, img2img and loras only, so the
 * poll takes the raw upstream route — and that route starts an unloaded model, 10 GiB
 * for one status line (measured 2026-11-10). So the poller lives exactly as long as
 * this tool's own generation: while a POST is in flight the model is loaded by
 * definition, and a poll can only report on work already running. Without a watcher the
 * wait is silent, and the figures the guidelines quote are from this box: 19s at 256²/20
 * steps, 57s at 512²/20, and the first call after five idle minutes also pays the weight
 * load, because the ttl in llama-swap.yaml is 300. 1024²/20, the configured default and
 * therefore the usual request, was measured through this tool on 2026-11-02 at 337s and
 * 329s, two calls back to back: 5.8× the 512² wait, not the 4× its latent count
 * predicts, so the extra is the sampler rather than a weight load the second call
 * skipped. The default request is a five-minute wait.
 *
 * Config: ~/.pi/agent/image.json — the same directory and plaintext convention as
 * tts.json. `/image test` proves both routes, one after the other on the one GPU, for
 * the price of two 256² generations — about 40 s of it warm.
 *
 * Why not `fetch`. Node's global fetch is undici, and undici abandons a response whose
 * headers have not arrived by `headersTimeout` — 300s by default, no per-request knob.
 * sd-server on halogen sends the headers with the finished image, so a generation longer
 * than that dies client-side while the box keeps sampling: measured 2026-11-09, two
 * 1024²/30 calls cut off at 301.0s each, and again 2026-11-10 on a cold-disk 1024²/20.
 * The old llm box answered headers early, which is why the same call at 337s completed
 * on 2026-11-02. `node:https` has no such timer; the only ceiling left is the caller's
 * `timeoutMs`. It does not follow redirects the way fetch did — nothing between this
 * tool and sd-server redirects a POST, and a 3xx would surface as a non-2xx error.
 *
 * Why cancel unloads. sd-server has no interrupt endpoint of its own (checked against
 * the binary 2026-11-10: txt2img, img2img, progress, options, loras, samplers,
 * schedulers, sd-models, upscalers, latent-upscale-modes), and it keeps sampling to
 * the end after its client dies (measured the same day: client gone at 20s, the frame
 * still finished at 50s). The only off switch is llama-swap's `POST
 * /api/models/unload/<model>`, which kills the process — verified: unload at step 2/20
 * answered 200 and the in-flight generation died with 502 four seconds later. So
 * `cancel_generate_image` unloads, an Esc-abort unloads through `generate()`, and
 * `session_shutdown` unloads while a generation is in flight. The next call pays the
 * weight reload: ~1s from the page cache, ~96s from a cold disk.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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
	 * A generation is minutes, not milliseconds, and this is the only ceiling on the
	 * wait: the transport is `node:https` with no timer of its own (see the header), so
	 * unlike the `fetch` that stood here through the published 1.0.4, nothing cuts a long
	 * call off at
	 * 300s. A request that outlives this one is reported as a timeout, and the
	 * generation may well still finish on the box.
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
// The clamp for n: zero images is not a request, and the server holds four latents and no
// more, so a larger n is clamped to four rather than queued here as two waits.
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
// The 2xx band. fetch answered `res.ok` for free; the raw transport compares the number,
// so both edges get a name — 300 (Multiple Choices) is the first status that is not a
// success and the last one a generation must not be.
const HTTP_OK = 200;
const HTTP_MULTIPLE_CHOICES = 300;
// The poll is a courtesy to whoever watches the block: one second is finer than the
// sampler's own pace and cheap enough to ignore.
const PROGRESS_POLL_MS = 1000;
// A status poll that outlives this is no longer reporting — the box is busy and the next
// tick will try again. A cold model start answers nothing for minutes.
const PROGRESS_GIVE_MS = 3000;
// The cancel paths run from an abort or a dying session, so they get a short leash.
const CANCEL_GIVE_MS = 5000;
// The call line is one line: the prompt is shown until it stops fitting the point.
const PROMPT_PREVIEW_CHARS = 60;
// Sampling fractions arrive as 0..1; the line shows them as percent.
const PERCENT = 100;
const SECONDS_PER_MINUTE = 60;
const ETA_DIGITS = 2;

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

/** What a request came back with: the status line and the whole body, read to the end. */
interface HttpResult {
	status: number;
	text: string;
}

/**
 * One JSON request over `node:https`/`node:http`, deliberately not `fetch`: undici's
 * `headersTimeout` (300s, no per-request knob) is shorter than a generation on this box,
 * and sd-server answers with the headers only when the image is done (header comment,
 * "Why not `fetch`"). These modules time nothing out on their own — `signal` is the only
 * way this wait ends early. No redirect following: nothing on the path redirects a POST.
 */
function httpJson(method: string, url: string, payload: string | undefined, signal: AbortSignal): Promise<HttpResult> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (payload !== undefined) {
		headers["content-length"] = String(Buffer.byteLength(payload));
	}
	const options: RequestOptions = { method, headers, signal };
	// `settle`, not `resolve`: node:path's resolve is already in this file's scope.
	return new Promise<HttpResult>((settle, reject) => {
		const onResponse = (res: IncomingMessage): void => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				text += chunk;
			});
			res.on("end", () => settle({ status: res.statusCode ?? 0, text }));
			res.on("error", reject);
		};
		let req: ClientRequest;
		if (new URL(url).protocol === "https:") {
			req = httpsRequest(url, options, onResponse);
		} else {
			req = httpRequest(url, options, onResponse);
		}
		req.on("error", reject);
		if (payload === undefined) {
			req.end();
		} else {
			req.end(payload);
		}
	});
}

function postJson(url: string, payload: string, signal: AbortSignal): Promise<HttpResult> {
	return httpJson("POST", url, payload, signal);
}

function getJson(url: string, signal: AbortSignal): Promise<HttpResult> {
	return httpJson("GET", url, undefined, signal);
}

/** What sd-server says about the generation in flight, narrowed to what this file shows. */
interface Progress {
	step: number;
	steps: number;
	fraction: number;
	etaSec: number;
	/** Whether etaSec is a real estimate; the box never fills `eta_relative`, so it is 0 until this file has timed a step. */
	etaKnown: boolean;
	/** Sampling is over and the VAE decode runs: the status went back to empty after a step. */
	decoding: boolean;
}

/**
 * The A1111-shaped status: `state.sampling_step` of `sampling_steps`, an overall
 * `progress` fraction and `eta_relative` seconds. The keys are the server's vocabulary,
 * so every field is read through a guard rather than trusted. `eta_relative` is always 0
 * on this route (measured 2026-11-10), so the ETA is measured by the tracker below.
 */
function parseProgress(text: string): Progress | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	let state: unknown;
	if (isRecord(parsed)) {
		({ state } = parsed);
	}
	const etaSec = numberField(parsed, "eta_relative") ?? 0;
	return {
		step: numberField(state, "sampling_step") ?? 0,
		steps: numberField(state, "sampling_steps") ?? 0,
		fraction: numberField(parsed, "progress") ?? 0,
		etaSec,
		etaKnown: etaSec > 0,
		decoding: false,
	};
}

/**
 * The ETA the box does not provide, and the decode state it does not report. The status
 * only moves when a step lands — every ~12s at 1024² — while this polls once a second, so
 * an ETA derived from the raw fraction would tick up between steps and only fall when one
 * arrives (the bug this replaces). Instead the seconds a step took are measured from the
 * step transitions, and between them the line counts down against a fixed finish estimate.
 * The memory lives here, across polls: when sampling began, the last step seen and when,
 * and the average a step costs.
 */
function createProgressTracker(onProgress: (p: Progress) => void): (p: Progress) => void {
	let samplingStart = 0;
	let lastStep = 0;
	let lastStepAt = 0;
	let perStepMs = 0;
	return (p: Progress): void => {
		const now = Date.now();
		if (p.steps === 0) {
			// Empty status: before any step this is load or prompt-encoding; after one it is
			// the VAE decode. Only the second is worth a distinct line.
			p.decoding = samplingStart > 0;
			onProgress(p);
			return;
		}
		if (samplingStart === 0) {
			samplingStart = now;
		}
		if (p.step > lastStep) {
			let from = samplingStart;
			if (lastStepAt > 0) {
				from = lastStepAt;
			}
			perStepMs = (now - from) / (p.step - lastStep);
			lastStep = p.step;
			lastStepAt = now;
		}
		if (perStepMs > 0) {
			const finishAt = lastStepAt + (p.steps - lastStep) * perStepMs;
			p.etaSec = Math.max(0, (finishAt - now) / MS_PER_SECOND);
			p.etaKnown = true;
		}
		onProgress(p);
	};
}

/** One line of it: what the sampler is on, how far along, and when it should be done. */
function progressLine(p: Progress): string {
	if (p.decoding) {
		return "decoding the latents…";
	}
	if (p.steps === 0) {
		return "waiting: the box is loading weights or encoding the prompt";
	}
	const pct = Math.round(p.fraction * PERCENT);
	let eta = "";
	if (p.etaKnown) {
		eta = ` · ETA ${clock(p.etaSec)}`;
	}
	return `sampling ${p.step}/${p.steps} · ${pct}%${eta}`;
}

/** Seconds to m:ss — an ETA of 300 should read as 5:00, not as 300. */
function clock(sec: number): string {
	const whole = Math.max(0, Math.round(sec));
	const mm = Math.floor(whole / SECONDS_PER_MINUTE);
	const ss = String(whole % SECONDS_PER_MINUTE).padStart(ETA_DIGITS, "0");
	return `${mm}:${ss}`;
}

/** The prompt as the call line shows it: whole when it fits, a head with an ellipsis when not. */
function preview(prompt: string): string {
	if (prompt.length <= PROMPT_PREVIEW_CHARS) {
		return prompt;
	}
	return `${prompt.slice(0, PROMPT_PREVIEW_CHARS - 1)}…`;
}

/** The text blocks of a result, joined — what the settled block shows, images aside. */
function textOf(content: { type: string; text?: string }[]): string {
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

/** The origin the llama-swap management routes (`/running`, `/api/models/unload`) hang off. */
function originOf(cfg: Config): string {
	return new URL(cfg.baseUrl.replace(TRAILING_SLASH, "")).origin;
}

/** llama-swap's registry: the models answering right now, by name. */
async function runningModels(origin: string, signal: AbortSignal): Promise<string[]> {
	const res = await getJson(`${origin}/running`, signal);
	if (res.status !== HTTP_OK) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(res.text);
	} catch {
		return [];
	}
	let list: unknown[];
	if (isRecord(parsed) && Array.isArray(parsed.running)) {
		list = parsed.running;
	} else {
		list = [];
	}
	const names: string[] = [];
	for (const entry of list) {
		const name = stringField(entry, "model") ?? stringField(entry, "name");
		if (name) {
			names.push(name);
		}
	}
	return names;
}

/**
 * Stop the box: llama-swap unloads — kills — the model process, and whatever it is
 * generating dies with it (see the header comment, "Why cancel unloads"). Unloading a
 * model that is not running is a no-op worth reporting, not an error.
 */
async function cancelGeneration(origin: string, model: string, signal: AbortSignal): Promise<string> {
	const running = await runningModels(origin, signal).catch(() => [] as string[]);
	if (!running.includes(model)) {
		return `nothing to cancel: ${model} is not running`;
	}
	const res = await postJson(`${origin}/api/models/unload/${model}`, "", signal);
	if (res.status < HTTP_OK || res.status >= HTTP_MULTIPLE_CHOICES) {
		throw new Error(`${model}: unload answered HTTP ${res.status} — ${res.text.slice(0, PREVIEW_CHARS)}`);
	}
	return `unloaded ${model}: the generation is stopped; the next generate_image pays the weight reload`;
}

// Generations this process has in flight right now; session end unloads the box while
// the count is above zero.
let inFlight = 0;

/**
 * One generation. `signal` is pi's abort: Esc during a long wait has to reach the
 * request, or the request keeps burning the GPU after the session has moved on.
 * `onProgress`, when given, hears about the sampling once a second while the POST is
 * in flight — see the header comment for why the poll may only run in that window.
 */
async function generate(
	cfg: Config,
	args: Args,
	signal: AbortSignal,
	onProgress?: (p: Progress) => void,
): Promise<Generated> {
	const size = parseSize(args.size ?? cfg.size);
	if ("error" in size) {
		throw new Error(size.error);
	}
	const n = Math.max(MIN_IMAGES, Math.min(MAX_IMAGES, Math.floor(args.n ?? 1)));
	const steps = args.steps ?? DEFAULT_STEPS;
	const seed = args.seed ?? SEED_SERVER_PICKS;

	// The OpenAI body has no field for steps, seed or a negative prompt — and sd-server
	// leaves its progress status empty while a generation arrives on that route (measured
	// 2026-11-10: job '' step 0/0 for a whole 512² call, while the same call on SDAPI
	// walked 1/20 to 20/20). So SDAPI is the default route: it carries every knob and it
	// is the route the progress poll can report on. The OpenAI shape stays for the one
	// thing only it does — jpeg and webp output — and the progress line then stays at
	// "waiting", which the format parameter's description tells the model.
	const format = args.format ?? cfg.format;
	const knobs = args.steps !== undefined || args.seed !== undefined || Boolean(args.negativePrompt);
	const api = cfg.baseUrl.replace(TRAILING_SLASH, "");
	const origin = originOf(cfg);
	// `negative_prompt`, `cfg_scale`, `batch_size` and `output_format` are the server's
	// vocabulary rather than this file's, so both shapes are built as maps: the keys are wire
	// data, and the naming rule is about the identifiers this file owns.
	const body: Record<string, unknown> = { model: cfg.model, prompt: args.prompt };
	let url: string;
	let route: string;
	if (format === "png" || knobs) {
		url = `${origin}/sdapi/v1/txt2img`;
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
		body.output_format = format;
		route = "images/generations";
	}

	const started = Date.now();
	// The poller lives exactly as long as this POST: /upstream/ starts an unloaded model,
	// and while the generation is in flight the model is loaded by definition. A poll
	// that fails or stalls is silence, not an error — the generation does not need it.
	let poller: ReturnType<typeof setInterval> | undefined;
	if (onProgress) {
		const progressUrl = `${origin}/upstream/${cfg.model}/sdapi/v1/progress`;
		const feed = createProgressTracker(onProgress);
		poller = setInterval(() => {
			const give = AbortSignal.any([signal, AbortSignal.timeout(PROGRESS_GIVE_MS)]);
			getJson(progressUrl, give)
				.then((r) => {
					if (r.status !== HTTP_OK) {
						return;
					}
					const p = parseProgress(r.text);
					if (p) {
						feed(p);
					}
				})
				.catch(() => undefined);
		}, PROGRESS_POLL_MS);
	}
	inFlight += 1;
	try {
		// pi's abort plus a ceiling of our own. Nothing else bounds this wait: pi's
		// httpIdleTimeoutMs governs provider requests, not a tool's own request, and neither
		// Caddy nor llama-swap times out an upstream generation.
		const timeout = AbortSignal.timeout(cfg.timeoutMs);
		let res: HttpResult;
		try {
			res = await postJson(url, JSON.stringify(body), AbortSignal.any([signal, timeout]));
		} catch (raw: unknown) {
			const err = raw as Error;
			if (timeout.aborted) {
				throw new Error(
					`${cfg.model}: no answer from ${new URL(url).pathname} in ${Math.round(cfg.timeoutMs / MS_PER_SECOND)}s. ` +
						"The generation may still be running on the box — GET /running on the same host says what is loaded.",
					{ cause: raw },
				);
			}
			if (signal.aborted) {
				// The client is gone; the box is not: sd-server samples to the end after its
				// connection dies (header, "Why cancel unloads"). Tell llama-swap to stop it,
				// best effort on a short leash — this path also runs while the session ends.
				try {
					await cancelGeneration(origin, cfg.model, AbortSignal.timeout(CANCEL_GIVE_MS));
				} catch {
					// A box that cannot be reached cannot be cancelled either.
				}
				throw new Error(`${cfg.model}: cancelled — llama-swap was told to stop the generation.`, { cause: raw });
			}
			// A bare "fetch failed" hid the real cause behind undici's wrapper; node:https
			// reports ECONNREFUSED and friends directly, and cause stays for whatever wraps.
			let cause = "";
			if (err.cause instanceof Error) {
				cause = ` (${err.cause.message})`;
			}
			throw new Error(`${cfg.model}: ${url} — ${err.message}${cause}`, { cause: raw });
		}

		const { status, text } = res;
		if (status < HTTP_OK || status >= HTTP_MULTIPLE_CHOICES) {
			// sd-server answers {"error":"..."}, llama-swap {"src":"llama-swap","error":{...}}.
			const detail = text.slice(0, DETAIL_CHARS).replace(WHITESPACE_RUN, " ");
			throw new Error(`${cfg.model}: HTTP ${status} from ${new URL(url).pathname} — ${detail}`);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(`${cfg.model}: the response was not JSON (${text.slice(0, PREVIEW_CHARS)})`, {
				cause: error,
			});
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
		// The echo follows the route that answered, not the knobs: a plain call rides SDAPI
		// too now, and its line has to say what SDAPI was told.
		let echo: string;
		if (route === "sdapi/txt2img") {
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
	} finally {
		inFlight -= 1;
		if (poller !== undefined) {
			clearInterval(poller);
		}
	}
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
				Type.String({
					description:
						"png (default), jpeg or webp. jpeg and webp lose the progress line and are ignored when steps/seed/negativePrompt are set.",
				}),
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
		async execute(_id, args, signal, onUpdate, ctx) {
			const a = args as Args;
			// The block re-renders on every update, so only a line that changed is worth one.
			let lastLine = "";
			const out = await generate(cfg, a, signal ?? new AbortController().signal, (p) => {
				const line = progressLine(p);
				if (line === lastLine) {
					return;
				}
				lastLine = line;
				onUpdate?.({
					content: [{ type: "text", text: line }],
					details: { files: [], ms: 0, route: "", echo: "", seenByModel: false, progress: p },
				});
			});
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
		renderCall(args, theme, context) {
			const a = args as Partial<Args>;
			const bits = [cfg.model, a.size ?? cfg.size];
			if (a.steps !== undefined) {
				bits.push(`${a.steps} steps`);
			}
			if (a.n !== undefined && a.n > 1) {
				bits.push(`n ${a.n}`);
			}
			if (a.seed !== undefined) {
				bits.push(`seed ${a.seed}`);
			}
			let line = theme.fg("toolTitle", theme.bold("generate_image")) + theme.fg("muted", ` · ${bits.join(" · ")}`);
			if (a.prompt) {
				line += theme.fg("dim", ` "${preview(a.prompt)}"`);
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(line);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (options.isPartial) {
				// The partial's text is the progress line the poller last produced.
				text.setText(theme.fg("muted", textOf(result.content ?? []) || "…"));
				return text;
			}
			text.setText(textOf(result.content ?? []));
			return text;
		},
	});

	pi.registerTool(tool);

	pi.registerTool(
		defineTool({
			name: "cancel_generate_image",
			label: "Cancel image",
			description:
				"Stop the qwen-image generation running on the box right now by unloading the model. " +
				"The box keeps sampling even after its client is gone, so an abandoned or stuck generation " +
				"has to be cancelled here. No-ops when nothing is running; the next generate_image then " +
				"pays the weight reload.",
			promptSnippet: "Stop the qwen-image generation running on the box",
			promptGuidelines: [
				"Call cancel_generate_image when the user cancels a running generate_image or asks to stop " +
					"it: the box keeps sampling to the end with nobody waiting, holding ~10 GiB of the GPU.",
			],
			parameters: Type.Object({}),
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
			async execute(_id, _args, signal) {
				const note = await cancelGeneration(originOf(cfg), cfg.model, signal ?? new AbortController().signal);
				return { content: [{ type: "text", text: note }], details: { note } };
			},
		}),
	);

	pi.on("session_shutdown", async () => {
		if (inFlight === 0) {
			return;
		}
		// The Esc path already cancels through generate()'s abort branch; this is the belt
		// for the exits that skip it (SIGTERM, reload, new session): an orphaned POST left
		// on the box keeps sampling for minutes with nobody waiting.
		await cancelGeneration(originOf(cfg), cfg.model, AbortSignal.timeout(CANCEL_GIVE_MS)).catch(() => undefined);
	});

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
			// hangs under /v1 — a single-route test would miss the other one entirely. Both are
			// 256²: the routes are what is under test, not the pixel count.
			const dir = tmpdir();
			const tag = stamp();
			let calls: Args[] = [{ prompt }];
			if (small) {
				calls = [
					// The jpeg call is what keeps the OpenAI route under test: png goes SDAPI now,
					// being the route that can report progress.
					{ prompt, size: "256x256", format: "jpeg", path: join(dir, `pi-image-test-${tag}.jpg`) },
					{ prompt, size: "256x256", steps: 12, path: join(dir, `pi-image-test-${tag}-sdapi.png`) },
				];
			}

			// A widget above the editor, not a notify: a notify is gone in seconds, and the
			// two generations take 40 s warm (19 s each, measured) and more after a weight
			// load, during which a silent command reads as a hung one. The lines stay until
			// the next turn starts.
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
				// The same route rule generate() applies: SDAPI unless a non-png format sent it away.
				const sdapi = (call.format ?? cfg.format) === "png" || knobs;
				let label = "sdapi/txt2img";
				if (!sdapi) {
					label = "images/generations";
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
