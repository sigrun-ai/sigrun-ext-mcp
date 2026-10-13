/**
 * The exposure matrix (spec slice 3 testables, corrected-set assertions):
 * a server's `exposure` (default "codemode") and per-tool `toolExposure`
 * overrides decide HOW each discovered tool registers under pi-durable 1.2.0
 * semantics:
 *
 *   codemode → `callers: ["tools"]`: in `agent.callable`, ABSENT from
 *              `agent.tools`, and NEVER in `agent.deferred` (callers-gated
 *              tools are not model-calleable, so they cannot be deferred).
 *   deferred  → `deferred: true`: in `agent.deferred` (loadable via
 *              tool_search) and `agent.callable`, absent from `agent.tools`
 *              until loaded.
 *   direct    → normal registration: in `agent.tools` and `agent.callable`.
 *   hidden    → NOT registered at all.
 *
 * The `codemode-deferred` alias resolves to codemode. Assertions target
 * `agent.callable` / `agent.tools` / `agent.deferred` name sets (the rev 3
 * correction: never use `agent.deferred` for codemode-exposed tools).
 */

import { expect, test } from "vitest";
import {
	cleanupDir,
	openMcpHarness,
	stubConfigPath,
	tempDir,
	writeConfig,
} from "./harness.js";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	parseMcpConfig,
	resolveToolExposure,
	DEFAULT_EXPOSURE,
} from "../src/config.js";

const STUB_SERVER = join(import.meta.dirname, "stub-mcp-server.mjs");

function stubServer(): { command: string; args: string[] } {
	return { command: process.execPath, args: [STUB_SERVER] };
}

/** One server entry: the stub command plus exposure config. */
function server(
	fields: Record<string, unknown> = {},
): Record<string, unknown> {
	return { ...stubServer(), ...fields };
}

/** Sorted tool-name set of an agent tool list. */
function namesOf(
	tools: readonly { readonly name: string }[],
): string[] {
	return tools.map((tool) => tool.name).sort();
}

test("the exposure matrix: default/codemode/deferred/direct/hidden/alias + per-tool overrides", async () => {
	const dir = await tempDir("sigrun-mcp-exposure-");
	try {
		await writeConfig(stubConfigPath(dir), {
			// Default exposure (codemode): callable, never offered, never deferred.
			dflt: server(),
			// Direct: model-offered.
			dir: server({ exposure: "direct" }),
			// Deferred: in agent.deferred until tool_search loads it.
			def: server({ exposure: "deferred" }),
			// Hidden: registers nothing.
			hid: server({ exposure: "hidden" }),
			// Per-tool overrides: exact "echo" wins over the "*" pattern;
			// everything else falls to the pattern (deferred), not the
			// server default (direct).
			mix: server({
				exposure: "direct",
				toolExposure: { "*": "deferred", echo: "hidden" },
			}),
			// The pi-compat alias resolves to codemode.
			alias: server({ exposure: "codemode-deferred" }),
		});
		const { harness, wiring, registry } = await openMcpHarness(dir);
		try {
			const root = await harness.root(BACKGROUND_CONTEXT, {});
			const agent = await root.agent(BACKGROUND_CONTEXT);

			// Model-offered set: only the direct registrations.
			expect(namesOf(agent.tools)).toEqual(["dir/add", "dir/echo"]);

			// Tools-callable set: every registered tool (scripts resolve
			// among these); hidden registrations are absent everywhere.
			expect(namesOf(agent.callable)).toEqual([
				"alias/add",
				"alias/echo",
				"def/add",
				"def/echo",
				"dflt/add",
				"dflt/echo",
				"dir/add",
				"dir/echo",
				"mix/add",
			]);

			// Deferred set: exactly the deferred registrations — codemode
			// and alias tools NEVER appear here (callers-gated tools are
			// not model-calleable, so they cannot be deferred).
			expect(namesOf(agent.deferred)).toEqual([
				"def/add",
				"def/echo",
				"mix/add",
			]);

			// Hidden registers nothing at the registry level either.
			const registered = registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool.name)
				.sort();
			expect(registered).not.toContain("hid/echo");
			expect(registered).not.toContain("hid/add");
			expect(registered).not.toContain("mix/echo");
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
			wiring.close();
		}
	} finally {
		await cleanupDir(dir);
	}
});

test("resolveToolExposure: exact name over patterns, first matching pattern wins, default codemode", () => {
	const config = parseMcpConfig(
		JSON.stringify({
			servers: {
				s: {
					command: "node",
					args: [],
					toolExposure: {
						"*-x": "deferred", // first pattern: wins for -x names
						"get-*": "codemode", // later pattern: loses ties
						"get-list": "direct", // exact beats both patterns
						other: "hidden", // exact for a different tool
					},
				},
			},
		}),
		"/x/mcp.json",
	);
	const serverConfig = config.servers.s!;
	// Exact name wins over every pattern.
	expect(resolveToolExposure(serverConfig, "get-list")).toBe("direct");
	// First MATCHING pattern wins when several match.
	expect(resolveToolExposure(serverConfig, "get-x")).toBe("deferred");
	// A name the earlier pattern misses falls to the later one alone.
	expect(resolveToolExposure(serverConfig, "get-other")).toBe("codemode");
	// No override matches: the server default (codemode).
	expect(resolveToolExposure(serverConfig, "set-flag")).toBe("codemode");
	expect(resolveToolExposure(serverConfig, "other")).toBe("hidden");
	// A server without overrides: the DEFAULT_EXPOSURE constant.
	const bare = parseMcpConfig(
		'{"servers": {"b": {"command": "node", "args": []}}}',
		"/x/mcp.json",
	).servers.b!;
	expect(resolveToolExposure(bare, "anything")).toBe(DEFAULT_EXPOSURE);
	expect(DEFAULT_EXPOSURE).toBe("codemode");
});

test("exposure schema validation fails loud on bad values", () => {
	const base = (fields: object) =>
		JSON.stringify({
			servers: { s: { command: "node", args: [], ...fields } },
		});
	expect(() => parseMcpConfig(base({ exposure: "offerred" }), "/x")).toThrow(
		/exposure must be one of/,
	);
	expect(() =>
		parseMcpConfig(base({ toolExposure: { t: "nope" } }), "/x"),
	).toThrow(/exposure must be one of/);
	expect(() =>
		parseMcpConfig(base({ toolExposure: "direct" }), "/x"),
	).toThrow(/toolExposure must be an object/);
	expect(() => parseMcpConfig(base({ enabled: "yes" }), "/x")).toThrow(
		/enabled must be a boolean/,
	);
	expect(() => parseMcpConfig(base({ timeout: 0 }), "/x")).toThrow(
		/timeout must be a positive number of seconds/,
	);
	expect(() => parseMcpConfig(base({ timeout: -5 }), "/x")).toThrow(
		/timeout must be a positive/,
	);
	expect(() => parseMcpConfig(base({ timeout: "60" }), "/x")).toThrow(
		/timeout must be a positive/,
	);
	// enabled/disabled contradictions are config lies: fail loud.
	expect(() =>
		parseMcpConfig(base({ enabled: true, disabled: true }), "/x"),
	).toThrow(/enabled and disabled contradict/);
	expect(() =>
		parseMcpConfig(base({ enabled: false, disabled: false }), "/x"),
	).toThrow(/enabled and disabled contradict/);
	// The alias normalizes to codemode at parse time.
	const parsed = parseMcpConfig(
		base({ exposure: "codemode-deferred", timeout: 1.5 }),
		"/x",
	);
	expect(parsed.servers.s?.exposure).toBe("codemode");
	expect(parsed.servers.s?.timeout).toBe(1.5);
	expect(parsed.servers.s?.enabled).toBeUndefined();
});

test("enabled: false skips the server entirely (same as disabled)", async () => {
	const dir = await tempDir("sigrun-mcp-disabled-");
	try {
		await writeConfig(stubConfigPath(dir), {
			off: server({ enabled: false }),
			on: server({}),
		});
		const { harness, wiring, registry } = await openMcpHarness(dir);
		try {
			const registered = registry
				.snapshot()
				.tools()
				.map(({ tool }) => tool.name)
				.sort();
			expect(registered).toEqual(["on/add", "on/echo"]);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
			wiring.close();
		}
	} finally {
		await cleanupDir(dir);
	}
});
