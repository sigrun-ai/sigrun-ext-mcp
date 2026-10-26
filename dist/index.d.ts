/** sigrun-ext-mcp: register MCP server tools as pi-durable tools. */
export { createMcpExtension, MCP_EXTENSION_NAME } from "./extension.js";
export type { McpWiring } from "./extension.js";
export type { SigrunHost, UserService, ServiceSpec } from "./user-servers.js";
export { connectMcpServer, McpClient } from "./client.js";
export { loadMcpConfig, MCP_CONFIG_ENV, parseMcpConfig, resolveMcpConfigPath, } from "./config.js";
export type { McpConfig, McpOAuthConfig, McpServerConfig, } from "./config.js";
export { loadMcpTokens, MCP_ACCESS_TOKEN_ENV, parseMcpTokenStore, resolveMcpTokenPath, saveMcpTokens, spawnEnvWithToken, storeMcpToken, } from "./tokens.js";
export type { McpStoredToken, McpTokenStore } from "./tokens.js";
export { buildAuthorizeUrl, exchangeCode, extractCode, makePkcePair, startOauth, } from "./oauth.js";
export type { OauthFlow, StartOauthOptions } from "./oauth.js";
export { parseCliArgs, runCli } from "./cli.js";
import { createMcpExtension } from "./extension.js";
/** The required host parameter keeps this factory at arity one: sigrun's
 * loader does not pass a host to optional/defaulted (length-zero) factories. */
declare const _default: typeof createMcpExtension;
export default _default;
