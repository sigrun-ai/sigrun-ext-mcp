/** Catalog wiring: shared operator services remain system children, while
 * per-user entries connect and publish through the structural sigrun host. */

import { defineDoc, defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PromptInput } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { connectMcpServer, type McpClient } from "./client.js";
import {
	normalizeMcpSettingsAliases,
	parseMcpSettings,
	DEFAULT_EXPOSURE,
	serverEnabled,
	type McpConfig,
	type McpOAuthConfig,
	type McpServerConfig,
	type McpStdioServerConfig,
} from "./config.js";
import {
	MCP_SETTINGS_JSON_SCHEMA,
	MCP_USER_JSON_SCHEMA,
} from "./settings-schema.js";
import {
	importMcpJsonIfPresent,
	MCP_IMPORT_NOTICE_KEY,
	type McpImportResult,
} from "./import.js";
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
	type OwnerEvent,
	type ServerExposure,
	type SigrunHost,
	type ToolAnnotationEntry,
	type UserService,
} from "./user-servers.js";
import { createToolAnnotationsHook } from "./annotations.js";
import type { PublishedHook } from "@sigrun/sigrun/extension";

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
	checkpointWhen: () => false,
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
	readonly publishedHooks: readonly PublishedHook[];
	conversationCreated(event: OwnerEvent): Promise<void>;
	runSettled(event: OwnerEvent): Promise<void>;
	onSettingsChanged(keys: readonly string[], user?: string): Promise<void>;
	/** The one-time mcp.json import (settings rework, Task 11): durable
	 * settings/secrets writes complete before the boot snapshot. Resolves
	 * to the imported server count (0 when there was nothing to import). */
	readonly imported: Promise<number>;
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

/** The settings handle the factory declared (per host; core permits
 * `settings.declare` only during the factory, so every later read
 * resolves the factory's handle rather than re-declaring). */
const declaredByHost = new WeakMap<SigrunHost, DeclaredSettingsHandle>();
type DeclaredSettingsHandle = ReturnType<
	import("@sigrun/sigrun/extension").SigrunHost["settings"]["declare"]
>;

/** Fold the legacy aliases into the stored settings ONCE at boot (a
 * settings migration): the schema cannot spell `disabled` or
 * `codemode-deferred`, so an unnormalized stored value would be repaired
 * away by the checked read. Writing the folded object back keeps every
 * later read on the declared handle (core's repair logging + admin
 * notice + secret fill), instead of a parallel local read path. */
async function foldStoredAliases(host: SigrunHost): Promise<void> {
	const stored = await host.stores.settings.get();
	const folded = normalizeMcpSettingsAliases(stored);
	if (JSON.stringify(folded) !== JSON.stringify(stored)) {
		await host.stores.settings.set(folded);
	}
}

/** The factory-window config read: raw scoped settings plus the scoped
 * secrets store, never the declared handle (a configured install is still
 * provisionally keyed until the loader resolves its final slug). Legacy
 * aliases fold before parsing; each stored header/env secret replaces its
 * file placeholder so imported credentials work on the FIRST boot. */
async function readBootMcpConfig(host: SigrunHost): Promise<McpConfig> {
	const stored = normalizeMcpSettingsAliases(
		structuredClone(await host.stores.settings.get()),
	);
	const servers = stored.servers;
	if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
		for (const [name, entry] of Object.entries(servers)) {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
			for (const field of ["headers", "env"] as const) {
				const table = (entry as Record<string, unknown>)[field];
				if (typeof table !== "object" || table === null || Array.isArray(table)) continue;
				for (const key of Object.keys(table)) {
					const value = await host.stores.secrets.get(`servers/${name}/${field}/${key}`);
					if (value !== undefined) (table as Record<string, unknown>)[key] = value;
				}
			}
		}
	}
	return parseMcpSettings(stored, "settings");
}

/** Read the operator config LIVE through the factory's declared handle
 * (defaults applied and secrets filled by core's checked read). */
export async function readMcpConfig(host: SigrunHost): Promise<McpConfig> {
	const declared = declaredByHost.get(host);
	if (declared === undefined) {
		throw new Error("readMcpConfig before the factory declared settings");
	}
	return parseMcpSettings((await declared.get()) as Record<string, unknown>, "settings");
}

// The host parameter is REQUIRED: sigrun passes it only to factories whose
// length is greater than zero. An optional/defaulted parameter has length 0
// and would silently receive no host, disabling every per-user operation.
export async function createMcpExtension(host: SigrunHost): Promise<McpWiring> {
	const declared = host.settings.declare({
		schema: MCP_SETTINGS_JSON_SCHEMA,
		userSchema: MCP_USER_JSON_SCHEMA,
	});
	declaredByHost.set(host, declared);
	// The one-time mcp.json import runs BEFORE the boot read (plain
	// scoped-store file I/O — safe before the bridge binds): an upgraded
	// install's servers are in settings when the connections are made.
	// Core seals declarations after loading; later reads see the imported
	// servers through the checked read. The alias fold precedes it so a
	// legacy-alias settings file is normalized before the import decides
	// whether servers exist.
	await foldStoredAliases(host);
	const imported: Promise<McpImportResult> = importMcpJsonIfPresent(host).catch((cause) => {
		console.warn(`mcp import failed: ${errorMessage(cause)}`);
		return { count: 0 };
	});
	// Boot stays OFF the declared handle: a configured package is still
	// provisionally keyed by its package name here, and a factory-time
	// declared read would fail the loader's final-slug check. Settings and
	// secrets are plain scoped file I/O, so this read is bridge-free. The
	// declared checked handle serves the post-boot mcp.servers hook and
	// OAuth routes; internal reconciliation uses the same bridge-free store
	// read so a settings-write fan-out never waits on the seam bridge.
	const importedResult = await imported;
	const config = await readBootMcpConfig(host);
	const tools: ToolRegistration[] = [];
	const clients = new Map<string, McpClient>();
	const serverExposures = new Map<string, ServerExposure>();
	const shared = Object.entries(config.servers).filter(
		([, server]) => server.credentials === "shared" && serverEnabled(server),
	);
	const sharedAnnotations = new Map<string, {
		readonly server: (typeof shared)[number][1];
		readonly annotations: ReadonlyMap<string, ToolAnnotationEntry>;
	}>();
	const catalog = createUserCatalog(host, config.servers, config.userServers ?? "none");
	const oauthFlows = createUserOauthFlows();
	let closed = false;
	let liveUserServers = config.userServers ?? "none";
	let policyRefresh: Promise<void> = Promise.resolve();
	const refreshPolicy = async (): Promise<void> => {
		// The userServers policy is a live settings field: every lifecycle
		// event re-reads the scoped settings + secrets stores. A transient
		// malformed stored value keeps the last known-good policy.
		let next = liveUserServers;
		try {
			next = (await readBootMcpConfig(host)).userServers ?? "none";
		} catch (cause) {
			console.warn(
				`mcp policy reload failed; keeping ${liveUserServers}: ${errorMessage(cause)}`,
			);
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
					sharedAnnotations.set(name, {
						server,
						annotations: discovered.annotations,
					});
					if (discovered.exposure !== undefined) {
						serverExposures.set(name, discovered.exposure);
					}
				} catch (cause) {
					clients.delete(name);
					sharedAnnotations.delete(name);
					client.close();
					console.warn(
						`mcp server "${name}" quarantined during discovery: ${errorMessage(cause)}`,
					);
				}
			})(),
		);
	}

	// The import's durable legs ran bridge-free in the factory. Its notice
	// is deferred until a post-open path: `ready` after discovery, or the
	// first lifecycle activation if the server bridge was not expected yet.
	// A headless boot without a server has no notice recipient surface.
	let importNoticePending = importedResult.notice !== undefined;
	let importNoticeErrorReported = false;
	const postImportNotice = async (): Promise<void> => {
		if (!importNoticePending) return;
		// Claim BEFORE the first await: ready and a lifecycle activation can
		// overlap in the same boot, and only one may post. A failure restores
		// the pending flag so the next activation can retry.
		importNoticePending = false;
		try {
			const admin = (await host.users.list()).find(
				(user) => user.admin === true,
			)?.user;
			if (admin === undefined) return;
			await host.notices.post({
				user: admin,
				key: MCP_IMPORT_NOTICE_KEY,
				...importedResult.notice!,
			});
		} catch (cause) {
			// Restore the claim: the next activation retries after a bridge
			// failure. Log once so a headless process does not spam.
			importNoticePending = true;
			if (!importNoticeErrorReported) {
				importNoticeErrorReported = true;
				console.warn(`mcp import notice failed: ${errorMessage(cause)}`);
			}
		}
	};

	const activate = async (event: OwnerEvent): Promise<void> => {
		await refreshPolicy();
		await postImportNotice();
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
	const oauthServer = async (name: string | undefined):
		Promise<(McpStdioServerConfig & { readonly oauth: McpOAuthConfig }) | undefined> => {
		if (name === undefined) return undefined;
		// Read fresh: a server's OAuth block added in settings must work
		// without a restart.
		const server = (await readMcpConfig(host)).servers[name];
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
				const server = await oauthServer(name);
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
				const server = await oauthServer(name);
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
		sharedAnnotations.clear();
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
		publishedHooks: [
			createToolAnnotationsHook(host, catalog, sharedAnnotations),
			createMcpServersHook(host),
		],
		conversationCreated: activate,
		runSettled: activate,
		onSettingsChanged: async (keys, user) => {
			if (user !== undefined) {
				try {
					const names = new Set([
						...Object.keys(config.servers),
						...Object.keys((await readBootMcpConfig(host)).servers),
					]);
					if (
						keys.includes("servers") ||
						keys.some((key) => names.has(key) || key.startsWith("servers."))
					) {
						await catalog.activate(user);
					}
				} catch (cause) {
					console.warn(
						`mcp settings reconciliation failed for user "${user}": ${errorMessage(cause)}`,
					);
				}
				return;
			}
			// The fan-out reaches every extension for EVERY scope, with keys
			// but no source slug. Only MCP's own fields are actionable; a
			// core or sibling-extension write must not trigger a registry
			// read/reconcile at all.
			if (
				!keys.includes("userServers") &&
				!keys.some((key) => key === "servers" || key.startsWith("servers."))
			) {
				return;
			}
			// An MCP operator write: reconcile the live userServers policy.
			// Known users are re-activated by refreshPolicy ONLY when the
			// policy value changed; boot-time shared stdio connections remain
			// a restart-apply surface.
			await refreshPolicy();
		},
		close,
		imported: Promise.resolve(importedResult.count),
		ready: Promise.all(pending).then(postImportNotice),
	};
}

/** The `mcp.servers` published hook (Task 11): codemode asks which MCP
 * server namespaces exist and how their tools are exposed. No input;
 * answered FRESH from settings on every call, so a settings change needs
 * no restart. */
export const MCP_SERVERS_HOOK = "mcp.servers";

const McpServersInput = Type.Object({});
const Exposure = Type.Union([
	Type.Literal("codemode"),
	Type.Literal("deferred"),
	Type.Literal("direct"),
	Type.Literal("hidden"),
]);
const McpServersOutput = Type.Object({
	servers: Type.Array(
		Type.Object({
			name: Type.String(),
			enabled: Type.Boolean(),
			exposure: Exposure,
			toolExposure: Type.Record(Type.String(), Exposure),
		}),
	),
});

function createMcpServersHook(host: SigrunHost): PublishedHook {
	return {
		name: MCP_SERVERS_HOOK,
		description:
			"List the configured MCP servers: name, resolved enabled flag, and exposure policy.",
		input: McpServersInput,
		output: McpServersOutput,
		run: async () => {
			const config = await readMcpConfig(host);
			return {
				servers: Object.entries(config.servers).map(([name, server]) => ({
					name,
					enabled: serverEnabled(server),
					exposure: server.exposure ?? DEFAULT_EXPOSURE,
					toolExposure: { ...(server.toolExposure ?? {}) },
				})),
			};
		},
	};
}
