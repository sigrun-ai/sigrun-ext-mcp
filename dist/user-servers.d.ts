/** Per-user catalog lifecycle and the structural sigrun host contract.
 * This package mirrors the host types instead of depending on sigrun, so it
 * remains independently buildable and installable. */
import { type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";
import { type McpClient, type McpServiceHandle } from "./client.js";
import { type McpServerConfig, type UserServersMode } from "./config.js";
import type { ToolAnnotations } from "./types.js";
export interface HandlerContext {
    readonly abortSignal: AbortSignal | undefined;
}
export interface ServiceSpec {
    readonly command: string;
    readonly args: string[];
    readonly env?: Record<string, string>;
    readonly cwd?: string;
    readonly readPaths?: string[];
}
export interface UserService {
    readonly name: string;
    start(user: string, ctx: HandlerContext): Promise<ServiceSpec | undefined>;
    readonly idleMinutes?: number;
}
export interface ServiceHandle extends McpServiceHandle {
    readonly stderr: ReadableStream<Uint8Array>;
}
/** The settings declaration contract (settings rework, Task 11): mirrors
 * core's `host.settings.declare` — structural, so the real host and this
 * repo's test doubles both satisfy it. */
export interface SettingsDeclarationMirror {
    readonly schema: Readonly<Record<string, unknown>>;
    readonly userSchema?: Readonly<Record<string, unknown>>;
}
export interface DeclaredSettingsMirror {
    get(): Promise<Record<string, unknown>>;
    user(user: string): {
        get(): Promise<Record<string, unknown>>;
    };
}
export interface SigrunHost {
    readonly settings: {
        declare(decl: SettingsDeclarationMirror): DeclaredSettingsMirror;
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
    readonly tools: {
        setUserTools(user: string, tools: readonly ToolRegistration[]): void;
    };
    readonly services: {
        connect(name: string, user: string, ctx: HandlerContext): Promise<ServiceHandle>;
    };
    readonly stores: {
        readonly secrets: {
            get(key: string): Promise<string | undefined>;
            set(key: string, value: string): Promise<void>;
            delete(key: string): Promise<void>;
        };
        readonly settings: {
            get(): Promise<Record<string, unknown>>;
            set(value: Record<string, unknown>): Promise<void>;
        };
        user(user: string): {
            readonly secrets: {
                get(key: string): Promise<string | undefined>;
                set(key: string, value: string): Promise<void>;
                delete(key: string): Promise<void>;
            };
            readonly settings: {
                get(): Promise<Record<string, unknown>>;
                set(value: Record<string, unknown>): Promise<void>;
            };
            readonly paths: {
                readonly data: string;
                readonly state: string;
                readonly cache: string;
            };
        };
    };
    readonly identity: {
        actingUser(conversationId: ConversationId): Promise<string | undefined>;
    };
}
export interface OwnerEvent {
    readonly conversationId: ConversationId;
    readonly owner?: string;
}
export interface ServerExposure {
    readonly codemode: boolean;
    readonly deferred: boolean;
    readonly description: string;
    readonly count: number;
}
/** One discovered tool's annotation record, keyed by the sigrun tool name. */
export interface ToolAnnotationEntry {
    readonly server: string;
    readonly mcpName: string;
    readonly annotations: ToolAnnotations;
}
export interface DiscoveredTools {
    readonly tools: ToolRegistration[];
    readonly exposure: ServerExposure | undefined;
    /** Annotations keyed by the sigrun tool name (`<server>/<tool>`); only
     * tools that advertised at least one boolean hint appear. */
    readonly annotations: ReadonlyMap<string, ToolAnnotationEntry>;
}
/** The one discovery-to-registration mapping shared by system and user tools. */
export declare function discoverMcpTools(name: string, server: McpServerConfig, client: McpClient): Promise<DiscoveredTools>;
export declare function catalogEnabledFromSettings(name: string, server: McpServerConfig, settings: Record<string, unknown>): boolean;
export declare function catalogEnabled(host: SigrunHost, user: string, name: string, server: McpServerConfig): Promise<boolean>;
export declare function sharedServerAllowed(host: SigrunHost, conversationId: ConversationId, name: string, server: McpServerConfig): Promise<boolean>;
export interface CatalogSettingsSection {
    readonly id: string;
    readonly title: string;
    readonly scope: "user";
    readonly form: {
        readonly v: 1;
        readonly root: Record<string, unknown>;
    };
}
export interface UserCatalog {
    readonly perUserTools: boolean;
    readonly userServices: readonly UserService[];
    readonly settings: readonly CatalogSettingsSection[];
    activate(user: string, ctx?: HandlerContext): Promise<void>;
    retire(user: string, server: string): Promise<void>;
    exposures(user: string): ReadonlyMap<string, ServerExposure>;
    /** Live annotation maps for this user's current connections; retirement
     * removes entries because the underlying connections map is the source. */
    annotationsFor(user: string): ReadonlyMap<string, ToolAnnotationEntry>;
    reconcileAll(mode?: UserServersMode): Promise<void>;
    close(): void;
}
export declare function userServerAllowed(kind: "url" | "stdio", mode: UserServersMode): boolean;
export declare function createUserCatalog(host: SigrunHost, servers: Readonly<Record<string, McpServerConfig>>, initialMode?: UserServersMode): UserCatalog;
