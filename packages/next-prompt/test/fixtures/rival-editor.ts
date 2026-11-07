/**
 * A second extension claiming the editor slot the way pi-cc-extensions does — by replacing it
 * outright — so the test reproduces the collision next-prompt used to lose: whoever wrote the
 * slot last owned the editor, and the other's `render` never ran.
 *
 * It paints a marker over the first column of the content line, the place a prompt glyph sits.
 * The test then asks for both the marker and the ghost text on that row: the marker proves the
 * rival still draws, the ghost proves next-prompt draws on top of it rather than instead of it.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

class RivalEditor extends CustomEditor {
	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length > 2 && lines[1]?.length) {
			lines[1] = RIVAL_MARKER + lines[1].slice(1);
		}
		return lines;
	}
}

/** Painted over the editor's first content column, where a prompt glyph would sit. */
export const RIVAL_MARKER = "R";

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			return;
		}
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new RivalEditor(tui, theme, keybindings));
	});
}
