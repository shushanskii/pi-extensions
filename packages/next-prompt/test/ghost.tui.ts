/**
 * The one thing only a terminal shows: that the ghost text and another extension's prompt glyph
 * reach the same row of the same editor.
 *
 * next-prompt used to lose that row. pi's editor slot holds a single factory and setting it
 * replaces what was there, so an extension that installs its own editor at session_start evicted
 * the one that drew the suggestion — and did so silently, because the hint below the editor is
 * posted through a different API and kept appearing over an editor that no longer had a ghost.
 * The rival here replaces the slot the way pi-cc-extensions does; the assertion is that both
 * drawings now land.
 */

import { afterAll, beforeAll, expect, test } from "vitest";
import { type FakeServer, scriptedModels, startFakeServer } from "../../../tests/fake-server.ts";
import { type Home, makeHome } from "../../../tests/home.ts";
import { startTui, type Tui } from "../../../tests/tui.ts";
import { RIVAL_MARKER } from "./fixtures/rival-editor.ts";

/** What the scripted model returns as the guess. */
const SUGGESTION = "try the diff";
/** Relative to the repository root, which is where pi starts. */
const RIVAL = "./packages/next-prompt/test/fixtures/rival-editor.ts";

let server: FakeServer;
let home: Home;
let tui: Tui;

beforeAll(async () => {
	server = await startFakeServer();
	home = makeHome();
	home.agentFile("models.json", scriptedModels(server.url));
	// next-prompt first, the rival second: the later loader is the one that used to win the slot.
	tui = await startTui("next-prompt", home, "text-only", [RIVAL]);
});

afterAll(async () => {
	await tui?.close();
	await server?.close();
	home?.dispose();
});

test("the ghost lands on the row another extension drew", async () => {
	// Turn one answers the prompt; turn two is the guess asked for once the run has settled.
	server.script({ text: "the answer" }, { text: SUGGESTION });

	await tui.submit("hello");
	await tui.term.getByText("↳ suggestion").expect({ timeout: 15_000 });

	const line = await tui.editorLine();
	expect(line).toContain(RIVAL_MARKER);
	expect(line).toContain(SUGGESTION);
	expect(server.pending()).toBe(0);
});
