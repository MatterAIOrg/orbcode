---
name: orb-logout
description: Clear stored OrbCode credentials and log out from MatterAI.
allowed-tools: Bash(node *)
---

Log out of OrbCode by clearing stored credentials:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/orb-cli.js logout
```

Confirm that the user has been logged out.

Optionally, if the user wants to fully disconnect:
1. Suggest stopping the proxy with `/orb-status` to check if it's running
2. Let them know they can re-authenticate anytime with `/orb-login`
