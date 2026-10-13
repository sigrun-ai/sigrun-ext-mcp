/**
 * Minimal hand-rolled MCP stdio client (ruling 3): JSON-RPC 2.0 over
 * newline-delimited stdio, no pi-mcp dependency.
 *
 * Lifecycle: spawn → `initialize` handshake (protocolVersion "2025-06-18",
 * clientInfo, capabilities) → `notifications/initialized` → `tools/list`
 * (discovery) → `tools/call` (execution). Requests correlate by id; the
 * response frame's `id` must match a pending request (a notification is
 * never a reply). A spawn failure or handshake failure rejects `connect`,
 * never affecting any other server (per-server isolation).
 *
 * Per-request timeout (codemode parity, spec slice 3): every request REJECTS
 * at its deadline (default 60s; config `timeout` per server) instead of
 * awaiting a hung server forever. A `notifications/progress` frame naming a
 * pending request's id (sent as the request's `progressToken`) RESETS that
 * request's deadline — a server that keeps reporting progress stays alive
 * as long as it works. A timeout rejects the call but never kills the child
 * (per-server isolation: the next request gets a fresh chance).
 */
import { type ChildProcess } from "node:child_process";
import type { McpServerConfig, McpToolDefinition, McpToolResult } from "./types.js";
/** One connected MCP server: a live child process speaking JSON-RPC. */
export declare class McpClient {
    #private;
    /** @internal constructed by {@link connectMcpServer}. */
    constructor(name: string, child: ChildProcess);
    /**
     * The MCP handshake: `initialize` then `notifications/initialized`.
     * The initialize reply is validated to carry the protocol version.
     */
    handshake(): Promise<void>;
    /** Discover the server's tools (`tools/list`). */
    listTools(): Promise<McpToolDefinition[]>;
    /** Execute one tool (`tools/call`); an `isError` result resolves (it is a
     * valid tool outcome, not a protocol failure). `timeoutSeconds` caps the
     * wait per request (default 60; progress notifications reset it). */
    callTool(name: string, args: Record<string, unknown>, timeoutSeconds?: number): Promise<McpToolResult>;
    /** Wait for the child to exit (used by tests / shutdown checks). */
    exited(): Promise<Error | undefined>;
    /** Kill the child and tear down (idempotent). */
    close(): void;
}
/**
 * Spawn and connect one configured MCP server. Throws on spawn failure or a
 * failed handshake — per-server isolation is the CALLER's policy (the
 * extension connects all servers with `.catch` per server).
 */
export declare function connectMcpServer(name: string, config: McpServerConfig): Promise<McpClient>;
