/**
 * Chunking and indexing constants
 */

// Parser / Chunker
export const MAX_BLOCK_CHARS = 1000;
export const MIN_BLOCK_CHARS = 50;
export const MIN_CHUNK_REMAINDER_CHARS = 200;
export const MAX_CHARS_TOLERANCE_FACTOR = 1.15;

// File Watcher
export const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024; // 1MB
export const BATCH_DEBOUNCE_MS = 500;
export const FILE_PROCESSING_CONCURRENCY = 10;

// Batching
export const BATCH_SEGMENT_THRESHOLD = 10;
export const MAX_BATCH_RETRIES = 3;
export const INITIAL_RETRY_DELAY_MS = 500;

// Vector Store
export const QDRANT_CODE_BLOCK_NAMESPACE =
  "f47ac10b-58cc-4372-a567-0e02b2c3d479";

// Supported file extensions for indexing
export const INDEXABLE_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".java",
  ".kt",
  ".scala",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".c",
  ".cpp",
  ".cc",
  ".h",
  ".hpp",
  ".cs",
  ".fs",
  ".fsx",
  ".swift",
  ".dart",
  ".lua",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".md",
  ".markdown",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".sql",
  ".graphql",
  ".gql",
  ".vue",
  ".svelte",
  ".r",
  ".pl",
  ".pm",
  ".vb",
];
