---
name: orb-index-status
description: Show the current indexing progress and status.
allowed-tools: Bash(node *)
---

# OrbCode Index Status

Show the current indexing progress including:

- Progress bar with percentage
- Files processed / total
- Current file being indexed
- Collection status

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/orb-cli.js index-status
```

Example output:

```
📊 Indexing Status
────────────────────────────
Progress: [████████░░░░░░░░░░░░] 40%
Files: 120/300
Current: src/components/Button.tsx

Status: 🔄 Active
Workspace: /Users/dev/project
Started: 1/15/2026, 10:30:00 AM
Collection: ✅ Ready
```
