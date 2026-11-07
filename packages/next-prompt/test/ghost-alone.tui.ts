/**
 * The base case: next-prompt alone, no other extension in sight.
 *
 * This is the case that broke when "is the slot already ours" was answered by comparing the
 * factory in the slot with this extension's own — before the first install both are `undefined`,
 * the comparison said yes, and nothing was ever installed. Nothing said so: the guess still ran,
 * the hint below the editor still appeared, and only the row inside the editor stayed empty. The
 * companion test cannot catch it, because there a second extension occupies the slot and the
 * re-install before the first suggestion papers over it.
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import { type FakeServer, scriptedModels, startFakeServer } from "../../../tests/fake-server.ts";
import { type Home, makeHome } from "../../../tests/home.ts";
import { startTui, type Tui } from "../../../tests/tui.ts";

const SUGGESTION = "run the tests";

let server: FakeServer;
let home: Home;
let tui: Tui;

beforeAll(async () => {
	server = await startFakeServer();
	home = makeHome();
	home.agentFile("models.json", scriptedModels(server.url));
	tui = await startTui("next-prompt", home, "text-only");
});

afterAll(async () => {
	await tui?.close();
	await server?.close();
	home?.dispose();
});

test("the ghost is drawn when nothing else claimed the editor", async () => {
	server.script({ text: "the answer" }, { text: SUGGESTION });

	await tui.submit("hello");
	await tui.term.getByText("↳ suggestion").expect({ timeout: 15_000 });

	expect(await tui.editorLine()).toContain(SUGGESTION);
	expect(server.pending()).toBe(0);
});
