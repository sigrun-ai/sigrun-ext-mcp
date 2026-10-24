import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { connectMcpServer } from "../src/client.js";
import { MCP_CONFIG_ENV } from "../src/config.js";
import { serverSpawnEnv } from "../src/spawn-env.js";
import { storeMcpToken } from "../src/tokens.js";

const STUB_SERVER = join(import.meta.dirname, "stub-mcp-server.mjs");

/** Stand-ins for SIGRUN_API_TOKEN and a provider key in sigrun's env. */
const SECRETS = {
	SIGRUN_LEAK_PROBE: "sigrun-secret-probe",
	ACME_PROVIDER_API_KEY: "provider-secret-probe",
};

test("stdio servers get the allowlist and their config env, never sigrun's secrets", () => {
	const env = serverSpawnEnv(
		"stub",
		{ env: { OWN: "yes", PATH: "/opt/stub/bin" } },
		{ ...SECRETS, PATH: "/usr/bin", LC_ALL: "C.UTF-8", HOME: "/home/acme" },
	);
	expect(env).toEqual({
		PATH: "/opt/stub/bin",
		LC_ALL: "C.UTF-8",
		HOME: "/home/acme",
		OWN: "yes",
	});
});

test("a stored token is still injected, and the config-dir variable used to find it is not", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-mcp-spawn-env-"));
	try {
		const source = { ...SECRETS, PATH: "/usr/bin", [MCP_CONFIG_ENV]: join(dir, "mcp.json") };
		storeMcpToken(
			"stub",
			{ access_token: "tok-123", token_type: "Bearer", obtained_at: 1 },
			source,
		);
		const env = serverSpawnEnv(
			"stub",
			{
				oauth: {
					clientId: "acme-client",
					authorizeUrl: "https://as.example.invalid/authorize",
					tokenUrl: "https://as.example.invalid/token",
				},
			},
			source,
		);
		expect(env).toEqual({ PATH: "/usr/bin", MCP_ACCESS_TOKEN: "tok-123" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a spawned server cannot read sigrun's environment", async () => {
	Object.assign(process.env, SECRETS);
	try {
		const client = await connectMcpServer("stub", {
			command: process.execPath,
			args: [STUB_SERVER],
			env: { STUB_ENV_TOOL: "1" },
		});
		try {
			const read = async (name: string) =>
				(await client.callTool("getenv", { name })).content?.[0]?.text;
			expect(await read("SIGRUN_LEAK_PROBE")).toBe("");
			expect(await read("ACME_PROVIDER_API_KEY")).toBe("");
			expect(await read("PATH")).not.toBe("");
		} finally {
			client.close();
		}
	} finally {
		for (const key of Object.keys(SECRETS)) delete process.env[key];
	}
});
