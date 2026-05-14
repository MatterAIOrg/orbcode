# OrbCode — MatterAI Plugin for Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen)](.nvmrc)
[![Marketplace](https://img.shields.io/badge/marketplace-matterai--marketplace-purple)](https://matterai.so)

Route all Claude Code inference through MatterAI for optimized API calls, cost control, and enhanced capabilities.

## How It Works

OrbCode runs a lightweight local proxy that intercepts every Anthropic API call:

```
Claude Code  →  Local Proxy (port 7856)  →  api.matterai.so/v1/orbinference
                                                     ↓
                                             Modified body + headers
                                                     ↓
                                              Anthropic API
                                                     ↓
                                    Claude Code  ←  Response
```

Before each inference call, the full request (messages, model, tools, headers) is sent to MatterAI's orbinference API. MatterAI returns potentially modified body and headers, which are then used to make the actual Anthropic call.

## Getting Started

### 1. Install

From inside a Claude Code session:

```
/plugin marketplace add AquaSecure/orbcode-plugin
/plugin install orb@matterai-marketplace
```

### 2. Setup

Run the setup command:

```
/orb-setup
```

This does three things in one shot:

- Starts the local proxy daemon on port 7856
- Opens your browser to authenticate with MatterAI (skipped if already logged in)
- Starts the codebase indexer in the background after auth

`ANTHROPIC_BASE_URL` is set automatically by the plugin's `settings.json` — no shell-profile edits required.

**Headless / SSH?** Pass the token directly:

```
/orb-setup --token '<your-access-token>'
```

### 3. Restart Claude Code

Quit your current session and launch Claude Code again:

```bash
claude
```

### 4. Verify

Run `/orb-status` to check everything is connected:

```
/orb-status
```

You should see:

- Authentication: ✅ Logged in
- Proxy: ✅ Running
- ANTHROPIC_BASE_URL: ✅ Set

## Commands

| Command           | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `/orb-setup`      | Full bootstrap — starts proxy, authenticates, starts indexer |
| `/orb-login`      | Re-authenticate (used when logged out or token expired)      |
| `/orb-logout`     | Clear stored credentials                                     |
| `/orb-status`     | Check auth & proxy status                                    |
| `/orb-update`     | Update to latest plugin version                              |
| `/reload-plugins` | Reload plugins after updates                                 |

## Architecture

### Local Proxy (`scripts/orb-proxy.js`)

A Node.js HTTP server running on `127.0.0.1:7856` that:

1. Receives Anthropic API requests from Claude Code (via `ANTHROPIC_BASE_URL`)
2. Sends the complete request (body + headers) to `api.matterai.so/v1/orbinference`
3. Receives modified body + headers from MatterAI
4. Forwards the modified request to the real Anthropic API
5. Streams the response back to Claude Code

The proxy auto-starts on each Claude Code session via the SessionStart hook.

### Authentication

Tokens are stored in `~/.claude/orbcode/auth.json` and used as Bearer tokens for the orbinference API.

### Environment

| Variable             | Purpose                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_BASE_URL` | Points Claude Code to the local proxy — set automatically via the plugin's `settings.json` `env` block; applied on each Claude Code session start |
| `CLAUDE_PLUGIN_ROOT` | Set automatically by Claude Code                                                                                                                  |

## Development

Load the plugin from a local directory:

```bash
claude --plugin-dir /path/to/orbcode
```

Make sure `ANTHROPIC_BASE_URL` is set in your env for the proxy to work:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:7856
claude --plugin-dir /path/to/orbcode
```

## Requirements

- Node.js >= 20
- Claude Code
- MatterAI account

## Contributing

We welcome contributions! Please read our [Contributing Guide](CONTRIBUTING.md) and [Code of Conduct](CODE_OF_CONDUCT.md) before opening issues or pull requests.

## Security

If you discover a security vulnerability, please follow our [Security Policy](SECURITY.md) and report it privately to **support@matterai.so**.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a history of changes.

## License

[MIT](LICENSE)

## Support

- Website: [matterai.so](https://matterai.so)
- Email: support@matterai.so
