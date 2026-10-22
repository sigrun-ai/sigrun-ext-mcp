/**
 * Remote-transport tests (the testable line): an http(s) MCP server
 * connects over streamable HTTP — the reply arriving as a JSON body or an
 * SSE stream — and a server that 404/405s the POST falls back to the
 * legacy HTTP+SSE transport (GET stream + endpoint event + message POSTs).
 *
 * All stubs are plain node:http servers on 127.0.0.1 OS-ephemeral ports.
 */

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { connectMcpServer } from "../src/client.js";

/** The shared stub tool surface (mirrors the stdio stub's echo/add). */
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

interface StubFrame {
	jsonrpc: "2.0";
	id?: number | string | null;
	method?: string;
	params?: unknown;
}

/** Reply payload for one stub request frame. */
function replyFor(frame: StubFrame): unknown {
	if (frame.method === "initialize") {
		return {
			protocolVersion: "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "stub-http", version: "0.0.1" },
		};
	}
	if (frame.method === "tools/list") return { tools: TOOLS };
	if (frame.method === "tools/call") {
		const params = frame.params as { name?: string; arguments?: Record<string, unknown> };
		if (params?.name === "echo") {
			return {
				content: [{ type: "text", text: `hello, ${params.arguments?.name ?? "?"}` }],
			};
		}
		if (params?.name === "add") {
			const a = Number(params.arguments?.a ?? 0);
			const b = Number(params.arguments?.b ?? 0);
			return { content: [{ type: "text", text: String(a + b) }] };
		}
		return undefined; // caller renders a JSON-RPC error
	}
	return {};
}

/** The reply frame for a request (or undefined when the method is unknown). */
function replyFrame(frame: StubFrame): { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: { code: number; message: string } } {
	const result = replyFor(frame);
	if (result === undefined) {
		return {
			jsonrpc: "2.0",
			id: frame.id ?? 0,
			error: { code: -32602, message: `unknown tool: ${(frame.params as { name?: string })?.name ?? "?"}` },
		};
	}
	return { jsonrpc: "2.0", id: frame.id ?? 0, result };
}

/** Listen on an ephemeral port; resolve the base URL. */
function listen(server: Server): Promise<string> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${address.port}`);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

/** Collect every JSON body the server parsed (request observation). */
interface Observed {
	method: string;
	id: number | string | null | undefined;
	headers: Record<string, string | string[] | undefined>;
}

function makeStreamableJson(): { server: Server; url: () => Promise<string>; observed: Observed[] } {
	const observed: Observed[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			const frame = JSON.parse(body) as StubFrame;
			observed.push({ method: frame.method ?? "?", id: frame.id, headers: req.headers });
			if (frame.method === "notifications/initialized") {
				res.writeHead(202).end();
				return;
			}
			res.setHeader("content-type", "application/json");
			res.setHeader("mcp-session-id", "sess-1");
			res.end(JSON.stringify(replyFrame(frame)));
		});
	});
	return { server, url: () => listen(server), observed };
}

function makeStreamableSse(): { server: Server; url: () => Promise<string>; observed: Observed[] } {
	const observed: Observed[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			const frame = JSON.parse(body) as StubFrame;
			observed.push({ method: frame.method ?? "?", id: frame.id, headers: req.headers });
			if (frame.method === "notifications/initialized") {
				res.writeHead(202).end();
				return;
			}
			res.setHeader("content-type", "text/event-stream");
			res.setHeader("mcp-session-id", "sse-sess-1");
			res.write(`event: message\ndata: ${JSON.stringify(replyFrame(frame))}\n\n`);
			res.end();
		});
	});
	return { server, url: () => listen(server), observed };
}

function makeLegacySse(): { server: Server; url: () => Promise<string>; observed: Observed[] } {
	const observed: Observed[] = [];
	// The message endpoint path the endpoint event announces.
	const messagePath = "/legacy/messages";
	const server = createServer((req, res) => {
		if (req.method === "POST") {
			let body = "";
			req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
			req.on("end", () => {
				const frame = JSON.parse(body) as StubFrame;
				observed.push({ method: frame.method ?? "?", id: frame.id, headers: req.headers });
				if (req.url === messagePath) {
					// Legacy: the reply rides the GET stream, the POST just 202s.
					res.writeHead(202).end();
					legacyStream?.write(`event: message\ndata: ${JSON.stringify(replyFrame(frame))}\n\n`);
					return;
				}
				// The streamable-style POST on the root: 405 triggers fallback.
				res.writeHead(405).end();
			});
			return;
		}
		// GET: the long-lived SSE stream.
		res.setHeader("content-type", "text/event-stream");
		res.flushHeaders();
		res.write(`event: endpoint\ndata: ${messagePath}\n\n`);
		legacyStream = res;
	});
	let legacyStream: import("node:http").ServerResponse | undefined;
	return { server, url: () => listen(server), observed };
}

test("streamable HTTP (JSON bodies): handshake, list, call, session echo", async () => {
	const stub = makeStreamableJson();
	const url = await stub.url();
	try {
		const client = await connectMcpServer("stub", { url });
		try {
			const tools = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
			const result = await client.callTool("add", { a: 2, b: 40 });
			expect(result.content?.[0]?.text).toBe("42");
			await expect(client.callTool("nope", {})).rejects.toThrow(/unknown tool: nope/);
		} finally {
			client.close();
		}
		// The session id from the initialize response echoed on later requests.
		const listCall = stub.observed.find((o) => o.method === "tools/list");
		expect(listCall?.headers["mcp-session-id"]).toBe("sess-1");
	} finally {
		await close(stub.server);
	}
});

test("streamable HTTP (SSE replies): full round trip", async () => {
	const stub = makeStreamableSse();
	const url = await stub.url();
	try {
		const client = await connectMcpServer("stub", { url });
		try {
			const tools = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
			const result = await client.callTool("echo", { name: "world" });
			expect(result.content?.[0]?.text).toBe("hello, world");
		} finally {
			client.close();
		}
		const listCall = stub.observed.find((o) => o.method === "tools/list");
		expect(listCall?.headers["mcp-session-id"]).toBe("sse-sess-1");
	} finally {
		await close(stub.server);
	}
});

test("legacy HTTP+SSE: POST 405 falls back to the GET stream + endpoint event", async () => {
	const stub = makeLegacySse();
	const url = await stub.url();
	try {
		const client = await connectMcpServer("stub", { url });
		try {
			const tools = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
			const result = await client.callTool("echo", { name: "legacy" });
			expect(result.content?.[0]?.text).toBe("hello, legacy");
		} finally {
			client.close();
		}
		// After fallback, requests POST to the endpoint-event URL, not the root.
		const call = stub.observed.find((o) => o.method === "tools/call");
		expect(call).toBeDefined();
	} finally {
		await close(stub.server);
	}
});

test("config headers ride every request", async () => {
	const stub = makeStreamableJson();
	const url = await stub.url();
	try {
		const client = await connectMcpServer("stub", {
			url,
			headers: { authorization: "Bearer stub-token" },
		});
		try {
			await client.listTools();
		} finally {
			client.close();
		}
		const listCall = stub.observed.find((o) => o.method === "tools/list");
		expect(listCall?.headers.authorization).toBe("Bearer stub-token");
	} finally {
		await close(stub.server);
	}
});

test("a non-2xx POST rejects the connect with status and body snippet", async () => {
	const server = createServer((_req, res) => {
		res.setHeader("content-type", "application/json");
		res.writeHead(500);
		res.end(JSON.stringify({ error: "broken" }));
	});
	const url = await listen(server);
	try {
		await expect(
			connectMcpServer("broken", { url }),
		).rejects.toThrow(/500/);
	} finally {
		await close(server);
	}
});

test("close() settles in-flight requests", async () => {
	// A streamable server that answers initialize but HANGS every later
	// request (headers never sent): a call under it must settle at close(),
	// not wait out its 60s deadline.
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			const frame = JSON.parse(body) as StubFrame;
			if (frame.method === "initialize" || frame.method === "notifications/initialized") {
				res.setHeader("content-type", "application/json");
				res.writeHead(200).end(JSON.stringify(replyFrame(frame)));
				return;
			}
			// Everything else: open the stream and never speak again.
			res.writeHead(202);
		});
	});
	const url = await listen(server);
	try {
		const client = await connectMcpServer("stub", { url, timeout: 60 });
		const pending = client.listTools();
		// Give the POST a moment to land, then close underneath it.
		await new Promise((r) => setTimeout(r, 50));
		client.close();
		await expect(pending).rejects.toThrow(/closed/);
	} finally {
		await close(server);
	}
});

test("a hung request rejects at its deadline (timeout semantics survive the transport)", async () => {
	// Same hang-after-initialize shape, but the test NEVER closes: the
	// engine's per-request deadline must fire and reject. The deadline is
	// per-REQUEST (callTool's timeoutSeconds — the extension threads the
	// server's `timeout` there); listTools uses the default, so this
	// exercises the deadline through callTool with a 1s cap.
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			const frame = JSON.parse(body) as StubFrame;
			if (frame.method === "initialize" || frame.method === "notifications/initialized") {
				res.setHeader("content-type", "application/json");
				res.writeHead(200).end(JSON.stringify(replyFrame(frame)));
				return;
			}
			res.writeHead(202);
		});
	});
	const url = await listen(server);
	try {
		const client = await connectMcpServer("stub", { url });
		try {
			await expect(
				client.callTool("echo", { name: "x" }, 1),
			).rejects.toThrow(/timed out after 1s/);
		} finally {
			client.close();
		}
	} finally {
		await close(server);
	}
});

test("CRLF-framed SSE replies parse (live servers emit \\r\\n)", async () => {
	// The SSE spec allows CRLF line endings; a parser that splits events
	// on plain \n\n never finds the boundary. This stub frames with CRLF.
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			const frame = JSON.parse(body) as StubFrame;
			if (frame.method === "notifications/initialized") {
				res.writeHead(202).end();
				return;
			}
			res.setHeader("content-type", "text/event-stream");
			res.write(`event: message\r\ndata: ${JSON.stringify(replyFrame(frame))}\r\n\r\n`);
			res.end();
		});
	});
	const url = await listen(server);
	try {
		const client = await connectMcpServer("stub", { url });
		try {
			const tools = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(["echo", "add"]);
		} finally {
			client.close();
		}
	} finally {
		await close(server);
	}
});
