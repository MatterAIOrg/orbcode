/**
 * Code chunking module - implements fallback chunking strategy
 * Based on the reference implementation in mattercode
 */

import { createHash } from "crypto";
import {
  MAX_BLOCK_CHARS,
  MIN_BLOCK_CHARS,
  MIN_CHUNK_REMAINDER_CHARS,
  MAX_CHARS_TOLERANCE_FACTOR,
} from "./constants.js";

/**
 * @typedef {Object} CodeBlock
 * @property {string} file_path - Path to the file
 * @property {string|null} identifier - Optional identifier (function name, etc.)
 * @property {string} type - Type of block
 * @property {number} start_line - Start line (1-based)
 * @property {number} end_line - End line (1-based)
 * @property {string} content - Block content
 * @property {string} segmentHash - Unique hash for this segment
 * @property {string} fileHash - Hash of the entire file
 */

/**
 * Creates a hash for file content
 * @param {string} content - File content
 * @returns {string} SHA256 hash
 */
export function createFileHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Chunk text by lines, avoiding tiny remainders
 * @param {string[]} lines - Array of lines to chunk
 * @param {string} filePath - Path to the file
 * @param {string} fileHash - Hash of the file
 * @param {string} chunkType - Type of chunk
 * @param {Set<string>} seenSegmentHashes - Set of already seen hashes
 * @param {number} baseStartLine - 1-based start line of first line in array
 * @returns {CodeBlock[]} Array of code blocks
 */
function chunkTextByLines(
  lines,
  filePath,
  fileHash,
  chunkType,
  seenSegmentHashes,
  baseStartLine = 1,
) {
  const chunks = [];
  let currentChunkLines = [];
  let currentChunkLength = 0;
  let chunkStartLineIndex = 0;
  const effectiveMaxChars = MAX_BLOCK_CHARS * MAX_CHARS_TOLERANCE_FACTOR;

  const finalizeChunk = (endLineIndex) => {
    if (currentChunkLength >= MIN_BLOCK_CHARS && currentChunkLines.length > 0) {
      const chunkContent = currentChunkLines.join(String.fromCharCode(10));
      const startLine = baseStartLine + chunkStartLineIndex;
      const endLine = baseStartLine + endLineIndex;
      const contentPreview = chunkContent.slice(0, 100);
      const segmentHash = createHash("sha256")
        .update(
          `${filePath}-${startLine}-${endLine}-${chunkContent.length}-${contentPreview}`,
        )
        .digest("hex");

      if (!seenSegmentHashes.has(segmentHash)) {
        seenSegmentHashes.add(segmentHash);
        chunks.push({
          file_path: filePath,
          identifier: null,
          type: chunkType,
          start_line: startLine,
          end_line: endLine,
          content: chunkContent,
          segmentHash,
          fileHash,
        });
      }
    }
    currentChunkLines = [];
    currentChunkLength = 0;
    chunkStartLineIndex = endLineIndex + 1;
  };

  const createSegmentBlock = (segment, originalLineNumber, startCharIndex) => {
    const segmentPreview = segment.slice(0, 100);
    const segmentHash = createHash("sha256")
      .update(
        `${filePath}-${originalLineNumber}-${originalLineNumber}-${startCharIndex}-${segment.length}-${segmentPreview}`,
      )
      .digest("hex");

    if (!seenSegmentHashes.has(segmentHash)) {
      seenSegmentHashes.add(segmentHash);
      chunks.push({
        file_path: filePath,
        identifier: null,
        type: `${chunkType}_segment`,
        start_line: originalLineNumber,
        end_line: originalLineNumber,
        content: segment,
        segmentHash,
        fileHash,
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLength = line.length + (i < lines.length - 1 ? 1 : 0);
    const originalLineNumber = baseStartLine + i;

    // Handle oversized lines
    if (lineLength > effectiveMaxChars) {
      if (currentChunkLines.length > 0) {
        finalizeChunk(i - 1);
      }

      let remainingLineContent = line;
      let currentSegmentStartChar = 0;
      while (remainingLineContent.length > 0) {
        const segment = remainingLineContent.substring(0, MAX_BLOCK_CHARS);
        remainingLineContent = remainingLineContent.substring(MAX_BLOCK_CHARS);
        createSegmentBlock(
          segment,
          originalLineNumber,
          currentSegmentStartChar,
        );
        currentSegmentStartChar += MAX_BLOCK_CHARS;
      }
      chunkStartLineIndex = i + 1;
      continue;
    }

    // Handle normally sized lines
    if (
      currentChunkLength > 0 &&
      currentChunkLength + lineLength > effectiveMaxChars
    ) {
      let splitIndex = i - 1;
      let remainderLength = 0;
      for (let j = i; j < lines.length; j++) {
        remainderLength += lines[j].length + (j < lines.length - 1 ? 1 : 0);
      }

      if (
        currentChunkLength >= MIN_BLOCK_CHARS &&
        remainderLength < MIN_CHUNK_REMAINDER_CHARS &&
        currentChunkLines.length > 1
      ) {
        for (let k = i - 2; k >= chunkStartLineIndex; k--) {
          const potentialChunkLines = lines.slice(chunkStartLineIndex, k + 1);
          const potentialChunkLength =
            potentialChunkLines.join(String.fromCharCode(10)).length + 1;
          const potentialNextChunkLines = lines.slice(k + 1);
          const potentialNextChunkLength =
            potentialNextChunkLines.join(String.fromCharCode(10)).length + 1;

          if (
            potentialChunkLength >= MIN_BLOCK_CHARS &&
            potentialNextChunkLength >= MIN_CHUNK_REMAINDER_CHARS
          ) {
            splitIndex = k;
            break;
          }
        }
      }

      finalizeChunk(splitIndex);

      if (i >= chunkStartLineIndex) {
        currentChunkLines.push(line);
        currentChunkLength += lineLength;
      } else {
        i = chunkStartLineIndex - 1;
        continue;
      }
    } else {
      currentChunkLines.push(line);
      currentChunkLength += lineLength;
    }
  }

  // Process the last remaining chunk
  if (currentChunkLines.length > 0) {
    finalizeChunk(lines.length - 1);
  }

  return chunks;
}

/**
 * Perform fallback chunking on file content
 * @param {string} filePath - Path to the file
 * @param {string} content - File content
 * @param {string} fileHash - Hash of the file
 * @param {Set<string>} [seenSegmentHashes] - Set of already seen hashes
 * @returns {CodeBlock[]} Array of code blocks
 */
export function performFallbackChunking(
  filePath,
  content,
  fileHash,
  seenSegmentHashes = new Set(),
) {
  const lines = content.split(String.fromCharCode(10));
  return chunkTextByLines(
    lines,
    filePath,
    fileHash,
    "fallback_chunk",
    seenSegmentHashes,
  );
}

/**
 * Parse a file and return code blocks
 * @param {string} filePath - Path to the file
 * @param {Object} options - Options
 * @param {string} [options.content] - File content (if already read)
 * @param {string} [options.fileHash] - File hash (if already computed)
 * @returns {Promise<CodeBlock[]>} Array of code blocks
 */
export async function parseFile(filePath, options = {}) {
  const { readFile } = await import("fs/promises");
  const { extname } = await import("path");

  // Check if extension is supported
  const ext = extname(filePath).toLowerCase();
  const supportedExtensions = [
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
    ".fs",
    ".fsx",
  ];

  if (!supportedExtensions.includes(ext)) {
    return [];
  }

  // Get content
  let content;
  let fileHash;

  if (options.content) {
    content = options.content;
    fileHash = options.fileHash || createFileHash(content);
  } else {
    try {
      content = await readFile(filePath, "utf8");
      fileHash = createFileHash(content);
    } catch (error) {
      console.error(`Error reading file ${filePath}:`, error);
      return [];
    }
  }

  // Skip if content is too small
  if (content.length < MIN_BLOCK_CHARS) {
    return [];
  }

  // Use fallback chunking for all files (simplified approach)
  return performFallbackChunking(filePath, content, fileHash);
}
