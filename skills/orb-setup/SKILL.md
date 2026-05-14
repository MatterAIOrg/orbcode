---
name: orb-setup
description: Run the full OrbCode bootstrap — starts the proxy, authenticates with MatterAI, and kicks off codebase indexing in one shot.
allowed-tools: Bash(node *)
---

# OrbCode Setup

Run the full OrbCode bootstrap. This will:
1. Start the local proxy daemon
2. Authenticate with MatterAI (opens browser). Skipped if the user is already logged in.
3. Start the codebase indexer in the background once auth succeeds.

`ANTHROPIC_BASE_URL` is set by the plugin's `settings.json` and applied by Claude Code on session start — no shell-profile edits required.

If the user passed `--token <token>` as arguments, pass it through so login runs non-interactively:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/orb-cli.js setup --token '<token>'
```

Otherwise, run plain:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/orb-cli.js setup
```

Relay the output to the user. After setup completes, tell them:
- Quit and relaunch Claude Code — that's all that's needed for the proxy to take effect
- The `semantic_code_search` MCP tool becomes available once the first batch of files has been embedded

If browser login fails (headless / SSH), the auth URL is printed in the output — direct the user to open it manually, complete login, copy the token, and re-run with `/orb-setup --token <token>`.
