# @sigrun/ext-mcp

Register MCP server tools as pi-durable tools, named `<server>/<tool>`.

Config: the sigrun config dir's `mcp.json` (`SIGRUN_CONFIG_DIR/mcp.json`; a
bare user install falls back to `~/.config/sigrun/mcp.json`; the
`SIGRUN_MCP_CONFIG` env override points at any path). Each entry under
`"servers"` names an MCP server — stdio or remote:

```json
{
	"servers": {
		"github": {
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-github"],
			"exposure": "codemode",
			"timeout": 120
		},
		"search": {
			"url": "https://mcp.example.test/mcp",
			"headers": { "Authorization": "Bearer <token>" },
			"exposure": "direct"
		}
	}
}
```

## Server fields

- `command`, `args` (stdio) — how to spawn the server.
- `url` (remote) — the server endpoint (http/https). Streamable HTTP is the
  transport; a legacy HTTP+SSE server (2024-11-05 shape — GET stream +
  `endpoint` event + message POSTs) is adopted automatically, so no adapter
  process is needed.
- `headers` (remote) — extra request headers (auth etc.), sent on every
  request. For per-user servers, configured `Authorization` is removed;
  only that user's scoped token supplies it.
- `env` (stdio) — extra environment variables for the child process. For
  per-user servers, configured `MCP_ACCESS_TOKEN` is removed; only that
  user's scoped token supplies it.
- `credentials` — `"user"` (default) or `"shared"`. User-credential servers
  start per user in the host's service jail; remote user servers connect
  with the user's scoped token. Existing installs needing one system-wide
  server must explicitly select `"shared"`.
- `sharedAuthority` — required, non-empty one-line reason when
  `credentials` is `"shared"`. Shared MCP servers hand every permitted
  user's agent the admin's credential for that service; the settings
  section displays this reason and warning beside the server.
- `users` — optional string allowlist for a shared server. Only those
  users may call its tools; this field is invalid for user-credential
  servers. Ownerless calls fail closed.
- `availability` — `"all"` (default) or `"opt-in"`. The per-user settings
  section stores each server's enablement as a flat boolean keyed by its
  bare server name. `"all"` starts enabled; `"opt-in"` starts disabled.
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
- `oauth` (stdio) — the authorization-code (PKCE) flow block; see
  `sigrun-ext-mcp oauth <server>` (the CLI mints and stores a token; the spawn
  injects it).

`userServers` is the separate admin policy for user-supplied servers:
`"none"` (default), `"remote"`, or `"all"`. It is distinct from the admin
catalog's `credentials` and `availability` fields above. Catalog names
starting `u_` are reserved for those user-supplied servers and rejected.

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
last-selected-wins) — **do not co-install**. Sigrun's extension loader
(made the shadowing visible at boot: it `console.warn`s once per duplicate
tool name, naming the extensions and the last-wins resolution) but the
warning changes nothing: last-wins stands. Replace, don't co-install.