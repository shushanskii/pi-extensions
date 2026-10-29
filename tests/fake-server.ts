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

/** One scripted model answer: text, or a tool call pi will then execute. */
export type Turn = { text: string } | { tool: string; args: Record<string, unknown> };

/** A canned non-chat response, keyed by path; `delayMs` holds it back, the way a GPU would. */
type Route = { status: number; body: unknown; delayMs?: number };

export type LoggedRequest = { method: string; path: string; body: any };

export type FakeServer = {
	/** Origin, e.g. http://127.0.0.1:53211 — no trailing slash. */
	url: string;
	/** Every request received, in order. */
	log: LoggedRequest[];
	/** Chat requests only — the conversation pi sent the model, turn by turn. */
	chats(): any[];
	/** Queue model turns, answered in order by /v1/chat/completions. */
	script(...turns: Turn[]): void;
	/** Turns queued but never asked for. */
	pending(): number;
	/** Answer `path` with this status and JSON body, `delayMs` late, until `reset`. */
	route(path: string, status: number, body: unknown, delayMs?: number): void;
	/**
	 * Forget the log, any `route` override and any turn left in the script, so one failed test
	 * cannot hand its unused turns to the next. Read `pending` before calling this.
	 */
	reset(): void;
	close(): Promise<void>;
};

/** A 1×1 transparent PNG: the smallest real image an endpoint can return. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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
		maxTokens: 1_000,
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
	"/v1/images/generations": { status: 200, body: { data: [{ b64_json: PNG_1X1 }], output_format: "png" } },
	"/sdapi/v1/txt2img": { status: 200, body: { images: [PNG_1X1] } },
};

export async function startFakeServer(): Promise<FakeServer> {
	const log: LoggedRequest[] = [];
	const turns: Turn[] = [];
	let routes = new Map<string, Route>(Object.entries(IMAGE_ROUTES));
	let calls = 0;

	const server = createServer(async (req, res) => {
		const raw = await readBody(req);
		let body: any = raw;
		try {
			body = raw ? JSON.parse(raw) : undefined;
		} catch {
			/* keep the raw text: a test may want to see what was not JSON */
		}
		const path = (req.url ?? "/").split("?")[0] ?? "/";
		log.push({ method: req.method ?? "", path, body });

		if (path === "/v1/chat/completions") {
			const turn = turns.shift();
			if (!turn) return json(res, 500, { error: { message: "fake model: the script has no turn left" } });
			return streamTurn(res, turn, `call_${++calls}`);
		}
		const route = routes.get(path);
		if (route) {
			if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
			return json(res, route.status, route.body);
		}
		json(res, 404, { error: `fake server: no route for ${path}` });
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}`,
		log,
		chats: () => log.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body),
		script: (...t) => void turns.push(...t),
		pending: () => turns.length,
		route: (path, status, body, delayMs) => void routes.set(path, { status, body, delayMs }),
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

/** A turn as the OpenAI streaming format sends it: role, content or one tool call, finish, usage. */
function streamTurn(res: ServerResponse, turn: Turn, callId: string): void {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	const chunk = (delta: unknown, finish: string | null = null) =>
		res.write(
			`data: ${JSON.stringify({
				id: "fake",
				object: "chat.completion.chunk",
				created: 0,
				model: "scripted",
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`,
		);

	chunk({ role: "assistant", content: "" });
	if ("text" in turn) {
		chunk({ content: turn.text });
		chunk({}, "stop");
	} else {
		chunk({
			tool_calls: [
				{
					index: 0,
					id: callId,
					type: "function",
					function: { name: turn.tool, arguments: JSON.stringify(turn.args) },
				},
			],
		});
		chunk({}, "tool_calls");
	}
	res.write(
		`data: ${JSON.stringify({
			id: "fake",
			object: "chat.completion.chunk",
			created: 0,
			model: "scripted",
			choices: [],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		})}\n\n`,
	);
	res.end("data: [DONE]\n\n");
}
