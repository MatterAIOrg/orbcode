---
name: orb-setup
description: Run the full OrbCode bootstrap — starts the proxy, authenticates with MatterAI, and kicks off codebase indexing in one shot.
allowed-tools: AskUserQuestion, Bash(node *)
---

# OrbCode Setup

Run the full OrbCode bootstrap. This will:
1. Ask the user what their tech role is (only if not already stored)
2. Start the local proxy daemon
3. Authenticate with MatterAI (opens browser). Skipped if the user is already logged in.
4. Configure `ANTHROPIC_BASE_URL` and `API_TIMEOUT_MS` in `~/.claude/settings.json`
5. Start the codebase indexer in the background once auth succeeds.

## Step 1 — Ask the user's role (BEFORE running setup)

Before running the CLI, check whether the user already has a stored role:

```bash
node -e "try { const r = JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(), '.claude', 'orbcode', 'role.json'), 'utf-8')); process.stdout.write(r.role || '') } catch { process.stdout.write('') }"
```

If the command outputs a non-empty string, the user already has a role on file — skip the question and pass `--role <stored>` through (or omit `--role` entirely so the CLI reads the file itself).

If empty, ask the user **once** using `AskUserQuestion` with this exact configuration:

- question: `"What's your primary tech role? This helps MatterAI tailor optimizations and metrics."`
- header: `"Tech role"`
- multiSelect: `false`
- options (in this order, mutually exclusive — do NOT add an "Other" option, the harness adds one automatically):
  1. label `"Frontend Engineer"`, description `"UI, web, mobile-web, design systems."`
  2. label `"Backend Engineer"`, description `"APIs, services, databases, infra-adjacent code."`
  3. label `"Full-stack Engineer"`, description `"Both frontend and backend in roughly equal measure."`
  4. label `"DevOps / Platform / SRE"`, description `"Infra, deploy pipelines, observability, reliability."`

The user's selected label (or their `Other` free-text answer) is the role string.

## Step 2 — Run setup

If the user passed `--token <token>` as arguments, pass it through so login runs non-interactively:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/orb-cli.js setup --role '<role>' --token '<token>'
```

Otherwise:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/orb-cli.js setup --role '<role>'
```

If the role was already on file and you skipped the question, you may omit `--role` — the CLI will use the stored value.

## Step 3 — Relay output

Relay the CLI output to the user. After setup completes, tell them:
- Quit and relaunch Claude Code — that's all that's needed for the proxy to take effect
- The `semantic_code_search` MCP tool becomes available once the first batch of files has been embedded

If browser login fails (headless / SSH), the auth URL is printed in the output — direct the user to open it manually, complete login, copy the token, and re-run with `/orb-setup --token <token>`.
