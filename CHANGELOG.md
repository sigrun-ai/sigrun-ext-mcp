# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Changed
- **Upgrade behavior:** catalog servers now default to `credentials: "user"`.
  Existing installs that rely on one system-wide server must explicitly
  select `credentials: "shared"` and provide `sharedAuthority`. Shared MCP
  servers hand every permitted user's agent the admin's credential for that
  service.

### Fixed
- Catalog enablement now mounts through `surfaces.settings` and uses core's
  actual flat settings shape: each toggle and changed key is the bare server
  name. Shared-authority help is punctuated and guarded against missing
  programmatic input.
- Prompt sections resolve the conversation owner through the harness's
  committed-read surface instead of the server-bound identity bridge, so
  harness-only boots cannot hang while preparing a request.

### Added
- Per-user OAuth start/complete extension routes with ten-minute in-memory
  PKCE state scoped by user and server. Completion stores the raw access
  token in the caller's scoped secrets; the CLI refuses per-user servers.
- Token storage retires and reconnects the caller's catalog connection.
  Core owns the process lifecycle: a still-live child retains its original
  environment until idle-stop or exit because the host contract cannot force
  a relaunch.
- MCP catalog entries default to per-user credentials, with lazy per-user
  stdio services, scoped token injection, remote connections, and tools
  published only for their owner. Opt-in availability and per-user settings
  control enablement; disabling removes tools and drains active calls.
- Shared entries require `sharedAuthority`, retain system-tool behavior,
  and enforce their optional user allowlist and enablement at call time.
  Prompt sections list only servers available to the calling user.

### Security
- Stdio servers no longer inherit sigrun's environment. They are spawned
  with an allowlist (`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_*`, `TZ`,
  `TERM`, `USER`, `LOGNAME`, `SHELL`, `NPM_CONFIG_CACHE`,
  `SSH_AUTH_SOCK`) plus their configured `env` and stored token.
  Previously every server could read `SIGRUN_API_TOKEN`,
  `SIGRUN_PROXY_SECRET` and provider keys. A server that relied on an
  inherited variable must now list it in its `env`.

## [0.2.0] - 2026-10-22
### Added
- Remote MCP servers: a `servers` entry may be `{url, headers?, exposure?,
  toolExposure?, timeout?}` instead of a stdio `{command, args}`. Streamable
  HTTP is the transport (POST per frame, JSON or SSE reply,
  `mcp-session-id` captured and echoed); a legacy HTTP+SSE server is adopted
  automatically — whether it 404/405s the POST or (crawl4ai's shape) answers
  it with an `endpoint` event — so no supergateway-style adapter is needed.
- `mcp.json` now resolves from the sigrun config dir
  (`SIGRUN_CONFIG_DIR/mcp.json`) before the home fallback, matching every
  other sigrun store.

### Fixed
- SSE parsing handles CRLF line endings (the spec allows them; live servers
  emit them).
- Streamable replies stop at the id-matching frame — servers legitimately
  hold SSE streams open past the reply.

## [0.1.0] - 2026-10-13
### Added
- Renamed to `@sigrun/ext-mcp` for the 0.1.0 release (repo stays
  `sigrun-ai/sigrun-ext-mcp`): published package metadata
  (`publishConfig` access/provenance), host modules moved to
  `peerDependencies` mirrored in `devDependencies` at exact pins
  (`typebox` now declared — it was an undeclared host import),
  CHANGELOG.md joined the files whitelist, and a manifest hygiene check
  wired into `npm test`.
- MCP client over stdio: server discovery, tool registration (`<server>/<tool>`
  naming), OAuth (PKCE paste-the-URL flow) with a durable token store.
- The MCP exposure model on pi-durable 1.2.0: per-server
  `exposure: codemode|deferred|direct|hidden` (default `codemode`),
  per-tool `toolExposure` overrides (exact over patterns, first wins),
  `enabled`, and per-request `timeout` with progress-notification reset.
- The `mcp_servers` prompt section: live-rendered, 4KB whole-line-truncated,
  gated on the discovery tool being model-offered, with an honest
  enable-notice line for unreachable servers.
