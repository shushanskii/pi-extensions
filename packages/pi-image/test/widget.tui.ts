/**
 * The one thing pi-image does that only a terminal shows: the widget above the editor that
 * `/image test` keeps while it waits, keeps after it is done, and loses when the next turn
 * starts. RPC sees the setWidget calls; only the TUI shows where the lines land and that the
 * clear actually clears them.
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import { type FakeServer, HTTP_OK, IMAGE_ROUTES, scriptedModels, startFakeServer } from "../../../tests/fake-server.ts";
import { type Home, makeHome } from "../../../tests/home.ts";
import { startTui, type Tui } from "../../../tests/tui.ts";

let server: FakeServer;
let home: Home;
let tui: Tui;

/** Slow enough that the live line is on screen long enough to be read. */
const ROUTE_DELAY_MS = 3000;
const GENERATIONS_DONE =
	/^ image: ✓ 1\/2 images\/generations \d+s — <HOME>\/tmp\/pi-image-test-\d+-\d+\.png \(size 256x256, png\)$/u;
const SDAPI_DONE =
	/^ image: ✓ 2\/2 sdapi\/txt2img \d+s — <HOME>\/tmp\/pi-image-test-\d+-\d+-sdapi\.png \(steps 12, cfg 6, seed -1\)$/u;

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

test("/image test keeps a widget above the editor until the next turn", async () => {
	const path = "/v1/images/generations";
	server.route(path, HTTP_OK, IMAGE_ROUTES[path]?.body, ROUTE_DELAY_MS);

	await tui.submit("/image test");
	// The counter has to move: a frozen "… 0s" reads as a hung command, which is what the widget is for.
	await tui.term.getByText("image: 1/2 images/generations … 1s").expect();
	expect(await tui.aboveEditor()).toEqual([" image: 1/2 images/generations … 1s"]);

	await tui.term.getByText("image: done in").expect({ timeout: 10_000 });
	expect(await tui.aboveEditor()).toEqual([expect.stringMatching(GENERATIONS_DONE), expect.stringMatching(SDAPI_DONE)]);

	server.script({ text: "the next turn" });
	await tui.submit("hello");
	await tui.term.getByText("the next turn").expect();
	expect(await tui.aboveEditor()).toEqual([]);
	expect(server.pending()).toBe(0);
});
