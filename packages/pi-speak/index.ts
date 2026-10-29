/**
 * pi-speak — one spoken sentence at the end of a turn, in Russian.
 *
 * The ears were already there (pi-voice-stt → the whisper on llm.rezolver-zero.com);
 * this is the mouth: POST /v1/audio/speech to the piper in the same container, which
 * srv02/llm/deploy.sh installs and llama-swap routes. One domain, one auth, one
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
 * Toggle: /speak, or alt+v anywhere. Nothing is spoken in print/JSON mode — those runs
 * are piped, and a voice on a pipe is a bug report.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Config = {
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
};

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
	let out = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/\|/g, " ")
		.replace(/[*_]{1,3}([^*_\n]+)[*_]{1,3}/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
	if (out.length <= maxChars) return out;
	// Cut at the last sentence end inside the budget, not at the budget: a voice
	// stopping mid-word is heard as a broken endpoint.
	const head = out.slice(0, maxChars);
	const stop = Math.max(head.lastIndexOf("."), head.lastIndexOf("!"), head.lastIndexOf("?"));
	out = stop > 80 ? head.slice(0, stop + 1) : head.trim();
	return out;
}

function assistantText(messages: readonly any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
		const text = m.content
			.filter((c: any) => c?.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

export default function (pi: ExtensionAPI) {
	let cfg = loadConfig();
	let enabled = cfg.enabled;
	let pending: Promise<void> = Promise.resolve();
	let player: ReturnType<typeof spawn> | undefined;
	let lastAnswer = "";
	let warned = false;

	const pickPlayer = () =>
		cfg.player ?? (process.platform === "darwin" ? "afplay" : process.platform === "linux" ? "paplay" : "");

	function notify(ctx: ExtensionContext | undefined, text: string) {
		// Once per session for the recurring failures: a dead endpoint should not
		// talk over the terminal on every turn.
		if (warned || !ctx?.hasUI) return;
		warned = true;
		ctx.ui.notify(text, "warning");
	}

	async function synthesize(text: string): Promise<Buffer> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
		const body: Record<string, unknown> = { model: cfg.model, input: text, speed: cfg.speed };
		if (cfg.voice) body.voice = cfg.voice;

		const res = await fetch(cfg.endpoint, { method: "POST", headers, body: JSON.stringify(body) });
		if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 160)}`);
		const wav = Buffer.from(await res.arrayBuffer());
		// The magic number, because a JSON error body arrives with the same speed
		// and a client that only counts bytes plays silence and blames the voice.
		if (wav.length < 44 || wav.subarray(0, 4).toString("latin1") !== "RIFF") {
			throw new Error(`response is not wav: ${wav.subarray(0, 120).toString("utf8")}`);
		}
		return wav;
	}

	function play(wav: Buffer): Promise<void> {
		const cmd = pickPlayer();
		if (!cmd) return Promise.reject(new Error('no audio player: set "player" in tts.json'));
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
		if (!cfg.summarize || !ctx.model) return text;
		const stream = ctx.modelRegistry.streamSimple(
			ctx.model,
			{
				systemPrompt: cfg.summaryPrompt,
				// The answer, not the transcript: the summary is of what was said,
				// and the transcript would pay for every tool result again.
				messages: [{ role: "user", content: text.slice(0, 8000), timestamp: Date.now() }],
			},
			// Thinking off: a reasoning model that deliberates over a one-line
			// summary is slower than the speech it is preparing. No `reasoning` is
			// how off is spelled — pi-ai then sends the model's thinkingLevelMap.off;
			// "off" itself is not a level the option accepts (rewrite-compact, same).
			{ maxTokens: 160, temperature: 0.2 },
		);
		const msg = await stream.result();
		const out = (msg.content ?? [])
			.filter((c: any) => c?.type === "text")
			.map((c: any) => c.text)
			.join(" ")
			.trim();
		return out || text;
	}

	function say(text: string, ctx: ExtensionContext | undefined, raw = false) {
		const wanted = raw ? text : speakable(text, cfg.maxChars);
		if (!wanted) return;
		// Chained, never awaited by the caller: playback outlives the turn, and a
		// handler that waits for a voice holds the session open.
		pending = pending
			.then(async () => {
				const spoken = raw ? wanted : await summarize(wanted, ctx!).catch(() => wanted);
				await play(await synthesize(speakable(spoken, cfg.maxChars)));
			})
			.catch((e: unknown) => notify(ctx, `speak: ${String((e as Error)?.message ?? e)}`));
	}

	pi.on("agent_end", (event) => {
		lastAnswer = assistantText(event.messages as readonly any[]);
	});

	pi.on("agent_settled", (event, ctx) => {
		const text = lastAnswer;
		lastAnswer = "";
		if (!enabled || event.aborted || !text) return;
		if (ctx.mode !== "tui") return;
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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			say(String(params.text ?? ""), ctx as unknown as ExtensionContext, true);
			return { content: [{ type: "text", text: "spoken" }], details: undefined };
		},
	});

	pi.registerCommand("speak", {
		description: "Voice: on | off | test | reload | <text to say>",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim();
			if (arg === "off" || arg === "on") {
				enabled = arg === "on";
				if (!enabled && player) player.kill();
				ctx.ui.notify(`voice ${enabled ? "on" : "off"} (${cfg.model} @ ${new URL(cfg.endpoint).host})`, "info");
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
					`voice ${enabled ? "on" : "off"} · ${cfg.endpoint} · model ${cfg.model} · summarize ${cfg.summarize ? "on" : "off"}`,
					"info",
				);
				return;
			}
			say(arg, ctx, true);
		},
	});

	pi.registerShortcut(Key.alt("v"), {
		description: "Toggle the voice",
		handler: async (ctx) => {
			enabled = !enabled;
			if (!enabled && player) player.kill();
			ctx.ui.notify(`voice ${enabled ? "on" : "off"}`, "info");
		},
	});
}
