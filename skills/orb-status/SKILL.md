---
name: orb-status
description: Show current OrbCode authentication and proxy status.
allowed-tools: Bash(node *)
---

Check the current OrbCode status (authentication, proxy, and environment):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/orb-cli.js status
```

Relay the output to the user in a clear, formatted way.

If there are issues:
- **Not authenticated**: Suggest running `/orb-login`
- **Proxy not running**: Suggest running the setup or starting the proxy manually
- **ANTHROPIC_BASE_URL not set**: Explain that the env var needs to be configured for the proxy to intercept API calls. Suggest running `/orb-setup`.
