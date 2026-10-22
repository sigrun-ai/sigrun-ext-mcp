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

import { createInterface } from "node:readline";
import {
	isStdioServer,
	loadMcpConfig,
	MCP_CONFIG_ENV,
	type McpConfig,
} from "./config.js";
import { startOauth } from "./oauth.js";
import { resolveMcpTokenPath } from "./tokens.js";

/** The flow timeout (matches startOauth's default; explicit so the user's
 * error message is deterministic). */
const TIMEOUT_MS = 5 * 60_000;

/** Print the usage banner. */
function usage(out: NodeJS.WriteStream): void {
	out.write("usage: sigrun-ext-mcp oauth <server> [--paste]\n");
	out.write(
		`reads the MCP config (env ${MCP_CONFIG_ENV} or ~/.config/sigrun/mcp.json);\n` +
			`the named server needs an oauth block; the token is stored beside the\n` +
			`config as mcp-tokens.json (0600)\n`,
	);
}

/** Parse argv minimally: `oauth <server> [--paste]`. */
export function parseCliArgs(argv: readonly string[]): {
	readonly command: "oauth";
	readonly server: string;
	readonly paste: boolean;
} {
	const args = [...argv];
	const head = args.shift();
	if (head !== "oauth") {
		throw new Error(`unknown command: ${String(head)}`);
	}
	const paste = args.includes("--paste");
	const positional = args.filter((arg) => arg !== "--paste");
	if (positional.length !== 1) {
		throw new Error("expected exactly one server name");
	}
	return { command: "oauth", server: positional[0], paste };
}

/** Load the config, turning a malformed config into exit-1 (not a crash). */
function loadMcpConfigSafe(stderr: NodeJS.WriteStream): McpConfig {
	try {
		return loadMcpConfig();
	} catch (cause) {
		stderr.write(
			`error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
		);
		process.exit(1);
	}
}

/** The CLI body (exported for tests); returns the process exit code. */
export async function runCli(
	argv: readonly string[],
	io: {
		readonly stdout: NodeJS.WriteStream;
		readonly stderr: NodeJS.WriteStream;
	} = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
	let parsed;
	try {
		parsed = parseCliArgs(argv);
	} catch (cause) {
		usage(io.stderr);
		io.stderr.write(
			`error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
		);
		return 1;
	}
	const config = loadMcpConfigSafe(io.stderr);
	const server = config.servers[parsed.server];
	if (server === undefined) {
		io.stderr.write(
			`error: no server named "${parsed.server}" in the MCP config\n`,
		);
		return 1;
	}
	if (!isStdioServer(server) || server.oauth === undefined) {
		io.stderr.write(
			`error: server "${parsed.server}" has no oauth block in the MCP config\n`,
		);
		return 1;
	}

	const flow = await startOauth(parsed.server, server.oauth, {
		timeoutMs: TIMEOUT_MS,
	});
	io.stdout.write(`Authorize URL:\n  ${flow.authorizeUrl}\n`);
	io.stdout.write(`Redirect URI:\n  ${flow.redirectUri}\n`);
	io.stdout.write(
		"Open the Authorize URL in a browser and approve. If the redirect does\n" +
			"not reach this machine, paste the FULL redirected URL here instead:\n",
	);

	// The paste fallback: every stdin line is fed to the flow; first arrival
	// wins (the loopback listener or the paste settles the code). pasteUrl
	// never throws (lines with no code are ignored), so the readline handler
	// cannot crash the bin.
	const lines = createInterface({ input: process.stdin });
	lines.on("line", (line: string) => {
		const trimmed = line.trim();
		if (trimmed !== "") flow.pasteUrl(trimmed);
	});

	try {
		await flow.done;
		lines.close();
		io.stdout.write(
			`Token stored for "${parsed.server}" in:\n  ${resolveMcpTokenPath()}\n`,
		);
		return 0;
	} catch (cause) {
		lines.close();
		flow.stop();
		io.stderr.write(
			`error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
		);
		return 1;
	}
}

// This module is the CLI body only (pure exports; importable for tests).
// The bin entry lives in ./bin.ts — dist/bin.js is the package.json "bin".