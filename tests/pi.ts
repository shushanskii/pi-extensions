/**
 * What every way of starting pi in a test shares: which pi, from where, with which environment.
 *
 * The pi is the pinned one in node_modules, not whatever `pi` is on PATH, so a run here means
 * the same thing as a run in CI. Every switch that reaches the network on its own is off and
 * the session is not saved: the only traffic a test sees is the traffic the extension and the
 * scripted model make.
 */

import { join } from "node:path";
import { SCRIPTED_PROVIDER } from "./fake-server.ts";
import type { Home } from "./home.ts";

// `npm test` runs vitest from the repository root. The root package.json carries no
// "type", so these files are CommonJS to tsc and `import.meta` is not available to locate them;
// and the package's `exports` hide package.json, so require.resolve cannot find it either.
export const ROOT = process.cwd();
export const CLI = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

/** The variables that point pi, and the extension it loads, at `home` instead of the real one. */
export function isolatedEnv(home: Home): Record<string, string> {
	// `HOME`, `TMPDIR` and the `PI_*` switches are the environment's vocabulary, not this file's,
	// so they are assigned as keys of a map rather than written as identifiers.
	const env: Record<string, string> = {};
	env.PATH = process.env.PATH ?? "";
	env.HOME = home.dir;
	env.PI_CODING_AGENT_DIR = join(home.dir, ".pi", "agent");
	// os.tmpdir() reads TMPDIR: what an extension writes "to /tmp" lands in the throwaway home too.
	env.TMPDIR = home.tmp;
	env.PI_OFFLINE = "1";
	env.PI_SKIP_VERSION_CHECK = "1";
	env.PI_TELEMETRY = "0";
	return env;
}

/**
 * One record of what pi reports back, in either driver: the RPC stream and `--mode json` carry the
 * same `tool_execution_*` records. pi does not export the union a driver receives, so the fields a
 * test reads are spelled out here — a release that renames one fails the type-check instead of
 * turning an assertion into a comparison with `undefined`.
 */
export interface PiEvent {
	type: string;
	toolName?: string;
	toolCallId?: string;
	args?: { command?: string };
	isError?: boolean;
	result?: { content?: { text?: string }[]; details?: Record<string, unknown> };
	/** What `onUpdate` streamed while the tool ran; only `tool_execution_update` carries it. */
	partialResult?: { content?: { text?: string }[]; details?: Record<string, unknown> };
}

/**
 * pi's arguments for `packages/<name>` as the only extension. `model` picks one from the
 * provider `scriptedModels` writes; without it pi starts with no model, which is enough for
 * commands and not for a prompt. `extra` loads further extension paths after it, in the order
 * given — what a test needs when the thing under test is how two extensions meet.
 */
export function piArgs(name: string, model?: string, extra?: string[]): string[] {
	const args = ["--no-session", "--no-extensions", "-e", `./packages/${name}`];
	for (const path of extra ?? []) {
		args.push("-e", path);
	}
	if (model) {
		args.push("--provider", SCRIPTED_PROVIDER, "--model", model);
	}
	return args;
}
