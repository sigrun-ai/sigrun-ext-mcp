/** Wire types for the MCP stdio protocol surface this extension uses. */
import type { McpServerConfig } from "./config.js";
/** One tool as `tools/list` reports it. */
export interface McpToolDefinition {
    readonly name: string;
    readonly description?: string;
    /** JSON Schema for the tool's arguments object. */
    readonly inputSchema?: {
        readonly type?: unknown;
        readonly properties?: unknown;
        readonly required?: unknown;
        [key: string]: unknown;
    };
}
/** One content block in a `tools/call` result. */
export interface McpContentBlock {
    readonly type: string;
    readonly text?: string;
    [key: string]: unknown;
}
/** A `tools/call` result: content blocks plus the error flag. */
export interface McpToolResult {
    readonly content?: readonly McpContentBlock[];
    /** True when the tool ran and reported failure (a valid outcome). */
    readonly isError?: boolean;
    [key: string]: unknown;
}
export type { McpServerConfig };
