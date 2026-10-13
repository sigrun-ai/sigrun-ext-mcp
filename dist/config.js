/**
 * The MCP config store: reads `mcp.json` — the MCP server registry.
 *
 * Resolution order (ruling 2):
 *   1. `SIGRUN_MCP_CONFIG` env override — an explicit path to an mcp.json
 *   2. `~/.config/sigrun/mcp.json` (the sigrun config dir)
 *
 * Shape:
 *   { "servers": { "<name>": {
 *       "command": string, "args": string[], "env"?: {...}, "disabled"?: boolean
 *   } } }
 *
 * Fail-loud on malformed config: unparseable JSON or a wrong-shaped body
 * throws a clear error naming the path (the loader turns a throwing factory
 * into quarantine semantics — this package never silently degrades).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
/** Config-level exposure words: the four real ones plus pi's `codemode-deferred`
 * alias (normalized to "codemode" at parse time — pi compat). */
const EXPOSURE_WORDS = [
    "codemode",
    "deferred",
    "direct",
    "hidden",
    "codemode-deferred",
];
/** The server-default exposure (spec slice 3: the default flip — a server
 * with no `exposure` registers its tools script-only, NOT model-offered;
 * `"exposure": "direct"` restores the pre-1.2.0 behavior). */
export const DEFAULT_EXPOSURE = "codemode";
/** Default per-request wire timeout in seconds (config `timeout` overrides). */
export const DEFAULT_TIMEOUT_SECONDS = 60;
/** Parse one exposure word; the alias normalizes to "codemode". */
function parseExposure(value, source, where) {
    if (typeof value !== "string" || !EXPOSURE_WORDS.includes(value)) {
        throw new Error(`mcp config ${source}: ${where} exposure must be one of ${EXPOSURE_WORDS.map((word) => JSON.stringify(word)).join(", ")}`);
    }
    const word = value;
    return word === "codemode-deferred" ? "codemode" : word;
}
/** Glob match for `toolExposure` patterns: `*` matches any run of
 * characters (including `/`); a pattern without `*` is exact-only. */
function globMatch(pattern, name) {
    const parts = pattern.split("*");
    if (parts.length === 1)
        return pattern === name;
    if (!name.startsWith(parts[0]))
        return false;
    let index = parts[0].length;
    for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        const last = i === parts.length - 1;
        const found = last ? name.lastIndexOf(part) : name.indexOf(part, index);
        if (found < 0 || found < index)
            return false;
        index = found + part.length;
        if (last && index !== name.length)
            return false;
    }
    return true;
}
/** Resolve one discovered tool's exposure: an exact `toolExposure` name wins
 * over patterns; among patterns the FIRST matching one in config order wins
 * (pi's precedence); otherwise the server default (default "codemode"). */
export function resolveToolExposure(server, toolName) {
    const overrides = server.toolExposure;
    if (overrides !== undefined) {
        const exact = overrides[toolName];
        if (exact !== undefined)
            return exact;
        for (const [pattern, exposure] of Object.entries(overrides)) {
            if (!pattern.includes("*"))
                continue;
            if (globMatch(pattern, toolName))
                return exposure;
        }
    }
    return server.exposure ?? DEFAULT_EXPOSURE;
}
/** Whether a configured server participates at all: `enabled: false` and
 * `disabled: true` both skip it (parse-time validation rejects
 * contradictions, so either false simply means off). */
export function serverEnabled(server) {
    return server.enabled !== false && server.disabled !== true;
}
/** The env override the config store reads. */
export const MCP_CONFIG_ENV = "SIGRUN_MCP_CONFIG";
/** Resolve the config path without reading it (for diagnostics). */
export function resolveMcpConfigPath(env = process.env) {
    const override = env[MCP_CONFIG_ENV];
    if (override !== undefined && override !== "") {
        // A relative override resolves against cwd, like sigrun's other paths.
        return isAbsolute(override) ? override : resolve(override);
    }
    return resolve(homedir(), ".config", "sigrun", "mcp.json");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Parse and validate an `mcp.json` body. Throws a clear error naming the
 * source when the JSON is unparseable or the shape is wrong.
 */
export function parseMcpConfig(text, source) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (cause) {
        throw new Error(`mcp config ${source} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (!isRecord(parsed)) {
        throw new Error(`mcp config ${source} must be a JSON object`);
    }
    const servers = {};
    const rawServers = parsed.servers;
    if (!isRecord(rawServers)) {
        throw new Error(`mcp config ${source} must have a "servers" object mapping names to server entries`);
    }
    for (const [name, entry] of Object.entries(rawServers)) {
        if (!isRecord(entry)) {
            throw new Error(`mcp config ${source}: server "${name}" must be an object`);
        }
        if (typeof entry.command !== "string" ||
            !Array.isArray(entry.args) ||
            entry.args.some((arg) => typeof arg !== "string")) {
            throw new Error(`mcp config ${source}: server "${name}" needs a string "command" and a string[] "args"`);
        }
        if (entry.env !== undefined &&
            (!isRecord(entry.env) ||
                Object.values(entry.env).some((v) => typeof v !== "string"))) {
            throw new Error(`mcp config ${source}: server "${name}" env must map strings to strings`);
        }
        if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") {
            throw new Error(`mcp config ${source}: server "${name}" disabled must be a boolean`);
        }
        if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
            throw new Error(`mcp config ${source}: server "${name}" enabled must be a boolean`);
        }
        // enabled/disabled must agree when both present: a server that is
        // simultaneously on and off is a config lie, not a default to guess.
        if (entry.enabled !== undefined &&
            entry.disabled !== undefined &&
            entry.enabled === entry.disabled) {
            throw new Error(`mcp config ${source}: server "${name}" enabled and disabled contradict each other`);
        }
        if (entry.timeout !== undefined) {
            if (typeof entry.timeout !== "number" ||
                !Number.isFinite(entry.timeout) ||
                entry.timeout <= 0) {
                throw new Error(`mcp config ${source}: server "${name}" timeout must be a positive number of seconds`);
            }
        }
        const exposure = entry.exposure === undefined
            ? undefined
            : parseExposure(entry.exposure, source, `server "${name}"`);
        let toolExposure;
        if (entry.toolExposure !== undefined) {
            if (!isRecord(entry.toolExposure)) {
                throw new Error(`mcp config ${source}: server "${name}" toolExposure must be an object mapping tool names or patterns to exposure words`);
            }
            toolExposure = {};
            for (const [key, value] of Object.entries(entry.toolExposure)) {
                toolExposure[key] = parseExposure(value, source, `server "${name}" toolExposure "${key}"`);
            }
        }
        const oauth = entry.oauth === undefined
            ? undefined
            : parseOauthEntry(entry.oauth, source, name);
        servers[name] = {
            command: entry.command,
            args: entry.args,
            ...(entry.env === undefined
                ? {}
                : { env: entry.env }),
            ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
            ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
            ...(exposure === undefined ? {} : { exposure }),
            ...(toolExposure === undefined ? {} : { toolExposure }),
            ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
            ...(oauth === undefined ? {} : { oauth }),
        };
    }
    return { servers };
}
/** Parse one server's oauth block. Fail-loud on a wrong shape: a
 * half-configured block is a config error, not a silently-ignored field. */
function parseOauthEntry(value, source, name) {
    if (!isRecord(value)) {
        throw new Error(`mcp config ${source}: server "${name}" oauth must be an object`);
    }
    if (typeof value.authorizeUrl !== "string" ||
        typeof value.tokenUrl !== "string" ||
        typeof value.clientId !== "string") {
        throw new Error(`mcp config ${source}: server "${name}" oauth needs string "authorizeUrl", "tokenUrl" and "clientId"`);
    }
    if (value.scopes !== undefined &&
        (!Array.isArray(value.scopes) ||
            value.scopes.some((scope) => typeof scope !== "string"))) {
        throw new Error(`mcp config ${source}: server "${name}" oauth scopes must be a string[]`);
    }
    if (value.codeChallengeMethod !== undefined &&
        typeof value.codeChallengeMethod !== "string") {
        throw new Error(`mcp config ${source}: server "${name}" oauth codeChallengeMethod must be a string`);
    }
    // Only S256 is implemented; a config naming anything else would silently
    // send S256 anyway — fail loudly instead (config lies must not pass).
    if (value.codeChallengeMethod !== undefined &&
        value.codeChallengeMethod !== "S256") {
        throw new Error(`mcp config ${source}: server "${name}" oauth codeChallengeMethod must be "S256" (the only implemented method)`);
    }
    return {
        authorizeUrl: value.authorizeUrl,
        tokenUrl: value.tokenUrl,
        clientId: value.clientId,
        ...(value.scopes === undefined
            ? {}
            : { scopes: value.scopes }),
        ...(value.codeChallengeMethod === undefined
            ? {}
            : { codeChallengeMethod: value.codeChallengeMethod }),
    };
}
/**
 * Read and parse the config from the resolved path. A missing file is an
 * empty config (zero servers — the extension installs and contributes
 * nothing); an existing-but-malformed file throws.
 */
export function loadMcpConfig(env = process.env) {
    const path = resolveMcpConfigPath(env);
    if (!existsSync(path))
        return { servers: {} };
    const text = readFileSync(path, "utf8");
    return parseMcpConfig(text, path);
}
