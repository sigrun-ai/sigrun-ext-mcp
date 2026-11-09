/**
 * The MCP settings schema (settings rework, Task 11): drawable proof, the
 * defaults the checked read applies, and the legacy-alias folding the
 * settings parser performs (the `disabled` alias and pi's
 * `codemode-deferred` exposure word).
 */
import { describe, expect, test } from "vitest";
import {
	assertDrawable,
	checkStoredSettings,
	generateForm,
} from "@sigrun/sigrun/settings-schema";
import {
	MCP_SETTINGS_JSON_SCHEMA,
	MCP_USER_JSON_SCHEMA,
} from "../src/settings-schema.js";
import { parseMcpSettings } from "../src/config.js";

describe("MCP settings schema", () => {
	test("schema is drawable", () => {
		assertDrawable(MCP_SETTINGS_JSON_SCHEMA);
		assertDrawable(MCP_USER_JSON_SCHEMA);
	});

	test("a stored URL server row keeps every field in the generated table value shape", () => {
		const generated = generateForm(MCP_SETTINGS_JSON_SCHEMA, { idPrefix: "test" });
		const root = generated.form.root as unknown as { children: Record<string, unknown>[] };
		const servers = root.children.find((field) => field.name === "servers") as unknown as {
			item: ({ name?: string; type: string } | { type: string; children: unknown[] })[];
		};
		const itemNames = servers.item.flatMap((field) =>
			"name" in field && typeof field.name === "string" ? [field.name] : [],
		);
		expect(itemNames).toEqual(expect.arrayContaining([
			"transport", "url", "headers", "command", "args", "env",
		]));
		expect(servers.item.some(
			(field) => field.type === "section" && "title" in field && field.title === "OAuth",
		)).toBe(true);
		// The flattened row is what the entries channel binds. An opened
		// stored row submits all its fields plus its saved identity; it is not
		// collapsed into a synthetic `value` variant arm.
		const submitted = {
			transport: "url",
			url: "https://acme.example.invalid/mcp",
			headers: { Authorization: "" },
			enabled: true,
			$from: "acme",
		};
		expect(submitted).toMatchObject({
			url: "https://acme.example.invalid/mcp",
			headers: { Authorization: "" },
			$from: "acme",
		});
		const { $from: _from, ...entry } = submitted;
		const checked = checkStoredSettings(MCP_SETTINGS_JSON_SCHEMA, {
			servers: { acme: entry },
		});
		expect(checked.repairs).toEqual([]);
	});

	test("the user-settings form draws the flat server toggles as a table", () => {
		const generated = generateForm(MCP_USER_JSON_SCHEMA, { idPrefix: "test-user" });
		const table = (generated.form.root as unknown as { children: Record<string, unknown>[] }).children
			.find((field) => field.name === "") as unknown as {
				type: string;
				shape: string;
				item: { type: string; name: string }[];
			};
		expect(table).toMatchObject({
			type: "entries",
			shape: "table",
			item: [{ type: "toggle", name: "value" }],
		});
		// A stored flat toggle is data for that table, not an unknown key.
		const stored = { servers: {}, acme: true };
		expect(checkStoredSettings(MCP_USER_JSON_SCHEMA, stored).value).toMatchObject({
			acme: true,
		});
	});

	test("defaults: no servers, userServers none, entries enabled and codemode", () => {
		const checked = checkStoredSettings(MCP_SETTINGS_JSON_SCHEMA, {
			servers: {
				acme: { transport: "url", url: "https://acme.example.invalid/mcp" },
			},
		});
		const acme = (checked.value.servers as Record<string, Record<string, unknown>>).acme;
		expect(acme.enabled).toBe(true);
		expect(acme.credentials).toBe("user");
		expect(acme.exposure).toBe("codemode");
		expect(checked.value.userServers).toBe("none");
	});

	test("the user schema checks the existing flat per-server toggles", () => {
		const checked = checkStoredSettings(MCP_USER_JSON_SCHEMA, {
			servers: {},
			acme: true,
			other: false,
			broken: "yes",
		});
		expect(checked.value.acme).toBe(true);
		expect(checked.value.other).toBe(false);
		expect(checked.value.broken).toBeUndefined();
		expect(checked.repairs.some((repair) => repair.path === "/broken")).toBe(true);
	});

	test("a wrong-typed stored value is dropped to its default", () => {
		const checked = checkStoredSettings(MCP_SETTINGS_JSON_SCHEMA, {
			userServers: "everything",
			servers: {
				acme: { transport: "url", url: "https://acme.example.invalid/mcp", enabled: "yes" },
			},
		});
		expect(checked.value.userServers).toBe("none");
		const acme = (checked.value.servers as Record<string, Record<string, unknown>>).acme;
		expect(acme.enabled).toBe(true);
	});

	test("parseMcpSettings reads the checked object (transport inferred when absent)", () => {
		const config = parseMcpSettings({
			servers: {
				acme: { url: "https://acme.example.invalid/mcp" },
				local: { command: "node", args: ["server.mjs"] },
			},
			userServers: "remote",
		});
		expect(config.userServers).toBe("remote");
		expect("url" in config.servers.acme).toBe(true);
		expect("command" in config.servers.local).toBe(true);
	});

	test("disabled and codemode-deferred aliases normalize on the settings read", () => {
		const config = parseMcpSettings({
			servers: {
				acme: {
					url: "https://acme.example.invalid/mcp",
					disabled: true,
					exposure: "codemode-deferred",
					toolExposure: { "danger*": "codemode-deferred", ping: "direct" },
				},
				other: {
					command: "node",
					args: [],
					disabled: false,
				},
			},
		});
		// The alias folds: enabled carries the inverse, disabled is gone.
		expect(config.servers.acme.enabled).toBe(false);
		expect(config.servers.acme.disabled).toBeUndefined();
		expect(config.servers.acme.exposure).toBe("codemode");
		expect(config.servers.acme.toolExposure).toEqual({
			"danger*": "codemode",
			ping: "direct",
		});
		expect(config.servers.other.enabled).toBe(true);
		expect(config.servers.other.disabled).toBeUndefined();
	});

	test("an explicit enabled+disabled contradiction stays a config error", () => {
		expect(() =>
			parseMcpSettings({
				servers: {
					acme: {
						url: "https://acme.example.invalid/mcp",
						enabled: true,
						disabled: true,
					},
				},
			}),
		).toThrow(/contradict/);
	});

	test("server name rules survive the settings path", () => {
		for (const name of ["servers", "u_acme", "acme.tools", "acme/tools"]) {
			expect(() =>
				parseMcpSettings({
					servers: { [name]: { url: "https://acme.example.invalid/mcp" } },
				}),
			).toThrow();
		}
	});
});
