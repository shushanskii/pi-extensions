/**
 * Read window.
 *
 * Blocks a `read` of a large file when no window was asked for, and names the
 * two commands that would have found the right lines instead.
 *
 * Why enforcement and not another sentence in AGENTS.md: the unit of reading in
 * this repository is a file, and the files are not small — srv02/llm/
 * deploy.sh is ~20k tokens, the tree ~150k. One unbounded read is a tenth of a
 * window spent before the first tool result, and the cost is not the invoice:
 * a model reasons worse over a window padded with code that turned out not to
 * matter. The rule reads well and gets ignored under load, which is exactly
 * when it is needed.
 *
 * Blocking, not silently clamping. A clamp hides content and the reader never
 * learns the file was bigger than the window it got, so it answers from a
 * fragment it believes is the whole. A refusal is a fact the reader can act on.
 *
 * Escape hatches, both honoured without argument: pass `limit` (or `offset`)
 * and the read is yours, because you chose the window; and the threshold is
 * line-based, so the 90-line README nobody has to search is never in the way.
 *
 * Measured on this repository, two arms, three runs each, on a 350-line plan:
 * reading it whole cost 5.5k tokens of window and 2.3 turns for 6.0 of seven
 * facts; one 70-line window at a section boundary cost 1.2k and got six; a
 * five-window sweep got seven for ten turns. The block is therefore not the win
 * — the single well-placed window is, and the sweep is how this rule loses, so
 * the refusal below spends its last words forbidding it rather than repeating
 * the command that produced it.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_LINES = 200;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "read") {
			return;
		}

		const input = event.input as { path?: string; offset?: number; limit?: number };
		if (!input.path || input.offset !== undefined || input.limit !== undefined) {
			return;
		}

		// Unreadable here means unreadable there too; never block on a guess.
		let lines: number;
		try {
			const text = readFileSync(input.path, "utf8");
			const split = text.split("\n");
			// A trailing newline is not a line: wc -l and this have to agree, or the
			// refusal quotes a number the reader cannot reproduce.
			if (text.endsWith("\n")) {
				split.pop();
			}
			lines = split.length;
		} catch {
			return;
		}
		if (lines <= MAX_LINES) {
			return;
		}

		return {
			block: true,
			reason:
				`${input.path} is ${lines} lines and no window was requested. ` +
				`Take the shape — ./tools/map.sh ${input.path}, or rg -n '^#{1,3} ' ${input.path} — then read ONE window, ~120 lines, at a section boundary. ` +
				"A second window goes where the search points, never at the next line after the first: windows that add up to the file cost more than the file did. " +
				"If the whole file really is the task, pass an explicit limit and this stops applying.",
		};
	});
}
