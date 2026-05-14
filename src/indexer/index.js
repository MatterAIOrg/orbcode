/**
 * Main indexing entry point
 * Provides a simple API to start/stop codebase indexing
 */

import { CodeIndexer } from "./indexer.js";
import { HttpVectorStore } from "./vector-store.js";

/**
 * Start codebase indexing for a workspace
 * @param {Object} options - Options
 * @param {string} options.workspacePath - Path to the workspace
 * @param {string} options.apiKey - MatterAI API key
 * @param {string} [options.baseUrl] - MatterAI API base URL
 * @param {Function} [options.onProgress] - Progress callback
 * @returns {Promise<CodeIndexer>} The indexer instance
 */
export async function startIndexing(options) {
  const {
    workspacePath,
    apiKey,
    baseUrl = "https://api.matterai.so",
    onProgress = () => {},
  } = options;

  // Create vector store client
  const vectorStore = new HttpVectorStore(
    workspacePath,
    baseUrl,
    1536, // text-embedding-3-small vector size
    apiKey,
  );

  // Create indexer
  const indexer = new CodeIndexer({
    workspacePath,
    vectorStore,
    apiKey,
    baseUrl,
    onProgress,
  });

  // Perform initial indexing
  console.log("[IndexManager] Starting codebase indexing...");
  const result = await indexer.performInitialIndexing();
  console.log(
    "[IndexManager] Initial indexing complete:",
    result.indexed,
    "files indexed,",
    result.skipped,
    "skipped,",
    result.totalPoints,
    "total points",
  );

  // Start file watcher for incremental updates
  indexer.startFileWatcher();

  return indexer;
}

/**
 * Stop codebase indexing
 * @param {CodeIndexer} indexer - The indexer instance to stop
 */
export function stopIndexing(indexer) {
  if (indexer) {
    indexer.stop();
    console.log("[IndexManager] Indexing stopped");
  }
}

// Re-export classes for advanced usage
export { CodeIndexer } from "./indexer.js";
export { HttpVectorStore } from "./vector-store.js";
export { FileWatcher } from "./file-watcher.js";
export { parseFile, performFallbackChunking } from "./chunker.js";
