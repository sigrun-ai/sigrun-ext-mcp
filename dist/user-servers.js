/** Per-user catalog lifecycle and the structural sigrun host contract.
 * This package mirrors the host types instead of depending on sigrun, so it
 * remains independently buildable and installable. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, } from "@earendil-works/pi-durable";
import { connectMcpServer, } from "./client.js";
import { isStdioServer, resolveToolExposure, serverEnabled, } from "./config.js";
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
    const catalog = settings.catalog;
    if (catalog === undefined)
        return server.availability !== "opt-in";
    if (!isRecord(catalog))
        throw new Error("mcp user settings: catalog must be an object");
    const enabled = catalog[name];
    if (enabled === undefined)
        return server.availability !== "opt-in";
    if (typeof enabled !== "boolean") {
        throw new Error(`mcp user settings: catalog.${name} must be a boolean`);
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
export function createUserCatalog(host, servers) {
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
                    // exclusively the shared operator's credential path.
                    const token = await host.stores.user(user).secrets.get(`token:${name}`);
                    return {
                        command: server.command,
                        args: [...server.args],
                        env: {
                            ...server.env,
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
        const token = await host.stores.user(user).secrets.get(`token:${name}`);
        return await connectMcpServer(name, {
            ...server,
            headers: {
                ...server.headers,
                ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
            },
        });
    };
    const publish = (user, state) => {
        host.tools.setUserTools(user, personal.flatMap(([name]) => state.connections.get(name)?.registrations ?? []));
    };
    const refresh = async (user, ctx) => {
        const state = states.get(user);
        if (state === undefined || closed)
            return;
        const settings = await host.stores.user(user).settings.get();
        await Promise.all(personal.map(async ([name, server]) => {
            const enabled = catalogEnabledFromSettings(name, server, settings);
            const existing = state.connections.get(name);
            if (!enabled) {
                state.connections.delete(name);
                existing?.retire();
                return;
            }
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
    const enabledServers = Object.entries(servers).filter(([, server]) => serverEnabled(server));
    const settingsSections = enabledServers.length === 0
        ? []
        : [{
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
                            name: `catalog.${name}`,
                            label: name,
                            default: server.availability !== "opt-in",
                        })),
                    },
                },
            }];
    return {
        perUserTools: personal.length > 0,
        userServices,
        settingsSections,
        activate,
        exposures: (user) => new Map(personal.flatMap(([name]) => {
            const exposure = states.get(user)?.connections.get(name)?.exposure;
            return exposure === undefined ? [] : [[name, exposure]];
        })),
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
