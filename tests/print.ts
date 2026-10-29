/**
 * pi in JSON mode: one prompt, no terminal, and no client to answer a dialog. That absence is the
 * point — it is the only way to reach the code an extension runs when `ctx.hasUI` is false, and RPC
 * mode cannot reach it because RPC always has a client. It is also how the lab runs unattended.
 *
 * The child gets the isolated environment, like the other drivers: PATH from the parent, and
 * nothing else from the test's own environment.
 */

import { spawn } from "node:child_process";
import type { Home } from "./home.ts";
import { CLI, isolatedEnv, piArgs, ROOT } from "./pi.ts";

export type PrintRun = {
	/** Every record after the session header, in order. */
	events: any[];
	/** pi writes diagnostics and errors here, so a failed run is readable without a re-run. */
	stderr: string;
	/** The exit code. */
	code: number | null;
};

/** Run one prompt through pi's JSON mode, from a cold process to its exit. */
export async function runPi(
	name: string,
	home: Home,
	prompt: string,
	model?: string,
	timeoutMs = 60_000,
): Promise<PrintRun> {
	const child = spawn(process.execPath, [CLI, ...piArgs(name, model), "--mode", "json", prompt], {
		cwd: ROOT,
		// "ignore", not "pipe": pi would otherwise sit reading a stdin that this driver never writes.
		stdio: ["ignore", "pipe", "pipe"],
		env: { PATH: process.env.PATH ?? "", ...isolatedEnv(home) },
	});

	const events: any[] = [];
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		// Split on LF only — pi's docs warn against any other line boundary in this stream — and keep
		// the tail, which is a record still being written.
		const complete = stdout.split("\n");
		stdout = complete.pop() ?? "";
		for (const line of complete) events.push(...parse(line));
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});

	const code = await new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi --mode json did not exit in ${timeoutMs}ms. Stdout: ${stdout}\nStderr: ${stderr}`));
		}, timeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});

	events.push(...parse(stdout.trim()));
	return { events: events.filter((e) => e.type !== "session"), stderr, code };
}

/** One JSONL record, or nothing. pi's own docs warn against anything but LF framing and strict JSON. */
function parse(line: string): any[] {
	const trimmed = line.trim();
	if (!trimmed) return [];
	try {
		return [JSON.parse(trimmed)];
	} catch {
		return [];
	}
}
