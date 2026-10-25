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
import type { McpOAuthConfig } from "./config.js";
import { type McpStoredToken } from "./tokens.js";
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
export declare function extractCode(url: string): {
    code: string;
} | {
    error: string;
};
/** Exchange the code at `tokenUrl` and return the normalized token. */
export declare function exchangeCode(oauth: McpOAuthConfig, code: string, redirectUri: string, verifier: string): Promise<McpStoredToken>;
/** An injected seam for tests: how the CLI/flow mints the verifier. */
export declare function makePkcePair(): {
    readonly verifier: string;
    readonly challenge: string;
};
/** Build the authorize URL (PKCE S256 + optional scopes + redirect_uri). */
export declare function buildAuthorizeUrl(oauth: McpOAuthConfig, redirectUri: string, codeChallenge: string): string;
interface PendingUserFlow {
    readonly verifier: string;
    readonly redirectUri: string;
    readonly expiresAt: number;
}
export type UserOauthFlow = PendingUserFlow;
/** In-memory PKCE state for extension routes; the caller owns token storage. */
export declare function createUserOauthFlows(now?: () => number): {
    start(user: string, server: string, oauth: McpOAuthConfig, redirectUri: string): string;
    take(user: string, server: string): UserOauthFlow | undefined;
    release(user: string, server: string, flow: UserOauthFlow): void;
    clear(): void;
};
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
export declare function startOauth(serverName: string, oauth: McpOAuthConfig, options?: StartOauthOptions): Promise<OauthFlow>;
export {};
