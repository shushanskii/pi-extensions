/**
 * pi in RPC mode: commands in on stdin, session events and extension UI requests out on
 * stdout. Everything an extension does short of drawing on a terminal is visible here.
 */

import type { ChildProcess } from "node:child_process";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { Home } from "./home.ts";
import { CLI, isolatedEnv, piArgs, ROOT } from "./pi.ts";

/** The methods that block until the client answers; the rest are fire-and-forget. */
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/**
 * Write one `extension_ui_response` to pi's stdin.
 *
 * pi's own `RpcClient` implements the half of the UI protocol a chat client needs: a dialog arrives
 * as an event and nothing answers it, so the extension waits out its timeout. The protocol itself is
 * a line on stdin — the shape `docs/rpc-extension-ui.md` documents and pi's own example client
 * writes — and `process` is where the client keeps the child. That field is private, which is why
 * the check below exists: after a pi release renamed it, a test would otherwise read a dialog that
 * never resolved rather than this.
 */
function sendUiResponse(client: RpcClient, body: Record<string, unknown>): void {
	const child = (client as unknown as { process?: ChildProcess }).process;
	if (!child?.stdin?.writable) {
		throw new Error("RpcClient no longer holds its child in a `process` field; a dialog cannot be answered.");
	}
	child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", ...body })}\n`);
}

/** An `extension_ui_request` as it arrives on stdout; only the fields the tests read. */
export interface UiRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
	title?: string;
	options?: string[];
	message?: string;
	notifyType?: string;
	widgetKey?: string;
	widgetLines?: string[];
}

export interface Pi {
	client: RpcClient;
	/** Every extension UI request received so far, in arrival order. */
	ui: UiRequest[];
	/** Resolve with the first UI request (already received or still to come) that matches. */
	waitForUi: (match: (r: UiRequest) => boolean, timeoutMs?: number) => Promise<UiRequest>;
	/** Answer one dialog: an option string for `select`/`input`, a boolean for `confirm`. */
	answer: (request: UiRequest, value: string | boolean) => void;
	/**
	 * Answer every dialog that arrives from now on, and return the unsubscribe. Needed whenever a
	 * turn carries more than one tool call: the questions then arrive together, and answering them
	 * one by one races the ones already in flight.
	 */
	answerEvery: (value: string) => () => void;
	stop: () => Promise<void>;
}

/** Start pi with `packages/<name>` as its only extension, HOME pointed at `home`. */
export async function startPi(name: string, home: Home, model?: string): Promise<Pi> {
	// RpcClient spreads process.env first, so every variable that could point pi back at the
	// real configuration is overridden by isolatedEnv, not merely left out.
	const client = new RpcClient({ cliPath: CLI, cwd: ROOT, env: isolatedEnv(home), args: piArgs(name, model) });

	const ui: UiRequest[] = [];
	const waiters = new Set<{ match: (r: UiRequest) => boolean; resolve: (r: UiRequest) => void }>();
	client.onEvent((event) => {
		const r = event as unknown as UiRequest;
		if (r.type !== "extension_ui_request") {
			return;
		}
		ui.push(r);
		for (const w of waiters) {
			if (w.match(r)) {
				waiters.delete(w);
				w.resolve(r);
			}
		}
	});
	await client.start();

	const answer = (request: UiRequest, value: string | boolean) => {
		if (typeof value === "boolean") {
			sendUiResponse(client, { id: request.id, confirmed: value });
			return;
		}
		sendUiResponse(client, { id: request.id, value });
	};

	return {
		client,
		ui,
		answer,
		answerEvery(value) {
			return client.onEvent((event) => {
				const r = event as unknown as UiRequest;
				if (r.type === "extension_ui_request" && DIALOGS.has(r.method)) {
					answer(r, value);
				}
			});
		},
		waitForUi(match, timeoutMs = 10_000) {
			const seen = ui.find(match);
			if (seen) {
				return Promise.resolve(seen);
			}
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(w);
					reject(new Error(`no matching extension_ui_request in ${timeoutMs}ms; got: ${JSON.stringify(ui)}`));
				}, timeoutMs);
				const w = {
					match,
					resolve: (r: UiRequest) => {
						clearTimeout(timer);
						resolve(r);
					},
				};
				waiters.add(w);
			});
		},
		stop: () => client.stop(),
	};
}
