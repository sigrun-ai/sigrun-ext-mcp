/** Catalog wiring: shared operator services remain system children, while
 * per-user entries connect and publish through the structural sigrun host. */
import { defineDoc, defineExtension } from "@earendil-works/pi-durable";
import { connectMcpServer } from "./client.js";
import { loadMcpConfig, serverEnabled, } from "./config.js";
import { createUserOauthFlows, exchangeCode, extractCode, } from "./oauth.js";
import { storeUserMcpToken } from "./tokens.js";
import { MCP_SERVERS_SECTION_KEY, partitionForSection, renderMcpServersSection, } from "./section.js";
import { catalogEnabledFromSettings, createUserCatalog, sharedServerAllowed, discoverMcpTools, } from "./user-servers.js";
export const MCP_EXTENSION_NAME = "sigrun.mcp";
/** Standalone tokens need no registry install; the kind/version must match
 * core's session-meta document so its committed owner is readable here. */
const SessionOwnerDoc = defineDoc({
    kind: "sigrun.session-meta",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({}),
});
function denied(message) {
    return {
        output: [{ type: "text", text: message }],
        isError: true,
    };
}
/** The shared tool wrapper is the authority boundary: registry visibility is
 * only convenience, and it cannot be bypassed by selecting an extension. */
function sharedTool(host, name, server, tool) {
    return {
        ...tool,
        execute: async (args, api, context) => {
            try {
                if (!(await sharedServerAllowed(host, api.conversationId, name, server))) {
                    return denied(`MCP server "${name}" is not available for this user`);
                }
            }
            catch (cause) {
                return denied(`MCP server "${name}" access check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
            }
            return tool.execute(args, api, context);
        },
    };
}
function errorMessage(cause) {
    return cause instanceof Error ? cause.message : String(cause);
}
// The host parameter is REQUIRED: sigrun passes it only to factories whose
// length is greater than zero. An optional/defaulted parameter has length 0
// and would silently receive no host, disabling every per-user operation.
export function createMcpExtension(host) {
    const config = loadMcpConfig();
    const tools = [];
    const clients = new Map();
    const serverExposures = new Map();
    const shared = Object.entries(config.servers).filter(([, server]) => server.credentials === "shared" && serverEnabled(server));
    const catalog = createUserCatalog(host, config.servers);
    const oauthFlows = createUserOauthFlows();
    let closed = false;
    const pending = [];
    for (const [name, server] of shared) {
        pending.push((async () => {
            let client;
            try {
                client = await connectMcpServer(name, server);
            }
            catch (cause) {
                console.warn(`mcp server "${name}" quarantined: ${errorMessage(cause)}`);
                return;
            }
            if (closed) {
                client.close();
                return;
            }
            clients.set(name, client);
            try {
                const discovered = await discoverMcpTools(name, server, client);
                if (closed) {
                    client.close();
                    return;
                }
                tools.push(...discovered.tools.map((tool) => sharedTool(host, name, server, tool)));
                if (discovered.exposure !== undefined) {
                    serverExposures.set(name, discovered.exposure);
                }
            }
            catch (cause) {
                clients.delete(name);
                client.close();
                console.warn(`mcp server "${name}" quarantined during discovery: ${errorMessage(cause)}`);
            }
        })());
    }
    const activate = async (event) => {
        if (event.owner !== undefined)
            await catalog.activate(event.owner);
    };
    const errorResponse = (status, error) => Response.json({ error }, { status });
    const serverFromRequest = (request) => {
        const match = new URL(request.url).pathname.match(/\/v1\/ext\/sigrun-mcp\/oauth\/([^/]+)\/(?:start|complete)$/);
        if (match === null)
            return undefined;
        try {
            return decodeURIComponent(match[1]);
        }
        catch {
            return undefined;
        }
    };
    const oauthServer = (name) => {
        if (name === undefined)
            return undefined;
        const server = config.servers[name];
        if (server === undefined ||
            server.credentials === "shared" ||
            !serverEnabled(server) ||
            !("oauth" in server) ||
            server.oauth === undefined)
            return undefined;
        return { ...server, oauth: server.oauth };
    };
    const userFrom = (ctx) => ctx.principal?.user;
    const routes = [
        {
            method: "POST",
            path: "oauth/:server/start",
            auth: "user",
            handler: async (request, ctx) => {
                const user = userFrom(ctx);
                if (user === undefined)
                    return errorResponse(400, "no_pending_flow");
                const name = serverFromRequest(request);
                const server = oauthServer(name);
                if (name === undefined || server === undefined) {
                    return errorResponse(404, "unknown_server");
                }
                // No listener: the browser is redirected back to the complete
                // endpoint, whose URL the user can paste from the address bar.
                const redirectUri = new URL(`/v1/ext/sigrun-mcp/oauth/${encodeURIComponent(name)}/complete`, request.url).toString();
                const url = oauthFlows.start(user, name, server.oauth, redirectUri);
                return Response.json({ url });
            },
        },
        {
            method: "POST",
            path: "oauth/:server/complete",
            auth: "user",
            handler: async (request, ctx) => {
                const user = userFrom(ctx);
                if (user === undefined)
                    return errorResponse(400, "no_pending_flow");
                const name = serverFromRequest(request);
                const server = oauthServer(name);
                if (name === undefined || server === undefined) {
                    return errorResponse(404, "unknown_server");
                }
                let redirectedUrl;
                try {
                    const body = await request.json();
                    if (typeof body !== "object" || body === null || Array.isArray(body) ||
                        !("redirectedUrl" in body) ||
                        typeof body.redirectedUrl !== "string" || body.redirectedUrl === "")
                        throw new Error("invalid body");
                    redirectedUrl = body.redirectedUrl;
                }
                catch {
                    return errorResponse(400, "invalid_body");
                }
                const flow = oauthFlows.take(user, name);
                if (flow === undefined)
                    return errorResponse(400, "no_pending_flow");
                let code;
                try {
                    const extracted = extractCode(redirectedUrl);
                    if (!("code" in extracted))
                        throw new Error("authorization failed");
                    code = extracted.code;
                }
                catch {
                    oauthFlows.release(user, name, flow);
                    return errorResponse(400, "invalid_redirect");
                }
                let token;
                try {
                    token = await exchangeCode(server.oauth, code, flow.redirectUri, flow.verifier);
                }
                catch {
                    return errorResponse(502, "exchange_failed");
                }
                await storeUserMcpToken(ctx.host, user, name, token.access_token);
                await catalog.retire(user, name);
                await catalog.activate(user);
                return new Response(null, { status: 204 });
            },
        },
    ];
    const close = async () => {
        if (closed)
            return;
        closed = true;
        process.off("exit", closeSystemClients);
        for (const client of clients.values())
            client.close();
        clients.clear();
        tools.length = 0;
        serverExposures.clear();
        await Promise.all(pending);
        oauthFlows.clear();
        catalog.close();
    };
    const closeSystemClients = () => {
        for (const client of clients.values())
            client.close();
        clients.clear();
        catalog.close();
    };
    process.on("exit", closeSystemClients);
    const mcpServersSection = async (input, context) => {
        let user;
        let settings;
        try {
            // PromptInput.read uses only committed harness state. The host identity
            // bridge is server-bound and may never resolve in harness-only boots.
            user = (await input.read.snapshot(SessionOwnerDoc, input.conversationId, context))?.owner;
            if (user !== undefined) {
                settings = await host.stores.user(user).settings.get();
            }
        }
        catch (cause) {
            console.warn(`mcp section access read failed: ${errorMessage(cause)}`);
            return undefined;
        }
        const reachable = new Map();
        for (const [name, server] of shared) {
            if (user !== undefined &&
                settings !== undefined &&
                (server.users === undefined || server.users.includes(user)) &&
                catalogEnabledFromSettings(name, server, settings)) {
                const exposure = serverExposures.get(name);
                if (exposure !== undefined)
                    reachable.set(name, exposure);
            }
        }
        if (user !== undefined) {
            await catalog.activate(user);
            for (const [name, exposure] of catalog.exposures(user)) {
                reachable.set(name, exposure);
            }
        }
        const reaches = new Map();
        for (const [name, mix] of reachable) {
            reaches.set(name, mix.codemode && mix.deferred
                ? "either"
                : mix.codemode
                    ? "codemode"
                    : "tool_search");
        }
        const offers = new Set(input.agent.tools.map((tool) => tool.name));
        const { listed, unreachable } = partitionForSection(reaches, offers);
        const entries = listed.map((name) => {
            const mix = reachable.get(name);
            return {
                name,
                description: mix.description,
                how: mix.codemode && mix.deferred
                    ? "codemode scripts and the tool_search tool"
                    : mix.codemode
                        ? "codemode scripts"
                        : "the tool_search tool",
            };
        });
        return renderMcpServersSection(entries, unreachable.length);
    };
    const extension = defineExtension({
        name: MCP_EXTENSION_NAME,
        tools,
        sections: [{ key: MCP_SERVERS_SECTION_KEY, render: mcpServersSection }],
    });
    return {
        extension,
        perUserTools: catalog.perUserTools,
        routes,
        userServices: catalog.userServices,
        surfaces: { settings: catalog.settings },
        conversationCreated: activate,
        runSettled: activate,
        onSettingsChanged: async (keys, user) => {
            // Core persists and reports flat form-field names. Only configured
            // server names trigger reconciliation; unrelated settings stay inert.
            if (user !== undefined &&
                keys.some((key) => Object.hasOwn(config.servers, key))) {
                await catalog.activate(user);
            }
            // The host has no settings-read hook. A visit that changes nothing
            // starts nothing; the committed write is the actionable trigger.
        },
        close,
        ready: Promise.all(pending).then(() => undefined),
    };
}
