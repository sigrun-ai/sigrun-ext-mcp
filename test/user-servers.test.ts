import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMcpConfig } from "../src/config.js";
import { createMcpExtension } from "../src/extension.js";
import {
	createUserCatalog,
	userServerAllowed,
} from "../src/user-servers.js";
import { createCatalogHost } from "./catalog-host.js";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { validateTree } from "@sigrun/sigrun/blocks";
import { assertFreshCoreBlocks } from "./core-blocks-freshness.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fakeMcpServer(tool = "ping"): Promise<{
	url: string;
	connections: () => number;
	close: () => Promise<void>;
}> {
	let requests = 0;
	const server: Server = createServer((request, response) => {
		requests += 1;
		let body = "";
		request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
		request.on("end", () => {
			const frame = JSON.parse(body) as { id?: number; method: string };
			if (frame.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			const result = frame.method === "initialize"
				? { protocolVersion: "2025-06-18", capabilities: {} }
				: frame.method === "tools/list"
					? { tools: [{ name: tool, inputSchema: { type: "object" } }] }
					: { content: [{ type: "text", text: "pong" }] };
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("missing test port");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		connections: () => requests,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
	};
}

function settings(servers: Record<string, unknown> | string): Record<string, unknown> {
	return { servers };
}

describe("user-supplied MCP server configuration", () => {
	it("parses the userServers mode and rejects invalid values with the allowed set", () => {
		expect(parseMcpConfig(JSON.stringify({ servers: {}, userServers: "remote" }), "acme/mcp.json").userServers).toBe("remote");
		expect(() => parseMcpConfig(JSON.stringify({ servers: {}, userServers: "everything" }), "acme/mcp.json"))
			.toThrow(/userServers.*"none", "remote", "all"/);
	});

	it("rejects a catalog server that would shadow the user settings namespace", () => {
		expect(() => parseMcpConfig(JSON.stringify({ servers: { servers: { url: "https://example.invalid/mcp" } } }), "acme/mcp.json"))
			.toThrow(/server "servers".*reserved.*settings/);
	});

	it("keeps transport gating in one full mode matrix", () => {
		expect(userServerAllowed("url", "remote")).toBe(true);
		expect(userServerAllowed("stdio", "remote")).toBe(false);
		expect(userServerAllowed("url", "all")).toBe(true);
		expect(userServerAllowed("stdio", "all")).toBe(true);
	});
});

describe("user-supplied MCP server lifecycle", () => {
	it("balances its process exit listener across factory and close", async () => {
		const before = process.listenerCount("exit");
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		const wiring = createMcpExtension(double.host);
		if (wiring.perUserTools) double.declarePerUserTools();
		cleanups.push(() => wiring.close());
		expect(process.listenerCount("exit")).toBe(before + 1);
		await wiring.close();
		expect(process.listenerCount("exit")).toBe(before);
	});

	it("none ignores a user stdio server", async () => {
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		double.setSettings("alice", settings({ acme: { command: "acme-stdio", args: [] } }));
		const catalog = createUserCatalog(double.host, {}, "none");
		double.declarePerUserTools();
		cleanups.push(() => catalog.close());
		await catalog.activate("alice");
		expect(double.launches).toHaveLength(0);
		expect(double.userTools.get("alice")).toEqual([]);
	});

	it("remote loads URL tools with the u_ prefix and ignores stdio", async () => {
		const remote = await fakeMcpServer();
		cleanups.push(remote.close);
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		double.setSettings("alice", settings({
			acme: { url: remote.url },
			local: { command: "acme-stdio", args: [] },
		}));
		const catalog = createUserCatalog(double.host, {}, "remote");
		double.declarePerUserTools();
		cleanups.push(() => catalog.close());
		await catalog.activate("alice");
		expect(double.userTools.get("alice")?.map((tool) => tool.name)).toEqual(["u_acme/ping"]);
		expect(double.launches).toHaveLength(0);
	});

	it("all loads URL servers and refuses stdio with a named host-contract error", async () => {
		const remote = await fakeMcpServer();
		cleanups.push(remote.close);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		double.setSettings("alice", settings({
			acme: { url: remote.url },
			local: { command: "acme-stdio", args: [] },
		}));
		const catalog = createUserCatalog(double.host, {}, "all");
		double.declarePerUserTools();
		cleanups.push(() => catalog.close());
		await catalog.activate("alice");
		expect(double.userTools.get("alice")?.map((tool) => tool.name)).toEqual(["u_acme/ping"]);
		expect(double.launches).toHaveLength(0);
		expect(warning).toHaveBeenCalledWith(expect.stringMatching(/server "local".*statically at load.*no server name.*start/));
	});

	it("rejects u_-prefixed user server names without affecting another user", async () => {
		const remote = await fakeMcpServer();
		cleanups.push(remote.close);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		double.setSettings("alice", settings({ u_acme: { url: "https://example.invalid/mcp" } }));
		double.setSettings("bob", settings({ acme: { url: remote.url } }));
		const catalog = createUserCatalog(double.host, {}, "remote");
		double.declarePerUserTools();
		cleanups.push(() => catalog.close());
		await Promise.all([catalog.activate("alice"), catalog.activate("bob")]);
		expect(double.userTools.get("alice")).toEqual([]);
		expect(double.userTools.get("bob")?.map((tool) => tool.name)).toEqual(["u_acme/ping"]);
		expect(warning).toHaveBeenCalledWith(expect.stringMatching(/alice.*u_acme.*reserved "u_" prefix/));
	});

	it("accepts the string persisted by an extension-scope longtext save", async () => {
		const remote = await fakeMcpServer();
		cleanups.push(remote.close);
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		double.setSettings("alice", settings(JSON.stringify({ acme: { url: remote.url } })));
		const catalog = createUserCatalog(double.host, {}, "remote");
		double.declarePerUserTools();
		cleanups.push(() => catalog.close());
		await catalog.activate("alice");
		expect(double.userTools.get("alice")?.map((tool) => tool.name)).toEqual(["u_acme/ping"]);
	});

	it("treats an untouched or cleared longtext editor as no user servers", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		double.setSettings("alice", settings("  \n"));
		const catalog = createUserCatalog(double.host, {}, "remote");
		double.declarePerUserTools();
		cleanups.push(() => catalog.close());
		await catalog.activate("alice");
		expect(double.userTools.get("alice")).toEqual([]);
		expect(warning).not.toHaveBeenCalled();
	});

	it("reports malformed longtext JSON as that user's settings error", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		double.setSettings("alice", settings("{not-json"));
		const catalog = createUserCatalog(double.host, {}, "remote");
		double.declarePerUserTools();
		cleanups.push(() => catalog.close());
		await catalog.activate("alice");
		expect(double.userTools.get("alice")).toEqual([]);
		expect(warning).toHaveBeenCalledWith(expect.stringMatching(/user \"alice\".*not valid JSON/));
	});

	it("passes the contributed form through core's real settings validator", () => {
		assertFreshCoreBlocks();
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		const catalog = createUserCatalog(double.host, {}, "remote");
		double.declarePerUserTools();
		cleanups.push(() => catalog.close());
		const section = catalog.settings.find((item) => item.id === "user-servers");
		expect(section?.scope).toBe("user");
		expect(validateTree(section?.form, {
			placement: "settings",
			handlers: new Set(["save", "submit"]),
		})).toMatchObject({ ok: true });
	});

	it("keeps URL tools across all to remote and retires them at none", async () => {
		// The all-mode stdio refusal above is intentional; this URL fixture
		// covers the permitted side of the same policy transitions.
		const remote = await fakeMcpServer();
		cleanups.push(remote.close);
		const dir = await mkdtemp(join(tmpdir(), "acme-user-servers-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const path = join(dir, "mcp.json");
		await writeFile(path, JSON.stringify({ servers: {}, userServers: "all" }));
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		double.setSettings("alice", settings({ acme: { url: remote.url } }));
		double.setSettings("bob", settings({ acme: { url: remote.url } }));
		const prior = process.env.SIGRUN_MCP_CONFIG;
		process.env.SIGRUN_MCP_CONFIG = path;
		let wiring: ReturnType<typeof createMcpExtension>;
		try {
			wiring = createMcpExtension(double.host);
		} finally {
			if (prior === undefined) delete process.env.SIGRUN_MCP_CONFIG;
			else process.env.SIGRUN_MCP_CONFIG = prior;
		}
		if (wiring.perUserTools) double.declarePerUserTools();
		cleanups.push(() => wiring.close());
		await Promise.all([
			wiring.conversationCreated({ conversationId: ROOT_CONVERSATION_ID, owner: "alice" }),
			wiring.conversationCreated({ conversationId: ROOT_CONVERSATION_ID, owner: "bob" }),
		]);
		expect(double.userTools.get("alice")?.map((tool) => tool.name)).toEqual(["u_acme/ping"]);
		expect(double.userTools.get("bob")?.map((tool) => tool.name)).toEqual(["u_acme/ping"]);
		const before = remote.connections();
		await writeFile(path, JSON.stringify({ servers: {}, userServers: "remote" }));
		await wiring.runSettled({ conversationId: ROOT_CONVERSATION_ID, owner: "alice" });
		expect(double.userTools.get("alice")?.map((item) => item.name)).toEqual(["u_acme/ping"]);
		expect(double.userTools.get("bob")?.map((item) => item.name)).toEqual(["u_acme/ping"]);
		expect(remote.connections()).toBe(before);
		const tool = double.userTools.get("alice")?.[0];
		expect(tool).toBeDefined();
		await writeFile(path, JSON.stringify({ servers: {}, userServers: "none" }));
		await wiring.runSettled({ conversationId: ROOT_CONVERSATION_ID, owner: "alice" });
		expect(double.userTools.get("alice")).toEqual([]);
		expect(double.userTools.get("bob")).toEqual([]);
		const result = await tool?.execute(
			{},
			{ conversationId: ROOT_CONVERSATION_ID } as Parameters<typeof tool.execute>[1],
			{ abortSignal: undefined } as Parameters<typeof tool.execute>[2],
		);
		expect(result).toMatchObject({ isError: true });
		expect(remote.connections()).toBe(before);
	});

	it("keeps activation working when a policy read is malformed", async () => {
		const remote = await fakeMcpServer();
		cleanups.push(remote.close);
		const dir = await mkdtemp(join(tmpdir(), "acme-policy-error-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const path = join(dir, "mcp.json");
		await writeFile(path, JSON.stringify({ servers: {}, userServers: "remote" }));
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		double.setSettings("alice", settings({ acme: { url: remote.url } }));
		const prior = process.env.SIGRUN_MCP_CONFIG;
		process.env.SIGRUN_MCP_CONFIG = path;
		let wiring: ReturnType<typeof createMcpExtension>;
		try {
			wiring = createMcpExtension(double.host);
		} finally {
			if (prior === undefined) delete process.env.SIGRUN_MCP_CONFIG;
			else process.env.SIGRUN_MCP_CONFIG = prior;
		}
		if (wiring.perUserTools) double.declarePerUserTools();
		cleanups.push(() => wiring.close());
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await writeFile(path, "{malformed");
		await wiring.runSettled({ conversationId: ROOT_CONVERSATION_ID, owner: "alice" });
		expect(double.userTools.get("alice")?.map((tool) => tool.name)).toEqual(["u_acme/ping"]);
		expect(warning).toHaveBeenCalledWith(expect.stringContaining(path));
	});
});
