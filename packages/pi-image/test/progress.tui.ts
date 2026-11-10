/**
 * The progress line inside a real terminal: RPC proves the `tool_execution_update` events
 * arrive; only the TUI shows that the tool block actually re-renders them while the tool
 * is still running. The fake box answers the progress route with a fixed step and holds
 * the generation, so the line has to appear between submit and finish.
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import { type FakeServer, HTTP_OK, IMAGE_ROUTES, scriptedModels, startFakeServer } from "../../../tests/fake-server.ts";
import { type Home, makeHome } from "../../../tests/home.ts";
import { startTui, type Tui } from "../../../tests/tui.ts";

/** How long the fake box holds the generation: the poller ticks once a second. */
const HOLD_MS = 6000;
/** The fixed status: step 10 of 20, half done, ten seconds left. */
const PROGRESS_STEP = 10;
const PROGRESS_STEPS = 20;
const PROGRESS_FRACTION = 0.5;
const PROGRESS_ETA_SEC = 10;

let server: FakeServer;
let home: Home;
let tui: Tui;

beforeAll(async () => {
	server = await startFakeServer();
	home = makeHome();
	home.agentFile("models.json", scriptedModels(server.url));
	home.agentFile("image.json", { baseUrl: `${server.url}/v1` });
	tui = await startTui("pi-image", home, "text-only");
});

afterAll(async () => {
	await tui?.close();
	await server?.close();
	home?.dispose();
});

test("the block shows the sampling progress while the tool runs", async () => {
	// The keys are sd-server's A1111-shaped status, so they go in field by field.
	const state: Record<string, unknown> = {};
	state.sampling_step = PROGRESS_STEP;
	state.sampling_steps = PROGRESS_STEPS;
	const status: Record<string, unknown> = { state };
	status.progress = PROGRESS_FRACTION;
	status.eta_relative = PROGRESS_ETA_SEC;
	server.route("/upstream/qwen-image/sdapi/v1/progress", HTTP_OK, status);
	server.route("/sdapi/v1/txt2img", HTTP_OK, IMAGE_ROUTES["/sdapi/v1/txt2img"]?.body, HOLD_MS);
	server.script({ tool: "generate_image", args: { prompt: "a red fox", size: "256x256" } }, { text: "done" });

	await tui.submit("draw a fox");
	await tui.term.getByText(`sampling ${PROGRESS_STEP}/${PROGRESS_STEPS}`).expect({ timeout: 5000 });

	await tui.term.getByText("done").expect({ timeout: 15_000 });
	expect(server.pending()).toBe(0);
});
