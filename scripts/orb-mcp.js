#!/usr/bin/env node

/**
 * OrbCode MCP Server — exposes a single `semantic_code_search` tool to Claude Code.
 *
 * When Claude calls the tool, this server posts to MatterAI's
 * /orb-embedding/search, which embeds the query and runs a qdrant lookup
 * against the user's indexed workspace. The response is returned as a
 * tool_result for Claude to consume.
 *
 * Wire format: line-delimited JSON-RPC 2.0 over stdio (MCP).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const ORB_DIR = join(homedir(), ".claude", "orbcode");
const AUTH_FILE = join(ORB_DIR, "auth.json");
const API_BASE = process.env.ORB_API_BASE || "https://api.matterai.so";
const PROTOCOL_VERSION = "2024-11-05";

// ── Helpers ────────────────────────────────────────────────────────────────────

function getAuthToken() {
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    return data.access_token || null;
  } catch {
    return null;
  }
}

function getWorkspacePath() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// ── Tool definitions ───────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "semantic_code_search",
    description:
      "Search the user's indexed codebase for code chunks relevant to a natural-language query. Returns ranked snippets with file paths and line numbers. Use this when you need to find functions, patterns, or implementations across the project — it is faster and more targeted than reading files blindly.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language description of what to find. Be specific: name the symbol, behavior, or feature you're looking for.",
        },
        directoryPrefix: {
          type: "string",
          description:
            "Optional path prefix to scope the search (e.g. 'src/api'). Omit to search the whole workspace.",
        },
        maxResults: {
          type: "integer",
          description: "Max number of results to return. Defaults to 5.",
          minimum: 1,
          maximum: 20,
        },
      },
      required: ["query"],
    },
  },
];

// ── Tool handler ───────────────────────────────────────────────────────────────

async function callSemanticCodeSearch(args) {
  const token = getAuthToken();
  if (!token) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Not authenticated with OrbCode. Run /orb-login in Claude Code first.",
        },
      ],
    };
  }

  const workspacePath = getWorkspacePath();

  const response = await fetch(`${API_BASE}/orb-embedding/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      workspacePath,
      query: args?.query,
      directoryPrefix: args?.directoryPrefix,
      maxResults: args?.maxResults,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Search failed (HTTP ${response.status}). ${text.slice(0, 500)}`,
        },
      ],
    };
  }

  const data = await response.json();

  if (!data?.success) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Search failed: ${data?.error || "unknown error"}`,
        },
      ],
    };
  }

  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No matching code found in the indexed workspace.",
        },
      ],
    };
  }

  const formatted = results
    .map((r, i) => {
      const p = r?.payload || {};
      const score = typeof r?.score === "number" ? r.score.toFixed(3) : "?";
      const header = `[${i + 1}] ${p.filePath || "(unknown)"}:${p.startLine ?? "?"}-${p.endLine ?? "?"}  (score ${score})`;
      const code = (p.codeChunk || "").trimEnd();
      return `${header}\n${code}`;
    })
    .join("\n\n---\n\n");

  return {
    content: [
      {
        type: "text",
        text: formatted,
      },
    ],
  };
}

// ── JSON-RPC dispatcher ────────────────────────────────────────────────────────

async function handle(message) {
  const { id, method, params } = message;

  // Notifications (no id) — no response expected.
  if (id === undefined || id === null) {
    return;
  }

  try {
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "orbcode-mcp", version: "0.1.0" },
        });
        return;

      case "tools/list":
        reply(id, { tools: TOOLS });
        return;

      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments || {};
        if (name !== "semantic_code_search") {
          replyError(id, -32601, `Unknown tool: ${name}`);
          return;
        }
        const result = await callSemanticCodeSearch(args);
        reply(id, result);
        return;
      }

      case "ping":
        reply(id, {});
        return;

      default:
        replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    replyError(id, -32000, err?.message || "Internal error");
  }
}

// ── stdio loop ─────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // ignore malformed frames
  }

  handle(message).catch((err) => {
    if (message?.id !== undefined) {
      replyError(message.id, -32000, err?.message || "Internal error");
    }
  });
});

rl.on("close", () => process.exit(0));
