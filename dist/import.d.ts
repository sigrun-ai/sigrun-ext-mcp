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
 * never read again; one log line and one primary-admin notice
 * (`key: "mcp.imported"`) record the move.
 *
 * When settings already have servers and the file exists, the file is
 * ignored with a log line — settings win.
 */
/** The import notice's replace key (Task 6 ruling: no kind on the wire). */
export declare const MCP_IMPORT_NOTICE_KEY = "mcp.imported";
/** The host surface the import needs (structural — the fake hosts in this
 * repo's tests and core's real seam host both satisfy it). */
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
    readonly users: {
        list(): Promise<readonly {
            readonly user: string;
            readonly admin?: boolean;
            readonly createdAt?: number;
        }[]>;
    };
    readonly notices: {
        post(input: {
            readonly user: string;
            readonly key?: string;
            readonly title: string;
            readonly body?: string;
        }): Promise<unknown>;
    };
}
/**
 * Run the import if it applies. Returns the number of imported servers
 * (0 when there was nothing to do). Never throws into the loader: a
 * failed import logs and leaves the settings untouched so the next boot
 * retries.
 */
export declare function importMcpJsonIfPresent(host: McpImportHost, options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly log?: (message: string) => void;
}): Promise<number>;
