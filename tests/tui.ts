/**
 * pi's real interactive TUI in a pseudo-terminal, read back as a screen. This is the level for
 * what exists only on a terminal — a widget above the editor, a grey hint below it, a dialog —
 * and nothing else: anything RPC can see is cheaper and steadier to test there.
 *
 * The terminal is @microsoft/tui-test, which runs the program in a PTY and parses its output
 * with a real terminal engine (Alacritty's by default) in a native library, so pi's Kitty
 * keyboard protocol and its synchronized output are interpreted the way a terminal would, not
 * approximated. Measured on macOS arm64 with pi 1.4.0: pi-image's file runs in 4.7s, 3s of it the
 * image route held back on purpose, and passed 10 runs out of 10.
 *
 * Not in CI yet: the engine is a native library, and the runner's CPU has no AVX2 — the same
 * gap that killed fallow's musl build there. It goes in once a run on that runner has passed.
 *
 * Unlike RpcClient, the child gets only the environment given here: PATH and TERM are passed
 * on, everything else from the test's own environment is left out.
 */

import { TuiTest } from "@microsoft/tui-test";
import type { Home } from "./home.ts";
import { CLI, isolatedEnv, piArgs, ROOT } from "./pi.ts";

export type Tui = {
	term: TuiTest;
	/**
	 * Type a line and submit it. The Enter waits for the screen to settle first: typed straight
	 * after `/name`, it lands while the slash-command autocomplete is open, which takes it as
	 * "accept the completion" and leaves the line in the editor unsent.
	 */
	submit(line: string): Promise<void>;
	/** The visible screen as lines, `home` and the repository replaced by <HOME> and <ROOT>. */
	screen(): Promise<string[]>;
	/** The lines between the transcript and the editor's top border: what a widget above it shows. */
	aboveEditor(): Promise<string[]>;
	close(): Promise<void>;
};

// Wide enough that a temp-dir path in a widget line does not wrap (macOS puts it under /var/folders).
const COLS = 240;
const ROWS = 40;
/** The editor's borders are full-width rules of this character. */
const RULE = "─".repeat(COLS);

export async function startTui(name: string, home: Home, model?: string): Promise<Tui> {
	const term = TuiTest.ephemeral(`pi-${name}`, {
		trace: { mode: "on-failure", directory: ".tui-test/traces" },
	});
	await term.run(process.execPath, [CLI, ...piArgs(name, model)], {
		cols: COLS,
		rows: ROWS,
		cwd: ROOT,
		env: { PATH: process.env.PATH ?? "", TERM: "xterm-256color", ...isolatedEnv(home) },
	});
	// pi lists what it loaded once it is ready for input.
	await term.getByText("[Extensions]").expect({ timeout: 15_000 });

	const screen = async () =>
		(await term.text()).split("\n").map((l) => l.replaceAll(home.dir, "<HOME>").replaceAll(ROOT, "<ROOT>").trimEnd());

	return {
		term,
		async submit(line) {
			await term.type(line);
			await term.waitIdle();
			await term.press("Enter");
		},
		screen,
		async aboveEditor() {
			const lines = await screen();
			const top = lines.indexOf(RULE);
			if (top < 0) throw new Error(`no editor border on screen:\n${lines.join("\n")}`);
			let start = top;
			while (start > 0 && lines[start - 1] !== "") start--;
			return lines.slice(start, top);
		},
		close: () => term.closeQuiet(),
	};
}
