/**
 * One local HTTP server standing in for everything an extension test would otherwise reach
 * over the network: an OpenAI-compatible chat model that answers from a script, and the image
 * endpoints pi-image posts to. It listens on 127.0.0.1 with an OS-chosen port, so tests in
 * parallel workers never collide, and it logs every request so a test can assert on what was
 * sent, not only on what came back.
 *
 * The model is the main source of flakiness in an agent test, so it is not a model here: each
 * chat request takes the next turn off a queue the test wrote. A request with the queue empty
 * is answered with HTTP 500, which pi surfaces as an error at once — the throwaway home turns pi's
 * retries off — so a test that expected fewer turns than pi asked for fails instead of waiting.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A canned non-chat response, keyed by path; `delayMs` holds it back, the way a GPU would. */
interface Route {
	status: number;
	body: unknown;
	delayMs?: number;
}

const HTTP_NOT_FOUND = 404;
/** An empty script is a test bug, and 500 makes pi say so on the first turn instead of retrying. */
const HTTP_SCRIPT_EXHAUSTED = 500;

// biome-ignore lint/security/noSecrets: a 1×1 transparent PNG, not a credential — the rule sees a high-entropy base64 run
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.setEncoding("utf8");
		req.on("data", (c: string) => {
			data += c;
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

/**
 * A turn as the OpenAI streaming format sends it: role, content or the tool calls, finish, usage.
 * Several calls go out one chunk each, carrying the index OpenAI uses to tell them apart, which is
 * what lets a test put a whole decision table into one turn instead of paying a turn per row.
 *
 * The keys are OpenAI's vocabulary rather than this file's, so the ones that are not valid
 * camelCase identifiers are set as keys of a map — the same reason pi-image builds its request
 * bodies that way.
 */
function streamTurn(res: ServerResponse, turn: Turn, nextCallId: () => string): void {
	res.writeHead(HTTP_OK, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	const frame = (extra: Record<string, unknown>): void => {
		const body: Record<string, unknown> = {
			id: "fake",
			object: "chat.completion.chunk",
			created: 0,
			model: SCRIPTED_PROVIDER,
		};
		res.write(`data: ${JSON.stringify({ ...body, ...extra })}\n\n`);
	};
	const chunk = (delta: unknown, finish: string | null = null) => {
		const choice: Record<string, unknown> = { index: 0, delta };
		choice.finish_reason = finish;
		frame({ choices: [choice] });
	};

	chunk({ role: "assistant", content: "" });
	if ("text" in turn) {
		chunk({ content: turn.text });
		chunk({}, "stop");
	} else {
		const requested: ToolCall[] = [];
		if ("tools" in turn) {
			requested.push(...turn.tools);
		} else {
			requested.push(turn);
		}
		for (const [index, call] of requested.entries()) {
			const delta: Record<string, unknown> = {};
			delta.tool_calls = [
				{
					index,
					id: nextCallId(),
					type: "function",
					function: { name: call.tool, arguments: JSON.stringify(call.args) },
				},
			];
			chunk(delta);
		}
		chunk({}, "tool_calls");
	}
	const usage: Record<string, unknown> = {};
	usage.prompt_tokens = 1;
	usage.completion_tokens = 1;
	usage.total_tokens = 2;
	frame({ choices: [], usage });
	res.end("data: [DONE]\n\n");
}

/** The OpenAI image answer. `b64_json` and `output_format` are the server's keys, not this file's. */
function openAiImageAnswer(): Record<string, unknown> {
	const image: Record<string, unknown> = {};
	image.b64_json = PNG_1X1;
	const answer: Record<string, unknown> = { data: [image] };
	answer.output_format = "png";
	return answer;
}

/** One scripted model answer: text, a tool call pi will then execute, or several calls at once. */
export interface ToolCall {
	tool: string;
	args: Record<string, unknown>;
}
export type Turn = { text: string } | ToolCall | { tools: ToolCall[] };

export interface LoggedRequest {
	method: string;
	path: string;
	/** Parsed JSON when the body was JSON, its raw text when it was not. */
	body: unknown;
}

export interface FakeServer {
	/** Origin, e.g. http://127.0.0.1:53211 — no trailing slash. */
	url: string;
	/** Every request received, in order. */
	log: LoggedRequest[];
	/** Chat requests only — the conversation pi sent the model, turn by turn. */
	chats: () => unknown[];
	/** Queue model turns, answered in order by /v1/chat/completions. */
	script: (...turns: Turn[]) => void;
	/** Turns queued but never asked for. */
	pending: () => number;
	/** Answer `path` with this status and JSON body, `delayMs` late, until `reset`. */
	route: (path: string, status: number, body: unknown, delayMs?: number) => void;
	/**
	 * Forget the log, any `route` override and any turn left in the script, so one failed test
	 * cannot hand its unused turns to the next. Read `pending` before calling this.
	 */
	reset: () => void;
	close: () => Promise<void>;
}

export const HTTP_OK = 200;

export const SCRIPTED_PROVIDER = "scripted";

/**
 * `~/.pi/agent/models.json` naming this server as a provider with two models that differ only in
 * whether pi will hand them an image block — the one property an extension most often branches on.
 */
export function scriptedModels(url: string) {
	const model = (id: string, input: string[]) => ({
		id,
		input,
		contextWindow: 32_000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	return {
		providers: {
			[SCRIPTED_PROVIDER]: {
				baseUrl: `${url}/v1`,
				api: "openai-completions",
				apiKey: "scripted",
				models: [model("text-only", ["text"]), model("vision", ["text", "image"])],
			},
		},
	};
}

/** The two image routes pi-image knows, answering with one PNG each by default. */
export const IMAGE_ROUTES: Record<string, Route> = {
	"/v1/images/generations": { status: HTTP_OK, body: openAiImageAnswer() },
	"/sdapi/v1/txt2img": { status: HTTP_OK, body: { images: [PNG_1X1] } },
};

export async function startFakeServer(): Promise<FakeServer> {
	const log: LoggedRequest[] = [];
	const turns: Turn[] = [];
	let routes = new Map<string, Route>(Object.entries(IMAGE_ROUTES));
	let calls = 0;

	const server = createServer(async (req, res) => {
		const raw = await readBody(req);
		let body: unknown = raw;
		if (raw) {
			try {
				body = JSON.parse(raw);
			} catch {
				/* keep the raw text: a test may want to see what was not JSON */
			}
		}
		const path = (req.url ?? "/").split("?")[0] ?? "/";
		log.push({ method: req.method ?? "", path, body });

		if (path === "/v1/chat/completions") {
			const turn = turns.shift();
			if (!turn) {
				return json(res, HTTP_SCRIPT_EXHAUSTED, { error: { message: "fake model: the script has no turn left" } });
			}
			return streamTurn(res, turn, () => {
				calls += 1;
				return `call_${calls}`;
			});
		}
		const route = routes.get(path);
		if (route) {
			if (route.delayMs) {
				await new Promise((r) => setTimeout(r, route.delayMs));
			}
			return json(res, route.status, route.body);
		}
		json(res, HTTP_NOT_FOUND, { error: `fake server: no route for ${path}` });
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}`,
		log,
		chats: () => log.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body),
		script: (...t) => {
			turns.push(...t);
		},
		pending: () => turns.length,
		route: (path, status, body, delayMs) => {
			routes.set(path, { status, body, delayMs });
		},
		reset: () => {
			log.length = 0;
			turns.length = 0;
			routes = new Map(Object.entries(IMAGE_ROUTES));
		},
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
