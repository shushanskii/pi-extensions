/**
 * remote-gate inside a real pi, in RPC mode: the scripted model asks for bash calls, and the test
 * reads which ones pi stopped to ask about, which ones reached the shell, and what the model was
 * told about the ones it did not get.
 *
 * The whole decision table goes into ONE turn: every row is a different pair of regexes, so paying a
 * model turn per row buys nothing, and pi runs the calls of a turn concurrently, so fifteen commands
 * cost about as much wall clock as one. Measured here — this file is 1.5 s end to end, most of it the
 * pi start, and the `rpc` project of 14 tests across 3 files runs in 3 s.
 *
 * The rows are chosen so the test is safe when the gate is wrong. Everything answered "No" never
 * runs; everything expected to pass without a prompt is inert by itself, and hosts are named
 * `host.invalid` (RFC 2606: guaranteed not to resolve) rather than a real machine, since a read that
 * is not gated is a read that executes.
 *
 * Two asymmetries the package header argues for are pinned here rather than left implied: `sudo` is
 * a change only when the command reaches another machine, and a local command is stopped only when
 * it is a network or service one — so `chown -R` on this box passes without a prompt, while
 * `ip route replace` does not.
 */

import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { type FakeServer, scriptedModels, startFakeServer } from "../../../tests/fake-server.ts";
import { type Home, makeHome } from "../../../tests/home.ts";
import { type Pi, startPi } from "../../../tests/rpc.ts";

/** What the model is told when the answer is no. */
const DECLINED = "The user declined this command. Do not retry it or work around it;";

/** [command, the reason the gate gives] — a wrong regex changes one of these pairs. */
const STOPPED: [string, string][] = [
	["scp ./notes.md host.invalid:/srv/notes.md", "copies files onto a remote host"],
	["rsync -a ./srv host.invalid:/etc/srv", "copies files onto a remote host"],
	["ssh host.invalid sudo systemctl restart nginx", "changes a remote host"],
	["ssh host.invalid ip route replace 192.168.100.0/24 via 192.168.100.13", "changes a remote host"],
	["ip route replace default via 203.0.113.1", "changes the network or a service"],
	["systemctl restart dnsmasq", "changes the network or a service"],
];

/** Reads: investigating a host must cost no prompts, including over ssh and against the firewall. */
const READS = [
	"echo gate-read",
	"ip route show",
	"nft list ruleset",
	"iptables --list",
	"docker ps",
	"ssh host.invalid cat /etc/os-release",
	"scp host.invalid:/etc/hosts ./gate-hosts",
	"rsync -a host.invalid:/etc/hosts ./gate-hosts-copy",
	"echo one && sudo -n true",
	"chown -R nobody ./gate-nope",
];

let server: FakeServer;
let home: Home;
let pi: Pi;
let stopAutoAnswer: (() => void) | undefined;

beforeAll(async () => {
	server = await startFakeServer();
	home = makeHome();
	home.agentFile("models.json", scriptedModels(server.url));
	pi = await startPi("remote-gate", home, "text-only");
});

afterAll(async () => {
	await pi?.stop();
	await server?.close();
	home?.dispose();
});

afterEach(() => {
	stopAutoAnswer?.();
	stopAutoAnswer = undefined;
	const pending = server.pending();
	server.reset();
	pi.ui.length = 0;
	expect(pending, "turns the script queued but pi never asked for").toBe(0);
});

/** Answer every dialog of the next turn at once — they arrive together, so one by one would race. */
function answerAll(value: string) {
	stopAutoAnswer?.();
	stopAutoAnswer = pi.answerEvery(value);
}

/** One turn of bash calls, and every event of it. */
async function runBash(commands: string[]) {
	answerAll("No");
	server.script({ tools: commands.map((command) => ({ tool: "bash", args: { command } })) }, { text: "done" });
	return (await pi.client.promptAndWait("gate?", undefined, 60_000)) as any[];
}

/** The questions the gate asked, as the command and the reason shown next to it. */
function asked(): { command: string; why: string }[] {
	return pi.ui
		.filter((r) => r.method === "select")
		.map((r) => {
			const shown = /^⚠️\s+This command (.+):\n\n([\s\S]+)\n\nRun it\?$/.exec(r.title ?? "");
			// A dialog this does not parse is not the gate's; saying so beats comparing undefined to a
			// command, which a reader would have to decode from a diff of two objects.
			if (!shown) throw new Error(`a dialog that is not the gate's: ${r.title}`);
			return { why: shown[1], command: shown[2] };
		});
}

/** What each command got: the text the model saw, and whether pi marked it an error. */
function results(events: any[]): Map<string, { text: string; isError: boolean }> {
	const commands = new Map<string, string>();
	const out = new Map<string, { text: string; isError: boolean }>();
	for (const e of events) {
		if (e.type === "tool_execution_start" && e.toolName === "bash") commands.set(e.toolCallId, e.args.command);
		if (e.type === "tool_execution_end") {
			const command = commands.get(e.toolCallId);
			if (command) out.set(command, { text: e.result.content[0]?.text ?? "", isError: e.isError === true });
		}
	}
	return out;
}

const key = ({ command, why }: { command: string; why: string }) => `${command}\t${why}`;

test("asks for the changing commands with a reason, and does not ask for the reads", async () => {
	const events = await runBash([...STOPPED.map(([command]) => command), ...READS]);

	expect(asked().map(key).sort(), "the gate asked about the wrong set of commands").toEqual(
		STOPPED.map(([command, why]) => `${command}\t${why}`).sort(),
	);

	const got = results(events);
	for (const command of READS) {
		expect(got.get(command)?.text, `${command} was stopped instead of run`).not.toContain(DECLINED);
	}
	for (const [command] of STOPPED) {
		const result = got.get(command);
		expect(result?.isError, `${command} reached the shell`).toBe(true);
		expect(result?.text).toContain(DECLINED);
	}
}, 90_000);

test("yes runs the command the question was about", async () => {
	const command = "echo gate-approved && systemctl start gate-test";
	answerAll("Yes, run it");
	server.script({ tool: "bash", args: { command } }, { text: "done" });
	const events = (await pi.client.promptAndWait("gate?", undefined, 30_000)) as any[];

	expect(asked()).toEqual([{ command, why: "changes the network or a service" }]);
	// `systemctl` is not on this machine, so the command fails — what proves the yes is that it ran.
	expect(results(events).get(command)?.text).toContain("gate-approved");
}, 60_000);

test("no keeps the command out of the shell", async () => {
	const command = "echo gate-declined && systemctl start gate-test";
	const events = await runBash([command]);

	const result = results(events).get(command);
	expect(result?.isError).toBe(true);
	expect(result?.text).not.toContain("gate-declined");
	expect(result?.text).toContain(DECLINED);
}, 60_000);

/**
 * Known gap, kept executable: the exception meant to let a firewall read through is
 * `(?!.*\b(list|-L|-S|--list)\b)`, and `\b` cannot match in front of the `-` of `-L` — so the long
 * forms pass and the short ones, which is how iptables is actually read, are asked about.
 * `test.fails` is a standing note: it turns red the moment the lookahead is fixed, and the fix is
 * to drop `.fails` in the same commit.
 */
test.fails("iptables -L is a read too", async () => {
	const events = await runBash(["iptables -L -n"]);
	expect(asked()).toEqual([]);
	expect(results(events).get("iptables -L -n")?.text).not.toContain(DECLINED);
}, 60_000);
