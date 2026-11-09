/**
 * Shared test harness: opens a REAL pi-durable Harness (registry + faux
 * provider) with the MCP extension installed against settings seeded in
 * the host double (settings rework, Task 11: the server registry lives in
 * settings; `mcp.json` exists only as the import source) — the same shape
 * as the other sigrun extension harnesses, no sigrun-core dependency
 * beyond the settings-schema helpers.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	createRegistry,
	Harness,
	type ModelRef,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MCP_CONFIG_ENV } from "../src/config.js";
import { createMcpExtension, type McpWiring } from "../src/extension.js";
import { createCatalogHost } from "./catalog-host.js";

/** Legacy fixture path: where a test that WANTS an mcp.json import writes
 * the file (SIGRUN_MCP_CONFIG points at it). Production reads settings. */
export function stubConfigPath(dir: string): string {
	return join(dir, "mcp.json");
}

/** Write a legacy mcp.json (the import source; tests that exercise the
 * import call this, everything else seeds shared settings). */
export async function writeConfig(
	path: string,
	servers: Record<string, unknown>,
): Promise<void> {
	// Legacy harness fixtures exercise system-child behavior. New catalog
	// fixtures set credentials explicitly instead of inheriting this default.
	const shared = Object.fromEntries(
		Object.entries(servers).map(([name, server]) => [
			name,
			{
				credentials: "shared",
				sharedAuthority: "Synthetic shared test authority",
				...(server as Record<string, unknown>),
			},
		]),
	);
	await writeFile(path, JSON.stringify({ servers: shared }), "utf8");
}

/** The settings-file spelling of a fixture server (transport inferred). */
export function settingsEntry(server: Record<string, unknown>): Record<string, unknown> {
	return {
		transport: "url" in server ? "url" : "command",
		...server,
	};
}

export interface OpenedHarness {
	readonly harness: Harness;
	readonly defaultModel: ModelRef;
	readonly wiring: McpWiring;
	readonly registry: ReturnType<typeof createRegistry>;
}

/** Open a real pi-durable harness with the MCP extension installed. */
export async function openMcpHarness(
	dir: string,
	responses: Parameters<
		ReturnType<typeof fauxProvider>["setResponses"]
	>[0] = [fauxAssistantMessage("no tools needed")],
): Promise<OpenedHarness> {
	let wiring: McpWiring;
	const double = createCatalogHost();
	// The fixture file is the fixture SOURCE, already transcribed into
	// shared settings above. Point the legacy-config env at a NONEXISTENT
	// path so the one-time import never fires on this path (and never
	// reads the developer's real ~/.config/sigrun/mcp.json).
	const prior = process.env[MCP_CONFIG_ENV];
	process.env[MCP_CONFIG_ENV] = join(dir, "no-legacy-config.json");
	try {
		double.actingUsers.set(ROOT_CONVERSATION_ID, "alice");
		const { readFile } = await import("node:fs/promises");
		const parsed = JSON.parse(
			await readFile(stubConfigPath(dir), "utf8"),
		) as { servers: Record<string, unknown> };
		// The registry lives in the extension's shared settings now.
		double.setSharedSettings({
			servers: Object.fromEntries(
				Object.entries(parsed.servers).map(([name, server]) => [
					name,
					settingsEntry(server as Record<string, unknown>),
				]),
			),
		});
		// Production reads the flat availability form: settings[serverName]
		// (see catalogEnabledFromSettings). The old nested {catalog: {...}}
		// seed was dead — nothing reads it.
		double.setSettings("alice", Object.fromEntries(
			Object.keys(parsed.servers).map((name) => [name, true]),
		));
		wiring = await createMcpExtension(double.host);
		// Mirror the core loader: the factory result's perUserTools field is
		// the declaration signal. createUserCatalog returns perUserTools: true;
		// the loader (or this double) must read it and declare. This is NOT
		// unconditional masking — it is the same conditional the loader uses.
		if (wiring.perUserTools) double.declarePerUserTools();
	} finally {
		if (prior === undefined) delete process.env[MCP_CONFIG_ENV];
		else process.env[MCP_CONFIG_ENV] = prior;
	}
	await wiring.ready; // tools present before the registry snapshot read

	const faux = fauxProvider({
		provider: "faux",
		models: [{ id: "m", contextWindow: 128_000 }],
	});
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const defaultModel: ModelRef = { provider: "faux", modelId: "m" };

	const registry = createRegistry();
	registry.install(wiring.extension);

	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dir, "sigrun.db")),
		{ models, registry },
		BACKGROUND_CONTEXT,
	);
	harness.resume();
	return { harness, defaultModel, wiring, registry };
}

/** Fresh temp dir; the test body receives it and must clean up. */
export async function tempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

export async function cleanupDir(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}
