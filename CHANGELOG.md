# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-13
### Added
- MCP client over stdio: server discovery, tool registration (`<server>/<tool>`
  naming), OAuth (PKCE paste-the-URL flow) with a durable token store.
- The MCP exposure model on pi-durable 1.2.0: per-server
  `exposure: codemode|deferred|direct|hidden` (default `codemode`),
  per-tool `toolExposure` overrides (exact over patterns, first wins),
  `enabled`, and per-request `timeout` with progress-notification reset.
- The `mcp_servers` prompt section: live-rendered, 4KB whole-line-truncated,
  gated on the discovery tool being model-offered, with an honest
  enable-notice line for unreachable servers.
