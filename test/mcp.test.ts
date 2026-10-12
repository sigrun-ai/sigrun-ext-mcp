/**
 * End-to-end tests (the testable line): an MCP server connects, its tools
 * appear in the harness, and a tool call through the MCP server works
 * end-to-end. Runs a REAL pi-durable Harness (registry + faux provider),
 * mirroring sigrun-ext-approvals' test harness — no sigrun-core dependency.
 *
 * Also covers per-server isolation (a bad server entry quarantines alone)
 * and close() lifecycle (children torn down).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	Harness,
	type ModelRef,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { connectMcpServer } from "../src/client.js";
import { MCP_CONFIG_ENV } from "../src/config.js";
import { createMcpExtension } from "../src/extension.js";

const STUB_SERVER = join(import.meta.dirname, "stub-mcp-server.mjs");

/** Configure the factory's config store via the env override. */
function stubConfigPath(dir: string): string {
	return join(dir, "mcp.json");
}

async function writeConfig(
	path: string,
	servers: Record<string, unknown>,
): Promise<void> {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(path, JSON.stringify({ servers }), "utf8");
}

interface Opened {
	readonly harness: Harness;
	readonly defaultModel: ModelRef;
}

/** Open a real pi-durable harness with the MCP extension installed. */
async function openMcpHarness(
	dir: string,
	responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
): Promise<{
	readonly opened: Opened;
	readonly wiring: Awaited<ReturnType<typeof createMcpExtension>>;
	readonly registry: ReturnType<typeof createRegistry>;
}> {
	const prior = process.env[MCP_CONFIG_ENV];
	process.env[MCP_CONFIG_ENV] = stubConfigPath(dir);
	let wiring: Awaited<ReturnType<typeof createMcpExtension>>;
	try {
		wiring = createMcpExtension();
	} finally {
		if (prior === undefined) delete process.env[MCP_CONFIG_ENV];
		else process.env[MCP_CONFIG_ENV] = prior;
	}
	await wiring.ready; // tools present before the registry snapshot read

	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const defaultModel: ModelRef = { provider: "faux", modelId: "m" };

	const registry = createRegistry();
	registry.install(wiring.extension);

	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dir, "sigrun.db")),
		{ models, registry },
		BACKGROUND_CONTEXT,
	);
	harness.resume();
	return { opened: { harness, defaultModel }, wiring, registry };
}

test("a stub MCP server connects, its tools appear, and a tool call works end-to-end", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-mcp-"));
	try {
		await writeConfig(stubConfigPath(dir), {
			stub: { command: process.execPath, args: [STUB_SERVER] },
		});
		const { opened, wiring, registry } = await openMcpHarness(dir, [
			fauxAssistantMessage(
				fauxToolCall(
					"stub/echo",
					{ name: "sigruNN" },
					{ id: "call-1" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done after echo"),
		]);
		try {
			// Its tools appear in the harness registry.
			const tools = registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool.name);
			expect(tools).toContain("stub/echo");
			expect(tools).toContain("stub/add");

			// A tools/call round-trip works end-to-end through the harness:
			// the model emits stub/echo, the extension bridges to the MCP
			// server, and the result flows back into the transcript.
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {
				agent: { model: opened.defaultModel },
			});
			const submission = await root.submit(
				{ type: "input", content: "greet" },
				BACKGROUND_CONTEXT,
			);
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			expect(settled.status).toBe("done");
			await root.waitForIdle(BACKGROUND_CONTEXT);
			const page = await root.entries({}, 50, undefined, BACKGROUND_CONTEXT);
			const transcript = JSON.stringify(page.items);
			expect(transcript).toContain("hello, sigruNN");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
			wiring.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a bad server entry is isolated per-server (the healthy server still serves tools)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-mcp-"));
	try {
		await writeConfig(stubConfigPath(dir), {
			broken: {
				command: "/nonexistent/sigrun-mcp-bad-server",
				args: [],
			},
			stub: { command: process.execPath, args: [STUB_SERVER] },
		});
		const { opened, wiring, registry } = await openMcpHarness(dir, [
			fauxAssistantMessage("no tools needed"),
		]);
		try {
			// The broken server quarantined alone; the stub's tools are there.
			const tools = registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool.name);
			expect(tools).toContain("stub/echo");
			expect(tools).not.toContain("broken/anything");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
			wiring.close();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a tools/call round-trip through the raw client resolves the result", async () => {
	const client = await connectMcpServer("stub", {
		command: process.execPath,
		args: [STUB_SERVER],
	});
	try {
		const tools = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(["echo", "add"]);
		const result = await client.callTool("add", { a: 2, b: 40 });
		expect(result.content?.[0]?.text).toBe("42");
		// An unknown tool is a JSON-RPC error: the call REJECTS (never a silent
		// undefined result).
		await expect(client.callTool("nope", {})).rejects.toThrow(
			/unknown tool: nope/,
		);
	} finally {
		client.close();
	}
	// close() tears the child down cleanly: exited() resolves with no error
	// (an intentional close is a shutdown, not a failure).
	expect(await client.exited()).toBeUndefined();
});

test("malformed config throws a clear error from the factory (quarantine semantics)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-mcp-"));
	try {
		const { writeFile } = await import("node:fs/promises");
		const path = join(dir, "mcp.json");
		await writeFile(path, "{ malformed", "utf8");
		const prior = process.env[MCP_CONFIG_ENV];
		process.env[MCP_CONFIG_ENV] = path;
		try {
			expect(() => createMcpExtension()).toThrow(/not valid JSON/);
		} finally {
			if (prior === undefined) delete process.env[MCP_CONFIG_ENV];
			else process.env[MCP_CONFIG_ENV] = prior;
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});