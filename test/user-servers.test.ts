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

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fakeMcpServer(tool = "ping"): Promise<{ url: string; close: () => Promise<void> }> {
	const server: Server = createServer((request, response) => {
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
		close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
	};
}

function settings(servers: Record<string, unknown>): Record<string, unknown> {
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
	it("none ignores a user stdio server", async () => {
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		double.setSettings("alice", settings({ acme: { command: "acme-stdio", args: [] } }));
		const catalog = createUserCatalog(double.host, {}, "none");
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
		cleanups.push(() => catalog.close());
		await Promise.all([catalog.activate("alice"), catalog.activate("bob")]);
		expect(double.userTools.get("alice")).toEqual([]);
		expect(double.userTools.get("bob")?.map((tool) => tool.name)).toEqual(["u_acme/ping"]);
		expect(warning).toHaveBeenCalledWith(expect.stringMatching(/alice.*u_acme.*reserved "u_" prefix/));
	});

	it("contributes a user settings section bound to the servers namespace", () => {
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		const catalog = createUserCatalog(double.host, {}, "remote");
		cleanups.push(() => catalog.close());
		const section = catalog.settings.find((item) => item.id === "user-servers");
		expect(section?.scope).toBe("user");
		expect(JSON.stringify(section?.form)).toContain('"name":"servers"');
	});

	it("flips all to remote for every user and drops a disallowed server's tools on a later none flip", async () => {
		const remote = await fakeMcpServer();
		cleanups.push(remote.close);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const dir = await mkdtemp(join(tmpdir(), "acme-user-servers-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const path = join(dir, "mcp.json");
		await writeFile(path, JSON.stringify({ servers: {}, userServers: "all" }));
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		double.setSettings("alice", settings({ local: { command: "acme-stdio", args: [] }, acme: { url: remote.url } }));
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
		cleanups.push(() => wiring.close());
		await Promise.all([
			wiring.conversationCreated({ conversationId: ROOT_CONVERSATION_ID, owner: "alice" }),
			wiring.conversationCreated({ conversationId: ROOT_CONVERSATION_ID, owner: "bob" }),
		]);
		expect(double.userTools.get("alice")?.map((tool) => tool.name)).toEqual(["u_acme/ping"]);
		expect(double.launches).toHaveLength(0);
		await writeFile(path, JSON.stringify({ servers: {}, userServers: "remote" }));
		await wiring.onSettingsChanged(["userServers"]);
		expect(double.userTools.get("bob")?.map((tool) => tool.name)).toEqual(["u_acme/ping"]);
		expect(double.launches).toHaveLength(0);
		expect(warning).toHaveBeenCalledWith(expect.stringMatching(/server "local"/));
		await writeFile(path, JSON.stringify({ servers: {}, userServers: "none" }));
		await wiring.onSettingsChanged(["userServers"]);
		expect(double.userTools.get("alice")).toEqual([]);
		expect(double.userTools.get("bob")).toEqual([]);
		const retired = double.userTools.get("bob");
		expect(retired).toEqual([]);
	});
});
