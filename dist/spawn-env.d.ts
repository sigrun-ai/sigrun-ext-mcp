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
/** Variables copied from sigrun's environment into every server. */
export declare const SERVER_ENV_KEYS: readonly string[];
/**
 * The spawn env for one stdio server. `source` is sigrun's environment:
 * it supplies the allowlisted values and locates the token store, and
 * nothing else from it reaches the server.
 */
export declare function serverSpawnEnv(name: string, server: Pick<McpStdioServerConfig, "env" | "oauth">, source?: NodeJS.ProcessEnv): Record<string, string>;
