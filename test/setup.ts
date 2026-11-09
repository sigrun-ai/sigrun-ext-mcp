/**
 * Suite-wide hermetic config root. The factory's legacy import resolves
 * SIGRUN_MCP_CONFIG before touching any store, and the CLI/token tests use
 * SIGRUN_CONFIG_DIR. Pin BOTH to a per-worker tmp dir so a test that
 * forgets an override can never read or write the developer's real
 * ~/.config/sigrun. Tests that exercise a fixture override and restore
 * these variables around the call.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = mkdtempSync(join(tmpdir(), "sigrun-ext-mcp-vitest-config-"));
process.env.SIGRUN_CONFIG_DIR = configDir;
process.env.SIGRUN_MCP_CONFIG = join(configDir, "no-legacy-mcp.json");
