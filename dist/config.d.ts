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
/** How one tool's registration reaches callers (pi-durable 1.2.0):
 * `codemode` → `callers: ["tools"]` (scripts only, never model-offered),
 * `deferred` → `deferred: true` (model-callable once tool_search loads it),
 * `direct` → normal registration (model-offered),
 * `hidden` → not registered at all. */
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
/** The server-default exposure (spec slice 3: the default flip — a server
 * with no `exposure` registers its tools script-only, NOT model-offered;
 * `"exposure": "direct"` restores the pre-1.2.0 behavior). */
export declare const DEFAULT_EXPOSURE: McpExposure;
/** Default per-request wire timeout in seconds (config `timeout` overrides). */
export declare const DEFAULT_TIMEOUT_SECONDS = 60;
/** Resolve one discovered tool's exposure: an exact `toolExposure` name wins
 * over patterns; among patterns the FIRST matching one in config order wins
 * (pi's precedence); otherwise the server default (default "codemode"). */
export declare function resolveToolExposure(server: McpServerConfig, toolName: string): McpExposure;
/** Whether a configured server participates at all: `enabled: false` and
 * `disabled: true` both skip it (parse-time validation rejects
 * contradictions, so either false simply means off). */
export declare function serverEnabled(server: McpServerConfig): boolean;
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
export declare function isStdioServer(server: McpServerConfig): server is McpStdioServerConfig;
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
export declare const MCP_CONFIG_ENV = "SIGRUN_MCP_CONFIG";
/** Resolve the config path without reading it (for diagnostics).
 *
 * Resolution order: the `SIGRUN_MCP_CONFIG` override → the sigrun config
 * dir (`SIGRUN_CONFIG_DIR`, the SAME root every sigrun store resolves
 * through — a deployment setting one sets them all) → `~/.config/sigrun`
 * (the pre-deployment fallback, kept so a bare user install keeps
 * working). */
export declare function resolveMcpConfigPath(env?: NodeJS.ProcessEnv): string;
/**
 * Parse and validate an `mcp.json` body. Throws a clear error naming the
 * source when the JSON is unparseable or the shape is wrong.
 */
export declare function parseMcpConfig(text: string, source: string): McpConfig;
/**
 * Read and parse the config from the resolved path. A missing file is an
 * empty config (zero servers — the extension installs and contributes
 * nothing); an existing-but-malformed file throws.
 */
export declare function loadMcpConfig(env?: NodeJS.ProcessEnv): McpConfig;
export {};
