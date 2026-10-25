/** Catalog wiring: shared operator services remain system children, while
 * per-user entries connect and publish through the structural sigrun host. */
import { type Extension } from "@earendil-works/pi-durable";
import { type CatalogSettingsSection, type OwnerEvent, type SigrunHost, type UserService } from "./user-servers.js";
export declare const MCP_EXTENSION_NAME = "sigrun.mcp";
export interface McpWiring {
    readonly extension: Extension;
    readonly perUserTools: boolean;
    readonly userServices: readonly UserService[];
    readonly surfaces: {
        readonly settings: readonly CatalogSettingsSection[];
    };
    conversationCreated(event: OwnerEvent): Promise<void>;
    runSettled(event: OwnerEvent): Promise<void>;
    onSettingsChanged(keys: readonly string[], user?: string): Promise<void>;
    /** Stop system clients immediately; per-user clients drain in-flight calls. */
    close(): Promise<void>;
    readonly ready: Promise<void>;
}
export declare function createMcpExtension(host: SigrunHost): McpWiring;
