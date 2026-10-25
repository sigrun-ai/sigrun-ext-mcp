/**
 * Shared test harness: opens a REAL pi-durable Harness (registry + faux
 * provider) with the MCP extension installed against a temp config — the
 * same shape as the other sigrun extension harnesses, no sigrun-core
 * dependency.
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

/** Configure the factory's config store via the env override. */
export function stubConfigPath(dir: string): string {
	return join(dir, "mcp.json");
}

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
	const prior = process.env[MCP_CONFIG_ENV];
	process.env[MCP_CONFIG_ENV] = stubConfigPath(dir);
	let wiring: McpWiring;
	try {
		const double = createCatalogHost();
		double.actingUsers.set(ROOT_CONVERSATION_ID, "alice");
		const { readFile } = await import("node:fs/promises");
		const parsed = JSON.parse(
			await readFile(stubConfigPath(dir), "utf8"),
		) as { servers: Record<string, unknown> };
		double.setSettings("alice", {
			catalog: Object.fromEntries(
				Object.keys(parsed.servers).map((name) => [name, true]),
			),
		});
		wiring = createMcpExtension(double.host);
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
