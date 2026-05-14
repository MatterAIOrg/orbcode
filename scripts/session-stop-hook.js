#!/usr/bin/env node

/**
 * OrbCode Session Stop Hook
 *
 * Previously killed the proxy daemon, but that caused "ConnectionRefused"
 * on continued/new sessions because the proxy is a long-running daemon.
 * The proxy now stays alive across Claude Code sessions.
 */

// No-op — proxy remains running as a daemon
