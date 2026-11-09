/**
 * MCP server configuration (settings rework, Task 11): the operator's
 * server registry lives in the extension's SETTINGS
 * (`<configDir>/settings/sigrun-mcp.json`, declared through
 * `host.settings.declare` — see settings-schema.ts). `parseMcpSettings`
 * turns the checked settings object (defaults applied, secrets filled by
 * core) into the `McpConfig` the wiring consumes, applying the rules the
 * schema cannot express.
 *
 * The `mcp.json` reader survives ONLY for the one-time import
 * (`importMcpJson`, extension.ts): an install upgraded from the file-based
 * config gets its servers moved into settings once, and the file is never
 * read again.
 *
 * Fail-loud on malformed config: unparseable JSON or a wrong-shaped body
 * throws a clear error naming the source (the loader turns a throwing
 * factory into quarantine semantics — this package never silently
 * degrades).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** How one tool's registration reaches callers (pi-durable 1.2.0):
 * `codemode` → `callers: ["tools"]` (scripts only, never model-offered),
 * `deferred` → `deferred: true` (model-callable once tool_search loads it),
 * `direct` → normal registration (model-offered),
 * `hidden` → not registered at all. */
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";

/** Config-level exposure words: the four real ones plus pi's `codemode-deferred`
 * alias (normalized to "codemode" at parse time — pi compat). */
const EXPOSURE_WORDS = [
	"codemode",
	"deferred",
	"direct",
	"hidden",
	"codemode-deferred",
] as const;

/** The server-default exposure (spec slice 3: the default flip — a server
 * with no `exposure` registers its tools script-only, NOT model-offered;
 * `"exposure": "direct"` restores the pre-1.2.0 behavior). */
export const DEFAULT_EXPOSURE: McpExposure = "codemode";

/** Default per-request wire timeout in seconds (config `timeout` overrides). */
export const DEFAULT_TIMEOUT_SECONDS = 60;

/** Parse one exposure word; the alias normalizes to "codemode". */
function parseExposure(
	value: unknown,
	source: string,
	where: string,
): McpExposure {
	if (typeof value !== "string" || !EXPOSURE_WORDS.includes(value as never)) {
		throw new Error(
			`mcp config ${source}: ${where} exposure must be one of ${
				EXPOSURE_WORDS.map((word) => JSON.stringify(word)).join(", ")
			}`,
		);
	}
	const word = value as (typeof EXPOSURE_WORDS)[number];
	return word === "codemode-deferred" ? "codemode" : word;
}

/** Glob match for `toolExposure` patterns: `*` matches any run of
 * characters (including `/`); a pattern without `*` is exact-only. */
function globMatch(pattern: string, name: string): boolean {
	const parts = pattern.split("*");
	if (parts.length === 1) return pattern === name;
	if (!name.startsWith(parts[0]!)) return false;
	let index = parts[0]!.length;
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i]!;
		const last = i === parts.length - 1;
		const found = last ? name.lastIndexOf(part) : name.indexOf(part, index);
		if (found < 0 || found < index) return false;
		index = found + part.length;
		if (last && index !== name.length) return false;
	}
	return true;
}

/** Resolve one discovered tool's exposure: an exact `toolExposure` name wins
 * over patterns; among patterns the FIRST matching one in config order wins
 * (pi's precedence); otherwise the server default (default "codemode"). */
export function resolveToolExposure(
	server: McpServerConfig,
	toolName: string,
): McpExposure {
	const overrides = server.toolExposure;
	if (overrides !== undefined) {
		const exact = overrides[toolName];
		if (exact !== undefined) return exact;
		for (const [pattern, exposure] of Object.entries(overrides)) {
			if (!pattern.includes("*")) continue;
			if (globMatch(pattern, toolName)) return exposure;
		}
	}
	return server.exposure ?? DEFAULT_EXPOSURE;
}

/** Whether a configured server participates at all: `enabled: false` and
 * `disabled: true` both skip it (parse-time validation rejects
 * contradictions, so either false simply means off). */
export function serverEnabled(server: McpServerConfig): boolean {
	return server.enabled !== false && server.disabled !== true;
}

/** Who supplies the server's authority and owns its connection lifecycle. */
export type McpCredentials = "user" | "shared";

/** Whether every user starts enabled or must explicitly opt in. */
export type McpAvailability = "all" | "opt-in";

/** Fields every server variant carries regardless of transport. */
interface McpServerCommon {
	/** Per-user jailed connections by default; shared authority is opt-in. */
	readonly credentials?: McpCredentials;
	/** Required for shared entries: why lending this authority is acceptable. */
	readonly sharedAuthority?: string;
	/** Optional allowlist for a shared entry; rejected for user credentials. */
	readonly users?: readonly string[];
	/** Absent user settings mean enabled for all, disabled for opt-in. */
	readonly availability?: McpAvailability;
	/** Skip this server entirely (default false). */
	readonly disabled?: boolean;
	/** Skip this server entirely (default true; contradicts `disabled`). */
	readonly enabled?: boolean;
	/** Server-default registration exposure (default "codemode"). */
	readonly exposure?: McpExposure;
	/** Per-tool exposure overrides: exact tool names beat patterns; the
	 * first matching `*`-pattern in config order wins. */
	readonly toolExposure?: Readonly<Record<string, McpExposure>>;
	/** Per-request wire timeout in seconds (default 60). */
	readonly timeout?: number;
}

/** One configured MCP server (stdio transport). */
export interface McpStdioServerConfig extends McpServerCommon {
	/** The executable to spawn. */
	readonly command: string;
	/** Arguments to the executable. */
	readonly args: readonly string[];
	/** Extra environment variables for the child process. */
	readonly env?: Readonly<Record<string, string>>;
	/** OAuth (T3c): when present, `sigrun-ext-mcp oauth <name>` can mint a
	 * token and spawn injects it as `MCP_ACCESS_TOKEN` (see tokens.ts). */
	readonly oauth?: McpOAuthConfig;
}

/** One configured MCP server (remote transport: streamable HTTP, with a
 * legacy-SSE fallback negotiated on first contact). */
export interface McpUrlServerConfig extends McpServerCommon {
	/** The server endpoint (http/https). */
	readonly url: string;
	/** Extra request headers (auth etc.), sent on every request. */
	readonly headers?: Readonly<Record<string, string>>;
}

/** One configured MCP server: stdio OR remote. */
export type McpServerConfig = McpStdioServerConfig | McpUrlServerConfig;

/** Narrow to the stdio variant (the spawn path). */
export function isStdioServer(
	server: McpServerConfig,
): server is McpStdioServerConfig {
	return "command" in server;
}

/** OAuth block for one server: how to run the authorization-code flow. */
export interface McpOAuthConfig {
	/** The AS's authorize endpoint (GET; the user opens this in a browser). */
	readonly authorizeUrl: string;
	/** The AS's token endpoint (POST; the CLI exchanges the code here). */
	readonly tokenUrl: string;
	/** The registered client id. */
	readonly clientId: string;
	/** Requested scopes (optional). */
	readonly scopes?: readonly string[];
	/** PKCE method (optional; only "S256" is implemented — and always used). */
	readonly codeChallengeMethod?: string;
}

export type UserServersMode = "none" | "remote" | "all";

/** The parsed `mcp.json` body. */
export interface McpConfig {
	readonly servers: Readonly<Record<string, McpServerConfig>>;
	readonly userServers?: UserServersMode;
}

/** The env override the config store reads. */
export const MCP_CONFIG_ENV = "SIGRUN_MCP_CONFIG";

/** Resolve the config path without reading it (for diagnostics).
 *
 * Resolution order: the `SIGRUN_MCP_CONFIG` override → the sigrun config
 * dir (`SIGRUN_CONFIG_DIR`, the SAME root every sigrun store resolves
 * through — a deployment setting one sets them all) → `~/.config/sigrun`
 * (the pre-deployment fallback, kept so a bare user install keeps
 * working). */
export function resolveMcpConfigPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const override = env[MCP_CONFIG_ENV];
	if (override !== undefined && override !== "") {
		// A relative override resolves against cwd, like sigrun's other paths.
		return isAbsolute(override) ? override : resolve(override);
	}
	const configDir = env.SIGRUN_CONFIG_DIR;
	if (configDir !== undefined && configDir !== "") {
		return join(configDir, "mcp.json");
	}
	return resolve(homedir(), ".config", "sigrun", "mcp.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate an `mcp.json` body. Throws a clear error naming the
 * source when the JSON is unparseable or the shape is wrong.
 */
export function parseMcpConfig(text: string, source: string): McpConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw new Error(
			`mcp config ${source} is not valid JSON: ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		);
	}
	if (!isRecord(parsed)) {
		throw new Error(`mcp config ${source} must be a JSON object`);
	}
	const userServers = parsed.userServers ?? "none";
	if (userServers !== "none" && userServers !== "remote" && userServers !== "all") {
		throw new Error(
			`mcp config ${source}: userServers must be one of "none", "remote", "all"`,
		);
	}
	const servers: Record<string, McpServerConfig> = {};
	const rawServers = parsed.servers;
	if (!isRecord(rawServers)) {
		throw new Error(
			`mcp config ${source} must have a "servers" object mapping names to server entries`,
		);
	}
	for (const [name, entry] of Object.entries(rawServers)) {
		if (name === "servers") {
			throw new Error(
				`mcp config ${source}: server "servers" uses the reserved user settings namespace`,
			);
		}
		if (name.startsWith("u_")) {
			throw new Error(
				`mcp config ${source}: server "${name}" uses the reserved "u_" prefix`,
			);
		}
		// The tool namespace is `<server>/<tool>` and settings keys use dots
		// for paths, so a server named `acme.tools` or `acme/tools` would
		// produce ambiguous or conflicting keys. Reject at the source, before
		// any settings section can be generated from the bad name.
		if (name.includes(".") || name.includes("/")) {
			throw new Error(
				`mcp config ${source}: server "${name}" contains forbidden characters ("." or "/") — dots conflict with settings key paths and slashes conflict with the <server>/<tool> namespace`,
			);
		}
		if (!isRecord(entry)) {
			throw new Error(
				`mcp config ${source}: server "${name}" must be an object`,
		);
		}
		// Transport dispatch: a server is EITHER a stdio child or a remote
		// endpoint. Both arms share the optional fields below; each arm then
		// validates its own required fields.
		const hasCommand = entry.command !== undefined || entry.args !== undefined;
		const hasUrl = entry.url !== undefined;
		if (hasCommand && hasUrl) {
			throw new Error(
				`mcp config ${source}: server "${name}" cannot carry both "command" (stdio) and "url" (remote) — pick one transport`,
			);
		}
		if (!hasCommand && !hasUrl) {
			throw new Error(
				`mcp config ${source}: server "${name}" needs either "command"+"args" (stdio) or "url" (remote)`,
			);
		}
		if (hasUrl) {
			if (typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url)) {
				throw new Error(
					`mcp config ${source}: server "${name}" url must be an http(s) URL`,
				);
			}
			if (
				entry.headers !== undefined &&
				(!isRecord(entry.headers) ||
					Object.values(entry.headers).some((v) => typeof v !== "string"))
			) {
				throw new Error(
					`mcp config ${source}: server "${name}" headers must map strings to strings`,
				);
			}
		} else if (
			typeof entry.command !== "string" ||
			!Array.isArray(entry.args) ||
			entry.args.some((arg) => typeof arg !== "string")
		) {
			throw new Error(
				`mcp config ${source}: server "${name}" needs a string "command" and a string[] "args"`,
			);
		}
		if (
			entry.env !== undefined &&
			(!isRecord(entry.env) ||
				Object.values(entry.env).some((v) => typeof v !== "string"))
		) {
			throw new Error(
				`mcp config ${source}: server "${name}" env must map strings to strings`,
			);
		}
		const credentials: McpCredentials = (entry.credentials ?? "user") as McpCredentials;
		if (credentials !== "user" && credentials !== "shared") {
			throw new Error(
				`mcp config ${source}: server "${name}" credentials must be "user" or "shared"`,
			);
		}
		if (
			credentials === "shared" &&
			(typeof entry.sharedAuthority !== "string" ||
				entry.sharedAuthority.trim() === "")
		) {
			throw new Error(
				`mcp config ${source}: server "${name}" requires a non-empty sharedAuthority when credentials are "shared"`,
			);
		}
		if (entry.users !== undefined) {
			if (credentials !== "shared") {
				throw new Error(
					`mcp config ${source}: server "${name}" users is only valid with credentials "shared"`,
				);
			}
			if (
				!Array.isArray(entry.users) ||
				entry.users.some(
					(user) => typeof user !== "string" || user.trim() === "",
				)
			) {
				throw new Error(
					`mcp config ${source}: server "${name}" users must be a string[] of non-empty users`,
				);
			}
		}
		const availability: McpAvailability = (entry.availability ?? "all") as McpAvailability;
		if (availability !== "all" && availability !== "opt-in") {
			throw new Error(
				`mcp config ${source}: server "${name}" availability must be "all" or "opt-in"`,
			);
		}
		if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") {
			throw new Error(
				`mcp config ${source}: server "${name}" disabled must be a boolean`,
		);
		}
		if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
			throw new Error(
				`mcp config ${source}: server "${name}" enabled must be a boolean`,
			);
		}
		// enabled/disabled must agree when both present: a server that is
		// simultaneously on and off is a config lie, not a default to guess.
		if (
				entry.enabled !== undefined &&
				entry.disabled !== undefined &&
				entry.enabled === entry.disabled
		) {
			throw new Error(
				`mcp config ${source}: server "${name}" enabled and disabled contradict each other`,
			);
		}
		if (entry.timeout !== undefined) {
			if (
					typeof entry.timeout !== "number" ||
				!Number.isFinite(entry.timeout) ||
				entry.timeout <= 0
			) {
				throw new Error(
					`mcp config ${source}: server "${name}" timeout must be a positive number of seconds`,
			);
			}
		}
		const exposure =
			entry.exposure === undefined
				? undefined
				: parseExposure(entry.exposure, source, `server "${name}"`);
		let toolExposure: Record<string, McpExposure> | undefined;
		if (entry.toolExposure !== undefined) {
			if (!isRecord(entry.toolExposure)) {
				throw new Error(
					`mcp config ${source}: server "${name}" toolExposure must be an object mapping tool names or patterns to exposure words`,
				);
			}
			toolExposure = {};
			for (const [key, value] of Object.entries(entry.toolExposure)) {
				toolExposure[key] = parseExposure(
					value,
					source,
					`server "${name}" toolExposure "${key}"`,
				);
			}
		}
		const oauth =
			entry.oauth === undefined
				? undefined
				: parseOauthEntry(entry.oauth, source, name);
		const catalog = {
			// Preserve the pre-catalog serialized shape when both fields are
			// absent. Consumers use nullish defaults, so omitted and explicit
			// default values are equivalent without changing legacy fixtures.
			...(entry.credentials === undefined ? {} : { credentials }),
			...(entry.availability === undefined ? {} : { availability }),
			...(entry.sharedAuthority === undefined
				? {}
				: { sharedAuthority: entry.sharedAuthority as string }),
			...(entry.users === undefined
				? {}
				: { users: entry.users as string[] }),
		} as const;
		// The common optionals first, then the transport arm's own fields —
		// the union stays discriminable by "command" vs "url" presence.
		servers[name] = hasUrl
			? {
					url: entry.url as string,
					...(entry.headers === undefined
						? {}
						: { headers: entry.headers as Record<string, string> }),
					...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
					...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
					...(exposure === undefined ? {} : { exposure }),
					...(toolExposure === undefined ? {} : { toolExposure }),
					...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
					...catalog,
				}
			: {
					command: entry.command as string,
					args: entry.args as readonly string[],
					...(entry.env === undefined
						? {}
						: { env: entry.env as Record<string, string> }),
					...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
					...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
					...(exposure === undefined ? {} : { exposure }),
					...(toolExposure === undefined ? {} : { toolExposure }),
					...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
					...(oauth === undefined ? {} : { oauth }),
					...catalog,
				};
	}
	return { servers, userServers };
}

/** Parse one server's oauth block. Fail-loud on a wrong shape: a
 * half-configured block is a config error, not a silently-ignored field. */
function parseOauthEntry(
	value: unknown,
	source: string,
	name: string,
): McpOAuthConfig {
	if (!isRecord(value)) {
		throw new Error(
			`mcp config ${source}: server "${name}" oauth must be an object`,
		);
	}
	if (
		typeof value.authorizeUrl !== "string" ||
		typeof value.tokenUrl !== "string" ||
		typeof value.clientId !== "string"
	) {
		throw new Error(
			`mcp config ${source}: server "${name}" oauth needs string "authorizeUrl", "tokenUrl" and "clientId"`,
		);
	}
	if (
		value.scopes !== undefined &&
		(!Array.isArray(value.scopes) ||
			value.scopes.some((scope) => typeof scope !== "string"))
	) {
		throw new Error(
			`mcp config ${source}: server "${name}" oauth scopes must be a string[]`,
		);
	}
	if (
		value.codeChallengeMethod !== undefined &&
		typeof value.codeChallengeMethod !== "string"
	) {
		throw new Error(
			`mcp config ${source}: server "${name}" oauth codeChallengeMethod must be a string`,
		);
	}
	// Only S256 is implemented; a config naming anything else would silently
	// send S256 anyway — fail loudly instead (config lies must not pass).
	if (
		value.codeChallengeMethod !== undefined &&
		value.codeChallengeMethod !== "S256"
	) {
		throw new Error(
			`mcp config ${source}: server "${name}" oauth codeChallengeMethod must be "S256" (the only implemented method)`,
		);
	}
	return {
		authorizeUrl: value.authorizeUrl,
		tokenUrl: value.tokenUrl,
		clientId: value.clientId,
		...(value.scopes === undefined
			? {}
			: { scopes: value.scopes as string[] }),
		...(value.codeChallengeMethod === undefined
			? {}
			: { codeChallengeMethod: value.codeChallengeMethod }),
	};
}

/**
 * Read and parse the legacy `mcp.json` from the resolved path. A missing
 * file is an empty config; an existing-but-malformed file throws. Kept
 * ONLY for the one-time import — production reads settings.
 */
export function loadMcpConfig(
	env: NodeJS.ProcessEnv = process.env,
): McpConfig {
	const path = resolveMcpConfigPath(env);
	if (!existsSync(path)) return { servers: {} };
	const text = readFileSync(path, "utf8");
	return parseMcpConfig(text, path);
}

/**
 * Resolve sigrun's config dir the way core does (stores.ts tiers):
 * `SIGRUN_CONFIG_DIR` verbatim → `$XDG_CONFIG_HOME/sigrun` →
 * `~/.config/sigrun`. The CLI reads settings from here; the extension
 * itself never calls this (its stores are host-scoped).
 */
export function resolveSigrunConfigDir(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const explicit = env.SIGRUN_CONFIG_DIR;
	if (explicit !== undefined && explicit !== "") return explicit;
	const xdg = env.XDG_CONFIG_HOME;
	if (xdg !== undefined && xdg !== "") return join(xdg, "sigrun");
	return resolve(homedir(), ".config", "sigrun");
}

/** The built-in's settings slug (core src/harness/builtins.ts). */
export const MCP_SETTINGS_SLUG = "sigrun-mcp";

/**
 * Read the operator's MCP settings from disk for the CLI: the declared
 * settings file plus the secrets section, with the secret values filled
 * back into the header/env slots (the file carries empty-string
 * placeholders for them). Absent files mean an empty registry.
 */
export function readMcpSettingsForCli(
	env: NodeJS.ProcessEnv = process.env,
): McpConfig {
	const configDir = resolveSigrunConfigDir(env);
	const settingsPath = join(configDir, "settings", `${MCP_SETTINGS_SLUG}.json`);
	const settings = existsSync(settingsPath)
		? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
		: {};
	const secretsPath = join(configDir, "secrets.json");
	const allSecrets = existsSync(secretsPath)
		? (JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, unknown>)
		: {};
	const section = allSecrets[MCP_SETTINGS_SLUG];
	const secrets = isRecord(section) ? section : {};
	const servers = isRecord(settings.servers) ? { ...settings.servers } : {};
	for (const [name, entry] of Object.entries(servers)) {
		if (!isRecord(entry)) continue;
		const next: Record<string, unknown> = { ...entry };
		for (const field of ["headers", "env"] as const) {
			const table = next[field];
			if (!isRecord(table)) continue;
			const filled: Record<string, unknown> = { ...table };
			for (const key of Object.keys(filled)) {
				const value = secrets[`servers/${name}/${field}/${key}`];
				if (typeof value === "string" && value !== "") filled[key] = value;
			}
			next[field] = filled;
		}
		servers[name] = next;
	}
	return parseMcpSettings({ ...settings, servers }, settingsPath);
}

/**
 * Normalize legacy spellings in a raw stored settings object BEFORE the
 * checked read (settings rework, Task 11): the `disabled` alias folds
 * into `enabled` and pi's `codemode-deferred` exposure alias normalizes
 * to `codemode`. Running ahead of schema validation is load-bearing: the
 * schema cannot spell the aliases, so an unnormalized stored value would
 * otherwise be "repaired" away (a codemode-deferred server would flip to
 * the default exposure, or be dropped outright).
 */
export function normalizeMcpSettingsAliases(
	settings: Record<string, unknown>,
): Record<string, unknown> {
	if (!isRecord(settings.servers)) return settings;
	return {
		...settings,
		servers: Object.fromEntries(
			Object.entries(settings.servers).map(([name, entry]) => [
				name,
				isRecord(entry) ? normalizeServerAliases(entry) : entry,
			]),
		),
	};
}

/**
 * Normalize one server entry's legacy spellings: `disabled` folds into
 * `enabled`; `codemode-deferred` normalizes to `codemode`. The explicit
 * enabled+disabled contradiction stays a config error (both spellings
 * survive for the parser's check when both were written).
 */
function normalizeServerAliases(entry: Record<string, unknown>): Record<string, unknown> {
	let next = entry;
	if (next.disabled !== undefined) {
		const { disabled, ...rest } = next;
		next = {
			...rest,
			...(next.enabled === undefined
				? { enabled: disabled === true ? false : true }
				: // Keep the alias for the contradiction check when both were
					// spelled out: enabled+disabled agreeing is still a lie.
					{ disabled }),
		};
	}
	if (next.exposure === "codemode-deferred") next = { ...next, exposure: "codemode" };
	if (isRecord(next.toolExposure)) {
		next = {
			...next,
			toolExposure: Object.fromEntries(
				Object.entries(next.toolExposure).map(([key, value]) => [
					key,
					value === "codemode-deferred" ? "codemode" : value,
				]),
			),
		};
	}
	return next;
}

/**
 * Parse the checked settings object into the runtime config. The schema
 * read already applied defaults and repaired malformed values; this pass
 * enforces the cross-field rules (shared authority, users allowlist,
 * enabled/disabled agreement, OAuth shape) and normalizes the legacy
 * spellings. `transport` is inferred when absent (`url` present → url).
 *
 * `source` names the settings scope in error messages (e.g. "settings"
 * or "user settings servers").
 */
export function parseMcpSettings(
	settings: Record<string, unknown>,
	source = "settings",
): McpConfig {
	// Round-trip through the legacy wire parser: it owns every cross-field
	// rule and error wording. The settings form carries the transport
	// discriminator; the legacy shape is recovered by dropping it.
	const raw: Record<string, unknown> = {
		// An absent settings file means an empty registry; the legacy parser's
		// required servers object applies to an EXISTING mcp.json, not here.
		servers: {},
		...settings,
	};
	if (isRecord(raw.servers)) {
		raw.servers = Object.fromEntries(
			Object.entries(raw.servers).map(([name, entry]) => {
				if (!isRecord(entry)) return [name, entry];
				const normalized = normalizeServerAliases(entry);
				// The flattened drawable row carries `args`'s schema default on
				// EVERY variant. On a URL row with no command it is presentation
				// default fill, not a stdio transport signal; drop it before the
				// legacy parser's command-or-args dispatch. An explicit command
				// alongside url still fails the both-transports rule.
				const { transport: _transport, ...rest } = normalized;
				// Mutate the COPY (rest), never the checked-read document
				// (normalizeServerAliases returns the SAME reference when no
				// alias applied — a delete on it writes through to the
				// caller's settings object).
				if (rest.url !== undefined && rest.command === undefined) {
					delete rest.args;
				}
				return [name, rest];
			}),
		);
	}
	return parseMcpConfig(JSON.stringify(raw), source);
}