/**
 * Minimal hand-rolled MCP stdio client (ruling 3): JSON-RPC 2.0 over
 * newline-delimited stdio, no pi-mcp dependency.
 *
 * Lifecycle: spawn → `initialize` handshake (protocolVersion "2025-06-18",
 * clientInfo, capabilities) → `notifications/initialized` → `tools/list`
 * (discovery) → `tools/call` (execution). Requests correlate by id; the
 * response frame's `id` must match a pending request (a notification is
 * never a reply). A spawn failure or handshake failure rejects `connect`,
 * never affecting any other server (per-server isolation).
 *
 * Per-request timeout (codemode parity, spec slice 3): every request REJECTS
 * at its deadline (default 60s; config `timeout` per server) instead of
 * awaiting a hung server forever. A `notifications/progress` frame naming a
 * pending request's id (sent as the request's `progressToken`) RESETS that
 * request's deadline — a server that keeps reporting progress stays alive
 * as long as it works. A timeout rejects the call but never kills the child
 * (per-server isolation: the next request gets a fresh chance).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { spawnEnvWithToken } from "./tokens.js";
import { DEFAULT_TIMEOUT_SECONDS } from "./config.js";
import type {
	McpServerConfig,
	McpToolDefinition,
	McpToolResult,
} from "./types.js";

/** JSON-RPC 2.0 request / notification frame. */
interface JsonRpcFrame {
	readonly jsonrpc: "2.0";
	readonly id?: number | string | null;
	readonly method: string;
	readonly params?: unknown;
	/** Request extension channel: carries our `progressToken` so servers
	 * can report progress on a pending request by id. */
	readonly _meta?: unknown;
	readonly result?: unknown;
	readonly error?: { code: number; message: string; data?: unknown };
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One pending request's timeout bookkeeping. */
interface PendingRequest {
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
	/** Restart the deadline wait (a progress notification reset). */
	resetTimeout(): void;
	/** Cancel the deadline timer (the request settled). */
	clearTimeout(): void;
}

/** One connected MCP server: a live child process speaking JSON-RPC. */
export class McpClient {
	readonly #process: ChildProcess;
	readonly #stdin: Writable;
	readonly #stdout: Readable;
	readonly #name: string;
	#nextId = 1;
	#buffer = "";
	#pending = new Map<number, PendingRequest>();
	#exitError: Error | undefined;
	/** True when the child exited through an intentional close(). */
	#exitClean = false;
	#exitWaiters: ((error: Error | undefined) => void)[] = [];
	#closed = false;

	/** @internal constructed by {@link connectMcpServer}. */
	constructor(name: string, child: ChildProcess) {
		this.#name = name;
		this.#process = child;
		if (child.stdin === null || child.stdout === null) {
			throw new Error(`mcp server "${name}" spawned without stdio`);
		}
		this.#stdin = child.stdin;
		this.#stdout = child.stdout;
		this.#stdout.setEncoding("utf8");
		this.#stdout.on("data", (chunk: string) => this.#onData(chunk));
		this.#stdout.on("error", () => this.#failExits()); // closed pipe: ignore
		// A broken stdin pipe (server died) must not crash the host with an
		// unhandled stream error; surface it as the exit error instead.
		this.#stdin.on("error", () => this.#failExits());
		this.#process.on("error", (error) => this.#setExitError(error));
		this.#process.on("exit", () => this.#setExitError(undefined));
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#buffer.slice(0, newline).trim();
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line === "") continue;
			this.#onLine(line);
		}
	}

	#onLine(line: string): void {
		let frame: JsonRpcFrame;
		try {
			frame = JSON.parse(line) as JsonRpcFrame;
		} catch {
			return; // a non-JSON line (server chatter) is not a protocol reply
		}
		if (frame.id === undefined || frame.id === null) {
			// A frame with no id is a server-initiated NOTIFICATION (a reply
			// always carries the request's id). A `notifications/progress`
			// frame whose `progressToken` names a PENDING request resets that
			// request's deadline — the server is alive and still working, so
			// a long job must not die at the deadline while it keeps
			// reporting progress. Every other notification is ignored.
			if (
				frame.method === "notifications/progress" &&
				isRecord(frame.params) &&
				typeof frame.params.progressToken === "number"
			) {
				this.#pending.get(frame.params.progressToken)?.resetTimeout();
			}
			return;
		}
		// A reply: its id must be one of ours (a notification is never a
		// reply, and a non-numeric id is not one of our requests).
		if (typeof frame.id !== "number") return;
		const pending = this.#pending.get(frame.id);
		if (pending === undefined) return;
		this.#pending.delete(frame.id);
		pending.clearTimeout();
		if (frame.error !== undefined) {
			pending.reject(
				new Error(
					`mcp server "${this.#name}" ${frame.error.message} (code ${frame.error.code})`,
				),
			);
		} else {
			pending.resolve(frame.result);
		}
	}

	#setExitError(error: Error | undefined): void {
		if (this.#exitError !== undefined) return;
		// An INTENTIONAL close() is a clean shutdown: resolve waiters with no
		// error (a close is a shutdown, never a failure).
		if (this.#closed) this.#exitClean = true;
		const waiters = this.#exitWaiters;
		this.#exitWaiters = [];
		if (!this.#exitClean) {
			this.#exitError =
				error ??
				new Error(
					`mcp server "${this.#name}" exited early (code ${
						this.#process.exitCode ?? "?"
					})`,
				);
		}
		for (const waiter of waiters) waiter(this.#exitError);
		this.#rejectPending();
	}

	#failExits(): void {
		// stdout closed: surface as an exit error if the process has not yet
		// reported one, so a hung `tools/call` unwinds.
		this.#setExitError(undefined);
	}

	#rejectPending(): void {
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const entry of pending) {
			entry.clearTimeout();
			entry.reject(this.#exitError ?? new Error("mcp server closed"));
		}
	}

	/** Write one frame as a single newline-terminated line. */
	#write(frame: JsonRpcFrame): void {
		if (this.#closed) throw new Error(`mcp server "${this.#name}" is closed`);
		this.#stdin.write(JSON.stringify(frame) + "\n");
	}

	/**
	 * Send a request and await its reply (id-correlated) under a per-request
	 * deadline. `timeoutSeconds` defaults to 60; the request's id is also the
	 * `progressToken` it advertises, so progress notifications can name it.
	 */
	#request(
		method: string,
		params: unknown,
		timeoutSeconds: number | undefined,
	): Promise<unknown> {
		const id = this.#nextId++;
		const seconds = timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
		return new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const entry: PendingRequest = {
				resolve,
				reject,
				// A progress notification naming this request id restarts the
				// deadline wait (the server is alive and still working).
				resetTimeout: () => {
					clearTimeout(timer);
					timer = setTimeout(deadline, seconds * 1000);
				},
				clearTimeout: () => {
					clearTimeout(timer);
					timer = undefined;
				},
			};
			const fail = (error: Error) => {
				this.#pending.delete(id);
				entry.clearTimeout();
				reject(error);
			};
			const deadline = () =>
				fail(
					new Error(
						`mcp server "${this.#name}" ${method} timed out after ${seconds}s`,
					),
				);
			this.#pending.set(id, entry);
			try {
				this.#write({
					jsonrpc: "2.0",
					id,
					method,
					params,
					_meta: { progressToken: id },
				});
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			timer = setTimeout(deadline, seconds * 1000);
			if (this.#exitError !== undefined) {
				// The server already died: unwind this request too.
				fail(this.#exitError);
			}
		});
	}

	/**
	 * The MCP handshake: `initialize` then `notifications/initialized`.
	 * The initialize reply is validated to carry the protocol version.
	 */
	async handshake(): Promise<void> {
		const result = (await this.#request(
			"initialize",
			{
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "sigrun-ext-mcp", version: "0.1.0" },
			},
			undefined,
		)) as { protocolVersion?: string } | undefined;
		if (typeof result?.protocolVersion !== "string") {
			throw new Error(
				`mcp server "${this.#name}" handshake reply lacks protocolVersion`,
			);
		}
		this.#write({ jsonrpc: "2.0", method: "notifications/initialized" });
	}

	/** Discover the server's tools (`tools/list`). */
	async listTools(): Promise<McpToolDefinition[]> {
		const result = (await this.#request("tools/list", undefined, undefined)) as {
			tools?: McpToolDefinition[];
		} | undefined;
		return result?.tools ?? [];
	}

	/** Execute one tool (`tools/call`); an `isError` result resolves (it is a
	 * valid tool outcome, not a protocol failure). `timeoutSeconds` caps the
	 * wait per request (default 60; progress notifications reset it). */
	async callTool(
		name: string,
		args: Record<string, unknown>,
		timeoutSeconds?: number,
	): Promise<McpToolResult> {
		const result = (await this.#request(
			"tools/call",
			{ name, arguments: args },
			timeoutSeconds,
		)) as McpToolResult | undefined;
		if (result === undefined) {
			throw new Error(
				`mcp server "${this.#name}" tools/call "${name}" returned no result`,
			);
		}
		return result;
	}

	/** Wait for the child to exit (used by tests / shutdown checks). */
	async exited(): Promise<Error | undefined> {
		if (this.#exitError !== undefined) return this.#exitError;
		if (this.#process.exitCode !== null || this.#process.signalCode !== null) {
			return undefined; // exited cleanly; already unwound pending
		}
		return new Promise((resolve) => {
			this.#exitWaiters.push(resolve);
		});
	}

	/** Kill the child and tear down (idempotent). */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#process.kill("SIGTERM");
		this.#rejectPending();
	}
}

/**
 * Spawn and connect one configured MCP server. Throws on spawn failure or a
 * failed handshake — per-server isolation is the CALLER's policy (the
 * extension connects all servers with `.catch` per server).
 */
export async function connectMcpServer(
	name: string,
	config: McpServerConfig,
): Promise<McpClient> {
	const child = spawn(config.command, [...config.args], {
		stdio: ["pipe", "pipe", "pipe"],
		// Token injection (ruling 3): a server with an oauth block AND a stored
		// token gets it as MCP_ACCESS_TOKEN, merged over the server's own env.
		env: { ...process.env, ...spawnEnvWithToken(name, config) },
	});
	const client = new McpClient(name, child);
	try {
		await client.handshake();
	} catch (cause) {
		client.close();
		child.kill("SIGKILL");
		throw cause instanceof Error
			? cause
			: new Error(`mcp server "${name}" handshake failed`);
	}
	return client;
}