/** Annotation retention + the published `mcp.tool-annotations` hook:
 * discovery copies only boolean hint values, and the hook resolves a sigrun
 * tool name against the caller's reachable servers (own catalog first, then
 * gated shared servers, else unknown). */

import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Compile } from "typebox/compile";
import {
	TOOL_ANNOTATIONS_INPUT,
	TOOL_ANNOTATIONS_OUTPUT,
} from "../src/annotations.js";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PublishedHook } from "@sigrun/sigrun/extension";
import { createMcpExtension, type McpWiring } from "../src/extension.js";
import { MCP_CONFIG_ENV } from "../src/config.js";
import { discoverMcpTools } from "../src/user-servers.js";
import type { McpClient } from "../src/client.js";
import type { McpToolDefinition, McpToolResult } from "../src/types.js";
import { createCatalogHost, type CatalogHostDouble } from "./catalog-host.js";
import { cleanupDir, stubConfigPath, tempDir } from "./harness.js";

const STUB_SERVER = join(import.meta.dirname, "stub-mcp-server.mjs");

function conv(id: number): ConversationId {
	// SAFETY: the host double uses real numeric ids; pi-durable's brand only
	// distinguishes id domains at compile time.
	return id as ConversationId;
}

function fakeClient(tools: readonly McpToolDefinition[]): McpClient {
	return {
		listTools: async () => [...tools],
		callTool: async (): Promise<McpToolResult> => ({ content: [] }),
		close: () => {},
	};
}

const STDIO_SERVER = {
	command: process.execPath,
	args: [STUB_SERVER],
} as const;

test("discoverMcpTools keeps boolean annotations and drops non-boolean ones", async () => {
	const client = fakeClient([
		{
			name: "probe",
			description: "Probe everything.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: "yes",
				openWorldHint: 1,
			},
		},
		{
			name: "probeless",
			description: "Nothing boolean to keep.",
			annotations: { idempotentHint: "yes", openWorldHint: "no" },
		},
	]);
	const discovered = await discoverMcpTools(
		"acme-media",
		{ ...STDIO_SERVER },
		client,
	);
	expect(discovered.annotations.get("acme-media/probe")).toEqual({
		server: "acme-media",
		mcpName: "probe",
		annotations: { readOnlyHint: true, destructiveHint: false },
	});
	expect(discovered.tools.map((tool) => tool.name)).toEqual([
		"acme-media/probe",
		"acme-media/probeless",
	]);
});

test("a tool whose annotations are all non-boolean produces no map entry", async () => {
	const discovered = await discoverMcpTools(
		"acme-media",
		{ ...STDIO_SERVER },
		fakeClient([
			{
				name: "quiet",
				description: "Only a non-boolean hint.",
				annotations: { idempotentHint: "yes" },
			},
		]),
	);
	expect(discovered.annotations.has("acme-media/quiet")).toBe(false);
	expect(discovered.tools.map((tool) => tool.name)).toEqual([
		"acme-media/quiet",
	]);
	// Through the hook the tool exists (the stub advertises it) but with no
	// kept hints the answer is {unknown:true}.
	const opened = await openHook({
		servers: {
			"acme-media": {
				...STDIO_SERVER,
				env: { STUB_ANNOTATIONS: "1" },
				credentials: "shared",
				sharedAuthority: "Synthetic shared test authority",
			},
		},
	});
	try {
		await opened.wiring.ready;
		const conversationId = conv(5);
		opened.double.actingUsers.set(conversationId, "alice");
		expect(
			await callHook(opened.hook, "acme-media/torrents_probe", {
				user: "alice",
				conversationId,
			}),
		).toEqual({ unknown: true });
		// Sanity: a hinted sibling from the same server still resolves.
		expect(
			await callHook(opened.hook, "acme-media/torrents_remove", {
				user: "alice",
				conversationId,
			}),
		).toEqual({
			server: "acme-media",
			mcpName: "torrents_remove",
			annotations: { readOnlyHint: false, destructiveHint: true },
		});
	} finally {
		await opened.close();
	}
});

test("the hook's declared input and output schemas compile and validate the wire shapes", () => {
	// Compile the same way core's registry does; proves the schemas are
	// compilable and that the three wire shapes the hook speaks check.
	const input = Compile(TOOL_ANNOTATIONS_INPUT);
	expect(input.Check({ tool: "acme-media/torrents_remove" })).toBe(true);
	expect(input.Check({})).toBe(false);
	const output = Compile(TOOL_ANNOTATIONS_OUTPUT);
	expect(
		output.Check({
			server: "acme-media",
			mcpName: "torrents_remove",
			annotations: { destructiveHint: true },
		}),
	).toBe(true);
	expect(output.Check({ unknown: true })).toBe(true);
});

interface OpenedHook {
	readonly wiring: McpWiring;
	readonly double: CatalogHostDouble;
	readonly hook: PublishedHook;
	close(): Promise<void>;
}

async function openHook(
	config: Record<string, unknown>,
): Promise<OpenedHook> {
	const dir = await tempDir("sigrun-mcp-annotations-");
	const double = createCatalogHost();
	const prior = process.env[MCP_CONFIG_ENV];
	process.env[MCP_CONFIG_ENV] = stubConfigPath(dir);
	let wiring: McpWiring;
	try {
		await writeFile(stubConfigPath(dir), JSON.stringify(config), "utf8");
		wiring = createMcpExtension(double.host);
	} finally {
		if (prior === undefined) delete process.env[MCP_CONFIG_ENV];
		else process.env[MCP_CONFIG_ENV] = prior;
	}
	if (wiring.perUserTools) double.declarePerUserTools();
	double.registerServices(wiring.userServices);
	const hook = wiring.publishedHooks.find(
		(candidate) => candidate.name === "mcp.tool-annotations",
	);
	if (hook === undefined) throw new Error("missing mcp.tool-annotations hook");
	return {
		wiring,
		double,
		hook,
		close: async () => {
			await wiring.close();
			double.close();
			await cleanupDir(dir);
		},
	};
}

function callHook(
	hook: PublishedHook,
	tool: string,
	call: { user?: string; conversationId?: ConversationId },
): Promise<unknown> {
	return hook.run(
		{ tool },
		{
			caller: "acme-warden",
			user: call.user,
			conversationId: call.conversationId,
			abortSignal: undefined,
		},
	);
}

test("the published hook name satisfies core's published-hook grammar", async () => {
	const opened = await openHook({ servers: {} });
	try {
		// Core's loader quarantines an extension whose published-hook name
		// is not lowercase dotted segments; mirror that grammar here so a
		// rename regression fails in THIS suite, not at load time.
		expect(opened.wiring.publishedHooks.length).toBeGreaterThan(0);
		for (const hook of opened.wiring.publishedHooks) {
			expect(hook.name).toMatch(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/);
		}
	} finally {
		await opened.close();
	}
});

test("mcp.tool-annotations answers acme-media/torrents_remove with destructiveHint true and mcpName torrents_remove", async () => {
	const opened = await openHook({
		servers: {
			"acme-media": {
				...STDIO_SERVER,
				env: { STUB_ANNOTATIONS: "1" },
				credentials: "shared",
				sharedAuthority: "Synthetic shared test authority",
			},
		},
	});
	try {
		await opened.wiring.ready;
		const conversationId = conv(7);
		opened.double.actingUsers.set(conversationId, "alice");
		expect(
			await callHook(opened.hook, "acme-media/torrents_remove", {
				user: "alice",
				conversationId,
			}),
		).toEqual({
			server: "acme-media",
			mcpName: "torrents_remove",
			annotations: { readOnlyHint: false, destructiveHint: true },
		});
	} finally {
		await opened.close();
	}
});

test("answers {unknown:true} for an unknown tool and for a shared server the user can't reach", async () => {
	const opened = await openHook({
		servers: {
			"acme-media": {
				...STDIO_SERVER,
				env: { STUB_ANNOTATIONS: "1" },
				credentials: "shared",
				sharedAuthority: "Synthetic shared test authority",
			},
		},
	});
	try {
		await opened.wiring.ready;
		const aliceId = conv(11);
		opened.double.actingUsers.set(aliceId, "alice");
		// A tool name no server ever advertised.
		expect(
			await callHook(opened.hook, "acme-media/torrents_nuke", {
				user: "alice",
				conversationId: aliceId,
			}),
		).toEqual({ unknown: true });
		// alice opted the shared server out: its tools become unreachable.
		opened.double.setSettings("alice", { "acme-media": false });
		expect(
			await callHook(opened.hook, "acme-media/torrents_remove", {
				user: "alice",
				conversationId: aliceId,
			}),
		).toEqual({ unknown: true });
		// A shared-server lookup without a conversation fails closed too.
		expect(
			await callHook(opened.hook, "acme-media/torrents_remove", {
				user: "alice",
			}),
		).toEqual({ unknown: true });
	} finally {
		await opened.close();
	}
});

test("a per-user server's tool is answered only for its user (alice yes, bob unknown)", async () => {
	// alice's user-supplied URL server advertises an annotated tool over a
	// local listener; bob never configures it, so its name is unknown to him.
	const remote = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
		request.on("end", () => {
			const frame = JSON.parse(body) as { id?: number; method: string };
			if (frame.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			const result = frame.method === "initialize"
				? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
				: {
					tools: [{
						name: "torrents_remove",
						description: "Remove one torrent.",
						inputSchema: { type: "object" },
						annotations: { readOnlyHint: false, destructiveHint: true },
					}],
				};
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
		});
	});
	await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
	const address = remote.address() as AddressInfo;
	const opened = await openHook({
		servers: {
			"acme-media": {
				url: `http://127.0.0.1:${address.port}/mcp`,
				credentials: "user",
				availability: "opt-in",
			},
		},
	});
	try {
		await opened.wiring.ready;
		// alice opts in; bob leaves it disabled, so his catalog has no
		// acme-media connection and the tool is unknown to him.
		opened.double.setSettings("alice", { "acme-media": true });
		opened.double.setSettings("bob", {});
		await opened.wiring.conversationCreated({
			conversationId: conv(21),
			owner: "alice",
		});
		await opened.wiring.conversationCreated({
			conversationId: conv(22),
			owner: "bob",
		});
		expect(
			await callHook(opened.hook, "acme-media/torrents_remove", {
				user: "alice",
				conversationId: conv(21),
			}),
		).toEqual({
			server: "acme-media",
			mcpName: "torrents_remove",
			annotations: { readOnlyHint: false, destructiveHint: true },
		});
		expect(
			await callHook(opened.hook, "acme-media/torrents_remove", {
				user: "bob",
				conversationId: conv(22),
			}),
		).toEqual({ unknown: true });
	} finally {
		await opened.close();
		await new Promise<void>((resolve, reject) => {
			remote.close((error) => error === undefined ? resolve() : reject(error));
		});
	}
});
