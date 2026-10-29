/**
 * pi-image inside a real pi, in RPC mode: the scripted model calls `generate_image`, pi runs the
 * tool against the fake image endpoints, and the test reads what came back through pi's own
 * event stream and what pi sent the model on the next turn.
 */

import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { type FakeServer, scriptedModels, startFakeServer } from "../../../tests/fake-server.ts";
import { type Home, makeHome } from "../../../tests/home.ts";
import { type Pi, startPi } from "../../../tests/rpc.ts";

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
	const it = withPi();

	test("registers /image and nothing else", async () => {
		const commands = await it.pi.client.getCommands();
		expect(commands.map((c) => c.name)).toEqual(["image"]);
	});

	test("/image config reports the config from the isolated HOME", async () => {
		await it.pi.client.prompt("/image config");
		const r = await it.pi.waitForUi((r) => r.method === "notify");
		expect(r.message).toBe(`image: ${server.url}/v1 · qwen-image · 1024x1024 · ${home.dir}/pictures`);
	});

	test("/image test walks both routes and keeps a widget line for each", async () => {
		await it.pi.client.prompt("/image test");
		const done = await it.pi.waitForUi((r) => r.method === "notify");
		expect(done).toMatchObject({ notifyType: "info", message: expect.stringMatching(/^image: done in \d+s$/) });

		expect(server.log.map((r) => r.path)).toEqual(["/v1/images/generations", "/sdapi/v1/txt2img"]);
		expect(server.log[1]?.body).toMatchObject({ steps: 12, width: 256, height: 256 });

		const widgets = it.pi.ui.filter((r) => r.method === "setWidget" && r.widgetKey === "pi-image");
		const last = widgets.at(-1)?.widgetLines ?? [];
		expect(last).toHaveLength(2);
		expect(last[0]).toMatch(/^image: ✓ 1\/2 images\/generations \d+s — .*pi-image-test-.*\.png \(size 256x256, png\)$/);
		expect(last[0]).toContain(`— ${home.tmp}/pi-image-test-`);
		expect(last[1]).toMatch(/^image: ✓ 2\/2 sdapi\/txt2img \d+s — .*-sdapi\.png \(steps 12, cfg 6, seed -1\)$/);
	});

	test("/image test stops at the first failing route and says so", async () => {
		server.route("/v1/images/generations", 503, { error: "model is loading" });
		await it.pi.client.prompt("/image test");
		const done = await it.pi.waitForUi((r) => r.method === "notify");
		expect(done).toMatchObject({ notifyType: "error", message: expect.stringMatching(/^image: failed after/) });
		expect(server.log.map((r) => r.path)).toEqual(["/v1/images/generations"]);
		const last = it.pi.ui.filter((r) => r.method === "setWidget").at(-1)?.widgetLines;
		expect(last).toEqual([
			'image: ✗ 1/2 images/generations — qwen-image: HTTP 503 from /v1/images/generations — {"error":"model is loading"}',
		]);
	});
});

/** The model asks for a picture, then says it is done. */
function drawAndStop(args: Record<string, unknown>) {
	server.script({ tool: "generate_image", args: { prompt: "a red fox", ...args } }, { text: "done" });
}

async function toolResult(pi: Pi, message: string) {
	const events = (await pi.client.promptAndWait(message, undefined, 15_000)) as any[];
	const end = events.find((e) => e.type === "tool_execution_end");
	expect(end, "tool_execution_end").toBeDefined();
	return end as { isError: boolean; result: { content: any[]; details: any } };
}

describe("tool, text-only model", () => {
	const it = withPi("text-only");

	test("writes the file, names it, and says the model has not seen it", async () => {
		drawAndStop({ size: "256x256" });
		const end = await toolResult(it.pi, "draw a fox");

		expect(end.isError).toBe(false);
		expect(server.log.find((r) => r.path === "/v1/images/generations")?.body).toEqual({
			model: "qwen-image",
			prompt: "a red fox",
			n: 1,
			size: "256x256",
			output_format: "png",
		});
		const file = end.result.details.files[0].path as string;
		expect(file.startsWith(`${home.dir}/pictures/`)).toBe(true);
		expect(file).toMatch(/-a-red-fox\.png$/);
		expect(existsSync(file)).toBe(true);
		expect(end.result.details).toMatchObject({ route: "images/generations", seen_by_model: false });
		expect(end.result.content[0].text).toContain("You have NOT seen these: the active model (text-only)");

		// What pi sent the model after the tool ran: the path, and no image.
		const followUp = JSON.stringify(server.chats()[1]);
		expect(followUp).toContain(file);
		expect(followUp).not.toContain("image_url");
	});

	test("a seed moves the request to the SDAPI route", async () => {
		drawAndStop({ size: "256x256", seed: 7 });
		const end = await toolResult(it.pi, "the same fox again");

		expect(end.result.details.route).toBe("sdapi/txt2img");
		expect(server.log.find((r) => r.path === "/sdapi/v1/txt2img")?.body).toMatchObject({ seed: 7, steps: 20 });
	});

	test("a size the model cannot draw is an error, and nothing is posted", async () => {
		drawAndStop({ size: "300x300" });
		const end = await toolResult(it.pi, "a fox at an odd size");

		expect(end.isError).toBe(true);
		expect(end.result.content[0].text).toBe("width 300 is not divisible by 32");
		expect(server.log.filter((r) => r.path !== "/v1/chat/completions")).toEqual([]);
	});
});

describe("tool, vision model", () => {
	const it = withPi("vision");

	test("hands the picture to the model and drops the blindness line", async () => {
		drawAndStop({ size: "256x256" });
		const end = await toolResult(it.pi, "draw a fox");

		expect(end.result.details.seen_by_model).toBe(true);
		expect(end.result.content[0].text).not.toContain("You have NOT seen");
		expect(JSON.stringify(server.chats()[1])).toContain("image_url");
	});
});
