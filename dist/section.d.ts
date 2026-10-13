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
/** The section key the server list renders under (Task 7 asserts this). */
export declare const MCP_SERVERS_SECTION_KEY = "mcp_servers";
/** Total rendered-section budget (skills-section precedent), notice included. */
export declare const MCP_SERVERS_SECTION_LIMIT_BYTES = 4096;
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
/**
 * Assemble the section text: the header plus one
 * `- name: description (reachable via ...)` line per server, capped at
 * {@link MCP_SERVERS_SECTION_LIMIT_BYTES} bytes including the truncation
 * notice. Whole lines drop from the end until the text fits; the notice
 * names how many servers were cut. Zero servers and zero unreachable
 * render no section at all.
 */
export declare function renderMcpServersSection(entries: readonly McpServerSectionEntry[], unreachableCount: number): string | undefined;
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
export declare function partitionForSection(serverReaches: ReadonlyMap<string, Reach>, offers: ReadonlySet<string>): {
    listed: string[];
    unreachable: string[];
};
