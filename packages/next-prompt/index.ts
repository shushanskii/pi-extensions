/**
 * next-prompt — a suggested next message, shown as grey ghost text in the empty editor.
 *
 * Claude Code guesses what you will type next; pi has no such thing, so this is one: when
 * a run has settled and the editor is empty, the session model gets a short excerpt — your
 * last message and the end of its answer — and returns one line, drawn greyed out inside
 * the editor. The editor itself stays empty, so the suggestion can never leak into what is
 * sent: Enter sends it, Tab or → puts it in the editor for editing, Esc, Backspace or
 * Delete dismiss it, and any other key dismisses it and types itself. Typing while a guess
 * is still in flight cancels the guess.
 *
 * Why an excerpt and not the transcript: the lab has one model and one request queue. A
 * request with a different system prompt does not match the engine's conversation cache,
 * so sending a 150k-token session would re-read all of it — minutes during which the real
 * next turn waits. One or two thousand tokens cost about a second, and Strata does not
 * park a request that short, so the session's own cache entry stays where it was.
 *
 * How the grey text is drawn: a subclass of pi's CustomEditor that replaces only the
 * empty content line in render() and leaves everything else — borders, autocomplete, app
 * keys — to the parent. It is installed once with setEditorComponent; another extension
 * that installs its own editor would replace it, and then only the hint line remains.
 *
 * No Alt shortcut on purpose: on macOS Option is not Meta unless the terminal is told so,
 * and alt+s arrived as "ß" — a key the listener rightly took for typing.
 *
 * Config: ~/.pi/agent/next-prompt.json (optional; every key has a default below).
 * Toggle: /suggest on | off | reload, or /suggest for the state. Interactive mode only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type EditorTheme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Config = {
	enabled: boolean;
	/** Characters of the agent's last answer sent with the excerpt, taken from its end. */
	answerChars: number;
	/** Characters of your last message sent with the excerpt, taken from its start. */
	userChars: number;
	maxTokens: number;
	prompt: string;
};

const DEFAULTS: Config = {
	enabled: true,
	answerChars: 4000,
	userChars: 1500,
	maxTokens: 80,
	prompt:
		"You predict the user's next message to a coding agent. Read the user's last message and " +
		"the end of the agent's answer, and write the single most likely next message the user " +
		"would send: short, concrete, in the same language as the user's message, written as the " +
		"user (imperative or a question), not as the agent. One line. No quotes, no markdown, no " +
		"preamble. If the answer asks the user a question, the next message is the user's answer.",
};

const CONFIG_PATH = join(process.env.HOME ?? "", ".pi", "agent", "next-prompt.json");
const WIDGET = "next-prompt";
const HINT = "↳ suggestion · Enter send · Tab/→ edit · Esc dismiss";
const GREY = (s: string) => `\x1b[90m${s}\x1b[39m`;
// Raw terminal input, as the listener receives it before the editor does.
const ENTER = ["\r", "\n"];
const KEEP = ["\t", "\x1b[C", "\x1bOC"]; // Tab, → (normal and application cursor mode)
const DISMISS = ["\x1b", "\x7f", "\x1b[3~"]; // Esc, Backspace, Delete

function loadConfig(): Config {
	try {
		return { ...DEFAULTS, ...(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>) };
	} catch {
		return { ...DEFAULTS };
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n")
		.trim();
}

function assistantText(messages: readonly any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		const text = textOf(m.content);
		if (text) return text;
	}
	return "";
}

/** The newest user message on the current branch, as plain text. */
function lastUserText(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch() as readonly any[];
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e?.type === "message" && e.message?.role === "user") {
			const text = textOf(e.message.content);
			if (text) return text;
		}
	}
	return "";
}

/** One clean line: the model sometimes quotes it, prefixes it, or wraps it in markdown. */
function oneLine(raw: string): string {
	let s =
		raw
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0) ?? "";
	s = s.replace(/^(next message|user|пользователь|следующий запрос)\s*[:：-]\s*/i, "");
	s = s
		.replace(/^[`"'«“]+|[`"'»”]+$/g, "")
		.replace(/\*\*/g, "")
		.trim();
	return s.length > 240 ? `${s.slice(0, 239)}…` : s;
}

export default function (pi: ExtensionAPI) {
	let cfg = loadConfig();
	let enabled = cfg.enabled;
	let lastAnswer = "";
	// The suggestion currently drawn as ghost text; empty when there is none.
	let ghost = "";
	let inflight: AbortController | undefined;
	// Bumped by every event that makes a pending guess stale; a result only lands if
	// its generation is still the current one.
	let generation = 0;
	let unlisten: (() => void) | undefined;
	let tui: TUI | undefined;

	class GhostEditor extends CustomEditor {
		constructor(t: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
			super(t, theme, keybindings);
			tui = t;
		}

		render(width: number): string[] {
			const lines = super.render(width);
			// Only an empty, single-line editor gets the ghost: top border, one content line,
			// bottom border, then whatever autocomplete appends.
			if (!ghost || this.getText() !== "" || lines.length < 3) return lines;
			const pad = Math.min(this.getPaddingX(), Math.floor(width / 2));
			const room = Math.max(1, width - pad * 2 - 1);
			const text = truncateToWidth(ghost, room, "…");
			// The marker places the terminal's own cursor at the start; a fake cursor would
			// paint the first letter in reverse video and make it look typed, not suggested.
			const body = `${CURSOR_MARKER}${GREY(text)}`;
			const fill = " ".repeat(Math.max(0, width - pad * 2 - visibleWidth(text)));
			lines[1] = `${" ".repeat(pad)}${body}${fill}${" ".repeat(pad)}`;
			return lines;
		}
	}

	/** Forget the suggestion and the guess behind it. */
	function clear(ctx: ExtensionContext | undefined) {
		generation++;
		inflight?.abort();
		inflight = undefined;
		if (ghost && ctx?.hasUI) ctx.ui.setWidget(WIDGET, undefined);
		ghost = "";
		tui?.requestRender();
	}

	function show(ctx: ExtensionContext, text: string) {
		ghost = text;
		ctx.ui.setWidget(WIDGET, [GREY(HINT)], { placement: "belowEditor" });
		tui?.requestRender();
	}

	async function guess(ctx: ExtensionContext) {
		if (!ctx.model) return;
		const answer = lastAnswer;
		const user = lastUserText(ctx);
		if (!answer && !user) return;
		const mine = ++generation;
		const ac = new AbortController();
		inflight = ac;
		const excerpt =
			`User's last message:\n${user.slice(0, cfg.userChars)}\n\n` +
			`End of the agent's answer:\n${answer.slice(-cfg.answerChars)}`;
		try {
			const stream = ctx.modelRegistry.streamSimple(
				ctx.model,
				{ systemPrompt: cfg.prompt, messages: [{ role: "user", content: excerpt, timestamp: Date.now() }] },
				// Thinking off and a short cap: the guess has to arrive before the user
				// starts typing, and every second here is a second the queue is busy.
				{ maxTokens: cfg.maxTokens, temperature: 0.3, reasoning: "off", signal: ac.signal } as any,
			);
			const msg = await stream.result();
			if (mine !== generation || ac.signal.aborted) return;
			const line = oneLine(textOf(msg.content));
			// Only over an editor that is still empty: never over something the user wrote.
			if (line && !ctx.ui.getEditorText().trim()) show(ctx, line);
		} catch {
			// A failed or cancelled guess is silence, not a notification: the user did not ask.
		} finally {
			if (inflight === ac) inflight = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || unlisten) return;
		ctx.ui.setEditorComponent((t, theme, keybindings) => new GhostEditor(t, theme, keybindings));
		unlisten = ctx.ui.onTerminalInput((data) => {
			if (!ghost) {
				// A key before the guess arrived: the user is writing their own message.
				if (inflight) clear(ctx);
				return undefined;
			}
			if (ctx.ui.getEditorText() !== "") {
				// Text got in some other way (paste, history): the ghost is no longer wanted.
				clear(ctx);
				return undefined;
			}
			const text = ghost;
			if (ENTER.includes(data)) {
				// Fill the editor first; the Enter that follows submits it.
				clear(ctx);
				ctx.ui.setEditorText(text);
				return undefined;
			}
			if (KEEP.includes(data)) {
				// Kept for editing; consumed so Tab does not also open autocomplete.
				clear(ctx);
				ctx.ui.setEditorText(text);
				return { consume: true };
			}
			clear(ctx);
			// Esc, Backspace and Delete only dismiss; any other key also types itself.
			return DISMISS.includes(data) ? { consume: true } : undefined;
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clear(ctx);
		unlisten?.();
		unlisten = undefined;
	});

	pi.on("agent_start", (_event, ctx) => clear(ctx));

	pi.on("agent_end", (event) => {
		lastAnswer = assistantText(event.messages as readonly any[]);
	});

	pi.on("agent_settled", (event, ctx) => {
		if (!enabled || event.aborted || ctx.mode !== "tui") return;
		if (ctx.ui.getEditorText().trim()) return;
		// Not awaited: the handler would otherwise hold the session in "settling".
		void guess(ctx);
	});

	pi.registerCommand("suggest", {
		description: "Next-prompt suggestions: on | off | reload",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				if (!enabled) clear(ctx);
				ctx.ui.notify(`next-prompt ${enabled ? "on" : "off"}`, "info");
				return;
			}
			if (arg === "reload") {
				cfg = loadConfig();
				ctx.ui.notify(
					`next-prompt config reloaded (${cfg.userChars}+${cfg.answerChars} chars, ${cfg.maxTokens} tokens)`,
					"info",
				);
				return;
			}
			ctx.ui.notify(
				`next-prompt ${enabled ? "on" : "off"} · model ${ctx.model?.id ?? "none"} · excerpt ${cfg.userChars}+${cfg.answerChars} chars`,
				"info",
			);
		},
	});
}
