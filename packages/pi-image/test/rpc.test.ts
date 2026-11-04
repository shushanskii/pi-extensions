/**
 * pi-image inside a real pi, in RPC mode: the scripted model calls `generate_image`, pi runs the
 * tool against the fake image endpoints, and the test reads what came back through pi's own
 * event stream and what pi sent the model on the next turn.
 */

import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { type FakeServer, scriptedModels, startFakeServer } from "../../../tests/fake-server.ts";
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
const GENERATIONS_LINE = /^image: ✓ 1\/2 images\/generations \d+s — .*pi-image-test-.*\.png \(size 256x256, png\)$/u;
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

/** The body pi-image posted, with `output_format` spelled the way the server wants it. */
function expectedGenerationBody(size: string): Record<string, unknown> {
	const body: Record<string, unknown> = { model: "qwen-image", prompt: "a red fox", n: 1, size };
	body.output_format = "png";
	return body;
}

describe("tool, text-only model", () => {
	const harness = withPi("text-only");

	test("writes the file, names it, and says the model has not seen it", async () => {
		drawAndStop({ size: "256x256" });
		const end = await toolResult(harness.pi, "draw a fox");

		expect(end.isError).toBe(false);
		expect(server.log.find((r) => r.path === "/v1/images/generations")?.body).toEqual(
			expectedGenerationBody("256x256"),
		);
		const details = detailsOf(end);
		expect(details.files[0].path.startsWith(`${home.dir}/pictures/`)).toBe(true);
		expect(details.files[0].path).toMatch(FOX_FILE);
		expect(existsSync(details.files[0].path)).toBe(true);
		expect(details).toMatchObject({ route: "images/generations", seenByModel: false });
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
