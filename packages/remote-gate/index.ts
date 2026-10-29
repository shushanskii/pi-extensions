/**
 * remote-gate — ask before a bash call changes a remote host or the network.
 *
 * The lab's rule (gw-router AGENTS.md, "Boundaries") is that a command over SSH runs only
 * after the user approves that specific action. A rule kept only in a prompt is kept by
 * memory, and on 2026-10-27 memory lost: an agent "tried a route and rolled it back" on
 * the gateway — `ip route replace 192.168.100.0/24 via 192.168.100.13`, then `ip route
 * del` of the same — and `replace` had overwritten the kernel's own route to the guest
 * network, so the rollback deleted the only one. Every guest lost DNS and the internet
 * until the route was added back by hand. This puts the rule in the tool path instead.
 *
 * What is stopped for a yes/no: a bash command that reaches another machine (ssh, scp,
 * rsync to host:path) and carries sudo or a changing command; and the changing network
 * and service commands themselves even when local. Reads pass — `ip route show`, `cat`,
 * `grep`, `docker ps` without sudo — so investigating a host costs no prompts.
 *
 * In print/JSON mode there is no one to ask: the call is blocked, and the reason tells
 * the model to put the exact command to the user and wait.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Every group below is structure, not extraction: these patterns are only ever handed
// `.test()`, so each group is `(?:…)`. A capturing group that nothing reads is a promise the
// reader has to disprove before trusting the pattern.
//
// Reaches another machine: ssh <host>, or scp/rsync with a host:path operand.
const REMOTE = [/(?:^|[\s;&|(])ssh\s/u, /(?:^|[\s;&|(])(?:scp|rsync)\s[^\n]*\S+:\S*/u];
// Copies onto another machine: scp/rsync whose last operand is host:path. Overwriting a
// remote file is a change whatever it contains; copying from a host to here is not.
const COPY_OUT = /(?:^|[\s;&|(])(?:scp|rsync)\s[^\n;&|]*\s[\w.@-]+:[^\s;&|]*\s*(?:$|[;&|])/u;

// Changes state. Written to catch the verb, not every mention of the tool.
const CHANGING = [
	/\bsudo\b/u,
	/\bip\s+(?:-\S+\s+)*(?:route|r|addr|address|a|link|l|rule|neigh|n)\s+(?:add|del|delete|replace|change|flush|set|append)\b/u,
	/\b(?:nft|iptables|ip6tables|ebtables)\b(?!.*\b(?:list|-L|-S|--list)\b)/u,
	/\bsystemctl\s+(?:start|stop|restart|reload|enable|disable|mask|unmask|kill|daemon-reload)\b/u,
	/\b(?:reboot|shutdown|poweroff|halt)\b/u,
	/\bdocker\s+(?:rm|rmi|stop|kill|restart|prune|volume\s+rm|network\s+rm|compose\s+(?:down|rm|stop|restart|up))\b/u,
	/\b(?:pct|qm)\s+(?:create|destroy|set|start|stop|reboot|shutdown|resize|migrate|restore)\b/u,
	/\brm\s+(?:-\w*r\w*f|-\w*f\w*r|--recursive)\b/u,
	/\bsed\s+(?:-\w+\s+)*-i\b/u,
	/(?:>|\btee\s+(?:-a\s+)?)\s*\/etc\//u,
	/\b(?:apt|apt-get|dnf|yum)\s+(?:install|remove|purge|upgrade|dist-upgrade|autoremove)\b/u,
	/\b(?:kill|pkill|killall)\s/u,
	// File changes on the far side: plain on a remote host, so only ever checked with REMOTE.
	/\btar\s[^|;&]*-\w*x/u,
	/\b(?:mv|cp|mkdir|rmdir|chmod|chown|ln|truncate|dd|touch)\s/u,
];

// Changing network/service commands that are dangerous on this machine too.
const LOCAL = [CHANGING[1], CHANGING[2], CHANGING[3], CHANGING[4], CHANGING[6]];

// A command longer than this is truncated in the prompt: the model has the whole string in
// the tool call already, and the box has to stay readable.
const MAX_SHOWN = 1200;

// Show a command whole, or its head plus an ellipsis.
function truncate(command: string, max: number): string {
	if (command.length <= max) {
		return command;
	}
	return `${command.slice(0, max)}…`;
}

export function verdict(command: string): string | undefined {
	if (COPY_OUT.test(command)) {
		return "copies files onto a remote host";
	}
	const remote = REMOTE.some((p) => p.test(command));
	if (remote && CHANGING.some((p) => p.test(command))) {
		return "changes a remote host";
	}
	if (LOCAL.some((p) => p.test(command))) {
		return "changes the network or a service";
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") {
			return;
		}
		const command = String((event.input as { command?: unknown }).command ?? "");
		const why = verdict(command);
		if (!why) {
			return;
		}

		if (!ctx.hasUI) {
			return {
				block: true,
				reason:
					`Blocked: this command ${why}, and nobody is here to approve it. ` +
					"Show the user the exact command and what it changes, and run it only after they say yes.",
			};
		}
		const shown = truncate(command, MAX_SHOWN);
		const choice = await ctx.ui.select(`⚠️  This command ${why}:\n\n${shown}\n\nRun it?`, ["No", "Yes, run it"]);
		if (choice === "Yes, run it") {
			return;
		}
		return {
			block: true,
			reason:
				"The user declined this command. Do not retry it or work around it; explain what you wanted to change and ask.",
		};
	});
}
