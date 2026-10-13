# sigrun-ext-mcp

Register MCP server tools as pi-durable tools, named `<server>/<tool>`.

Config: `~/.config/sigrun/mcp.json` (or the `SIGRUN_MCP_CONFIG` env override
pointing at any path). Each entry under `"servers"` names a stdio MCP server:

```json
{
	"servers": {
		"github": {
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-github"],
			"exposure": "codemode",
			"timeout": 120
		}
	}
}
```

## Server fields

- `command`, `args` (required) — how to spawn the server.
- `env` — extra environment variables for the child process.
- `enabled` (default `true`) / `disabled` — skip the server entirely. Set one,
  never both: a server that is simultaneously on and off is a config error and
  fails loudly.
- `timeout` — per-request wire timeout in seconds (default `60`). A request
  that gets no reply by its deadline rejects. A server that keeps sending
  `notifications/progress` for a pending request never dies at the deadline
  while it keeps reporting work — progress resets the deadline.
- `exposure` — how the server's tools register (see below). Default `"codemode"`.
- `toolExposure` — per-tool overrides of `exposure`: an object mapping tool
  names (exact) or `*`-globs (e.g. `"get-*"`) to exposure words. An exact name
  always wins; among matching patterns the FIRST one in config order wins.
- `oauth` — the authorization-code (PKCE) flow block; see `sigrun-ext-mcp oauth
  <server>` (the CLI mints and stores a token; the spawn injects it).

## Exposure: how tools reach callers

On pi-durable 1.2.0 semantics, `"exposure"` decides who can call a server's
tools:

| exposure    | registration              | who can call                          |
| ----------- | ------------------------- | ------------------------------------- |
| `codemode`  | `callers: ["tools"]`      | scripts only (never model-offered)    |
| `deferred`  | `deferred: true`          | the model, once `tool_search` loads it |
| `direct`    | normal                    | the model (offered when in the set)   |
| `hidden`    | not registered            | nobody (config entry kept)            |

The `codemode-deferred` word is kept as an alias for `codemode` (pi compat).

### The default flip — a breaking change

**Before 1.2.0, an `mcp.json` server entry with no `exposure` field had its
tools offered to the model. Now the default is `"codemode"`:** a
default-exposure server's tools are callable by scripts (codemode), never
offered to the model directly. To restore the old behavior, set the server
(or the tool, via `toolExposure`) to `"exposure": "direct"`:

```json
{ "exposure": "direct" }
```

The `mcp_servers` system-prompt section lists codemode/deferred servers when
their discovery tool (`codemode`, `tool_search`) is offered in the request;
when such servers exist but their tools are unreachable, it appends one
notice line naming the count and the Settings → default tools fix.

## Tool naming: `<server>/<tool>` (decision)

Tools keep the existing `<server>/<tool>` shape rather than upstream pi's
`mcp__<server>__<tool>`:

- The upstream codemode section groups tools by `CodemodeNamespace.prefix`
  (longest match wins), and the namespaces are **config-side** — the host
  passes the groups, so any naming can namespace trivially: ours groups as
  `prefix: "<server>/"` with no rename at all.
- The name-addressed surface makes per-tool replacement and `toolExposure`
  patterns readable (`"github/*"`), and the existing wire name is already
  deployed in configs and scripts.

No section-rendering compat requires the upstream spelling; the decision is
recorded here per the spec's open item.

## Replacement semantics

Replacement works by not installing ours and installing yours: the
name-addressed tool surface (`<server>/<tool>`) makes per-name replacement
trivial. Co-installing this package with another that registers the same
tool names shadows silently (pi-durable resolves cross-extension duplicates
last-selected-wins, with no conflict signal) — **do not co-install**.