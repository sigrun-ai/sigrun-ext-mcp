/**
 * The OAuth token store (ruling 2): a JSON file BESIDE the resolved mcp.json
 * — `<resolved-config-dir>/mcp-tokens.json` — so the `SIGRUN_MCP_CONFIG`
 * override relocates tokens with config (a test / pod override moves both).
 *
 * Shape (one entry per configured server name):
 *   { "<server-name>": {
 *       "access_token": string, "token_type": string,
 *       "refresh_token"?: string, "expires_at"?: number, "obtained_at": number
 *   } }
 *
 * Files are written 0600 (secrets). A missing file is an empty store; an
 * existing-but-malformed file is a fail-loud config error (consistent with
 * the config store).
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveMcpConfigPath } from "./config.js";

/** One stored token (the AS's token-endpoint response, normalized). */
export interface McpStoredToken {
	readonly access_token: string;
	readonly token_type: string;
	readonly refresh_token?: string;
	readonly expires_at?: number;
	readonly obtained_at: number;
}

/** The whole token store: server name → token. */
export type McpTokenStore = Record<string, McpStoredToken>;

/** Resolve the token-store path for a given environment (beside config). */
export function resolveMcpTokenPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const configPath = resolveMcpConfigPath(env);
	return join(dirname(configPath), "mcp-tokens.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTokenEntry(
	name: string,
	value: unknown,
	source: string,
): McpStoredToken {
	if (!isRecord(value)) {
		throw new Error(`token store ${source}: entry "${name}" must be an object`);
	}
	if (
		typeof value.access_token !== "string" ||
		typeof value.token_type !== "string" ||
		typeof value.obtained_at !== "number"
	) {
		throw new Error(
			`token store ${source}: entry "${name}" needs string "access_token", string "token_type" and number "obtained_at"`,
		);
	}
	if (
		value.refresh_token !== undefined &&
		typeof value.refresh_token !== "string"
	) {
		throw new Error(
			`token store ${source}: entry "${name}" refresh_token must be a string`,
		);
	}
	if (value.expires_at !== undefined && typeof value.expires_at !== "number") {
		throw new Error(
			`token store ${source}: entry "${name}" expires_at must be a number`,
		);
	}
	return {
		access_token: value.access_token,
		token_type: value.token_type,
		...(typeof value.refresh_token === "string"
			? { refresh_token: value.refresh_token }
			: {}),
		...(typeof value.expires_at === "number"
			? { expires_at: value.expires_at }
			: {}),
		obtained_at: value.obtained_at,
	};
}

/** Parse and validate a token-store body. */
export function parseMcpTokenStore(
	text: string,
	source: string,
): McpTokenStore {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw new Error(
			`token store ${source} is not valid JSON: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		);
	}
	if (!isRecord(parsed)) {
		throw new Error(`token store ${source} must be a JSON object`);
	}
	const store: McpTokenStore = {};
	for (const [name, value] of Object.entries(parsed)) {
		store[name] = parseTokenEntry(name, value, source);
	}
	return store;
}

/** Load the token store from beside the resolved config (missing = empty). */
export function loadMcpTokens(
	env: NodeJS.ProcessEnv = process.env,
): McpTokenStore {
	const path = resolveMcpTokenPath(env);
	if (!existsSync(path)) return {};
	return parseMcpTokenStore(readFileSync(path, "utf8"), path);
}

/** Persist the store: 0600, beside the resolved config (create-on-write —
 * the config dir is expected to exist since the config file lives there). */
export function saveMcpTokens(
	store: McpTokenStore,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const path = resolveMcpTokenPath(env);
	writeFileSync(path, JSON.stringify(store, null, "\t") + "\n", {
		mode: 0o600,
	});
	// POSIX honors `mode` only on create; chmod so an existing file also ends
	// 0600 (e.g. a rewritten store on a stricter umask).
	chmodSync(path, 0o600);
}

/** Store one server's token (merge over the existing store). */
export function storeMcpToken(
	name: string,
	token: McpStoredToken,
	env: NodeJS.ProcessEnv = process.env,
): McpTokenStore {
	const store = loadMcpTokens(env);
	store[name] = token;
	saveMcpTokens(store, env);
	return store;
}

/**
 * The env var a stored token is injected as (ruling 3): stdio MCP servers
 * take credentials through env, not HTTP headers. A server with both an
 * oauth block and a stored token spawns with this set (merged OVER the
 * server's own `env`, so config wins over inheritance).
 */
export const MCP_ACCESS_TOKEN_ENV = "MCP_ACCESS_TOKEN";

/**
 * The spawn env for one server: the server's config env plus the stored
 * token (as {@link MCP_ACCESS_TOKEN_ENV}) when the server has an oauth
 * block AND a stored token. No oauth block, or no token yet (the user has
 * not run `sigrun-ext-mcp oauth <name>`) → the server's env unchanged.
 */
export function spawnEnvWithToken(
	name: string,
	server: {
		readonly env?: Readonly<Record<string, string>>;
		readonly oauth?: { readonly clientId: string };
	},
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	if (server.oauth === undefined) return { ...server.env };
	const token = loadMcpTokens(env)[name];
	if (token === undefined) return { ...server.env };
	return { ...server.env, [MCP_ACCESS_TOKEN_ENV]: token.access_token };
}