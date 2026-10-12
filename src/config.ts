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

/** One configured MCP server (stdio transport). */
export interface McpServerConfig {
	/** The executable to spawn. */
	readonly command: string;
	/** Arguments to the executable. */
	readonly args: readonly string[];
	/** Extra environment variables for the child process. */
	readonly env?: Readonly<Record<string, string>>;
	/** Skip this server entirely (default false). */
	readonly disabled?: boolean;
}

/** The parsed `mcp.json` body. */
export interface McpConfig {
	readonly servers: Readonly<Record<string, McpServerConfig>>;
}

/** The env override the config store reads. */
export const MCP_CONFIG_ENV = "SIGRUN_MCP_CONFIG";

/** Resolve the config path without reading it (for diagnostics). */
export function resolveMcpConfigPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const override = env[MCP_CONFIG_ENV];
	if (override !== undefined && override !== "") {
		// A relative override resolves against cwd, like sigrun's other paths.
		return isAbsolute(override) ? override : resolve(override);
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
	const servers: Record<string, McpServerConfig> = {};
	const rawServers = parsed.servers;
	if (!isRecord(rawServers)) {
		throw new Error(
			`mcp config ${source} must have a "servers" object mapping names to server entries`,
		);
	}
	for (const [name, entry] of Object.entries(rawServers)) {
		if (!isRecord(entry)) {
			throw new Error(
				`mcp config ${source}: server "${name}" must be an object`,
			);
		}
		if (
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
		if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") {
			throw new Error(
				`mcp config ${source}: server "${name}" disabled must be a boolean`,
			);
		}
		servers[name] = {
			command: entry.command,
			args: entry.args,
			...(entry.env === undefined
				? {}
				: { env: entry.env as Record<string, string> }),
			...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
		};
	}
	return { servers };
}

/**
 * Read and parse the config from the resolved path. A missing file is an
 * empty config (zero servers — the extension installs and contributes
 * nothing); an existing-but-malformed file throws.
 */
export function loadMcpConfig(
	env: NodeJS.ProcessEnv = process.env,
): McpConfig {
	const path = resolveMcpConfigPath(env);
	if (!existsSync(path)) return { servers: {} };
	const text = readFileSync(path, "utf8");
	return parseMcpConfig(text, path);
}