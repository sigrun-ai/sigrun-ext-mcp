# AGENTS.md — sigrun-ext-mcp

Guidance for coding agents working in this repository.

## What this is

MCP servers over stdio registered as `<server>/<tool>` tools. Per-server
`exposure` decides how tools register (`codemode` | `deferred` | `direct` |
`hidden`); an OAuth token store backs servers that need browser authorization
(see README.md for the exact shapes).

A [sigrun](https://github.com/sigrun-ai/sigrun) extension (pi-durable
loader contract): a default export or named factory consumed by sigrun's
extension loader. Small, single-purpose, no cross-extension coupling.

## Layout

- `src/index.ts` — public surface (re-exports the factory).
- `src/extension.ts` — the implementation (server wiring + tool registration).
- `src/client.ts` — minimal hand-rolled MCP stdio client (JSON-RPC 2.0).
- `src/config.ts` — per-server config (`exposure`, `toolExposure`, `timeout`).
- `src/oauth.ts` + `src/tokens.ts` — OAuth authorization-code flow + token store.
- `src/cli.ts` / `src/bin.ts` — the `sigrun-ext-mcp oauth <server>` CLI bin.
- `test/` — vitest suites.
- `dist/` — **committed build output** (git-source installs load
  `dist/index.js` with no build step). Rebuild with `npm run build` and
  commit whenever `src/` moves; a stale dist is ship-blocking.

## Run and test

```sh
npm install
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/ (commit the result)
```

## Conventions

- **Commit dist**: tracked by design (see the `.gitignore` comment). If
  `git status` shows `dist/` changes after a build, those belong in the
  same commit as the source change.
- **Verification before completion**: `npm test` + `npm run typecheck` +
  `npm run build` with a clean `git status -- dist` before claiming done.
- Tests own their literals: synthetic hosts (`example.invalid`), no real
  tokens or private URLs in fixtures.
