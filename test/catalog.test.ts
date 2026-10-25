import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { expect, test } from "vitest";
import type { ConversationId, ToolRegistration } from "@earendil-works/pi-durable";
import { createMcpExtension } from "../src/extension.js";
import { MCP_CONFIG_ENV } from "../src/config.js";
import { createCatalogHost, type CatalogHostDouble } from "./catalog-host.js";
import { cleanupDir, stubConfigPath, tempDir, writeConfig } from "./harness.js";

const STUB_SERVER = join(import.meta.dirname, "stub-mcp-server.mjs");
const HANG_SERVER = join(import.meta.dirname, "stub-hang-server.mjs");
const CONTEXT = BACKGROUND_CONTEXT;

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
				read: undefined,
			} as never,
			CONTEXT,
		),
	);
}

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
		expect(names(opened.double.userTools.get("bob"))).not.toContain("acme@alice");
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
		opened.double.setSettings("alice", { catalog: { acme: true } });
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

test("opt-in is off until the user enables it", async () => {
	const opened = await openCatalog({ acme: user({ availability: "opt-in" }) });
	try {
		await opened.wiring.conversationCreated(event(opened, "alice"));
		expect(opened.double.launches).toHaveLength(0);
		expect(names(opened.double.userTools.get("alice"))).toEqual([]);
		opened.double.setSettings("alice", { catalog: { acme: true } });
		await opened.wiring.onSettingsChanged(["catalog"], "alice");
		expect(opened.double.launches).toHaveLength(1);
		expect(names(opened.double.userTools.get("alice"))).toContain("acme/echo");
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
		opened.double.setSettings("alice", { catalog: { acme: false } });
		await opened.wiring.onSettingsChanged(["catalog"], "alice");
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
		opened.double.setSettings("alice", { catalog: { acme: false } });
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

test("the user settings section declares catalog toggles", async () => {
	const opened = await openCatalog({
		acme: user({ availability: "opt-in" }),
		shared: shared(),
	});
	try {
		expect(opened.wiring.settingsSections).toHaveLength(1);
		const definition = opened.wiring.settingsSections[0];
		expect(definition.scope).toBe("user");
		expect(definition.form).toMatchObject({
			root: {
				children: [
					expect.objectContaining({ name: "catalog.acme", default: false }),
					expect.objectContaining({ name: "catalog.shared", default: true }),
				],
			},
		});
	} finally {
		await opened.close();
	}
});
