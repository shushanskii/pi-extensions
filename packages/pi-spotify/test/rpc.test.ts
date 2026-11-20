/**
 * pi-spotify inside a real pi, in RPC mode, against a fake Spotify: the scripted model calls `spotify`,
 * pi runs the tool against the fake Web API and token endpoints, and the test reads what was sent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { type FakeServer, HTTP_OK, scriptedModels, startFakeServer } from "../../../tests/fake-server.ts";
import { type Home, makeHome } from "../../../tests/home.ts";
import type { PiEvent } from "../../../tests/pi.ts";
import { type Pi, startPi } from "../../../tests/rpc.ts";

const TURN_WAIT_MS = 15_000;
const HOUR_MS = 3_600_000;
const TOKEN_LIFETIME_S = 3600;
const DEVICE_VOLUME = 40;
const ORIGINAL = "spotify:track:original";
const SLOWED = "spotify:track:slowed";

let server: FakeServer;
let home: Home;

/** A token that is valid for an hour, or one that expired, as `/spotify login` writes it. */
function writeToken(expiresAt: number): void {
	home.agentFile("spotify.token", { accessToken: "old-access", refreshToken: "refresh-1", expiresAt, scope: "x" });
}

function track(uri: string, name: string): Record<string, unknown> {
	return { uri, name, artists: [{ name: "Radiohead" }] };
}

/** The fake Web API: one computer, a search that ranks a re-upload first, playback that succeeds. */
function routeSpotify(): void {
	const device: Record<string, unknown> = { id: "mac-1", name: "MacBook", type: "Computer" };
	device.is_active = false;
	device.is_restricted = false;
	device.volume_percent = DEVICE_VOLUME;
	server.route("/v1/me/player/devices", HTTP_OK, { devices: [device] });
	server.route("/v1/search", HTTP_OK, {
		tracks: { items: [track(SLOWED, "creep - slowed + reverb"), track(ORIGINAL, "Creep")] },
	});
	server.route("/v1/me/player/play", HTTP_OK, {});
	const fresh: Record<string, unknown> = {};
	fresh.access_token = "new-access";
	fresh.expires_in = TOKEN_LIFETIME_S;
	fresh.scope = "user-read-playback-state user-modify-playback-state";
	server.route("/api/token", HTTP_OK, fresh);
}

beforeAll(async () => {
	server = await startFakeServer();
	home = makeHome();
	home.agentFile("models.json", scriptedModels(server.url));
	home.agentFile("spotify.json", { clientId: "client-1", apiBase: `${server.url}/v1`, accountsBase: server.url });
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

async function toolResult(pi: Pi, message: string): Promise<PiEvent> {
	const events = (await pi.client.promptAndWait(message, undefined, TURN_WAIT_MS)) as PiEvent[];
	const end = events.find((e) => e.type === "tool_execution_end");
	// biome-ignore lint/suspicious/noMisplacedAssertion: without this the caller compares against undefined
	expect(end, "tool_execution_end").toBeDefined();
	return end as PiEvent;
}

describe("pi-spotify", () => {
	let pi: Pi;
	beforeAll(async () => {
		pi = await startPi("pi-spotify", home, "text-only");
	});
	afterAll(async () => {
		await pi?.stop();
	});

	test("registers /spotify, which lists the devices", async () => {
		writeToken(Date.now() + HOUR_MS);
		routeSpotify();
		const commands = await pi.client.getCommands();
		expect(commands.map((c) => c.name)).toEqual(["spotify"]);
		await pi.client.prompt("/spotify");
		const notice = await pi.waitForUi((r) => r.method === "notify");
		expect(notice.message).toContain("clientId set");
		expect(notice.message).toContain("devices: MacBook");
	});

	test("play searches, prefers the original over a re-upload, and plays it on the computer", async () => {
		writeToken(Date.now() + HOUR_MS);
		routeSpotify();
		server.script({ tool: "spotify", args: { action: "play", query: "creep radiohead" } }, { text: "playing" });
		const end = await toolResult(pi, "play creep");
		expect(end.isError).toBe(false);
		expect(end.result?.details).toMatchObject({ action: "play", performed: true, planned: { uri: ORIGINAL } });
		const play = server.log.find((r) => r.path === "/v1/me/player/play");
		expect(play?.method).toBe("PUT");
		expect(play?.body).toEqual({ uris: [ORIGINAL] });
		expect(server.log.some((r) => r.path === "/api/token")).toBe(false);
	});

	test("an expired token is refreshed first and written back", async () => {
		writeToken(0);
		routeSpotify();
		server.script({ tool: "spotify", args: { action: "pause" } }, { text: "paused" });
		server.route("/v1/me/player/pause", HTTP_OK, {});
		const end = await toolResult(pi, "pause");
		expect(end.isError).toBe(false);
		expect(server.log.map((r) => r.path)).toEqual([
			"/v1/chat/completions",
			"/api/token",
			"/v1/me/player/pause",
			"/v1/chat/completions",
		]);
		const saved = JSON.parse(readFileSync(join(home.dir, ".pi", "agent", "spotify.token"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(saved).toMatchObject({ accessToken: "new-access", refreshToken: "refresh-1" });
	});
});
