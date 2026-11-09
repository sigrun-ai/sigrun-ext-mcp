/**
 * The one-time `mcp.json` import (settings rework, Task 11 / spec §8).
 *
 * At boot, when the checked settings carry no `servers` and an `mcp.json`
 * exists (`SIGRUN_MCP_CONFIG` or `<configDir>/mcp.json`), the file's
 * servers move into the extension's settings: secret values (headers, env)
 * go to the secrets store under `servers/<name>/headers/<Header>` (resp.
 * `env/<KEY>`), everything else into the settings file, with the legacy
 * spellings normalized (`disabled` → `enabled`, `codemode-deferred` →
 * `codemode`) and the transport discriminator inferred. The file is then
 * never read again; one log line records the move. The returned record
 * carries the notice text for the factory's post-open `ready` path — the
 * factory window must never call the bridge-delegated `host.users` or
 * `host.notices` (they wait for the harness, which waits for the loader,
 * which is awaiting this factory).
 *
 * When settings already have servers and the file exists, the file is
 * ignored with a log line — settings win.
 */

import { existsSync, readFileSync } from "node:fs";
import {
	parseMcpSettings,
	resolveMcpConfigPath,
	type McpServerConfig,
} from "./config.js";
import { isStdioServer } from "./config.js";

/** The import notice's replace key (Task 6 ruling: no kind on the wire). */
export const MCP_IMPORT_NOTICE_KEY = "mcp.imported";

/** The host surface the import needs (structural — the fake hosts in this
 * repo's tests and core's real seam host both satisfy it). ONLY scoped
 * settings/secrets file I/O: safe during the factory window. */
export interface McpImportHost {
	readonly stores: {
		readonly settings: {
			get(): Promise<Record<string, unknown>>;
			set(value: Record<string, unknown>): Promise<void>;
		};
		readonly secrets: {
			set(key: string, value: string): Promise<void>;
		};
	};
}

/** A completed import's post-open notice payload. */
export interface McpImportResult {
	readonly count: number;
	readonly notice?: {
		readonly title: string;
		readonly body: string;
	};
}

/**
 * Run the import if it applies. `count` is the number of imported servers
 * (0 when there was nothing to do). Never throws into the loader: a
 * failed import logs and leaves the settings untouched so the next boot
 * retries. No bridge-delegated host surface is touched.
 */
export async function importMcpJsonIfPresent(
	host: McpImportHost,
	options: {
		readonly env?: NodeJS.ProcessEnv;
		readonly log?: (message: string) => void;
	} = {},
): Promise<McpImportResult> {
	const env = options.env ?? process.env;
	const log = options.log ?? ((message: string) => console.warn(message));
	const path = resolveMcpConfigPath(env);
	const settings = await host.stores.settings.get();
	const hasServers =
		settings.servers !== undefined &&
		settings.servers !== null &&
		typeof settings.servers === "object" &&
		!Array.isArray(settings.servers) &&
		Object.keys(settings.servers).length > 0;
	if (!existsSync(path)) return { count: 0 };
	if (hasServers) {
		log(`ignoring ${path}: servers are configured in settings`);
		return { count: 0 };
	}
	let imported: ReturnType<typeof parseMcpSettings>;
	try {
		imported = parseMcpSettings(
			JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
			path,
		);
	} catch (cause) {
		log(
			`mcp import skipped: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		return { count: 0 };
	}
	const servers: Record<string, unknown> = {};
	const secrets: [string, string][] = [];
	for (const [name, server] of Object.entries(imported.servers)) {
		const entry = stripSecrets(name, server, secrets);
		servers[name] = {
			transport: isStdioServer(server) ? "command" : "url",
			...entry,
		};
	}
	for (const [key, value] of secrets) await host.stores.secrets.set(key, value);
	await host.stores.settings.set({ ...settings, servers });
	const count = Object.keys(servers).length;
	log(`imported ${count} servers from ${path}; the file is no longer read`);
	return {
		count,
		notice: {
			title: "MCP servers imported into settings",
			body: `Imported ${count} servers from ${path}. The file is no longer read; edit them in Settings → sigrun-mcp.`,
		},
	};
}

/** Split one server's secret values out of its settings entry. */
function stripSecrets(
	name: string,
	server: McpServerConfig,
	out: [string, string][],
): Record<string, unknown> {
	const { headers, env, ...rest } = server as McpServerConfig & {
		readonly headers?: Readonly<Record<string, string>>;
		readonly env?: Readonly<Record<string, string>>;
	};
	const entry: Record<string, unknown> = { ...rest };
	if (headers !== undefined) {
		const names: Record<string, string> = {};
		for (const [header, value] of Object.entries(headers)) {
			out.push([`servers/${name}/headers/${header}`, value]);
			names[header] = "";
		}
		if (Object.keys(names).length > 0) entry.headers = names;
	}
	if (env !== undefined) {
		const names: Record<string, string> = {};
		for (const [key, value] of Object.entries(env)) {
			out.push([`servers/${name}/env/${key}`, value]);
			names[key] = "";
		}
		if (Object.keys(names).length > 0) entry.env = names;
	}
	return entry;
}
