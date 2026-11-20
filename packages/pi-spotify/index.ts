/**
 * pi-spotify — Spotify as a tool the model can call: find and play, pause, skip, volume, "what is playing".
 *
 * The extension plays nothing itself. It drives an official Spotify client — the desktop app, the phone, a
 * Connect speaker — through Spotify's Web API, the same way the phone app remote-controls a speaker. The
 * alternative was a headless player on this machine (librespot, go-librespot): measured on 2026-11-20 it
 * logged in and then Spotify refused the audio key for every track ("refused the audio key (code 1)", 51
 * tracks in a row). That is Spotify blocking librespot on some accounts (go-librespot#279,
 * librespot#1649), not a setting. Its shared client id also answered the very first search with 429:
 * Web API limits are per client id, and that one is shared by everyone who runs librespot. So the user
 * registers their own app, and this file is a remote control for it.
 *
 * Auth is Authorization Code with PKCE: an app at developer.spotify.com with `redirectPort`'s URI
 * (http://127.0.0.1:8898/callback — Spotify refuses `localhost`), its Client ID in the config, and
 * `/spotify login` once. The Client ID is not a secret and PKCE needs no client secret, so the config
 * holds nothing to protect; the access and refresh tokens go to `tokenFile` at 0600 and are refreshed
 * there. The player endpoints need Premium — a free account gets 403 on every one of them.
 *
 * Which device plays: the active one; else the device whose name contains `device` from the config;
 * else the first computer; else whatever Spotify lists first. Playing on a device that is not active
 * transfers playback to it, which is what "play" means to a person.
 *
 * Search order. Spotify's ranking alone put a "slowed + reverb" re-upload above Radiohead's "Creep" for
 * "creep radiohead" with limit=1 (2026-11-20). Ten results are scored by how many query words they
 * contain, minus one for remix-like words the query did not ask for; Spotify's order breaks ties.
 *
 * Deferred mode, for a voice host. A voice loop prepares answers it may never speak — the user goes on
 * talking and the draft is thrown away — and a tool that already pressed play cannot be taken back. With
 * `PI_SPOTIFY_DEFER=1` in pi's environment the tool only reads (search, status, devices) and returns the
 * action it would have taken in `details.planned`; the host performs it when the answer is actually
 * spoken. louder/quieter carry their step as `delta` beside the absolute `volume`: a voice host turns the
 * music down while it listens, so the level read here is the ducked one, and only the host knows the real one.
 * The model is told the action will happen, so it phrases the answer the same way. An environment
 * variable rather than a config key because the config is shared by every pi of this user, and only the
 * voice host's pi must defer.
 *
 * Config: ~/.pi/agent/spotify.json, every key optional but `clientId`; read on every call, so an edit
 * needs no restart.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "spotify.json");

interface Config {
	/** The Client ID of the user's own app at developer.spotify.com. */
	clientId: string;
	/** Access and refresh token, JSON, written at 0600 by `/spotify login`. */
	tokenFile: string;
	/** Part of a device name to prefer when nothing is active, e.g. "MacBook". */
	device: string;
	/** Loopback port of the login callback; the app's redirect URI must be http://127.0.0.1:<port>/callback. */
	redirectPort: number;
	/** louder/quieter step, in percent. */
	volumeStep: number;
	apiBase: string;
	accountsBase: string;
}

const DEFAULTS: Config = {
	clientId: "",
	tokenFile: "~/.pi/agent/spotify.token",
	device: "",
	redirectPort: 8898,
	volumeStep: 15,
	apiBase: "https://api.spotify.com/v1",
	accountsBase: "https://accounts.spotify.com",
};

const SCOPES = "user-read-playback-state user-modify-playback-state";
const KINDS = ["track", "artist", "album", "playlist"] as const;
type Kind = (typeof KINDS)[number];
const ACTIONS = [
	"play",
	"pause",
	"resume",
	"next",
	"previous",
	"volume",
	"louder",
	"quieter",
	"now_playing",
	"devices",
	"search",
] as const;
type Action = (typeof ACTIONS)[number];

const SEARCH_LIMIT = 10;
const SEARCH_SHOWN = 5;
const MAX_VOLUME = 100;
const FALLBACK_VOLUME = 50;
// Refresh this long before Spotify's expiry, so a token cannot die between the check and the request.
const EXPIRY_MARGIN_MS = 60_000;
const MS_PER_S = 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 300_000;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const ERROR_BODY_CHARS = 300;
const PKCE_VERIFIER_BYTES = 48;
const STATE_BYTES = 12;
const REMIX_WORDS = ["slowed", "reverb", "remix", "sped", "karaoke", "cover", "nightcore"];
const WORD = /[\p{L}\p{N}]+/gu;
const TRAILING_SLASHES = /\/+$/u;

/** What a deferred call hands the host to perform later. */
interface Planned {
	action: "play" | "pause" | "resume" | "next" | "previous" | "volume";
	uri?: string;
	name?: string;
	device?: string;
	volume?: number;
	/** louder/quieter only: the step behind `volume`, for a host that ducked the music and knows the real level. */
	delta?: number;
}

interface SpotifyDetails {
	action: Action;
	performed: boolean;
	planned?: Planned;
}

interface Token {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	scope: string;
}

interface Device {
	id: string;
	name: string;
	type: string;
	isActive: boolean;
	isRestricted: boolean;
	volume: number | null;
}

interface Found {
	uri: string;
	name: string;
}

interface Playing {
	isPlaying: boolean;
	track: string;
	device: string;
	volume: number | null;
}

class SpotifyError extends Error {}

function loadConfig(): Config {
	let raw: Partial<Config> = {};
	try {
		raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
	} catch {
		/* no config file: only clientId is missing, and every call says so */
	}
	const cfg = { ...DEFAULTS, ...raw };
	return {
		...cfg,
		apiBase: cfg.apiBase.replace(TRAILING_SLASHES, ""),
		accountsBase: cfg.accountsBase.replace(TRAILING_SLASHES, ""),
	};
}

function expand(p: string): string {
	if (p.startsWith("~")) {
		return join(homedir(), p.slice(1));
	}
	return p;
}

function deferred(): boolean {
	return process.env.PI_SPOTIFY_DEFER === "1";
}

/** A two-way choice without a ternary, which this repository's lint refuses. */
function either<T>(cond: boolean, yes: T, no: T): T {
	if (cond) {
		return yes;
	}
	return no;
}

function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

// ---------------------------------------------------------------- JSON guards ----

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, key: string): string {
	if (isRecord(v) && typeof v[key] === "string") {
		return v[key];
	}
	return "";
}

function num(v: unknown, key: string): number | null {
	if (isRecord(v) && typeof v[key] === "number") {
		return v[key];
	}
	return null;
}

function bool(v: unknown, key: string): boolean {
	return isRecord(v) && v[key] === true;
}

function field(v: unknown, key: string): unknown {
	if (isRecord(v)) {
		return v[key];
	}
	return undefined;
}

function list(v: unknown): unknown[] {
	if (Array.isArray(v)) {
		return v;
	}
	return [];
}

function artistsOf(item: unknown): string {
	return list(field(item, "artists"))
		.map((a) => str(a, "name"))
		.filter(Boolean)
		.join(", ");
}

// ---------------------------------------------------------------------- token ----

function readToken(cfg: Config): Token {
	const file = expand(cfg.tokenFile);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new SpotifyError(`not logged in: ${file} is missing or unreadable — run /spotify login`, { cause: error });
	}
	return {
		accessToken: str(raw, "accessToken"),
		refreshToken: str(raw, "refreshToken"),
		expiresAt: num(raw, "expiresAt") ?? 0,
		scope: str(raw, "scope"),
	};
}

function saveToken(cfg: Config, answer: unknown, previous?: Token): Token {
	const expiresIn = num(answer, "expires_in") ?? 0;
	const token: Token = {
		accessToken: str(answer, "access_token"),
		refreshToken: str(answer, "refresh_token") || previous?.refreshToken || "",
		expiresAt: Date.now() + expiresIn * MS_PER_S,
		scope: str(answer, "scope") || previous?.scope || "",
	};
	if (!(token.accessToken && token.refreshToken)) {
		throw new SpotifyError("Spotify answered without a token");
	}
	writeFileSync(expand(cfg.tokenFile), JSON.stringify(token), { mode: 0o600 });
	return token;
}

async function tokenRequest(cfg: Config, form: Record<string, string>): Promise<unknown> {
	const res = await fetch(`${cfg.accountsBase}/api/token`, {
		method: "POST",
		headers: [["Content-Type", "application/x-www-form-urlencoded"]],
		body: new URLSearchParams(form).toString(),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const text = await res.text();
	if (!res.ok) {
		throw new SpotifyError(`token request answered ${res.status}: ${text.slice(0, ERROR_BODY_CHARS)}`);
	}
	return JSON.parse(text);
}

function requireClientId(cfg: Config): string {
	if (!cfg.clientId) {
		throw new SpotifyError(`no clientId in ${CONFIG_PATH}: register an app at developer.spotify.com first`);
	}
	return cfg.clientId;
}

async function accessToken(cfg: Config): Promise<string> {
	const token = readToken(cfg);
	if (Date.now() < token.expiresAt - EXPIRY_MARGIN_MS) {
		return token.accessToken;
	}
	// OAuth's field names, set as keys of a map: they are wire data, not identifiers of this file.
	const form: Record<string, string> = {};
	form.grant_type = "refresh_token";
	form.client_id = requireClientId(cfg);
	form.refresh_token = token.refreshToken;
	return saveToken(cfg, await tokenRequest(cfg, form), token).accessToken;
}

// ---------------------------------------------------------------------- web ----

async function api(
	method: string,
	path: string,
	query?: Record<string, string>,
	body?: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const cfg = loadConfig();
	let url = cfg.apiBase + path;
	if (query) {
		url += `?${new URLSearchParams(query).toString()}`;
	}
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const headers: [string, string][] = [["Authorization", `Bearer ${await accessToken(cfg)}`]];
	let payload: string | undefined;
	if (body !== undefined) {
		headers.push(["Content-Type", "application/json"]);
		payload = JSON.stringify(body);
	}
	const res = await fetch(url, {
		method,
		headers,
		body: payload,
		signal: either(signal !== undefined, AbortSignal.any([signal ?? timeout, timeout]), timeout),
	});
	const text = await res.text();
	if (res.status === HTTP_NOT_FOUND && path.startsWith("/me/player")) {
		throw new SpotifyError("no active Spotify device: open Spotify on a computer or phone");
	}
	if (res.status === HTTP_FORBIDDEN && path.startsWith("/me/player")) {
		throw new SpotifyError(
			`Spotify refused (403, Premium is required for playback): ${text.slice(0, ERROR_BODY_CHARS)}`,
		);
	}
	if (!res.ok) {
		throw new SpotifyError(`${method} ${path} answered ${res.status}: ${text.slice(0, ERROR_BODY_CHARS)}`);
	}
	if (res.status === HTTP_NO_CONTENT || !text) {
		return null;
	}
	try {
		return JSON.parse(text);
	} catch {
		// Some player endpoints answer 200 with a body that is not JSON; the status is the answer.
		return null;
	}
}

async function devices(signal?: AbortSignal): Promise<Device[]> {
	const answer = await api("GET", "/me/player/devices", undefined, undefined, signal);
	return list(field(answer, "devices")).map((d) => ({
		id: str(d, "id"),
		name: str(d, "name"),
		type: str(d, "type"),
		isActive: bool(d, "is_active"),
		isRestricted: bool(d, "is_restricted"),
		volume: num(d, "volume_percent"),
	}));
}

async function target(signal?: AbortSignal): Promise<Device> {
	const usable = (await devices(signal)).filter((d) => !d.isRestricted && d.id);
	const want = loadConfig().device.toLowerCase();
	const picked =
		usable.find((d) => d.isActive) ??
		usable.find((d) => want && d.name.toLowerCase().includes(want)) ??
		usable.find((d) => d.type === "Computer") ??
		usable[0];
	if (!picked) {
		throw new SpotifyError("Spotify sees no device: open Spotify on a computer or phone");
	}
	return picked;
}

async function playing(signal?: AbortSignal): Promise<Playing | null> {
	const st = await api("GET", "/me/player", undefined, undefined, signal);
	const item = field(st, "item");
	if (!item) {
		return null;
	}
	const device = field(st, "device");
	return {
		isPlaying: bool(st, "is_playing"),
		track: `${str(item, "name")} — ${artistsOf(item)}`,
		device: str(device, "name"),
		volume: num(device, "volume_percent"),
	};
}

function describe(item: unknown, kind: Kind): string {
	const name = str(item, "name");
	if (kind === "track" || kind === "album") {
		return `${name} — ${artistsOf(item)}`;
	}
	if (kind === "playlist") {
		return `${name} (${str(field(item, "owner"), "display_name")})`;
	}
	return name;
}

function score(query: Set<string>, name: string): number {
	const have = new Set(name.toLowerCase().match(WORD) ?? []);
	let hits = 0;
	for (const w of query) {
		if (have.has(w)) {
			hits += 1;
		}
	}
	const unasked = REMIX_WORDS.some((w) => have.has(w) && !query.has(w));
	return hits - Number(unasked);
}

async function search(query: string, kind: Kind, signal?: AbortSignal): Promise<Found[]> {
	const answer = await api("GET", "/search", { q: query, type: kind, limit: String(SEARCH_LIMIT) }, undefined, signal);
	// Playlist search answers null in place of a playlist the user cannot see.
	const found = list(field(field(answer, `${kind}s`), "items"))
		.filter(isRecord)
		.map((item) => ({ uri: str(item, "uri"), name: describe(item, kind) }))
		.filter((f) => f.uri);
	const words = new Set(query.toLowerCase().match(WORD) ?? []);
	// Array.prototype.sort is stable, so Spotify's own order breaks ties.
	return found.sort((a, b) => score(words, b.name) - score(words, a.name));
}

async function perform(p: Planned, signal?: AbortSignal): Promise<void> {
	if (p.action === "play" && p.uri) {
		const body: Record<string, unknown> = {};
		if (p.uri.startsWith("spotify:track:")) {
			body.uris = [p.uri];
		} else {
			body.context_uri = p.uri;
		}
		const query: Record<string, string> = {};
		query.device_id = p.device ?? "";
		await api("PUT", "/me/player/play", query, body, signal);
		return;
	}
	if (p.action === "volume" && p.volume !== undefined) {
		const query: Record<string, string> = {};
		query.volume_percent = String(p.volume);
		await api("PUT", "/me/player/volume", query, undefined, signal);
		return;
	}
	const routes: Record<string, [string, string]> = {
		pause: ["PUT", "/me/player/pause"],
		resume: ["PUT", "/me/player/play"],
		next: ["POST", "/me/player/next"],
		previous: ["POST", "/me/player/previous"],
	};
	const route = routes[p.action];
	if (!route) {
		throw new SpotifyError(`nothing to perform for ${p.action}`);
	}
	await api(route[0], route[1], undefined, undefined, signal);
}

// ---------------------------------------------------------------------- tool ----

interface Args {
	action: Action;
	query?: string;
	kind?: Kind;
	volume?: number;
}

function clampVolume(v: number): number {
	return Math.min(MAX_VOLUME, Math.max(0, Math.round(v)));
}

/** Read what the action needs and decide what to do; nothing here changes playback. */
async function plan(args: Args, signal?: AbortSignal): Promise<{ text: string; planned?: Planned }> {
	const { action } = args;
	if (action === "now_playing") {
		const now = await playing(signal);
		if (!now) {
			return { text: "Nothing is playing." };
		}
		const state = either(now.isPlaying, "playing", "paused");
		return { text: `${state}: ${now.track} · on ${now.device} · volume ${now.volume ?? "?"}/100` };
	}
	if (action === "devices") {
		const all = await devices(signal);
		if (all.length === 0) {
			return { text: "Spotify sees no device. Open Spotify on a computer or phone." };
		}
		const rows = all.map((d) => `${either(d.isActive, "* ", "  ")}${d.name} (${d.type}, volume ${d.volume ?? "?"})`);
		return { text: rows.join("\n") };
	}
	if (action === "search" || action === "play") {
		const query = (args.query ?? "").trim();
		if (!query) {
			return { text: `${action} needs a query.` };
		}
		const kind = args.kind ?? "track";
		const found = await search(query, kind, signal);
		const [best] = found;
		if (!best) {
			return { text: `Nothing on Spotify for "${query}" (${kind}).` };
		}
		if (action === "search") {
			return {
				text: found
					.slice(0, SEARCH_SHOWN)
					.map((f) => `${f.name}  ${f.uri}`)
					.join("\n"),
			};
		}
		const device = await target(signal);
		return {
			text: `play ${best.name} on ${device.name}`,
			planned: { action: "play", uri: best.uri, name: best.name, device: device.id },
		};
	}
	if (action === "volume" || action === "louder" || action === "quieter") {
		let { volume } = args;
		let delta: number | undefined;
		if (action !== "volume") {
			const now = (await playing(signal))?.volume ?? FALLBACK_VOLUME;
			const step = loadConfig().volumeStep;
			delta = either(action === "louder", step, -step);
			volume = now + delta;
		}
		if (volume === undefined) {
			return { text: "volume needs a number 0..100." };
		}
		const clamped = clampVolume(volume);
		const planned: Planned = { action: "volume", volume: clamped };
		if (delta !== undefined) {
			planned.delta = delta;
		}
		return { text: `volume ${clamped}`, planned };
	}
	return { text: action, planned: { action } };
}

function login(cfg: Config, onUrl: (url: string) => void): Promise<Token> {
	const clientId = requireClientId(cfg);
	const verifier = randomBytes(PKCE_VERIFIER_BYTES).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(STATE_BYTES).toString("base64url");
	const redirect = `http://127.0.0.1:${cfg.redirectPort}/callback`;
	const authorize = new URL(`${cfg.accountsBase}/authorize`);
	const params: Record<string, string> = { scope: SCOPES, state };
	params.response_type = "code";
	params.client_id = clientId;
	params.redirect_uri = redirect;
	params.code_challenge_method = "S256";
	params.code_challenge = challenge;
	authorize.search = new URLSearchParams(params).toString();

	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			const got = new URL(req.url ?? "/", redirect).searchParams;
			if (got.get("state") !== state) {
				res.writeHead(HTTP_NOT_FOUND).end();
				return;
			}
			res.writeHead(HTTP_OK, [["Content-Type", "text/plain; charset=utf-8"]]);
			res.end("pi-spotify: done, this tab can be closed.");
			clearTimeout(timer);
			server.close();
			const code = got.get("code");
			if (!code) {
				reject(new SpotifyError(`Spotify refused the login: ${got.get("error") ?? "no code"}`));
				return;
			}
			const form: Record<string, string> = { code };
			form.grant_type = "authorization_code";
			form.redirect_uri = redirect;
			form.client_id = clientId;
			form.code_verifier = verifier;
			tokenRequest(cfg, form)
				.then((answer) => resolve(saveToken(cfg, answer)))
				.catch(reject);
		});
		const timer = setTimeout(() => {
			server.close();
			reject(new SpotifyError("login timed out: nobody came back to the callback in 5 minutes"));
		}, LOGIN_TIMEOUT_MS);
		server.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		server.listen(cfg.redirectPort, "127.0.0.1", () => onUrl(authorize.toString()));
	});
}

function openInBrowser(url: string): void {
	const cmd = either(process.platform === "darwin", "open", "xdg-open");
	spawn(cmd, [url], { detached: true, stdio: "ignore" })
		.on("error", () => {
			/* no browser opener: the URL is in the notice */
		})
		.unref();
}

async function status(): Promise<{ text: string; ok: boolean }> {
	const cfg = loadConfig();
	const lines = [
		`config ${CONFIG_PATH} · clientId ${either(Boolean(cfg.clientId), "set", "MISSING")} · defer ${deferred()}`,
	];
	let ok = Boolean(cfg.clientId);
	try {
		const token = readToken(cfg);
		lines.push(`token ${expand(cfg.tokenFile)} · scope ${token.scope || "?"}`);
		const all = await devices();
		lines.push(`devices: ${all.map((d) => `${either(d.isActive, "*", "")}${d.name}`).join(", ") || "none"}`);
		const now = await playing();
		if (now) {
			lines.push(`${either(now.isPlaying, "playing", "paused")}: ${now.track}`);
		} else {
			lines.push("nothing playing");
		}
	} catch (error) {
		ok = false;
		lines.push(messageOf(error));
	}
	return { text: lines.join("\n"), ok };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "spotify",
			label: "Spotify",
			description:
				"Control Spotify on the user's devices. play: find (query, kind) and start it. search: list matches " +
				"without playing. pause, resume, next, previous. volume: set 0..100; louder, quieter: one step. " +
				"now_playing: what plays, where, how loud. devices: where Spotify can play.",
			promptSnippet: "Play, pause, skip and search music on the user's Spotify",
			promptGuidelines: [
				'Use spotify play with kind playlist for a mood or genre ("something calm"), artist for a band, album ' +
					"for an album, track for a song. One call: play searches by itself.",
				"Use spotify for any request to play, stop, skip or change the volume of music, and for what is playing.",
			],
			parameters: Type.Object({
				action: Type.Union(
					ACTIONS.map((a) => Type.Literal(a)),
					{ description: "What to do" },
				),
				query: Type.Optional(Type.String({ description: "For play and search: what to look for" })),
				kind: Type.Optional(
					Type.Union(
						KINDS.map((k) => Type.Literal(k)),
						{ description: "For play and search: track (default), artist, album or playlist" },
					),
				),
				volume: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_VOLUME, description: "For volume: 0..100" })),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
			async execute(_id, raw, signal) {
				const args = raw as Args;
				const { text, planned } = await plan(args, signal);
				const details: SpotifyDetails = { action: args.action, performed: false };
				if (!planned) {
					return { content: [{ type: "text", text }], details };
				}
				details.planned = planned;
				if (deferred()) {
					return { content: [{ type: "text", text: `Will ${text} as soon as you finish answering.` }], details };
				}
				await perform(planned, signal);
				details.performed = true;
				return { content: [{ type: "text", text: `Done: ${text}.` }], details };
			},
			renderCall(args, theme) {
				let line = theme.fg("toolTitle", `spotify ${String(args.action ?? "")}`);
				if (typeof args.query === "string" && args.query) {
					line += theme.fg("accent", ` ${args.query}`);
				}
				return new Text(line, 0, 0);
			},
			renderResult(result, _opts, theme) {
				const [first] = result.content;
				let text = "";
				if (first?.type === "text") {
					[text = ""] = first.text.split("\n");
				}
				return new Text(theme.fg("muted", text), 0, 0);
			},
		}),
	);

	pi.registerCommand("spotify", {
		description: "pi-spotify: status | login | reload",
		handler: async (args, ctx) => {
			const { ui } = ctx as unknown as ExtensionContext;
			const arg = (args ?? "").trim();
			if (arg === "login") {
				try {
					await login(loadConfig(), (url) => {
						ui.notify(`spotify: approve in the browser — ${url}`, "info");
						openInBrowser(url);
					});
					ui.notify("spotify: logged in", "info");
				} catch (error) {
					ui.notify(`spotify: ${messageOf(error)}`, "error");
				}
				return;
			}
			// The config is read on every call, so `reload` is only a status that says it was re-read.
			const { text, ok } = await status();
			const prefix = either(arg === "reload", "spotify: config re-read\n", "spotify: ");
			ui.notify(prefix + text, either<"info" | "warning">(ok, "info", "warning"));
		},
	});
}
