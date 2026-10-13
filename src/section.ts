/**
 * The `mcp_servers` prompt section (spec slice 3): lists every enabled server
 * with codemode/deferred tools — name, description, and HOW its tools are
 * reached (`tool_search` loads deferred tools; codemode scripts call
 * codemode-exposed ones).
 *
 * Gating (rev 3's corrected channel — extensions have no boot hook, no
 * registry visibility, no args; the section render is the only per-request
 * seam): it reads `PromptInput.agent` at RENDER time. A server appears ONLY
 * when its discovery tool is model-offered in THIS request (`codemode` for
 * servers whose tools are script-reachable, `tool_search` for servers with
 * deferred tools — a server with both needs at least one of them). When
 * servers exist whose tools are unreachable through the offered set, one
 * notice line says so. Per-request, de-duplicated by construction, visible
 * to the model where it matters.
 *
 * Budget: the skills-section precedent — 4KB total including the truncation
 * notice, whole lines drop from the end until the text fits, the notice
 * names how many servers were cut.
 */

import type { PromptInput } from "@earendil-works/pi-durable";

/** The section key the server list renders under (Task 7 asserts this). */
export const MCP_SERVERS_SECTION_KEY = "mcp_servers";

/** Total rendered-section budget (skills-section precedent), notice included. */
export const MCP_SERVERS_SECTION_LIMIT_BYTES = 4096;

const SECTION_HEADER =
	"MCP servers with script-only or deferred tools. Tools on these servers are NOT offered to you directly:";

const ENABLE_NOTICE = (count: number) =>
	`(${count} server${count === 1 ? " has" : "s have"} script-only or deferred tools; enable codemode/tool_search in Settings → default tools to reach them)`;

/** One server's section entry (built at render time from live agent state). */
export interface McpServerSectionEntry {
	/** The configured server name (its tools register as `<name>/<tool>`). */
	readonly name: string;
	/** One line describing the server (from config or the connection). */
	readonly description: string;
	/** How the tools are reached: "codemode scripts" / "the tool_search tool". */
	readonly how: string;
}

/** Which discovery tool a server's exposure needs to be listed. */
export type Reach = "codemode" | "tool_search" | "either";

function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}

/**
 * Assemble the section text: the header plus one
 * `- name: description (reachable via ...)` line per server, capped at
 * {@link MCP_SERVERS_SECTION_LIMIT_BYTES} bytes including the truncation
 * notice. Whole lines drop from the end until the text fits; the notice
 * names how many servers were cut. Zero servers and zero unreachable
 * render no section at all.
 */
export function renderMcpServersSection(
	entries: readonly McpServerSectionEntry[],
	unreachableCount: number,
): string | undefined {
	if (entries.length === 0 && unreachableCount === 0) return undefined;
	// The unreachable-server notice always appends (count only).
	const notice =
		unreachableCount === 0
			? ""
			: `\n${ENABLE_NOTICE(unreachableCount)}`;
	if (entries.length === 0) {
		return notice.replace(/^\n/, "");
	}
	const header = `${SECTION_HEADER}\n\n`;
	const lines = entries.map(
		(entry) =>
			`- ${entry.name}: ${entry.description} (reachable via ${entry.how})`,
	);
	const body = header + lines.join("\n");
	if (byteLength(body + notice) <= MCP_SERVERS_SECTION_LIMIT_BYTES) {
		return body + notice;
	}
	// Over budget: drop whole lines from the end until it fits (the skills
	// section's idiom); the truncation notice names how many were cut.
	let kept = lines.length - 1;
	while (kept >= 0) {
		const dropped = lines.length - kept;
		const truncation = `\n(server list truncated: ${dropped} more not shown)`;
		const text = header + lines.slice(0, kept).join("\n") + truncation;
		if (byteLength(text + notice) <= MCP_SERVERS_SECTION_LIMIT_BYTES) {
			return text + notice;
		}
		kept -= 1;
	}
	// The header alone always fits (reached only if a header change ever
	// grows past the budget).
	return header.replace(/\s+$/, "");
}

/**
 * Partition live agent state for the section render: which configured
 * codemode/deferred servers are LISTED (their discovery tool is offered in
 * this request) and how many are unreachable (for the notice line).
 *
 * `offers` names the model-offered tool names in this request (from
 * `PromptInput.agent.tools`); `reaches` maps each configured server name to
 * the exposure mix its REGISTERED tools use (the extension computes this
 * snapshot from its live registrations).
 */
export function partitionForSection(
	serverReaches: ReadonlyMap<string, Reach>,
	offers: ReadonlySet<string>,
): { listed: string[]; unreachable: string[] } {
	const listed: string[] = [];
	const unreachable: string[] = [];
	for (const [name, reach] of serverReaches) {
		const ok =
			reach === "codemode"
				? offers.has("codemode")
				: reach === "tool_search"
					? offers.has("tool_search")
					: offers.has("codemode") || offers.has("tool_search");
		(ok ? listed : unreachable).push(name);
	}
	return { listed, unreachable };
}