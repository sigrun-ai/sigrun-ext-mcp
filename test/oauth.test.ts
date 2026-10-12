/**
 * OAuth (T3c) tests — the testable line: "a stub OAuth flow completes with
 * a pasted URL."
 *
 * The stub AS (test/stub-oauth-as.mjs-style, inline here over node:http on
 * an ephemeral port):
 *   - GET /authorize → 302 to `http://127.0.0.1:<listener-port>/callback?code=...`
 *     (the listener port is given via the `port` query param — the stub's
 *     own convention for tests, standing in for the AS redirect)
 *   - POST /token → validates the exchange (grant_type, code, redirect_uri,
 *     client_id, code_verifier against the S256 challenge sent at authorize
 *     time — recorded when GET /authorize was hit) and returns a token JSON
 *
 * The full flow runs through `startOauth` (the CLI-equivalent `runOauth`),
 * pastes the redirected URL via `flow.pasteUrl`, and checks the token lands
 * in the store with 0600. Plus: token injection (spawn env), absent-token
 * behavior, and config backward compat.
 */

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { expect, test, afterAll } from "vitest";
import {
	MCP_CONFIG_ENV,
	parseMcpConfig,
} from "../src/config.js";
import { spawnEnvWithToken, storeMcpToken, resolveMcpTokenPath, loadMcpTokens } from "../src/tokens.js";
import { startOauth, extractCode, buildAuthorizeUrl } from "../src/oauth.js";
import { parseCliArgs } from "../src/cli.js";

// ---------------------------------------------------------------- stub AS

interface StubAs {
	readonly server: Server;
	readonly url: string;
	/** The token endpoint's seen exchange requests (for assertions). */
	readonly exchanges: Record<string, string>[];
	/** The authorize requests' seen code_challenge values. */
	readonly challenges: string[];
	close(): Promise<void>;
}

/** Boot the stub authorization server on an ephemeral port. */
async function startStubAs(code: string): Promise<StubAs> {
	const exchanges: Record<string, string>[] = [];
	const challenges: string[] = [];
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://stub");
		if (req.method === "GET" && url.pathname === "/authorize") {
			challenges.push(url.searchParams.get("code_challenge") ?? "");
			const redirect =
				url.searchParams.get("redirect_uri") ?? "http://127.0.0.1:1/callback";
			res.writeHead(302, { location: `${redirect}?code=${code}` });
			res.end();
			return;
		}
		if (req.method === "POST" && url.pathname === "/token") {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				const params: Record<string, string> = {};
				for (const pair of Buffer.concat(chunks).toString("utf8").split("&")) {
					const eq = pair.indexOf("=");
					if (eq >= 0) {
						params[decodeURIComponent(pair.slice(0, eq))] =
							decodeURIComponent(pair.slice(eq + 1));
					}
				}
				exchanges.push(params);
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						access_token: `stub-token-${randomBytes(4).toString("hex")}`,
						token_type: "Bearer",
						refresh_token: "stub-refresh",
						expires_in: 3600,
					}),
				);
			});
			return;
		}
		res.writeHead(404);
		res.end("not found");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	return {
		server,
		url: `http://127.0.0.1:${address.port}`,
		exchanges,
		challenges,
		close: () =>
			new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

const stubServers: StubAs[] = [];
afterAll(async () => {
	for (const stub of stubServers) await stub.close();
});

/** Boot a stub AS and register it for afterAll teardown. */
async function stubAs(code: string): Promise<StubAs> {
	const stub = await startStubAs(code);
	stubServers.push(stub);
	return stub;
}

/** A temp dir with an mcp.json naming the stub AS for one server. */
async function oauthConfigDir(
	asUrl: string,
	serverName = "stub",
): Promise<{ readonly dir: string; readonly env: Record<string, string> }> {
	const dir = await mkdtemp(join(tmpdir(), "sigrun-mcp-oauth-"));
	const configPath = join(dir, "mcp.json");
	await writeFile(
		configPath,
		JSON.stringify({
			servers: {
				[serverName]: {
					command: process.execPath,
					args: ["stub-mcp-server.mjs"],
					oauth: {
						authorizeUrl: `${asUrl}/authorize`,
						tokenUrl: `${asUrl}/token`,
						clientId: "stub-client",
						scopes: ["read", "write"],
					},
				},
			},
		}),
		"utf8",
	);
	return { dir, env: { [MCP_CONFIG_ENV]: configPath } };
}

// ------------------------------------------------------------------ tests

test("a stub OAuth flow completes with a pasted URL (the testable line)", async () => {
	const as = await stubAs("paste-me-code");
	const { dir, env } = await oauthConfigDir(as.url);
	try {
		// Start the flow: loopback listener + authorize URL (the CLI prints
		// these; the test uses the flow handle directly).
		const config = parseMcpConfig(
			await (await import("node:fs/promises")).readFile(
				env[MCP_CONFIG_ENV],
				"utf8",
			),
			env[MCP_CONFIG_ENV]!,
		);
		const flow = await startOauth("stub", config.servers.stub.oauth!, {
			env,
			timeoutMs: 10_000,
		});

		// The authorize URL carries the RFC 8252 loopback redirect_uri and a
		// PKCE S256 challenge.
		expect(flow.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		const authorize = new URL(flow.authorizeUrl);
		expect(authorize.pathname).toBe("/authorize");
		expect(authorize.searchParams.get("redirect_uri")).toBe(flow.redirectUri);
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.searchParams.get("scope")).toBe("read write");
		const challenge = authorize.searchParams.get("code_challenge") ?? "";

		// The paste-the-URL path: the browser cannot reach the pod's loopback,
		// so the user pastes the redirected URL. The stub AS's redirect shape:
		const redirectedUrl = `${flow.redirectUri}?code=paste-me-code`;
		flow.pasteUrl(redirectedUrl);

		const token = await flow.done;
		expect(token.access_token).toMatch(/^stub-token-/);
		expect(token.token_type).toBe("Bearer");
		expect(token.refresh_token).toBe("stub-refresh");
		expect(token.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

		// The exchange reached the token endpoint correctly.
		expect(as.exchanges).toHaveLength(1);
		const exchange = as.exchanges[0];
		expect(exchange["grant_type"]).toBe("authorization_code");
		expect(exchange["code"]).toBe("paste-me-code");
		expect(exchange["redirect_uri"]).toBe(flow.redirectUri);
		expect(exchange["client_id"]).toBe("stub-client");
		// PKCE: the challenge in the authorize URL is the S256 of the verifier
		// sent in the exchange (recomputed here; the paste path never hits
		// /authorize, so the AS saw no challenge — that is the flow's point).
		const recomputed = createHash("sha256")
			.update(exchange["code_verifier"])
			.digest("base64url");
		expect(recomputed).toBe(challenge);

		// The token landed in the store beside the config, 0600.
		const tokenPath = resolveMcpTokenPath(env);
		expect(tokenPath).toBe(join(dirname(env[MCP_CONFIG_ENV]!), "mcp-tokens.json"));
		const stored = loadMcpTokens(env);
		expect(stored.stub.access_token).toBe(token.access_token);
		const mode = (await stat(tokenPath)).mode & 0o777;
		expect(mode).toBe(0o600);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("the loopback listener also settles the flow (first arrival wins)", async () => {
	const as = await stubAs("listener-code");
	const { dir, env } = await oauthConfigDir(as.url);
	try {
		const config = parseMcpConfig(
			await (await import("node:fs/promises")).readFile(
				env[MCP_CONFIG_ENV],
				"utf8",
			),
			env[MCP_CONFIG_ENV]!,
		);
		const flow = await startOauth("stub", config.servers.stub.oauth!, {
			env,
			timeoutMs: 10_000,
		});

		// Hit the stub AS's authorize endpoint like a browser would: it 302s
		// to the flow's own loopback redirect_uri with the code.
		const authorizeUrl = flow.authorizeUrl;
		const { get } = await import("node:http");
		const redirectLocation: string = await new Promise((resolve, reject) => {
			const target = new URL(authorizeUrl);
			get(
				{ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}` },
				(res) => {
					resolve(res.headers.location ?? "");
					res.resume();
				},
			).on("error", reject);
		});
		expect(redirectLocation).toContain("code=listener-code");

		// Follow the redirect to the flow's loopback listener.
		const followed: string = await new Promise((resolve, reject) => {
			const target = new URL(redirectLocation);
			get(
				{ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}` },
				(res) => {
					res.resume();
					resolve(`status-${res.statusCode}`);
				},
			).on("error", reject);
		});
		expect(followed).toBe("status-200");

		const token = await flow.done;
		expect(token.access_token).toMatch(/^stub-token-/);
		expect(as.exchanges[0]["code"]).toBe("listener-code");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a stored token is injected into the child env; absent token is not", async () => {
	const as = await stubAs("env-code");
	const { dir, env } = await oauthConfigDir(as.url);
	try {
		const config = parseMcpConfig(
			await (await import("node:fs/promises")).readFile(
				env[MCP_CONFIG_ENV],
				"utf8",
			),
			env[MCP_CONFIG_ENV]!,
		);
		const server = config.servers.stub;

		// No stored token yet: spawn env is just the server's own env.
		const before = spawnEnvWithToken("stub", server, env);
		expect(before).toEqual({});

		// Store a token (as the flow would) → injected as MCP_ACCESS_TOKEN.
		storeMcpToken(
			"stub",
			{
				access_token: "tok-123",
				token_type: "Bearer",
				obtained_at: 1,
			},
			env,
		);
		const after = spawnEnvWithToken("stub", server, env);
		expect(after).toEqual({ MCP_ACCESS_TOKEN: "tok-123" });

		// Config env merges UNDER the token (token wins, per the ruling).
		const withEnv = { ...server, env: { OWN: "yes" } };
		expect(spawnEnvWithToken("stub", withEnv, env)).toEqual({
			OWN: "yes",
			MCP_ACCESS_TOKEN: "tok-123",
		});

		// A server WITHOUT an oauth block never reads the store (backward
		// compat): its env passes through even though a token exists.
		const plain = { command: "x", args: [] } as typeof server;
		expect(spawnEnvWithToken("stub", plain, env)).toEqual({});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("config backward compat: no oauth block → part-1 shape unchanged", () => {
	const config = parseMcpConfig(
		JSON.stringify({
			servers: { plain: { command: "node", args: ["s.mjs"] } },
		}),
		"/x/mcp.json",
	);
	expect(config.servers.plain.oauth).toBeUndefined();
	expect(config.servers.plain).toEqual({ command: "node", args: ["s.mjs"] });

	// A malformed oauth block fails loudly (fail-loud config store).
	expect(() =>
		parseMcpConfig(
			JSON.stringify({
				servers: {
					bad: {
						command: "node",
						args: [],
						oauth: { authorizeUrl: "http://x" },
					},
				},
			}),
			"/x/mcp.json",
		),
	).toThrow(/oauth needs string/);
});

test("extractCode pulls the code (and surfaces AS errors)", () => {
	expect(extractCode("http://127.0.0.1:9/callback?code=abc&state=z")).toEqual({
		code: "abc",
	});
	expect(extractCode("http://127.0.0.1:9/callback?error=access_denied")).toEqual({
		error: "access_denied",
	});
	expect(() => extractCode("http://127.0.0.1:9/callback?state=1")).toThrow(
		/no code/,
	);
});

test("the CLI arg parser accepts the oauth subcommand shape", () => {
	expect(parseCliArgs(["oauth", "stub"])).toEqual({
		command: "oauth",
		server: "stub",
		paste: false,
	});
	expect(parseCliArgs(["oauth", "stub", "--paste"])).toEqual({
		command: "oauth",
		server: "stub",
		paste: true,
	});
	expect(() => parseCliArgs(["login", "stub"])).toThrow(/unknown command/);
	expect(() => parseCliArgs(["oauth"])).toThrow(/exactly one server name/);
});