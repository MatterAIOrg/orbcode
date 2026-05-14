#!/usr/bin/env node

/**
 * OrbCode Session Start Hook
 *
 * Runs when a Claude Code session starts. Checks auth and proxy status,
 * auto-starts the proxy if needed, and injects session context.
 *
 * Output format: JSON with hookSpecificOutput.additionalContext
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ORB_DIR = join(homedir(), '.claude', 'orbcode');
const AUTH_FILE = join(ORB_DIR, 'auth.json');
const PROXY_FILE = join(ORB_DIR, 'proxy.json');
const INDEX_FILE = join(ORB_DIR, 'index.json');
const DEFAULT_PORT = 7856;

function isAuthenticated() {
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, 'utf-8'));
    return !!data.access_token;
  } catch {
    return false;
  }
}

function getProxyInfo() {
  try {
    return JSON.parse(readFileSync(PROXY_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProxyRunning() {
  const info = getProxyInfo();
  if (!info?.pid) return false;
  return isProcessAlive(info.pid);
}

async function autoStartProxy() {
  if (isProxyRunning()) return true;

  const proxyScript = join(__dirname, 'orb-proxy.js');
  if (!existsSync(proxyScript)) return false;

  try {
    const { openSync } = await import('node:fs');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(ORB_DIR, { recursive: true });
    const logFile = join(ORB_DIR, 'proxy.log');
    const out = openSync(logFile, 'a');

    const child = spawn('node', [proxyScript, String(DEFAULT_PORT)], {
      detached: true,
      stdio: ['ignore', out, out]
    });
    child.unref();

    // Brief wait for startup
    await new Promise(r => setTimeout(r, 1000));
    return isProxyRunning();
  } catch {
    return false;
  }
}

function readIndexRegistry() {
  try {
    if (!existsSync(INDEX_FILE)) return {};
    const raw = JSON.parse(readFileSync(INDEX_FILE, 'utf-8'));
    return raw?.workspaces && typeof raw.workspaces === 'object'
      ? raw.workspaces
      : {};
  } catch {
    return {};
  }
}

/**
 * Spawn the indexer daemon for the current workspace if one isn't already
 * running. Detached so it survives the session-start hook process exiting.
 */
async function autoStartIndexer() {
  const workspacePath = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const registry = readIndexRegistry();
  const existing = registry[workspacePath];

  if (existing?.pid && isProcessAlive(existing.pid)) {
    return 'running';
  }

  const cliScript = join(__dirname, 'orb-cli.js');
  if (!existsSync(cliScript)) return 'skipped';

  try {
    const { openSync, mkdirSync } = await import('node:fs');
    mkdirSync(ORB_DIR, { recursive: true });
    const logFile = join(ORB_DIR, 'indexer.log');
    const out = openSync(logFile, 'a');

    const child = spawn('node', [cliScript, 'index', workspacePath], {
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, ORB_INDEXER_DAEMON: '1' },
    });
    child.unref();

    return 'started';
  } catch {
    return 'skipped';
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const authed = isAuthenticated();
  const contextParts = [];

  if (!authed) {
    contextParts.push(
      'OrbCode: User is NOT authenticated.',
      'If the user tries to use AI features, they will get auth errors.',
      'Suggest running /orb-login to authenticate with MatterAI.',
      'Do NOT proactively tell the user about this unless they ask or encounter an error.'
    );
  } else {
    // Auto-start proxy if needed
    let proxyOk = isProxyRunning();
    if (!proxyOk) {
      proxyOk = await autoStartProxy();
    }

    if (proxyOk) {
      const info = getProxyInfo();
      contextParts.push(
        'OrbCode: Active and running.',
        `Proxy: http://127.0.0.1:${info?.port || DEFAULT_PORT}`,
        'All inference calls are being routed through MatterAI.'
      );
    } else {
      contextParts.push(
        'OrbCode: Authenticated but proxy is NOT running.',
        'The proxy could not be auto-started.',
        'If the user encounters API errors, suggest running /orb-status for diagnostics.'
      );
    }

    // Ensure the codebase indexer is running for this workspace so that the
    // semantic_code_search MCP tool has fresh embeddings to query against.
    const indexerStatus = await autoStartIndexer();
    if (indexerStatus === 'started') {
      contextParts.push('OrbCode: Started codebase indexer for this workspace.');
    }

    // Check ANTHROPIC_BASE_URL
    const baseUrl = process.env.ANTHROPIC_BASE_URL;
    if (!baseUrl) {
      contextParts.push(
        'WARNING: ANTHROPIC_BASE_URL is not set.',
        'Claude Code is making direct Anthropic calls, bypassing OrbCode.',
        'If the user asks, suggest running /orb-setup or manually setting the env var.'
      );
    }
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: contextParts.join(' ')
    }
  };

  console.log(JSON.stringify(output));
}

main().catch((err) => {
  // Fail silently — don't break the session
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `OrbCode: Session hook error — ${err.message}. Plugin may not work correctly.`
    }
  }));
});
