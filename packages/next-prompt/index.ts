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

interface Config {
	enabled: boolean;
	/** Characters of the agent's last answer sent with the excerpt, taken from its end. */
	answerChars: number;
	/** Characters of your last message sent with the excerpt, taken from its start. */
	userChars: number;
	maxTokens: number;
	prompt: string;
}

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
// A suggestion is one line of ghost text; past this it stops being a hint and becomes a
// paragraph the user has to read before typing their own.
const MAX_SUGGESTION = 240;
// The guess is not creative work; a little randomness only makes it wander.
const GUESS_TEMPERATURE = 0.3;
// Editor padding sits on both sides, so usable width is width - pad * PADDING_SIDES.
const PADDING_SIDES = 2;
// An empty editor is three rendered lines: top border, content, bottom border. Fewer than
// that is not the editor this file knows, so the ghost stays off; more is the same frame
// with autocomplete appended below it, so the content line stays the middle one.
const EDITOR_FRAME_LINES = 3;

// What the model sometimes puts in front of the line it was asked for.
const LEAD_IN = /^(?:next message|user|пользователь|следующий запрос)\s*[:：-]\s*/iu;
const QUOTES = /^[`"'«“]+|[`"'»”]+$/gu;
const BOLD = /\*\*/gu;

type StreamOptions = NonNullable<Parameters<ExtensionContext["modelRegistry"]["streamSimple"]>[2]>;
// pi's options type lists the thinking levels a chat model offers and leaves "off" out, while
// pi-ai accepts it — EXTENDED_THINKING_LEVELS in pi-ai/models.js — and off is the whole point:
// a guess that spends thinking tokens arrives after the user has already typed. Widened one
// field at a time rather than with `as any`, so maxTokens, temperature and signal stay checked.
const REASONING_OFF = "off" as unknown as StreamOptions["reasoning"];

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
	if (typeof content === "string") {
		return content;
	}
	const texts: string[] = [];
	if (Array.isArray(content)) {
		for (const part of content) {
			if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
				texts.push(part.text);
			}
		}
	}
	return texts.join("\n").trim();
}

// pi's message and session-entry unions carry far more than the two fields read here, so the
// walks below take `unknown` and check what they touch instead of asserting a shape.
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function onOff(value: boolean): string {
	if (value) {
		return "on";
	}
	return "off";
}

function assistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const message = messages[i];
		if (isRecord(message) && message.role === "assistant") {
			const text = textOf(message.content);
			if (text) {
				return text;
			}
		}
	}
	return "";
}

/** The newest user message on the current branch, as plain text. */
function lastUserText(ctx: ExtensionContext): string {
	const branch: readonly unknown[] = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i];
		if (isRecord(entry) && entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") {
			const text = textOf(entry.message.content);
			if (text) {
				return text;
			}
		}
	}
	return "";
}

/** One clean line: the model sometimes quotes it, prefixes it, or wraps it in markdown. */
function oneLine(raw: string): string {
	const firstLine =
		raw
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	const stripped = firstLine.replace(LEAD_IN, "").replace(QUOTES, "").replace(BOLD, "").trim();
	if (stripped.length > MAX_SUGGESTION) {
		return `${stripped.slice(0, MAX_SUGGESTION - 1)}…`;
	}
	return stripped;
}

export default function (pi: ExtensionAPI) {
	let cfg = loadConfig();
	let { enabled } = cfg;
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
			if (!ghost || this.getText() !== "" || lines.length < EDITOR_FRAME_LINES) {
				return lines;
			}
			const pad = Math.min(this.getPaddingX(), Math.floor(width / PADDING_SIDES));
			const room = Math.max(1, width - pad * PADDING_SIDES - 1);
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
		generation += 1;
		inflight?.abort();
		inflight = undefined;
		if (ghost && ctx?.hasUI) {
			ctx.ui.setWidget(WIDGET, undefined);
		}
		ghost = "";
		tui?.requestRender();
	}

	function show(ctx: ExtensionContext, text: string) {
		ghost = text;
		ctx.ui.setWidget(WIDGET, [GREY(HINT)], { placement: "belowEditor" });
		tui?.requestRender();
	}

	async function guess(ctx: ExtensionContext) {
		if (!ctx.model) {
			return;
		}
		const answer = lastAnswer;
		const user = lastUserText(ctx);
		if (!(answer || user)) {
			return;
		}
		generation += 1;
		const mine = generation;
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
				{ maxTokens: cfg.maxTokens, temperature: GUESS_TEMPERATURE, reasoning: REASONING_OFF, signal: ac.signal },
			);
			const msg = await stream.result();
			if (mine !== generation || ac.signal.aborted) {
				return;
			}
			const line = oneLine(textOf(msg.content));
			// Only over an editor that is still empty: never over something the user wrote.
			if (line && !ctx.ui.getEditorText().trim()) {
				show(ctx, line);
			}
		} catch {
			// A failed or cancelled guess is silence, not a notification: the user did not ask.
		} finally {
			if (inflight === ac) {
				inflight = undefined;
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || unlisten) {
			return;
		}
		ctx.ui.setEditorComponent((t, theme, keybindings) => new GhostEditor(t, theme, keybindings));
		unlisten = ctx.ui.onTerminalInput((data) => {
			if (!ghost) {
				// A key before the guess arrived: the user is writing their own message.
				if (inflight) {
					clear(ctx);
				}
				return;
			}
			if (ctx.ui.getEditorText() !== "") {
				// Text got in some other way (paste, history): the ghost is no longer wanted.
				clear(ctx);
				return;
			}
			const text = ghost;
			if (ENTER.includes(data)) {
				// Fill the editor first; the Enter that follows submits it.
				clear(ctx);
				ctx.ui.setEditorText(text);
				return;
			}
			if (KEEP.includes(data)) {
				// Kept for editing; consumed so Tab does not also open autocomplete.
				clear(ctx);
				ctx.ui.setEditorText(text);
				return { consume: true };
			}
			clear(ctx);
			// Esc, Backspace and Delete only dismiss; any other key also types itself.
			if (DISMISS.includes(data)) {
				return { consume: true };
			}
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clear(ctx);
		unlisten?.();
		unlisten = undefined;
	});

	pi.on("agent_start", (_event, ctx) => clear(ctx));

	pi.on("agent_end", (event) => {
		lastAnswer = assistantText(event.messages);
	});

	pi.on("agent_settled", (event, ctx) => {
		if (!enabled || event.aborted || ctx.mode !== "tui") {
			return;
		}
		if (ctx.ui.getEditorText().trim()) {
			return;
		}
		// Not awaited: the handler would otherwise hold the session in "settling". A failed
		// guess is silence, not a notification — the user did not ask for it.
		guess(ctx).catch(() => {
			// Deliberately silent.
		});
	});

	pi.registerCommand("suggest", {
		description: "Next-prompt suggestions: on | off | reload",
		// pi types a command handler as returning Promise<void>, and this handler waits on
		// nothing: it flips a flag and prints state. The async stays for the type, and the
		// suppression says why rather than leaving a rule to be re-discovered.
		// biome-ignore lint/suspicious/useAwait: the handler type demands a promise, not a wait
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				if (!enabled) {
					clear(ctx);
				}
				ctx.ui.notify(`next-prompt ${onOff(enabled)}`, "info");
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
				`next-prompt ${onOff(enabled)} · model ${ctx.model?.id ?? "none"} · excerpt ${cfg.userChars}+${cfg.answerChars} chars`,
				"info",
			);
		},
	});
}
