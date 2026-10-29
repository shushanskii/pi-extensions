/**
 * pi in RPC mode: commands in on stdin, session events and extension UI requests out on
 * stdout. Everything an extension does short of drawing on a terminal is visible here.
 */

import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { Home } from "./home.ts";
import { CLI, isolatedEnv, piArgs, ROOT } from "./pi.ts";

/** An `extension_ui_request` as it arrives on stdout; only the fields the tests read. */
export type UiRequest = {
	type: "extension_ui_request";
	id: string;
	method: string;
	message?: string;
	notifyType?: string;
	widgetKey?: string;
	widgetLines?: string[];
};

export type Pi = {
	client: RpcClient;
	/** Every extension UI request received so far, in arrival order. */
	ui: UiRequest[];
	/** Resolve with the first UI request (already received or still to come) that matches. */
	waitForUi(match: (r: UiRequest) => boolean, timeoutMs?: number): Promise<UiRequest>;
	stop(): Promise<void>;
};

/** Start pi with `packages/<name>` as its only extension, HOME pointed at `home`. */
export async function startPi(name: string, home: Home, model?: string): Promise<Pi> {
	// RpcClient spreads process.env first, so every variable that could point pi back at the
	// real configuration is overridden by isolatedEnv, not merely left out.
	const client = new RpcClient({ cliPath: CLI, cwd: ROOT, env: isolatedEnv(home), args: piArgs(name, model) });

	const ui: UiRequest[] = [];
	const waiters = new Set<{ match: (r: UiRequest) => boolean; resolve: (r: UiRequest) => void }>();
	client.onEvent((event) => {
		const r = event as unknown as UiRequest;
		if (r.type !== "extension_ui_request") return;
		ui.push(r);
		for (const w of waiters) {
			if (w.match(r)) {
				waiters.delete(w);
				w.resolve(r);
			}
		}
	});
	await client.start();

	return {
		client,
		ui,
		waitForUi(match, timeoutMs = 10_000) {
			const seen = ui.find(match);
			if (seen) return Promise.resolve(seen);
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
