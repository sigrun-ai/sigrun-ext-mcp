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
export declare function resolveMcpTokenPath(env?: NodeJS.ProcessEnv): string;
/** Parse and validate a token-store body. */
export declare function parseMcpTokenStore(text: string, source: string): McpTokenStore;
/** Load the token store from beside the resolved config (missing = empty). */
export declare function loadMcpTokens(env?: NodeJS.ProcessEnv): McpTokenStore;
/** Persist the store: 0600, beside the resolved config (create-on-write —
 * the config dir is expected to exist since the config file lives there). */
export declare function saveMcpTokens(store: McpTokenStore, env?: NodeJS.ProcessEnv): void;
/** Store one server's token (merge over the existing store). */
export declare function storeMcpToken(name: string, token: McpStoredToken, env?: NodeJS.ProcessEnv): McpTokenStore;
/** Store the exact credential shape read by per-user service launches. */
export declare function storeUserMcpToken(host: import("./user-servers.js").SigrunHost, user: string, server: string, accessToken: string): Promise<void>;
/**
 * The env var a stored token is injected as (ruling 3): stdio MCP servers
 * take credentials through env, not HTTP headers. A server with both an
 * oauth block and a stored token spawns with this set (merged OVER the
 * server's own `env`, so config wins over inheritance).
 */
export declare const MCP_ACCESS_TOKEN_ENV = "MCP_ACCESS_TOKEN";
/**
 * The spawn env for one server: the server's config env plus the stored
 * token (as {@link MCP_ACCESS_TOKEN_ENV}) when the server has an oauth
 * block AND a stored token. No oauth block, or no token yet (the user has
 * not run `sigrun-ext-mcp oauth <name>`) → the server's env unchanged.
 */
export declare function spawnEnvWithToken(name: string, server: {
    readonly env?: Readonly<Record<string, string>>;
    readonly oauth?: {
        readonly clientId: string;
    };
}, env?: NodeJS.ProcessEnv): Record<string, string>;
