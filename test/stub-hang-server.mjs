/**
 * A hanging MCP server for timeout tests: speaks the handshake and tools/list
 * like the normal stub, but `tools/call` for "hang" NEVER replies — and can
 * be told (via env) to keep sending `notifications/progress` for the pending
 * request instead, to exercise the deadline-reset path.
 *
 * Env knobs (HANG_MODE):
 *   unset/"silent"  — tools/call hangs silently (no progress, no reply)
 *   "progress"      — tools/call sends a progress notification every 100ms
 *                     forever, never replying
 */

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
const HANG_MODE = process.env.HANG_MODE ?? "silent";

const TOOLS = [
	{
		name: "hang",
		description: "Hangs forever (or reports progress forever).",
		inputSchema: { type: "object" },
	},
];

function write(frame) {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

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
	if (frame.id === undefined) return; // a notification: no response
	const id = frame.id;
	if (frame.method === "initialize") {
		write({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: "hang-mcp", version: "0.1.0" },
			},
		});
		return;
	}
	if (frame.method === "tools/list") {
		write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
		return;
	}
	if (frame.method === "tools/call") {
		// Never reply. In progress mode, keep notifying: the client's
		// deadline must keep resetting while the server reports work.
		if (HANG_MODE === "progress") {
			const token = frame.params?._meta?.progressToken ?? id;
			const tick = () =>
				write({
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progressToken: token, progress: 1, total: 10 },
				});
			tick();
			setInterval(tick, 100);
		}
		return;
	}
	write({
		jsonrpc: "2.0",
		id,
		error: { code: -32601, message: `unknown method: ${String(frame.method)}` },
	});
});