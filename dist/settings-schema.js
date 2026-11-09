/**
 * The MCP extension's declared settings schemas (settings rework, Task 11):
 * the operator's server registry moves out of `mcp.json` into the shared
 * `servers` table (keyed by server name) plus the `userServers` policy,
 * and the per-user catalog toggles and user-defined servers move into
 * `userSchema`. Header and env VALUES are `writeOnly` — they live in the
 * secrets store under `servers/<name>/headers/<Header>` (resp. `env/<KEY>`),
 * never in the settings file.
 *
 * Authored as raw JSON Schema (the generator's contract), not TypeBox:
 * TypeBox 1.3's `Type.Object` wraps `additionalProperties` as a nested
 * property, which the generator cannot read as a table.
 *
 * The schema cannot express every config rule; `config.ts` keeps the
 * cross-field rules (shared credentials require a sharedAuthority, a users
 * allowlist only makes sense for shared entries, enabled/disabled must not
 * contradict, OAuth needs its three endpoints, only S256 PKCE is
 * implemented) applied after the checked read. The name rules (reserved
 * `servers`, no `u_` prefix, no `.` or `/`) are documented on
 * `propertyNames` for the form and enforced by the parser.
 */
const exposureChoice = {
    oneOf: [
        { const: "codemode", title: "Codemode (scripts only)" },
        { const: "deferred", title: "Deferred (tool_search)" },
        { const: "direct", title: "Direct (model-offered)" },
        { const: "hidden", title: "Hidden (not registered)" },
    ],
    default: "codemode",
};
const credentialsChoice = {
    oneOf: [
        { const: "user", title: "Per-user" },
        { const: "shared", title: "Shared operator authority" },
    ],
    default: "user",
};
const availabilityChoice = {
    oneOf: [
        { const: "all", title: "Enabled for everyone" },
        { const: "opt-in", title: "Opt-in per user" },
    ],
    default: "all",
};
/** Fields both transport variants carry (the checked read fills defaults). */
const commonFields = {
    credentials: credentialsChoice,
    sharedAuthority: {
        type: "string",
        description: "Why lending this shared authority to other users is acceptable (required for shared credentials).",
    },
    users: {
        type: "array",
        items: { type: "string", minLength: 1 },
        description: "Allowlist of directory users for a shared entry.",
    },
    availability: availabilityChoice,
    enabled: {
        type: "boolean",
        default: true,
        description: "Clear to skip this server entirely.",
    },
    exposure: exposureChoice,
    toolExposure: {
        type: "object",
        additionalProperties: exposureChoice,
        description: "Per-tool exposure overrides: exact tool names beat patterns; the first matching *-pattern wins.",
    },
    timeout: {
        type: "number",
        minimum: 0.001,
        description: "Per-request wire timeout in seconds (default 60).",
    },
};
const urlServer = {
    type: "object",
    title: "Remote (URL)",
    properties: {
        transport: { const: "url" },
        url: {
            type: "string",
            pattern: "^https?://",
            description: "The streamable-HTTP endpoint (legacy SSE negotiated on first contact).",
        },
        headers: {
            type: "object",
            additionalProperties: { type: "string", writeOnly: true },
            description: "Extra request headers; values are secrets stored in the secrets store.",
        },
        ...commonFields,
    },
};
const oauthGroup = {
    type: "object",
    title: "OAuth",
    properties: {
        authorizeUrl: {
            type: "string",
            description: "The authorization endpoint (browser).",
        },
        tokenUrl: { type: "string", description: "The token endpoint (code exchange)." },
        clientId: { type: "string", description: "The registered OAuth client id." },
        scopes: { type: "array", items: { type: "string" } },
        codeChallengeMethod: {
            type: "string",
            description: 'Only "S256" is implemented.',
        },
    },
};
const commandServer = {
    type: "object",
    title: "Stdio (command)",
    properties: {
        transport: { const: "command" },
        command: { type: "string", minLength: 1, description: "The executable to spawn." },
        args: { type: "array", items: { type: "string" }, default: [] },
        env: {
            type: "object",
            additionalProperties: { type: "string", writeOnly: true },
            description: "Extra environment for the child; values are secrets stored in the secrets store.",
        },
        oauth: oauthGroup,
        ...commonFields,
    },
};
const serverEntry = {
    oneOf: [urlServer, commandServer],
    "x-sigrun-summary": ["transport", "credentials", "exposure"],
};
/** The name rules today's parser enforces, documented for the form. */
const serverPropertyNames = {
    pattern: "^(?!servers$)(?!u_)[^./]+$",
    description: 'Server name: not the reserved "servers", no "u_" prefix, no "." or "/".',
};
const serversTable = {
    type: "object",
    additionalProperties: serverEntry,
    propertyNames: serverPropertyNames,
};
export const MCP_SETTINGS_JSON_SCHEMA = {
    type: "object",
    properties: {
        servers: {
            ...serversTable,
            default: {},
            description: "The operator's MCP server registry, keyed by server name.",
        },
        userServers: {
            oneOf: [
                { const: "none", title: "None (operator servers only)" },
                { const: "remote", title: "Remote (URL) servers" },
                { const: "all", title: "All (URL and stdio)" },
            ],
            default: "none",
            "x-sigrun-apply": "live",
            description: "Whether users may define their own MCP servers.",
        },
    },
};
/** Per-user settings: the user's own servers (the `u_`-prefixed catalog
 * entries' source). The per-operator-server toggles stay flat keys beside
 * it (catalogEnabledFromSettings); unknown keys survive schema saves. */
export const MCP_USER_JSON_SCHEMA = {
    type: "object",
    properties: {
        servers: {
            ...serversTable,
            default: {},
            "x-sigrun-apply": "live",
            description: "Your own MCP servers, keyed by server name.",
        },
    },
};
