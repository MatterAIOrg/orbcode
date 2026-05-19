# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-05-19

### Added

- **Role persistence** — setup now asks for the user's tech role (Frontend, Backend, Full-stack, DevOps/SRE) and stores it in `~/.claude/orbcode/role.json`. The role is forwarded to the MatterAI backend on every inference request via the `x-orb-role` header.
- **Workspace environment snapshot** — new `scripts/orb-env.js` collector mirrors MatterCode's `<environment_details>` format. The proxy attaches a full workspace snapshot (git state, file tree, OS info, time) on every inference request, letting the backend inject context once per session.
- **Session-level deduplication** — per-session `firstRequest` flag is sent with each inference payload so the backend can skip redundant session-store lookups on subsequent turns.
- **API_TIMEOUT_MS configuration** — `orb-setup` now writes `API_TIMEOUT_MS=300000` (5 min) into `~/.claude/settings.json` alongside `ANTHROPIC_BASE_URL`.

### Changed

- **Proxy request timeout** increased from 30 s to 10 min to support extended thinking and long inference through the proxy chain.
- **Node.js server timeouts** bumped to 10 min (`requestTimeout`) and 60 s (`headersTimeout`) so the proxy itself doesn't drop long-running Claude Code sessions.

### Fixed

- **Double-response crashes** — proxy now guards against `ERR_HTTP_HEADERS_SENT` when an Anthropic request errors mid-stream by tracking `responseStarted`.
- **Proxy resilience** — added `clientError` handler for malformed/early-closed TCP connections and an `uncaughtException` safety net that logs and keeps the proxy alive instead of crashing mid-session.

## [0.1.0] - 2026-05-14

### Added

- Initial release of the OrbCode plugin for Claude Code
- Local proxy (`scripts/orb-proxy.js`) that intercepts Anthropic API calls and routes them through MatterAI's orbinference API
- MCP server (`scripts/orb-mcp.js`) exposing `semantic_code_search` tool for codebase lookup
- Session start/stop hooks for automatic proxy lifecycle management
- Slash commands: `/orb-setup`, `/orb-login`, `/orb-logout`, `/orb-status`, `/orb-update`
- Codebase indexer with file watching and vector search integration
- Plugin marketplace manifest for `matterai-marketplace`
