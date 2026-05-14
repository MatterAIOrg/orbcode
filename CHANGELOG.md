# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-14

### Added

- Initial release of the OrbCode plugin for Claude Code
- Local proxy (`scripts/orb-proxy.js`) that intercepts Anthropic API calls and routes them through MatterAI's orbinference API
- MCP server (`scripts/orb-mcp.js`) exposing `semantic_code_search` tool for codebase lookup
- Session start/stop hooks for automatic proxy lifecycle management
- Slash commands: `/orb-setup`, `/orb-login`, `/orb-logout`, `/orb-status`, `/orb-update`
- Codebase indexer with file watching and vector search integration
- Plugin marketplace manifest for `matterai-marketplace`
