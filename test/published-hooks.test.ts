/**
 * The `mcp.servers` published hook (settings rework, Task 11): codemode's
 * namespace source. Read fresh from settings on every call, so a settings
 * change needs no restart.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { Compile } from "typebox/compile";
import type { PublishedHookCall } from "@sigrun/sigrun/extension";
import { createMcpExtension, MCP_SERVERS_HOOK } from "../src/extension.js";
import { createCatalogHost, type CatalogHostDouble } from "./catalog-host.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

const CALL: PublishedHookCall = {
	caller: "codemode",
	user: undefined,
	conversationId: undefined,
	abortSignal: undefined,
};

async function open(servers: Record<string, unknown>): Promise<{
	double: CatalogHostDouble;
	run(): Promise<{ servers: Record<string, unknown>[] }>;
}> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-mcp-servers-hook-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const double = createCatalogHost();
	cleanups.push(() => double.close());
	double.setSharedSettings({
		servers: Object.fromEntries(
			Object.entries(servers).map(([name, server]) => [
				name,
				{ transport: "url" in (server as object) ? "url" : "command", ...(server as object) },
			]),
		),
	});
	const wiring = await createMcpExtension(double.host);
	cleanups.push(() => wiring.close());
	const hook = wiring.publishedHooks.find((candidate) => candidate.name === MCP_SERVERS_HOOK);
	if (hook === undefined) throw new Error(`missing ${MCP_SERVERS_HOOK} hook`);
	return {
		double,
		run: async () =>
			(await hook.run({}, CALL)) as { servers: Record<string, unknown>[] },
	};
}

describe("the mcp.servers hook", () => {
	test("lists servers with resolved enabled and exposure", async () => {
		const opened = await open({
			acme: {
				url: "https://acme.example.invalid/mcp",
				exposure: "deferred",
				toolExposure: { "danger*": "hidden" },
			},
			off: { command: "node", args: [], enabled: false },
			plain: { command: "node", args: [] },
		});
		const result = await opened.run();
		expect(result.servers).toEqual([
			{
				name: "acme",
				enabled: true,
				exposure: "deferred",
				toolExposure: { "danger*": "hidden" },
			},
			{ name: "off", enabled: false, exposure: "codemode", toolExposure: {} },
			{ name: "plain", enabled: true, exposure: "codemode", toolExposure: {} },
		]);
	});

	test("mcp.servers reflects a settings change without restart", async () => {
		const opened = await open({
			acme: { url: "https://acme.example.invalid/mcp" },
		});
		expect((await opened.run()).servers).toHaveLength(1);

		// The operator edits settings: a new server appears and acme flips off.
		opened.double.setSharedSettings({
			servers: {
				acme: { transport: "url", url: "https://acme.example.invalid/mcp", enabled: false },
				added: { transport: "url", url: "https://added.example.invalid/mcp", exposure: "direct" },
			},
		});
		const result = await opened.run();
		expect(result.servers).toEqual([
			{ name: "acme", enabled: false, exposure: "codemode", toolExposure: {} },
			{ name: "added", enabled: true, exposure: "direct", toolExposure: {} },
		]);
	});

	test("the hook's declared input and output schemas compile and validate the wire shapes", async () => {
		const opened = await open({});
		const result = await opened.run();
		// The registry validates against these same TypeBox schemas; prove the
		// produced shape checks (a drift between run() and output fails here).
		const wiring = await createMcpExtension(opened.double.host);
		cleanups.push(() => wiring.close());
		const hook = wiring.publishedHooks.find((candidate) => candidate.name === MCP_SERVERS_HOOK)!;
		expect(Compile(hook.input).Check({})).toBe(true);
		expect(Compile(hook.output!).Check(result)).toBe(true);
		expect(
			Compile(hook.output!).Check({ servers: [{ name: "x", enabled: true }] }),
		).toBe(false);
	});
});
