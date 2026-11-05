/** Wire types for the MCP stdio protocol surface this extension uses. */
import type { McpServerConfig } from "./config.js";
/** The MCP-declared hint surface, narrowed to the four boolean hints a
 * downstream safety classifier reads. Non-boolean values are dropped at
 * discovery time rather than trusted blindly. */
export interface ToolAnnotations {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
}
/** One tool as `tools/list` reports it. */
export interface McpToolDefinition {
    readonly name: string;
    readonly description?: string;
    /** Server-advertised hints; only boolean values are retained. */
    readonly annotations?: {
        readonly [key: string]: unknown;
    };
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
