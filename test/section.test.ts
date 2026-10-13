/**
 * The `mcp_servers` section + gating (spec slice 3, rev 3's corrected
 * warning channel): the section renders per request from live agent state —
 * a codemode/deferred server is LISTED only when its discovery tool
 * (`codemode` / `tool_search`) is model-offered in that request; servers
 * whose tools are unreachable collapse into ONE enable-notice line.
 *
 * The discovery tools here are minimal stand-ins (name + no-op execute): the
 * section gates on `PromptInput.agent.tools` NAMES, so the stand-ins suffice
 * to drive the offered set. The 4KB whole-line-truncation budget mirrors the
 * skills-section precedent (SKILLS_SECTION_LIMIT_BYTES idiom).
 */

import { expect, test } from "vitest";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	cleanupDir,
	openMcpHarness,
	stubConfigPath,
	tempDir,
	writeConfig,
} from "./harness.js";
import {
	MCP_SERVERS_SECTION_KEY,
	MCP_SERVERS_SECTION_LIMIT_BYTES,
	renderMcpServersSection,
} from "../src/section.js";

const STUB_SERVER = join(import.meta.dirname, "stub-mcp-server.mjs");

/** A minimal model-offered stand-in for a discovery tool (codemode /
 * tool_search): the section gates on tool NAMES in `agent.tools`. */
function discoveryTool(name: string) {
	return defineTool({
		name,
		description: `${name} stand-in (section gating test)`,
		parameters: Type.Unsafe({ type: "object" } as never),
		replay: "unsafe",
		async execute() {
			return { output: [] };
		},
	});
}

/** Read the section render for the harness's root conversation. */
async function renderSection(
	harness: import("@earendil-works/pi-durable").Harness,
): Promise<string | undefined> {
	const root = await harness.root(BACKGROUND_CONTEXT, {});
	const agent = await root.agent(BACKGROUND_CONTEXT);
	const section = agent.sections.find((s) => s.key === MCP_SERVERS_SECTION_KEY);
	if (section === undefined) return undefined;
	return await Promise.resolve(
		section.render(
			{
				conversationId: root.id,
				agent,
				env: undefined,
				shown: {},
				// `read` is unused by our render; satisfy the type loosely.
				read: undefined as never,
			},
			BACKGROUND_CONTEXT,
		),
	);
}

test("with codemode model-offered, the section lists the codemode server", async () => {
	const dir = await tempDir("sigrun-mcp-section-");
	try {
		await writeConfig(stubConfigPath(dir), {
			stub: { command: process.execPath, args: [STUB_SERVER] }, // default codemode
		});
		// Install a codemode stand-in so the discovery tool is model-offered.
		const opened = await openMcpHarness(dir);
		try {
			opened.registry.install({
				name: "test.codemode-standin",
				tools: [discoveryTool("codemode")],
			});
			const text = await renderSection(opened.harness);
			expect(text).toBeDefined();
			expect(text).toContain("- stub:");
			expect(text).toContain("reachable via codemode scripts");
			// No unreachable servers: no enable-notice.
			expect(text).not.toMatch(/enable codemode\/tool_search/);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
			opened.wiring.close();
		}
	} finally {
		await cleanupDir(dir);
	}
});

test("with the discovery tool NOT offered, no tool listings — just the enable-notice line", async () => {
	const dir = await tempDir("sigrun-mcp-section-");
	try {
		await writeConfig(stubConfigPath(dir), {
			stub: { command: process.execPath, args: [STUB_SERVER] }, // default codemode
		});
		const opened = await openMcpHarness(dir);
		try {
			// No codemode/tool_search installed: the server's tools are
			// unreachable through the offered set.
			const text = await renderSection(opened.harness);
			expect(text).toBeDefined();
			// The notice line, with the server COUNT — and NO tool listings.
			expect(text).toContain(
				"1 server has script-only or deferred tools",
			);
			expect(text).not.toContain("- stub:");
			expect(text).toContain("enable codemode/tool_search");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
			opened.wiring.close();
		}
	} finally {
		await cleanupDir(dir);
	}
});

test("a direct server is not listed (nothing script-only or deferred about it)", async () => {
	const dir = await tempDir("sigrun-mcp-section-");
	try {
		await writeConfig(stubConfigPath(dir), {
			stub: {
				command: process.execPath,
				args: [STUB_SERVER],
				exposure: "direct",
			},
		});
		const opened = await openMcpHarness(dir);
		try {
			// No codemode/deferred tools anywhere: NO section at all.
			const text = await renderSection(opened.harness);
			expect(text).toBeUndefined();
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
			opened.wiring.close();
		}
	} finally {
		await cleanupDir(dir);
	}
});

test("the section budget: 4KB with whole-line truncation, notice included (skills idiom)", () => {
	const entry = (i: number): {
		name: string;
		description: string;
		how: string;
	} => ({
		name: `server-${i}`,
		description: `${"d".repeat(600)} ${i}`,
		how: "codemode scripts",
	});
	// ~600 bytes per line: 4KB fits ~6 whole lines.
	const many = Array.from({ length: 30 }, (_, i) => entry(i));
	const rendered = renderMcpServersSection(many, 0);
	expect(rendered).toBeDefined();
	const bytes = new TextEncoder().encode(rendered!).length;
	expect(bytes).toBeLessThanOrEqual(MCP_SERVERS_SECTION_LIMIT_BYTES);
	expect(rendered).toContain("server list truncated:");
	// Whole-LINE truncation: the last kept line is complete.
	const lines = rendered!.split("\n");
	const lastListed = lines.findLast((line) => line.startsWith("- "));
	expect(lastListed).not.toMatch(/- server-\d+: d+-?\d*$/);
	// The truncated count is honest.
	const keptCount = lines.filter((line) => line.startsWith("- ")).length;
	expect(rendered).toContain(`${30 - keptCount} more not shown`);
	// Zero servers, zero unreachable: no section.
	expect(renderMcpServersSection([], 0)).toBeUndefined();
	// Unreachable-only: the bare notice.
	expect(renderMcpServersSection([], 2)).toBe(
		"(2 servers have script-only or deferred tools; enable codemode/tool_search in Settings → default tools to reach them)",
	);
});