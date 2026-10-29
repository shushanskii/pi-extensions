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
	return {
		HOME: home.dir,
		PI_CODING_AGENT_DIR: join(home.dir, ".pi", "agent"),
		// os.tmpdir() reads TMPDIR: what an extension writes "to /tmp" lands in the throwaway home too.
		TMPDIR: home.tmp,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
	};
}

/**
 * pi's arguments for `packages/<name>` as the only extension. `model` picks one from the
 * provider `scriptedModels` writes; without it pi starts with no model, which is enough for
 * commands and not for a prompt.
 */
export function piArgs(name: string, model?: string): string[] {
	return [
		"--no-session",
		"--no-extensions",
		"-e",
		`./packages/${name}`,
		...(model ? ["--provider", SCRIPTED_PROVIDER, "--model", model] : []),
	];
}
