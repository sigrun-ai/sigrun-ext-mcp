/**
 * A stub MCP server for tests: a small Node script speaking the stdio
 * JSON-RPC 2.0 protocol (ruling 3's minimal surface).
 *
 * Reads newline-delimited JSON-RPC frames from stdin, writes responses to
 * stdout. Serves:
 *   - `initialize` → the protocol version + server info + tools capability
 *   - `notifications/initialized` → ignored (a notification)
 *   - `tools/list` → two tools: `echo` (a string argument) and `add`
 *     (two number arguments)
 *   - `tools/call` → `echo` returns the greeting text; `add` returns the sum
 *     (as JSON text); unknown tools → a JSON-RPC error
 */

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
	{
		name: "echo",
		description: "Echo a greeting for a name.",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		},
	},
	{
		name: "add",
		description: "Add two numbers.",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
	},
];

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const trimmed = line.trim();
	if (trimmed === "") return;
	let frame;
	try {
		frame = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (frame.id === undefined) {
		// A notification (e.g. notifications/initialized): no response.
		return;
	}
	const id = frame.id;
	if (frame.method === "initialize") {
		write({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "stub-mcp", version: "0.1.0" },
			},
		});
		return;
	}
	if (frame.method === "tools/list") {
		write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
		return;
	}
	if (frame.method === "tools/call") {
		const name = frame.params?.name;
		const args = frame.params?.arguments ?? {};
		if (name === "echo") {
			write({
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: `hello, ${String(args.name)}` }],
				},
			});
		} else if (name === "add") {
			write({
				jsonrpc: "2.0",
				id,
				result: {
					content: [
						{
							type: "text",
							text: String(Number(args.a) + Number(args.b)),
						},
					],
				},
			});
		} else {
			write({
				jsonrpc: "2.0",
				id,
				error: { code: -32602, message: `unknown tool: ${String(name)}` },
			});
		}
		return;
	}
	write({
		jsonrpc: "2.0",
		id,
		error: { code: -32601, message: `unknown method: ${String(frame.method)}` },
	});
});

function write(frame) {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}