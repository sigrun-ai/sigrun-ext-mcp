/**
 * The MCP extension (sigrun-ext-mcp): registers every tool discovered on
 * the configured MCP servers as a pi-durable tool named
 * `<server>/<toolname>` (ruling 4).
 *
 * Contract (sigrun's src/harness/loader.ts): the package default-exports a
 * FACTORY TAKING NO ARGUMENTS, returning `{ extension }`. The loader calls
 * it synchronously at boot, before `Harness.open` reads the registry — so
 * the factory returns immediately and the async connect/discover work lands
 * through a LIVE tools array (the registry re-reads `extension.tools` on
 * every snapshot, so tools discovered after install appear in the harness
 * without a reinstall).
 *
 * Lifecycle (ruling 5): servers spawn eagerly at factory time (a server is
 * a long-lived stdio process; lazy-at-first-use buys nothing and complicates
 * discovery visibility). Each server is ISOLATED: a spawn or handshake or
 * discovery failure quarantines just that server (warned, contributing no
 * tools) and never affects the others. Children are killed on process exit
 * and on `wiring.close()`; there is no loader-side uninstall callback to
 * hook.
 *
 * Config (ruling 2): `mcp.json` resolved as `SIGRUN_MCP_CONFIG` env
 * override → `~/.config/sigrun/mcp.json`. Malformed config THROWS from the
 * factory (the loader's quarantine semantics take over); a missing config
 * is an empty registry (the extension installs with zero tools).
 */
import { type Extension } from "@earendil-works/pi-durable";
/** The extension's pi-durable registry name. */
export declare const MCP_EXTENSION_NAME = "sigrun.mcp";
/** What {@link createMcpExtension} returns (the loader contract: `.extension`). */
export interface McpWiring {
    /** The extension to install into the harness registry. */
    readonly extension: Extension;
    /**
     * Kill every connected MCP server child process (idempotent). Called on
     * process exit automatically; hosts may call it on harness shutdown.
     */
    close(): void;
    /**
     * Resolves when every enabled server has connected (and discovered its
     * tools) or failed (isolated). Hosts that want tools present before
     * `Harness.open` reads the registry await this; the loader does not.
     */
    readonly ready: Promise<void>;
}
/**
 * The extension factory (the loader contract: no arguments; config resolves
 * from the package context — the `SIGRUN_MCP_CONFIG` override or the sigrun
 * config dir).
 */
export declare function createMcpExtension(): McpWiring;
