
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { LRUCache } = require("lru-cache");
const SafeUtils = require("./SafeUtils");
const ConfigFileLoader = require("./ConfigFileLoader");
const ErrorHandler = require("./ErrorHandler");

// Conditional Logger - only use if initialized (avoid circular dependency)
let Logger;
try {
  Logger = require("./Logger");
} catch (err) {
  // Logger not available during its own initialization
  Logger = null;
}

/**
 * @typedef {Object} EnvEntry
 * @property {string} name - Environment variable name (must be uppercase)
 * @property {string} [type] - Type: "int", "bool", "boolean", "enum", or undefined (string)
 * @property {*} [default] - Default value if not set
 * @property {boolean} [required] - Whether the variable is required
 * @property {number} [min] - Minimum value for integers (must be <= max)
 * @property {number} [max] - Maximum value for integers (must be >= min)
 * @property {string[]} [allowed] - Allowed values for enum type (must be non-empty, no case-insensitive duplicates)
 */

/**
 * @typedef {Object} EnvConfiguration
 * @property {EnvEntry[]} global - Global environment entries (required)
 * @property {EnvEntry[]} [key: string] - Additional section entries
 */

/**
 * Class EnvLoader
 *
 * A defensive environment loader that reads from a configurable source (defaults to `process.env`),
 * normalizes variable names, applies defaults, enforces required values, and performs type-safe
 * coercion/validation (e.g., ints with bounds and enums with allowlists) to produce a normalized
 * runtime configuration object.
 *
 * @link #TODO
 */
class EnvLoader {
  // Define the default section name for environment configs
  static #DEFAULT_SECTION = "global";
  // Define the alias value that maps back to the default section
  static #ALIAS_DEFAULT = "default";

  // Default environment source for lookups; derived from .env + process.env.
  static source = process.env;
  // Cached configuration object for validation.
  static config = null;
  // Cache validated section results (using LRUCache for automatic eviction).
  static #validatedSections = new LRUCache({
    max: 1000,
    updateAgeOnGet: false,
    updateAgeOnHas: false,
  });
  // Cache parsed .env files by path and content hash (using LRUCache for automatic eviction).
  static #envFileCache = new LRUCache({
    max: 500,
    updateAgeOnGet: false,
    updateAgeOnHas: false,
  });

  
  /**
   * Load environment with schema enforcement.
   *
   * Perform the full workflow of reading the .env file, applying the configuration schema, and returning normalized variables.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#loadEnv #TODO
   * @param {string} envFilePath - Path to the .env file (default: ".env")
   * @param {string} configPath - Path to the env config JSON (default: "configs/envConfig.json")
   * @returns {object} normalized global environment values
   */
  static loadEnv(envFilePath = ".env", configPath = "configs/envConfig.json") {
    // Start env load workflow within a guarded try block
    try {
      // Log start of env load workflow with trace-level metadata
      ErrorHandler.addError("EnvLoader.loadEnv started", {
        code: "ENV_LOAD_START",
        level: "trace",
        envFilePath,
        configPath,
        origin: "EnvLoader",
        timestamp: new Date().toISOString(),
      });
      // Load and cache the requested .env file
      this.loadEnvFile(envFilePath);
      // Load the environment configuration definition from disk
      const envConfiguration = ConfigFileLoader.loadConfig(configPath);
      // Store the loaded configuration for validation
      this.setConfig(envConfiguration);
      // Run validation on the global section before normalization
      this.validateEnv(this.#DEFAULT_SECTION);
      // Normalize the configuration into actual env entries
      const normalizedEnv = this.#normalizeConfig(envConfiguration);
      // Log successful completion of env loading
      ErrorHandler.addError("EnvLoader.loadEnv completed", {
        code: "ENV_LOAD_SUCCESS",
        level: "info",
        envFilePath,
        configPath,
        origin: "EnvLoader",
        varsLoaded: Object.keys(normalizedEnv).length,
        timestamp: new Date().toISOString(),
      });
      // Only log success through Logger when it is initialized
      if (Logger && typeof Logger.writeLog === "function") {
        // Wrap logger invocation to avoid throwing
        try {
          // Emit success event with metadata
          Logger.writeLog("info", "env", "load", `Environment loaded successfully from ${envFilePath}`, {
            configPath,
            varsLoaded: Object.keys(normalizedEnv).length,
          });
        }
        // Suppress any logger errors to prevent cascading failures
        catch (loggerError) {
          // Ignore Logger errors
        }
      }
      // Return the normalized environment values
      return normalizedEnv;
    }
    // Handle failures that occur during the env load workflow
    catch (loadError) {
      // Log failure event with error details
      ErrorHandler.addError("EnvLoader.loadEnv failed", {
        code: "ENV_LOAD_FAILED",
        level: "error",
        envFilePath,
        configPath,
        origin: "EnvLoader",
        error: loadError.message,
        stack: loadError.stack,
        timestamp: new Date().toISOString(),
      });
      // Only emit failure detail via Logger when available
      if (Logger && typeof Logger.writeLog === "function") {
        // Wrap logger invocation to guard against errors
        try {
          // Emit failure log event with metadata
          Logger.writeLog("error", "env", "load_failed", `Environment load failed: ${loadError.message}`, {
            envFilePath,
            configPath,
            error: loadError.message,
          });
        }
        // Suppress logger issues
        catch (logErr) {
          // Ignore Logger errors
        }
      }
      // Rethrow the original load error
      throw loadError;
    }
  }

  /**
   * Load and cache a .env file.
   *
   * Resolve the target file, enforce path traversal protections, leverage caching, and return the merged environment source.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#loadEnvFile #TODO
   * @param {string} envFilePath - Path to the .env file.
   * @returns {object} merged environment source
   */
  static loadEnvFile(envFilePath = ".env") {
    // Validate that a string path was provided
    if (!envFilePath || typeof envFilePath !== "string") {
      // Throw when the argument is missing or invalid
      throw new Error("EnvLoader.loadEnvFile requires a file path string");
    }
    // Resolve to an absolute path so we can perform safe checks
    const resolvedEnvPath = path.isAbsolute(envFilePath)
      ? envFilePath
      : path.resolve(process.cwd(), envFilePath);
    // Prepare project root path for traversal guard
    const projectRoot = path.resolve(process.cwd());
    const projectRootWithSep = projectRoot.endsWith(path.sep)
      ? projectRoot
      : `${projectRoot}${path.sep}`;
    // Block attempts to escape the project root
    if (!resolvedEnvPath.startsWith(projectRootWithSep)) {
      // Log the blocked traversal attempt
      ErrorHandler.addError("EnvLoader: path traversal attempt blocked", {
        code: "PATH_TRAVERSAL_BLOCKED",
        level: "warning",
        requestedPath: envFilePath,
        resolvedPath: resolvedEnvPath,
        projectRoot,
        origin: "EnvLoader",
        timestamp: new Date().toISOString(),
      });
      // Only emit a security log if Logger is available
      if (Logger && typeof Logger.writeLog === "function") {
        // Wrap logger call to avoid throwing
        try {
          // Emit traversal warning with metadata
          Logger.writeLog("warning", "security", "path_traversal", "Path traversal attempt blocked", {
            requestedPath: envFilePath,
            resolvedPath: resolvedEnvPath,
            critical: true,
          });
        }
        // Ignore logger errors entirely
        catch (logErr) {
          // Ignore Logger errors
        }
      }
      // Reject the invalid path
      throw new Error("EnvLoader: path traversal attempt blocked");
    }
    // Handle missing env files by clearing cache entry
    if (!fs.existsSync(resolvedEnvPath)) {
      // Remove stale cache entry when file disappears
      this.#envFileCache.delete(resolvedEnvPath);
      // Throw to signal missing file
      throw new Error("EnvLoader: env file not found");
    }
    // Gather file statistics for further validation
    const envFileStats = fs.statSync(resolvedEnvPath);
    // Ensure the resolved path points to a regular file
    if (!envFileStats.isFile()) {
      // Remove stale cache entry when the path becomes invalid
      this.#envFileCache.delete(resolvedEnvPath);
      // Throw to signal incorrect file type
      throw new Error("EnvLoader: env file path is not a file");
    }
    // Read the file contents before hashing to avoid race conditions
    const envFileContent = fs.readFileSync(resolvedEnvPath, "utf8");
    // Compute deterministic hash for caching purposes
    const envFileHash = crypto.createHash("sha256").update(envFileContent).digest("hex");
    // Check the cache for the current file path
    const cached = this.#envFileCache.get(resolvedEnvPath);
    // When the cache matches input, reuse the existing source
    if (cached && cached.contentHash === envFileHash) {
      // Log cache hit event
      ErrorHandler.addError("EnvLoader: cache hit", {
        code: "ENV_CACHE_HIT",
        level: "trace",
        path: resolvedEnvPath,
        hash: envFileHash,
        origin: "EnvLoader",
        timestamp: new Date().toISOString(),
      });
      // Refresh source and normalized sections after hitting cache
      this.source = process.env;
      this.#validatedSections.clear();
      // Return the reused environment source
      return this.source;
    }
    // Log cache miss and new file processing
    ErrorHandler.addError("EnvLoader: cache miss, loading file", {
      code: "ENV_CACHE_MISS",
      level: "trace",
      path: resolvedEnvPath,
      hash: envFileHash,
      fileSize: envFileContent.length,
      origin: "EnvLoader",
      timestamp: new Date().toISOString(),
    });
    // Clear cache entry when hash differs to force reload
    if (cached && cached.contentHash !== envFileHash) {
      // Remove outdated cache information
      this.#envFileCache.delete(resolvedEnvPath);
    }
    // Load the file into process.env via dotenv
    const dotenvResult = dotenv.config({ path: resolvedEnvPath, override: true });
    // Handle dotenv failures by throwing the encountered error
    if (dotenvResult && dotenvResult.error) {
      // Log dotenv failure event
      ErrorHandler.addError("EnvLoader: dotenv.config failed", {
        code: "ENV_DOTENV_FAILED",
        level: "error",
        path: resolvedEnvPath,
        error: dotenvResult.error.message,
        origin: "EnvLoader",
        timestamp: new Date().toISOString(),
      });
      // Rethrow the dotenv error for upper layers to handle
      throw dotenvResult.error;
    }
    // Cache the new hash for future loads
    this.#envFileCache.set(resolvedEnvPath, { contentHash: envFileHash });
    // Update the shared source mapping with process.env
    this.source = process.env;
    // Clear validated section cache after reloading source
    this.#validatedSections.clear();
    // Log successful env file load
    ErrorHandler.addError("EnvLoader: env file loaded successfully", {
      code: "ENV_FILE_LOADED",
      level: "info",
      path: resolvedEnvPath,
      hash: envFileHash,
      origin: "EnvLoader",
      timestamp: new Date().toISOString(),
    });
    // Return the refreshed environment source
    return this.source;
  }

  /**
   * Store and validate environment configuration.
   *
   * Validate the provided configuration object, cache it, and prepare section caches for future validation.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#setConfig #TODO
   * @param {EnvConfiguration} configDefinition - config describing each env variable
   * @returns {void} nothing
   */
  static setConfig(configDefinition = {}) {
    // Guard the validation and caching steps inside a try block
    try {
      // Ensure the configuration is an object
      if (configDefinition === null || configDefinition === undefined || typeof configDefinition !== "object") {
        // Throw when the provided value is not an object
        throw new Error("EnvLoader.setConfig requires a configuration object");
      }
      // Disallow arrays because they are not plain configuration objects
      if (Array.isArray(configDefinition)) {
        // Throw for invalid array structures
        throw new Error("EnvLoader.load requires a plain configuration object");
      }
      // Ensure the object is plain using SafeUtils
      if (!SafeUtils.isPlainObject(configDefinition)) {
        // Throw when the object has an unexpected prototype
        throw new Error("EnvLoader.load requires a plain configuration object");
      }
      // Record the configuration set attempt
      ErrorHandler.addError("EnvLoader: setting configuration", {
        code: "ENV_CONFIG_SET",
        level: "trace",
        sections: Object.keys(configDefinition),
        sectionCount: Object.keys(configDefinition).length,
        origin: "EnvLoader",
        timestamp: new Date().toISOString(),
      });
      // Validate the overall shape (ensures global section)
      this.#ensureConfigShape(configDefinition);
      // Deep validate each entry after the top-level shape passes
      this.#validateConfigDeep(configDefinition);
      // Cache the validated configuration for reuse
      this.config = configDefinition;
      // Clear any previously validated section caches
      this.#validatedSections.clear();
      // Log successful configuration storage
      ErrorHandler.addError("EnvLoader: configuration set successfully", {
        code: "ENV_CONFIG_SET_SUCCESS",
        level: "info",
        sections: Object.keys(configDefinition),
        origin: "EnvLoader",
        timestamp: new Date().toISOString(),
      });
    }
    // Handle validation failures
    catch (err) {
      // Log configuration failure with error details
      ErrorHandler.addError("EnvLoader: configuration validation failed", {
        code: "ENV_CONFIG_INVALID",
        level: "error",
        error: err.message,
        origin: "EnvLoader",
        timestamp: new Date().toISOString(),
      });
      // Rethrow to surface the validation error
      throw err;
    }
  }

  /**
   * Validate a specific config section.
   *
   * Normalize and validate a single section of the loaded configuration, caching the normalized values for reuse.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#validateEnv #TODO
   * @param {string} sectionName - section name to validate
   * @param {object|null} envConfiguration - optional config override
   * @returns {object} normalized environment values for the section
   */
  static validateEnv(sectionName = this.#DEFAULT_SECTION) {
    // Normalize the requested section name
    const resolvedSection = this.#normalizeSectionName(sectionName);
    // Retrieve the currently loaded configuration
    const activeConfig = this.config;
    // Ensure a configuration object is available before validating
    if (!activeConfig || typeof activeConfig !== "object") {
      // Throw when the loader has no configuration
      throw new Error("EnvLoader.validate requires a configuration object");
    }
    // Ensure the section exists with the required shape
    this.#ensureSectionShape(activeConfig, resolvedSection);
    // Invalidate cached section when config or source changes
    if (this.#validatedSections.has(resolvedSection)) {
      // Retrieve stored references for comparison
      const cachedConfig = this.#validatedSections.get(`${resolvedSection}:config`);
      const cachedSource = this.#validatedSections.get(`${resolvedSection}:source`);
      // Clear caches when either configuration or source no longer matches
      if (cachedConfig !== activeConfig || cachedSource !== this.source) {
        // Remove stale normalized values
        this.#validatedSections.delete(resolvedSection);
        // Remove stored config pointer
        this.#validatedSections.delete(`${resolvedSection}:config`);
        // Remove stored source pointer
        this.#validatedSections.delete(`${resolvedSection}:source`);
      }
    }
    // Return cached values when the section remains valid
    if (this.#validatedSections.has(resolvedSection)) {
      // Log cache hit event
      ErrorHandler.addError("EnvLoader: validation cache hit", {
        code: "ENV_VALIDATION_CACHE_HIT",
        level: "trace",
        section: resolvedSection,
        origin: "EnvLoader",
        timestamp: new Date().toISOString(),
      });
      // Provide the cached normalized values
      return this.#validatedSections.get(resolvedSection);
    }
    // Normalize and cache the section when no cache is available
    try {
      // Read the entries for the requested section
      const sectionEntries = activeConfig[resolvedSection] || [];
      // Load and normalize each entry
      const normalizedValues = this.#loadSection(sectionEntries);
      // Cache the normalized section
      this.#validatedSections.set(resolvedSection, normalizedValues);
      // Track the configuration reference for cache invalidation
      this.#validatedSections.set(`${resolvedSection}:config`, activeConfig);
      // Track the source reference for cache invalidation
      this.#validatedSections.set(`${resolvedSection}:source`, this.source);
      // Log successful validation
      ErrorHandler.addError("EnvLoader: section validated", {
        code: "ENV_SECTION_VALIDATED",
        level: "trace",
        section: resolvedSection,
        varsValidated: Object.keys(normalizedValues).length,
        origin: "EnvLoader",
        timestamp: new Date().toISOString(),
      });
      // Return the normalized values for this section
      return normalizedValues;
    }
    // Handle validation errors by logging and rethrowing
    catch (validationError) {
      // Emit error log for failed validation
      ErrorHandler.addError("EnvLoader: section validation failed", {
        code: "ENV_SECTION_VALIDATION_FAILED",
        level: "error",
        section: resolvedSection,
        error: validationError.message,
        origin: "EnvLoader",
        timestamp: new Date().toISOString(),
      });
      // Rethrow to notify callers of the failure
      throw validationError;
    }
  }

  /**
   * Warm up validation cache for commonly used sections.
   *
   * Pre-validates sections such as "global" so that their entries are ready before first use.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#warmupCache #TODO
   * @param {string[]} [sections] - Array of section names to warm up. Defaults to ["global"].
   * @returns {void}
   */
  static warmupCache(sections = [this.#DEFAULT_SECTION]) {
    // Skip warming up when no configuration is available
    if (!this.config || typeof this.config !== "object") {
      // Nothing to warm up without configuration
      return;
    }
    // Iterate through the requested sections array
    for (const section of sections) {
      // Only handle non-empty string section names
      if (typeof section === "string" && section.trim()) {
        // Attempt to validate each section without failing the loop
        try {
          // Force validation to populate cache entries
          this.validateEnv(section);
        }
        // Suppress validation errors during warmup
        catch (err) {
          // Ignore warmup errors since they will surface on actual usage
        }
      }
    }
  }

  /**
   * Ensure environment source contains usable values.
   *
   * Confirm that the current env source is non-empty and that validated configuration yields results.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#ensureEnv #TODO
   * @returns {true} when env is present and non-empty
   */
  static ensureEnv() {
    // Confirm env source is an object before further checks
    if (!this.source || typeof this.source !== "object") {
      // Throw when no environment source exists
      throw new Error("ENV");
    }
    // When config is loaded, ensure validating the global section returns values
    if (this.config && typeof this.config === "object") {
      // Validate the global section to access normalized values
      const globalEnv = this.validateEnv(this.#DEFAULT_SECTION);
      // Throw if global section validation produced no values
      if (!globalEnv || Object.keys(globalEnv).length === 0) {
        throw new Error("ENV");
      }
      // Report success since values exist
      return true;
    }
    // Collect all keys from the current source
    const keys = Object.keys(this.source);
    // Fail when the source contains no keys
    if (keys.length === 0) {
      throw new Error("ENV");
    }
    // Determine whether any source value is non-empty
    const hasValue = keys.some((key) => {
      // Retrieve the raw source value for the key
      const value = this.source[key];
      // Return true for non-empty trimmed strings
      return value !== undefined && value !== null && String(value).trim() !== "";
    });
    // Throw if all values were empty
    if (!hasValue) {
      throw new Error("ENV");
    }
    // Confirm the environment source is usable
    return true;
  }

  /**
   * Normalize environment configuration (private - use loadEnv() for public API).
   *
   * Build normalized environment mapping from provided configuration object by validating each section.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#normalizeConfig #TODO
   * @param {EnvConfiguration} envConfiguration - config describing each env variable
   * @returns {object} normalized environment values
   */
  static #normalizeConfig(envConfiguration = {}) {
    // Ensure the configuration follows the expected shape
    this.#ensureConfigShape(envConfiguration);
    // Prepare accumulator for normalized environment variables
    const normalizedEnvironment = {};
    // Iterate over each section defined in the configuration
    for (const [sectionName, sectionEntries] of Object.entries(envConfiguration)) {
      // Ensure each section is represented as an array
      if (!Array.isArray(sectionEntries)) {
        // Throw when a section is not array-formatted
        throw new Error(`EnvLoader.#normalizeConfig expects section "${sectionName}" to be an array`);
      }
      // Normalize the section name for consistent keys
      const resolvedSection = this.#normalizeSectionName(sectionName);
      // Use cached normalized values when available
      if (this.config === envConfiguration && this.#validatedSections.has(resolvedSection)) {
        // Retrieve cached normalized section
        const cachedValidatedSection = this.#validatedSections.get(resolvedSection);
        // Merge cached section values into accumulator
        Object.assign(normalizedEnvironment, cachedValidatedSection);
      }
      // Otherwise load and normalize the section afresh
      else {
        // Load the normalized values for the section entries
        const sectionValues = this.#loadSection(sectionEntries);
        // Merge the section's normalized values
        Object.assign(normalizedEnvironment, sectionValues);
      }
    }
    // Return the fully normalized environment object
    return normalizedEnvironment;
  }

  /**
   * Load a single config section.
   *
   * Normalize each entry in the specified section while collecting validation errors for later reporting.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#loadSection #TODO
   * @param {EnvEntry[]} sectionEntries - config entries for a section
   * @returns {object} normalized section values
   */
  static #loadSection(sectionEntries = []) {
    // Prepare accumulator for normalized values
    const normalizedEnvironment = {};
    // Track missing required entry errors
    const requiredErrors = [];
    // Track validation-specific errors (ints, bools, enums, etc.)
    const validationErrors = [];
    // Ensure the provided entries are in an array
    if (!Array.isArray(sectionEntries)) {
      // Inform callers of the misuse
      throw new Error("EnvLoader.#loadSection expects an array of entries");
    }
    // Iterate through each entry in the section
    for (const envEntry of sectionEntries) {
      // Normalize the entry name for consistent lookups
      const normalizedName = this.#normalizeName(envEntry);
      // Skip entries that lack a usable name
      if (!normalizedName) {
        // Continue to the next entry
        continue;
      }
      // Attempt to resolve the value for the entry
      try {
        // Resolve and assign the normalized value
        normalizedEnvironment[normalizedName] = this.#resolveValue(envEntry, normalizedName);
      }
      // Handle errors raised during resolution
      catch (entryError) {
        // Collect missing-required errors separately
        if (entryError.message && entryError.message.includes("missing required env")) {
          // Track the required error for later throwing
          requiredErrors.push(entryError);
        }
        // Track type and validation errors for later throwing
        else if (entryError.message && (
          entryError.message.includes("must be an integer") ||
          entryError.message.includes("must be a boolean") ||
          entryError.message.includes("must be one of") ||
          entryError.message.includes("requires a non-empty") ||
          entryError.message.includes("must be >=") ||
          entryError.message.includes("must be <=")
        )) {
          // Store validation errors for prioritized handling
          validationErrors.push(entryError);
        }
        // Log unexpected entry resolution failures
        else {
          // Emit warning about the skipped entry
          ErrorHandler.addError("EnvLoader: entry resolution failed (skipped)", {
            code: "ENV_ENTRY_RESOLUTION_FAILED",
            level: "warning",
            name: normalizedName,
            error: entryError.message,
            origin: "EnvLoader",
            timestamp: new Date().toISOString(),
          });
        }
        // Skip to the next entry after logging
        continue;
      }
    }
    // Throw the first validation error encountered, if any
    if (validationErrors.length > 0) {
      // Report validation failures before required ones
      throw validationErrors[0];
    }
    // Throw the first required-entry error encountered when validation passed
    if (requiredErrors.length > 0) {
      throw requiredErrors[0];
    }
    // Return the successfully normalized environment section
    return normalizedEnvironment;
  }



  /**
   * Ensure configuration object is valid.
   *
   * Validate top level shape of the provided config.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#_ensureConfigShape #TODO
   *
   * @param {EnvConfiguration} envConfiguration - configuration to validate
   * @returns {void} nothing
   */
  static #ensureConfigShape(envConfiguration) {
    // Ensure the configuration is plain via SafeUtils
    if (!SafeUtils.isPlainObject(envConfiguration)) {
      // Throw for non-plain configuration objects
      throw new Error("EnvLoader.load requires a plain configuration object");
    }
    // Validate the presence of the required global section
    const globalSection = envConfiguration[this.#DEFAULT_SECTION];
    if (!Array.isArray(globalSection)) {
      // Throw when the global section is missing or malformed
      throw new Error(`EnvLoader.load requires a "${this.#DEFAULT_SECTION}" array of env specs`);
    }
    // Verify that every configured section is an array
    for (const [key, sectionArray] of Object.entries(envConfiguration)) {
      // Throw when a section entry is not array-formatted
      if (!Array.isArray(sectionArray)) {
        // Throw for any non-array sections
        throw new Error(`EnvLoader.load expects section "${key}" to be an array`);
      }
    }
  }

  /**
   * Deep validation of configuration entries.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#_validateConfigDeep #TODO
   * @param {EnvConfiguration} envConfiguration - configuration to validate
   * @returns {void} nothing
   */
  static #validateConfigDeep(envConfiguration) {
    // Iterate through each section in the configuration
    for (const [sectionName, sectionEntries] of Object.entries(envConfiguration)) {
      // Skip entries that are not arrays
      if (!Array.isArray(sectionEntries)) {
        // Continue to the next section when invalid
        continue;
      }
      // Track whether we encountered at least one valid entry
      let hasValidEntry = false;
      // Capture the first invalid entry to report if no valid ones exist
      let firstInvalidEntry = null;
      // Iterate through every entry in the section
      for (const envEntry of sectionEntries) {
        // Ensure each entry is a plain object
        if (!SafeUtils.isPlainObject(envEntry)) {
          // Throw on malformed entry structure
          throw new Error(`EnvLoader: invalid entry in section "${sectionName}"`);
        }
        // Validate that the entry defines a non-empty string name
        if (typeof envEntry.name !== "string" || !envEntry.name.trim()) {
          // Track first invalid entry for error reporting
          if (!firstInvalidEntry) {
            firstInvalidEntry = envEntry;
          }
          // Skip entries that lack a valid name
          continue;
        }
        // Mark that at least one valid entry exists
        hasValidEntry = true;
        // Trim the name for comparisons
        const trimmedName = envEntry.name.trim();
        // Enforce uppercase names for environment variables
        if (trimmedName !== trimmedName.toUpperCase()) {
          // Log lowercase name rejection
          ErrorHandler.addError("EnvLoader: lowercase env var name rejected", {
            code: "ENV_LOWERCASE_NAME",
            level: "warning",
            section: sectionName,
            name: trimmedName,
            expected: trimmedName.toUpperCase(),
            origin: "EnvLoader",
            timestamp: new Date().toISOString(),
          });
          // Throw when a name is not uppercase
          throw new Error(`EnvLoader: environment variable name "${trimmedName}" must be uppercase`);
        }
        // Validate integer bounds when type is int
        if (envEntry.type === "int") {
          // Ensure both min and max are numbers before comparing
          if (typeof envEntry.min === "number" && typeof envEntry.max === "number") {
            // Detect invalid bounds where min exceeds max
            if (envEntry.min > envEntry.max) {
              // Log invalid integer bounds
              ErrorHandler.addError("EnvLoader: invalid int bounds", {
                code: "ENV_INVALID_INT_BOUNDS",
                level: "error",
                section: sectionName,
                name: envEntry.name,
                min: envEntry.min,
                max: envEntry.max,
                origin: "EnvLoader",
                timestamp: new Date().toISOString(),
              });
              // Throw to highlight the bound violation
              throw new Error(
                `EnvLoader: entry "${envEntry.name}" in section "${sectionName}" has min (${envEntry.min}) > max (${envEntry.max})`
              );
            }
          }
        }
        // Validate enum definitions and allowed list
        if (envEntry.type === "enum" || Array.isArray(envEntry.allowed)) {
          // Ensure the allowed array exists and is non-empty
          if (!Array.isArray(envEntry.allowed) || envEntry.allowed.length === 0) {
            // Throw when allowed options are missing for enums
            throw new Error(
              `EnvLoader: entry "${envEntry.name}" in section "${sectionName}" requires a non-empty "allowed" array for enum type`
            );
          }
          // Normalize allowed values for duplicate detection
          const lowerAllowed = envEntry.allowed.map((v) => String(v).toLowerCase());
          const uniqueLower = new Set(lowerAllowed);
          // Throw when allowed list contains case-insensitive duplicates
          if (lowerAllowed.length !== uniqueLower.size) {
            // Log enum duplicate detection
            ErrorHandler.addError("EnvLoader: enum case-insensitive duplicates", {
              code: "ENV_ENUM_DUPLICATES",
              level: "error",
              section: sectionName,
              name: envEntry.name,
              allowed: envEntry.allowed,
              origin: "EnvLoader",
              timestamp: new Date().toISOString(),
            });
            // Throw to inform about duplicate entries
            throw new Error(
              `EnvLoader: entry "${envEntry.name}" in section "${sectionName}" has case-insensitive duplicate values in "allowed" array`
            );
          }
          // Confirm each allowed value is a string
          for (const allowedValue of envEntry.allowed) {
            if (typeof allowedValue !== "string") {
              // Throw when non-string allowed values appear
              throw new Error(
                `EnvLoader: entry "${envEntry.name}" in section "${sectionName}" has non-string value in "allowed" array`
              );
            }
          }
        }
      }
      // After validating entries, ensure at least one valid entry existed
      if (!hasValidEntry && firstInvalidEntry) {
        // Throw when the section contained no valid names
        throw new Error(`EnvLoader: entry in section "${sectionName}" must have a non-empty string name`);
      }
    }
  }

  /**
   * Ensure configuration section is valid.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#_ensureSectionShape #TODO
   * @param {EnvConfiguration} envConfiguration - configuration to validate
   * @param {string} sectionName - section to validate
   * @returns {void} nothing
   */
  static #ensureSectionShape(envConfiguration, sectionName) {
    // Confirm the configuration object exists and is plain
    if (!envConfiguration || typeof envConfiguration !== "object") {
      // Throw when there is no configuration
      throw new Error("EnvLoader.validate requires a configuration object");
    }
    // Retrieve the section entries from the configuration
    const sectionEntries = envConfiguration[sectionName];
    // Ensure the section is represented as an array
    if (!Array.isArray(sectionEntries)) {
      // Throw when the requested section is missing or malformed
      throw new Error(`EnvLoader.validate requires a "${sectionName}" array`);
    }
  }

  /**
   * Normalize section names.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#_normalizeSectionName #TODO
   * @param {string} sectionName - section name to normalize
   * @returns {string} normalized section name
   */
  static #normalizeSectionName(sectionName) {
    // Return default when the name is not a string
    if (typeof sectionName !== "string") {
      return this.#DEFAULT_SECTION;
    }
    // Trim whitespace from the provided section name
    const trimmedSection = sectionName.trim();
    // Return default when trimming yields an empty string
    if (!trimmedSection) {
      return this.#DEFAULT_SECTION;
    }
    // Treat alias 'default' as the canonical default section
    if (trimmedSection.toLowerCase() === this.#ALIAS_DEFAULT) {
      return this.#DEFAULT_SECTION;
    }
    // Return the normalized section name
    return trimmedSection;
  }

  /**
   * Normalize environment entry name.
   *
   * Ensure the provided entry carries a string name and trim whitespace.
   * Returns uppercase name as required.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#_normalizeName #TODO
   *
   * @param {EnvEntry} envEntry - env entry metadata to evaluate
   * @returns {string} trimmed uppercase entry name or empty string when invalid
   */
  static #normalizeName(envEntry) {
    // Validate env entry presence and structure
    if (!envEntry || typeof envEntry.name !== "string") {
      // Return empty string for invalid entries
      return "";
    }
    // Trim and return normalized uppercase name
    return envEntry.name.trim().toUpperCase();
  }

  /**
   * Resolve configuration entry value.
   *
   * Derive normalized value for a single environment specification entry.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#_resolveValue #TODO
   *
   * @param {EnvEntry} envEntry - specification for environment value
   * @param {string} normalizedName - trimmed uppercase environment variable name
   * @returns {*} resolved value based on declared type
   */
  static #resolveValue(envEntry, normalizedName) {
    // Read the raw value from the environment source
    const rawValue = this.#resolveRaw(normalizedName);
    // Apply default fallback when raw value is empty and default is defined
    const normalizedValue =
      rawValue === "" && envEntry.default !== undefined
        ? String(envEntry.default).trim()
        : rawValue;
    // Enforce required values when indicated
    if (envEntry.required && normalizedValue === "") {
      // Throw when a required environment variable is missing
      throw new Error(`EnvLoader: missing required env "${normalizedName}"`);
    }
    // Return early when the value remains empty
    if (normalizedValue === "") {
      return normalizedValue;
    }
    // Coerce integer types
    if (envEntry.type === "int") {
      return this.#resolveInt(normalizedName, normalizedValue.trim(), envEntry);
    }
    // Coerce boolean types
    if (envEntry.type === "bool" || envEntry.type === "boolean") {
      return this.#resolveBool(normalizedName, normalizedValue.trim());
    }
    // Coerce enum or allowed values
    if (
      envEntry.type === "enum" ||
      (Array.isArray(envEntry.allowed) && envEntry.allowed.length > 0)
    ) {
      return this.#resolveEnum(normalizedName, normalizedValue.trim(), envEntry);
    }
    // Return trimmed string values by default
    return normalizedValue.trim();
  }

  /**
   * Resolve raw environment string.
   *
   * Retrieve trimmed uppercase value from the current source map.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#_resolveRaw #TODO
   *
   * @param {string} normalizedName - uppercase name to read from the source
   * @returns {string} trimmed source value
   */
  static #resolveRaw(normalizedName) {
    // Lookup the value from the shared source map
    const sourceValue = this.source[normalizedName];
    // Return empty string when undefined or null to avoid undefined propagation
    if (sourceValue === undefined || sourceValue === null) {
      return "";
    }
    // Coerce the raw value to string for downstream processing
    return String(sourceValue);
  }


  /**
   * Resolve integer configuration.
   *
   * Parse and validate integer env values against declared bounds.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#_resolveInt #TODO
   *
   * @param {string} normalizedName - name of the environment variable
   * @param {string} normalizedValue - string content to parse
   * @param {EnvEntry} envEntry - env entry configuration for validation
   * @returns {number} validated integer value
   */
  static #resolveInt(normalizedName, normalizedValue, envEntry) {
    // Trim whitespace from the provided value
    const trimmedValue = normalizedValue.trim();
    // Reject empty strings
    if (!trimmedValue) {
      // Throw when value is missing
      throw new Error(`EnvLoader: "${normalizedName}" must be an integer`);
    }
    // Disallow hex or octal prefixes
    if (/^0[xX]/.test(trimmedValue) || /^0[oO]/.test(trimmedValue)) {
      // Throw when non-decimal prefixes are detected
      throw new Error(`EnvLoader: "${normalizedName}" must be an integer`);
    }
    // Prevent leading zeros for multi-digit numbers
    if (trimmedValue.length > 1 && trimmedValue.startsWith("0")) {
      // Throw when value has invalid formatting
      throw new Error(`EnvLoader: "${normalizedName}" must be an integer`);
    }
    // Sanitize the numeric string
    const parsedInteger = SafeUtils.sanitizeInteger(trimmedValue);
    // Reject non-integer sanitization results
    if (parsedInteger === null || parsedInteger === false) {
      throw new Error(`EnvLoader: "${normalizedName}" must be an integer`);
    }
    // Ensure normalization matches the original string
    if (String(parsedInteger) !== trimmedValue) {
      throw new Error(`EnvLoader: "${normalizedName}" must be an integer`);
    }
    // Enforce minimum bound when specified
    if (typeof envEntry.min === "number" && parsedInteger < envEntry.min) {
      throw new Error(`EnvLoader: "${normalizedName}" must be >= ${envEntry.min}`);
    }
    // Enforce maximum bound when specified
    if (typeof envEntry.max === "number" && parsedInteger > envEntry.max) {
      throw new Error(`EnvLoader: "${normalizedName}" must be <= ${envEntry.max}`);
    }
    // Return validated integer
    return parsedInteger;
  }

  /**
   * Resolve boolean configuration.
   *
   * Parse and validate boolean env values against allowed representations.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#_resolveBool #TODO
   *
   * @param {string} normalizedName - name of the environment variable
   * @param {string} normalizedValue - string content to parse (already trimmed)
   * @returns {boolean} validated boolean value
   */
  static #resolveBool(normalizedName, normalizedValue) {
    // Sanitize the boolean-like string
    const booleanResult = SafeUtils.sanitizeBoolean(normalizedValue);
    // Throw when the value cannot be interpreted as a boolean
    if (booleanResult === null) {
      throw new Error(
        `EnvLoader: "${normalizedName}" must be a boolean (true/false, yes/no, 1/0)`,
      );
    }
    // Return the sanitized boolean
    return booleanResult;
  }

  /**
   * Resolve enum configuration.
   *
   * Match normalized value against allowed enum entries.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/EnvLoader#_resolveEnum #TODO
   *
   * @param {string} normalizedName - name of the environment variable
   * @param {string} normalizedValue - value to match against enums (already trimmed)
   * @param {EnvEntry} envEntry - enum configuration metadata
   * @returns {string} matched enum value (original case from allowed array)
   */
  static #resolveEnum(normalizedName, normalizedValue, envEntry) {
    // Determine the allowed enum options from the entry metadata
    const allowedOptions = Array.isArray(envEntry.allowed)
      ? envEntry.allowed
      : [];
    // Require a non-empty list of allowed values
    if (allowedOptions.length === 0) {
      // Throw when enum metadata is missing
      throw new Error(`EnvLoader: "${normalizedName}" requires a non-empty "allowed" array`);
    }
    // Prepare a lowercase version of the input for comparison
    const normalizedValueLower = normalizedValue.toLowerCase();
    // Attempt to find a matching allowed value
    const matchedOption = allowedOptions.find((allowedOption) => {
      // Skip non-string allowed values
      if (typeof allowedOption !== "string") {
        return false;
      }
      // Compare case-insensitively
      return allowedOption.toLowerCase() === normalizedValueLower;
    });
    // Throw when no match was found
    if (!matchedOption) {
      throw new Error(
        `EnvLoader: "${normalizedName}" must be one of: ${allowedOptions.join(", ")}`,
      );
    }
    // Return the matched allowed value with original casing
    return matchedOption;
  }
}

module.exports = EnvLoader;