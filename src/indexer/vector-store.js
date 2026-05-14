/**
 * HTTP Vector Store client
 * Communicates with the MatterAI backend API for embeddings storage
 * The backend handles search and context injection — this client only manages indexing.
 */

/**
 * @typedef {Object} PointStruct
 * @property {string} id - Unique point ID
 * @property {number[]} vector - Embedding vector
 * @property {Object} payload - Metadata payload
 * @property {string} payload.filePath - Relative file path
 * @property {string} payload.codeChunk - Code content
 * @property {number} payload.startLine - Start line
 * @property {number} payload.endLine - End line
 */

export class HttpVectorStore {
  /**
   * Creates a new HTTP vector store
   * @param {string} workspacePath - Path to the workspace
   * @param {string} baseUrl - Base URL for the backend API
   * @param {number} vectorSize - Size of the vectors
   * @param {string} apiKey - API key for authentication
   */
  constructor(workspacePath, baseUrl, vectorSize, apiKey) {
    this.workspacePath = workspacePath;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.vectorSize = vectorSize;
    this.apiKey = apiKey;
  }

  /**
   * Get auth headers for API requests
   * @returns {Object} Headers object
   */
  _headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Initializes the vector store collection
   * @returns {Promise<boolean>} Whether a new collection was created
   */
  async initialize() {
    const response = await fetch(`${this.baseUrl}/orb-embedding/initialize`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        workspacePath: this.workspacePath,
        vectorSize: this.vectorSize,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    return result.created || false;
  }

  /**
   * Upserts points into the vector store
   * @param {PointStruct[]} points - Array of points to upsert
   */
  async upsertPoints(points) {
    const response = await fetch(`${this.baseUrl}/orb-embedding/upsert-points`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        workspacePath: this.workspacePath,
        points: points,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    await response.json();
  }

  /**
   * Deletes points by file path
   * @param {string} filePath - Path of the file to delete points for
   */
  async deletePointsByFilePath(filePath) {
    const response = await fetch(`${this.baseUrl}/orb-embedding/delete-points`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        workspacePath: this.workspacePath,
        filePath: filePath,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    await response.json();
  }

  /**
   * Deletes points by multiple file paths
   * @param {string[]} filePaths - Array of file paths to delete points for
   */
  async deletePointsByMultipleFilePaths(filePaths) {
    if (filePaths.length === 0) {
      return;
    }

    const response = await fetch(
      `${this.baseUrl}/orb-embedding/delete-points-batch`,
      {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify({
          workspacePath: this.workspacePath,
          filePaths: filePaths,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    await response.json();
  }

  /**
   * Clears all points from the collection
   */
  async clearCollection() {
    const response = await fetch(
      `${this.baseUrl}/orb-embedding/clear-collection`,
      {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify({
          workspacePath: this.workspacePath,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    await response.json();
  }

  /**
   * Deletes the entire collection
   */
  async deleteCollection() {
    const response = await fetch(
      `${this.baseUrl}/orb-embedding/delete-collection`,
      {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify({
          workspacePath: this.workspacePath,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    await response.json();
  }

  /**
   * Checks if the collection exists
   * @returns {Promise<boolean>}
   */
  async collectionExists() {
    const response = await fetch(
      `${this.baseUrl}/orb-embedding/collection-exists?workspacePath=${encodeURIComponent(this.workspacePath)}`,
      {
        method: "GET",
        headers: this._headers(),
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    return result.exists || false;
  }
}
