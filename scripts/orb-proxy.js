#!/usr/bin/env node

/**
 * OrbCode Local Proxy Server
 *
 * Intercepts Anthropic API calls from Claude Code and routes them through
 * the MatterAI orbinference API before forwarding to Anthropic.
 *
 * Flow:
 *   Claude Code  →  Local Proxy  →  api.matterai.so/v1/orbinference
 *                                          ↓ (modified body + headers)
 *                                    Anthropic API
 *                                          ↓
 *                    Claude Code  ←  Response (streamed)
 */

import http from "node:http";
import https from "node:https";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  collectEnvironmentDetails,
  formatEnvironmentDetails,
} from "./orb-env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Constants ──────────────────────────────────────────────────────────────────

const ORB_DIR = join(homedir(), ".claude", "orbcode");
const AUTH_FILE = join(ORB_DIR, "auth.json");
const PROXY_FILE = join(ORB_DIR, "proxy.json");
const LOG_FILE = join(ORB_DIR, "proxy.log");
const DEFAULT_PORT = 7856;
const MATTERAI_HOST = "https://proxy.matterai.so";
const MATTERAI_PATH = "";
const ANTHROPIC_HOST = "api.anthropic.com";

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  // When spawned detached by the session hook, stderr is already redirected to
  // LOG_FILE. Writing via both stderr AND appendFileSync produced every line
  // twice. Only mirror to stderr when it's a TTY (interactive manual runs).
  if (process.stderr.isTTY) process.stderr.write(line);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {}
}

function getAuthToken() {
  try {
    const data = JSON.parse(readFileSync(AUTH_FILE, "utf-8"));
    return data.access_token || null;
  } catch {
    return null;
  }
}

function getUserRole() {
  try {
    const roleFile = join(ORB_DIR, "role.json");
    const data = JSON.parse(readFileSync(roleFile, "utf-8"));
    return data.role || "";
  } catch {
    return "";
  }
}

function collectBody(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function makeRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "http:" ? http : https;
    const req = transport.request(parsed, options, (res) => resolve(res));
    req.on("error", reject);
    // 10 minutes timeout to allow extended thinking and long inferences
    req.setTimeout(600000, () => req.destroy(new Error("Request timed out")));
    if (body) req.write(body);
    req.end();
  });
}

let _workspaceCache = null;

function getWorkspaceInfo() {
  if (_workspaceCache) return _workspaceCache;

  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let repo = "";
  let branch = "";

  // stdio: suppress git's "fatal: not a git repository" stderr noise that
  // otherwise leaks into proxy.log for non-git workspaces.
  const opts = { cwd: dir, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] };

  try {
    repo = execSync("git remote get-url origin", opts).toString().trim();
  } catch {}

  try {
    branch = execSync("git rev-parse --abbrev-ref HEAD", opts)
      .toString()
      .trim();
  } catch {}

  _workspaceCache = { dir, repo, branch };
  return _workspaceCache;
}

// Per-process tracking of sessions that have already received their workspace
// `<environment_details>` snapshot. The proxy attaches the full snapshot on
// every request (the backend dedupes), but we also keep this so we can include
// a `firstRequest` flag — a hint the backend can use for cheap fast-path skips
// without consulting its own session store.
const _sessionsSeen = new Set();

function getClaudeSessionId(headers) {
  // Claude Code sends one of several aliases depending on version. Mirror the
  // backend's lookup order so the "first request per session" signal we send
  // lines up with the backend's session dedupe map.
  const candidates = [
    "x-claude-code-session-id",
    "x-claude-session-id",
    "x-claude-code-ide-session-id",
    "x-orb-session-id",
    "x-session-id",
    "anthropic-session-id",
  ];
  for (const name of candidates) {
    const v = headers?.[name] || headers?.[name.toLowerCase()];
    if (v) return Array.isArray(v) ? v[0] : String(v);
  }
  return "";
}

function buildEnvironmentDetailsPayload(headers) {
  let details;
  try {
    details = collectEnvironmentDetails();
  } catch (err) {
    log(`  ⚠ Failed to collect environment details: ${err.message}`);
    return null;
  }

  const sessionId = getClaudeSessionId(headers);
  const firstRequest = sessionId ? !_sessionsSeen.has(sessionId) : true;
  if (sessionId) _sessionsSeen.add(sessionId);

  let rendered = "";
  try {
    rendered = formatEnvironmentDetails(details);
  } catch (err) {
    log(`  ⚠ Failed to format environment details: ${err.message}`);
  }

  return {
    sessionId,
    firstRequest,
    details,
    rendered,
  };
}

// Only inference calls (POST /v1/messages...) should be routed through
// MatterAI's orbinference endpoint. Health-check pings (HEAD /), model lists,
// and any other Anthropic endpoints must go directly to Anthropic — otherwise
// the extra MatterAI hop adds ~1s of latency to Claude Code's initial
// connectivity probe, which then surfaces as "unable to reach API" on the
// first request of a session.
function shouldRouteThroughMatterAI(method, url) {
  if (method !== "POST") return false;
  // Strip querystring before path match.
  const path = (url || "").split("?")[0];
  return path === "/v1/messages" || path.startsWith("/v1/messages/");
}

// ── Request Handler ────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const token = getAuthToken();

  if (!token) {
    log(`REJECT ${req.method} ${req.url} — not authenticated`);
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message:
            "OrbCode: Not authenticated. Run /orb-login in Claude Code first.",
        },
      }),
    );
    return;
  }

  log(`PROXY ${req.method} ${req.url}`);

  try {
    // 1. Collect the incoming request body
    const rawBody = await collectBody(req);
    const bodyStr = rawBody.toString("utf-8");

    // 2. Decide whether to route this request through MatterAI's orbinference
    //    endpoint, or forward it directly to Anthropic. Only inference POSTs
    //    need MatterAI rewriting — health-check pings, model lists, etc. must
    //    bypass it.
    const routeViaMatterAI = shouldRouteThroughMatterAI(req.method, req.url);

    let modifiedBody;
    let anthropicHeaders;
    let anthropicPath;

    if (routeViaMatterAI) {
      let parsedBody = null;
      try {
        if (bodyStr) parsedBody = JSON.parse(bodyStr);
      } catch {
        parsedBody = bodyStr; // Forward raw if not JSON
      }

      // Always attach the workspace environment snapshot. The backend dedupes
      // per-session, but the plugin's `firstRequest` flag lets it skip the
      // session-store lookup on subsequent turns in the same session.
      const envPayload = buildEnvironmentDetailsPayload(req.headers);

      const orbPayload = JSON.stringify({
        path: req.url,
        method: req.method,
        body: parsedBody,
        headers: req.headers,
        environmentDetails: envPayload
          ? {
              sessionId: envPayload.sessionId,
              firstRequest: envPayload.firstRequest,
              details: envPayload.details,
              rendered: envPayload.rendered,
            }
          : null,
      });

      const orbUrl = `${MATTERAI_HOST}${MATTERAI_PATH}`;

      log(
        `  → MatterAI ${orbUrl} (${Buffer.byteLength(orbPayload)} bytes, env=${
          envPayload ? (envPayload.firstRequest ? "first" : "cached") : "none"
        })`,
      );

      const workspace = getWorkspaceInfo();

      const orbResponse = await makeRequest(
        orbUrl,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(orbPayload),
            Authorization: `Bearer ${token}`,
            "User-Agent": req.headers["user-agent"] || "claude-code",
            "x-user-agent": "OrbCode/0.1.0",
            "x-workspace": workspace.dir,
            "x-git-repo": workspace.repo,
            "x-git-branch": workspace.branch,
            "x-orb-session-id": envPayload?.sessionId || "",
            "x-orb-env-first-request": envPayload
              ? String(envPayload.firstRequest)
              : "false",
            "x-orb-role": getUserRole(),
          },
        },
        orbPayload,
      );

      // 4. Read orbinference response
      const orbBody = await collectBody(orbResponse);
      const orbBodyStr = orbBody.toString("utf-8");

      if (orbResponse.statusCode !== 200) {
        log(
          `  ✗ MatterAI returned ${orbResponse.statusCode}: ${orbBodyStr.slice(0, 200)}`,
        );
        res.writeHead(orbResponse.statusCode, {
          "Content-Type": "application/json",
        });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "api_error",
              message: `OrbCode: MatterAI API returned ${orbResponse.statusCode}. ${orbBodyStr.slice(0, 500)}`,
            },
          }),
        );
        return;
      }

      let orbData;
      try {
        orbData = JSON.parse(orbBodyStr);
      } catch (e) {
        log(`  ✗ Failed to parse MatterAI response: ${e.message}`);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "api_error",
              message: "OrbCode: Invalid response from MatterAI API.",
            },
          }),
        );
        return;
      }

      // 5. Build the modified request to Anthropic
      modifiedBody =
        typeof orbData.body === "string"
          ? orbData.body
          : JSON.stringify(orbData.body);

      anthropicHeaders = { ...(orbData.headers || {}) };
      anthropicPath = orbData.path || req.url;
    } else {
      // Bypass MatterAI — forward the request as-is to Anthropic.
      log(`  → bypass MatterAI (non-inference ${req.method} ${req.url})`);
      modifiedBody = bodyStr;
      anthropicHeaders = { ...req.headers };
      anthropicPath = req.url;
    }

    // Ensure required headers are set
    anthropicHeaders["host"] = ANTHROPIC_HOST;
    if (req.method === "HEAD" || req.method === "GET" || !modifiedBody) {
      delete anthropicHeaders["content-length"];
    } else {
      anthropicHeaders["content-length"] = String(
        Buffer.byteLength(modifiedBody),
      );
    }

    // Remove proxy-specific headers that shouldn't go to Anthropic
    delete anthropicHeaders["transfer-encoding"];
    delete anthropicHeaders["connection"];

    log(
      `  → Anthropic ${req.method} ${anthropicPath} (${Buffer.byteLength(modifiedBody || "")} bytes)`,
    );

    // 6. Forward to Anthropic and stream the response back
    const anthropicReq = https.request({
      hostname: ANTHROPIC_HOST,
      port: 443,
      path: anthropicPath,
      method: req.method,
      headers: anthropicHeaders,
    });
    // 10 minutes timeout to allow extended thinking and long inferences
    anthropicReq.setTimeout(600000, () => {
      anthropicReq.destroy(new Error("Anthropic request timed out"));
    });

    let responseStarted = false;

    anthropicReq.on("response", (anthropicRes) => {
      responseStarted = true;
      log(
        `  ← Anthropic ${anthropicRes.statusCode} (${anthropicRes.headers["content-type"] || "unknown"})`,
      );

      // Forward response headers, but strip hop-by-hop + framing headers.
      //
      // CRITICAL: Node's http client auto-decodes `transfer-encoding: chunked`
      // from the upstream response — `anthropicRes.on('data')` yields the
      // already-decoded body. If we echo `transfer-encoding: chunked` into
      // `res.writeHead()`, Node's server side assumes our writes are
      // pre-chunked and forwards them verbatim. The client then sees raw SSE
      // bytes labeled as chunked-encoded → parser error → connection drop.
      // That's exactly the "unable to reach API" behavior on the first
      // request. Strip it and let Node re-chunk automatically.
      const responseHeaders = {};
      for (const [key, value] of Object.entries(anthropicRes.headers)) {
        const lk = key.toLowerCase();
        if (lk === "connection" || lk === "keep-alive") continue;
        if (lk === "transfer-encoding") continue;
        // content-length from upstream can be wrong after Node decodes
        // the body (e.g. if upstream compressed or chunked); drop it for
        // streaming responses so Node computes framing itself.
        if (lk === "content-length") continue;
        responseHeaders[key] = value;
      }

      res.writeHead(anthropicRes.statusCode, responseHeaders);

      // Stream the response through. pipe() handles backpressure, flushing,
      // and end-of-stream correctly — and importantly flushes each chunk
      // promptly rather than buffering, which matters for SSE.
      anthropicRes.pipe(res);

      anthropicRes.on("end", () => {
        log(`  ✓ Response complete`);
      });

      anthropicRes.on("error", (err) => {
        log(`  ✗ Response stream error: ${err.message}`);
        if (!res.writableEnded) res.end();
      });

      // If the client disconnects mid-stream, abort the upstream request so
      // we don't keep consuming bandwidth from Anthropic for a response
      // nobody's reading.
      res.on("close", () => {
        if (!anthropicRes.complete) {
          log(`  ⚠ Client disconnected mid-stream — aborting upstream`);
          anthropicReq.destroy();
        }
      });
    });

    anthropicReq.on("error", (err) => {
      log(`  ✗ Anthropic request error: ${err.message}`);
      // Only write error response if we haven't already sent headers
      if (!responseStarted && !res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "api_error",
              message: `OrbCode: Failed to reach Anthropic API: ${err.message}`,
            },
          }),
        );
      } else if (!res.writableEnded) {
        // If response already started, just close the stream
        res.end();
      }
    });

    if (modifiedBody && req.method !== "HEAD" && req.method !== "GET") {
      anthropicReq.write(modifiedBody);
    }
    anthropicReq.end();
  } catch (err) {
    log(`  ✗ Proxy error: ${err.message}`);
    // Only write an error response if we haven't already started streaming.
    // After headers are sent (e.g. mid-stream from Anthropic), writeHead
    // would throw ERR_HTTP_HEADERS_SENT and crash the proxy.
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: `OrbCode: Proxy error — ${err.message}`,
          },
        }),
      );
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

// ── Health Check ───────────────────────────────────────────────────────────────

function handleHealth(req, res) {
  if (req.url === "/__orb/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        authenticated: !!getAuthToken(),
        uptime: process.uptime(),
        pid: process.pid,
      }),
    );
    return true;
  }
  return false;
}

// ── Server ─────────────────────────────────────────────────────────────────────

const port = parseInt(process.argv[2]) || DEFAULT_PORT;

mkdirSync(ORB_DIR, { recursive: true });

const server = http.createServer(
  {
    // Allow up to 10 minutes for the full request/response cycle.
    // The default requestTimeout (5 min on Node 19+) is too tight
    // for long inference + extended thinking through the proxy chain.
    requestTimeout: 600000,
    headersTimeout: 60000,
  },
  (req, res) => {
    // Health check endpoint
    if (handleHealth(req, res)) return;
    // All other requests are proxied
    handleRequest(req, res);
  },
);

server.listen(port, "127.0.0.1", () => {
  log(
    `OrbCode proxy started on http://127.0.0.1:${port} (PID: ${process.pid})`,
  );
  console.log(
    JSON.stringify({
      status: "running",
      port,
      pid: process.pid,
      url: `http://127.0.0.1:${port}`,
    }),
  );

  // Write proxy state file
  writeFileSync(
    PROXY_FILE,
    JSON.stringify(
      {
        port,
        pid: process.pid,
        url: `http://127.0.0.1:${port}`,
        started: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      JSON.stringify({
        status: "error",
        error: `Port ${port} already in use. Proxy may already be running.`,
      }),
    );
    process.exit(1);
  }
  log(`Server error: ${err.message}`);
  process.exit(1);
});

// Handle malformed/early-closed client requests without crashing.
// Without this, a client TCP reset during handshake can emit a 'clientError'
// event that, if unhandled, takes the process down.
server.on("clientError", (err, socket) => {
  log(`Client error: ${err.message} (code=${err.code || "none"})`);
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } else {
    socket.destroy();
  }
});

// ── Graceful Shutdown ──────────────────────────────────────────────────────────

function shutdown(signal) {
  log(`Received ${signal}, shutting down...`);
  server.close(() => {
    try {
      unlinkSync(PROXY_FILE);
    } catch {}
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Prevent unhandled rejections from crashing the proxy
process.on("unhandledRejection", (err) => {
  log(`Unhandled rejection: ${err?.message || err}`);
});

// Last-resort safety net: keep the proxy alive across any synchronous throw
// that escapes a callback (e.g. ERR_HTTP_HEADERS_SENT inside a response
// 'error' handler). Without this, a single stray exception during a long
// Claude Code session would kill the proxy and force the SessionStart hook
// to respawn it — which is exactly the mid-session interruption we're trying
// to eliminate. We log the error and keep serving.
process.on("uncaughtException", (err) => {
  log(`Uncaught exception (proxy kept alive): ${err?.stack || err?.message || err}`);
});
