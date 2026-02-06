/*
 * Methods:
 *    loadConfig() — Load a sanitized config file from the project root directory.
 *    load() — Load a file via absolute or relative path.
 *    sanitizeConfigPath() — Ensure config file paths are safe.
 *    resolveInBaseDir() — Resolve paths within the project root directory safely.
 *    atomicReadFile() — Perform atomic file reads.
 *    parseJsonStrict() — Parse JSON with strict validation.
 *    deepFreeze() — Deep freeze an object graph recursively.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const Joi = require("joi");
const { LRUCache } = require("lru-cache");
const SafeUtils = require("./SafeUtils");
const ErrorHandler = require("./ErrorHandler");

// Declare optional Logger holder and only require it when initialized to avoid circular dependency
let Logger;
// Attempt to require Logger when available
try {
  // Load Logger dynamically to avoid circular dependency problems
  Logger = require("./Logger");
}
// Capture failures that occur during Logger initialization
catch (err) {
  // Logger is unavailable while it initializes
  Logger = null;
}

/**
 * Class ConfigSchemaLoader
 *
 * Generic secure JSON configuration loader that enforces filename sanitization,
 * caches by file metadata, and deep-freezes configuration outputs.
 */
class ConfigSchemaLoader {
  // Private in-memory cache keyed by sanitized relative paths using LRUCache eviction (max 1000 entries)
  static #cache = new LRUCache({
    max: 1000,
    updateAgeOnGet: false, // Don't update age on get, only on set
    updateAgeOnHas: false, // Don't update age on has, only on set
  });
  // Base directory (project root) that backs config lookups.
  static #baseDirectoryPath = path.resolve(process.cwd());
  // Lock queue for concurrent file operations per path; currently for reads only, placeholder for future writes
  static #fileLocks = new Map();

 
  /**
   * Release per-file lock.
   *
   * Remove the pending lock for the supplied file path after a micro delay to let the next consumer run.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ConfigFileLoader#releaseFileLock #TODO
   * @param {string} filePath - Path to unlock.
   * @returns {void} Clears the stored lock promise for the provided path.
   */
  static #releaseFileLock(filePath) {
    // Schedule lock removal asynchronously to avoid reentrancy issues
    setTimeout(() => {
      // Delete the recorded promise from the lock map
      this.#fileLocks.delete(filePath);
    }, 0);
  }

  /**
   * Load sanitized config file entry.
   *
   * Validate the requested relative path, read the file atomically, cache the frozen result, and return it.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ConfigFileLoader#loadConfig #TODO
   * @param {string} requestedConfigPath - Path (relative to repo root) of the config file.
   * @returns {object} Frozen config object resolved from disk.
   */
  static loadConfig(requestedConfigPath) {
    // Sanitize the provided path string before validation
    const sanitizedRequestedPath = SafeUtils.sanitizeString(requestedConfigPath);
    // Validate the sanitized string is not empty
    if (!sanitizedRequestedPath || sanitizedRequestedPath.length === 0 || sanitizedRequestedPath.trim().length === 0) {
      // Compose the error message for empty paths
      const errorMessage = "Config file path cannot be empty";
      // Log the invalid path error via ErrorHandler
      ErrorHandler.addError(errorMessage, {
        // Use the invalid file name error code
        code: "INVALID_FILE_NAME",
        // Attach the sanitized path or null if unavailable
        file: sanitizedRequestedPath || null,
        // Identify the error origin
        origin: "ConfigSchemaLoader",
      });
      // Halt execution by throwing the error
      throw new Error(errorMessage);
    }
    // Validate the original requested path with the shared schema
    const { error: pathError } = this.#getFilePathSchema().validate(requestedConfigPath);
    // Handle schema validation failures
    if (pathError) {
      // Prepare variable for the formatted message
      let errorMessage;
      // Capture the Joi-provided message text
      const joiMessage = pathError.details[0].message;
      // Manage invalid extension failures
      if (pathError.details[0].type === "string.invalidExtension") {
        // Message for invalid extensions
        errorMessage = `Config file must be .json: ${requestedConfigPath}`;
      }
      // Manage embedded null byte failures
      else if (pathError.details[0].type === "string.noNullBytes") {
        // Message for null byte paths
        errorMessage = "Config file path cannot contain null bytes.";
      }
      // Manage all other validation failures
      else {
        // Message that aligns with test expectations
        errorMessage = joiMessage.includes("requires a file path string")
          ? "loadConfig(filePath) requires a file path string."
          : `loadConfig(filePath) ${joiMessage}`;
      }
      // Log the validation failure with context
      ErrorHandler.addError(errorMessage, {
        // Choose the appropriate error code
        code:
          pathError.details[0].type === "string.invalidExtension"
            ? "INVALID_FILE_EXT"
            : pathError.details[0].type === "string.noNullBytes"
            ? "INVALID_FILE_NAME"
            : "INVALID_FILE_PATH",
        // Attach the original requested path
        file: requestedConfigPath || null,
        // Mark the error as coming from this loader
        origin: "ConfigSchemaLoader",
      });
      // Conditionally log the failure through Logger
      if (Logger && typeof Logger.writeLog === "function") {
        // Guard the logger invocation
        try {
          // Emit structured log entry describing invalid paths
          Logger.writeLog("error", "config", "invalid_path", "Invalid config file path", {
            // Attach the request path for diagnostics
            requestedPath: requestedConfigPath,
          });
        }
        // Suppress logging failures
        catch (logErr) {
          // Ignore Logger errors
        }
      }
      // Throw to surface the validation failure
      throw new Error(errorMessage);
    }
    // Normalize the sanitized relative path
    const sanitizedRelativePath = this.#sanitizeConfigPath(sanitizedRequestedPath);
    // Resolve the file path within the project root
    const resolvedConfigFilePath = this.#resolveInBaseDir(sanitizedRelativePath);
    // Check that the resolved path exists
    if (!fs.existsSync(resolvedConfigFilePath)) {
      // Detect directories requested via .json names
      if (sanitizedRelativePath.endsWith(".json")) {
        // Strip the .json extension for directory checks
        const pathWithoutExt = sanitizedRelativePath.slice(0, -5);
        // Resolve the stripped path within the project root
        const resolvedPathWithoutExt = this.#resolveInBaseDir(pathWithoutExt);
        // Check whether the stripped path exists
        if (fs.existsSync(resolvedPathWithoutExt)) {
          // Gather stats for the stripped path
          const stats = fs.statSync(resolvedPathWithoutExt);
          // Determine if the stripped path points to a directory
          if (stats.isDirectory()) {
            // Log that the resolved path is not a file
            ErrorHandler.addError(`${resolvedConfigFilePath} is not a file`, {
              // Use the not-a-file error code
              code: "NOT_A_FILE",
              // Attach the problematic path
              file: resolvedConfigFilePath,
              // Identify the loader as the origin
              origin: "ConfigSchemaLoader",
            });
            // Throw because directories cannot be returned as config
            throw new Error(`${resolvedConfigFilePath} is not a file`);
          }
        }
      }
      // Log missing file occurrences
      ErrorHandler.addError(`Config file not found: ${resolvedConfigFilePath}`, {
        // Use the file not found error code
        code: "FILE_NOT_FOUND",
        // Attach the missing path
        file: resolvedConfigFilePath,
        // Tag the error origin
        origin: "ConfigSchemaLoader",
      });
      // Conditionally log the missing file scenario
      if (Logger && typeof Logger.writeLog === "function") {
        // Guard logging to prevent crashes
        try {
          // Emit log entry for missing config files
          Logger.writeLog("error", "config", "file_not_found", "Config file not found", {
            // Provide the resolved path for diagnostics
            filePath: resolvedConfigFilePath,
          });
        }
        // Suppress logging failures
        catch (logErr) {
          // Ignore Logger errors
        }
      }
      // Throw to propagate the file absence
      throw new Error(`Config file not found: ${resolvedConfigFilePath}`);
    }
    // Capture stats before caching
    const initialConfigStats = fs.statSync(resolvedConfigFilePath);
    // Reject if the resolved path is a directory
    if (initialConfigStats.isDirectory()) {
      // Log wrong type (directory)
      ErrorHandler.addError(`${resolvedConfigFilePath} is not a file`, {
        // Use the not-a-file code
        code: "NOT_A_FILE",
        // Attach the offending path
        file: resolvedConfigFilePath,
        // Mark the origin for auditing
        origin: "ConfigSchemaLoader",
      });
      // Throw because directories cannot be configs
      throw new Error(`${resolvedConfigFilePath} is not a file`);
    }
    // Reject if the path is not recognized as a file
    if (!initialConfigStats.isFile()) {
      // Log invalid file type
      ErrorHandler.addError(`${resolvedConfigFilePath} is not a file`, {
        // Use the not-a-file code
        code: "NOT_A_FILE",
        // Attach the problematic path
        file: resolvedConfigFilePath,
        // Mark the origin for tracking
        origin: "ConfigSchemaLoader",
      });
      // Throw because the path cannot be used
      throw new Error(`${resolvedConfigFilePath} is not a file`);
    }
    // Use the relative path as the cache key
    const cacheKey = sanitizedRelativePath;
    // Retrieve cache entry if it exists
    const cachedConfigEntry = this.#cache.get(cacheKey);
    // Determine cache validity based on stats
    if (
      cachedConfigEntry &&
      cachedConfigEntry.mtimeMs === initialConfigStats.mtimeMs &&
      cachedConfigEntry.size === initialConfigStats.size
    ) {
      // Conditionally log cache hits
      if (Logger && typeof Logger.writeLog === "function") {
        // Guard the logger call
        try {
          // Log that the cache provided the configuration
          Logger.writeLog("debug", "config", "cache_hit", "Config file cache hit", {
            // Provide the file path to the log
            filePath: resolvedConfigFilePath,
          });
        }
        // Suppress logger failures
        catch (logErr) {
          // Ignore Logger errors
        }
      }
      // Return the cached configuration object
      return cachedConfigEntry.config;
    }
    // Safely read the config file contents
    const serializedConfig = this.#atomicReadFile(resolvedConfigFilePath);
    // Parse and validate the JSON content
    const parsedConfigObject = this.#parseJsonStrict(
      // Provide serialized configuration text
      serializedConfig,
      // Provide file path context for errors
      resolvedConfigFilePath,
    );
    // Freeze the parsed configuration graph
    const frozenConfig = this.#deepFreeze(parsedConfigObject);
    // Update stats after reading
    const latestConfigFileStats = fs.statSync(resolvedConfigFilePath);
    // Store the entry in the cache with metadata
    this.#cache.set(cacheKey, {
      // Record modification timestamp
      mtimeMs: latestConfigFileStats.mtimeMs,
      // Record file size
      size: latestConfigFileStats.size,
      // Record the frozen config
      config: frozenConfig,
    });
    // Conditionally log successful loads
    if (Logger && typeof Logger.writeLog === "function") {
      // Guard the logger invocation
      try {
        // Log the successful configuration load
        Logger.writeLog("info", "config", "load", "Config file loaded successfully", {
          // Provide file path metadata
          filePath: resolvedConfigFilePath,
        });
      }
      // Suppress logging failures
      catch (logErr) {
        // Ignore Logger errors
      }
    }
    // Return the deep-frozen configuration
    return frozenConfig;
  }

  /**
   * Load file through absolute or relative path.
   *
   * Validate and sanitize any path, ensure the target exists and is a file, parse its JSON, and return a deep-frozen object.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ConfigFileLoader#load #TODO
   * @param {string} requestedArbitraryFilePath - Absolute or relative path to load.
   * @returns {object} Parsed and frozen configuration object.
   */
  static load(requestedArbitraryFilePath) {
    // Build Joi schema to validate that a non-empty path is provided
    const { error: pathError } = Joi.string()
      // Require the path to be present
      .required()
      // Enforce at least one character
      .min(1)
      // Provide custom messages for failure modes
      .messages({
        // Message when path is not a string
        "string.base": "requires a file path string",
        // Message when path is missing
        "any.required": "requires a file path string",
        // Message when path is empty
        "string.empty": "requires a non-empty path string",
        // Message when path is too short
        "string.min": "requires a non-empty path string",
      })
      // Validate the provided arbitrary path
      .validate(requestedArbitraryFilePath);
    // Handle invalid path errors
    if (pathError) {
      // Compose error message for logging
      const errorMessage = `load(filePath) ${pathError.details[0].message}`;
      // Log the invalid path with ErrorHandler
      ErrorHandler.addError(errorMessage, {
        // Attach invalid file path code
        code: "INVALID_FILE_PATH",
        // Include the original request for diagnostics
        file: requestedArbitraryFilePath || null,
        // Identify the originating loader
        origin: "ConfigSchemaLoader",
      });
      // Throw to indicate failure
      throw new Error(errorMessage);
    }
    // Sanitize the requested path before resolution
    const sanitizedFilePathRequest = SafeUtils.sanitizeString(
      requestedArbitraryFilePath,
    );
    // Ensure sanitized path remains non-empty
    if (!sanitizedFilePathRequest.length) {
      // Log error for empty sanitized path
      ErrorHandler.addError("load(filePath) requires a non-empty path string.", {
        // Use invalid file path code
        code: "INVALID_FILE_PATH",
        // Attach the original request
        file: requestedArbitraryFilePath,
        // Mark origin
        origin: "ConfigSchemaLoader",
      });
      // Throw to signal invalid input
      throw new Error("load(filePath) requires a non-empty path string.");
    }
    // Resolve the sanitized path relative to the current working directory
    const resolvedArbitraryFilePath = path.resolve(
      process.cwd(),
      sanitizedFilePathRequest,
    );
    // Confirm the resolved path exists
    if (!fs.existsSync(resolvedArbitraryFilePath)) {
      // Log missing file error
      ErrorHandler.addError(`Config file not found: ${resolvedArbitraryFilePath}`, {
        // Use file not found code
        code: "FILE_NOT_FOUND",
        // Provide path for diagnostics
        file: resolvedArbitraryFilePath,
        // Mark origin
        origin: "ConfigSchemaLoader",
      });
      // Throw to indicate missing file
      throw new Error(`Config file not found: ${resolvedArbitraryFilePath}`);
    }
    // Retrieve file statistics after confirming existence
    const resolvedFileStats = fs.statSync(resolvedArbitraryFilePath);
    // Ensure the path resolves to a file
    if (!resolvedFileStats.isFile()) {
      // Log not-a-file error
      ErrorHandler.addError(
        `Config path is not a file: ${resolvedArbitraryFilePath}`,
        {
          // Use not-a-file error code
          code: "NOT_A_FILE",
          // Include the path that failed
          file: resolvedArbitraryFilePath,
          // Mark origin
          origin: "ConfigSchemaLoader",
        },
      );
      // Throw to indicate invalid path target
      throw new Error(`Config path is not a file: ${resolvedArbitraryFilePath}`);
    }
    // Read the file contents as UTF-8 text
    const arbitraryFileContent = fs.readFileSync(resolvedArbitraryFilePath, "utf8");
    // Parse the JSON string strictly with helper
    const parsedConfigObject = this.#parseJsonStrict(
      // Provide file contents to parser
      arbitraryFileContent,
      // Provide file path for context
      resolvedArbitraryFilePath,
    );
    // Return the deep-frozen parsed object
    return this.#deepFreeze(parsedConfigObject);
  }

   /**
   * Build sanitized file path schema.
   *
   * Return Joi schema that ensures config file paths are non-empty and end with a .json extension without null bytes.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ConfigFileLoader#getFilePathSchema #TODO
   * @returns {Joi.StringSchema} File path validation schema
   */
  static #getFilePathSchema() {
    // Start building the Joi string schema
    return Joi.string()
      // Require the path value to be present
      .required()
      // Enforce a minimum length of one character
      .min(1)
      // Apply custom rules for null bytes and extension
      .custom((value, helpers) => {
        // Reject values that contain null bytes
        if (value.includes("\0")) {
          // Signal a null byte validation failure
          return helpers.error("string.noNullBytes");
        }
        // Normalize the value for extension checks
        const normalized = value.toLowerCase();
        // Reject values that do not end with .json
        if (!normalized.endsWith(".json")) {
          // Signal an invalid extension failure
          return helpers.error("string.invalidExtension");
        }
        // Return the validated value when checks pass
        return value;
      })
      // Attach user-friendly error messages
      .messages({
        // Error when value is not a string
        "string.base": "requires a file path string",
        // Error when value is omitted
        "any.required": "requires a file path string",
        // Error when value is empty
        "string.empty": "cannot be empty",
        // Error when value is too short
        "string.min": "cannot be empty",
        // Error when value contains null bytes
        "string.noNullBytes": "cannot contain null bytes",
        // Error when extension is not .json
        "string.invalidExtension": "must be .json",
      });
  }

  /**
   * Build JSON content schema.
   *
   * Provide a Joi schema that ensures strings look like JSON objects or arrays before parsing.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ConfigFileLoader#getJsonContentSchema #TODO
   * @returns {Joi.StringSchema} JSON content validation schema
   */
  static #getJsonContentSchema() {
    // Start building Joi string schema for JSON payloads
    return Joi.string()
      // Require the string input to be present
      .required()
      // Add custom validator that checks for JSON-like structure
      .custom((value, helpers) => {
        // Trim whitespace before checking the starting character
        const trimmed = value.trim();
        // Verify the trimmed string begins with object or array delimiters
        if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
          // Signal that value does not resemble JSON
          return helpers.error("string.notJsonLike");
        }
        // Accept the value when it passes the JSON-like check
        return value;
      })
      // Attach custom error messages for JSON validation
      .messages({
        // Message for non-string inputs
        "string.base": "expected string",
        // Message when the value is missing
        "any.required": "expected string",
        // Message when content does not look like JSON
        "string.notJsonLike": "does not look like JSON",
      });
  }
  
  /**
   * Acquire per-file lock for future writes.
   *
   * Queue lock holders per path so that write operations would serialize once implemented.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ConfigFileLoader#acquireFileLock #TODO
   * @param {string} filePath - Path to lock.
   * @returns {Promise<void>} Promise that resolves when lock is acquired.
   */
  static async #acquireFileLock(filePath) {
    // Check whether a lock already exists for this path
    if (!this.#fileLocks.has(filePath)) {
      // Create resolved promise slot for the new path lock
      this.#fileLocks.set(filePath, Promise.resolve());
      // Return immediately when no waiting lock exists
      return;
    }
    // Capture the existing lock promise for chaining
    const previousLock = this.#fileLocks.get(filePath);
    // Build a new promise that waits for the previous lock
    const newLock = previousLock.then(() => Promise.resolve());
    // Store the new promise in the lock map for future callers
    this.#fileLocks.set(filePath, newLock);
    // Return the new lock promise to the caller
    return newLock;
  }

  
  /**
   * Ensure config file paths are safe.
   *
   * Normalize and enforce relative JSON path requirements, throwing when invalid.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ConfigFileLoader#sanitizeConfigPath #TODO
   * @param {string} candidatePath - Already sanitized path string.
   * @returns {string} Sanitized relative path (no leading separators).
   */
  static #sanitizeConfigPath(candidatePath) {
    // Trim whitespace and guard against nullish inputs
    const trimmedCandidate = candidatePath?.trim() ?? "";
    // Ensure the trimmed string is not empty
    if (!trimmedCandidate) {
      // Define error message for empty candidate paths
      const errorMessage = "Config file path cannot be empty";
      // Log the path validation failure
      ErrorHandler.addError(errorMessage, {
        // Use the invalid file name error code
        code: "INVALID_FILE_NAME",
        // Provide the original candidate for diagnostics
        file: candidatePath || null,
        // Identify the origin
        origin: "ConfigSchemaLoader",
      });
      // Throw to signal the invalid input
      throw new Error(errorMessage);
    }
    // Validate candidate path using the shared schema
    const { error: pathError } = this.#getFilePathSchema().validate(candidatePath);
    // Handle Joi validation failure
    if (pathError) {
      // Prepare formatted error message for logging
      let errorMessage;
      // Handle invalid extension case explicitly
      if (pathError.details[0].type === "string.invalidExtension") {
        // Compose invalid extension message
        errorMessage = `Config file must be .json: ${candidatePath}`;
      }
      // Handle null byte occurrences explicitly
      else if (pathError.details[0].type === "string.noNullBytes") {
        // Compose null byte message
        errorMessage = "Config file path cannot contain null bytes.";
      }
      // Handle other Joi error modes generically
      else {
        // Compose general failure message
        errorMessage = `loadConfig(filePath) ${pathError.details[0].message}`;
      }
      // Log the sanitized path failure
      ErrorHandler.addError(errorMessage, {
        // Use the appropriate error code for invalid extensions vs names
        code:
          pathError.details[0].type === "string.invalidExtension"
            ? "INVALID_FILE_EXT"
            : "INVALID_FILE_NAME",
        // Attach the path in question
        file: candidatePath || null,
        // Mark the loader origin for consistency
        origin: "ConfigSchemaLoader",
      });
      // Throw the validation error
      throw new Error(errorMessage);
    }
    // Strip leading slashes to keep the path relative
    const relativeCandidatePath = candidatePath.replace(/^[\\/]+/, "");
    // Reject absolute paths
    if (path.isAbsolute(relativeCandidatePath)) {
      // Log path traversal attempt
      ErrorHandler.addError(
        "loadConfig(filePath) expects a path relative to the project root.",
        {
          // Attach path traversal error code
          code: "INVALID_FILE_PATH",
          // Provide the offending candidate
          file: candidatePath,
          // Mark the origin
          origin: "ConfigSchemaLoader",
        },
      );
      // Throw to block the traversal attempt
      throw new Error(
        "loadConfig(filePath) expects a path relative to the project root.",
      );
    }
    // Normalize Windows-style separators and redundant segments
    const normalizedPath = path.normalize(relativeCandidatePath);
    // Ensure normalized path is not empty after normalization
    if (normalizedPath.length === 0) {
      // Log empty path error
      ErrorHandler.addError("Config file path cannot be empty.", {
        // Use invalid file name code
        code: "INVALID_FILE_NAME",
        // Provide the path that failed
        file: candidatePath,
        // Mark the origin
        origin: "ConfigSchemaLoader",
      });
      // Throw to prevent use of empty path
      throw new Error("Config file path cannot be empty.");
    }
    // Return the relative, normalized path
    return normalizedPath;
  }

  /**
   * Resolve sanitized path inside root.
   *
   * Convert the sanitized relative path into an absolute path and enforce that it stays below the configured base directory.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ConfigFileLoader#resolveInBaseDir #TODO
   * @param {string} sanitizedRelativePath - Validated relative path to resolve.
   * @returns {string} Absolute path to the file within the project root directory.
   */
  static #resolveInBaseDir(sanitizedRelativePath) {
    // Build the absolute path from the base directory and relative segment
    const absoluteConfigPath = path.resolve(
      this.#baseDirectoryPath,
      sanitizedRelativePath,
    );
    // Ensure the base directory path ends with a separator for prefix checks
    const baseDirectoryWithSep = this.#baseDirectoryPath.endsWith(path.sep)
      ? this.#baseDirectoryPath
      : `${this.#baseDirectoryPath}${path.sep}`;
    // Block traversal attempts that escape the base directory
    if (!absoluteConfigPath.startsWith(baseDirectoryWithSep)) {
      // Log the traversal block event
      ErrorHandler.addError("Blocked path traversal attempt.", {
        // Use the path traversal error code
        code: "PATH_TRAVERSAL_BLOCKED",
        // Attach the offending path
        file: absoluteConfigPath,
        // Mark the error origin
        origin: "ConfigSchemaLoader",
      });
      // Throw to stop execution when traversal occurs
      throw new Error("Blocked path traversal attempt.");
    }
    // Return the validated absolute path
    return absoluteConfigPath;
  }

  /**
   * Perform atomic file reads.
   *
   * @param {string} configFilePath - Path to the config file to read.
   * @returns {string} Raw file contents.
   */
  static #atomicReadFile(configFilePath) {
    for (
      let readAttemptNumber = 1;
      readAttemptNumber <= 3;
      readAttemptNumber++
    ) {
      // Record stats before reading to detect mid-read changes
      const fileStatsBeforeRead = fs.statSync(configFilePath);
      // Read the file content as UTF-8 text
      const fileRawContent = fs.readFileSync(configFilePath, "utf8");
      // Record stats after reading for comparison
      const fileStatsAfterRead = fs.statSync(configFilePath);
      // Determine whether the file mutated during the read
      const isContentChanged =
        fileStatsBeforeRead.mtimeMs !== fileStatsAfterRead.mtimeMs ||
        fileStatsBeforeRead.size !== fileStatsAfterRead.size ||
        (typeof fileRawContent === "string" &&
          fileRawContent.length === 0 &&
          fileStatsAfterRead.size > 0);
      // Return when read appears consistent
      if (!isContentChanged) {
        // Provide the read content on success
        return fileRawContent;
      }
      // Fail when the final attempt still sees concurrent modifications
      if (readAttemptNumber === 3) {
        // Log the atomic read failure
        ErrorHandler.addError(
          "Config file changed while reading; atomic read failed after retries.",
          {
            // Use atomic read failure error code
            code: "ATOMIC_READ_FAILED",
            // Attach the file path
            file: configFilePath,
            // Identify the loader origin
            origin: "ConfigSchemaLoader",
          },
        );
        // Throw to signal repeated atomic read failure
        throw new Error(
          "Config file changed while reading; atomic read failed after retries.",
        );
      }
    }
    // Log the failure after exhausting retries
    ErrorHandler.addError("Atomic read failed.", {
      // Use atomic read failure code
      code: "ATOMIC_READ_FAILED",
      // Attach path context
      file: configFilePath,
      // Mark the origin
      origin: "ConfigSchemaLoader",
    });
    // Throw to communicate the failure
    throw new Error("Atomic read failed.");
  }

  /**
   * Parse JSON with strict validation.
   *
   * Validate the raw content matches JSON expectations before calling `JSON.parse` and report errors with context.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ConfigFileLoader#parseJsonStrict #TODO
   * @param {string} rawJsonString - Raw string content from disk.
   * @param {string} configFilePath - File path used for error context.
   * @returns {*} Parsed JSON value.
   */
  static #parseJsonStrict(rawJsonString, configFilePath) {
    // Validate JSON-like structure before parsing
    const { error: contentError } = this.#getJsonContentSchema().validate(rawJsonString);
    // Handle validation failures
    if (contentError) {
      // Determine the appropriate message based on error type
      let errorMessage;
      if (contentError.details[0].type === "string.notJsonLike") {
        // Compose message for JSON syntax that does not resemble JSON
        errorMessage = "Invalid JSON syntax: content does not look like JSON.";
      } else {
        // Compose message for general validation failure
        errorMessage = `Invalid config content (expected string).`;
      }
      // Log the validation failure
      ErrorHandler.addError(errorMessage, {
        // Use invalid JSON syntax code when applicable
        code: contentError.details[0].type === "string.notJsonLike" ? "INVALID_JSON_SYNTAX" : "INVALID_CONTENT",
        // Provide file path context
        file: configFilePath,
        // Mark the loader origin
        origin: "ConfigSchemaLoader",
      });
      // Throw to stop processing
      throw new Error(errorMessage);
    }
    // Trim whitespace before parsing
    const trimmedJsonContent = rawJsonString.trim();
    try {
      // Parse the JSON string
      return JSON.parse(trimmedJsonContent);
    } catch (jsonParseError) {
      // Compose message from parser errors
      const parseErrorMessage =
        jsonParseError && jsonParseError.message
          ? jsonParseError.message
          : String(jsonParseError);
      // Log the parse failure
      ErrorHandler.addError(
        `Invalid JSON syntax: ${parseErrorMessage}`,
        {
          // Use the invalid syntax code
          code: "INVALID_JSON_SYNTAX",
          // Provide file context
          file: configFilePath,
          // Mark origin
          origin: "ConfigSchemaLoader",
        },
      );
      // Throw with the composed message
      throw new Error(`Invalid JSON syntax: ${parseErrorMessage}`);
    }
  }

  /**
   * Deep freeze an object graph recursively.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ConfigFileLoader#deepFreeze #TODO
   * @param {any} objectToFreeze - The value to deep-freeze if it is an object.
   * @param {WeakSet} [visited] - Optional WeakSet to track visited objects for circular reference detection.
   * @returns {any} The original value, frozen when applicable.
   * @throws {Error} If circular reference is detected.
   */
  static #deepFreeze(objectToFreeze, visited = new WeakSet()) {
    // Return non-object values immediately
    if (objectToFreeze === null || typeof objectToFreeze !== "object") {
      // Return primitives untouched
      return objectToFreeze;
    }
    // Detect circular references
    if (visited.has(objectToFreeze)) {
      // Log circular reference before throwing
      ErrorHandler.addError("ConfigFileLoader.deepFreeze: circular reference detected", {
        // Use circular reference error code
        code: "CIRCULAR_REFERENCE",
        // Mark origin
        origin: "ConfigSchemaLoader",
      });
      // Throw to signal the invalid graph
      throw new Error("ConfigFileLoader.deepFreeze: circular reference detected in object graph");
    }
    // Mark object as visited to avoid future loops
    visited.add(objectToFreeze);
    // Freeze the current object
    Object.freeze(objectToFreeze);
    // Recurse into each own property
    for (const propertyKey of Object.keys(objectToFreeze)) {
      // Retrieve the property value
      const propertyValue = objectToFreeze[propertyKey];
      // Recurse when value is an unfrozen object
      if (
        propertyValue &&
        typeof propertyValue === "object" &&
        !Object.isFrozen(propertyValue)
      ) {
        // Recursively freeze nested objects
        this.#deepFreeze(propertyValue, visited);
      }
    }
    // Return the frozen object
    return objectToFreeze;
  }

  /**
   * Clear the config cache (for testing purposes only).
   *
   * Empties the cached entries to reset loader state during tests.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ConfigFileLoader#_clearCache #TODO
   * @returns {void} Clears the internal cache store.
   */
  static _clearCache() {
    // Remove every cached entry
    this.#cache.clear();
  }
}

// Export as ConfigFileLoader for consistency with test imports
const ConfigFileLoader = ConfigSchemaLoader;
module.exports = ConfigFileLoader;