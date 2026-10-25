/** Per-user catalog lifecycle and the structural sigrun host contract.
 * This package mirrors the host types instead of depending on sigrun, so it
 * remains independently buildable and installable. */

import { Type } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import {
	defineTool,
	type ConversationId,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	connectMcpServer,
	type McpClient,
	type McpServiceHandle,
} from "./client.js";
import {
	isStdioServer,
	resolveToolExposure,
	serverEnabled,
	type McpServerConfig,
} from "./config.js";
import type {
	McpContentBlock,
	McpToolResult,
} from "./types.js";

export interface HandlerContext {
	readonly abortSignal: AbortSignal | undefined;
}
export interface ServiceSpec {
	readonly command: string;
	readonly args: string[];
	readonly env?: Record<string, string>;
	readonly cwd?: string;
	readonly readPaths?: string[];
}
export interface UserService {
	readonly name: string;
	start(user: string, ctx: HandlerContext): Promise<ServiceSpec | undefined>;
	readonly idleMinutes?: number;
}
export interface ServiceHandle extends McpServiceHandle {
	readonly stderr: ReadableStream<Uint8Array>;
}
export interface SigrunHost {
	readonly tools: {
		setUserTools(user: string, tools: readonly ToolRegistration[]): void;
	};
	readonly services: {
		connect(name: string, user: string, ctx: HandlerContext): Promise<ServiceHandle>;
	};
	readonly stores: {
		user(user: string): {
			readonly secrets: {
				get(key: string): Promise<string | undefined>;
				set(key: string, value: string): Promise<void>;
				delete(key: string): Promise<void>;
			};
			readonly settings: {
				get(): Promise<Record<string, unknown>>;
				set(value: Record<string, unknown>): Promise<void>;
			};
			readonly paths: {
				readonly data: string;
				readonly state: string;
				readonly cache: string;
			};
		};
	};
	readonly identity: {
		actingUser(conversationId: ConversationId): Promise<string | undefined>;
	};
}
export interface OwnerEvent {
	readonly conversationId: ConversationId;
	readonly owner?: string;
}
export interface ServerExposure {
	readonly codemode: boolean;
	readonly deferred: boolean;
	readonly description: string;
	readonly count: number;
}
export interface DiscoveredTools {
	readonly tools: ToolRegistration[];
	readonly exposure: ServerExposure | undefined;
}

function toContent(block: McpContentBlock): { type: "text"; text: string } {
	return block.type === "text" && typeof block.text === "string"
		? { type: "text", text: block.text }
		: { type: "text", text: JSON.stringify(block) };
}

/** The one discovery-to-registration mapping shared by system and user tools. */
export async function discoverMcpTools(
	name: string,
	server: McpServerConfig,
	client: McpClient,
): Promise<DiscoveredTools> {
	const discovered = await client.listTools();
	const tools: ToolRegistration[] = [];
	const mix = { codemode: false, deferred: false, count: 0 };
	for (const tool of discovered) {
		const exposure = resolveToolExposure(server, tool.name);
		if (exposure === "hidden") continue;
		if (exposure === "codemode") mix.codemode = true;
		if (exposure === "deferred") mix.deferred = true;
		mix.count += 1;
		// SAFETY: MCP advertises JSON Schema, which TypeBox accepts at runtime;
		// its structural inputSchema type is weaker than TSchema.
		const parameters = (
			tool.inputSchema !== undefined &&
			typeof tool.inputSchema === "object" &&
			tool.inputSchema !== null
				? tool.inputSchema
				: { type: "object" }
		) as unknown as TSchema;
		const exposureFlags =
			exposure === "codemode"
				? { callers: ["tools"] as const }
				: exposure === "deferred"
					? { deferred: true as const }
					: {};
		tools.push(
			defineTool({
				name: `${name}/${tool.name}`,
				description:
					tool.description !== undefined && tool.description !== ""
						? tool.description
						: `MCP tool ${tool.name} on server ${name}.`,
				parameters: Type.Unsafe(parameters),
				// A tools/call round-trip is external I/O; never rerun on recovery.
				replay: "unsafe",
				...exposureFlags,
				async execute(args) {
					const result: McpToolResult = await client.callTool(
						tool.name,
						{ ...(args as Record<string, unknown>) },
						server.timeout,
					);
					const blocks = result.content ?? [];
					const content = blocks.map(toContent);
					return {
						output:
							content.length > 0
								? content
								: [{ type: "text" as const, text: JSON.stringify(result) }],
						isError: result.isError === true,
						// SAFETY: MCP results are JSON-compatible protocol values.
						details: result as unknown as import("@earendil-works/chord").JsonValue,
					};
				},
			}),
		);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function catalogEnabledFromSettings(
	name: string,
	server: McpServerConfig,
	settings: Record<string, unknown>,
): boolean {
	const catalog = settings.catalog;
	if (catalog === undefined) return server.availability !== "opt-in";
	if (!isRecord(catalog)) throw new Error("mcp user settings: catalog must be an object");
	const enabled = catalog[name];
	if (enabled === undefined) return server.availability !== "opt-in";
	if (typeof enabled !== "boolean") {
		throw new Error(`mcp user settings: catalog.${name} must be a boolean`);
	}
	return enabled;
}

export async function catalogEnabled(
	host: SigrunHost,
	user: string,
	name: string,
	server: McpServerConfig,
): Promise<boolean> {
	return catalogEnabledFromSettings(
		name,
		server,
		await host.stores.user(user).settings.get(),
	);
}

export async function sharedServerAllowed(
	host: SigrunHost,
	conversationId: ConversationId,
	name: string,
	server: McpServerConfig,
): Promise<boolean> {
	const user = await host.identity.actingUser(conversationId);
	// Shared tools lend operator authority: an unidentified caller fails closed
	// even without a users allowlist, rather than inheriting ambient authority.
	if (user === undefined) return false;
	if (server.users !== undefined && !server.users.includes(user)) return false;
	return await catalogEnabled(host, user, name, server);
}

interface CatalogConnection {
	readonly registrations: ToolRegistration[];
	readonly exposure: ServerExposure | undefined;
	retire(): void;
	revive(): void;
	close(): void;
}

/** Retiring stops future calls immediately but defers close until active calls
 * finish. Reviving while draining is safe; retirement after drain is terminal. */
function trackConnection(
	name: string,
	client: McpClient,
	discovered: DiscoveredTools,
): CatalogConnection {
	let active = 0;
	let retired = false;
	let closed = false;
	const unavailable = () => ({
		output: [{ type: "text" as const, text: `MCP server "${name}" is disabled` }],
		isError: true,
	});
	const drain = () => {
		if (closed || !retired || active > 0) return;
		closed = true;
		client.close();
	};
	const registrations = discovered.tools.map((tool) => ({
		...tool,
		execute: async (args: Parameters<ToolRegistration["execute"]>[0], api: Parameters<ToolRegistration["execute"]>[1], context: Parameters<ToolRegistration["execute"]>[2]) => {
			if (retired) return unavailable();
			active += 1;
			try {
				return await tool.execute(args, api, context);
			} finally {
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
			if (!closed) retired = false;
		},
		close: () => {
			if (closed) return;
			closed = true;
			client.close();
		},
	};
}

interface UserCatalogState {
	readonly connections: Map<string, CatalogConnection>;
	refresh: Promise<void>;
}
export interface CatalogSettingsSection {
	readonly id: string;
	readonly title: string;
	readonly scope: "user";
	readonly form: {
		readonly v: 1;
		readonly root: Record<string, unknown>;
	};
}
export interface UserCatalog {
	readonly perUserTools: boolean;
	readonly userServices: readonly UserService[];
	readonly settingsSections: readonly CatalogSettingsSection[];
	activate(user: string, ctx?: HandlerContext): Promise<void>;
	exposures(user: string): ReadonlyMap<string, ServerExposure>;
	close(): void;
}
function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function createUserCatalog(
	host: SigrunHost,
	servers: Readonly<Record<string, McpServerConfig>>,
): UserCatalog {
	const states = new Map<string, UserCatalogState>();
	const personal = Object.entries(servers).filter(
		([, server]) => server.credentials !== "shared" && serverEnabled(server),
	);
	let closed = false;
	const userServices = personal.flatMap(([name, server]) => {
		if (!isStdioServer(server)) return [];
		return [{
			name,
			start: async (user: string, _ctx: HandlerContext) => {
				if (!(await catalogEnabled(host, user, name, server))) return undefined;
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
		} satisfies UserService];
	});

	const connectPersonal = async (
		name: string,
		server: McpServerConfig,
		user: string,
		ctx: HandlerContext,
	): Promise<McpClient> => {
		if (isStdioServer(server)) {
			const handle = await host.services.connect(name, user, ctx);
			try {
				return await connectMcpServer(name, server, handle);
			} catch (cause) {
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

	const publish = (user: string, state: UserCatalogState) => {
		host.tools.setUserTools(
			user,
			personal.flatMap(([name]) => state.connections.get(name)?.registrations ?? []),
		);
	};

	const refresh = async (user: string, ctx: HandlerContext): Promise<void> => {
		const state = states.get(user);
		if (state === undefined || closed) return;
		const settings = await host.stores.user(user).settings.get();
		await Promise.all(
			personal.map(async ([name, server]) => {
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
				let client: McpClient | undefined;
				try {
					client = await connectPersonal(name, server, user, ctx);
					if (closed) {
						client.close();
						return;
					}
					const connection = trackConnection(
						name,
						client,
						await discoverMcpTools(name, server, client),
					);
					if (closed) {
						connection.close();
						return;
					}
					state.connections.set(name, connection);
				} catch (cause) {
					// Discovery can fail after the handshake owns a live service.
					client?.close();
					// One user's failed service is quarantined independently of every
					// other user and every other configured server.
					console.warn(
						`mcp server "${name}" quarantined for user "${user}": ${errorMessage(cause)}`,
					);
				}
			}),
		);
		if (!closed) publish(user, state);
	};

	const activate = (user: string, ctx: HandlerContext = { abortSignal: undefined }) => {
		if (closed) return Promise.resolve();
		let state = states.get(user);
		if (state === undefined) {
			state = { connections: new Map(), refresh: Promise.resolve() };
			states.set(user, state);
		}
		// Per-user serialization prevents discovery/settings races from creating
		// duplicate processes or republishing a disabled connection.
		const current = state.refresh.then(
			() => refresh(user, ctx),
			() => refresh(user, ctx),
		);
		state.refresh = current;
		return current;
	};

	const enabledServers = Object.entries(servers).filter(([, server]) => serverEnabled(server));
	const settingsSections: readonly CatalogSettingsSection[] =
		enabledServers.length === 0
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
		exposures: (user) => new Map(
			personal.flatMap(([name]) => {
				const exposure = states.get(user)?.connections.get(name)?.exposure;
				return exposure === undefined ? [] : [[name, exposure]];
			}),
		),
		close: () => {
			if (closed) return;
			closed = true;
			for (const state of states.values()) {
				for (const connection of state.connections.values()) connection.close();
				state.connections.clear();
			}
			states.clear();
		},
	};
}
