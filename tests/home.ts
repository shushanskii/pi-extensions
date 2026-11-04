/**
 * A throwaway HOME for one test file, so a test never reads or writes the real ~/.pi.
 *
 * The directory is handed to the child process through its `env`, never assigned in the
 * test's own process: an extension resolves `homedir()` in the process that loads it, and
 * a HOME changed here would leak into every later test in the same worker.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Home {
	/** The directory to pass as HOME. */
	dir: string;
	/** A directory inside it to pass as TMPDIR. */
	tmp: string;
	/** Write `~/.pi/agent/<name>` inside it, JSON-encoded. settings.json is already there, retries off. */
	agentFile: (name: string, value: unknown) => void;
	/** Remove the directory and everything pi wrote into it. */
	dispose: () => void;
}

export function makeHome(): Home {
	const dir = mkdtempSync(join(tmpdir(), "pi-ext-test-"));
	const agent = join(dir, ".pi", "agent");
	const tmp = join(dir, "tmp");
	mkdirSync(agent, { recursive: true });
	mkdirSync(tmp);
	// pi retries a failed model request three times with backoff — 14.5s measured before it gives
	// up — so a scripted model that runs out of turns would read as a timeout, not as an error.
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	return {
		dir,
		tmp,
		agentFile(name, value) {
			writeFileSync(join(agent, name), JSON.stringify(value, null, "\t"));
		},
		dispose() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
