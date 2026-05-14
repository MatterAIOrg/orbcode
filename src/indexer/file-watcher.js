/**
 * File watcher module
 * Watches for file changes and triggers re-indexing
 */

import { watch } from "fs";
import { join, extname } from "path";
import { INDEXABLE_EXTENSIONS, BATCH_DEBOUNCE_MS } from "./constants.js";

/**
 * @typedef {Object} FileEvent
 * @property {string} path - File path
 * @property {"create" | "change" | "delete"} type - Event type
 */

/**
 * @typedef {Object} WatchOptions
 * @property {string} workspacePath - Path to watch
 * @property {Function} onBatch - Callback for batch of file events
 * @property {string[]} [ignorePatterns] - Patterns to ignore
 */

export class FileWatcher {
  /**
   * Creates a new file watcher
   * @param {WatchOptions} options - Watch options
   */
  constructor(options) {
    this.workspacePath = options.workspacePath;
    this.onBatch = options.onBatch;
    this.ignorePatterns = options.ignorePatterns || [
      "node_modules",
      ".git",
      ".claude",
      "dist",
      "build",
      ".next",
      ".nuxt",
      "coverage",
      ".coverage",
    ];

    this.watchers = new Map();
    this.accumulatedEvents = new Map();
    this.batchDebounceTimer = null;
    this.isRunning = false;
  }

  /**
   * Check if path should be ignored
   * @param {string} filePath - Path to check
   * @returns {boolean}
   */
  _shouldIgnore(filePath) {
    const normalizedPath = filePath.replace(/\\/g, "/");

    // Check ignore patterns
    for (const pattern of this.ignorePatterns) {
      if (normalizedPath.includes("/" + pattern + "/")) {
        return true;
      }
    }

    // Check if extension is supported
    const ext = extname(filePath).toLowerCase();
    if (!INDEXABLE_EXTENSIONS.includes(ext)) {
      return true;
    }

    return false;
  }

  /**
   * Schedule batch processing with debounce
   */
  _scheduleBatchProcessing() {
    if (this.batchDebounceTimer) {
      clearTimeout(this.batchDebounceTimer);
    }

    this.batchDebounceTimer = setTimeout(() => {
      this._triggerBatchProcessing();
    }, BATCH_DEBOUNCE_MS);
  }

  /**
   * Trigger processing of accumulated events
   */
  _triggerBatchProcessing() {
    if (this.accumulatedEvents.size === 0) {
      return;
    }

    const eventsToProcess = new Map(this.accumulatedEvents);
    this.accumulatedEvents.clear();

    const fileEvents = Array.from(eventsToProcess.values());
    this.onBatch(fileEvents);
  }

  /**
   * Handle file event
   * @param {string} filePath - File path
   * @param {"create" | "change" | "delete"} type - Event type
   */
  _handleFileEvent(filePath, type) {
    if (this._shouldIgnore(filePath)) {
      return;
    }

    this.accumulatedEvents.set(filePath, { path: filePath, type });
    this._scheduleBatchProcessing();
  }

  /**
   * Watch a directory
   * @param {string} dirPath - Directory to watch
   */
  _watchDirectory(dirPath) {
    if (this._shouldIgnore(dirPath)) {
      return;
    }

    try {
      const watcher = watch(
        dirPath,
        { recursive: false },
        (eventType, filename) => {
          if (!filename) return;

          const fullPath = join(dirPath, filename);

          // Skip if ignored
          if (this._shouldIgnore(fullPath)) {
            return;
          }

          // Determine event type
          let type = "change";
          if (eventType === "rename") {
            type = "change";
          }

          this._handleFileEvent(fullPath, type);
        },
      );

      this.watchers.set(dirPath, watcher);
    } catch (error) {
      console.error("Error watching directory " + dirPath + ":", error);
    }
  }

  /**
   * Start watching the workspace
   */
  start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this._watchDirectory(this.workspacePath);

    console.log("[FileWatcher] Started watching " + this.workspacePath);
  }

  /**
   * Stop watching
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    // Clear any pending batch
    if (this.batchDebounceTimer) {
      clearTimeout(this.batchDebounceTimer);
      this.batchDebounceTimer = null;
    }

    // Close all watchers
    for (const [path, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();

    // Process any remaining events
    this._triggerBatchProcessing();

    this.isRunning = false;
    console.log("[FileWatcher] Stopped");
  }
}
