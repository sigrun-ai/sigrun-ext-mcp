/**
 * The `sigrun-ext-mcp` CLI bin (ruling 4): `sigrun-ext-mcp oauth <server>`
 * runs the paste-the-URL OAuth flow for one configured server.
 *
 * argv surface (parsed minimally — no new deps):
 *   sigrun-ext-mcp oauth <server> [--paste]
 *
 * Default mode: the loopback listener runs AND stdin is read (paste
 * fallback) — first arrival wins. `--paste` is accepted for hosts that want
 * the semantics explicit; the flow is identical either way.
 *
 * Prints to stdout:
 *   - the authorize URL (open this in a browser)
 *   - the redirect_uri (what the AS will redirect to)
 *   - a paste prompt
 * Exits 0 with the token stored, or 1 with a clear error (usage / config /
 * flow / 5-minute timeout).
 */
/** Parse argv minimally: `oauth <server> [--paste]`. */
export declare function parseCliArgs(argv: readonly string[]): {
    readonly command: "oauth";
    readonly server: string;
    readonly paste: boolean;
};
/** The CLI body (exported for tests); returns the process exit code. */
export declare function runCli(argv: readonly string[], io?: {
    readonly stdout: NodeJS.WriteStream;
    readonly stderr: NodeJS.WriteStream;
}): Promise<number>;
