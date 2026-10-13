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

import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import {
	defineExtension,
	defineTool,
	type Extension,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { connectMcpServer, type McpClient } from "./client.js";
import {
	loadMcpConfig,
	resolveToolExposure,
	serverEnabled,
	type McpExposure,
	type McpServerConfig,
} from "./config.js";
import type {
	McpContentBlock,
	McpToolDefinition,
	McpToolResult,
} from "./types.js";

/** The extension's pi-durable registry name. */
export const MCP_EXTENSION_NAME = "sigrun.mcp";

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

/** Render one MCP content block as pi-ai tool-result content. */
function toContent(block: McpContentBlock): { type: "text"; text: string } {
	if (block.type === "text" && typeof block.text === "string") {
		return { type: "text", text: block.text };
	}
	return { type: "text", text: JSON.stringify(block) };
}

/** Build the pi-durable tool for one discovered MCP tool. */
function mcpTool(
	serverName: string,
	tool: McpToolDefinition,
	client: McpClient,
	exposure: McpExposure,
	timeoutSeconds: number | undefined,
): ToolRegistration {
	// MCP advertises a plain JSON Schema for arguments. pi-durable validates
	// with TypeBox's Compile, which accepts plain JSON Schema objects; pass it
	// through as an unsafe schema (fallback: the empty object schema when the
	// server omitted inputSchema).
	const parameters = (
		tool.inputSchema !== undefined &&
		typeof tool.inputSchema === "object" &&
		tool.inputSchema !== null
			? tool.inputSchema
			: { type: "object" }
	) as unknown as TSchema;
	const toolName = `${serverName}/${tool.name}`;
	// The exposure mapping onto pi-durable 1.2.0 (spec slice 3):
	//   codemode → callers: ["tools"] (scripts only, never model-offered);
	//   deferred → deferred: true (invisible until tool_search loads it);
	//   direct   → normal registration (model-offered when in the tool set);
	//   hidden   → never registered (the caller checks and skips).
	const exposureFlags =
		exposure === "codemode"
			? { callers: ["tools"] as const }
			: exposure === "deferred"
					? { deferred: true as const }
					: {};
	return defineTool({
		name: toolName,
		description:
			tool.description !== undefined && tool.description !== ""
				? tool.description
				: `MCP tool ${tool.name} on server ${serverName}.`,
		parameters: Type.Unsafe(parameters),
		// A tools/call round-trip is external I/O; never rerun on recovery.
		replay: "unsafe",
		...exposureFlags,
		async execute(args) {
			const result: McpToolResult = await client.callTool(
				tool.name,
				{ ...(args as Record<string, unknown>) },
				timeoutSeconds,
			);
			const blocks = result.content ?? [];
			const content = blocks.length > 0 ? blocks.map(toContent) : [];
			return {
				output: content.length > 0 ? content : [
					{ type: "text" as const, text: JSON.stringify(result) },
				],
				isError: result.isError === true,
				details: result as unknown as import("@earendil-works/chord").JsonValue,
			};
		},
	});
}

/**
 * The extension factory (the loader contract: no arguments; config resolves
 * from the package context — the `SIGRUN_MCP_CONFIG` override or the sigrun
 * config dir).
 */
export function createMcpExtension(): McpWiring {
	const config = loadMcpConfig();
	const tools: ToolRegistration[] = []; // live: discovered tools land here
	const clients = new Map<string, McpClient>();
	let closed = false;

	// Per-server isolation: each server connects independently; any failure
	// quarantines that server alone (warned, zero tools) and the others
	// proceed. A disabled server is skipped before it ever spawns.
	const pending: Promise<void>[] = [];
	for (const [name, server] of Object.entries(config.servers)) {
		if (!serverEnabled(server)) continue;
		pending.push(
			(async () => {
				let client: McpClient;
				try {
					client = await connectMcpServer(name, server);
				} catch (cause) {
					console.warn(
						`mcp server "${name}" quarantined: ${
							cause instanceof Error ? cause.message : String(cause)
						}`,
					);
					return;
			}
				if (closed) {
					client.close();
					return;
			}
				clients.set(name, client);
				try {
					const discovered = await client.listTools();
				for (const tool of discovered) {
					const exposure = resolveToolExposure(server, tool.name);
					if (exposure === "hidden") continue; // not registered
					tools.push(
						mcpTool(name, tool, client, exposure, server.timeout),
					);
				}
			} catch (cause) {
					clients.delete(name);
					client.close();
					console.warn(
						`mcp server "${name}" quarantined during discovery: ${
							cause instanceof Error ? cause.message : String(cause)
						}`,
					);
				}
			})(),
		);
	}

	const killAll = () => {
		if (closed) return;
		closed = true;
		for (const client of clients.values()) client.close();
		clients.clear();
		tools.length = 0;
	};

	// Children must not outlive this process. The exit handler must be
	// synchronous (exit listeners cannot await), so it only SIGTERMs.
	process.on("exit", killAll);

	const extension = defineExtension({
		name: MCP_EXTENSION_NAME,
		tools, // live array: the registry re-reads it on every snapshot
	});

	return {
		extension,
		close: killAll,
		ready: Promise.all(pending).then(() => undefined),
	};
}