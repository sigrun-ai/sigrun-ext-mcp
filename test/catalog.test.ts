import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, test } from "vitest";
import { defineDoc, type ConversationId, type ToolRegistration } from "@earendil-works/pi-durable";
import { createMcpExtension } from "../src/extension.js";
import { MCP_CONFIG_ENV } from "../src/config.js";
import { createCatalogHost, type CatalogHostDouble } from "./catalog-host.js";
import { cleanupDir, stubConfigPath, tempDir, writeConfig } from "./harness.js";

const STUB_SERVER = join(import.meta.dirname, "stub-mcp-server.mjs");
const HANG_SERVER = join(import.meta.dirname, "stub-hang-server.mjs");
const CONTEXT = BACKGROUND_CONTEXT;
const SessionMetaDoc = defineDoc<{ owner?: string }>({
	kind: "sigrun.session-meta",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({}),
	checkpointWhen: () => false,
});

interface OpenedCatalog {
	readonly wiring: ReturnType<typeof createMcpExtension>;
	readonly double: CatalogHostDouble;
}

async function openCatalog(
	servers: Record<string, unknown>,
): Promise<OpenedCatalog & { close(): Promise<void> }> {
	const dir = await tempDir("sigrun-mcp-catalog-");
	const double = createCatalogHost();
	const prior = process.env[MCP_CONFIG_ENV];
	process.env[MCP_CONFIG_ENV] = stubConfigPath(dir);
	let wiring: ReturnType<typeof createMcpExtension>;
	try {
		await writeConfig(stubConfigPath(dir), servers);
		wiring = createMcpExtension(double.host);
	} finally {
		if (prior === undefined) delete process.env[MCP_CONFIG_ENV];
		else process.env[MCP_CONFIG_ENV] = prior;
	}
	if (wiring.perUserTools) double.declarePerUserTools();
	double.registerServices(wiring.userServices);
	return {
		wiring,
		double,
		close: async () => {
			await wiring.close();
			double.close();
			await cleanupDir(dir);
		},
	};
}

/** Mirror the settings surface's flat field merge and changed-key event. */
async function saveCatalogSetting(
	opened: OpenedCatalog,
	user: string,
	name: string,
	enabled: boolean,
): Promise<void> {
	const next = { ...opened.double.settings.get(user), [name]: enabled };
	await opened.double.host.stores.user(user).settings.set(next);
	await opened.wiring.onSettingsChanged([name], user);
}

function shared(fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		command: process.execPath,
		args: [STUB_SERVER],
		credentials: "shared",
		sharedAuthority: "Synthetic shared test authority",
		...fields,
	};
}

function user(fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		command: process.execPath,
		args: [STUB_SERVER],
		env: { STUB_ENV_TOOL: "1" },
		// The legacy writeConfig helper supplies shared credentials to old
		// fixtures; these fixtures must preserve the catalog's user default.
		credentials: "user",
		...fields,
	};
}

function names(tools: readonly ToolRegistration[] | undefined): string[] {
	return (tools ?? []).map((tool) => tool.name).sort();
}

function tool(tools: readonly ToolRegistration[], name: string): ToolRegistration {
	const found = tools.find((candidate) => candidate.name === name);
	if (found === undefined) throw new Error(`missing tool ${name}`);
	return found;
}

function api(conversationId: ConversationId | string) {
	return { conversationId } as never;
}

let nextConversationId = 100;
function event(opened: OpenedCatalog, owner: string) {
	// SAFETY: the host double uses real numeric ids; pi-durable's brand only
	// distinguishes id domains at compile time.
	const conversationId = nextConversationId++ as ConversationId;
	opened.double.actingUsers.set(conversationId, owner);
	return { conversationId, owner, id: conversationId };
}

async function section(
	opened: OpenedCatalog,
	conversationId: ConversationId,
): Promise<string | undefined> {
	const entry = opened.wiring.extension.sections?.find(
		(candidate) => candidate.key === "mcp_servers",
	);
	if (entry === undefined) throw new Error("mcp_servers section missing");
	return await Promise.resolve(
		entry.render(
			{
				conversationId,
				agent: {
					tools: [{ name: "codemode" }, { name: "tool_search" }],
				},
				env: undefined,
				shown: {},
				read: {
					snapshot: async (
						token: unknown,
						id: ConversationId,
					) => id === conversationId &&
						(token as { definition?: { kind?: string } }).definition?.kind === SessionMetaDoc.definition.kind
						? { owner: opened.double.actingUsers.get(id) }
						: undefined,
				},
			} as never,
			CONTEXT,
		),
	);
}

test("shared-only catalogs keep lifecycle activation and prompt sections working", async () => {
	const opened = await openCatalog({ acme: shared() });
	try {
		await opened.wiring.ready;
		const alice = event(opened, "alice");
		await opened.wiring.runSettled(alice);
		expect(opened.double.userTools.get("alice")).toEqual([]);
		await expect(section(opened, alice.id)).resolves.toContain("- acme:");
	} finally {
		await opened.close();
	}
});

test("section render never waits for an unbound host identity bridge", async () => {
	const opened = await openCatalog({ acme: shared() });
	try {
		await opened.wiring.ready;
		const alice = event(opened, "alice");
		opened.double.host.identity.actingUser = () => new Promise<string>(() => {});
		const rendered = section(opened, alice.id);
		await expect(
			Promise.race([
				rendered,
				new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
			]),
		).resolves.toContain("- acme:");
	} finally {
		await opened.close();
	}
});

test("catalog servers are lazy and each user gets a process with their own token", async () => {
	const opened = await openCatalog({ acme: user() });
	try {
		expect(opened.wiring.perUserTools).toBe(true);
		expect(opened.double.launches).toHaveLength(0);
		opened.double.setSecret("alice", "token:acme", "alice-token");
		opened.double.setSecret("bob", "token:acme", "bob-token");
		const aliceEvent = event(opened, "alice");
		const bobEvent = event(opened, "bob");
		await opened.wiring.conversationCreated(aliceEvent);
		await opened.wiring.runSettled(bobEvent);
		expect(opened.double.launches).toHaveLength(2);
		const [alice, bob] = opened.double.launches;
		expect(alice.child.pid).not.toBe(bob.child.pid);
		expect(alice.spec.env?.MCP_ACCESS_TOKEN).toBe("alice-token");
		expect(bob.spec.env?.MCP_ACCESS_TOKEN).toBe("bob-token");
		expect(names(opened.double.userTools.get("alice"))).toContain("acme/getenv");
		expect(names(opened.double.userTools.get("bob"))).toContain("acme/getenv");
		const aliceResult = await tool(opened.double.userTools.get("alice")!, "acme/getenv").execute(
			{ name: "MCP_ACCESS_TOKEN" }, api(aliceEvent.id), CONTEXT,
		);
		const bobResult = await tool(opened.double.userTools.get("bob")!, "acme/getenv").execute(
			{ name: "MCP_ACCESS_TOKEN" }, api(bobEvent.id), CONTEXT,
		);
		expect(aliceResult.output).toEqual([{ type: "text", text: "alice-token" }]);
		expect(bobResult.output).toEqual([{ type: "text", text: "bob-token" }]);
		const aliceSection = await section(opened, aliceEvent.id);
		expect(aliceSection).toContain("acme");
		expect(aliceSection).not.toContain("bob");
		expect(JSON.stringify(bobResult)).not.toContain("alice-token");
	} finally {
		await opened.close();
	}
});

test("shared users allowlist gates calls and the caller's prompt section", async () => {
	const opened = await openCatalog({
		acme: shared({ users: ["alice"] }),
	});
	try {
		await opened.wiring.ready;
		const bobEvent = event(opened, "bob");
		const aliceEvent = event(opened, "alice");
		opened.double.setSettings("alice", { acme: true });
		const registered = opened.wiring.extension.tools ?? [];
		const result = await tool(registered, "acme/echo").execute(
			{ name: "bob" }, api(bobEvent.id), CONTEXT,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toEqual([
			{ type: "text", text: expect.stringMatching(/not available/) },
		]);
		expect(await section(opened, bobEvent.id)).toBeUndefined();
		expect(await section(opened, aliceEvent.id)).toContain("- acme:");
	} finally {
		await opened.close();
	}
});

test("shared tools reject an unidentified owner instead of lending authority", async () => {
	const opened = await openCatalog({ acme: shared() });
	try {
		await opened.wiring.ready;
		const result = await tool(opened.wiring.extension.tools ?? [], "acme/echo").execute(
			{ name: "ownerless" }, api("ownerless-run"), CONTEXT,
		);
		expect(result.isError).toBe(true);
	} finally {
		await opened.close();
	}
});

test("remote user connections never inherit configured authorization", async () => {
	const authorization: (string | undefined)[] = [];
	const remote = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
		request.on("end", () => {
			const frame = JSON.parse(body) as { id?: number; method: string };
			authorization.push(request.headers.authorization);
			if (frame.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			const result = frame.method === "initialize"
				? { protocolVersion: "2025-06-18", capabilities: {} }
				: { tools: [] };
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
		});
	});
	await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
	const address = remote.address() as AddressInfo;
	const opened = await openCatalog({
		acme: {
			url: `http://127.0.0.1:${address.port}/mcp`,
			headers: { aUtHoRiZaTiOn: "Bearer configured-token" },
			credentials: "user",
		},
	});
	try {
		await opened.wiring.conversationCreated(event(opened, "alice"));
		expect(authorization).not.toHaveLength(0);
		expect(authorization.every((value) => value === undefined)).toBe(true);
		opened.double.setSecret("bob", "token:acme", "bob-token");
		await opened.wiring.conversationCreated(event(opened, "bob"));
		expect(authorization.at(-1)).toBe("Bearer bob-token");
	} finally {
		await opened.close();
		await new Promise<void>((resolve, reject) => {
			remote.close((error) => error === undefined ? resolve() : reject(error));
		});
	}
});

test("a missing scoped token removes the configured stdio credential", async () => {
	const opened = await openCatalog({
		acme: user({ env: { STUB_ENV_TOOL: "1", MCP_ACCESS_TOKEN: "configured-token" } }),
	});
	try {
		await opened.wiring.conversationCreated(event(opened, "alice"));
		expect(opened.double.launches[0]?.spec.env?.MCP_ACCESS_TOKEN).toBeUndefined();
		const result = await tool(opened.double.userTools.get("alice")!, "acme/getenv").execute(
			{ name: "MCP_ACCESS_TOKEN" }, api("alice-run"), CONTEXT,
		);
		expect(result.output).toEqual([{ type: "text", text: "" }]);
	} finally {
		await opened.close();
	}
});

test("opt-in is off until the user enables it", async () => {
	const opened = await openCatalog({ acme: user({ availability: "opt-in" }) });
	try {
		await opened.wiring.conversationCreated(event(opened, "alice"));
		expect(opened.double.launches).toHaveLength(0);
		expect(names(opened.double.userTools.get("alice"))).toEqual([]);
		await saveCatalogSetting(opened, "alice", "acme", true);
		expect(opened.double.launches).toHaveLength(1);
		expect(names(opened.double.userTools.get("alice"))).toContain("acme/echo");
	} finally {
		await opened.close();
	}
});

test("a flat disable write retires an idle service and unpublishes its tools", async () => {
	const opened = await openCatalog({ acme: user() });
	try {
		await opened.wiring.conversationCreated(event(opened, "alice"));
		expect(names(opened.double.userTools.get("alice"))).toContain("acme/echo");
		await saveCatalogSetting(opened, "alice", "acme", false);
		expect(names(opened.double.userTools.get("alice"))).toEqual([]);
		expect(opened.double.launches[0]?.releases).toBe(1);
	} finally {
		await opened.close();
	}
});

test("disable finishes an in-flight call then unpublishes and releases the service", async () => {
	const opened = await openCatalog({
		acme: user({
			command: process.execPath,
			args: [HANG_SERVER],
			env: { HANG_MODE: "finish" },
		}),
	});
	try {
		await opened.wiring.conversationCreated(event(opened, "alice"));
		const tools = opened.double.userTools.get("alice")!;
		const pending = tool(tools, "acme/hang").execute({}, api("alice-run"), CONTEXT);
		await saveCatalogSetting(opened, "alice", "acme", false);
		expect(names(opened.double.userTools.get("alice"))).toEqual([]);
		expect(opened.double.launches[0]?.releases).toBe(0);
		await expect(pending).resolves.toMatchObject({ isError: false });
		expect(opened.double.launches[0]?.releases).toBe(1);
	} finally {
		await opened.close();
	}
});

test("a failed per-user connection does not stop another user", async () => {
	const opened = await openCatalog({ acme: user() });
	try {
		opened.double.setSettings("alice", { acme: false });
		const realConnect = opened.double.host.services.connect;
		opened.double.host.services.connect = async (name, userName, ctx) => {
			if (userName === "alice") throw new Error("synthetic alice failure");
			return realConnect(name, userName, ctx);
		};
		await expect(
			opened.wiring.runSettled(event(opened, "alice")),
		).resolves.toBeUndefined();
		await expect(
			opened.wiring.runSettled(event(opened, "bob")),
		).resolves.toBeUndefined();
		expect(names(opened.double.userTools.get("bob"))).toContain("acme/echo");
	} finally {
		await opened.close();
	}
});

test("the settings surface declares flat toggles and shared-authority help", async () => {
	const opened = await openCatalog({
		acme: user({ availability: "opt-in" }),
		shared: shared({ sharedAuthority: "Synthetic shared test authority." }),
	});
	try {
		expect(opened.wiring.surfaces.settings).toHaveLength(1);
		expect("settingsSections" in opened.wiring).toBe(false);
		const definition = opened.wiring.surfaces.settings[0];
		expect(definition.scope).toBe("user");
		expect(definition.form).toMatchObject({
			root: {
				children: [
					expect.objectContaining({ name: "acme", default: false }),
					expect.objectContaining({
						name: "shared",
						default: true,
						help: expect.stringContaining("Synthetic shared test authority"),
					}),
				],
			},
		});
		const sharedToggle = (definition.form.root.children as { help?: string }[])
			.find((child) => child.help !== undefined);
		expect(sharedToggle?.help).toBe(
			"Synthetic shared test authority. Shared MCP servers hand every permitted user's agent the admin's credential for that service.",
		);
		for (const child of definition.form.root.children as { name?: string }[]) {
			expect(child.name).not.toMatch(/[./]/);
		}
	} finally {
		await opened.close();
	}
});
