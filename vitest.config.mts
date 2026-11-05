import { defineConfig } from "vitest/config";

// Three projects so the terminal tests can be run, and left out of CI, on their own:
// `npm test` is `--project rpc --project unit`, `npm run test:tui` is `--project tui`.
// `unit` is pi-navigator's own suite: plain functions over the view-models, no pi process,
// so it shares nothing with the RPC harness and is kept out of `rpc`'s glob.
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "rpc",
					include: ["packages/*/test/**/*.test.ts"],
					exclude: ["**/node_modules/**", "packages/pi-navigator/**"],
				},
			},
			{ test: { name: "unit", include: ["packages/pi-navigator/test/**/*.test.ts"] } },
			// One pi in one PTY per file, and each waits on the screen: in parallel they slow
			// each other into timeouts on a loaded machine, so files run one at a time.
			{ test: { name: "tui", include: ["packages/*/test/**/*.tui.ts"], fileParallelism: false, testTimeout: 30_000 } },
		],
	},
});
