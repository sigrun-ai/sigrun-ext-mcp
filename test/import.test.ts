/**
 * The one-time mcp.json import (settings rework, Task 11): secrets move
 * to the secrets store, the import runs once, existing settings win, and
 * the legacy spellings normalize.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MCP_CONFIG_ENV } from "../src/config.js";
import { createMcpExtension } from "../src/extension.js";
import { createCatalogHost, type CatalogHostDouble } from "./catalog-host.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function importDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-mcp-import-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function withConfigEnv(path: string): void {
	const prior = process.env[MCP_CONFIG_ENV];
	process.env[MCP_CONFIG_ENV] = path;
	cleanups.push(() => {
		if (prior === undefined) delete process.env[MCP_CONFIG_ENV];
		else process.env[MCP_CONFIG_ENV] = prior;
	});
}

async function openWithImport(
	double: CatalogHostDouble,
): ReturnType<typeof createMcpExtension> {
	const wiring = await createMcpExtension(double.host);
	if (wiring.perUserTools) double.declarePerUserTools();
	cleanups.push(() => wiring.close());
	return wiring;
}

describe("the mcp.json import", () => {
	test("import moves header and env values to secrets", async () => {
		const dir = await importDir();
		const path = join(dir, "mcp.json");
		await writeFile(
			path,
			JSON.stringify({
				servers: {
					remote: {
						url: "https://acme.example.invalid/mcp",
						headers: { Authorization: "Bearer acme-secret", "X-Trace": "trace-1" },
					},
					local: {
						command: "node",
						args: ["server.mjs"],
						env: { ACME_KEY: "env-secret" },
					},
				},
			}),
			"utf8",
		);
		withConfigEnv(path);
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		const wiring = await openWithImport(double);
		expect(await wiring.imported).toBe(2);

		const settings = await double.host.stores.settings.get();
		const servers = settings.servers as Record<string, Record<string, unknown>>;
		expect(servers.remote.transport).toBe("url");
		expect(servers.local.transport).toBe("command");
		// The file carries placeholder names, never the values.
		expect(JSON.stringify(settings)).not.toContain("acme-secret");
		expect(JSON.stringify(settings)).not.toContain("env-secret");
		expect(servers.remote.headers).toEqual({ Authorization: "", "X-Trace": "" });
		expect(servers.local.env).toEqual({ ACME_KEY: "" });

		expect(double.shared.secrets.get("servers/remote/headers/Authorization")).toBe(
			"Bearer acme-secret",
		);
		expect(double.shared.secrets.get("servers/remote/headers/X-Trace")).toBe("trace-1");
		expect(double.shared.secrets.get("servers/local/env/ACME_KEY")).toBe("env-secret");

		// One notice to the primary admin, keyed mcp.imported.
		expect(double.shared.notices).toHaveLength(1);
		expect(double.shared.notices[0]).toMatchObject({
			user: "alice",
			key: "mcp.imported",
		});
	});

	test("import runs once", async () => {
		const dir = await importDir();
		const path = join(dir, "mcp.json");
		await writeFile(
			path,
			JSON.stringify({
				servers: { acme: { url: "https://acme.example.invalid/mcp" } },
			}),
			"utf8",
		);
		withConfigEnv(path);
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		const wiring = await openWithImport(double);
		expect(await wiring.imported).toBe(1);
		const stored = await double.host.stores.settings.get();

		// A second factory over the SAME stores (the next boot) must not
		// re-import: settings already carry servers.
		const again = await openWithImport(double);
		expect(await again.imported).toBe(0);
		expect(await double.host.stores.settings.get()).toEqual(stored);
		expect(double.shared.notices).toHaveLength(1);
	});

	test("existing settings win over mcp.json", async () => {
		const dir = await importDir();
		const path = join(dir, "mcp.json");
		await writeFile(
			path,
			JSON.stringify({
				servers: { legacy: { url: "https://legacy.example.invalid/mcp" } },
			}),
			"utf8",
		);
		withConfigEnv(path);
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		double.setSharedSettings({
			servers: { acme: { transport: "url", url: "https://acme.example.invalid/mcp" } },
		});
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const wiring = await openWithImport(double);
		expect(await wiring.imported).toBe(0);
		expect(log).toHaveBeenCalledWith(
			`ignoring ${path}: servers are configured in settings`,
		);
		const settings = await double.host.stores.settings.get();
		expect(Object.keys(settings.servers as Record<string, unknown>)).toEqual(["acme"]);
		expect(double.shared.notices).toHaveLength(0);
	});

	test("disabled and codemode-deferred aliases normalize on import", async () => {
		const dir = await importDir();
		const path = join(dir, "mcp.json");
		await writeFile(
			path,
			JSON.stringify({
				servers: {
					acme: {
						url: "https://acme.example.invalid/mcp",
						disabled: true,
						exposure: "codemode-deferred",
						toolExposure: { "danger*": "codemode-deferred" },
					},
				},
			}),
			"utf8",
		);
		withConfigEnv(path);
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		const wiring = await openWithImport(double);
		expect(await wiring.imported).toBe(1);
		const settings = await double.host.stores.settings.get();
		const acme = (settings.servers as Record<string, Record<string, unknown>>).acme;
		expect(acme.enabled).toBe(false);
		expect(acme.disabled).toBeUndefined();
		expect(acme.exposure).toBe("codemode");
		expect(acme.toolExposure).toEqual({ "danger*": "codemode" });
	});

	test("a malformed mcp.json leaves settings untouched and never notices", async () => {
		const dir = await importDir();
		const path = join(dir, "mcp.json");
		await writeFile(path, "{ not json", "utf8");
		withConfigEnv(path);
		const double = createCatalogHost();
		cleanups.push(() => double.close());
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const wiring = await openWithImport(double);
		expect(await wiring.imported).toBe(0);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("mcp import skipped"));
		expect(await double.host.stores.settings.get()).toEqual({});
		expect(double.shared.notices).toHaveLength(0);
	});
});
