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
import { expect, test, afterAll, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	MCP_CONFIG_ENV,
	parseMcpConfig,
} from "../src/config.js";
import { spawnEnvWithToken, storeMcpToken, resolveMcpTokenPath, loadMcpTokens } from "../src/tokens.js";
import { startOauth, extractCode, buildAuthorizeUrl, createUserOauthFlows } from "../src/oauth.js";
import { createMcpExtension, type McpWiring } from "../src/extension.js";
import { parseCliArgs, runCli } from "../src/cli.js";
import { createCatalogHost, type CatalogHostDouble } from "./catalog-host.js";
import { cleanupDir, stubConfigPath, tempDir } from "./harness.js";

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
				if (params.code !== code) {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "invalid_grant" }));
					return;
				}
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
		const stubServer = config.servers.stub;
		if (!("command" in stubServer)) throw new Error("expected stdio server");
		const flow = await startOauth("stub", stubServer.oauth!, {
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

test("the loopback listener also settles the flow (first arrival wins)", async () => {	const as = await stubAs("listener-code");
	const { dir, env } = await oauthConfigDir(as.url);
	try {
		const config = parseMcpConfig(
			await (await import("node:fs/promises")).readFile(
				env[MCP_CONFIG_ENV],
				"utf8",
			),
			env[MCP_CONFIG_ENV]!,
		);
		const stubServer = config.servers.stub;
		if (!("command" in stubServer)) throw new Error("expected stdio server");
		const flow = await startOauth("stub", stubServer.oauth!, {
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
		if (!("command" in server)) throw new Error("expected stdio server");

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

test("a pasted URL with an AS error fails the flow fast; junk pastes are ignored", async () => {
	const as = await stubAs("irrelevant");
	const { dir, env } = await oauthConfigDir(as.url);
	try {
		const config = parseMcpConfig(
			await (await import("node:fs/promises")).readFile(
				env[MCP_CONFIG_ENV],
				"utf8",
			),
			env[MCP_CONFIG_ENV]!,
		);
		const stubServer = config.servers.stub;
		if (!("command" in stubServer)) throw new Error("expected stdio server");
		const flow = await startOauth("stub", stubServer.oauth!, {
			env,
			timeoutMs: 10_000,
		});

		// A junk line (no code) is ignored — the user may paste again.
		flow.pasteUrl("not a url at all");
		flow.pasteUrl("http://127.0.0.1:1/callback?state=xyz");

		// An AS error parameter fails the flow instead of hanging to timeout.
		flow.pasteUrl(`${flow.redirectUri}?error=access_denied`);
		await expect(flow.done).rejects.toThrow(/access_denied/);
		flow.stop();
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
	const plain = config.servers.plain;
	if (!("command" in plain)) throw new Error("expected stdio plain");
	expect(plain.oauth).toBeUndefined();
	expect(plain).toEqual({ command: "node", args: ["s.mjs"] });

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

// ------------------------------------------------------- per-user routes

interface RouteFixture {
	readonly wiring: McpWiring;
	readonly double: CatalogHostDouble;
	readonly as: StubAs;
	start(server: string, user: string): Promise<Response>;
	complete(server: string, user: string, body?: string | null): Promise<Response>;
	close(): Promise<void>;
}

async function openRouteFixture(
	servers: Record<string, unknown> | ((as: StubAs) => Record<string, unknown>),
	stopOnLastRelease = false,
): Promise<RouteFixture> {
	const as = await stubAs("alice-code");
	const dir = await tempDir("sigrun-mcp-user-oauth-");
	const double = createCatalogHost({ stopOnLastRelease });
	const prior = process.env[MCP_CONFIG_ENV];
	process.env[MCP_CONFIG_ENV] = stubConfigPath(dir);
	let wiring: McpWiring;
	try {
		await writeFile(
			stubConfigPath(dir),
			JSON.stringify({
				servers: typeof servers === "function" ? servers(as) : servers,
			}),
			"utf8",
		);
		wiring = createMcpExtension(double.host);
	} finally {
		if (prior === undefined) delete process.env[MCP_CONFIG_ENV];
		else process.env[MCP_CONFIG_ENV] = prior;
	}
	double.registerServices(wiring.userServices);
	const route = (suffix: string) => {
		const found = wiring.routes.find(
			(candidate) => candidate.path === `oauth/:server/${suffix}`,
		);
		if (found === undefined) throw new Error(`missing OAuth ${suffix} route`);
		expect(found.method).toBe("POST");
		expect(found.auth).toBe("user");
		return found;
	};
	const startRoute = route("start");
	const completeRoute = route("complete");
	const call = (
		contribution: McpWiring["routes"][number],
		server: string,
		user: string,
		body?: string,
	) =>
		contribution.handler(
			new Request(
				`https://sigrun.example.invalid/v1/ext/sigrun-mcp/oauth/${server}/${contribution.path.endsWith("start") ? "start" : "complete"}`,
				{
					method: "POST",
					...(body === undefined ? {} : { body }),
				},
			),
			{ principal: { user }, host: double.host },
		);
	return {
		wiring,
		double,
		as,
		start: (server, user) => call(startRoute, server, user),
		complete: (
			server,
			user,
			body = JSON.stringify({
				redirectedUrl: `https://client.example.invalid/callback?code=alice-code`,
			}),
		) => call(completeRoute, server, user, body ?? undefined),
		close: async () => {
			await wiring.close();
			double.close();
			await cleanupDir(dir);
		},
	};
}

function personalOauth(
	as: StubAs,
	fields: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		command: process.execPath,
		args: [join(import.meta.dirname, "stub-mcp-server.mjs")],
		env: { STUB_ENV_TOOL: "1" },
		credentials: "user",
		oauth: {
			authorizeUrl: `${as.url}/authorize`,
			tokenUrl: `${as.url}/token`,
			clientId: "acme-client",
		},
		...fields,
	};
}

async function authorizeUrl(response: Response): Promise<URL> {
	expect(response.status).toBe(200);
	return new URL(((await response.json()) as { url: string }).url);
}

async function expectError(
	response: Response,
	status: number,
	error: string,
): Promise<void> {
	expect(response.status).toBe(status);
	await expect(response.json()).resolves.toEqual({ error });
}

test("per-user OAuth start builds PKCE and completion stores only the caller's raw token", async () => {
	const fixture = await openRouteFixture((as) => ({ acme: personalOauth(as) }));
	try {
		const url = await authorizeUrl(await fixture.start("acme", "alice"));
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://sigrun.example.invalid/v1/ext/sigrun-mcp/oauth/acme/complete",
		);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		await expect(fixture.complete("acme", "alice")).resolves.toMatchObject({
			status: 204,
		});
		expect(fixture.double.secrets.get("alice")?.get("token:acme")).toMatch(
			/^stub-token-/,
		);
		expect(fixture.double.secrets.has("bob")).toBe(false);
		expect(fixture.as.exchanges).toHaveLength(1);
		expect(fixture.as.exchanges[0].redirect_uri).toBe(
			"https://sigrun.example.invalid/v1/ext/sigrun-mcp/oauth/acme/complete",
		);
		const verifier = fixture.as.exchanges[0].code_verifier;
		expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
			url.searchParams.get("code_challenge"),
		);
	} finally {
		await fixture.close();
	}
});

test("two users own independent flows and another user cannot complete a pending flow", async () => {
	const fixture = await openRouteFixture((as) => ({ acme: personalOauth(as) }));
	try {
		const aliceUrl = await authorizeUrl(await fixture.start("acme", "alice"));
		const bobUrl = await authorizeUrl(await fixture.start("acme", "bob"));
		expect(aliceUrl.searchParams.get("code_challenge")).not.toBe(
			bobUrl.searchParams.get("code_challenge"),
		);
		await expectError(
			await fixture.complete("acme", "mallory"),
			400,
			"no_pending_flow",
		);
		await expectError(
			await fixture.complete(
				"acme",
				"bob",
				JSON.stringify({
					redirectedUrl:
						"https://client.example.invalid/callback?code=not-issued",
				}),
			),
			502,
			"exchange_failed",
		);
		expect(fixture.double.secrets.has("bob")).toBe(false);
		await expect(fixture.complete("acme", "alice")).resolves.toMatchObject({
			status: 204,
		});
		expect(fixture.double.secrets.has("alice")).toBe(true);
		expect(fixture.double.secrets.has("bob")).toBe(false);
	} finally {
		await fixture.close();
	}
});

test("bob cannot consume alice's pending flow", async () => {
	const fixture = await openRouteFixture((as) => ({ acme: personalOauth(as) }));
	try {
		await fixture.start("acme", "alice");
		await expectError(
			await fixture.complete("acme", "bob"),
			400,
			"no_pending_flow",
		);
		expect(fixture.as.exchanges).toHaveLength(0);
		expect(fixture.double.secrets.size).toBe(0);
		await expect(fixture.complete("acme", "alice")).resolves.toMatchObject({
			status: 204,
		});
	} finally {
		await fixture.close();
	}
});

test("shared, unknown, and non-OAuth servers refuse both routes without storing", async () => {
	const as = await stubAs("unused");
	const fixture = await openRouteFixture({
		acme: personalOauth(as),
		shared: {
			...personalOauth(as),
			credentials: "shared",
			sharedAuthority: "Synthetic shared test authority",
		},
		plain: {
			command: process.execPath,
			args: ["server.mjs"],
			credentials: "user",
		},
	});
	try {
		for (const server of ["shared", "missing", "plain"]) {
			await expectError(
				await fixture.start(server, "alice"),
				404,
				"unknown_server",
			);
			await expectError(
				await fixture.complete(server, "alice"),
				404,
				"unknown_server",
			);
		}
		expect(fixture.double.secrets.size).toBe(0);
		expect(fixture.as.exchanges).toHaveLength(0);
	} finally {
		await fixture.close();
	}
});

test("expired flows and malformed or invalid completion bodies store nothing", async () => {
	vi.useFakeTimers();
	const fixture = await openRouteFixture((as) => ({ acme: personalOauth(as) }));
	try {
		await fixture.start("acme", "alice");
		await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
		await expectError(
			await fixture.complete("acme", "alice"),
			400,
			"no_pending_flow",
		);
		for (const body of [
			null,
			"{",
			"null",
			"[]",
			"{}",
			JSON.stringify({ redirectedUrl: 7 }),
		]) {
			await fixture.start("acme", "alice");
			await expectError(
				await fixture.complete("acme", "alice", body),
				400,
				"invalid_body",
			);
		}
		await fixture.start("acme", "alice");
		await expectError(
			await fixture.complete(
				"acme",
				"alice",
				JSON.stringify({ redirectedUrl: "not a url" }),
			),
			400,
			"invalid_redirect",
		);
		expect(fixture.double.secrets.size).toBe(0);
		expect(fixture.as.exchanges).toHaveLength(0);
		await expect(fixture.complete("acme", "alice")).resolves.toMatchObject({
			status: 204,
		});
	} finally {
		await fixture.close();
		vi.useRealTimers();
	}
});

test("an invalid old redirect cannot displace a replacement flow", async () => {
	const fixture = await openRouteFixture((as) => ({ acme: personalOauth(as) }));
	try {
		await fixture.start("acme", "alice");
		let parsed: (value: unknown) => void = () => {};
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"redirectedUrl":"no-code"}'));
				parsed = () => controller.close();
			},
		});
		const route = fixture.wiring.routes.find((candidate) => candidate.path.endsWith("complete"));
		if (route === undefined) throw new Error("missing complete route");
		const completing = route.handler(
			new Request("https://sigrun.example.invalid/v1/ext/sigrun-mcp/oauth/acme/complete", {
				method: "POST",
				body,
				duplex: "half",
			} as RequestInit),
			{ principal: { user: "alice" }, host: fixture.double.host },
		);
		await fixture.start("acme", "alice");
		parsed(undefined);
		await expectError(await completing, 400, "invalid_redirect");
		await expect(fixture.complete("acme", "alice")).resolves.toMatchObject({
			status: 204,
		});
	} finally {
		await fixture.close();
	}
});

test("failed exchanges consume the flow and never store a token", async () => {
	const fixture = await openRouteFixture((as) => ({ acme: personalOauth(as) }));
	try {
		await fixture.start("acme", "alice");
		await expectError(
			await fixture.complete(
				"acme",
				"alice",
				JSON.stringify({
					redirectedUrl: "https://client.example.invalid/callback?code=wrong",
				}),
			),
			502,
			"exchange_failed",
		);
		await expectError(
			await fixture.complete("acme", "alice"),
			400,
			"no_pending_flow",
		);
		expect(fixture.double.secrets.size).toBe(0);
	} finally {
		await fixture.close();
	}
});

test("a successful completion cannot be replayed", async () => {
	const fixture = await openRouteFixture((as) => ({ acme: personalOauth(as) }));
	try {
		await fixture.start("acme", "alice");
		await expect(fixture.complete("acme", "alice")).resolves.toMatchObject({
			status: 204,
		});
		await expectError(
			await fixture.complete("acme", "alice"),
			400,
			"no_pending_flow",
		);
		expect(fixture.as.exchanges).toHaveLength(1);
	} finally {
		await fixture.close();
	}
});

test("token storage retires and reconnects the caller's service with the new secret", async () => {
	const fixture = await openRouteFixture(
		(as) => ({ acme: personalOauth(as) }),
		true,
	);
	try {
		await fixture.wiring.conversationCreated({
			conversationId: 9001 as never,
			owner: "alice",
		});
		const getenv = () =>
			fixture.double.userTools
				.get("alice")
				?.find((tool) => tool.name === "acme/getenv");
		const read = async () =>
			(
				await getenv()?.execute(
					{ name: "MCP_ACCESS_TOKEN" },
					{ conversationId: 9001 } as never,
					BACKGROUND_CONTEXT,
				)
			)?.output;
		expect(await read()).toEqual([{ type: "text", text: "" }]);
		expect(fixture.double.launches).toHaveLength(1);
		await fixture.start("acme", "alice");
		await expect(fixture.complete("acme", "alice")).resolves.toMatchObject({
			status: 204,
		});
		expect(fixture.double.launches[0].releases).toBeGreaterThan(0);
		await fixture.wiring.conversationCreated({
			conversationId: 9001 as never,
			owner: "alice",
		});
		expect(fixture.double.launches).toHaveLength(2);
		expect(fixture.double.launches[1].spec.env?.MCP_ACCESS_TOKEN).toBe(
			fixture.double.secrets.get("alice")?.get("token:acme"),
		);
		expect(await read()).toEqual([
			{
				type: "text",
				text: fixture.double.secrets.get("alice")?.get("token:acme"),
			},
		]);
	} finally {
		await fixture.close();
	}
});

test("the CLI refuses per-user OAuth and names the extension start route", async () => {
	const as = await stubAs("unused");
	const { dir, env } = await oauthConfigDir(as.url, "acme");
	const prior = process.env[MCP_CONFIG_ENV];
	process.env[MCP_CONFIG_ENV] = env[MCP_CONFIG_ENV];
	let stderr = "";
	try {
		const config = JSON.parse(
			await (
				await import("node:fs/promises")
			).readFile(env[MCP_CONFIG_ENV]!, "utf8"),
		) as { servers: Record<string, unknown> };
		config.servers.acme = {
			...(config.servers.acme as Record<string, unknown>),
			credentials: "user",
		};
		await writeFile(env[MCP_CONFIG_ENV]!, JSON.stringify(config), "utf8");
		const code = await runCli(["oauth", "acme"], {
			stdout: { write: () => true } as unknown as NodeJS.WriteStream,
			stderr: {
				write: (chunk: string) => {
					stderr += chunk;
					return true;
				},
			} as unknown as NodeJS.WriteStream,
		});
		expect(code).toBe(1);
		expect(stderr).toContain("/v1/ext/sigrun-mcp/oauth/acme/start");
		expect(stderr).toContain("per-user");
		expect(loadMcpTokens(env)).toEqual({});
	} finally {
		if (prior === undefined) delete process.env[MCP_CONFIG_ENV];
		else process.env[MCP_CONFIG_ENV] = prior;
		await rm(dir, { recursive: true, force: true });
	}
});
test("starting a flow proactively evicts every expired pending flow", () => {
	let now = 1_000;
	const flows = createUserOauthFlows(() => now);
	const oauth = {
		authorizeUrl: "https://as.example.invalid/authorize",
		tokenUrl: "https://as.example.invalid/token",
		clientId: "acme-client",
	};
	const redirectUri = "https://sigrun.example.invalid/callback";
	const original = flows.start("alice", "acme", oauth, redirectUri);
	flows.start("bob", "acme", oauth, redirectUri);
	flows.start("alice", "files", oauth, redirectUri);
	expect(flows.pendingCount()).toBe(3);
	now += 10 * 60_000;
	flows.start("mallory", "acme", oauth, redirectUri);
	expect(flows.pendingCount()).toBe(1);
	for (const [user, server] of [["alice", "acme"], ["bob", "acme"], ["alice", "files"]]) {
		expect(flows.take(user, server)).toBeUndefined();
		const replacement = flows.start(user, server, oauth, redirectUri);
		expect(replacement).not.toBe(original);
		expect(new URL(replacement).searchParams.get("code_challenge")).not.toBe(
			new URL(original).searchParams.get("code_challenge"),
		);
	}
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