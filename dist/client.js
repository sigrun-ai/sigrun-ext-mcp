/**
 * The MCP client: a transport-neutral JSON-RPC 2.0 engine plus two
 * transports.
 *
 * stdio (the original transport): newline-delimited JSON-RPC over a spawned
 * child's pipes. Remote (streamable HTTP): every request POSTs to the
 * configured URL; the reply is a JSON body OR an SSE stream. A server that
 * 404/405s the POST (the pre-2025-03-26 "HTTP+SSE" transport — still common,
 * e.g. many self-hosted servers) falls back to the legacy shape: a GET
 * stream for server→client frames and a discovered message endpoint for
 * client→server POSTs.
 *
 * Lifecycle (both transports): `initialize` handshake (protocolVersion
 * "2025-06-18", clientInfo, capabilities) → `notifications/initialized` →
 * `tools/list` (discovery) → `tools/call` (execution). Requests correlate
 * by id; the response frame's `id` must match a pending request (a
 * notification is never a reply). A connect failure rejects `connect`,
 * never affecting any other server (per-server isolation).
 *
 * Per-request timeout (codemode parity, spec slice 3): every request REJECTS
 * at its deadline (default 60s; config `timeout` per server) instead of
 * awaiting a hung server forever. A `notifications/progress` frame naming a
 * pending request's id (sent as the request's `progressToken`) RESETS that
 * request's deadline — a server that keeps reporting progress stays alive
 * as long as it works. A timeout rejects the call but never kills the
 * transport (per-server isolation: the next request gets a fresh chance).
 */
import { spawn } from "node:child_process";
import { serverSpawnEnv } from "./spawn-env.js";
import { DEFAULT_TIMEOUT_SECONDS } from "./config.js";
const MCP_PROTOCOL_VERSION = "2025-06-18";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * The JSON-RPC engine: id correlation, per-request deadlines, progress
 * resets, and the handshake/list/call methods. Transport-agnostic — frames
 * in, frames out, death unwinds pending.
 */
class McpEngine {
    #name;
    #transport;
    #nextId = 1;
    #pending = new Map();
    #dead;
    #closed = false;
    constructor(name, transport) {
        this.#name = name;
        this.#transport = transport;
    }
    /** A transport delivered one parsed frame (reply or notification). */
    handleFrame(frame) {
        if (frame.id === undefined || frame.id === null) {
            // A frame with no id is a server-initiated NOTIFICATION (a reply
            // always carries the request's id). A `notifications/progress`
            // frame whose `progressToken` names a PENDING request resets that
            // request's deadline — the server is alive and still working, so
            // a long job must not die at the deadline while it keeps
            // reporting progress. Every other notification is ignored.
            if (frame.method === "notifications/progress" &&
                isRecord(frame.params) &&
                typeof frame.params.progressToken === "number") {
                this.#pending.get(frame.params.progressToken)?.resetTimeout();
            }
            return;
        }
        // A reply: its id must be one of ours (a notification is never a
        // reply, and a non-numeric id is not one of our requests).
        if (typeof frame.id !== "number")
            return;
        const pending = this.#pending.get(frame.id);
        if (pending === undefined)
            return;
        this.#pending.delete(frame.id);
        pending.clearTimeout();
        if (frame.error !== undefined) {
            pending.reject(new Error(`mcp server "${this.#name}" ${frame.error.message} (code ${frame.error.code})`));
        }
        else {
            pending.resolve(frame.result);
        }
    }
    /** The transport died (once): unwind everything pending with the error. */
    handleDeath(error) {
        if (this.#dead !== undefined)
            return;
        this.#dead = error;
        const pending = [...this.#pending.values()];
        this.#pending.clear();
        for (const entry of pending) {
            entry.clearTimeout();
            entry.reject(error);
        }
    }
    /**
     * Send a request and await its reply (id-correlated) under a per-request
     * deadline. `timeoutSeconds` defaults to 60; the request's id doubles as
     * the `progressToken` it advertises (in `params._meta`, per the MCP
     * convention), so progress notifications can name it.
     */
    #request(method, params, timeoutSeconds) {
        if (this.#dead !== undefined)
            return Promise.reject(this.#dead);
        const id = this.#nextId++;
        const seconds = timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
        return new Promise((resolve, reject) => {
            let timer;
            const entry = {
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
            const fail = (error) => {
                this.#pending.delete(id);
                entry.clearTimeout();
                reject(error);
            };
            const deadline = () => fail(new Error(`mcp server "${this.#name}" ${method} timed out after ${seconds}s`));
            this.#pending.set(id, entry);
            // MCP convention: the progressToken rides in params._meta (a
            // spec-conforming server reads/echoes it from there). params is
            // merged (never mutated) so an object request keeps its fields;
            // a null-params request (tools/list) gets params just for _meta.
            const requestParams = isRecord(params)
                ? { ...params, _meta: { progressToken: id } }
                : { _meta: { progressToken: id } };
            this.#transport
                .send({ jsonrpc: "2.0", id, method, params: requestParams })
                .catch((cause) => {
                fail(cause instanceof Error ? cause : new Error(String(cause)));
                return;
            });
            timer = setTimeout(deadline, seconds * 1000);
        });
    }
    /**
     * The MCP handshake: `initialize` then `notifications/initialized`.
     * The initialize reply is validated to carry the protocol version.
     */
    async handshake() {
        const result = (await this.#request("initialize", {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "sigrun-ext-mcp", version: "0.2.0" },
        }, undefined));
        if (typeof result?.protocolVersion !== "string") {
            throw new Error(`mcp server "${this.#name}" handshake reply lacks protocolVersion`);
        }
        await this.#transport.send({
            jsonrpc: "2.0",
            method: "notifications/initialized",
        });
    }
    /** Discover the server's tools (`tools/list`). */
    async listTools() {
        const result = (await this.#request("tools/list", undefined, undefined));
        return result?.tools ?? [];
    }
    /** Execute one tool (`tools/call`); an `isError` result resolves (it is a
     * valid tool outcome, not a protocol failure). `timeoutSeconds` caps the
     * wait per request (default 60; progress notifications reset it). */
    async callTool(name, args, timeoutSeconds) {
        const result = (await this.#request("tools/call", { name, arguments: args }, timeoutSeconds));
        if (result === undefined) {
            throw new Error(`mcp server "${this.#name}" tools/call "${name}" returned no result`);
        }
        return result;
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#transport.close();
        this.handleDeath(new Error("mcp client closed"));
    }
}
// ---------------------------------------------------------------------------
// stdio transport (the original): today's behavior, moved verbatim in shape.
// ---------------------------------------------------------------------------
/** One connected stdio MCP server: a live child process speaking JSON-RPC. */
class StdioTransport {
    #engine;
    #process;
    #stdin;
    #stdout;
    #buffer = "";
    #closed = false;
    constructor(name, command, args, env) {
        // The engine is constructed with this transport; handleFrame/handleDeath
        // route the child's output back into it.
        this.#process = spawn(command, [...args], {
            stdio: ["pipe", "pipe", "pipe"],
            env,
        });
        this.#engine = new McpEngine(name, this);
        if (this.#process.stdin === null || this.#process.stdout === null) {
            this.#process.kill("SIGKILL");
            throw new Error(`mcp server "${name}" spawned without stdio`);
        }
        this.#stdin = this.#process.stdin;
        this.#stdout = this.#process.stdout;
        this.#stdout.setEncoding("utf8");
        this.#stdout.on("data", (chunk) => this.#onData(chunk));
        // A closed pipe is transport death (never an unhandled stream error).
        this.#stdout.on("error", () => this.#die());
        this.#stdin.on("error", () => this.#die());
        this.#process.on("error", (error) => this.#die(error));
        this.#process.on("exit", () => this.#die());
    }
    get engine() {
        return this.#engine;
    }
    #onData(chunk) {
        this.#buffer += chunk;
        for (;;) {
            const newline = this.#buffer.indexOf("\n");
            if (newline < 0)
                return;
            const line = this.#buffer.slice(0, newline).trim();
            this.#buffer = this.#buffer.slice(newline + 1);
            if (line === "")
                continue;
            let frame;
            try {
                frame = JSON.parse(line);
            }
            catch {
                continue; // a non-JSON line (server chatter) is not a protocol reply
            }
            this.#engine.handleFrame(frame);
        }
    }
    #die(error) {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#engine.handleDeath(error ??
            new Error(`mcp server exited early (code ${this.#process.exitCode ?? "?"})`));
    }
    send(frame) {
        if (this.#closed) {
            return Promise.reject(new Error("mcp stdio transport is closed"));
        }
        return new Promise((resolve, reject) => {
            this.#stdin.write(JSON.stringify(frame) + "\n", (error) => {
                if (error === undefined || error === null)
                    resolve();
                else
                    reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    }
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        this.#process.kill("SIGTERM");
        this.#engine.handleDeath(new Error("mcp client closed"));
    }
}
// ---------------------------------------------------------------------------
// Remote transport: streamable HTTP with a legacy-SSE fallback.
// ---------------------------------------------------------------------------
/**
 * Hand-rolled SSE parsing (no EventSource dependency — this is Node, and
 * the stream is a fetch body, not a DOM event target): buffer bytes, split
 * complete events on a blank line, read `data:` lines, JSON-parse each
 * data payload as one JSON-RPC message per event. Non-`message` event
 * names are read for transport control (the legacy `endpoint` event) and
 * otherwise ignored.
 */
class SseParser {
    #buffer = "";
    #pendingData = [];
    #pendingEvent = "";
    /** Feed bytes; emits complete parsed frames through `onFrame` and
     * legacy `endpoint` events through `onEndpoint`. */
    feed(chunk, onFrame, onEndpoint) {
        this.#buffer += chunk;
        for (;;) {
            // The SSE spec allows \r\n, \n, or \r line endings; live servers
            // (e.g. behind certain proxies) emit CRLF, so a plain \n\n split
            // never finds the event boundary. Normalize the whole buffer's line
            // endings FIRST, then split events on blank lines.
            this.#buffer = this.#buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
            const boundary = this.#buffer.indexOf("\n\n");
            if (boundary < 0)
                return;
            const raw = this.#buffer.slice(0, boundary);
            this.#buffer = this.#buffer.slice(boundary + 2);
            const dataLines = [];
            let eventName = "";
            for (const line of raw.split("\n")) {
                if (line.startsWith("data:")) {
                    // One leading space after the colon is per-spec optional.
                    const value = line.slice(5);
                    dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
                }
                else if (line.startsWith("event:")) {
                    const value = line.slice(6);
                    eventName = (value.startsWith(" ") ? value.slice(1) : value).trim();
                }
            }
            if (dataLines.length === 0)
                continue;
            const payload = dataLines.join("\n");
            if (eventName === "endpoint") {
                onEndpoint?.(payload.trim());
                continue;
            }
            try {
                onFrame(JSON.parse(payload));
            }
            catch {
                // A non-JSON data payload is not a protocol frame; skip it.
            }
        }
    }
}
/**
 * The remote transport. Starts in STREAMABLE mode: every frame POSTs to the
 * configured URL; replies arrive as the POST response body (JSON or SSE).
 * If the INITIAL POST answers 404/405 (a legacy HTTP+SSE server), the
 * transport switches to LEGACY mode: a long-lived GET SSE stream delivers
 * every server→client frame, and client→server frames POST to the message
 * endpoint the server announces via an `endpoint` event.
 */
class HttpTransport {
    #engine;
    #name;
    #url;
    #headers;
    /** Legacy mode's message endpoint (absolute); streamable mode's POST target stays #url. */
    #messageUrl;
    /** Streamable HTTP session id (echoed on every request once seen). */
    #sessionId;
    /** Legacy GET stream bookkeeping. */
    #getController;
    #mode = "streamable";
    #closed = false;
    constructor(name, config) {
        this.#name = name;
        this.#url = config.url;
        this.#headers = { ...(config.headers ?? {}) };
        this.#engine = new McpEngine(name, this);
    }
    get engine() {
        return this.#engine;
    }
    #requestHeaders(extra) {
        const headers = {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...this.#headers,
            ...extra,
        };
        if (this.#sessionId !== undefined) {
            headers["mcp-session-id"] = this.#sessionId;
        }
        return headers;
    }
    send(frame) {
        if (this.#closed) {
            return Promise.reject(new Error(`mcp server "${this.#name}" is closed`));
        }
        // A reply-bearing REQUEST: the reply may be the POST response body or
        // (legacy) arrive on the GET stream — this send resolves when the POST
        // is accepted; the ENGINE's pending entry settles when the frame lands.
        // A NOTIFICATION never expects a body reply (202/204 are fine).
        return this.#post(frame);
    }
    async #post(frame) {
        const url = this.#messageUrl ?? this.#url;
        const body = JSON.stringify(frame);
        const controller = new AbortController();
        const abortOnClose = () => controller.abort();
        this.#closeHooks.add(abortOnClose);
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: this.#requestHeaders({}),
                body,
                signal: controller.signal,
            });
            const sessionHeader = response.headers.get("mcp-session-id");
            if (sessionHeader !== null && sessionHeader !== "") {
                this.#sessionId = sessionHeader;
            }
            if (response.status === 404 || response.status === 405) {
                if (this.#mode === "streamable" && frame.method === "initialize") {
                    // The legacy negotiation point: only on the FIRST request.
                    // Later 404/405s are ordinary errors (below).
                    await this.#startLegacy();
                    // The initialize POST must now go to the legacy message
                    // endpoint; the endpoint event has set #messageUrl.
                    if (this.#messageUrl === undefined) {
                        throw new Error(`mcp server "${this.#name}" legacy SSE stream announced no endpoint`);
                    }
                    return this.#post(frame);
                }
                throw new Error(`mcp server "${this.#name}" POST ${url} failed: ${response.status} ${response.statusText}`);
            }
            if (!response.ok) {
                const snippet = (await response.text()).slice(0, 200);
                throw new Error(`mcp server "${this.#name}" POST ${url} failed: ${response.status} ${response.statusText} ${snippet}`.trim());
            }
            // A notification needs no body processing; a request's reply may
            // be here (streamable) or on the GET stream (legacy — where the
            // body is typically empty 202). 202/204 carry no reply body per
            // spec — and a legacy server may 202 WITHOUT ever ending the
            // response stream, so awaiting the body would hang: treat them as
            // accepted-and-done (the reply, if any, rides the GET stream).
            const contentType = response.headers.get("content-type") ?? "";
            if (response.status === 202 || response.status === 204) {
                // Nothing to read; cancel any body the server left open.
                response.body?.cancel().catch(() => {
                    // A cancel failure (already-closed stream) needs no handling.
                });
            }
            else if (contentType.includes("text/event-stream")) {
                // Streamable SSE: the reply to THIS request arrives as an event
                // on the response stream — but the stream legitimately STAYS OPEN
                // after it (the server may push notifications). Read until the
                // id-matching reply frame lands, then cancel the stream; a
                // notification POST (no id) has no reply to wait for, so it just
                // cancels. Reading past the reply would hang on servers that
                // hold the stream open (e.g. searmcp).
                //
                // LEGACY DETECTION (generalized): some legacy servers (crawl4ai's
                // shape) answer the initial POST itself with 200 + SSE + an
                // `endpoint` event — no 404/405 ever fires. The endpoint event is
                // unambiguous (streamable HTTP never sends one), so on the FIRST
                // request an endpoint event means legacy: adopt this stream as
                // the server→client channel and re-POST to the message endpoint.
                if (this.#mode === "streamable" && frame.method === "initialize") {
                    const legacy = await this.#maybeAdoptLegacyFromPost(response);
                    if (legacy) {
                        if (this.#messageUrl === undefined) {
                            throw new Error(`mcp server "${this.#name}" legacy SSE stream announced no endpoint`);
                        }
                        return this.#post(frame);
                    }
                    // Not legacy: fall through to the reply-wait drain.
                }
                const waitForId = typeof frame.id === "number" ? frame.id : undefined;
                await this.#drainSseBody(response, (parsed) => {
                    this.#engine.handleFrame(parsed);
                }, waitForId);
            }
            else if (frame.id !== undefined && frame.id !== null) {
                const text = await response.text();
                if (text !== "") {
                    try {
                        this.#engine.handleFrame(JSON.parse(text));
                    }
                    catch {
                        // A non-JSON body for a request is a protocol break on
                        // this reply; the engine's deadline will surface it.
                    }
                }
            }
            else {
                // Drain (and discard) notification bodies.
                await response.text().catch(() => "");
            }
        }
        finally {
            this.#closeHooks.delete(abortOnClose);
        }
    }
    /** On the INITIAL POST's SSE response: read events until either the
     * id-matching reply arrives (streamable — report not-legacy) or an
     * `endpoint` event appears (legacy — adopt the stream as the
     * server→client channel, set #messageUrl, report legacy). */
    async #maybeAdoptLegacyFromPost(response) {
        const parser = new SseParser();
        const reader = response.body?.getReader();
        if (reader === undefined)
            return false;
        const decoder = new TextDecoder();
        const self = this;
        let sawReply = false;
        const deliver = (parsed) => {
            if (parsed.id !== undefined && parsed.id !== null)
                sawReply = true;
            this.#engine.handleFrame(parsed);
        };
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                return false; // stream ended with no endpoint event
            let sawEndpoint = false;
            parser.feed(decoder.decode(value, { stream: true }), deliver, (endpoint) => {
                sawEndpoint = true;
                self.#messageUrl = new URL(endpoint, self.#url).toString();
            });
            if (sawEndpoint) {
                // Adopt this stream as the legacy server→client channel: legacy
                // mode from here; a background reader keeps feeding frames.
                this.#mode = "legacy";
                const controller = new AbortController();
                this.#getController = controller;
                const abortOnClose = () => controller.abort();
                this.#closeHooks.add(abortOnClose);
                const engine = this.#engine;
                void (async () => {
                    try {
                        for (;;) {
                            const next = await reader.read();
                            if (next.done)
                                break;
                            parser.feed(decoder.decode(next.value, { stream: true }), (frame2) => engine.handleFrame(frame2));
                        }
                        engine.handleDeath(new Error(`mcp server "${self.#name}" legacy SSE stream ended`));
                    }
                    catch (cause) {
                        if (self.#closed)
                            return;
                        engine.handleDeath(cause instanceof Error
                            ? cause
                            : new Error(`mcp server "${self.#name}" SSE stream failed`));
                    }
                })();
                return true;
            }
            if (sawReply)
                return false; // a reply already arrived: streamable
        }
    }
    /** Read a fetch response whose body is an SSE stream. When `waitForId`
     * is set, stop (cancel the stream) once a reply frame with that id has
     * been delivered — the streamable transport keeps streams open past the
     * reply; without a wait the stream reads to completion. */
    async #drainSseBody(response, onFrame, waitForId) {
        const parser = new SseParser();
        const reader = response.body?.getReader();
        if (reader === undefined)
            return;
        const decoder = new TextDecoder();
        let seen = false;
        const deliver = (frame) => {
            onFrame(frame);
            if (waitForId !== undefined && frame.id === waitForId) {
                seen = true;
            }
        };
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            parser.feed(decoder.decode(value, { stream: true }), deliver);
            if (seen) {
                await reader.cancel().catch(() => {
                    // Already-closed streams cancel noisily; harmless.
                });
                return;
            }
        }
        parser.feed(decoder.decode(), deliver);
    }
    /** Switch to the legacy transport: open the GET SSE stream and wait for
     * the server's `endpoint` event naming the message POST URL. */
    async #startLegacy() {
        this.#mode = "legacy";
        const controller = new AbortController();
        this.#getController = controller;
        const abortOnClose = () => controller.abort();
        this.#closeHooks.add(abortOnClose);
        const response = await fetch(this.#url, {
            method: "GET",
            headers: {
                accept: "text/event-stream",
                ...this.#headers,
            },
            signal: controller.signal,
        });
        if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
            controller.abort();
            throw new Error(`mcp server "${this.#name}" legacy SSE stream failed: ${response.status} ${response.statusText}`);
        }
        const sessionHeader = response.headers.get("mcp-session-id");
        if (sessionHeader !== null && sessionHeader !== "") {
            this.#sessionId = sessionHeader;
        }
        // Read the stream; the endpoint event flips #messageUrl, frames feed
        // the engine, stream end is transport death.
        const reader = response.body?.getReader();
        if (reader === undefined) {
            throw new Error(`mcp server "${this.#name}" legacy SSE stream has no body`);
        }
        const parser = new SseParser();
        const decoder = new TextDecoder();
        const engine = this.#engine;
        const self = this;
        // The endpoint usually arrives first; race a bounded wait so a
        // silent server cannot hang the connect forever (the engine's own
        // initialize deadline still applies on top).
        const endpointSeen = new Promise((resolveEndpoint) => {
            void (async () => {
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        parser.feed(decoder.decode(value, { stream: true }), (frame) => engine.handleFrame(frame), (endpoint) => {
                            self.#messageUrl = new URL(endpoint, self.#url).toString();
                            resolveEndpoint();
                        });
                    }
                    const tail = decoder.decode();
                    if (tail !== "") {
                        parser.feed(tail, (frame) => engine.handleFrame(frame), (endpoint) => {
                            self.#messageUrl = new URL(endpoint, self.#url).toString();
                            resolveEndpoint();
                        });
                    }
                    engine.handleDeath(new Error(`mcp server "${self.#name}" legacy SSE stream ended`));
                }
                catch (cause) {
                    if (self.#closed)
                        return; // our own abort: not a failure
                    engine.handleDeath(cause instanceof Error
                        ? cause
                        : new Error(`mcp server "${self.#name}" SSE stream failed`));
                }
            })();
        });
        // A 15s cap on waiting for the endpoint event — plenty for any
        // compliant server, and short enough to fail loud on a broken one.
        await Promise.race([
            endpointSeen,
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`mcp server "${this.#name}" legacy SSE stream announced no endpoint within 15s`)), 15_000)),
        ]);
    }
    #closeHooks = new Set();
    close() {
        if (this.#closed)
            return;
        this.#closed = true;
        for (const hook of this.#closeHooks)
            hook();
        this.#closeHooks.clear();
        this.#getController?.abort();
        this.#engine.handleDeath(new Error("mcp client closed"));
    }
}
/**
 * Spawn/connect one configured MCP server (stdio or remote by config
 * shape). Throws on spawn/connect failure or a failed handshake —
 * per-server isolation is the CALLER's policy (the extension connects all
 * servers with `.catch` per server).
 */
export async function connectMcpServer(name, config) {
    let engine;
    if ("url" in config) {
        const transport = new HttpTransport(name, config);
        engine = transport.engine;
    }
    else {
        // Never sigrun's own environment: an allowlist, the server's config
        // env, then its stored token as MCP_ACCESS_TOKEN (ruling 3).
        const env = serverSpawnEnv(name, config);
        const transport = new StdioTransport(name, config.command, config.args, env);
        engine = transport.engine;
    }
    try {
        await engine.handshake();
    }
    catch (cause) {
        engine.close();
        throw cause instanceof Error
            ? cause
            : new Error(`mcp server "${name}" handshake failed`);
    }
    return engine;
}
