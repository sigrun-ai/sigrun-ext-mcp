/** Per-user catalog lifecycle and the structural sigrun host contract.
 * This package mirrors the host types instead of depending on sigrun, so it
 * remains independently buildable and installable. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, } from "@earendil-works/pi-durable";
import { connectMcpServer, } from "./client.js";
import { isStdioServer, parseMcpConfig, resolveToolExposure, serverEnabled, } from "./config.js";
function toContent(block) {
    return block.type === "text" && typeof block.text === "string"
        ? { type: "text", text: block.text }
        : { type: "text", text: JSON.stringify(block) };
}
/** The one discovery-to-registration mapping shared by system and user tools. */
export async function discoverMcpTools(name, server, client) {
    const discovered = await client.listTools();
    const tools = [];
    const mix = { codemode: false, deferred: false, count: 0 };
    for (const tool of discovered) {
        const exposure = resolveToolExposure(server, tool.name);
        if (exposure === "hidden")
            continue;
        if (exposure === "codemode")
            mix.codemode = true;
        if (exposure === "deferred")
            mix.deferred = true;
        mix.count += 1;
        // SAFETY: MCP advertises JSON Schema, which TypeBox accepts at runtime;
        // its structural inputSchema type is weaker than TSchema.
        const parameters = (tool.inputSchema !== undefined &&
            typeof tool.inputSchema === "object" &&
            tool.inputSchema !== null
            ? tool.inputSchema
            : { type: "object" });
        const exposureFlags = exposure === "codemode"
            ? { callers: ["tools"] }
            : exposure === "deferred"
                ? { deferred: true }
                : {};
        tools.push(defineTool({
            name: `${name}/${tool.name}`,
            description: tool.description !== undefined && tool.description !== ""
                ? tool.description
                : `MCP tool ${tool.name} on server ${name}.`,
            parameters: Type.Unsafe(parameters),
            // A tools/call round-trip is external I/O; never rerun on recovery.
            replay: "unsafe",
            ...exposureFlags,
            async execute(args) {
                const result = await client.callTool(tool.name, { ...args }, server.timeout);
                const blocks = result.content ?? [];
                const content = blocks.map(toContent);
                return {
                    output: content.length > 0
                        ? content
                        : [{ type: "text", text: JSON.stringify(result) }],
                    isError: result.isError === true,
                    // SAFETY: MCP results are JSON-compatible protocol values.
                    details: result,
                };
            },
        }));
    }
    if (mix.count === 0 || (!mix.codemode && !mix.deferred)) {
        return { tools, exposure: undefined };
    }
    const origin = isStdioServer(server)
        ? `${server.command} ${server.args.join(" ")}`.trim()
        : server.url;
    return {
        tools,
        exposure: {
            ...mix,
            description: `${mix.count} tool${mix.count === 1 ? "" : "s"} from ${origin}`,
        },
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function catalogEnabledFromSettings(name, server, settings) {
    // Settings surfaces persist form fields as top-level values; the server
    // name itself is the key, not a nested catalog object.
    const enabled = settings[name];
    if (enabled === undefined)
        return server.availability !== "opt-in";
    if (typeof enabled !== "boolean") {
        throw new Error(`mcp user settings: ${name} must be a boolean`);
    }
    return enabled;
}
export async function catalogEnabled(host, user, name, server) {
    return catalogEnabledFromSettings(name, server, await host.stores.user(user).settings.get());
}
export async function sharedServerAllowed(host, conversationId, name, server) {
    const user = await host.identity.actingUser(conversationId);
    // Shared tools lend operator authority: an unidentified caller fails closed
    // even without a users allowlist, rather than inheriting ambient authority.
    if (user === undefined)
        return false;
    if (server.users !== undefined && !server.users.includes(user))
        return false;
    return await catalogEnabled(host, user, name, server);
}
/** Retiring stops future calls immediately but defers close until active calls
 * finish. Reviving while draining is safe; retirement after drain is terminal. */
function trackConnection(name, client, discovered) {
    let active = 0;
    let retired = false;
    let closed = false;
    const unavailable = () => ({
        output: [{ type: "text", text: `MCP server "${name}" is disabled` }],
        isError: true,
    });
    const drain = () => {
        if (closed || !retired || active > 0)
            return;
        closed = true;
        client.close();
    };
    const registrations = discovered.tools.map((tool) => ({
        ...tool,
        execute: async (args, api, context) => {
            if (retired)
                return unavailable();
            active += 1;
            try {
                return await tool.execute(args, api, context);
            }
            finally {
                active -= 1;
                drain();
            }
        },
    }));
    return {
        registrations,
        exposure: discovered.exposure,
        retire: () => {
            retired = true;
            drain();
        },
        revive: () => {
            if (!closed)
                retired = false;
        },
        close: () => {
            if (closed)
                return;
            closed = true;
            client.close();
        },
    };
}
function errorMessage(cause) {
    return cause instanceof Error ? cause.message : String(cause);
}
export function userServerAllowed(kind, mode) {
    return kind === "url" ? mode !== "none" : mode === "all";
}
function userServersFromSettings(settings) {
    if (settings.servers === undefined)
        return {};
    // Reuse the wire validator so a user cannot supply fields or transports
    // that the operator registry would reject under a different code path.
    return parseMcpConfig(JSON.stringify({ servers: settings.servers }), "user settings servers").servers;
}
function sharedAuthorityHelp(reason) {
    const authority = reason?.trim() ?? "Shared authority was not stated.";
    const sentence = /[.!?]$/.test(authority) ? authority : `${authority}.`;
    return `${sentence} Shared MCP servers hand every permitted user's agent the admin's credential for that service.`;
}
export function createUserCatalog(host, servers, initialMode = "none") {
    let mode = initialMode;
    const states = new Map();
    const personal = Object.entries(servers).filter(([, server]) => server.credentials !== "shared" && serverEnabled(server));
    let closed = false;
    const userServices = personal.flatMap(([name, server]) => {
        if (!isStdioServer(server))
            return [];
        return [{
                name,
                start: async (user, _ctx) => {
                    if (!(await catalogEnabled(host, user, name, server)))
                        return undefined;
                    // Per-user tokens use only scoped secrets; the file store remains
                    // exclusively the shared operator's credential path. A configured
                    // token is shared configuration and must never become the fallback.
                    const env = Object.fromEntries(Object.entries(server.env ?? {}).filter(([key]) => key !== "MCP_ACCESS_TOKEN"));
                    const token = await host.stores.user(user).secrets.get(`token:${name}`);
                    return {
                        command: server.command,
                        args: [...server.args],
                        env: {
                            ...env,
                            ...(token === undefined ? {} : { MCP_ACCESS_TOKEN: token }),
                        },
                    };
                },
            }];
    });
    const connectPersonal = async (name, server, user, ctx) => {
        if (isStdioServer(server)) {
            const handle = await host.services.connect(name, user, ctx);
            try {
                return await connectMcpServer(name, server, handle);
            }
            catch (cause) {
                handle.release();
                throw cause;
            }
        }
        // Header names are case-insensitive; remove every configured spelling
        // so one user's missing token cannot fall back to another credential.
        const headers = Object.fromEntries(Object.entries(server.headers ?? {}).filter(([key]) => key.toLowerCase() !== "authorization"));
        const token = await host.stores.user(user).secrets.get(`token:${name}`);
        return await connectMcpServer(name, {
            ...server,
            headers: {
                ...headers,
                ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
            },
        });
    };
    const publish = (user, state) => {
        host.tools.setUserTools(user, [...state.connections.values()].flatMap((connection) => connection.registrations));
    };
    const refresh = async (user, ctx) => {
        const state = states.get(user);
        if (state === undefined || closed)
            return;
        let configured = {};
        const settings = await host.stores.user(user).settings.get();
        try {
            configured = userServersFromSettings(settings);
        }
        catch (cause) {
            console.warn(`mcp user "${user}" settings quarantined: ${errorMessage(cause)}`);
        }
        const activePersonal = personal.flatMap(([name, server]) => {
            try {
                return catalogEnabledFromSettings(name, server, settings) ? [[name, server]] : [];
            }
            catch (cause) {
                console.warn(`mcp server "${name}" settings quarantined for user "${user}": ${errorMessage(cause)}`);
                return [];
            }
        });
        const activeSupplied = Object.entries(configured).filter(([name, server]) => {
            if (!userServerAllowed(isStdioServer(server) ? "stdio" : "url", mode))
                return false;
            if (!isStdioServer(server))
                return true;
            // Dynamic user services cannot be represented by the static host
            // contract; never run the user's command in sigrun's own process.
            console.warn(`mcp server "${name}" for user "${user}" is a config error: the host declares per-user services statically at load and passes no server name to start, so a dynamic per-user stdio service cannot be launched`);
            return false;
        });
        const active = new Map([
            ...activePersonal,
            ...activeSupplied.map(([name, server]) => [`u_${name}`, { ...server, credentials: "user" }]),
        ]);
        for (const [name, connection] of state.connections) {
            if (active.has(name))
                continue;
            state.connections.delete(name);
            connection.retire();
        }
        await Promise.all([...active].map(async ([name, server]) => {
            const existing = state.connections.get(name);
            if (existing !== undefined) {
                existing.revive();
                return;
            }
            let client;
            try {
                client = await connectPersonal(name, server, user, ctx);
                if (closed) {
                    client.close();
                    return;
                }
                const connection = trackConnection(name, client, await discoverMcpTools(name, server, client));
                if (closed) {
                    connection.close();
                    return;
                }
                state.connections.set(name, connection);
            }
            catch (cause) {
                // Discovery can fail after the handshake owns a live service.
                client?.close();
                // One user's failed service is quarantined independently of every
                // other user and every other configured server.
                console.warn(`mcp server "${name}" quarantined for user "${user}": ${errorMessage(cause)}`);
            }
        }));
        if (!closed)
            publish(user, state);
    };
    const reconcileAll = async (nextMode) => {
        if (nextMode !== undefined)
            mode = nextMode;
        await Promise.all([...states.keys()].map((user) => activate(user)));
    };
    const activate = (user, ctx = { abortSignal: undefined }) => {
        if (closed)
            return Promise.resolve();
        let state = states.get(user);
        if (state === undefined) {
            state = { connections: new Map(), refresh: Promise.resolve() };
            states.set(user, state);
        }
        // Per-user serialization prevents discovery/settings races from creating
        // duplicate processes or republishing a disabled connection.
        const current = state.refresh.then(() => refresh(user, ctx), () => refresh(user, ctx));
        state.refresh = current;
        return current;
    };
    const retire = async (user, server) => {
        if (closed)
            return;
        const state = states.get(user);
        if (state === undefined)
            return;
        const current = state.refresh.then(async () => {
            if (closed)
                return;
            const connection = state.connections.get(server);
            if (connection === undefined)
                return;
            state.connections.delete(server);
            // Core owns the process lifecycle: releasing the last handle only
            // arms idle-stop. A live child keeps its old environment until that
            // timer fires or it crashes; this host contract cannot force a stop.
            connection.retire();
            publish(user, state);
        });
        state.refresh = current;
        await current;
    };
    const enabledServers = Object.entries(servers).filter(([, server]) => serverEnabled(server));
    const settings = mode === "none" ? [] : [{
            id: "user-servers",
            title: "Your MCP servers",
            scope: "user",
            form: {
                v: 1,
                root: {
                    type: "form",
                    id: "mcp-user-servers-form",
                    bind: "/settings",
                    mode: "submit",
                    onSubmit: "save",
                    children: [{
                            type: "textarea",
                            name: "servers",
                            label: "MCP server definitions",
                            default: {},
                            help: "Define MCP servers as a JSON object. Remote servers use url; stdio availability depends on the operator's userServers policy.",
                        }],
                },
            },
        }];
    if (enabledServers.length > 0) {
        settings.push({
            id: "catalog",
            title: "MCP servers",
            scope: "user",
            form: {
                v: 1,
                root: {
                    type: "form",
                    id: "mcp-catalog-form",
                    bind: "/settings",
                    mode: "submit",
                    onSubmit: "save",
                    children: enabledServers.map(([name, server]) => ({
                        type: "toggle",
                        name,
                        label: name,
                        default: server.availability !== "opt-in",
                        ...(server.credentials === "shared"
                            ? { help: sharedAuthorityHelp(server.sharedAuthority) }
                            : {}),
                    })),
                },
            },
        });
    }
    return {
        perUserTools: personal.length > 0,
        userServices,
        settings,
        activate,
        retire,
        reconcileAll,
        exposures: (user) => new Map([...(states.get(user)?.connections ?? [])].flatMap(([name, connection]) => connection.exposure === undefined ? [] : [[name, connection.exposure]])),
        close: () => {
            if (closed)
                return;
            closed = true;
            for (const state of states.values()) {
                for (const connection of state.connections.values())
                    connection.close();
                state.connections.clear();
            }
            states.clear();
        },
    };
}
