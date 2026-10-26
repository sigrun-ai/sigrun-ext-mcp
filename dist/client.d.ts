/**
 * The MCP client: a transport-neutral JSON-RPC 2.0 engine plus two
 * transports.
 *
 * stdio (the original transport): newline-delimited JSON-RPC over a spawned
 * child's pipes. Remote (streamable HTTP): every request POSTs to the
 * configured URL; the reply is a JSON body OR an SSE stream. A server that
 * 404/405s the POST (the pre-2025-03-26 "HTTP+SSE" transport — still common,
 * e.g. many self-hosted servers) falls back to the legacy shape: a GET
 * stream for server→client frames and a discovered message endpoint for
 * client→server POSTs.
 *
 * Lifecycle (both transports): `initialize` handshake (protocolVersion
 * "2025-06-18", clientInfo, capabilities) → `notifications/initialized` →
 * `tools/list` (discovery) → `tools/call` (execution). Requests correlate
 * by id; the response frame's `id` must match a pending request (a
 * notification is never a reply). A connect failure rejects `connect`,
 * never affecting any other server (per-server isolation).
 *
 * Per-request timeout (codemode parity, spec slice 3): every request REJECTS
 * at its deadline (default 60s; config `timeout` per server) instead of
 * awaiting a hung server forever. A `notifications/progress` frame naming a
 * pending request's id (sent as the request's `progressToken`) RESETS that
 * request's deadline — a server that keeps reporting progress stays alive
 * as long as it works. A timeout rejects the call but never kills the
 * transport (per-server isolation: the next request gets a fresh chance).
 */
import type { McpServerConfig, McpToolDefinition, McpToolResult } from "./types.js";
/** The public client surface (what the extension consumes). */
export interface McpClient {
    listTools(): Promise<McpToolDefinition[]>;
    callTool(name: string, args: Record<string, unknown>, timeoutSeconds?: number): Promise<McpToolResult>;
    /** Tear the connection down (idempotent). */
    close(): void;
}
/** The byte streams of a core-launched per-user service. */
export interface McpServiceHandle {
    readonly stdin: WritableStream<Uint8Array>;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly exited: Promise<{
        code: number | null;
        signal: string | null;
    }>;
    release(): void;
}
/**
 * Spawn/connect one configured MCP server (stdio or remote by config
 * shape). Throws on spawn/connect failure or a failed handshake —
 * per-server isolation is the CALLER's policy (the extension connects all
 * servers with `.catch` per server).
 */
export declare function connectMcpServer(name: string, config: McpServerConfig, handle?: McpServiceHandle): Promise<McpClient>;
