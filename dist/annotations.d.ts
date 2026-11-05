/** The `mcp.tool-annotations` published hook: a downstream safety extension
 * asks "what did this tool's server declare about it?" and this extension
 * answers from its live connection maps — the caller's per-user catalog
 * first, then shared servers the caller may reach, else unknown. */
import { Type, type Static } from "@earendil-works/pi-ai";
import type { PublishedHook } from "@sigrun/sigrun/extension";
import type { McpServerConfig } from "./config.js";
import { type SigrunHost, type ToolAnnotationEntry, type UserCatalog } from "./user-servers.js";
declare const Input: Type.TObject<{
    tool: Type.TString;
}>;
export declare const TOOL_ANNOTATIONS_INPUT: Type.TObject<{
    tool: Type.TString;
}>;
export declare const TOOL_ANNOTATIONS_OUTPUT: Type.TUnion<[Type.TObject<{
    server: Type.TString;
    mcpName: Type.TString;
    annotations: Type.TObject<{
        readOnlyHint: Type.TOptional<Type.TBoolean>;
        destructiveHint: Type.TOptional<Type.TBoolean>;
        idempotentHint: Type.TOptional<Type.TBoolean>;
        openWorldHint: Type.TOptional<Type.TBoolean>;
    }>;
}>, Type.TObject<{
    unknown: Type.TLiteral<true>;
}>]>;
export type ToolAnnotationsPayload = Static<typeof Input>;
export type ToolAnnotationsResult = ToolAnnotationEntry | {
    readonly unknown: true;
};
export declare const TOOL_ANNOTATIONS_HOOK = "mcp.tool-annotations";
export declare function createToolAnnotationsHook(host: SigrunHost, catalog: UserCatalog, shared: ReadonlyMap<string, {
    readonly server: McpServerConfig;
    readonly annotations: ReadonlyMap<string, ToolAnnotationEntry>;
}>): PublishedHook;
export {};
