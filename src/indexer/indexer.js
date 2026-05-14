/**
 * Code Indexer Service
 * Manages codebase indexing with initial scan and incremental updates
 */

import { readdir, stat, readFile } from "fs/promises";
import { join, relative, extname } from "path";
import { createHash, randomUUID } from "crypto";
import {
  INDEXABLE_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  BATCH_SEGMENT_THRESHOLD,
  MAX_BATCH_RETRIES,
  INITIAL_RETRY_DELAY_MS,
  FILE_PROCESSING_CONCURRENCY,
  QDRANT_CODE_BLOCK_NAMESPACE,
} from "./constants.js";
import { parseFile, createFileHash } from "./chunker.js";
import { FileWatcher } from "./file-watcher.js";

/**
 * @typedef {Object} IndexerOptions
 * @property {string} workspacePath - Path to the workspace
 * @property {HttpVectorStore} vectorStore - Vector store client
 * @property {string} apiKey - API key for embeddings
 * @property {string} [baseUrl] - Base URL for embeddings API
 * @property {Function} [onProgress] - Progress callback
 */

export class CodeIndexer {
  /**
   * Creates a new code indexer
   * @param {IndexerOptions} options - Indexer options
   */
  constructor(options) {
    this.workspacePath = options.workspacePath;
    this.vectorStore = options.vectorStore;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl || "https://api.matterai.so";
    this.onProgress = options.onProgress || (() => {});

    this.fileWatcher = null;
    this.cache = new Map(); // file path -> { hash, mtime }
    this.isIndexing = false;
  }

  /**
   * Check if file extension is supported
   * @param {string} filePath - File path
   * @returns {boolean}
   */
  _isSupportedFile(filePath) {
    const ext = extname(filePath).toLowerCase();
    return INDEXABLE_EXTENSIONS.includes(ext);
  }

  /**
   * Check if path should be ignored
   * @param {string} filePath - File path
   * @returns {boolean}
   */
  _shouldIgnore(filePath) {
    const ignoredPaths = [
      "node_modules",
      ".git",
      ".claude",
      "dist",
      "build",
      ".next",
      ".nuxt",
      "coverage",
      ".coverage",
      ".vscode",
      ".idea",
      ".cache",
    ];

    const normalizedPath = filePath.replace(/\\/g, "/");
    for (const pattern of ignoredPaths) {
      if (normalizedPath.includes("/" + pattern + "/")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all files recursively
   * @param {string} dir - Directory to scan
   * @returns {Promise<string[]>} Array of file paths
   */
  async _getAllFiles(dir) {
    const files = [];

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (this._shouldIgnore(fullPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          const subFiles = await this._getAllFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile() && this._isSupportedFile(fullPath)) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.error("Error reading directory " + dir + ":", error);
    }

    return files;
  }

  /**
   * Create embeddings for text batches
   * @param {string[]} texts - Array of texts to embed
   * @returns {Promise<number[][]>} Array of embedding vectors
   */
  async _createEmbeddings(texts) {
    const response = await fetch(this.baseUrl + "/orb-embedding/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + this.apiKey,
      },
      body: JSON.stringify({
        model: "matterai-orb-embedding",
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error("Embedding API error: " + error);
    }

    const result = await response.json();
    return result.data.map((d) => d.embedding);
  }

  /**
   * Process a single file and return points to upsert
   * @param {string} filePath - Path to the file
   * @returns {Promise<{points: Array, hash: string, filePath: string} | null>}
   */
  async _processFile(filePath) {
    try {
      // Check file size
      const stats = await stat(filePath);
      if (stats.size > MAX_FILE_SIZE_BYTES) {
        console.log("Skipping large file: " + filePath);
        return null;
      }

      // Read and hash file
      const content = await readFile(filePath, "utf8");
      const hash = createFileHash(content);

      // Check cache
      const cached = this.cache.get(filePath);
      if (cached && cached.hash === hash) {
        return null; // File unchanged
      }

      // Parse file into chunks
      const blocks = await parseFile(filePath, { content, fileHash: hash });

      if (blocks.length === 0) {
        return null;
      }

      // Create embeddings for blocks
      const texts = blocks.map((b) => b.content);
      const embeddings = await this._createEmbeddings(texts);

      // Prepare points
      const points = blocks.map((block, index) => {
        const relativePath = relative(this.workspacePath, block.file_path);
        const stableName =
          relativePath + ":" + block.start_line + ":" + block.segmentHash;
        const pointId = this._generateUuidV5(
          stableName,
          QDRANT_CODE_BLOCK_NAMESPACE,
        );

        return {
          id: pointId,
          vector: embeddings[index],
          payload: {
            filePath: relativePath,
            codeChunk: block.content,
            startLine: block.start_line,
            endLine: block.end_line,
            segmentHash: block.segmentHash,
          },
        };
      });

      return { points, hash, filePath };
    } catch (error) {
      console.error("Error processing file " + filePath + ":", error);
      return null;
    }
  }

  /**
   * Generate UUID v5
   * @param {string} name - Name to hash
   * @param {string} namespace - Namespace UUID
   * @returns {string} UUID v5 string
   */
  _generateUuidV5(name, namespace) {
    // Simple UUID v5 implementation using SHA-256
    const hash = createHash("sha256")
      .update(namespace + name)
      .digest("hex");
    return (
      hash.substring(0, 8) +
      "-" +
      hash.substring(8, 12) +
      "-" +
      "5" +
      hash.substring(13, 16) +
      "-" +
      ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16) +
      hash.substring(18, 20) +
      "-" +
      hash.substring(20, 32)
    );
  }

  /**
   * Process batch of files with concurrency limit
   * @param {string[]} filePaths - Array of file paths
   * @param {Function} onFileProcessed - Callback when file is processed
   */
  async _processFilesBatch(filePaths, onFileProcessed) {
    const results = [];
    const queue = [...filePaths];
    const inProgress = new Set();

    return new Promise((resolve, reject) => {
      const processNext = async () => {
        if (queue.length === 0 && inProgress.size === 0) {
          resolve(results);
          return;
        }

        while (
          inProgress.size < FILE_PROCESSING_CONCURRENCY &&
          queue.length > 0
        ) {
          const filePath = queue.shift();
          inProgress.add(filePath);

          this._processFile(filePath)
            .then((result) => {
              inProgress.delete(filePath);
              if (result) {
                results.push(result);
              }
              onFileProcessed(filePath, result != null);
              processNext();
            })
            .catch((error) => {
              inProgress.delete(filePath);
              console.error("Failed to process " + filePath + ":", error);
              onFileProcessed(filePath, false);
              processNext();
            });
        }
      };

      processNext();
    });
  }

  /**
   * Upsert points to vector store with batching and retries
   * @param {Array} points - Points to upsert
   */
  async _upsertPoints(points) {
    for (let i = 0; i < points.length; i += BATCH_SEGMENT_THRESHOLD) {
      const batch = points.slice(i, i + BATCH_SEGMENT_THRESHOLD);
      let attempts = 0;
      let success = false;

      while (attempts < MAX_BATCH_RETRIES && !success) {
        attempts++;
        try {
          await this.vectorStore.upsertPoints(batch);
          success = true;
        } catch (error) {
          console.error("Upsert attempt " + attempts + " failed:", error);
          if (attempts < MAX_BATCH_RETRIES) {
            const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempts - 1);
            await new Promise((r) => setTimeout(r, delay));
          } else {
            throw error;
          }
        }
      }
    }
  }

  /**
   * Perform initial indexing of the workspace
   * @returns {Promise<{indexed: number, skipped: number}>}
   */
  async performInitialIndexing() {
    if (this.isIndexing) {
      throw new Error("Indexing already in progress");
    }

    this.isIndexing = true;
    console.log("[Indexer] Starting initial indexing...");

    try {
      // Initialize vector store
      await this.vectorStore.initialize();

      // Get all files
      const allFiles = await this._getAllFiles(this.workspacePath);
      console.log("[Indexer] Found " + allFiles.length + " files to index");

      let processed = 0;
      let indexed = 0;
      let allPoints = [];
      const fileHashes = new Map();

      // Process files in batches
      await this._processFilesBatch(allFiles, (filePath, wasIndexed) => {
        processed++;
        if (wasIndexed) indexed++;
        this.onProgress({
          type: "processing",
          processed,
          total: allFiles.length,
          currentFile: filePath,
        });
      });

      // Collect all points
      // (We need to re-process to get the points since we didn't store them above)
      for (const filePath of allFiles) {
        const result = await this._processFile(filePath);
        if (result) {
          allPoints.push(...result.points);
          fileHashes.set(filePath, result.hash);
        }
      }

      // Delete old points for modified files
      const modifiedFiles = Array.from(fileHashes.keys());
      if (modifiedFiles.length > 0) {
        try {
          await this.vectorStore.deletePointsByMultipleFilePaths(modifiedFiles);
        } catch (error) {
          console.error("Error deleting old points:", error);
        }
      }

      // Upsert all points in batches
      if (allPoints.length > 0) {
        console.log("[Indexer] Upserting " + allPoints.length + " points...");
        await this._upsertPoints(allPoints);

        // Update cache
        for (const [filePath, hash] of fileHashes) {
          this.cache.set(filePath, { hash, mtime: Date.now() });
        }
      }

      // Clean up deleted files from cache
      const currentFiles = new Set(allFiles);
      for (const cachedPath of this.cache.keys()) {
        if (!currentFiles.has(cachedPath)) {
          this.cache.delete(cachedPath);
          try {
            await this.vectorStore.deletePointsByFilePath(cachedPath);
          } catch (error) {
            console.error("Error deleting points for removed file:", error);
          }
        }
      }

      console.log(
        "[Indexer] Initial indexing complete. Indexed " + indexed + " files.",
      );

      return {
        indexed,
        skipped: allFiles.length - indexed,
        totalPoints: allPoints.length,
      };
    } finally {
      this.isIndexing = false;
    }
  }

  /**
   * Process a batch of file events from the watcher
   * @param {Array<{path: string, type: string}>} events - File events
   */
  async processFileEvents(events) {
    const filesToUpsert = [];
    const filesToDelete = [];

    for (const event of events) {
      if (event.type === "delete") {
        filesToDelete.push(event.path);
      } else {
        filesToUpsert.push(event.path);
      }
    }

    // Delete points for deleted files
    if (filesToDelete.length > 0) {
      try {
        await this.vectorStore.deletePointsByMultipleFilePaths(filesToDelete);
        for (const filePath of filesToDelete) {
          this.cache.delete(filePath);
        }
        console.log(
          "[Indexer] Deleted " + filesToDelete.length + " files from index",
        );
      } catch (error) {
        console.error("Error deleting points:", error);
      }
    }

    // Process modified/created files
    if (filesToUpsert.length > 0) {
      const allPoints = [];
      const fileHashes = new Map();

      for (const filePath of filesToUpsert) {
        const result = await this._processFile(filePath);
        if (result) {
          allPoints.push(...result.points);
          fileHashes.set(filePath, result.hash);
        }
      }

      if (allPoints.length > 0) {
        // Delete old points first
        try {
          await this.vectorStore.deletePointsByMultipleFilePaths(filesToUpsert);
        } catch (error) {
          console.error("Error deleting old points:", error);
        }

        // Upsert new points
        await this._upsertPoints(allPoints);

        // Update cache
        for (const [filePath, hash] of fileHashes) {
          this.cache.set(filePath, { hash, mtime: Date.now() });
        }

        console.log(
          "[Indexer] Updated " + filesToUpsert.length + " files in index",
        );
      }
    }
  }

  /**
   * Start file watcher for incremental indexing
   */
  startFileWatcher() {
    if (this.fileWatcher) {
      return;
    }

    this.fileWatcher = new FileWatcher({
      workspacePath: this.workspacePath,
      onBatch: (events) => {
        this.processFileEvents(events).catch((error) => {
          console.error("Error processing file events:", error);
        });
      },
    });

    this.fileWatcher.start();
    console.log("[Indexer] File watcher started");
  }

  /**
   * Stop file watcher
   */
  stopFileWatcher() {
    if (this.fileWatcher) {
      this.fileWatcher.stop();
      this.fileWatcher = null;
      console.log("[Indexer] File watcher stopped");
    }
  }

  /**
   * Stop all indexing activities
   */
  stop() {
    this.stopFileWatcher();
    this.isIndexing = false;
  }
}
