/**
 * The half of remote-gate that RPC cannot reach: nobody is there to ask.
 *
 * In RPC mode `ctx.hasUI` is true — there is a client, and `tests/rpc.ts` answers it — so the
 * block-instead-of-ask path only runs where there is no client at all: `pi --mode json`, which is how
 * an unattended run looks. What the model is told there matters more than the dialog does, since the
 * model is the one that has to go and ask.
 *
 * Measured here: one cold pi per test, 0.9 s for the two of them together. The driver is
 * `tests/print.ts`.
 */

import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { type FakeServer, scriptedModels, startFakeServer } from "../../../tests/fake-server.ts";
import { type Home, makeHome } from "../../../tests/home.ts";
import { type PrintRun, runPi } from "../../../tests/print.ts";

/** A cold pi plus one turn, generously: both tests finish in under a second. */
const TEST_TIMEOUT_MS = 60_000;
const BLOCKED_TEST_TIMEOUT_MS = 90_000;

let server: FakeServer;
let home: Home;

beforeAll(async () => {
	server = await startFakeServer();
	home = makeHome();
	home.agentFile("models.json", scriptedModels(server.url));
});

afterAll(async () => {
	await server?.close();
	home?.dispose();
});

afterEach(() => {
	const pending = server.pending();
	server.reset();
	// biome-ignore lint/suspicious/noMisplacedAssertion: an afterEach guard is an assertion by design
	expect(pending, "turns the script queued but pi never asked for").toBe(0);
});

/** One bash call the model asks for, then its closing sentence. */
function askForBash(command: string) {
	server.script({ tool: "bash", args: { command } }, { text: "understood" });
}

const toolText = (run: PrintRun) =>
	run.events
		.filter((e) => e.type === "tool_execution_end")
		.map((e) => e.result?.content?.[0]?.text ?? "")
		.join("\n");

test(
	"with no one to ask, the command is blocked and the model is sent to ask",
	async () => {
		// The echo is the marker: if the shell had run anything, its output would be in the result.
		askForBash("echo gate-headless-ran && systemctl restart dnsmasq");
		const run = await runPi("remote-gate", home, "restart the dns", "text-only");

		expect(run.code, run.stderr).toBe(0);
		expect(toolText(run)).toContain(
			"Blocked: this command changes the network or a service, and nobody is here to approve it.",
		);
		expect(toolText(run)).toContain("run it only after they say yes");
		expect(toolText(run)).not.toContain("gate-headless-ran");
	},
	BLOCKED_TEST_TIMEOUT_MS,
);

test(
	"a read still runs with no one to ask",
	async () => {
		askForBash("echo gate-headless");
		const run = await runPi("remote-gate", home, "say something", "text-only");

		expect(run.code, run.stderr).toBe(0);
		expect(toolText(run)).toContain("gate-headless");
	},
	TEST_TIMEOUT_MS,
);
