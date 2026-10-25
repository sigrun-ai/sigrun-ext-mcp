/** Catalog wiring: shared operator services remain system children, while
 * per-user entries connect and publish through the structural sigrun host. */

import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PromptInput } from "@earendil-works/pi-durable";
import { connectMcpServer, type McpClient } from "./client.js";
import {
	loadMcpConfig,
	serverEnabled,
} from "./config.js";
import {
	MCP_SERVERS_SECTION_KEY,
	partitionForSection,
	renderMcpServersSection,
	type McpServerSectionEntry,
	type Reach,
} from "./section.js";
import {
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

export interface McpWiring {
	readonly extension: Extension;
	readonly perUserTools: boolean;
	readonly userServices: readonly UserService[];
	readonly settingsSections: readonly CatalogSettingsSection[];
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
	const config = loadMcpConfig();
	const tools: ToolRegistration[] = [];
	const clients = new Map<string, McpClient>();
	const serverExposures = new Map<string, ServerExposure>();
	const shared = Object.entries(config.servers).filter(
		([, server]) => server.credentials === "shared" && serverEnabled(server),
	);
	const catalog = createUserCatalog(host, config.servers);
	let closed = false;

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
		if (event.owner !== undefined) await catalog.activate(event.owner);
	};

	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		process.off("exit", closeSystemClients);
		for (const client of clients.values()) client.close();
		clients.clear();
		tools.length = 0;
		serverExposures.clear();
		await Promise.all(pending);
		catalog.close();
	};

	const closeSystemClients = () => {
		for (const client of clients.values()) client.close();
		clients.clear();
		catalog.close();
	};
	process.on("exit", closeSystemClients);

	const mcpServersSection = async (input: PromptInput): Promise<string | undefined> => {
		const user = await host.identity.actingUser(input.conversationId);
		const reachable = new Map<string, ServerExposure>();
		for (const [name, server] of shared) {
			if (
				user !== undefined &&
				(await sharedServerAllowed(host, input.conversationId, name, server))
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
		userServices: catalog.userServices,
		settingsSections: catalog.settingsSections,
		conversationCreated: activate,
		runSettled: activate,
		onSettingsChanged: async (keys, user) => {
			if (user !== undefined && keys.includes("catalog")) {
				await catalog.activate(user);
			}
			// The host has no settings-read hook. A visit that changes nothing
			// starts nothing; the committed write is the actionable trigger.
		},
		close,
		ready: Promise.all(pending).then(() => undefined),
	};
}
