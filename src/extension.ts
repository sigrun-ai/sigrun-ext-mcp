/** Catalog wiring: shared operator services remain system children, while
 * per-user entries connect and publish through the structural sigrun host. */

import { defineDoc, defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PromptInput } from "@earendil-works/pi-durable";
import { connectMcpServer, type McpClient } from "./client.js";
import {
	loadMcpConfig,
	MCP_CONFIG_ENV,
	resolveMcpConfigPath,
	serverEnabled,
	type McpOAuthConfig,
	type McpStdioServerConfig,
} from "./config.js";
import {
	createUserOauthFlows,
	exchangeCode,
	extractCode,
} from "./oauth.js";
import { storeUserMcpToken } from "./tokens.js";
import {
	MCP_SERVERS_SECTION_KEY,
	partitionForSection,
	renderMcpServersSection,
	type McpServerSectionEntry,
	type Reach,
} from "./section.js";
import {
	catalogEnabledFromSettings,
	createUserCatalog,
	sharedServerAllowed,
	discoverMcpTools,
	type CatalogSettingsSection,
	type OwnerEvent,
	type ServerExposure,
	type SigrunHost,
	type UserService,
} from "./user-servers.js";

export const MCP_EXTENSION_NAME = "sigrun.mcp";

/** Standalone tokens need no registry install; the kind/version must match
 * core's session-meta document so its committed owner is readable here. */
const SessionOwnerDoc = defineDoc<{ owner?: string }>({
	kind: "sigrun.session-meta",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({}),
});

export interface ExtensionRouteContribution {
	readonly method: "POST";
	readonly path: string;
	readonly auth: "user";
	handler(
		request: Request,
		ctx: { readonly principal?: { readonly user?: string }; readonly host: SigrunHost },
	): Promise<Response>;
}

export interface McpWiring {
	readonly extension: Extension;
	readonly perUserTools: boolean;
	readonly routes: readonly ExtensionRouteContribution[];
	readonly userServices: readonly UserService[];
	readonly surfaces: { readonly settings: readonly CatalogSettingsSection[] };
	conversationCreated(event: OwnerEvent): Promise<void>;
	runSettled(event: OwnerEvent): Promise<void>;
	onSettingsChanged(keys: readonly string[], user?: string): Promise<void>;
	/** Stop system clients immediately; per-user clients drain in-flight calls. */
	close(): Promise<void>;
	readonly ready: Promise<void>;
}

function denied(message: string) {
	return {
		output: [{ type: "text" as const, text: message }],
		isError: true,
	};
}

/** The shared tool wrapper is the authority boundary: registry visibility is
 * only convenience, and it cannot be bypassed by selecting an extension. */
function sharedTool(
	host: SigrunHost,
	name: string,
	server: Parameters<typeof sharedServerAllowed>[3],
	tool: ToolRegistration,
): ToolRegistration {
	return {
		...tool,
		execute: async (args, api, context) => {
			try {
				if (!(await sharedServerAllowed(host, api.conversationId, name, server))) {
					return denied(`MCP server "${name}" is not available for this user`);
				}
			} catch (cause) {
				return denied(
					`MCP server "${name}" access check failed: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
			}
			return tool.execute(args, api, context);
		},
	};
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

// The host parameter is REQUIRED: sigrun passes it only to factories whose
// length is greater than zero. An optional/defaulted parameter has length 0
// and would silently receive no host, disabling every per-user operation.
export function createMcpExtension(host: SigrunHost): McpWiring {
	// Pin the boot-selected path so policy reloads survive callers restoring
	// their process environment immediately after the factory returns.
	const configPath = resolveMcpConfigPath();
	const config = loadMcpConfig();
	const tools: ToolRegistration[] = [];
	const clients = new Map<string, McpClient>();
	const serverExposures = new Map<string, ServerExposure>();
	const shared = Object.entries(config.servers).filter(
		([, server]) => server.credentials === "shared" && serverEnabled(server),
	);
	const catalog = createUserCatalog(host, config.servers, config.userServers ?? "none");
	const oauthFlows = createUserOauthFlows();
	let closed = false;
	let liveUserServers = config.userServers ?? "none";
	let policyRefresh: Promise<void> = Promise.resolve();
	let policyErrorReported = false;
	const refreshPolicy = async (): Promise<void> => {
		// Lifecycle events are the production file-change signal: mcp.json is
		// operator configuration, not part of core's settings document.
		let next = liveUserServers;
		try {
			next = loadMcpConfig({
				...process.env,
				[MCP_CONFIG_ENV]: configPath,
			}).userServers ?? "none";
			policyErrorReported = false;
		} catch (cause) {
			// A transient operator edit must not suppress this event's user
			// reconciliation or discard the last known-good policy.
			if (!policyErrorReported) {
				policyErrorReported = true;
				console.warn(
					`mcp policy reload failed for ${configPath}; keeping ${liveUserServers}: ${errorMessage(cause)}`,
				);
			}
			return;
		}
		if (next === liveUserServers) return policyRefresh;
		liveUserServers = next;
		const chain = policyRefresh.then(
			() => catalog.reconcileAll(next),
			() => catalog.reconcileAll(next),
		);
		// Retain a settled recovery point: one failed reconcile must not
		// poison every subsequent activation with the same stale rejection.
		policyRefresh = chain.catch(() => undefined);
		await chain;
	};

	const pending: Promise<void>[] = [];
	for (const [name, server] of shared) {
		pending.push(
			(async () => {
				let client: McpClient;
				try {
					client = await connectMcpServer(name, server);
				} catch (cause) {
					console.warn(
						`mcp server "${name}" quarantined: ${errorMessage(cause)}`,
					);
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
					tools.push(
						...discovered.tools.map((tool) => sharedTool(host, name, server, tool)),
					);
					if (discovered.exposure !== undefined) {
						serverExposures.set(name, discovered.exposure);
					}
				} catch (cause) {
					clients.delete(name);
					client.close();
					console.warn(
						`mcp server "${name}" quarantined during discovery: ${errorMessage(cause)}`,
					);
				}
			})(),
		);
	}

	const activate = async (event: OwnerEvent): Promise<void> => {
		await refreshPolicy();
		if (event.owner !== undefined) await catalog.activate(event.owner);
	};

	const errorResponse = (status: number, error: string): Response =>
		Response.json({ error }, { status });
	const serverFromRequest = (request: Request): string | undefined => {
		const match = new URL(request.url).pathname.match(
			/\/v1\/ext\/sigrun-mcp\/oauth\/([^/]+)\/(?:start|complete)$/,
		);
		if (match === null) return undefined;
		try {
			return decodeURIComponent(match[1]);
		} catch {
			return undefined;
		}
	};
	const oauthServer = (name: string | undefined):
		| (McpStdioServerConfig & { readonly oauth: McpOAuthConfig })
		| undefined => {
		if (name === undefined) return undefined;
		const server = config.servers[name];
		if (
			server === undefined ||
			server.credentials === "shared" ||
			!serverEnabled(server) ||
			!("oauth" in server) ||
			server.oauth === undefined
		) return undefined;
		return { ...server, oauth: server.oauth };
	};
	const userFrom = (ctx: { readonly principal?: { readonly user?: string } }) =>
		ctx.principal?.user;

	const routes: readonly ExtensionRouteContribution[] = [
		{
			method: "POST",
			path: "oauth/:server/start",
			auth: "user",
			handler: async (request, ctx) => {
				const user = userFrom(ctx);
				if (user === undefined) return errorResponse(400, "no_pending_flow");
				const name = serverFromRequest(request);
				const server = oauthServer(name);
				if (name === undefined || server === undefined) {
					return errorResponse(404, "unknown_server");
				}
				// No listener: the browser is redirected back to the complete
				// endpoint, whose URL the user can paste from the address bar.
				const redirectUri = new URL(
					`/v1/ext/sigrun-mcp/oauth/${encodeURIComponent(name)}/complete`,
					request.url,
				).toString();
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
				if (user === undefined) return errorResponse(400, "no_pending_flow");
				const name = serverFromRequest(request);
				const server = oauthServer(name);
				if (name === undefined || server === undefined) {
					return errorResponse(404, "unknown_server");
				}
				let redirectedUrl: string;
				try {
					const body: unknown = await request.json();
					if (
						typeof body !== "object" || body === null || Array.isArray(body) ||
						!("redirectedUrl" in body) ||
						typeof body.redirectedUrl !== "string" || body.redirectedUrl === ""
					) throw new Error("invalid body");
					redirectedUrl = body.redirectedUrl;
				} catch {
					return errorResponse(400, "invalid_body");
				}
				const flow = oauthFlows.take(user, name);
				if (flow === undefined) return errorResponse(400, "no_pending_flow");
				let code: string;
				try {
					const extracted = extractCode(redirectedUrl);
					if (!("code" in extracted)) throw new Error("authorization failed");
					code = extracted.code;
				} catch {
					oauthFlows.release(user, name, flow);
					return errorResponse(400, "invalid_redirect");
				}
				let token: Awaited<ReturnType<typeof exchangeCode>>;
				try {
					token = await exchangeCode(server.oauth, code, flow.redirectUri, flow.verifier);
				} catch {
					return errorResponse(502, "exchange_failed");
				}
				await storeUserMcpToken(ctx.host, user, name, token.access_token);
				await catalog.retire(user, name);
				await catalog.activate(user);
				return new Response(null, { status: 204 });
			},
		},
	];

	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		process.off("exit", closeSystemClients);
		for (const client of clients.values()) client.close();
		clients.clear();
		tools.length = 0;
		serverExposures.clear();
		await Promise.all(pending);
		oauthFlows.clear();
		catalog.close();
	};

	const closeSystemClients = () => {
		for (const client of clients.values()) client.close();
		clients.clear();
		catalog.close();
	};
	process.on("exit", closeSystemClients);

	const mcpServersSection = async (
		input: PromptInput,
		context: Parameters<NonNullable<Extension["sections"]>[number]["render"]>[1],
	): Promise<string | undefined> => {
		let user: string | undefined;
		let settings: Record<string, unknown> | undefined;
		try {
			// PromptInput.read uses only committed harness state. The host identity
			// bridge is server-bound and may never resolve in harness-only boots.
			user = (await input.read.snapshot(SessionOwnerDoc, input.conversationId, context))?.owner;
			if (user !== undefined) {
				settings = await host.stores.user(user).settings.get();
			}
		} catch (cause) {
			console.warn(`mcp section access read failed: ${errorMessage(cause)}`);
			return undefined;
		}
		const reachable = new Map<string, ServerExposure>();
		for (const [name, server] of shared) {
			if (
				user !== undefined &&
				settings !== undefined &&
				(server.users === undefined || server.users.includes(user)) &&
				catalogEnabledFromSettings(name, server, settings)
			) {
				const exposure = serverExposures.get(name);
				if (exposure !== undefined) reachable.set(name, exposure);
			}
		}
		if (user !== undefined) {
			await catalog.activate(user);
			for (const [name, exposure] of catalog.exposures(user)) {
				reachable.set(name, exposure);
			}
		}
		const reaches = new Map<string, Reach>();
		for (const [name, mix] of reachable) {
			reaches.set(
				name,
				mix.codemode && mix.deferred
					? "either"
					: mix.codemode
						? "codemode"
						: "tool_search",
			);
		}
		const offers = new Set(input.agent.tools.map((tool) => tool.name));
		const { listed, unreachable } = partitionForSection(reaches, offers);
		const entries: McpServerSectionEntry[] = listed.map((name) => {
			const mix = reachable.get(name)!;
			return {
				name,
				description: mix.description,
				how:
					mix.codemode && mix.deferred
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
			if (keys.includes("userServers")) {
				// Server scope has no user argument: every active user must lose
				// newly disallowed tools, not just the user who wrote settings.
				await refreshPolicy();
				return;
			}
			if (
				user !== undefined &&
				(keys.includes("servers") || keys.some((key) => Object.hasOwn(config.servers, key)))
			) {
				await catalog.activate(user);
			}
			// The host has no settings-read hook. A visit that changes nothing
			// starts nothing; the committed write is the actionable trigger.
		},
		close,
		ready: Promise.all(pending).then(() => undefined),
	};
}
