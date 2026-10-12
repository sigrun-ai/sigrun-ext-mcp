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
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
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
	readonly result?: unknown;
	readonly error?: { code: number; message: string; data?: unknown };
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

/** One connected MCP server: a live child process speaking JSON-RPC. */
export class McpClient {
	readonly #process: ChildProcess;
	readonly #stdin: Writable;
	readonly #stdout: Readable;
	readonly #name: string;
	#nextId = 1;
	#buffer = "";
	#pending = new Map<
		number,
		{ resolve: (result: unknown) => void; reject: (error: Error) => void }
	>();
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
		if (typeof frame.id !== "number") {
			// Responses to notifications (and server-initiated notifications)
			// have no pending request to settle. A server REPLY always has an id
			// — a missing id means this frame is a notification, never a reply.
			return;
		}
		const pending = this.#pending.get(frame.id);
		if (pending === undefined) return;
		this.#pending.delete(frame.id);
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
			entry.reject(this.#exitError ?? new Error("mcp server closed"));
		}
	}

	/** Write one frame as a single newline-terminated line. */
	#write(frame: JsonRpcFrame): void {
		if (this.#closed) throw new Error(`mcp server "${this.#name}" is closed`);
		this.#stdin.write(JSON.stringify(frame) + "\n");
	}

	/** Send a request and await its reply (id-correlated). */
	async #request(method: string, params?: unknown): Promise<unknown> {
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			try {
				this.#write({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				this.#pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			if (this.#exitError !== undefined) {
				// The server already died: unwind this request too.
				const pending = this.#pending.get(id);
				if (pending !== undefined) {
					this.#pending.delete(id);
					pending.reject(this.#exitError);
				}
			}
		});
	}

	/**
	 * The MCP handshake: `initialize` then `notifications/initialized`.
	 * The initialize reply is validated to carry the protocol version.
	 */
	async handshake(): Promise<void> {
		const result = (await this.#request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "sigrun-ext-mcp", version: "0.1.0" },
		})) as { protocolVersion?: string } | undefined;
		if (typeof result?.protocolVersion !== "string") {
			throw new Error(
				`mcp server "${this.#name}" handshake reply lacks protocolVersion`,
			);
		}
		this.#write({ jsonrpc: "2.0", method: "notifications/initialized" });
	}

	/** Discover the server's tools (`tools/list`). */
	async listTools(): Promise<McpToolDefinition[]> {
		const result = (await this.#request("tools/list")) as {
			tools?: McpToolDefinition[];
		} | undefined;
		return result?.tools ?? [];
	}

	/** Execute one tool (`tools/call`); an `isError` result resolves (it is a
	 * valid tool outcome, not a protocol failure). */
	async callTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<McpToolResult> {
		const result = (await this.#request("tools/call", {
			name,
			arguments: args,
		})) as McpToolResult | undefined;
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
		env: { ...process.env, ...config.env },
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