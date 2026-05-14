#!/usr/bin/env node

/**
 * OrbCode CLI
 *
 * Commands:
 *   login [--token <token>]  — Authenticate with MatterAI
 *   logout                   — Clear stored credentials
 *   status                   — Show auth & proxy status
 *   proxy-start [port]       — Start the local proxy daemon
 *   proxy-stop               — Stop the local proxy daemon
 *   setup                    — Full setup (proxy + env config)
 */

import http from "node:http";
import https from "node:https";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  openSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { exec, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// ── Constants ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ORB_DIR = join(homedir(), ".claude", "orbcode");
const AUTH_FILE = join(ORB_DIR, "auth.json");
const PROXY_FILE = join(ORB_DIR, "proxy.json");
const INDEX_FILE = join(ORB_DIR, "index.json");
const USER_SETTINGS_FILE = join(homedir(), ".claude", "settings.json");
const DEFAULT_PROXY_PORT = 7856;

const MATTERAI_AUTH_URL = "https://app.matterai.so";

// Global indexer instance for index-stop command
let currentIndexer = null;

// Ensure config directory
mkdirSync(ORB_DIR, { recursive: true });

// ── Main ───────────────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "login":
    await handleLogin();
    break;
  case "logout":
    handleLogout();
    break;
  case "status":
    await handleStatus();
    break;
  case "proxy-start":
    await handleProxyStart();
    break;
  case "proxy-stop":
    handleProxyStop();
    break;
  case "setup":
    await handleSetup();
    break;
  case "index":
    await handleIndex();
    break;
  case "index-stop":
    await handleIndexStop();
    break;
  case "index-status":
    await handleIndexStatus();
    break;
  default:
    console.log("OrbCode CLI — MatterAI Plugin for Claude Code");
    console.log("");
    console.log("Commands:");
    console.log("  login [--token <t>]   Authenticate with MatterAI");
    console.log("  logout                Clear stored credentials");
    console.log("  status                Show auth & proxy status");
    console.log("  proxy-start [port]    Start local proxy daemon");
    console.log("  proxy-stop            Stop local proxy daemon");
    console.log("  setup                 Full setup (proxy + env + indexing)");
    console.log("  index [path]          (internal) Run indexer in foreground");
    console.log("  index-stop [path]     Stop the indexer for a workspace");
    console.log("  index-status [path]   Show indexing progress/status");
    process.exit(command ? 1 : 0);
}

// ── Login ──────────────────────────────────────────────────────────────────────

async function handleLogin() {
  const tokenArgIdx = process.argv.indexOf("--token");

  if (tokenArgIdx !== -1 && process.argv[tokenArgIdx + 1]) {
    // Direct token login (for headless / SSH environments)
    const rawToken = process.argv[tokenArgIdx + 1];
    return await saveToken(rawToken);
  }

  // Browser-based login flow
  const state = randomUUID();
  const callbackPort = await findOpenPort(54600);
  const redirectUri = `http://localhost:${callbackPort}/callback`;
  // Use FE URL with redirect_uri - the FE dialog will handle showing auth options
  // After auth, BE will redirect to the callback with token
  const authUrl = `${MATTERAI_AUTH_URL}/orbital?loginType=orbcode&callback=${encodeURIComponent(redirectUri)}&clistate=${state}`;

  console.log("");
  console.log("🔐 Opening browser for MatterAI authentication...");
  console.log("");
  console.log("If the browser does not open automatically, visit:");
  console.log(`  ${authUrl}`);
  console.log("");

  try {
    const token = await waitForCallback(callbackPort, state, authUrl);
    await saveToken(token);
  } catch (err) {
    console.error(`❌ Login failed: ${err.message}`);
    console.error("");
    console.error("For headless/SSH environments, use:");
    console.error("  /orb-login --token '<your-token>'");
    process.exit(1);
  }
}

async function saveToken(rawToken) {
  let tokenData;
  try {
    tokenData = JSON.parse(rawToken);
  } catch {
    tokenData = { access_token: rawToken };
  }

  if (!tokenData.access_token) {
    console.error("❌ Invalid token: missing access_token field.");
    process.exit(1);
  }

  writeFileSync(AUTH_FILE, JSON.stringify(tokenData, null, 2));
  console.log("✅ Logged in to OrbCode successfully!");

  // Auto-start proxy if not running
  if (!isProxyRunning()) {
    console.log("");
    console.log("Starting proxy...");
    await handleProxyStart();
  }

  // Kick off codebase indexing for the current workspace in the background.
  // Indexing is part of the auth flow now — no separate skill required.
  const started = startIndexerDaemon(process.cwd());
  if (started === "started") {
    console.log("");
    console.log("📚 Codebase indexing started in the background.");
    console.log(`   Logs: ${join(ORB_DIR, "indexer.log")}`);
  } else if (started === "running") {
    console.log("");
    console.log("📚 Codebase indexer already running for this workspace.");
  }
}

function waitForCallback(port, expectedState, authUrl) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Authentication timed out after 120 seconds."));
    }, 120000);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname === "/callback") {
        const token = url.searchParams.get("token");
        const returnedState = url.searchParams.get("state");

        if (returnedState && returnedState !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            authPage(
              "❌ Security Error",
              "State mismatch. Please try logging in again.",
              true,
            ),
          );
          return;
        }

        if (token) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            authPage(
              "✅ Authenticated!",
              "You are now logged in to OrbCode. You can close this tab.",
              false,
            ),
          );
          clearTimeout(timeout);
          server.close();
          resolve(token);
        } else {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            authPage(
              "❌ Error",
              "No token received. Please try logging in again.",
              true,
            ),
          );
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(port, "127.0.0.1", () => {
      openBrowser(authUrl);
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Callback server error: ${err.message}`));
    });
  });
}

function authPage(title, message, isError) {
  const color = isError ? "#ef4444" : "#10b981";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>OrbCode — ${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; margin: 0;
      background: #0a0a0a; color: #e5e5e5;
    }
    .card {
      text-align: center; padding: 3rem;
      background: #171717; border-radius: 16px;
      border: 1px solid #262626; max-width: 420px;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,.5);
    }
    h1 { color: ${color}; font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #a3a3a3; line-height: 1.6; }
    .brand { color: #737373; font-size: 0.85rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="brand">OrbCode by MatterAI</p>
  </div>
</body>
</html>`;
}

// ── Logout ─────────────────────────────────────────────────────────────────────

function handleLogout() {
  try {
    if (existsSync(AUTH_FILE)) unlinkSync(AUTH_FILE);
    console.log("✅ Logged out. Credentials cleared.");
  } catch (err) {
    console.error(`❌ Logout error: ${err.message}`);
    process.exit(1);
  }
}

// ── Status ─────────────────────────────────────────────────────────────────────

async function handleStatus() {
  const output = {};

  // Auth
  let authed = false;
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    authed = !!data.access_token;
    output.authenticated = true;
    // Mask the token for display
    output.token_preview = data.access_token
      ? data.access_token.slice(0, 8) + "..." + data.access_token.slice(-4)
      : null;
  } catch {
    output.authenticated = false;
  }

  console.log(
    `Authentication: ${authed ? "✅ Logged in" : "❌ Not logged in"}`,
  );
  if (output.token_preview) {
    console.log(`  Token: ${output.token_preview}`);
  }

  // Proxy
  const proxyRunning = isProxyRunning();
  const proxyInfo = getProxyInfo();

  if (proxyRunning && proxyInfo) {
    console.log(
      `Proxy: ✅ Running on port ${proxyInfo.port} (PID: ${proxyInfo.pid})`,
    );
  } else {
    console.log("Proxy: ❌ Not running");
    if (proxyInfo) {
      // Clean up stale file
      try {
        unlinkSync(PROXY_FILE);
      } catch {}
    }
  }

  // ANTHROPIC_BASE_URL — check both the live process env (what's actually
  // active right now) and the user-level settings file (what will be applied
  // on the next Claude Code launch). Distinguishing the two lets us say
  // "configured, just restart" instead of the misleading "not set".
  const liveBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const configuredBaseUrl = getConfiguredBaseUrl();

  if (liveBaseUrl) {
    console.log(`ANTHROPIC_BASE_URL: ✅ ${liveBaseUrl}`);
    if (proxyInfo && !liveBaseUrl.includes(`:${proxyInfo.port}`)) {
      console.log("  ⚠️  URL does not match proxy port");
    }
  } else if (configuredBaseUrl) {
    console.log(
      `ANTHROPIC_BASE_URL: ⚠️  Configured (${configuredBaseUrl}) but not active in this process`,
    );
    console.log(
      "  Restart Claude Code to pick up the value from ~/.claude/settings.json",
    );
  } else {
    console.log("ANTHROPIC_BASE_URL: ⚠️  Not set");
    console.log("  Run /orb-setup to configure it automatically");
  }
}

// ── Proxy Start ────────────────────────────────────────────────────────────────

async function handleProxyStart() {
  // Check if already running
  if (isProxyRunning()) {
    const info = getProxyInfo();
    console.log(
      `Proxy already running on port ${info.port} (PID: ${info.pid})`,
    );
    return;
  }

  const port = parseInt(process.argv[3]) || DEFAULT_PROXY_PORT;
  const proxyScript = join(__dirname, "orb-proxy.js");

  if (!existsSync(proxyScript)) {
    console.error(`❌ Proxy script not found: ${proxyScript}`);
    process.exit(1);
  }

  // Start proxy as a detached background process
  const logFile = join(ORB_DIR, "proxy.log");
  const out = await import("node:fs").then((fs) => fs.openSync(logFile, "a"));

  const child = spawn("node", [proxyScript, String(port)], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env },
  });

  child.unref();

  // Wait briefly for the proxy to start
  await sleep(1500);

  // Verify it started
  if (isProxyRunning()) {
    const info = getProxyInfo();
    console.log(`✅ Proxy started on port ${info.port} (PID: ${info.pid})`);
    console.log(`   URL: http://127.0.0.1:${info.port}`);
  } else {
    console.error("❌ Proxy failed to start. Check logs:");
    console.error(`   ${logFile}`);
    process.exit(1);
  }
}

// ── Proxy Stop ─────────────────────────────────────────────────────────────────

function handleProxyStop() {
  const info = getProxyInfo();
  if (!info) {
    console.log("Proxy is not running.");
    return;
  }

  if (isProcessAlive(info.pid)) {
    try {
      process.kill(info.pid, "SIGTERM");
      console.log(`✅ Proxy stopped (PID: ${info.pid})`);
    } catch (err) {
      console.error(`❌ Failed to stop proxy: ${err.message}`);
    }
  } else {
    console.log("Proxy was not running (stale state).");
  }

  try {
    unlinkSync(PROXY_FILE);
  } catch {}
}

// ── Setup ──────────────────────────────────────────────────────────────────────

async function handleSetup() {
  console.log("");
  console.log("🔧 OrbCode Setup");
  console.log("─".repeat(40));

  // 1. Start proxy.
  console.log("");
  console.log("Step 1: Starting proxy...");
  await handleProxyStart();

  // 2. Authenticate (or skip if already logged in). handleLogin() also
  //    starts the indexer after saving the token, so we don't repeat that
  //    step on the fresh-auth path.
  let authed = false;
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    authed = !!data.access_token;
  } catch {
    authed = false;
  }

  if (!authed) {
    console.log("");
    console.log("Step 2: Authenticating with MatterAI...");
    await handleLogin();
  } else {
    console.log("");
    console.log("Step 2: Already authenticated — skipping login.");

    const result = startIndexerDaemon(process.cwd());
    if (result === "started") {
      console.log("  ✅ Codebase indexer started in the background.");
      console.log(`     Logs: ${join(ORB_DIR, "indexer.log")}`);
    } else if (result === "running") {
      console.log("  ✅ Codebase indexer already running for this workspace.");
    }
  }

  // 3. Persist ANTHROPIC_BASE_URL into ~/.claude/settings.json so Claude Code
  //    routes inference through the proxy on its next launch. The plugin's
  //    own settings.json env block isn't reliably applied to the main
  //    process, so we write it at the user level instead.
  console.log("");
  console.log("Step 3: Configuring ANTHROPIC_BASE_URL...");
  const proxyInfo = getProxyInfo();
  const proxyPort = proxyInfo?.port || DEFAULT_PROXY_PORT;
  const envResult = ensureUserBaseUrlConfig(proxyPort);
  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  if (envResult === "updated") {
    console.log(`  ✅ Wrote ANTHROPIC_BASE_URL=${baseUrl} to ${USER_SETTINGS_FILE}`);
  } else if (envResult === "already_set") {
    console.log(`  ✅ Already configured: ${baseUrl}`);
  } else if (envResult && envResult.error) {
    console.log(`  ❌ Could not update ${USER_SETTINGS_FILE}: ${envResult.error}`);
    console.log(`     Manually add { "env": { "ANTHROPIC_BASE_URL": "${baseUrl}" } }`);
  }

  console.log("");
  console.log("─".repeat(40));
  console.log("✅ Setup complete!");
  console.log("");
  console.log("Restart Claude Code to activate the proxy:");
  console.log("   1. Quit your current session");
  console.log("   2. Launch `claude` again");
  console.log("");
  console.log(
    `ANTHROPIC_BASE_URL is configured in ${USER_SETTINGS_FILE} and will be applied on next launch.`,
  );
  console.log("");
}

// ── Index ──────────────────────────────────────────────────────────────────────

async function handleIndex() {
  // Check auth
  let apiKey;
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    apiKey = data.access_token;
    if (!apiKey) {
      console.error("❌ Not authenticated. Run /orb-login first.");
      process.exit(1);
    }
  } catch {
    console.error("❌ Not authenticated. Run /orb-login first.");
    process.exit(1);
  }

  // Get workspace path
  const workspacePath = process.argv[3] || process.cwd();
  const resolvedPath = resolve(workspacePath);

  console.log("");
  console.log("📚 Codebase Indexing");
  console.log("─".repeat(40));
  console.log("Workspace: " + resolvedPath);
  console.log("");

  try {
    // Dynamically import the indexer (ESM)
    const { startIndexing } = await import(
      join(__dirname, "..", "src", "indexer", "index.js")
    );

    // Mark this workspace as "starting" in the registry so other processes
    // can see we're alive even before the first progress event.
    updateIndexRegistry(resolvedPath, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      phase: "initial",
    });

    currentIndexer = await startIndexing({
      workspacePath: resolvedPath,
      apiKey,
      baseUrl: "https://api.matterai.so",
      onProgress: (progress) => {
        if (progress.type === "processing") {
          const pct = Math.round((progress.processed / progress.total) * 100);
          process.stdout.write(
            "\r  [" +
              pct +
              "%] " +
              progress.processed +
              "/" +
              progress.total +
              " files",
          );
          updateIndexRegistry(resolvedPath, {
            pid: process.pid,
            phase: "initial",
            progress: {
              processed: progress.processed,
              total: progress.total,
              percentage: pct,
              currentFile: progress.currentFile,
            },
          });
        }
      },
    });

    console.log("");
    console.log("");
    console.log(
      "✅ Indexing complete! File watcher is running for incremental updates.",
    );

    updateIndexRegistry(resolvedPath, {
      pid: process.pid,
      phase: "watching",
      indexedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("");
    console.error("❌ Indexing failed:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// ── Index Stop ─────────────────────────────────────────────────────────────────

async function handleIndexStop() {
  // In-process indexer (when /orb-cli.js index was running in foreground).
  if (currentIndexer) {
    const { stopIndexing } = await import(
      join(__dirname, "..", "src", "indexer", "index.js")
    );
    stopIndexing(currentIndexer);
    currentIndexer = null;
  }

  const target = resolve(process.argv[3] || process.cwd());
  const registry = readIndexRegistry();
  const entry = registry[target];

  if (entry?.pid && isProcessAlive(entry.pid)) {
    try {
      process.kill(entry.pid, "SIGTERM");
      console.log(`✅ Indexer stopped for ${target} (PID: ${entry.pid})`);
    } catch (err) {
      console.error(`Failed to stop indexer: ${err.message}`);
    }
  }

  delete registry[target];
  if (Object.keys(registry).length === 0) {
    try {
      unlinkSync(INDEX_FILE);
    } catch {}
  } else {
    writeIndexRegistry(registry);
  }

  console.log("✅ Indexing stopped.");
}

// ── Index Status ───────────────────────────────────────────────────────────────

async function handleIndexStatus() {
  console.log("");
  console.log("📊 Indexing Status");
  console.log("─".repeat(40));

  const target = resolve(process.argv[3] || process.cwd());
  const registry = readIndexRegistry();
  const entry = registry[target];

  if (!entry) {
    console.log("Status: ❌ Not indexing for " + target);
    console.log("");
    console.log("Indexing auto-starts after /orb-login.");
    return;
  }

  const alive = entry.pid ? isProcessAlive(entry.pid) : false;
  const phase = entry.phase || (entry.indexedAt ? "watching" : "initial");

  // Only show the progress bar during the initial pass — once we transition
  // to "watching", a frozen 412/980 bar is misleading. Show a watcher line
  // instead so the user knows the daemon is actively listening for changes.
  if (alive && phase === "initial" && entry.progress) {
    const pct = entry.progress.percentage || 0;
    const bar =
      "█".repeat(Math.floor(pct / 5)) + "░".repeat(20 - Math.floor(pct / 5));
    console.log("Progress: [" + bar + "] " + pct + "%");
    console.log(
      "Files: " +
        entry.progress.processed +
        "/" +
        entry.progress.total,
    );
    if (entry.progress.currentFile) {
      console.log("Current: " + entry.progress.currentFile);
    }
    console.log("");
  }

  let statusLabel;
  if (!alive) {
    statusLabel = "⏸️  Stopped (daemon exited)";
  } else if (phase === "initial") {
    statusLabel = "🔄 Indexing (initial pass)";
  } else {
    statusLabel = "👁️  Watching for file changes";
  }

  console.log("Status: " + statusLabel);
  console.log("Workspace: " + target);
  if (entry.startedAt) {
    console.log("Started: " + new Date(entry.startedAt).toLocaleString());
  }
  if (entry.indexedAt) {
    console.log(
      "Initial pass finished: " +
        new Date(entry.indexedAt).toLocaleString(),
    );
  }

  // Collection-exists is independent of daemon liveness, so qualify the line:
  // a stopped daemon + ready collection means stale data, not "ready".
  try {
    const authData = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    const apiKey = authData.access_token;

    const { HttpVectorStore } = await import(
      join(__dirname, "..", "src", "indexer", "vector-store.js")
    );

    const vectorStore = new HttpVectorStore(
      target,
      "https://api.matterai.so",
      1536,
      apiKey,
    );

    const exists = await vectorStore.collectionExists();

    if (!exists) {
      console.log("Collection: ⏳ Not yet created");
    } else if (!alive) {
      console.log(
        "Collection: ⚠️  Present but incremental updates paused (daemon stopped)",
      );
    } else if (phase === "initial") {
      console.log("Collection: ⏳ Filling (initial pass in progress)");
    } else {
      console.log("Collection: ✅ Ready and being kept in sync");
    }
  } catch (error) {
    console.log("Collection: ⚠️  Unable to check (" + error.message + ")");
  }

  console.log("");
}

// ── Utility Functions ──────────────────────────────────────────────────────────

function getProxyInfo() {
  try {
    return JSON.parse(readFileSync(PROXY_FILE, "utf-8"));
  } catch {
    return null;
  }
}

// ── User Settings (~/.claude/settings.json) ────────────────────────────────────

/**
 * Read the user-level Claude Code settings file. Returns an empty object if
 * the file is missing or unparseable (the latter case backs the bad file up
 * first so we never silently clobber data the user cares about).
 */
function readUserSettings() {
  if (!existsSync(USER_SETTINGS_FILE)) return {};
  let raw;
  try {
    raw = readFileSync(USER_SETTINGS_FILE, "utf-8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    const backup = `${USER_SETTINGS_FILE}.orbcode-backup-${Date.now()}`;
    try {
      writeFileSync(backup, raw);
      console.log(
        `  ⚠️  Could not parse ${USER_SETTINGS_FILE}; backed up to ${backup}`,
      );
    } catch {}
    return {};
  }
}

/**
 * Ensure ~/.claude/settings.json has env.ANTHROPIC_BASE_URL pointing at our
 * proxy. Plugin-level settings.json env blocks aren't reliably applied to
 * Claude Code's main process, so the user-level settings file is the source
 * of truth. Other keys in the file are preserved untouched.
 *
 * Returns "already_set" | "updated" | { error: string }.
 */
function ensureUserBaseUrlConfig(port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const settings = readUserSettings();

  const existingEnv =
    settings.env && typeof settings.env === "object" ? settings.env : {};

  if (existingEnv.ANTHROPIC_BASE_URL === baseUrl) {
    return "already_set";
  }

  const nextSettings = {
    ...settings,
    env: { ...existingEnv, ANTHROPIC_BASE_URL: baseUrl },
  };

  try {
    mkdirSync(dirname(USER_SETTINGS_FILE), { recursive: true });
    writeFileSync(
      USER_SETTINGS_FILE,
      JSON.stringify(nextSettings, null, 2) + "\n",
    );
    return "updated";
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Read the configured ANTHROPIC_BASE_URL out of ~/.claude/settings.json,
 * if any. Used by `status` so we can tell the difference between "never
 * configured" and "configured but Claude Code hasn't been restarted yet".
 */
function getConfiguredBaseUrl() {
  const settings = readUserSettings();
  const value = settings?.env?.ANTHROPIC_BASE_URL;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ── Indexer Registry ───────────────────────────────────────────────────────────

function readIndexRegistry() {
  try {
    if (!existsSync(INDEX_FILE)) return {};
    const raw = JSON.parse(readFileSync(INDEX_FILE, "utf-8"));
    return raw?.workspaces && typeof raw.workspaces === "object"
      ? raw.workspaces
      : {};
  } catch {
    return {};
  }
}

function writeIndexRegistry(registry) {
  try {
    writeFileSync(
      INDEX_FILE,
      JSON.stringify({ workspaces: registry }, null, 2),
    );
  } catch {}
}

function updateIndexRegistry(workspacePath, patch) {
  const registry = readIndexRegistry();
  registry[workspacePath] = { ...(registry[workspacePath] || {}), ...patch };
  writeIndexRegistry(registry);
}

// ── Indexer Daemon ─────────────────────────────────────────────────────────────

/**
 * Starts the codebase indexer for `workspacePath` as a detached background
 * process. Returns "started" if a fresh daemon was launched, "running" if
 * one was already alive for that workspace, or "skipped" on failure.
 *
 * Tracks per-workspace PIDs in INDEX_FILE so that switching projects starts
 * an independent daemon per workspace without killing earlier ones.
 */
function startIndexerDaemon(workspacePath) {
  const resolvedPath = resolve(workspacePath || process.cwd());
  const registry = readIndexRegistry();
  const existing = registry[resolvedPath];

  if (existing?.pid && isProcessAlive(existing.pid)) {
    return "running";
  }

  try {
    mkdirSync(ORB_DIR, { recursive: true });
    const logFile = join(ORB_DIR, "indexer.log");
    const out = openSync(logFile, "a");

    const child = spawn(
      "node",
      [join(__dirname, "orb-cli.js"), "index", resolvedPath],
      {
        detached: true,
        stdio: ["ignore", out, out],
        env: { ...process.env, ORB_INDEXER_DAEMON: "1" },
      },
    );
    child.unref();

    updateIndexRegistry(resolvedPath, {
      pid: child.pid,
      startedAt: new Date().toISOString(),
    });

    return "started";
  } catch (err) {
    console.error(`Failed to start indexer daemon: ${err?.message || err}`);
    return "skipped";
  }
}

function isProxyRunning() {
  const info = getProxyInfo();
  if (!info?.pid) return false;
  return isProcessAlive(info.pid);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findOpenPort(startPort) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(startPort, "127.0.0.1", () => {
      server.close(() => resolve(startPort));
    });
    server.on("error", () => {
      resolve(findOpenPort(startPort + 1));
    });
  });
}

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} "${url}"`, (err) => {
    if (err) {
      // Silent — the URL is already printed for manual access
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
