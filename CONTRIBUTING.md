# Contributing to OrbCode

Thanks for your interest in contributing! This document explains how to get a dev environment running, the change workflow, and what we look for in a PR.

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Bug reports** — open an [issue](https://github.com/MatterAIOrg/orbcode/issues) using the bug template. Include OS, Node version, Claude Code version, and reproduction steps.
- **Feature requests** — open an issue using the feature template. Describe the use case before the proposed solution.
- **Pull requests** — see below.
- **Docs** — typo fixes and clarifications are welcome and don't need a prior issue.

## Development setup

Requirements:

- Node.js >= 20
- Claude Code (latest)
- A MatterAI account for end-to-end testing

```bash
git clone https://github.com/MatterAIOrg/orbcode.git
cd orbcode
npm install
```

Load the plugin from your local checkout:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:7856
claude --plugin-dir "$(pwd)"
```

Run `/orb-setup` inside the session to start the proxy and authenticate.

### Project layout

| Path | Purpose |
|------|---------|
| `.claude-plugin/` | Plugin and marketplace manifests |
| `scripts/orb-proxy.js` | Local HTTP proxy (port 7856) |
| `scripts/orb-mcp.js` | MCP server exposed to Claude Code |
| `scripts/orb-cli.js` | CLI used by slash commands |
| `scripts/session-start-hook.js` | Auto-starts the proxy on each session |
| `skills/` | Slash command definitions |
| `agents/` | Subagent definitions |
| `hooks/hooks.json` | Hook registrations |
| `src/indexer/` | Codebase indexer |

## Pull request workflow

1. Fork the repo and create a topic branch from `main`: `git checkout -b fix/proxy-timeout`.
2. Make your change. Keep PRs focused — one logical change per PR.
3. Test locally end-to-end (see Testing below).
4. Update `CHANGELOG.md` under `## [Unreleased]`.
5. If your change is user-facing, update the README.
6. Open a PR against `main` and fill out the template.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) where reasonable:

- `feat: add /orb-doctor command`
- `fix(proxy): handle 429 with exponential backoff`
- `docs: clarify headless setup`
- `chore: bump deps`

### Code style

- ES modules (`type: "module"`).
- No semicolons-only changes; preserve existing style in files you touch.
- Prefer small, well-named functions over comments.

## Testing

Before opening a PR:

1. `node scripts/orb-proxy.js` — confirm the proxy boots without errors.
2. In a real Claude Code session loaded against your branch, run `/orb-setup` then `/orb-status` and verify both succeed.
3. Exercise the path your change touches (login, indexer, MCP tool call, etc.).

When CI is added, all checks must pass before merge.

## Releasing (maintainers only)

1. Bump `version` in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and `package.json`.
2. Move `## [Unreleased]` entries in `CHANGELOG.md` under a new `## [x.y.z] - YYYY-MM-DD` heading.
3. Commit: `chore(release): vX.Y.Z`.
4. Tag and push: `git tag vX.Y.Z && git push origin main --tags`.
5. Create a GitHub Release with the changelog body.

## Reporting security issues

Do **not** open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
