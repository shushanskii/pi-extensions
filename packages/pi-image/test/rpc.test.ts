/**
 * pi-image inside a real pi, in RPC mode: the scripted model calls `generate_image`, pi runs the
 * tool against the fake image endpoints, and the test reads what came back through pi's own
 * event stream and what pi sent the model on the next turn.
 */

import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { type FakeServer, HTTP_OK, scriptedModels, startFakeServer } from "../../../tests/fake-server.ts";
import { type Home, makeHome } from "../../../tests/home.ts";
import type { PiEvent } from "../../../tests/pi.ts";
import { type Pi, startPi } from "../../../tests/rpc.ts";

/** A route that refuses is part of the script, not a constant of this file's own. */
const HTTP_SERVICE_UNAVAILABLE = 503;
/** How long a scripted turn may take before the driver gives up on it. */
const TURN_WAIT_MS = 15_000;

// The widget and notify lines, with the seconds and the temp path left open.
const DONE_NOTICE = /^image: done in \d+s$/u;
const FAILED_NOTICE = /^image: failed after/u;
const GENERATIONS_LINE = /^image: ✓ 1\/2 images\/generations \d+s — .*pi-image-test-.*\.jpg \(size 256x256, jpeg\)$/u;
const SDAPI_LINE = /^image: ✓ 2\/2 sdapi\/txt2img \d+s — .*-sdapi\.png \(steps 12, cfg 6, seed -1\)$/u;
const FOX_FILE = /-a-red-fox\.png$/u;

/** What pi-image puts into `details`; the package owns the shape, and this file is what pins it. */
interface ImageDetails {
	files: { path: string }[];
	route: string;
	seenByModel: boolean;
}

/**
 * The tool's `details`, narrowed field by field to that shape. A missing field throws here with the
 * payload in the message, rather than turning into `undefined` two assertions later.
 */
function detailsOf(end: PiEvent): ImageDetails {
	const details = end.result?.details as Partial<ImageDetails> | undefined;
	if (
		typeof details?.route !== "string" ||
		typeof details.seenByModel !== "boolean" ||
		typeof details.files?.[0]?.path !== "string"
	) {
		throw new Error(`pi-image returned no usable details: ${JSON.stringify(end.result?.details)}`);
	}
	return details as ImageDetails;
}

let server: FakeServer;
let home: Home;

beforeAll(async () => {
	server = await startFakeServer();
	home = makeHome();
	home.agentFile("models.json", scriptedModels(server.url));
	home.agentFile("image.json", { baseUrl: `${server.url}/v1`, dir: "~/pictures" });
});

afterAll(async () => {
	await server?.close();
	home?.dispose();
});

afterEach(() => {
	const pending = server.pending();
	server.reset();
	// biome-ignore lint/suspicious/noMisplacedAssertion: an afterEach guard is an assertion by design
	expect(pending, "turns the script queued but pi never asked for").toBe(0);
});

/** One pi per describe block: starting pi costs about half a second. */
function withPi(model?: string) {
	const ref = {} as { pi: Pi };
	beforeAll(async () => {
		ref.pi = await startPi("pi-image", home, model);
	});
	afterAll(async () => {
		await ref.pi?.stop();
	});
	afterEach(() => {
		ref.pi.ui.length = 0;
	});
	return ref;
}

describe("commands, no model", () => {
	const harness = withPi();

	test("registers /image and nothing else", async () => {
		const commands = await harness.pi.client.getCommands();
		expect(commands.map((c) => c.name)).toEqual(["image"]);
	});

	test("/image config reports the config from the isolated HOME", async () => {
		await harness.pi.client.prompt("/image config");
		const notice = await harness.pi.waitForUi((r) => r.method === "notify");
		expect(notice.message).toBe(`image: ${server.url}/v1 · qwen-image · 1024x1024 · ${home.dir}/pictures`);
	});

	test("/image test walks both routes and keeps a widget line for each", async () => {
		// The jpeg echo makes the OpenAI-route answer honest: the server's word on what it
		// produced is what the widget line shows.
		const img: Record<string, unknown> = {};
		img.b64_json = TINY_PNG_B64;
		const jpegAnswer: Record<string, unknown> = { data: [img] };
		jpegAnswer.output_format = "jpeg";
		server.route("/v1/images/generations", HTTP_OK, jpegAnswer);
		await harness.pi.client.prompt("/image test");
		const done = await harness.pi.waitForUi((r) => r.method === "notify");
		expect(done).toMatchObject({ notifyType: "info", message: expect.stringMatching(DONE_NOTICE) });

		expect(server.log.map((r) => r.path)).toEqual(["/v1/images/generations", "/sdapi/v1/txt2img"]);
		expect(server.log[1]?.body).toMatchObject({ steps: 12, width: 256, height: 256 });

		const widgets = harness.pi.ui.filter((r) => r.method === "setWidget" && r.widgetKey === "pi-image");
		const last = widgets.at(-1)?.widgetLines ?? [];
		expect(last).toHaveLength(2);
		expect(last[0]).toMatch(GENERATIONS_LINE);
		expect(last[0]).toContain(`— ${home.tmp}/pi-image-test-`);
		expect(last[1]).toMatch(SDAPI_LINE);
	});

	test("/image test stops at the first failing route and says so", async () => {
		server.route("/v1/images/generations", HTTP_SERVICE_UNAVAILABLE, { error: "model is loading" });
		await harness.pi.client.prompt("/image test");
		const done = await harness.pi.waitForUi((r) => r.method === "notify");
		expect(done).toMatchObject({ notifyType: "error", message: expect.stringMatching(FAILED_NOTICE) });
		expect(server.log.map((r) => r.path)).toEqual(["/v1/images/generations"]);
		const last = harness.pi.ui.filter((r) => r.method === "setWidget").at(-1)?.widgetLines;
		expect(last).toEqual([
			'image: ✗ 1/2 images/generations — qwen-image: HTTP 503 from /v1/images/generations — {"error":"model is loading"}',
		]);
	});
});

/** The model asks for a picture, then says it is done. */
function drawAndStop(args: Record<string, unknown>) {
	server.script({ tool: "generate_image", args: { prompt: "a red fox", ...args } }, { text: "done" });
}

async function toolResult(pi: Pi, message: string): Promise<PiEvent> {
	const events = (await pi.client.promptAndWait(message, undefined, TURN_WAIT_MS)) as PiEvent[];
	const end = events.find((e) => e.type === "tool_execution_end");
	// biome-ignore lint/suspicious/noMisplacedAssertion: without this the caller compares against undefined
	expect(end, "tool_execution_end").toBeDefined();
	return end as PiEvent;
}

/** The cfg the server was started with and the tool passes through unchanged. */
const DEFAULT_CFG_SCALE = 6;
/** The body pi-image posts on the SDAPI route for the plain 256² call of these tests. */
function expectedSdapiBody(): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: "qwen-image",
		prompt: "a red fox",
		width: 256,
		height: 256,
		steps: 20,
		seed: -1,
	};
	body.negative_prompt = "";
	body.cfg_scale = DEFAULT_CFG_SCALE;
	body.batch_size = 1;
	return body;
}

// The 1×1 PNG the fake server answers with, for a route this test re-registers with a delay.
// biome-ignore lint/security/noSecrets: a transparent pixel, not a credential
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** How long the fake route holds the answer: minutes on the GPU, two seconds here. */
const GPU_HOLD_MS = 2000;
/** Longer than the poller's first tick, so an update lands before the held answer does. */
const LONG_HOLD_MS = 3000;
/** How long the abort test lets the generation run before pulling the plug. */
const ABORT_AFTER_MS = 1500;
/** The SDAPI answer for a route the test holds open: the server's key goes in by field. */
function heldAnswer(): Record<string, unknown> {
	const held: Record<string, unknown> = {};
	held.images = [TINY_PNG_B64];
	return held;
}
/** llama-swap's /running answer with the image model loaded. */
function runningWithModel(): Record<string, unknown> {
	return { running: [{ model: "qwen-image" }] };
}
/** The fixed status the fake progress route reports: step 10 of 20, half done, ten seconds left. */
const PROGRESS_STEP = 10;
const PROGRESS_STEPS = 20;
const PROGRESS_FRACTION = 0.5;
const PROGRESS_ETA_SEC = 10;

describe("tool, text-only model", () => {
	const harness = withPi("text-only");

	test("writes the file, names it, and says the model has not seen it", async () => {
		drawAndStop({ size: "256x256" });
		const end = await toolResult(harness.pi, "draw a fox");

		expect(end.isError).toBe(false);
		// The plain call rides the SDAPI route now: it is the route that reports progress.
		expect(server.log.find((r) => r.path === "/sdapi/v1/txt2img")?.body).toEqual(expectedSdapiBody());
		const details = detailsOf(end);
		expect(details.files[0].path.startsWith(`${home.dir}/pictures/`)).toBe(true);
		expect(details.files[0].path).toMatch(FOX_FILE);
		expect(existsSync(details.files[0].path)).toBe(true);
		expect(details).toMatchObject({ route: "sdapi/txt2img", seenByModel: false });
		expect(end.result?.content?.[0]?.text).toContain("You have NOT seen these: the active model (text-only)");

		// What pi sent the model after the tool ran: the path, and no image.
		const followUp = JSON.stringify(server.chats()[1]);
		expect(followUp).toContain(details.files[0].path);
		expect(followUp).not.toContain("image_url");
	});

	test("a seed moves the request to the SDAPI route", async () => {
		drawAndStop({ size: "256x256", seed: 7 });
		const end = await toolResult(harness.pi, "the same fox again");

		expect(detailsOf(end).route).toBe("sdapi/txt2img");
		expect(server.log.find((r) => r.path === "/sdapi/v1/txt2img")?.body).toMatchObject({ seed: 7, steps: 20 });
	});

	test("a size the model cannot draw is an error, and nothing is posted", async () => {
		drawAndStop({ size: "300x300" });
		const end = await toolResult(harness.pi, "a fox at an odd size");

		expect(end.isError).toBe(true);
		expect(end.result?.content?.[0]?.text).toBe("width 300 is not divisible by 32");
		expect(server.log.filter((r) => r.path !== "/v1/chat/completions")).toEqual([]);
	});

	test("a response held open is waited out, not timed out", async () => {
		// The GPU holds the response for minutes and sends the headers with the finished
		// image; the old fetch transport cut that off at 300s (package header, "Why not
		// `fetch`"). 2s stands in for the minutes — the point is that holding is not an error.
		server.route("/sdapi/v1/txt2img", HTTP_OK, heldAnswer(), GPU_HOLD_MS);
		drawAndStop({ size: "256x256" });
		const end = await toolResult(harness.pi, "a fox behind a slow GPU");

		expect(end.isError).toBe(false);
		expect(detailsOf(end).route).toBe("sdapi/txt2img");
	});

	test("progress streams to the block while the box is busy", async () => {
		// The keys are sd-server's A1111-shaped status, so they go in field by field.
		const state: Record<string, unknown> = {};
		state.sampling_step = PROGRESS_STEP;
		state.sampling_steps = PROGRESS_STEPS;
		const status: Record<string, unknown> = { state };
		status.progress = PROGRESS_FRACTION;
		status.eta_relative = PROGRESS_ETA_SEC;
		server.route("/upstream/qwen-image/sdapi/v1/progress", HTTP_OK, status);
		// Held longer than the poller's first tick, so at least one update precedes the end.
		server.route("/sdapi/v1/txt2img", HTTP_OK, heldAnswer(), LONG_HOLD_MS);
		drawAndStop({ size: "256x256" });

		const events = (await harness.pi.client.promptAndWait("draw a slow fox", undefined, TURN_WAIT_MS)) as PiEvent[];
		const update = events.find((e) => e.type === "tool_execution_update");
		const progress = update?.partialResult?.details?.progress as { step?: number } | undefined;
		expect(progress?.step).toBe(PROGRESS_STEP);
		expect(update?.partialResult?.content?.[0]?.text).toContain(`sampling ${PROGRESS_STEP}/${PROGRESS_STEPS}`);
		const end = events.find((e) => e.type === "tool_execution_end");
		expect(end?.isError).toBe(false);
	});

	test("cancel_generate_image unloads a running model", async () => {
		server.route("/running", HTTP_OK, runningWithModel());
		server.route("/api/models/unload/qwen-image", HTTP_OK, "OK");
		server.script({ tool: "cancel_generate_image", args: {} }, { text: "stopped" });
		const end = await toolResult(harness.pi, "stop the picture");

		expect(end.isError).toBe(false);
		expect(end.result?.content?.[0]?.text).toContain("unloaded qwen-image");
		expect(server.log.map((r) => r.path)).toContain("/api/models/unload/qwen-image");
	});

	test("cancel is a no-op when nothing runs", async () => {
		server.route("/running", HTTP_OK, { running: [] });
		server.script({ tool: "cancel_generate_image", args: {} }, { text: "ok" });
		const end = await toolResult(harness.pi, "stop nothing");

		expect(end.result?.content?.[0]?.text).toContain("nothing to cancel");
		expect(server.log.map((r) => r.path)).not.toContain("/api/models/unload/qwen-image");
	});

	test("aborting the call tells llama-swap to stop the box", async () => {
		// The box keeps sampling after its client dies (package header, "Why cancel
		// unloads"), so the abort branch of generate() must reach the unload route.
		server.route("/running", HTTP_OK, runningWithModel());
		server.route("/api/models/unload/qwen-image", HTTP_OK, "OK");
		server.route("/sdapi/v1/txt2img", HTTP_OK, heldAnswer(), LONG_HOLD_MS);
		// Only the tool-call turn: the abort ends the run, so no answer turn is ever asked for.
		server.script({ tool: "generate_image", args: { prompt: "a red fox", size: "256x256" } });

		const prompt = harness.pi.client.promptAndWait("draw a fox", undefined, TURN_WAIT_MS);
		await new Promise((r) => setTimeout(r, ABORT_AFTER_MS));
		await harness.pi.client.abort();
		await prompt.catch(() => undefined);

		expect(server.log.map((r) => r.path)).toContain("/api/models/unload/qwen-image");
	});
});

describe("tool, vision model", () => {
	const harness = withPi("vision");

	test("hands the picture to the model and drops the blindness line", async () => {
		drawAndStop({ size: "256x256" });
		const end = await toolResult(harness.pi, "draw a fox");

		expect(detailsOf(end).seenByModel).toBe(true);
		expect(end.result?.content?.[0]?.text).not.toContain("You have NOT seen");
		expect(JSON.stringify(server.chats()[1])).toContain("image_url");
	});
});
