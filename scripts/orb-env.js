#!/usr/bin/env node

/**
 * OrbCode Environment Details Collector
 *
 * Mirrors the structure of MatterCode's getEnvironmentDetails.ts so that the
 * MatterAI backend has the same workspace, git, and time context that the
 * VSCode extension provides.
 *
 * The proxy attaches this on every inference request, but the backend is
 * responsible for injecting it into the system prompt only ONCE per session
 * (so we don't bloat every turn's context).
 */

import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";

const GIT_TIMEOUT_MS = 3000;
const MAX_WORKSPACE_FILES = 200;

function safeExec(cmd, opts) {
  try {
    return execSync(cmd, {
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      ...opts,
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

function getGitInfo(cwd) {
  const opts = { cwd };
  const repositoryUrl = safeExec("git remote get-url origin", opts);
  const currentBranch = safeExec("git rev-parse --abbrev-ref HEAD", opts);

  // Default branch: try `origin/HEAD` symbolic ref, fall back to common names.
  let defaultBranch = "";
  const symbolic = safeExec("git symbolic-ref refs/remotes/origin/HEAD", opts);
  const match = symbolic.match(/refs\/remotes\/origin\/(.+)/);
  if (match && match[1]) defaultBranch = match[1].trim();

  // Repository name: prefer the basename of the remote URL, fall back to dir.
  let repositoryName = "";
  if (repositoryUrl) {
    const cleaned = repositoryUrl.replace(/\.git$/, "");
    repositoryName = cleaned.split(/[/:]/).pop() || "";
  }
  if (!repositoryName) {
    repositoryName = path.basename(cwd);
  }

  // Short status — keep it small. Limit to the first ~20 entries.
  const status = safeExec("git status --porcelain", opts)
    .split("\n")
    .filter(Boolean)
    .slice(0, 20)
    .join("\n");

  const latestCommit = safeExec(
    "git log -1 --pretty=format:%h %s",
    opts,
  );

  const isGitRepo = Boolean(
    repositoryUrl || currentBranch || defaultBranch || status,
  );

  return {
    isGitRepo,
    repositoryUrl,
    repositoryName,
    currentBranch,
    defaultBranch,
    status,
    latestCommit,
  };
}

function listWorkspaceFiles(cwd, limit = MAX_WORKSPACE_FILES) {
  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    "target",
  ]);

  const out = [];
  let truncated = false;

  function walk(dir, depth) {
    if (out.length >= limit) {
      truncated = true;
      return;
    }
    if (depth > 4) return; // depth cap mirrors mattercode default

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (out.length >= limit) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      if (SKIP_DIRS.has(entry.name)) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(path.relative(cwd, full));
      }
    }
  }

  try {
    if (existsSync(cwd) && statSync(cwd).isDirectory()) {
      walk(cwd, 0);
    }
  } catch {}

  return { files: out, truncated };
}

function getTimeInfo() {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetHours = -now.getTimezoneOffset() / 60;
  const sign = offsetHours >= 0 ? "+" : "-";
  const absH = Math.floor(Math.abs(offsetHours));
  const absM = Math.abs(Math.round((Math.abs(offsetHours) - absH) * 60));
  const offsetStr = `${sign}${absH}:${String(absM).padStart(2, "0")}`;
  return {
    iso: now.toISOString(),
    timeZone,
    offset: offsetStr,
  };
}

/**
 * Collect a structured snapshot of the workspace environment for the backend.
 * Returns a JSON-serializable object — the backend formats it into the
 * `<environment_details>` block before injecting into the system prompt.
 */
export function collectEnvironmentDetails({ includeFiles = true } = {}) {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const git = getGitInfo(cwd);
  const time = getTimeInfo();
  const filesInfo = includeFiles
    ? listWorkspaceFiles(cwd)
    : { files: [], truncated: false };

  return {
    cwd,
    os: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      hostname: os.hostname(),
      shell: process.env.SHELL || "",
      user: os.userInfo().username,
      nodeVersion: process.version,
    },
    time,
    git,
    workspace: {
      files: filesInfo.files,
      truncated: filesInfo.truncated,
      fileCount: filesInfo.files.length,
    },
  };
}

/**
 * Render the structured snapshot as the `<environment_details>` XML block
 * that MatterCode's getEnvironmentDetails.ts produces — useful for parity
 * checks and direct injection on the plugin side if needed.
 */
export function formatEnvironmentDetails(details) {
  const lines = [];

  lines.push("# Current Time");
  lines.push(
    `Current time in ISO 8601 UTC format: ${details.time.iso}`,
  );
  lines.push(`User time zone: ${details.time.timeZone}, UTC${details.time.offset}`);

  if (details.git?.isGitRepo) {
    lines.push("");
    lines.push("# Git Repository Information");
    if (details.git.repositoryUrl)
      lines.push(`Repository URL: ${details.git.repositoryUrl}`);
    if (details.git.repositoryName)
      lines.push(`Repository Name: ${details.git.repositoryName}`);
    if (details.git.defaultBranch)
      lines.push(`Default Branch: ${details.git.defaultBranch}`);
    if (details.git.currentBranch)
      lines.push(`Current Branch: ${details.git.currentBranch}`);
    if (details.git.latestCommit)
      lines.push(`Latest Commit: ${details.git.latestCommit}`);
    if (details.git.status) {
      lines.push("Working Tree Status:");
      lines.push(details.git.status);
    }
  }

  lines.push("");
  lines.push("# System");
  lines.push(`Platform: ${details.os.platform} (${details.os.arch})`);
  lines.push(`Node: ${details.os.nodeVersion}`);
  if (details.os.shell) lines.push(`Shell: ${details.os.shell}`);

  lines.push("");
  lines.push(`# Current Workspace Directory (${details.cwd}) Files`);
  if (details.workspace.files.length === 0) {
    lines.push("(No files indexed)");
  } else {
    lines.push(...details.workspace.files);
    if (details.workspace.truncated) {
      lines.push(
        `(File list truncated at ${details.workspace.files.length} entries — use list_files to explore.)`,
      );
    }
  }

  return `<environment_details>\n${lines.join("\n").trim()}\n</environment_details>`;
}

// Allow running this file directly for quick debugging:
//   node scripts/orb-env.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const details = collectEnvironmentDetails();
  process.stdout.write(formatEnvironmentDetails(details) + "\n");
}
