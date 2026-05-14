---
name: orb-update
description: Update the OrbCode plugin to the latest version.
allowed-tools: Bash(claude *, rm *)
---

# Update OrbCode Plugin

Update the OrbCode plugin to the latest version.

Run these steps in sequence. After each bash command, check the exit code before proceeding.

## Step 1: Update marketplace

Try the update first:

```bash
claude plugin marketplace update orbcode-marketplace
```

If this fails (e.g. git/SSH auth error), fall back to adding via HTTPS, then removing the old entry:

```bash
claude plugin marketplace add https://github.com/AquaSecure/orbcode-plugin.git
```

If the add succeeded, remove the old marketplace entry:

```bash
claude plugin marketplace remove orbcode-marketplace
```

If the add failed, do NOT run remove — the old entry is still needed. Tell the user: "Marketplace update failed. Check your network connection and try again."

## Step 2: Install latest plugin version

```bash
claude plugin install orb@orbcode-marketplace
```

If this fails, tell the user: "Plugin install failed. Please contact support@matterai.so"

## Step 3: Confirm

After all steps succeed, tell the user:
- ✅ OrbCode updated successfully
- Run `/reload-plugins` to apply the update in the current session
