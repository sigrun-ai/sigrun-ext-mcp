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
/** The import notice's replace key (Task 6 ruling: no kind on the wire). */
export declare const MCP_IMPORT_NOTICE_KEY = "mcp.imported";
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
export declare function importMcpJsonIfPresent(host: McpImportHost, options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly log?: (message: string) => void;
}): Promise<McpImportResult>;
