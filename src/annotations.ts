/** The `mcp.toolAnnotations` published hook: a downstream safety extension
 * asks "what did this tool's server declare about it?" and this extension
 * answers from its live connection maps — the caller's per-user catalog
 * first, then shared servers the caller may reach, else unknown. */

import { Type, type Static } from "@earendil-works/pi-ai";
import type { PublishedHook, PublishedHookCall } from "@sigrun/sigrun/extension";
import type { McpServerConfig } from "./config.js";
import {
	sharedServerAllowed,
	type SigrunHost,
	type ToolAnnotationEntry,
	type UserCatalog,
} from "./user-servers.js";

const Input = Type.Object({
	tool: Type.String({ minLength: 1, maxLength: 512 }),
});

const Hints = Type.Object({
	readOnlyHint: Type.Optional(Type.Boolean()),
	destructiveHint: Type.Optional(Type.Boolean()),
	idempotentHint: Type.Optional(Type.Boolean()),
	openWorldHint: Type.Optional(Type.Boolean()),
});

const Output = Type.Union([
	Type.Object({
		server: Type.String(),
		mcpName: Type.String(),
		annotations: Hints,
	}),
	Type.Object({ unknown: Type.Literal(true) }),
]);

export type ToolAnnotationsPayload = Static<typeof Input>;
export type ToolAnnotationsResult =
	| ToolAnnotationEntry
	| { readonly unknown: true };

export const TOOL_ANNOTATIONS_HOOK = "mcp.toolAnnotations";

export function createToolAnnotationsHook(
	host: SigrunHost,
	catalog: UserCatalog,
	shared: ReadonlyMap<string, {
		readonly server: McpServerConfig;
		readonly annotations: ReadonlyMap<string, ToolAnnotationEntry>;
	}>,
): PublishedHook {
	const lookup = async (
		tool: string,
		call: PublishedHookCall,
	): Promise<ToolAnnotationsResult> => {
		if (call.user !== undefined) {
			const own = catalog.annotationsFor(call.user).get(tool);
			if (own !== undefined) return own;
			// Shared servers lend operator authority, so reachability is gated
			// by the acting user of the conversation; an unidentified caller
			// fails closed, matching sharedServerAllowed's own posture.
			if (call.conversationId !== undefined) {
				for (const [name, entry] of shared) {
					const found = entry.annotations.get(tool);
					if (found === undefined) continue;
					try {
						if (
							await sharedServerAllowed(
								host,
								call.conversationId,
								name,
								entry.server,
							)
						) {
							return found;
						}
					} catch {
						// A failed access check is not a reachability grant.
					}
				}
			}
		}
		return { unknown: true };
	};

	return {
		name: TOOL_ANNOTATIONS_HOOK,
		description:
			"Resolve a sigrun MCP tool name to its server-declared annotations.",
		input: Input,
		output: Output,
		run: async (payload, call) => {
			const { tool } = payload as ToolAnnotationsPayload;
			return await lookup(tool, call);
		},
	};
}
