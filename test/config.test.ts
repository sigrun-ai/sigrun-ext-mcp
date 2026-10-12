/**
 * Config store tests: resolution order (env override wins), shape
 * validation, and fail-loud malformed-JSON errors (task ruling 2).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
	MCP_CONFIG_ENV,
	parseMcpConfig,
	resolveMcpConfigPath,
} from "../src/config.js";

test("the env override wins over the config dir", () => {
	const fromEnv = resolveMcpConfigPath({
		[MCP_CONFIG_ENV]: "/explicit/mcp.json",
	});
	expect(fromEnv).toBe("/explicit/mcp.json");
	// A relative override resolves against cwd.
	expect(
		resolveMcpConfigPath({ [MCP_CONFIG_ENV]: "rel/mcp.json" }),
	).toBe(join(process.cwd(), "rel/mcp.json"));
	const noEnv = resolveMcpConfigPath({});
	expect(noEnv).toContain(
		join(".config", "sigrun", "mcp.json"),
	);
});

test("malformed JSON throws a clear error naming the source", () => {
	expect(() => parseMcpConfig("{ not json", "/x/mcp.json")).toThrow(
		/mcp config \/x\/mcp\.json is not valid JSON/,
	);
});

test("a missing servers object fails loudly", () => {
	expect(() => parseMcpConfig("{}", "/x/mcp.json")).toThrow(
		/"servers" object/,
	);
	expect(() => parseMcpConfig('{"servers": []}', "/x/mcp.json")).toThrow(
		/"servers" object/,
	);
});

test("a server entry missing command/args fails loudly", () => {
	expect(() =>
		parseMcpConfig('{"servers": {"a": {"args": []}}}', "/x/mcp.json"),
	).toThrow(/server "a" needs a string "command"/);
	expect(() =>
		parseMcpConfig('{"servers": {"a": {"command": "x"}}}', "/x/mcp.json"),
	).toThrow(/needs a string "command" and a string\[\] "args"/);
});

test("a valid config parses with optional fields preserved", () => {
	const config = parseMcpConfig(
		JSON.stringify({
			servers: {
				stub: { command: "node", args: ["s.mjs"], disabled: true },
				withEnv: {
					command: "node",
					args: ["s.mjs"],
					env: { K: "v" },
				},
			},
		}),
		"/x/mcp.json",
	);
	expect(config.servers.stub.command).toBe("node");
	expect(config.servers.stub.disabled).toBe(true);
	expect(config.servers.withEnv.env).toEqual({ K: "v" });
});

test("loadMcpConfig reads the env-override path and tolerates a missing file", async () => {
	const { loadMcpConfig } = await import("../src/config.js");
	const dir = await mkdtemp(join(tmpdir(), "sigrun-mcp-config-"));
	try {
		const path = join(dir, "mcp.json");
		await writeFile(
			path,
			JSON.stringify({
				servers: { stub: { command: "node", args: ["stub.mjs"] } },
			}),
			"utf8",
		);
		const loaded = loadMcpConfig({ [MCP_CONFIG_ENV]: path });
		expect(Object.keys(loaded.servers)).toEqual(["stub"]);
		// A missing file is an empty config, not an error.
		expect(loadMcpConfig({ [MCP_CONFIG_ENV]: join(dir, "absent.json") })).toEqual({
			servers: {},
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});