import { defineConfig } from "vitest/config";

// Two projects so the terminal tests can be run, and left out of CI, on their own:
// `npm test` is `--project rpc`, `npm run test:tui` is `--project tui`.
export default defineConfig({
	test: {
		projects: [
			{ test: { name: "rpc", include: ["packages/*/test/**/*.test.ts"] } },
			// One pi in one PTY per file, and each waits on the screen: in parallel they slow
			// each other into timeouts on a loaded machine, so files run one at a time.
			{ test: { name: "tui", include: ["packages/*/test/**/*.tui.ts"], fileParallelism: false, testTimeout: 30_000 } },
		],
	},
});
