/**
 * The environment a stdio MCP server is spawned with (sigrun multi-user
 * spec §8, the env-leak fix).
 *
 * Spawning with `{...process.env, ...}` handed every server sigrun's own
 * environment: `SIGRUN_API_TOKEN`, `SIGRUN_PROXY_SECRET`, provider keys.
 * A server now gets an allowlist copied from sigrun's environment, then
 * its configured `env`, then its stored token (`spawnEnvWithToken`, which
 * keeps its precedence: token over config).
 *
 * The allowlist mirrors core's agent-shell list (`src/harness/agent-env.ts`
 * in sigrun). It is a copy, not an import, because an extension may only
 * import core's types-only contract; the two lists change together.
 */

import type { McpStdioServerConfig } from "./config.js";
import { spawnEnvWithToken } from "./tokens.js";

/** Variables copied from sigrun's environment into every server. */
export const SERVER_ENV_KEYS: readonly string[] = [
	"PATH",
	"HOME",
	"TMPDIR",
	"LANG",
	"TZ",
	"TERM",
	"USER",
	"LOGNAME",
	"SHELL",
	"NPM_CONFIG_CACHE",
	"SSH_AUTH_SOCK",
];

/** Locale variables (`LC_ALL`, `LC_CTYPE`, …) pass through by prefix. */
const SERVER_ENV_PREFIXES: readonly string[] = ["LC_"];

/**
 * The spawn env for one stdio server. `source` is sigrun's environment:
 * it supplies the allowlisted values and locates the token store, and
 * nothing else from it reaches the server.
 */
export function serverSpawnEnv(
	name: string,
	server: Pick<McpStdioServerConfig, "env" | "oauth">,
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (
			SERVER_ENV_KEYS.includes(key) ||
			SERVER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
		) {
			env[key] = value;
		}
	}
	return { ...env, ...spawnEnvWithToken(name, server, source) };
}
