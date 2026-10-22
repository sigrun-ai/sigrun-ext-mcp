/**
 * End-to-end tests (the testable line): an MCP server connects, its tools
 * appear in the harness, and a tool call through the MCP server works
 * end-to-end. Runs a REAL pi-durable Harness (registry + faux provider),
 * mirroring the other sigrun extension test harnesses — no sigrun-core dependency.
 *
 * Also covers per-server isolation (a bad server entry quarantines alone),
 * close() lifecycle (children torn down), and the per-request timeout with
 * progress-notification reset (spec slice 3's client work).
 */

import { expect, test } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { connectMcpServer } from "../src/client.js";
import { MCP_CONFIG_ENV } from "../src/config.js";
import { createMcpExtension } from "../src/extension.js";
import {
	cleanupDir,
	openMcpHarness,
	stubConfigPath,
	tempDir,
	writeConfig,
} from "./harness.js";

const STUB_SERVER = join(import.meta.dirname, "stub-mcp-server.mjs");
const HANG_SERVER = join(import.meta.dirname, "stub-hang-server.mjs");

test("a stub MCP server connects, its tools appear, and a tool call works end-to-end", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-mcp-"));
	try {
		await writeConfig(stubConfigPath(dir), {
			// "direct": this test drives the tool call through the MODEL (the
			// faux provider emits stub/echo), so the server must be
			// model-offered. The default-flip matrix (codemode-by-default) is
			// covered in exposure.test.ts.
			stub: {
				command: process.execPath,
				args: [STUB_SERVER],
				exposure: "direct",
			},
		});
		const opened = await openMcpHarness(dir, [
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
			const tools = opened.registry
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
			opened.wiring.close();
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
		const opened = await openMcpHarness(dir, [
			fauxAssistantMessage("no tools needed"),
		]);
		try {
			// The broken server quarantined alone; the stub's tools are there.
			const tools = opened.registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool.name);
			expect(tools).toContain("stub/echo");
			expect(tools).not.toContain("broken/anything");
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
			opened.wiring.close();
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
		// An intentional close is a shutdown, not a failure: every later
		// call rejects with the close error, never a protocol error.
		await expect(client.listTools()).rejects.toThrow(/closed/);
		client.close(); // idempotent
	}
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

test("a tools/call that never answers REJECTS at the per-request deadline (config timeout)", async () => {
	const dir = await tempDir("sigrun-mcp-timeout-");
	try {
		await writeConfig(stubConfigPath(dir), {
			hang: {
				command: process.execPath,
				args: [HANG_SERVER],
				env: { HANG_MODE: "silent" },
				// A sub-second deadline keeps the test fast while proving the
				// machinery (default 60s would make the suite crawl).
				timeout: 0.3,
			},
		});
		const opened = await openMcpHarness(dir, [
			fauxAssistantMessage("no tools needed"),
		]);
		try {
			const root = await opened.harness.root(BACKGROUND_CONTEXT, {});
			const agent = await root.agent(BACKGROUND_CONTEXT);
			// The hang server's tool registered normally (direct exposure not
			// needed here — call it through the raw client below).
			const hangTool = agent.callable.find(
				(tool) => tool.name === "hang/hang",
			);
			expect(hangTool).toBeDefined();
			const started = Date.now();
			await expect(
				hangTool!.execute({}, { registry: opened.registry.snapshot() } as never, BACKGROUND_CONTEXT),
			).rejects.toThrow(/timed out after 0\.3s/);
			// The deadline actually governed: not instant, not the default 60s.
			const elapsed = Date.now() - started;
			expect(elapsed).toBeGreaterThanOrEqual(250);
			expect(elapsed).toBeLessThan(5000);
		} finally {
			await opened.harness.close(BACKGROUND_CONTEXT);
			opened.wiring.close();
		}
	} finally {
		await cleanupDir(dir);
	}
});

test("progress notifications RESET the deadline: a working server is never killed", async () => {
	const client = await connectMcpServer("hang", {
		command: process.execPath,
		args: [HANG_SERVER],
		env: { HANG_MODE: "progress" },
	});
	try {
		// A 0.5s deadline that the server's 100ms progress ticks keep
		// resetting: 1.5s of wall clock later the call is STILL pending —
		// the reset path works (a hard 0.5s deadline would have rejected).
		const pending = client.callTool("hang", {}, 0.5);
		const swallowed = pending.catch(() => undefined); // never rejects here
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const state = await Promise.race([
			pending.then(() => "settled"),
			swallowed.then(() => "settled"),
			new Promise((resolve) => setTimeout(() => resolve("pending"), 0)),
		]);
		expect(state).toBe("pending");
		// …but when the ticks STOP, the deadline fires: close the server's
		// input so progress stops, or simpler — a silent mode call still
		// times out (covered above); here just confirm the timer discipline:
		// after 1.5s of resets the promise never rejected.
	} finally {
		client.close();
	}
});