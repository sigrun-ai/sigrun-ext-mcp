/** Catalog wiring: shared operator services remain system children, while
 * per-user entries connect and publish through the structural sigrun host. */
import { type Extension } from "@earendil-works/pi-durable";
import { type McpConfig } from "./config.js";
import { type OwnerEvent, type SigrunHost, type UserService } from "./user-servers.js";
import type { PublishedHook } from "@sigrun/sigrun/extension";
export declare const MCP_EXTENSION_NAME = "sigrun.mcp";
export interface ExtensionRouteContribution {
    readonly method: "POST";
    readonly path: string;
    readonly auth: "user";
    handler(request: Request, ctx: {
        readonly principal?: {
            readonly user?: string;
        };
        readonly host: SigrunHost;
    }): Promise<Response>;
}
export interface McpWiring {
    readonly extension: Extension;
    readonly perUserTools: boolean;
    readonly routes: readonly ExtensionRouteContribution[];
    readonly userServices: readonly UserService[];
    readonly publishedHooks: readonly PublishedHook[];
    conversationCreated(event: OwnerEvent): Promise<void>;
    runSettled(event: OwnerEvent): Promise<void>;
    onSettingsChanged(keys: readonly string[], user?: string): Promise<void>;
    /** The one-time mcp.json import (settings rework, Task 11): kicked off
     * at the end of the factory, resolves once settings/secrets carry the
     * file's servers (0 when there was nothing to import). */
    readonly imported: Promise<number>;
    /** Stop system clients immediately; per-user clients drain in-flight calls. */
    close(): Promise<void>;
    readonly ready: Promise<void>;
}
/** Read the operator config LIVE through the factory's declared handle
 * (defaults applied and secrets filled by core's checked read). */
export declare function readMcpConfig(host: SigrunHost): Promise<McpConfig>;
export declare function createMcpExtension(host: SigrunHost): Promise<McpWiring>;
/** The `mcp.servers` published hook (Task 11): codemode asks which MCP
 * server namespaces exist and how their tools are exposed. No input;
 * answered FRESH from settings on every call, so a settings change needs
 * no restart. */
export declare const MCP_SERVERS_HOOK = "mcp.servers";
