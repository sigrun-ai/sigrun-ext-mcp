/**
 * The OAuth authorization-code flow (T3c): paste-the-URL mode for stdio MCP
 * servers living where the user's browser cannot reach them (inside a pod).
 *
 * `startOauth` builds the authorize URL (with PKCE S256 — RFC 7636; the
 * verifier is generated with node:crypto, no new deps), starts a loopback
 * listener on 127.0.0.1 with a RANDOM port (RFC 8252) as redirect_uri, and
 * returns the URL for the user to open however they get there. The CLI also
 * prints the redirect_uri and reads pasted redirected URLs from stdin —
 * first arrival wins: the loopback hit OR the paste. The code is exchanged
 * at `tokenUrl` (POST, client_id, grant_type=authorization_code, code,
 * redirect_uri, code_verifier) and the token lands in the store.
 */

import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { McpOAuthConfig } from "./config.js";
import { storeMcpToken, type McpStoredToken } from "./tokens.js";

/** The paste-the-URL flow's interactive handles (what `runOauth` returns). */
export interface OauthFlow {
	/** The authorize URL to open in a browser (also printed by the CLI). */
	readonly authorizeUrl: string;
	/** The loopback redirect_uri (`http://127.0.0.1:<port>/callback`). */
	readonly redirectUri: string;
	/** Feed a pasted redirected URL (the paste fallback). Extracts the code;
	 * a URL with no code is IGNORED (the user may paste again); a URL
	 * carrying an AS `error` parameter FAILS the flow fast. */
	pasteUrl(url: string): void;
	/** Settles with the STORED token, or rejects on AS error / exchange
	 * failure / timeout. */
	readonly done: Promise<McpStoredToken>;
	/** Tear down the listener (idempotent; no-op after the flow settles). */
	stop(): void;
}

/** Extract `code` (and `error`) from a redirected URL's query string. */
export function extractCode(url: string): { code: string } | { error: string } {
	const query = url.slice(url.indexOf("?") + 1);
	for (const pair of query.split("&")) {
		const eq = pair.indexOf("=");
		if (eq < 0) continue;
		const key = decodeURIComponent(pair.slice(0, eq));
		const value = decodeURIComponent(pair.slice(eq + 1));
		if (key === "code") return { code: value };
		if (key === "error") return { error: value };
	}
	throw new Error(`redirected URL has no code in its query: ${url}`);
}

/** Base64url (RFC 7636 §2) — used for the PKCE pair. */
function b64url(bytes: Buffer): string {
	return bytes
		.toString("base64")
		.replace(/=+$/, "")
		.replace(/\+/g, "-")
		.replace(/\//g, "_");
}

/** POST form-encoded params to `url`, resolve the parsed JSON body. */
async function postJson(
	url: string,
	params: Record<string, string>,
): Promise<Record<string, unknown>> {
	const body = Object.entries(params)
		.map(
			([key, value]) =>
				`${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
		)
		.join("&");
	const target = new URL(url);
	const send = target.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		const req = send(
			{
				hostname: target.hostname,
				port: target.port,
				path: `${target.pathname}${target.search}`,
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"content-length": String(Buffer.byteLength(body)),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
						reject(
							new Error(
								`token endpoint ${url} returned ${res.statusCode}: ${text}`,
							),
						);
						return;
					}
					try {
						const parsed = JSON.parse(text) as unknown;
						if (
							typeof parsed !== "object" ||
							parsed === null ||
							Array.isArray(parsed)
						) {
							throw new Error("not an object");
						}
						resolve(
							parsed as Record<string, unknown>,
						);
					} catch (cause) {
						reject(
							new Error(
								`token endpoint ${url} returned non-JSON: ${
									cause instanceof Error ? cause.message : String(cause)
								}`,
							),
						);
					}
				});
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

/** Exchange the code at `tokenUrl` and return the normalized token. */
export async function exchangeCode(
	oauth: McpOAuthConfig,
	code: string,
	redirectUri: string,
	verifier: string,
): Promise<McpStoredToken> {
	const response = await postJson(oauth.tokenUrl, {
		client_id: oauth.clientId,
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		code_verifier: verifier,
	});
	if (
		typeof response.access_token !== "string" ||
		typeof response.token_type !== "string"
	) {
		throw new Error(
			`token endpoint response lacks access_token/token_type: ${JSON.stringify(response)}`,
		);
	}
	const now = Math.floor(Date.now() / 1000);
	return {
		access_token: response.access_token,
		token_type: response.token_type,
		...(typeof response.refresh_token === "string"
			? { refresh_token: response.refresh_token }
			: {}),
		...(typeof response.expires_in === "number"
			? { expires_at: now + response.expires_in }
			: {}),
		obtained_at: now,
	};
}

/** An injected seam for tests: how the CLI/flow mints the verifier. */
export function makePkcePair(): { readonly verifier: string; readonly challenge: string } {
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

/** Build the authorize URL (PKCE S256 + optional scopes + redirect_uri). */
export function buildAuthorizeUrl(
	oauth: McpOAuthConfig,
	redirectUri: string,
	codeChallenge: string,
): string {
	const url = new URL(oauth.authorizeUrl);
	url.searchParams.set("client_id", oauth.clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	if (oauth.scopes !== undefined) {
		url.searchParams.set("scope", oauth.scopes.join(" "));
	}
	return url.toString();
}

const USER_FLOW_TTL_MS = 10 * 60_000;

interface PendingUserFlow {
	readonly verifier: string;
	readonly redirectUri: string;
	readonly expiresAt: number;
}

export type UserOauthFlow = PendingUserFlow;

/** In-memory PKCE state for extension routes; the caller owns token storage. */
export function createUserOauthFlows(now: () => number = Date.now) {
	const pending = new Map<string, PendingUserFlow>();
	const key = (user: string, server: string) => JSON.stringify([user, server]);
	return {
		start(
			user: string,
			server: string,
			oauth: McpOAuthConfig,
			redirectUri: string,
		): string {
			const { verifier, challenge } = makePkcePair();
			pending.set(key(user, server), {
				verifier,
				redirectUri,
				expiresAt: now() + USER_FLOW_TTL_MS,
			});
			return buildAuthorizeUrl(oauth, redirectUri, challenge);
		},
		take(user: string, server: string): UserOauthFlow | undefined {
			const flowKey = key(user, server);
			const flow = pending.get(flowKey);
			if (flow === undefined) return undefined;
			// Claim before any asynchronous exchange so concurrent completions
			// cannot reuse one authorization code or PKCE verifier.
			pending.delete(flowKey);
			if (flow.expiresAt <= now()) return undefined;
			return flow;
		},
		release(user: string, server: string, flow: UserOauthFlow): void {
			const flowKey = key(user, server);
			// A newer start supersedes the old flow; an invalid paste must not
			// restore stale state over its replacement.
			if (!pending.has(flowKey) && flow.expiresAt > now()) {
				pending.set(flowKey, flow);
			}
		},
		clear(): void {
			pending.clear();
		},
	};
}

/** Oauth start options (defaults match the CLI: 5-minute timeout). */
export interface StartOauthOptions {
	/** How long to wait for a code (listener or paste) before failing. */
	readonly timeoutMs?: number;
	/** Where to store the token (default: beside the resolved config). */
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * Run the flow for one server (the CLI-equivalent `runOauth`): start the
 * loopback listener, build + return the authorize URL, and expose
 * `pasteUrl` for the paste-the-URL fallback. First arrival wins; the flow
 * resolves with the STORED token (written to the token store).
 */
export async function startOauth(
	serverName: string,
	oauth: McpOAuthConfig,
	options: StartOauthOptions = {},
): Promise<OauthFlow> {
	const { createServer } = await import("node:http");
	const { verifier, challenge } = makePkcePair();

	// The code settlement: the listener hit and the paste handler both feed
	// this seam; the first caller wins (later calls are ignored).
	let settleCode: ((code: string) => void) | undefined;
	let failFlow: ((error: Error) => void) | undefined;
	const codeReceived = new Promise<string>((resolve, reject) => {
		settleCode = resolve;
		failFlow = reject;
	});

	// Loopback listener (RFC 8252): random port on 127.0.0.1, one route.
	const server = createServer((req, res) => {
		const url = req.url ?? "/";
		let code: string | undefined;
		let oauthError: string | undefined;
		for (const pair of url.slice(url.indexOf("?") + 1).split("&")) {
			const eq = pair.indexOf("=");
			if (eq < 0) continue;
			const [key, value] = [
				pair.slice(0, eq),
				decodeURIComponent(pair.slice(eq + 1)),
			];
			if (key === "code") code = value;
			if (key === "error") oauthError = value;
		}
		res.writeHead(200, { "content-type": "text/plain" });
		if (oauthError !== undefined) {
			res.end(`Authorization failed: ${oauthError}`);
			failFlow?.(new Error(`authorization server returned error: ${oauthError}`));
			return;
		}
		if (code !== undefined) {
			res.end("Authorization complete. You can close this tab.");
			settleCode?.(code);
		} else {
			res.end("Missing code in the redirect.");
		}
	});
	const listening = new Promise<number>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address !== null && typeof address === "object") {
				resolve(address.port);
			} else {
				reject(new Error("loopback listener did not report a port"));
			}
		});
	});
	const port = await listening;
	const redirectUri = `http://127.0.0.1:${port}/callback`;
	const authorizeUrl = buildAuthorizeUrl(oauth, redirectUri, challenge);

	const timeoutMs = options.timeoutMs ?? 5 * 60_000;

	// The flow: code (listener-or-paste, or timeout) → exchange → store.
	const done = (async (): Promise<McpStoredToken> => {
		const code = await Promise.race([
			codeReceived,
			new Promise<never>((_, reject) => {
				setTimeout(
					() =>
						reject(
							new Error(
								`oauth for "${serverName}" timed out after ${
									timeoutMs / 1000
								}s waiting for the redirect (listener or paste)`,
							),
						),
					timeoutMs,
				).unref?.();
			}),
		]);
		const token = await exchangeCode(oauth, code, redirectUri, verifier);
		storeMcpToken(serverName, token, options.env);
		return token;
	})();

	// Settle closes the listener no matter which path won. NOTE: the rejection
	// is HANDLED here (both callbacks), so the derived promise never becomes an
	// unhandled rejection when the flow fails.
	const stop = () => server.close();
	void done.then(stop, stop);

	return {
		authorizeUrl,
		redirectUri,
		pasteUrl(url: string) {
			let extracted: ReturnType<typeof extractCode>;
			try {
				extracted = extractCode(url);
			} catch {
				// A pasted line with no code (a stray paste, a log line): ignore —
				// the user may paste the right URL next. Never throw: this runs in
				// the CLI's readline handler, where a throw would crash the bin.
				return;
			}
			if ("error" in extracted) {
				// The AS redirected with an error parameter: fail fast instead
				// of hanging until the timeout.
				failFlow?.(
					new Error(`authorization server returned error: ${extracted.error}`),
				);
				return;
			}
			settleCode?.(extracted.code);
		},
		done,
		stop,
	} satisfies OauthFlow;
}