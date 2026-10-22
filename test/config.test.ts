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
});

test("SIGRUN_CONFIG_DIR locates mcp.json (the sigrun store root)", () => {
	// The config dir is the SAME root every sigrun store resolves through —
	// a deployment that sets it expects mcp.json beside settings.json.
	expect(
		resolveMcpConfigPath({ SIGRUN_CONFIG_DIR: "/cfg" }),
	).toBe(join("/cfg", "mcp.json"));
	// The explicit MCP override still wins over the config dir.
	expect(
		resolveMcpConfigPath({
			[MCP_CONFIG_ENV]: "/explicit/mcp.json",
			SIGRUN_CONFIG_DIR: "/cfg",
		}),
	).toBe("/explicit/mcp.json");
});

test("no env at all falls back to the home config dir", () => {
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
	const stub = config.servers.stub;
	if (!("command" in stub)) throw new Error("expected stdio stub");
	expect(stub.command).toBe("node");
	expect(stub.disabled).toBe(true);
	const withEnv = config.servers.withEnv;
	if (!("env" in withEnv)) throw new Error("expected stdio withEnv");
	expect(withEnv.env).toEqual({ K: "v" });
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
// ---------------------------------------------------------------------------
// URL servers (streamable HTTP + legacy SSE): the schema half of the
// transport work. A server is EITHER a stdio child (command+args) or a
// remote endpoint (url) — never both, never neither.
// ---------------------------------------------------------------------------

test("a url server parses with the shared optionals preserved", () => {
	const config = parseMcpConfig(
		JSON.stringify({
			servers: {
				search: {
					url: "https://mcp.example.test/mcp",
					headers: { Authorization: "Bearer t" },
					exposure: "direct",
					toolExposure: { search: "direct" },
					timeout: 30,
				},
			},
		}),
		"/x/mcp.json",
	);
	const server = config.servers.search;
	if (!("url" in server)) throw new Error("expected a url server");
	expect(server.url).toBe("https://mcp.example.test/mcp");
	expect(server.headers).toEqual({ Authorization: "Bearer t" });
	expect(server.exposure).toBe("direct");
	expect(server.timeout).toBe(30);
});

test("a stdio server still parses (the union keeps its first arm)", () => {
	const config = parseMcpConfig(
		JSON.stringify({
			servers: { stub: { command: "node", args: ["s.mjs"] } },
		}),
		"/x/mcp.json",
	);
	const server = config.servers.stub;
	if (!("command" in server)) throw new Error("expected a stdio server");
	expect(server.command).toBe("node");
});

test("a server with both url and command fails loud", () => {
	expect(() =>
		parseMcpConfig(
			JSON.stringify({
				servers: {
					a: {
						url: "https://mcp.example.test/mcp",
						command: "node",
						args: [],
					},
				},
			}),
			"/x/mcp.json",
		),
	).toThrow(/server "a" cannot carry both/);
});

test("a server with neither url nor command fails loud", () => {
	expect(() =>
		parseMcpConfig(JSON.stringify({ servers: { a: {} } }), "/x/mcp.json"),
	).toThrow(/server "a" needs either/);
});

test("a url server with a non-http(s) url fails loud", () => {
	expect(() =>
		parseMcpConfig(
			JSON.stringify({
				servers: { a: { url: "ftp://mcp.example.test/x" } },
			}),
			"/x/mcp.json",
		),
	).toThrow(/server "a" url must be an http/);
});

test("a url server with non-string header values fails loud", () => {
	expect(() =>
		parseMcpConfig(
			JSON.stringify({
				servers: {
					a: { url: "https://mcp.example.test/mcp", headers: { k: 7 } },
				},
			}),
			"/x/mcp.json",
		),
	).toThrow(/server "a" headers/);
});
