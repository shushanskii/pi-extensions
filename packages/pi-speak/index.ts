/**
 * pi-speak — one spoken sentence at the end of a turn, in Russian.
 *
 * The ears were already there (pi-voice-stt → the whisper on llm.rezolver-zero.com);
 * this is the mouth: POST /v1/audio/speech to the piper in the same container, which
 * the LLM host's deploy script installs and llama-swap routes. One domain, one auth, one
 * certificate for both directions.
 *
 * Why a summary and not the answer: a forty-line answer is three minutes of speech,
 * and nobody wants to listen to a diff. `summarize: true` asks the session model for
 * one sentence before speaking it — the same trick pi-voice documents, and the reason
 * the request is cheap is that the model is already resident.
 *
 * Why piper and not Kokoro: Kokoro's eight languages do not include Russian. This
 * voice reads Russian answers, so the voice has to speak Russian.
 *
 * Why agent_settled and not agent_end: agent_end fires after each low-level run, and
 * Pi may still retry, compact or continue with queued work. Settling is the moment the
 * answer is the answer.
 *
 * Config: ~/.pi/agent/tts.json, same directory and plaintext convention as stt.json.
 * Switching: `/speak on` and `/speak off`, or alt+v anywhere; a bare `/speak` only
 * prints what is in force. Nothing is spoken in print/JSON mode — those runs
 * are piped, and a voice on a pipe is a bug report.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Config {
	enabled: boolean;
	summarize: boolean;
	endpoint: string;
	model: string;
	apiKey: string;
	voice: string;
	speed: number;
	maxChars: number;
	player: string | null;
	summaryPrompt: string;
}

const DEFAULTS: Config = {
	enabled: true,
	summarize: true,
	endpoint: "https://llm.rezolver-zero.com/v1/audio/speech",
	model: "piper",
	apiKey: "",
	voice: "",
	speed: 1.05,
	maxChars: 600,
	player: null,
	summaryPrompt:
		"Ты произносишь итог вслух. Одно предложение по-русски: что сделано и что теперь. " +
		"Никаких путей, имён файлов, кода, ссылок и списков — это не выговорить. Без кавычек и markdown.",
};

const CONFIG_PATH = join(process.env.HOME ?? "", ".pi", "agent", "tts.json");

// Not the budget — that is `maxChars` in tts.json, 600 by default. When an answer
// overflows it, the cut is taken at the last sentence end inside the budget, but only if
// that end sits past this floor: text whose only period lands at character 40 would
// otherwise be spoken as 40 characters out of the 600 it was given.
const MIN_SENTENCE_CHARS = 80;
// A WAV header alone is 44 bytes, and the magic number is what separates a real file from the
// JSON error body that arrives with the same speed.
const MIN_WAV_BYTES = 44;
const RIFF_TAG = "RIFF";
// How much of a wrong response is quoted back before it stops being informative.
const ERROR_BODY_CHARS = 160;
const PREVIEW_BYTES = 120;
// The answer, not the transcript: the summary is of what was said.
const SUMMARY_INPUT_CHARS = 8000;

// The player this OS ships: afplay on macOS, paplay on Linux, and nothing elsewhere, which
// surfaces as the "no audio player" error rather than as a guess at a binary.
function defaultPlayer(): string {
	if (process.platform === "darwin") {
		return "afplay";
	}
	if (process.platform === "linux") {
		return "paplay";
	}
	return "";
}

function loadConfig(): Config {
	try {
		return { ...DEFAULTS, ...(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>) };
	} catch {
		return { ...DEFAULTS };
	}
}

/**
 * Markdown to something a voice can say. Fenced code is dropped rather than read:
 * a voice reciting backticks is the failure this file exists to avoid. Everything
 * else degrades to its own words.
 */
function speakable(text: string, maxChars: number): string {
	const out = text
		.replace(/```[\s\S]*?```/gu, " ")
		.replace(/`(?<inlineCode>[^`]*)`/gu, "$<inlineCode>")
		.replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
		.replace(/\[(?<label>[^\]]*)\]\([^)]*\)/gu, "$<label>")
		.replace(/^\s{0,3}#{1,6}\s+/gmu, "")
		.replace(/^\s*[-*+]\s+/gmu, "")
		.replace(/^\s*>\s?/gmu, "")
		.replace(/\|/gu, " ")
		.replace(/[*_]{1,3}(?<emphasis>[^*_\n]+)[*_]{1,3}/gu, "$<emphasis>")
		.replace(/\s+/gu, " ")
		.trim();
	if (out.length <= maxChars) {
		return out;
	}
	// Cut at the last sentence end inside the budget, not at the budget: a voice
	// stopping mid-word is heard as a broken endpoint.
	const head = out.slice(0, maxChars);
	const stop = Math.max(head.lastIndexOf("."), head.lastIndexOf("!"), head.lastIndexOf("?"));
	if (stop > MIN_SENTENCE_CHARS) {
		return head.slice(0, stop + 1);
	}
	return head.trim();
}

// pi's message union carries far more than the two fields read here, so the walk takes
// `unknown` and checks what it touches instead of asserting a shape.
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function textOf(content: unknown): string {
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

// The one-line shape of a thrown value, for a notice.
function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
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

export default function (pi: ExtensionAPI) {
	let cfg = loadConfig();
	let { enabled } = cfg;
	let pending: Promise<void> = Promise.resolve();
	let player: ReturnType<typeof spawn> | undefined;
	let lastAnswer = "";
	let warned = false;

	const pickPlayer = () => cfg.player ?? defaultPlayer();

	function notify(ctx: ExtensionContext | undefined, text: string) {
		// Once per session for the recurring failures: a dead endpoint should not
		// talk over the terminal on every turn.
		if (warned || !ctx?.hasUI) {
			return;
		}
		warned = true;
		ctx.ui.notify(text, "warning");
	}

	async function synthesize(text: string): Promise<Buffer> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (cfg.apiKey) {
			headers.Authorization = `Bearer ${cfg.apiKey}`;
		}
		const body: Record<string, unknown> = { model: cfg.model, input: text, speed: cfg.speed };
		if (cfg.voice) {
			body.voice = cfg.voice;
		}

		const res = await fetch(cfg.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
		if (!res.ok) {
			throw new Error(`${res.status}: ${(await res.text()).slice(0, ERROR_BODY_CHARS)}`);
		}
		const wav = Buffer.from(await res.arrayBuffer());
		// The magic number, because a JSON error body arrives with the same speed
		// and a client that only counts bytes plays silence and blames the voice.
		if (wav.length < MIN_WAV_BYTES || wav.subarray(0, RIFF_TAG.length).toString("latin1") !== RIFF_TAG) {
			throw new Error(`response is not wav: ${wav.subarray(0, PREVIEW_BYTES).toString("utf8")}`);
		}
		return wav;
	}

	function play(wav: Buffer): Promise<void> {
		const cmd = pickPlayer();
		if (!cmd) {
			return Promise.reject(new Error('no audio player: set "player" in tts.json'));
		}
		const dir = mkdtempSync(join(tmpdir(), "pi-speak-"));
		const file = join(dir, "say.wav");
		return new Promise((resolve, reject) => {
			try {
				writeFileSync(file, wav);
			} catch (e) {
				rmSync(dir, { recursive: true, force: true });
				reject(e as Error);
				return;
			}
			// A file, not a pipe: afplay has no stdin.
			player = spawn(cmd, [file], { stdio: "ignore" });
			player.on("error", (e) => {
				rmSync(dir, { recursive: true, force: true });
				reject(e);
			});
			player.on("close", () => {
				player = undefined;
				rmSync(dir, { recursive: true, force: true });
				resolve();
			});
		});
	}

	/** One sentence from the model that just answered, for the voice to say. */
	async function summarize(text: string, ctx: ExtensionContext): Promise<string> {
		if (!(cfg.summarize && ctx.model)) {
			return text;
		}
		const stream = ctx.modelRegistry.streamSimple(
			ctx.model,
			{
				systemPrompt: cfg.summaryPrompt,
				// The answer, not the transcript: the summary is of what was said,
				// and the transcript would pay for every tool result again.
				messages: [{ role: "user", content: text.slice(0, SUMMARY_INPUT_CHARS), timestamp: Date.now() }],
			},
			// Thinking off: a reasoning model that deliberates over a one-line
			// summary is slower than the speech it is preparing. Leaving `reasoning`
			// out is how off is spelled — pi's ThinkingLevel starts at "minimal" and
			// has no "off" to pass, and pi's own summarizer sends the session level
			// only when it is not off (compaction.js), so an absent option is the only
			// way to say no thinking. rewrite-compact does the same.
			{ maxTokens: 160, temperature: 0.2 },
		);
		const msg = await stream.result();
		const spoken = textOf(msg.content ?? [])
			.replace(/\n+/gu, " ")
			.trim();
		return spoken || text;
	}

	/**
	 * What the voice says: the text itself when it was written for the voice, otherwise the
	 * model's one-sentence summary, falling back to the text when the summary fails — silence
	 * is worse than a long sentence.
	 */
	function spokenText(text: string, ctx: ExtensionContext | undefined, raw: boolean): Promise<string> {
		if (raw || !ctx) {
			return Promise.resolve(text);
		}
		return summarize(text, ctx).catch(() => text);
	}

	function say(text: string, ctx: ExtensionContext | undefined, raw = false) {
		let wanted = text;
		if (!raw) {
			wanted = speakable(text, cfg.maxChars);
		}
		if (!wanted) {
			return;
		}
		// Chained, never awaited by the caller: playback outlives the turn, and a
		// handler that waits for a voice holds the session open.
		pending = pending
			.then(async () => {
				const spoken = await spokenText(wanted, ctx, raw);
				const wav = await synthesize(speakable(spoken, cfg.maxChars));
				await play(wav);
			})
			.catch((e: unknown) => notify(ctx, `speak: ${messageOf(e)}`));
	}

	pi.on("agent_end", (event) => {
		lastAnswer = assistantText(event.messages);
	});

	pi.on("agent_settled", (event, ctx) => {
		const text = lastAnswer;
		lastAnswer = "";
		if (!enabled || event.aborted || !text) {
			return;
		}
		if (ctx.mode !== "tui") {
			return;
		}
		say(text, ctx);
	});

	pi.registerTool({
		name: "speak",
		label: "Speak",
		description:
			"Say one short sentence out loud through the lab voice. Use it when a line is worth hearing; everything else stays on screen.",
		parameters: Type.Object({
			text: Type.String({ description: "One or two plain sentences. No markdown, no code, no paths." }),
		}),
		// pi types execute as Promise-returning; this one answers at once because playback is
		// chained onto `pending` and outlives the call — waiting for the voice would hold the
		// tool call open for the length of the sentence.
		// biome-ignore lint/suspicious/useAwait: the tool type demands a promise, not a wait
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			say(String(params.text ?? ""), ctx as unknown as ExtensionContext, true);
			return { content: [{ type: "text", text: "spoken" }], details: undefined };
		},
	});

	pi.registerCommand("speak", {
		description: "Voice: on | off | test | reload | <text to say>",
		// pi types a command handler as Promise-returning; nothing here waits, it flips a flag
		// and prints state. The async stays for the type.
		// biome-ignore lint/suspicious/useAwait: the handler type demands a promise, not a wait
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg === "off" || arg === "on") {
				enabled = arg === "on";
				if (!enabled && player) {
					player.kill();
				}
				ctx.ui.notify(`voice ${onOff(enabled)} (${cfg.model} @ ${new URL(cfg.endpoint).host})`, "info");
				return;
			}
			if (arg === "test") {
				say("Проверка: у агента появился голос.", ctx, true);
				return;
			}
			if (arg === "reload") {
				cfg = loadConfig();
				warned = false;
				ctx.ui.notify(`voice config reloaded: ${cfg.model}, summarize=${cfg.summarize}`, "info");
				return;
			}
			if (!arg) {
				ctx.ui.notify(
					`voice ${onOff(enabled)} · ${cfg.endpoint} · model ${cfg.model} · summarize ${onOff(cfg.summarize)}`,
					"info",
				);
				return;
			}
			say(arg, ctx, true);
		},
	});

	pi.registerShortcut(Key.alt("v"), {
		description: "Toggle the voice",
		handler: (ctx) => {
			enabled = !enabled;
			if (!enabled && player) {
				player.kill();
			}
			ctx.ui.notify(`voice ${onOff(enabled)}`, "info");
		},
	});
}
