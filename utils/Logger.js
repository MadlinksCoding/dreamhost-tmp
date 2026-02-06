// UtilityLogger.js — EFS-Optimized Logger (SQS/S3 removed, direct EFS writes)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { LRUCache } = require("lru-cache");
// const Slack = require("./slack");
const SafeUtils = require("./SafeUtils");
const DateTime = require("./DateTime");
const ConfigFileLoader = require("./ConfigFileLoader");
const EnvLoader = require("./EnvLoader");
const ErrorHandler = require("./ErrorHandler");

const DATE_FORMAT_DAY = "yyyy-MM-dd"; // Standard day format
const DATE_FORMAT_TIMESTAMP = "yyyy-MM-dd'T'HH:mm:ss.SSSZZ"; // Timestamp format used throughout logs
const LOG_TIMESTAMP_FORMAT = "yyyyMMddHHmmssSSS"; // Compact timestamp for filenames
const MAX_LOG_FILE_SIZE_BYTES = 5 * 1024 * 1024; // Rotate files after 5MB of data
const SLACK_FAILURE_THRESHOLD = 3; // Notify failure after this many attempts
const SLACK_FAILURE_COOLDOWN_MS = 60_000; // Cooldown before retrying Slack after repeated failures
const SLACK_FALLBACK_COOLDOWN_MS = 60_000; // Additional cooldown for fallback Slack writes
const SLACK_TIMEOUT_DEFAULT = 3000; // Default timeout for Slack requests
const CACHE_SIZE_LIMIT = 1000; // Limit entries per LRU cache
const PATH_SEGMENT_MAX_LEN = 64; // Maximum length for a sanitized path segment
const PLACEHOLDER_REGEX_PATTERN = /\{([^}]+)\}/; // Matches placeholders like {key}
const PLACEHOLDER_TOKEN_PATTERN = /^([A-Za-z0-9_]+)(?::([A-Za-z0-9_.\-\/]+))?$/; // Capture key and optional format
const SAFE_PLACEHOLDER_KEY_PATTERN = /^[A-Za-z0-9_]+$/; // Only allow alphanumeric/underscore keys
const RESERVED_PLACEHOLDER_KEYS = new Set(["__proto__", "constructor", "prototype"]); // Protect against prototype pollution
const FALLBACK_HASH_BYTES = 16; // Changed from 4 to 16
const RETRY_BACKOFF_BASE_MS = 50; // Base backoff time
const RETRY_BACKOFF_MAX_MS = 5000; // Max backoff cap
const FILE_OPERATION_TIMEOUT_MS = 30000; // 30 second timeout
const MAX_LOG_MESSAGE_SIZE = 10000; // 10KB max message
const MAX_LOG_DATA_SIZE = 10 * 1024 * 1024; // 10MB max data
const MAX_MISSING_PLACEHOLDERS = 100; // Limit missing fields
const MAX_CACHE_KEY_SIZE = 10000; // 10KB max cache key
const RATE_LIMIT_WRITES_PER_SECOND = 1000; // Rate limit
const RATE_LIMIT_WINDOW_MS = 1000; // 1 second window
const JSON_CIRCULAR_MAX_DEPTH = 50; // Max depth for circular JSON
const TIMESTAMP_COLLISION_SUFFIX_BYTES = 16; // Random suffix bytes
const ENCRYPTION_KEY_VERSION = 1; // Key version for rotation
const FILE_DESCRIPTOR_POOL_SIZE = 100; // Max concurrent file ops
// Standardized error codes used for logging operations
const ERROR_CODES = {
  WRITE_FAIL: "E_WRITE_FAIL",
  CRITICAL_WRITE_FAIL: "E_WRITE_FAIL_CRITICAL",
  BATCH_WRITE_FAIL: "E_BATCH_WRITE_FAIL",
  SLACK_FAIL: "E_SLACK_FAIL",
  ROTATE_FAIL: "E_ROTATE_FAIL",
};
const ENCRYPTION_ALGORITHM = "aes-256-gcm"; // Encryption algorithm used for log data encryption
const ENCRYPTION_IV_BYTES = 12; // IV length in bytes required by the AEAD cipher
const DEBUG_LEVEL_RANKS = Object.freeze({ trace: 10, debug: 20, info: 30 }); // Debug levels mapped to numeric ranks
const DEFAULT_DEBUG_LEVEL = "debug"; // Default level to use when unspecified
const ISO_FALLBACK_TIMESTAMP = "1970-01-01T00:00:00.000Z"; // Timestamp used when formatting cannot determine the current time
const ISO_FALLBACK_DATE = "1970-01-01"; // Date used when timestamp formatting falls back
const FALLBACK_FILE_TIMESTAMP = "19700101000000000"; // Default timestamp value used when formatting fails

/**
 * Class Logger
 *
 * Handles structured logging with EFS-optimized writes, critical alerts, and data encryption.
 *
 * @link https://docs.example.com/ErrorHandler #TODO
 */
class Logger {
  // Capture the environment variables at module load time
  static ENV = process.env;
  static {
    // Ensure environment variables are available
    EnvLoader.ensureEnv();
    // Throw when env validation fails early
    if (!Logger.ENV) {
      // Surface serious configuration issues immediately
      throw new Error("ENV");
    }
    // Validate the logger-specific environment schema
    try {
      EnvLoader.validateEnv("logger");
    } catch (err) {
      // Explicit error message check
      const errorMessage = err && err.message ? err.message : "unknown";
      // Report validation failures to the error handler
      ErrorHandler.addError("Logger env validation failed", {
        origin: "Logger",
        error: errorMessage,
      });
      // Re-throw the original error after logging
      throw err;
    }
    // Alert system removed - ErrorHandler now uses LRU cache without alerts
  }
  // Detect local environment for special behavior
  static IS_LOCAL = Logger.ENV.ENVIRONMENT === "local";
  // Determine remote environments for EFS usage
  static IS_REMOTE = ["dev", "stage", "prod"].includes(Logger.ENV.ENVIRONMENT);
  // Load log route configuration from the static config file
  static LOG_CONFIG = ConfigFileLoader.load(
    path.resolve(__dirname, "..", "configs", "logRoutes.json"),
  );
  // Choose appropriate log root depending on the environment
  static LOG_ROOT = Logger.IS_REMOTE
    ? Logger.ENV.LOG_EFS_ROOT
    : (
      Logger.ENV.LOG_LOCAL_ROOT ||
      Logger.LOG_CONFIG?.root ||
      path.join(process.cwd(), "logs")
    );
  // Determine where critical logs should reside
  static CRITICAL_ROOT = Logger.IS_REMOTE
    ? Logger.ENV.LOG_EFS_CRITICAL_ROOT
    : (
      Logger.ENV.LOG_LOCAL_CRITICAL_ROOT ||
      Logger.LOG_CONFIG?.criticalRoot ||
      path.join(Logger.LOG_ROOT, "critical")
    );
  
  // Encapsulate fallback directories in Logger class
  // Cached path for fallback logs
  static _FALLBACK_LOG_ROOT = null;
  // Cached path for missing-path fallbacks
  static _FALLBACK_MISSING_PATH_DIR = null;
  // Cached path for Slack fallbacks
  static _FALLBACK_SLACK_DIR = null;
  
  /**
   * Retrieve the cached fallback log root.
   *
   * Obtain the fallback directory for log writes when defaults are required.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_getFallbackLogRoot #TODO
   * @returns {string} fallback log root path
   */
  static _getFallbackLogRoot() {
    // Check cached fallback root
    if (Logger._FALLBACK_LOG_ROOT === null) {
      // Use configured fallback root if available
      if (Logger.ENV.LOG_FALLBACK_ROOT) {
        // Resolve configured fallback root to absolute path
        Logger._FALLBACK_LOG_ROOT = path.isAbsolute(Logger.ENV.LOG_FALLBACK_ROOT)
          ? Logger.ENV.LOG_FALLBACK_ROOT
          : path.resolve(Logger.ENV.LOG_FALLBACK_ROOT);
      } else {
        // Default to project logs_fallback directory
        Logger._FALLBACK_LOG_ROOT = path.join(process.cwd(), "logs_fallback");
      }
    }
    // Return the resolved fallback root
    return Logger._FALLBACK_LOG_ROOT;
  }
  
  /**
   * Retrieve fallback directory for missing path errors.
   *
   * Provide a cached directory for storing logs when route resolution fails.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_getFallbackMissingPathDir #TODO
   * @returns {string} missing path directory
   */
  static _getFallbackMissingPathDir() {
    // Check cached missing path directory
    if (Logger._FALLBACK_MISSING_PATH_DIR === null) {
      // Build missing path directory inside fallback root
      Logger._FALLBACK_MISSING_PATH_DIR = path.join(Logger._getFallbackLogRoot(), "missing_path");
    }
    // Return the resolved missing path directory
    return Logger._FALLBACK_MISSING_PATH_DIR;
  }
  
  /**
   * Retrieve fallback directory for slack messages.
   *
   * Supply a cached directory for writing slack fallback files.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_getFallbackSlackDir #TODO
   * @returns {string} slack directory path
   */
  static _getFallbackSlackDir() {
    // Check cached slack directory
    if (Logger._FALLBACK_SLACK_DIR === null) {
      // Build slack directory inside fallback root
      Logger._FALLBACK_SLACK_DIR = path.join(Logger._getFallbackLogRoot(), "slack");
    }
    // Return the resolved slack directory
    return Logger._FALLBACK_SLACK_DIR;
  }
  
  // Using LRUCache for automatic eviction of old entries
  static _RESOLVE_CACHE = new LRUCache({
    max: CACHE_SIZE_LIMIT,
    updateAgeOnGet: false,
    updateAgeOnHas: false,
  });
  static _ROUTE_CACHE = new LRUCache({
    max: CACHE_SIZE_LIMIT,
    updateAgeOnGet: false,
    updateAgeOnHas: false,
  });
  static _PATH_CACHE = new LRUCache({
    max: CACHE_SIZE_LIMIT,
    updateAgeOnGet: false,
    updateAgeOnHas: false,
  });
  
  // Unified cache size management
  // Note: LRUCache automatically evicts when max is reached, so _trimAllCachesIfNeeded
  // is now mainly for monitoring. We keep it for backward compatibility.
  /**
   * Get total cache size.
   *
   * Sum the counts of each cache to monitor usage.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_getTotalCacheSize #TODO
   * @returns {number} combined cache entry count
   */
  static _getTotalCacheSize() {
    // Return combined cache entries count
    return Logger._RESOLVE_CACHE.size + Logger._ROUTE_CACHE.size + Logger._PATH_CACHE.size;
  }
  
  /**
   * Evaluate whether cache trimming is required.
   *
   * Monitor combined cache usage and enforce a soft limit.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_trimAllCachesIfNeeded #TODO
   * @returns {void} nothing
   */
  static _trimAllCachesIfNeeded() {
    // Compute total cache size
    const totalSize = Logger._getTotalCacheSize();
    // Determine allowable global cache limit
    const globalLimit = CACHE_SIZE_LIMIT * 3;
    // Skip trimming when under soft limit
    if (totalSize <= globalLimit) {
      // Return early when caches remain within budget
      return;
    }
    // Note: LRUCache handles eviction automatically when over limit
  }
  static _SLACK_FAILURE_COUNT = 0;
  static _SLACK_COOLDOWN_UNTIL = 0;
  static _SLACK_FALLBACK_COOLDOWN_UNTIL = 0;
  static _SLACK_RETRY_LIMIT = 2;
  static _ENCRYPTION_KEY_BUFFER = undefined;
  static _ENCRYPTION_KEY_VERSION = ENCRYPTION_KEY_VERSION; // Key version for rotation
  static _LOCAL_WARNING_SHOWN = false;
  static _LOCAL_WARNING_HANDLER = null;
  static _ERROR_HANDLER_RECURSION_DEPTH = 0; // Prevent circular recursion
  static _ERROR_HANDLER_MAX_RECURSION = 3; // Max recursion depth
  static _WRITE_LOG_RATE_LIMIT_QUEUE = []; // Rate limiting queue
  static _CACHE_KEY_LOWER_MAP = new WeakMap(); // Cache for lowercase key lookups
  static _DEBUG_LOG_ENABLED_CACHE = null; // Cache debug flag
  static _ACTIVE_FILE_DESCRIPTORS = 0; // Track active file operations
  
  // File descriptor pool management
  /**
   * Acquire a file descriptor slot.
   *
   * Await availability before incrementing the active descriptor count.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_acquireFileDescriptor #TODO
   * @returns {Promise<void>} resolves when a slot is claimed
   */
  static async _acquireFileDescriptor() {
    // Wait while the descriptor pool is saturated
    while (Logger._ACTIVE_FILE_DESCRIPTORS >= FILE_DESCRIPTOR_POOL_SIZE) {
      // Delay briefly before retrying to prevent busy looping
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // Claim the available descriptor slot
    Logger._ACTIVE_FILE_DESCRIPTORS += 1;
  }
  
  /**
   * Release a claimed file descriptor slot.
   *
   * Decrease the active descriptor count if any slots are currently claimed.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_releaseFileDescriptor #TODO
   * @returns {void} nothing
   */
  static _releaseFileDescriptor() {
    // Check if there are active descriptors to release
    if (Logger._ACTIVE_FILE_DESCRIPTORS > 0) {
      // Decrement the active descriptor count
      Logger._ACTIVE_FILE_DESCRIPTORS -= 1;
    }
  }
  static _SLACK_RETRY_TIMERS = new WeakMap(); // Track retry timers for cleanup
  /**
   * Write a debug log to the console when enabled.
   *
   * Evaluate the environment flags before streaming filtered arguments to console.log.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#debugLog #TODO
   * @param {...any} consoleArguments - values passed through to console logging
   * @returns {boolean|null} true when logged otherwise null
   */
  static debugLog(...consoleArguments) {
    // Evaluate whether the console log flag is cached
    if (Logger._DEBUG_LOG_ENABLED_CACHE === null) {
      // Determine if console logs are enabled via boolean flag
      Logger._DEBUG_LOG_ENABLED_CACHE = Logger.ENV.LOGGING_ENABLE_CONSOLE_LOGS === true ||
        // Allow string "1" to enable console logs
        Logger.ENV.LOGGING_ENABLE_CONSOLE_LOGS === "1" ||
        // Allow numeric 1 to enable console logs
        Logger.ENV.LOGGING_ENABLE_CONSOLE_LOGS === 1;
    }
    // Skip logging when console output is disabled
    if (!Logger._DEBUG_LOG_ENABLED_CACHE) {
      // Indicate logging was suppressed
      return null;
    }
    // Extract configured debug level from environment
    const { LOG_DEBUG_LEVEL } = Logger.ENV;
    // Default to the baseline debug level
    let selectedLevel = DEFAULT_DEBUG_LEVEL;
    // Mirror the original arguments by default
    let filteredArguments = consoleArguments;
    // Inspect explicit log level indicator when present
    if (consoleArguments.length > 1 && typeof consoleArguments[0] === "string") {
      // Parse the level from the first argument
      const explicitLogLevel = Logger._parseDebugLevel(consoleArguments[0]);
      // Apply explicit level when parsed successfully
      if (explicitLogLevel) {
        // Override the selected level
        selectedLevel = explicitLogLevel;
        // Remove the level indicator from console arguments
        filteredArguments = consoleArguments.slice(1);
      }
    }
    // Normalize the configured minimum level
    const minimumConfiguredLevel = Logger._normalizeDebugLevel(LOG_DEBUG_LEVEL);
    // Guard against logging when the level rank is below minimum
    if (Logger._getDebugLevelRank(selectedLevel) < Logger._getDebugLevelRank(minimumConfiguredLevel)) {
      // Indicate logging was suppressed due to level filtering
      return null;
    }
    // Log the filtered arguments to the console
    console.log(...filteredArguments);
    // Indicate the log was emitted
    return true;
  }
  /**
   * Record a single structured log entry.
   *
   * Validate and route the entry before writing to storage and fallbacks.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#writeLog #TODO
   * @param {string} flag - identifier for log route
   * @param {Object} data - payload to log
   * @param {string} action - context action name
   * @param {boolean} critical - override critical flag
   * @param {string} message - descriptive text
   * @param {string} level - log severity level
   * @param {string[]} encryptFields - fields that require encryption
   * @returns {Promise<void|null>} null when logging is disabled
   */
  static async writeLog({
    flag: logFlag,
    data: logData = {},
    action: logAction,
    critical: explicitCriticalFlag,
    message: logMessage = "",
    level: logLevel = "info",
    encryptFields: encryptionFieldTargets = [],
  }) {
    // Extract environment flags for logging controls
    const { LOGGING_ENABLED: loggingEnabledFlag, ENVIRONMENT: environmentName } = Logger.ENV;
    // Skip when logging is globally disabled
    if (!loggingEnabledFlag) {
      // Indicate that logging was suppressed by configuration
      return null;
    }
    // Warn when running locally without remote routing
    Logger._warnIfLocalMode();
    // Track rate limit using current timestamp
    const currentTimestamp = Date.now();
    // Push the latest timestamp into the rate limit queue
    Logger._WRITE_LOG_RATE_LIMIT_QUEUE.push(currentTimestamp);
    // Compute the start of the sliding rate limit window
    const windowStart = currentTimestamp - RATE_LIMIT_WINDOW_MS;
    // Purge timestamps that fall outside the current window
    while (Logger._WRITE_LOG_RATE_LIMIT_QUEUE.length > 0 && Logger._WRITE_LOG_RATE_LIMIT_QUEUE[0] < windowStart) {
      // Remove stale timestamps from the queue
      Logger._WRITE_LOG_RATE_LIMIT_QUEUE.shift();
    }
    // Guard against exceeding the allowed writes per second
    if (Logger._WRITE_LOG_RATE_LIMIT_QUEUE.length > RATE_LIMIT_WRITES_PER_SECOND) {
      // Report the rate limit breach
      ErrorHandler.addError("Logger.writeLog: rate limit exceeded", { origin: "Logger", flag: logFlag, queueLength: Logger._WRITE_LOG_RATE_LIMIT_QUEUE.length });
      // Surface the violation via exception
      throw new Error("Logger.writeLog: rate limit exceeded");
    }
    // Validate that the log flag is a non-empty string
    if (typeof logFlag !== "string" || !logFlag.trim()) {
      // Report the invalid flag scenario
      ErrorHandler.addError("Logger.writeLog: invalid flag", { origin: "Logger", flag: logFlag });
      // Reject the request due to invalid flag
      throw new Error("Logger.writeLog: invalid flag");
    }
    // Ensure the data payload is a plain object
    if (typeof logData !== "object" || logData === null) {
      // Report the invalid data scenario
      ErrorHandler.addError("Logger.writeLog: data must be object", { origin: "Logger", flag: logFlag });
      // Reject the request due to invalid data
      throw new Error("Logger.writeLog: data must be object");
    }
    // Check message length against configured limit
    if (typeof logMessage === "string" && logMessage.length > MAX_LOG_MESSAGE_SIZE) {
      // Report message size breach
      ErrorHandler.addError("Logger.writeLog: message exceeds maximum size", { origin: "Logger", flag: logFlag, size: logMessage.length });
      // Throw to signal the oversized message
      throw new Error(`Logger.writeLog: message exceeds maximum size of ${MAX_LOG_MESSAGE_SIZE} bytes (message too large)`);
    }
    // Safely serialize data to measure its size
    try {
      // Compute the JSON size of the payload
      const dataSize = JSON.stringify(logData).length;
      // Enforce maximum allowed data size
      if (dataSize > MAX_LOG_DATA_SIZE) {
        // Report data size violation
        ErrorHandler.addError("Logger.writeLog: data exceeds maximum size", { origin: "Logger", flag: logFlag, size: dataSize });
        // Throw to signal the oversized data
        throw new Error(`Logger.writeLog: data exceeds maximum size of ${MAX_LOG_DATA_SIZE} bytes (data too large)`);
      }
    } catch (err) {
      // Re-throw specific size errors
      if (err.message.includes("exceeds maximum size")) {
        // Surface the previously thrown error
        throw err;
      }
      // Fall back to key count estimation when serialization fails
      const keyCount = Object.keys(logData).length;
      // Reject objects that remain excessively large
      if (keyCount > 10000) {
        // Prevent processing extremely large payloads
        throw new Error("Logger.writeLog: data object too large");
      }
    }
    // Resolve routing metadata for this flag
    const route = Logger.getRouteByFlag(logFlag);
    // Determine if the entry should be treated as critical
    const isCritical = Logger._resolveCriticalFlag(explicitCriticalFlag, route.critical);
    // Collect fields that require encryption
    const encryptionTargets = Logger._collectEncryptionTargets(route, { encryptFields: encryptionFieldTargets, data: logData });
    // Require action when the path pattern mandates it
    if (route && route.path && route.path.includes("{action}") && (typeof logAction !== "string" || !logAction.trim())) {
      // Report missing action for the configured route
      ErrorHandler.addError("Logger.writeLog: action is required for this log route", { origin: "Logger", flag: logFlag, path: route.path });
      // Reject the call because the action is mandatory
      throw new Error("Logger.writeLog: action is required for this log route");
    }
    // Prepare placeholder data for path resolution
    const pathData = Logger._preparePathData(logData, logAction);
    // Resolve the log path and capture any missing placeholders
    const { path: resolvedPath, missing = [] } = Logger.resolvePath(route.path, pathData);
    // Capture the current timestamp for entry metadata
    const nowRaw = DateTime.now();
    // Format the timestamp for the log entry
    const timestamp = Logger._safeFormatDate(nowRaw, DATE_FORMAT_TIMESTAMP, { placeholder: "timestamp", fallback: ISO_FALLBACK_TIMESTAMP });
    // Format the timestamp for the log filename
    const fileTimestamp = Logger._safeFormatDate(nowRaw, LOG_TIMESTAMP_FORMAT, { placeholder: "fileTimestamp", fallback: FALLBACK_FILE_TIMESTAMP });
    // Build the base log entry object
    const logEntry = { schemaVersion: "1.0", timestamp, level: logLevel, flag: logFlag, action: logAction || null, message: logMessage, critical: isCritical, data: logData, retention: route.retention, PciCompliance: route.PciCompliance, description: route.description, category: route.category, env: environmentName };
    // Apply encryption to sensitive fields when requested
    Logger._applyEncryption(logEntry, encryptionTargets);
    // Serialize the entry for storage
    const serializedLogEntry = Logger._serializeLogEntry(logEntry);
    // Handle missing placeholders by writing to fallback storage
    if (!resolvedPath) {
      // Report the missing placeholders failure
      ErrorHandler.addError("Logger.writeLog: missing placeholders", { origin: "Logger", flag: logFlag, missing: missing || [], routePath: route.path });
      // Build the fallback file location
      const fallbackTemplatePath = Logger._fallbackPathFromPattern(route.path);
      // Compose the relative path for the fallback file
      const fallbackRelative = Logger._buildFallbackRelativePath(fallbackTemplatePath, fileTimestamp);
      // Construct the fallback log entry explicitly
      const fallbackEntry = { schemaVersion: logEntry.schemaVersion, timestamp: logEntry.timestamp, level: logEntry.level, flag: logFlag, action: logEntry.action, message: logMessage, critical: logEntry.critical, data: logData, retention: logEntry.retention, PciCompliance: logEntry.PciCompliance, description: logEntry.description, category: logEntry.category, env: environmentName, logError: missing && missing.length ? `Missing required placeholders: ${missing.join(", ")}` : "Missing required placeholders", missingPlaceholders: missing };
      // Write the fallback entry to disk
      await Logger._writeFallbackLogEntry(Logger._getFallbackMissingPathDir(), fallbackRelative, Logger._serializeLogEntry(fallbackEntry), { stage: "missing-placeholders" });
      // Exit early because the primary path could not be resolved
      return;
    }
    // Append the file timestamp to the resolved path
    const timestampedLogPath = Logger._appendTimestampToPath(resolvedPath, fileTimestamp);
    // Write the serialized entry to storage
    await Logger.writeToStorage(timestampedLogPath, serializedLogEntry);
    // Handle critical entries via dedicated storage and Slack
    if (isCritical) {
      // Persist the critical file
      await Logger.writeCriticalLogFile(resolvedPath, serializedLogEntry, fileTimestamp);
      // Notify the critical slack channel
      await Logger.sendToSlackCritical(logEntry);
    }
  }

  /**
   * Write a batch of structured log entries.
   *
   Validate each entry, deduplicate them, and dispatch the required writes and fallbacks.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#writeLogs #TODO
   * @param {Object[]} logEntries - collection of entries to log
   * @returns {Promise<void|null>} null when logging is disabled
   */
  static async writeLogs(logEntries) {
    // Extract environment flags for logging and routing
    const { LOGGING_ENABLED: loggingEnabledFlag, ENVIRONMENT: environmentName } = Logger.ENV;
    // Exit early when logging is disabled by configuration
    if (!loggingEnabledFlag) {
      // Indicate logging did not run
      return null;
    }
    // Warn when operating in local mode without remote storage
    Logger._warnIfLocalMode();
    // Guard against receiving a non-array batch
    if (!Array.isArray(logEntries)) {
      // Record the invalid payload shape
      ErrorHandler.addError("Logger.writeLogs: logs must be an array", {
        origin: "Logger",
      });
      // Reject the request due to invalid input
      throw new Error("Logger.writeLogs: logs must be an array");
    }
    // Prepare promises for writes to primary storage
    const storagePromises = [];
    // Queue slack entries for critical logs
    const slackEntryQueue = [];
    // Track fallback keys to avoid duplicate writes
    const fallbackKeys = new Set();
    // Track seen log signatures for deduplication
    const seenSignatures = new Set();
    // Collect deduplicated log entries
    const uniqueLogs = [];
    // Capture a single timestamp for the batch file names
    const batchTimestamp = DateTime.now();
    // Format the batch-level file timestamp
    const batchFileTimestamp = Logger._safeFormatDate(batchTimestamp, LOG_TIMESTAMP_FORMAT, { placeholder: "fileTimestamp", fallback: FALLBACK_FILE_TIMESTAMP });
    // Validate and deduplicate each entry before writing
    logEntries.forEach((logEntry, index) => {
      // Validate that each entry includes a log flag
      if (typeof logEntry.flag !== "string" || !logEntry.flag.trim()) {
        // Report missing or invalid flag per entry
        ErrorHandler.addError("Logger.writeLogs: invalid flag in log entry", {
          origin: "Logger",
          index,
        });
        // Abort due to missing flag
        throw new Error("Logger.writeLogs: invalid flag in log entry");
      }
      // Validate that each entry includes a data object
      if (typeof logEntry.data !== "object" || logEntry.data === null) {
        // Report missing or invalid data per entry
        ErrorHandler.addError("Logger.writeLogs: data must be object in log entry", {
          origin: "Logger",
          index,
        });
        // Abort due to invalid data
        throw new Error("Logger.writeLogs: data must be object in log entry");
      }
      // Create a signature for deduplication
      const signature = `${logEntry.flag}::${JSON.stringify(logEntry.data).slice(0, 100)}`;
      // Keep only unique signatures to prevent duplicates
      if (!seenSignatures.has(signature)) {
        // Mark this signature as processed
        seenSignatures.add(signature);
        // Retain the unique log entry for processing
        uniqueLogs.push(logEntry);
      }
    });
    // Process each deduplicated log entry
    for (const logEntry of uniqueLogs) {
      // Resolve the route definition for the entry
      const route = Logger.getRouteByFlag(logEntry.flag);
      // Determine whether the entry should be critical
      const isCritical = Logger._resolveCriticalFlag(logEntry.critical, route.critical);
      // Determine encryption targets for the entry
      const encryptionTargets = Logger._collectEncryptionTargets(route, logEntry);
      // Build the placeholder data required for resolving the path
      const pathData = Logger._preparePathData(logEntry.data, logEntry.action);
      // Resolve the path and capture missing placeholders
      const { path: resolvedPath, missing = [] } = Logger.resolvePath(route.path, pathData);
      // Describe missing placeholders for logging
      const missingDescriptor = Logger._describeMissingPlaceholders(missing);
      // Format the entry timestamp using the current time
      const entryTimestamp = Logger._safeFormatDate(DateTime.now(), DATE_FORMAT_TIMESTAMP, { placeholder: "timestamp", fallback: ISO_FALLBACK_TIMESTAMP });
      // Reuse the batch-level file timestamp for file writes
      const fileTimestamp = batchFileTimestamp;
      // Construct the structured entry payload
      const constructedEntry = {
        schemaVersion: "1.0",
        timestamp: entryTimestamp,
        level: logEntry.level || "info",
        flag: logEntry.flag,
        action: logEntry.action || null,
        message: logEntry.message || "",
        critical: isCritical,
        data: logEntry.data,
        retention: route.retention,
        PciCompliance: route.PciCompliance,
        description: route.description,
        category: route.category,
        env: environmentName,
      };
      // Encrypt requested fields within the entry
      Logger._applyEncryption(constructedEntry, encryptionTargets);
      // Serialize the entry for writing
      const serializedEntry = Logger._serializeLogEntry(constructedEntry);
      // Handle unresolved paths by writing fallback entries
      if (!resolvedPath) {
        // Sanitize the flag for safe fallback filenames
        const sanitizedFlag = Logger._sanitizePathSegment(logEntry.flag);
        // Determine a fallback suffix based on missing descriptors
        const fallbackSuffix = missingDescriptor || "_missing";
        // Compose the fallback key to deduplicate writes
        const fallbackKey = `missing:${sanitizedFlag}:${fallbackSuffix}`;
        // Write fallback entry only once per unique key
        if (!fallbackKeys.has(fallbackKey)) {
          // Track the fallback key to avoid retries
          fallbackKeys.add(fallbackKey);
          // Report missing placeholders for this entry
          ErrorHandler.addError("Logger.writeLogs: missing placeholders in entry", {
            origin: "Logger",
            flag: logEntry.flag,
            missing,
            routePath: route.path,
          });
          // Resolve the fallback template path for recording the failure
          const fallbackTemplatePath = Logger._fallbackPathFromPattern(route.path);
          // Build the relative path for the fallback file
          const fallbackRelative = Logger._buildFallbackRelativePath(fallbackTemplatePath, fileTimestamp);
          // Create a fallback entry explicitly instead of spreading
          const fallbackEntry = {
            schemaVersion: constructedEntry.schemaVersion,
            timestamp: constructedEntry.timestamp,
            level: constructedEntry.level,
            flag: constructedEntry.flag,
            action: constructedEntry.action,
            message: constructedEntry.message,
            critical: constructedEntry.critical,
            data: constructedEntry.data,
            retention: constructedEntry.retention,
            PciCompliance: constructedEntry.PciCompliance,
            description: constructedEntry.description,
            category: constructedEntry.category,
            env: constructedEntry.env,
            logError: missing.length
              ? `Missing required placeholders: ${missing.join(", ")}`
              : "Missing required placeholders",
            missingPlaceholders: missing,
          };
          // Queue the fallback write for persistence
          storagePromises.push(
            Logger._writeFallbackLogEntry(
              Logger._getFallbackMissingPathDir(),
              fallbackRelative,
              Logger._serializeLogEntry(fallbackEntry),
              { stage: "missing-placeholders" },
            ),
          );
        }
        // Skip writing to the primary path for this entry
        continue;
      }
      // Append timestamp suffix to the resolved path
      const timestampedLogPath = Logger._appendTimestampToPath(resolvedPath, fileTimestamp);
      // Queue the primary storage write
      storagePromises.push(Logger.writeToStorage(timestampedLogPath, serializedEntry));
      // Handle critical entries by persisting and alerting
      if (isCritical) {
        // Queue the critical file write
        storagePromises.push(
          Logger.writeCriticalLogFile(
            resolvedPath,
            serializedEntry,
            fileTimestamp,
          ),
        );
        // Queue the Slack alert for later
        slackEntryQueue.push(constructedEntry);
      }
    }
    // Flush all queued storage writes
    await Promise.allSettled(storagePromises);
    // Send critical Slack alerts sequentially
    for (const slackEntry of slackEntryQueue) {
      await Logger.sendToSlackCritical(slackEntry);
    }
  }

  /**
   * Run writeLog with retries to handle transient failures.
   *
   * Retry the primary writeLog call once before returning failure.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#writeLogSafe #TODO
   * @param {Object} originalPayload - payload to log safely
   * @returns {Promise<any|null>} result of writeLog or null on failure
   */
  static async writeLogSafe(originalPayload) {
    // Track retry attempt count
    let retryAttempt = 0;
    // Initialize the payload used for logging
    let currentPayload = originalPayload;
    // Continue attempting while retry limit is not reached
    while (retryAttempt < 2) {
      // Attempt to write the payload safely
      try {
        // Forward the current payload to writeLog
        return await Logger.writeLog(currentPayload);
      }
      // Handle failures from writeLog
      catch (err) {
        // Log the writeLogSafe failure for debugging
        ErrorHandler.addError("Logger.writeLogSafe failed", {
          // Indicate the origin of the failure
          origin: "Logger",
          // Capture the attempt count when the error occurred
          attempt: retryAttempt,
          // Include the underlying error message when available
          error: err?.message || "unknown",
        });
        // Increment the retry attempt counter
        retryAttempt += 1;
        // Stop retrying once the limit is reached
        if (retryAttempt >= 2) {
          // Return null when retry limit is exhausted
          return null;
        }
        // Refresh the payload before the next attempt
        currentPayload =
          // Determine if the original payload is an object
          typeof originalPayload === "object" && originalPayload !== null
            // Use object merge when payload is object
            ? { ...originalPayload, safeFailed: true }
            // Build a safe payload when the original is not an object
            : { safeFailed: true };
      }
    }
    // Return null when all attempts have been processed without success
    return null;
  }
  /**
   * Run writeLogs with retries to handle transient failures.
   *
   * Retry the batched write operation once before returning failure.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#writeLogsSafe #TODO
   * @param {Object[]} originalLogs - collection of entries to process safely
   * @returns {Promise<any|null>} result of writeLogs or null on failure
   */
  static async writeLogsSafe(originalLogs) {
    // Track retry attempts
    let retryAttempt = 0;
    // Initialize the logs payload used for retries
    let currentLogs = originalLogs;
    // Continue retrying until the attempt limit is reached
    while (retryAttempt < 2) {
      // Attempt to write the logs batch
      try {
        // Forward the current batch to writeLogs
        return await Logger.writeLogs(currentLogs);
      }
      // Handle errors from writeLogs
      catch (err) {
        // Record the safe write failure for debugging
        ErrorHandler.addError("Logger.writeLogsSafe failed", {
          origin: "Logger",
          attempt: retryAttempt,
          error: err?.message || "unknown",
        });
        // Increment the retry counter
        retryAttempt += 1;
        // Exit when the retry limit has been reached
        if (retryAttempt >= 2) {
          // Return null after exhausting retries
          return null;
        }
        // Refresh the logs payload before the next attempt
        currentLogs =
          // Check if the original payload is an array for mapping
          Array.isArray(originalLogs)
            ? // Map entries to flag them as safely failed
              originalLogs.map((logEntry) => ({
                // Preserve existing entry data
                ...(logEntry || {}),
                // Mark the entry to indicate safe failure
                safeFailed: true,
              }))
            : // Keep the original payload when not an array
              originalLogs;
      }
    }
    // Return null when all retries have been attempted without success
    return null;
  }

  /**
   * Write a batch file with safeguards.
   *
   * Serialize a collection of log entries and persist them, falling back when necessary.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#writeLogBatchFile #TODO
   * @param {string} batchRelativePath - relative destination for the batch file
   * @param {Object[]} batchEntries - array of entries that compose the batch
   * @returns {Promise<void>} resolves when the batch file is persisted
   */
  static async writeLogBatchFile(batchRelativePath, batchEntries) {
    // Define environment metadata for this batch
    const { ENVIRONMENT: environmentName } = Logger.ENV;
    // Resolve the full path within the configured log root
    const resolvedBatchPath = await Logger._resolvePathWithinRoot(Logger.LOG_ROOT, batchRelativePath);
    // Capture the safe relative path extracted from resolution
    const safeRelativePath = resolvedBatchPath.relative;
    // Capture the absolute path to write into
    const absoluteBatchPath = resolvedBatchPath.full;
    // Capture the directory component needed for creation
    const batchDirectoryPath = resolvedBatchPath.dir;
    // Validate that the batch payload is an array
    if (!Array.isArray(batchEntries)) {
      // Signal wrong input shape to the caller
      throw new TypeError("Logger.writeLogBatchFile: entries must be an array");
    }
    // Attempt the primary batch write
    try {
      // Ensure the primary directory exists before writing
      await Logger._ensureDirExists(batchDirectoryPath, { stage: "primary-batch-write" });
      // Serialize each entry into its log representation
      const serializedBatchEntries = batchEntries.map((batchEntry) => Logger._serializeLogEntry(batchEntry));
      // Turn serialized entries into buffers with newline separators
      const entryBuffers = serializedBatchEntries.map((entryString) => Buffer.from(`${entryString}\n`, "utf8"));
      // Aggregate all buffers into one contiguous chunk
      const batchContentBuffer = Buffer.concat(entryBuffers);
      // Convert the combined buffer into a UTF-8 string payload
      const serializedBatchContent = batchContentBuffer.toString("utf8");
      // Write the serialized batch content with retry support
      await Logger._writeFileWithRetry(absoluteBatchPath, serializedBatchContent);
    }
    // Handle errors that occur during the primary write
    catch (err) {
      // Propagate permission-denied errors so callers can handle them
      if (Logger._isPermissionError(err)) {
        // Rethrow permission errors immediately
        throw err;
      }
      // Compute the fallback root used for batch write failures
      const fallbackRoot = path.join(Logger._getFallbackLogRoot(), "batch_write_errors");
      // Build the fallback path for this batch write failure
      const fallback = path.join(fallbackRoot, safeRel);
      // Attempt to record the failure in the fallback location
      try {
        // Ensure that the fallback directory exists
        await Logger._ensureDirExists(path.dirname(fallback), { stage: "fallback-batch-write" });
        // Build a structured fallback entry for diagnostics
        const fallbackEntry = {
          // Timestamp the failure entry
          timestamp: DateTime.now(DATE_FORMAT_TIMESTAMP),
          // Capture the error message raised by the primary write
          error: err.message,
          // Record the intended destination that failed
          attemptedPath: absoluteBatchPath,
          // Track how many entries were in the failed batch
          entryCount: batchEntries.length,
          // Preserve the originating environment name
          env: environmentName,
          // Attach the standardized error code for batch writes
          errorCode: ERROR_CODES.BATCH_WRITE_FAIL,
        };
        // Append a timestamp suffix to the fallback filename
        const fallbackWithTimestamp = Logger._appendTimestampToPath(fallback);
        // Write the serialized fallback entry with retry support
        await Logger._writeFileWithRetry(
          // Provide the fallback path with timestamp
          fallbackWithTimestamp,
          // Serialize the fallback entry with newline termination
          `${Logger._serializeLogEntry(fallbackEntry)}\n`,
        );
      }
      // Handle errors during fallback persistence
      catch (fallbackErr) {
        // Bypass fallback errors caused by permissions
        if (Logger._isPermissionError(fallbackErr)) {
          // Return silently when fallback lacks permissions
          return;
        }
        // Surface other fallback errors to the caller
        throw fallbackErr;
      }
    }
  }
  /**
   * Resolve root path asynchronously (non-blocking).
   *
   * Attempt an async realpath lookup while providing a synchronous fallback.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_resolveRootPath #TODO
   * @param {string} rootPath - Path to resolve
   * @returns {Promise<string>} resolved absolute path
   */
  static async _resolveRootPath(rootPath) {
    // Validate that the provided path is a string before resolving
    if (typeof rootPath !== "string") {
      // Return empty string when the input path is invalid
      return "";
    }
    // Attempt to resolve the path via fs.realpath
    try {
      // Use fs.promises.realpath for async resolution
      return await fs.promises.realpath(rootPath);
    }
    // Fallback when async realpath fails
    catch {
      // Resolve the path synchronously as a fallback
      return path.resolve(rootPath);
    }
  }
  /**
   * Persist a critical log payload with retry-safe fallbacks.
   *
   * Ensure the payload lands in the critical storage area and fallback directories when needed.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#writeCriticalLogFile #TODO
   * @param {string} criticalRelativePath - path relative to the critical root
   * @param {Object|string} logPayload - payload to be written
   * @param {string|null} criticalFileTimestamp - optional timestamp for filename
   * @returns {Promise<void>} completes when the file is persisted
   */
  static async writeCriticalLogFile(criticalRelativePath, logPayload, criticalFileTimestamp = null) {
    // Extract environment metadata for the critical log write
    const { ENVIRONMENT: environmentName } = Logger.ENV;
    // Normalize the relative path into a critical log path
    const criticalPath = Logger._toCriticalLogPath(criticalRelativePath);
    // Append optional timestamp to the critical path
    const timestampedCriticalPath = Logger._appendTimestampToPath(criticalPath, criticalFileTimestamp);
    // Ensure the critical path is relative before resolving
    const safeCriticalPath = Logger.ensureRelativeLogPath(timestampedCriticalPath);
    // Determine if the critical root is a subdirectory of the log root
    const isCriticalSubdir = await Logger._isPathWithinRoot(Logger.LOG_ROOT, Logger.CRITICAL_ROOT);
    // Validate the payload to ensure it is writeable
    Logger._validateLogPayload(logPayload);
    // Serialize the payload if not already a string
    const serializedPayload = typeof logPayload === "string" ? logPayload : Logger._serializeLogEntry(logPayload);
    // Handle the scenario where critical storage resides under the main log root
    if (isCriticalSubdir) {
      // Resolve the root paths to compute a relative path inside the log directory
      const resolvedLogRoot = await Logger._resolveRootPath(Logger.LOG_ROOT);
      const resolvedCriticalRoot = await Logger._resolveRootPath(Logger.CRITICAL_ROOT);
      // Build the relative path from log root to critical root
      const relFromRoot = path.join(
        path.relative(resolvedLogRoot, resolvedCriticalRoot),
        safeRel,
      );
      // Delegate writing to the shared storage handler when paths overlap
      return Logger.writeToStorage(relFromRoot, payload);
    }
    // Resolve the critical path within its dedicated root
    const resolvedCritical = await Logger._resolvePathWithinRoot(Logger.CRITICAL_ROOT, safeCriticalPath);
    // Capture the fully qualified destination path
    const criticalFullPath = resolvedCritical.full;
    // Capture the directory portion for creation
    const criticalDir = resolvedCritical.dir;
    // Attempt the primary critical write with retry-aware helper
    try {
      // Ensure the destination directory exists before writing
      await Logger._ensureDirExists(criticalDir, { stage: "primary-critical-write" });
      // Persist the serialized payload with retry semantics
      await Logger._writeFileWithRetry(criticalFullPath, `${serializedPayload}\n`);
    }
    // Handle write failures by dumping to a fallback directory
    catch (err) {
      // Allow permission errors to be handled by callers
      if (Logger._isPermissionError(err)) {
        return;
      }
      // Build the fallback root path for critical write errors
      const fallbackRoot = path.join(Logger._getFallbackLogRoot(), "critical_write_errors");
      // Compose the fallback file path
      const fallback = path.join(fallbackRoot, safeCriticalPath);
      // Attempt to record the failure for diagnostics
      try {
        // Ensure the fallback directory exists
        await Logger._ensureDirExists(path.dirname(fallback), { stage: "fallback-critical-write" });
        // Build a structured failure entry
        const fallbackEntry = {
          timestamp: DateTime.now(DATE_FORMAT_TIMESTAMP),
          error: err.message,
          attemptedPath: criticalFullPath,
          env: environmentName,
          errorCode: ERROR_CODES.CRITICAL_WRITE_FAIL,
        };
        // Append a timestamp suffix to the fallback file for uniqueness
        const fallbackWithTimestamp = Logger._appendTimestampToPath(fallback);
        // Write the failure entry to the fallback location
        await Logger._writeFileWithRetry(
          fallbackWithTimestamp,
          `${Logger._serializeLogEntry(fallbackEntry)}\n`,
        );
      }
      // Propagate non-permission fallback failures
      catch (fallbackErr) {
        if (Logger._isPermissionError(fallbackErr)) {
          return;
        }
        // Re-throw when fallback logging fails unexpectedly
        throw fallbackErr;
      }
    }
  }
  /**
   * Send critical logs to Slack with fallback handling.
   *
   Respect cooldowns, retry fallback writes, and log both success and failure states.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#sendToSlackCritical #TODO
   * @param {Object} slackAlertEntry - entry to send to Slack
   * @returns {Promise<null|void>} null when skipped, otherwise void
   */
  static async sendToSlackCritical(slackAlertEntry) {
    // Skip sending when cooldown window is active
    if (!Logger._canSendSlack()) {
      // Debug log about suppressed Slack send
      Logger.debugLog?.("debug", "[Logger] Slack send skipped: in cooldown window");
      // Return null to indicate nothing was sent
      return null;
    }
    // Prepare an AbortController to cancel the Slack request if needed
    const abortController = new AbortController();
    // Set a timeout to abort the Slack request after the configured duration
    const slackTimeoutId = setTimeout(
      () => abortController.abort(),
      Logger._getSlackTimeoutMs(),
    );
    // Attempt to send the alert to Slack
    try {
      // Push the alert to Slack with abort signal support
      await Slack.critical(slackAlertEntry, { signal: abortController.signal });
      // Record the successful send operation
      Logger._recordSlackSuccess();
    }
    // Handle errors encountered while sending to Slack
    catch (err) {
      // Preserve the thrown error for diagnostics
      const sendError = err;
      // Update slack failure counters and cooldowns
      Logger._recordSlackFailure(err);
      // Log the failure details for debugging purposes
      Logger.debugLog?.("debug", `[Logger] Slack send failed: ${sendError.message}`);
      // Skip fallback handling when still in the fallback cooldown window
      if (Date.now() < Logger._SLACK_FALLBACK_COOLDOWN_UNTIL) {
        //Log suppression due to fallback cooldown
        Logger.debugLog?.("debug", "[Logger] Slack fallback suppressed during cooldown");
        // Return null to indicate fallback was skipped
        return null;
      }
      // Determine the route metadata for this alert
      const routeDefinition = Logger.getRouteByFlag(slackAlertEntry.flag);
      // Build a fallback relative path derived from the route definition
      const fallbackTemplatePath = Logger._fallbackPathFromPattern(routeDefinition?.path);
      // Append timestamp and suffix to create the fallback path
      const fallbackRelative = Logger._buildFallbackRelativePath(fallbackTemplatePath);
      // Construct the fallback entry explicitly to avoid spreads
      const fallbackSlackEntry = {
        schemaVersion: slackAlertEntry.schemaVersion,
        timestamp: slackAlertEntry.timestamp,
        level: slackAlertEntry.level,
        flag: slackAlertEntry.flag,
        action: slackAlertEntry.action,
        message: slackAlertEntry.message,
        critical: slackAlertEntry.critical,
        data: slackAlertEntry.data,
        retention: slackAlertEntry.retention,
        PciCompliance: slackAlertEntry.PciCompliance,
        description: slackAlertEntry.description,
        category: slackAlertEntry.category,
        env: slackAlertEntry.env,
        slackError: sendError.message,
        errorCode: ERROR_CODES.SLACK_FAIL,
      };
      // Persist the fallback alert entry to disk
      await Logger._writeFallbackLogEntry(
        Logger._getFallbackSlackDir(),
        fallbackRelative,
        Logger._serializeLogEntry(fallbackSlackEntry),
        { stage: "slack-fallback" },
      );
      // Schedule a retry for the original Slack alert when appropriate
      Logger._scheduleSlackRetry(slackAlertEntry);
      // Extend the fallback cooldown window
      Logger._SLACK_FALLBACK_COOLDOWN_UNTIL = Date.now() + SLACK_FALLBACK_COOLDOWN_MS;
    }
    // Always run cleanup logic to clear the timeout
    finally {
      // Remove the scheduled timeout to avoid leaks
      clearTimeout(slackTimeoutId);
    }
  }
  /**
   * Persist the provided payload to storage.
   *
   * Write the payload to the configured log root, with fallbacks on failure.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#writeToStorage #TODO
   * @param {string} resourceRelativePath - relative path within the log root
   * @param {Object|string} entryOrPayload - payload to serialize and persist
   * @returns {Promise<void>} completes when the entry is written
   */
  static async writeToStorage(resourceRelativePath, entryOrPayload) {
    // Capture the environment name for metadata
    const { ENVIRONMENT: environmentName } = Logger.ENV;
    // Resolve the full resource path within the log root
    const resolvedStoragePath = await Logger._resolvePathWithinRoot(Logger.LOG_ROOT, resourceRelativePath);
    // Extract the safe relative path from the resolved result
    const safeRelativePath = resolvedStoragePath.relative;
    // Extract the full destination path
    const destinationFullPath = resolvedStoragePath.full;
    // Extract the destination directory for creation
    const destinationDir = resolvedStoragePath.dir;
    // Validate that the payload can be serialized
    Logger._validateLogPayload(entryOrPayload);
    // Serialize the payload into a string
    const serializedPayload =
      // Use the string directly when already serialized
      typeof entryOrPayload === "string"
        // Return the string value as-is
        ? entryOrPayload
        // Serialize the object payload into JSON
        : Logger._serializeLogEntry(entryOrPayload);
    // Attempt the primary write
    try {
      // Ensure the destination directory already exists
      await Logger._ensureDirExists(destinationDir, { stage: "primary-write" });
      // Append the entry to the log file with retry semantics
      await Logger._writeFileWithRetry(destinationFullPath, `${serializedPayload}\n`);
    }
    // Handle write failures with a fallback path
    catch (err) {
      // Allow permission-denied errors to propagate
      if (Logger._isPermissionError(err)) {
        // Surface the permission error without masking it
        throw err;
      }
      // Build the fallback root for write failures
      const fallbackRoot = path.join(Logger._getFallbackLogRoot(), "write_errors");
      // Compose the fallback path for this failure
      const fallback = path.join(fallbackRoot, safeRelativePath);
      // Attempt to record the failure in the fallback directory
      try {
        // Ensure the fallback directory exists
        await Logger._ensureDirExists(path.dirname(fallback), { stage: "fallback-write" });
        // Create a structured fallback entry for diagnostics
        const fallbackEntry = {
          // Timestamp when the fallback entry was created
          timestamp: DateTime.now(DATE_FORMAT_TIMESTAMP),
          // Capture the error message that triggered the fallback
          error: err.message,
          // Include the original destination path for reference
          attemptedPath: destinationFullPath,
          // Preserve the environment name for auditing
          env: environmentName,
          // Tag the entry with a standardized error code
          errorCode: ERROR_CODES.WRITE_FAIL,
        };
        // Append a timestamp to the fallback filename
        const fallbackWithTimestamp = Logger._appendTimestampToPath(fallback);
        // Write the serialized fallback entry with retry protection
        await Logger._writeFileWithRetry(
          // Provide the fallback path enriched with a timestamp
          fallbackWithTimestamp,
          // Serialize the fallback entry plus newline termination
          `${Logger._serializeLogEntry(fallbackEntry)}\n`,
        );
      }
      // Handle errors that occur while writing the fallback
      catch (fallbackErr) {
        // Ignore permission errors for fallback writes
        if (Logger._isPermissionError(fallbackErr)) {
          // Abort when fallback cannot create directories due to permissions
          return;
        }
        // Propagate other fallback errors
        throw fallbackErr;
      }
    }
  }


  /**
   * Determine effective critical flag.
   *
   * Prefer an explicit override before falling back to route defaults.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_resolveCriticalFlag #TODO
   * @param {boolean} explicitCriticalFlag - user-specified critical override
   * @param {boolean} routeCriticalFlag - default critical flag from route definition
   * @returns {boolean} resolved critical flag
   */
  static _resolveCriticalFlag(explicitCriticalFlag, routeCriticalFlag) {
    // Return explicitly provided critical flag when boolean
    if (typeof explicitCriticalFlag === "boolean") {
      // Honor explicit critical flag
      return explicitCriticalFlag;
    }
    // Fallback to route-defined critical flag
    return !!routeCriticalFlag;
  }



  /**
   * Check if a path lives within a given root.
   *
   Resolve both inputs and verify the candidate stays within the base path.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_isPathWithinRoot #TODO
   * @param {string} rootBasePath - directory we expect the path to remain inside
   * @param {string} pathToCheck - candidate path to verify
   * @returns {Promise<boolean>} true when the candidate is inside the base
   */
  static async _isPathWithinRoot(rootBasePath, pathToCheck) {
    // Resolve the base path to an absolute normalized value
    const resolvedRootBase = await Logger._resolveRootPath(rootBasePath);
    // Resolve the candidate path similarly
    const resolvedCandidatePath = await Logger._resolveRootPath(pathToCheck);
    // Return false when either resolution fails
    if (!resolvedRootBase || !resolvedCandidatePath) {
      // Path cannot be validated without resolved roots
      return false;
    }
    // Ensure the base path ends with a separator for clean prefix checks
    const rootBaseWithSep = resolvedRootBase.endsWith(path.sep)
      ? // Reuse the existing string when it already ends with separator
        resolvedRootBase
      : // Append separator otherwise
        `${resolvedRootBase}${path.sep}`;
    // Confirm the candidate equals the base or begins with the base prefix
    return resolvedCandidatePath === resolvedRootBase || resolvedCandidatePath.startsWith(rootBaseWithSep);
  }
  /**
   * Resolve a relative path safely within a root directory.
   *
   * Validate traversal constraints, cache the result, and return path metadata.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_resolvePathWithinRoot #TODO
   * @param {string} rootPath - base directory root for resolution
   * @param {string} relativePath - candidate relative path
   * @returns {Promise<Object>} object containing full, dir, and relative paths
   */
  static async _resolvePathWithinRoot(rootPath, relativePath) {
    // Normalize the caller-provided relative path safely
    const safeRelativePath = Logger.ensureRelativeLogPath(relativePath);
    // Construct a cache key that pairs root and relative path
    const cacheKey = `${rootPath}::${safeRelativePath}`;
    // Check for a cached resolution before recomputing
    const cachedResolution = Logger._PATH_CACHE.get(cacheKey);
    // Return cached data when available to save work
    if (cachedResolution) {
      // Reuse previously computed resolution
      return cachedResolution;
    }
    // Resolve the root path to an absolute location
    const resolvedRootPath = await Logger._resolveRootPath(rootPath);
    // Combine the resolved root with the safe relative segment
    const absoluteFullPath = path.resolve(resolvedRootPath, safeRelativePath);
    // Ensure the base path ends with a separator for comparisons
    const rootWithSeparator = resolvedRootPath.endsWith(path.sep)
      // Keep existing string when separator already present
      ? resolvedRootPath
      // Append separator otherwise
      : `${resolvedRootPath}${path.sep}`;
    // Guard against traversal by verifying the candidate starts with the base
    if (!absoluteFullPath.startsWith(rootWithSeparator)) {
      // Log the blocked traversal attempt for auditing
      ErrorHandler.addError("Blocked path traversal attempt.", {
        origin: "Logger",
        path: absoluteFullPath,
      });
      // Reject the path resolution attempt
      throw new Error("Blocked path traversal attempt.");
    }
    // Assemble the resolution object for consumption
    const resolution = {
      // Provide the full absolute file path
      full: absoluteFullPath,
      // Provide the directory portion for directory creation
      dir: path.dirname(absoluteFullPath),
      // Provide the normalized relative path for reference
      relative: safeRelativePath,
    };
    // Cache the resolution for future lookups
    Logger._PATH_CACHE.set(cacheKey, resolution);
    // Trim caches if we are over the soft limit
    Logger._trimAllCachesIfNeeded();
    // Return the resolved file metadata
    return resolution;
  }



  
  /**
   * Configure the handler used for local mode warnings.
   *
   * Allow callers to override the default local warning behavior.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#setLocalWarningHandler #TODO
   * @param {Function} handler - warning handler function
   * @returns {void} nothing
   */
  static setLocalWarningHandler(handler) {
    // Ignore non-function handlers
    if (typeof handler !== "function") {
      // Skip assignment when handler is invalid
      return;
    }
    // Store the handler for future warnings
    Logger._LOCAL_WARNING_HANDLER = handler;
  }

  /**
   * Default handler for logging when running locally.
   *
   * Emit a debug log informing that local filesystem writes occur.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_localWarningDefaultHandler #TODO
   * @returns {void} nothing
   */
  static _localWarningDefaultHandler() {
    // Inform about local mode logging in debug output
    Logger.debugLog("info", "[Logger] Local mode: logs written to local filesystem");
  }

  /**
   * Trigger local-mode warning when appropriate.
   *
   * Emit the configured handler once when running locally.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_warnIfLocalMode #TODO
   * @returns {void} nothing
   */
  static _warnIfLocalMode() {
    // Skip warnings when not in local mode or already shown
    if (!Logger.IS_LOCAL || Logger._LOCAL_WARNING_SHOWN) {
      // Return immediately when warning was already emitted
      return;
    }
    // Mark the warning as shown to prevent duplicates
    Logger._LOCAL_WARNING_SHOWN = true;
    // Determine which handler to run for this warning
    const handler = Logger._LOCAL_WARNING_HANDLER || Logger._localWarningDefaultHandler;
    // Invoke the resolved handler
    handler();
  }


  /**
   * Normalize and validate a relative log path.
   *
   * Enforce safety rules around traversal, null bytes, and absolute paths.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#ensureRelativeLogPath #TODO
   * @param {string} relPath - requested relative path
   * @returns {string} trimmed safe relative path
   */
  static ensureRelativeLogPath(relPath) {
    // Convert the input into a normalized string candidate
    const relativePathCandidate = typeof relPath === "string" ? relPath : String(relPath ?? "");
    // Guard against empty paths after trimming whitespace
    if (!relativePathCandidate.trim()) {
      // Record the error for empty paths
      ErrorHandler.addError("Log path cannot be empty", {
        // Identify Logger as the error origin
        origin: "Logger",
        // Include the offending path value
        relPath: relativePathCandidate,
      });
      // Throw an error to reject the invalid path
      throw new Error("Log path cannot be empty");
    }
    // Detect null byte usage in the path candidate
    if (relativePathCandidate.includes("\x00")) {
      // Log the presence of null bytes
      ErrorHandler.addError("Null bytes are not allowed in paths", {
        origin: "Logger",
        relPath: relativePathCandidate,
      });
      // Reject the candidate containing null bytes
      throw new Error("Null bytes are not allowed in paths");
    }
    // Resolve the project root for relative comparisons
    const projectRoot = path.resolve(process.cwd());
    // Normalize the candidate path to eliminate redundant segments
    const normalizedPath = path.normalize(relativePathCandidate);
    // Prevent absolute paths from being accepted
    if (path.isAbsolute(normalizedPath)) {
      // Report that absolute paths are disallowed
      ErrorHandler.addError("Absolute paths are not allowed", {
        origin: "Logger",
        relPath: normalizedPath,
      });
      // Reject the absolute path request
      throw new Error("Absolute paths are not allowed");
    }
    // Resolve paths relative to the project root to check boundaries
    const resolvedAbsolutePath = path.resolve(projectRoot, normalizedPath);
    // Capture the relative path from the root for traversal checks
    const relativePathFromRoot = path.relative(projectRoot, resolvedAbsolutePath);
    // Identify parent traversal attempts prior to additional validation
    if (
      relativePathFromRoot.startsWith("..") ||
      path.isAbsolute(relativePathFromRoot) ||
      /[/\\]\.\.[/\\]/.test(relativePathFromRoot) ||
      /[/\\]\.\.[/\\]/.test(relativePathCandidate) ||
      relativePathCandidate.startsWith("..") ||
      normalizedPath.startsWith("..")
    ) {
      // Log the detected traversal attempt
      ErrorHandler.addError("Parent traversal not allowed", {
        origin: "Logger",
        relPath: normalizedPath,
        resolved: relativePathFromRoot,
      });
      // Reject traversal attempts explicitly
      throw new Error("Parent traversal not allowed");
    }
    // Split the original candidate to detect dot-only segments
    const segmentsBeforeNormalize = relativePathCandidate.split(/[\\/]+/).filter(Boolean);
    // Enforce prohibition of dot-only segments (excluding "..")
    if (segmentsBeforeNormalize.some((segment) => /^\.+$/.test(segment) && segment !== "..")) {
      // Report dot-only segment violations before normalization
      ErrorHandler.addError("Dot-only path segments are not allowed", {
        origin: "Logger",
        relPath: relativePathCandidate,
      });
      // Reject the path due to dot-only segments
      throw new Error("Dot-only path segments are not allowed");
    }
    // Trim leading separators from the normalized path
    const trimmed = relativePathFromRoot.replace(/^[/\\]+/, "");
    // Split the trimmed path to inspect each segment
    const segments = trimmed.split(/[\\/]+/).filter(Boolean);
    // Ensure no remaining segments consist solely of dots
    if (segments.some((segment) => /^\.+$/.test(segment))) {
      // Record that a dot-only segment remained after trimming
      ErrorHandler.addError("Dot-only path segments are not allowed", {
        origin: "Logger",
        relPath: trimmed,
      });
      // Reject the path for containing unsafe segments
      throw new Error("Dot-only path segments are not allowed");
    }
    // Return the cleaned relative path
    return trimmed;
  }
  /**
   * Build fallback path from a templated route.
   *
   * Replace placeholders with sanitized keys and normalize the result.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_fallbackPathFromPattern #TODO
   * @param {string} template - path template containing placeholders
   * @returns {string} normalized fallback path
   */
  static _fallbackPathFromPattern(template) {
    // Validate that the provided template is a non-empty string
    if (typeof template !== "string" || !template.trim()) {
      // Return a default filename when the template is missing
      return "unknown.log";
    }
    // Instantiate a fresh regex for placeholder substitution
    const placeholderRegex = new RegExp(PLACEHOLDER_REGEX_PATTERN.source, "g");
    // Replace each placeholder token with its sanitized value
    const substitutedTemplate = template.replace(placeholderRegex, (match, token) => {
      // Parse the placeholder token for validation
      const parsedToken = Logger._parsePlaceholderToken(token);
      // Use the parsed key when valid otherwise fallback to "missing"
      return parsedToken.valid && parsedToken.key ? parsedToken.key : "missing";
    });
    // Normalize the substituted path and convert backslashes to slashes
    const normalizedFallback = path.normalize(substitutedTemplate).replace(/\\/g, "/");
    // Return the normalized fallback path
    return normalizedFallback;
  }
  /**
   * Normalize log path into a critical log filename.
   *
   * Ensure the path ends with `.critical.log` while honoring existing formats.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_toCriticalLogPath #TODO
   * @param {string} logRelativePath - base relative log path
   * @returns {string} critical log filename
   */
  static _toCriticalLogPath(logRelativePath) {
    // Return default when the provided path is invalid
    if (typeof logRelativePath !== "string" || !logRelativePath.trim()) {
      // Use the default critical filename
      return "critical.log";
    }
    // Preserve existing critical log path when already formatted
    if (logRelativePath.endsWith(".critical.log")) {
      // Return the original critical path
      return logRelativePath;
    }
    // Convert .log suffixes to .critical.log
    if (logRelativePath.endsWith(".log")) {
      // Replace the .log suffix with .critical.log
      return `${logRelativePath.slice(0, -4)}.critical.log`;
    }
    // Append the critical suffix when missing entirely
    return `${logRelativePath}.critical.log`;
  }
  /**
   * Sanitize a path segment for safe use.
   *
   * Trim, replace unsafe chars, and enforce length constraints.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_sanitizePathSegment #TODO
   * @param {string} segmentCandidate - raw segment value
   * @returns {string} cleaned segment or empty string
   */
  static _sanitizePathSegment(segmentCandidate) {
    // Return empty string when the candidate is missing or invalid
    if (typeof segmentCandidate !== "string" || !segmentCandidate) {
      // Provide an empty default for invalid segments
      return "";
    }
    // Apply trimming and unsafe character replacement
    let cleanedSegment = segmentCandidate
      .trim()
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^[._-]+/, "")
      .replace(/[.-]+$/, "");
    // Collapse repeated dots into single dots
    cleanedSegment = cleanedSegment.replace(/\.{2,}/g, ".");
    // Remove a leading dot when present
    if (cleanedSegment.startsWith(".")) {
      // Drop the leading dot for safety
      cleanedSegment = cleanedSegment.substring(1);
    }
    // Enforce the maximum allowed segment length
    if (cleanedSegment.length > PATH_SEGMENT_MAX_LEN) {
      // Truncate to the maximum configured length
      cleanedSegment = cleanedSegment.slice(0, PATH_SEGMENT_MAX_LEN);
    }
    // Return the cleaned segment or empty string when nothing remains
    return cleanedSegment || "";
  }
  /**
   * Resolve placeholders inside a path template.
   *
   * Replace path placeholders with sanitized values while caching results.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_resolvePathPattern #TODO
   * @param {string} pathTemplate - template containing placeholders
   * @param {Object} pathData - values to substitute for placeholders
   * @returns {{ path: string|null, missing: string[] }} resolved path metadata
   */
  static _resolvePathPattern(pathTemplate, pathData) {
    // Normalize the path data for deterministic matching
    const normalizedPathData = Logger._normalizePathData(pathData);
    // Serialize the normalized data for cache key generation
    const serialized = Logger._serializePathCacheKey(normalizedPathData);
    // Hash cache keys to prevent cache poisoning
    const cacheKeyHash = crypto.createHash("sha256").update(`${pathTemplate}::${serialized}`).digest("hex").slice(0, 32);
    // Combine template and hashed data to form the cache key
    const cacheKey = `${pathTemplate}::${cacheKeyHash}`;
    // Return cached resolution when available
    if (Logger._RESOLVE_CACHE.has(cacheKey)) {
      return Logger._RESOLVE_CACHE.get(cacheKey);
    }
    // Debug log when the cache misses
    Logger.debugLog?.("[Logger] Resolve cache miss", { template: pathTemplate });
    // Guard against absurdly long templates to avoid ReDoS
    if (pathTemplate.length > 10000) {
      // Surface an explicit error when the template is too long
      throw new Error("Logger: template path too long");
    }
    // Create a fresh placeholder regex to avoid shared state issues
    const placeholderRegex = new RegExp(PLACEHOLDER_REGEX_PATTERN.source, "g");
    // Extract all placeholder tokens from the template
    const placeholders = Array.from(pathTemplate.matchAll(placeholderRegex)).map((m) => m[1]);
    // Collect missing placeholders as we resolve the template
    const missingPlaceholders = [];
    // Start with the template as the base resolved string
    let resolvedTemplate = pathTemplate;
    // Iterate through each placeholder token
    for (const placeholder of placeholders) {
      // Limit how many missing placeholders are tracked
      if (missingPlaceholders.length >= MAX_MISSING_PLACEHOLDERS) {
        break;
      }
      // Parse the placeholder token into key and format parts
      const parsedToken = Logger._parsePlaceholderToken(placeholder);
      // Handle invalid tokens explicitly
      if (!parsedToken.valid) {
        // Log invalid token details for diagnostics
        ErrorHandler.addError("Logger: invalid placeholder token", {
          origin: "Logger",
          placeholder,
        });
        // Track the invalid placeholder name for the caller
        missingPlaceholders.push(parsedToken.key || placeholder);
        continue;
      }
      // Match the placeholder key case-insensitively against provided data
      const matchedKey = Logger._findMatchingKeyInsensitive(normalizedPathData, parsedToken.key);
      // Track missing placeholders when no match is found
      if (!matchedKey) {
        // Record the missing key for reporting
        missingPlaceholders.push(parsedToken.key);
        continue;
      }
      // Retrieve the value associated with the matched key
      let value = normalizedPathData[matchedKey];
      // Apply formatting when specified in the placeholder
      if (parsedToken.format) {
        // Format dates or other values safely
        value = Logger._safeFormatDate(value, parsedToken.format, {
          placeholder: parsedToken.key,
          template: pathTemplate,
          fallback: ISO_FALLBACK_TIMESTAMP,
        });
      }
      // Sanitize the value before substituting into the path
      const sanitizedValue = Logger._sanitizePathSegment(value);
      // Build the full placeholder string including braces
      const placeholderWithBraces = `{${placeholder}}`;
      // Replace all instances of the placeholder with the sanitized value
      resolvedTemplate = resolvedTemplate.split(placeholderWithBraces).join(sanitizedValue);
    }
    // Normalize the resolved template when no placeholders are missing
    const resolvedPath = missingPlaceholders.length ? null : path.normalize(resolvedTemplate);
    // Prepare the metadata result for the caller
    const result = { path: resolvedPath, missing: missingPlaceholders };
    // Cache successful resolutions for reuse
    if (!missingPlaceholders.length) {
      // Use the same hashed cache key for both lookup and set
      Logger._RESOLVE_CACHE.set(cacheKey, result);
      // Trim caches to maintain reasonable memory usage
      Logger._trimAllCachesIfNeeded();
    }
    // Return the resolved metadata structure
    return result;
  }
  /**
   * Prepare route data for placeholder resolution.
   *
   Normalize provided data and merge in the optional action.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_preparePathData #TODO
   * @param {Object} routeDataCandidate - raw route data
   * @param {string} actionValue - optional action string
   * @returns {Object} normalized data map
   */
  static _preparePathData(routeDataCandidate, actionValue) {
    // Normalize the provided route data for placeholder matching
    const normalizedRouteData = Logger._normalizePathData(routeDataCandidate);
    // Merge the action into normalized data when provided
    if (typeof actionValue === "string" && actionValue.trim()) {
      // Store the trimmed action value
      normalizedRouteData.action = actionValue.trim();
    }
    // Return the data prepared for path resolution
    return normalizedRouteData;
  }
  /**
   * Normalize placeholder data by filtering allowed keys.
   *
   * Reject invalid keys and return a cleaned object for template resolution.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_normalizePathData #TODO
   * @param {Object} dataCandidate - incoming placeholder data
   * @returns {Object} normalized placeholder map
   */
  static _normalizePathData(dataCandidate) {
    // Start with a clean map without prototype pollution
    const normalizedResult = Object.create(null);
    // Return the empty map when input is not an object
    if (!dataCandidate || typeof dataCandidate !== "object") {
      // Provide the normalized result immediately
      return normalizedResult;
    }
    // Iterate through each key-value pair provided
    for (const [key, value] of Object.entries(dataCandidate)) {
      // Skip keys that are not permitted placeholders
      if (!Logger._isAllowedPlaceholder(key)) {
        // Log the invalid placeholder key for diagnostics
        ErrorHandler.addError("Logger: invalid placeholder key in data", {
          origin: "Logger",
          key,
        });
        // Continue to the next entry without storing this key
        continue;
      }
      // Store the validated key-value pair
      normalizedResult[key] = value;
    }
    // Return the normalized data map
    return normalizedResult;
  }
  /**
   * Serialize normalized path data for cache keys.
   *
   * Sort entries, stringify values, and hash when the key is too long.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_serializePathCacheKey #TODO
   * @param {Object} normalizedPathData - sanitized placeholder data
   * @returns {string} serialized or hashed cache key
   */
  static _serializePathCacheKey(normalizedPathData) {
    // Order the keys deterministically before serialization
    const entries = Object.keys(normalizedPathData)
      .sort()
      .map((key) => [key, Logger._stringifyCacheValue(normalizedPathData[key])]);
    // Convert the ordered entries into JSON
    const serialized = JSON.stringify(entries);
    // Hash the serialized data when it exceeds the maximum key size
    if (serialized.length > MAX_CACHE_KEY_SIZE) {
      // Return a digest shortened to 32 hex characters
      return crypto.createHash("sha256").update(serialized).digest("hex").slice(0, 32);
    }
    // Return the JSON string when within the size budget
    return serialized;
  }
  /**
   * Serialize a cache value for consistent keys.
   *
   * Return empty strings for nullish data and stable-stringify objects.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_stringifyCacheValue #TODO
   * @param {*} cacheValue - value to convert to string
   * @returns {string} stringified representation
   */
  static _stringifyCacheValue(cacheValue) {
    // Represent null or undefined as empty string
    if (cacheValue === null || cacheValue === undefined) {
      // Return the empty default for nullish values
      return "";
    }
    // Use stable stringify for object values
    if (typeof cacheValue === "object") {
      try {
        // Convert objects via stable JSON to keep deterministic ordering
        return Logger._stableStringify(cacheValue);
      } catch {
        // Fall back to default string conversion when serialization fails
        return String(cacheValue);
      }
    }
    // Return primitive values via String()
    return String(cacheValue);
  }

  /**
   * Produce a deterministic JSON string for complex values.
   *
   Sort object keys and recursively stringify arrays/objects.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_stableStringify #TODO
   * @param {*} targetValue - value to stringify
   * @returns {string} deterministic serialization
   */
  static _stableStringify(targetValue) {
    // Represent null explicitly
    if (targetValue === null) {
      return "null";
    }
    // Handle arrays by serializing each entry
    if (Array.isArray(targetValue)) {
      // Map each item through stable stringify and join with commas
      return `[${targetValue.map((item) => Logger._stableStringify(item)).join(",")}]`;
    }
    // Handle objects by sorting keys for deterministic output
    if (typeof targetValue === "object") {
      // Gather sorted entries for consistent ordering
      const entries = Object.keys(targetValue)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${Logger._stableStringify(targetValue[key])}`,
        );
      // Return the assembled object string
      return `{${entries.join(",")}}`;
    }
    // Fall back to JSON.stringify for primitives
    return JSON.stringify(targetValue);
  }
  /**
   * Normalize log entry values for serialization.
   *
   * Convert undefined or NaN values to null for JSON safety.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_sanitizeLogEntryValue #TODO
   * @param {string} logKey - entry key being sanitized
   * @param {*} logValue - value to normalize
   * @returns {*} sanitized value or null
   */
  static _sanitizeLogEntryValue(logKey, logValue) {
    // Treat undefined values as null for serialization
    if (logValue === undefined) {
      // Return null for undefined values
      return null;
    }
    // Convert NaN numbers into null
    if (typeof logValue === "number" && Number.isNaN(logValue)) {
      // Use null to represent NaN safely
      return null;
    }
    // Return the original value when already safe
    return logValue;
  }
  /**
   * Serialize a log entry payload safely.
   *
   * Support raw strings, pretty-print toggles, and circular-safe serialization.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_serializeLogEntry #TODO
   * @param {Object|string} logEntryPayload - payload to serialize
   * @returns {string} serialized log entry
   */
  static _serializeLogEntry(logEntryPayload) {
    // Return string payloads as-is to avoid re-serialization
    if (typeof logEntryPayload === "string") {
      // Pass through the string when already serialized
      return logEntryPayload;
    }
    // Determine whether pretty-printing is enabled
    const prettyPrint = Logger.ENV.LOG_PRETTY_PRINT === true || Logger.ENV.LOG_PRETTY_PRINT === "1" || Logger.ENV.LOG_PRETTY_PRINT === 1;
    // Attempt JSON serialization while guarding against circular structures
    try {
      // Use the sanitizer to clean each value; indent when prettyPrint is true
      return JSON.stringify(logEntryPayload, Logger._sanitizeLogEntryValue, prettyPrint ? 2 : undefined);
    } catch (err) {
      // Delegate to a safer stringify utility on failure
      return Logger._safeStringifyLogEntry(logEntryPayload, prettyPrint);
    }
  }
  
  /**
   * Safe stringify with circular reference handling.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_safeStringifyLogEntry #TODO
   * @param {object} logEntryData - Log entry to stringify
   * @param {boolean} shouldPrettyPrint - Whether to pretty print
   * @returns {string} stringified entry
   */
  static _safeStringifyLogEntry(logEntryData, shouldPrettyPrint = false) {
    // Track visited objects to detect circular references
    const visitedEntries = new WeakSet();
    // Define a replacer that handles cycles and sanitization
    function replacer(key, value) {
      // Inspect object values to detect cycles
      if (typeof value === "object" && value !== null) {
        // Return placeholder when encountering revisited objects
        if (visitedEntries.has(value)) {
          return "[circular reference]";
        }
        // Mark this object as visited for future calls
        visitedEntries.add(value);
      }
      // Sanitize the current value before stringifying
      return Logger._sanitizeLogEntryValue(key, value);
    }
    // Attempt serialization using the specialized replacer
    try {
      // Apply pretty-print indentation when requested
      return JSON.stringify(logEntryData, replacer, shouldPrettyPrint ? 2 : undefined);
    }
    // Fall back to a generic error object when serialization fails
    catch {
      // Provide diagnostic payload when serialization cannot complete
      return JSON.stringify({ error: "Failed to serialize log entry", flag: logEntryData?.flag || "unknown" });
    }
  }

  /**
   * Detect whether a value is a log entry object.
   *
   * Ensure required log entry fields exist on the object.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_isLogEntryObject #TODO
   * @param {*} value - candidate to inspect
   * @returns {boolean} true when the object matches log entry shape
   */
  static _isLogEntryObject(value) {
    // Confirm value exists and is an object
    return (
      value &&
      typeof value === "object" &&
      // Check for schemaVersion string property
      typeof value.schemaVersion === "string" &&
      // Check for timestamp string property
      typeof value.timestamp === "string" &&
      // Check for flag string property
      typeof value.flag === "string"
    );
  }

  /**
   * Validate payloads before writing to storage.
   *
   * Accept strings with content or properly shaped log entry objects.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_validateLogPayload #TODO
   * @param {*} payload - candidate data for storage
   * @returns {boolean} true when the payload is valid
   */
  static _validateLogPayload(payload) {
    // Handle string payloads by ensuring they are not empty
    if (typeof payload === "string") {
      // Reject strings that are only whitespace
      if (!payload.trim()) {
        // Log the empty string payload error
        ErrorHandler.addError("Logger.writeToStorage received empty string payload", {
          origin: "Logger",
        });
        // Throw to indicate invalid payload
        throw new Error("Logger.writeToStorage received empty payload");
      }
      // Accept non-empty strings
      return true;
    }
    // Accept structured log entry objects
    if (Logger._isLogEntryObject(payload)) {
      // Return true when the payload shapes like a log entry
      return true;
    }
    // Record the invalid payload scenario for auditing
    ErrorHandler.addError("Logger.writeToStorage received invalid payload", {
      origin: "Logger",
      payload,
    });
    // Throw an error to reject the invalid payload
    throw new Error("Logger.writeToStorage received invalid payload");
  }
  /**
   * Validate placeholder keys for safety.
   *
   * Allow only non-reserved alphanumeric keys with underscores.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_isAllowedPlaceholder #TODO
   * @param {string} key - placeholder key to validate
   * @returns {boolean} true when the key is acceptable
   */
  static _isAllowedPlaceholder(key) {
    // Reject missing or non-string keys
    if (!key || typeof key !== "string") {
      // Return false for invalid types
      return false;
    }
    // Reject reserved keys to avoid prototype pollution
    if (RESERVED_PLACEHOLDER_KEYS.has(key)) {
      // Explicitly deny reserved keys
      return false;
    }
    // Match the key against allowed characters
    return SAFE_PLACEHOLDER_KEY_PATTERN.test(key);
  }
  /**
   * Normalize date format strings used in placeholders.
   *
   Map known aliases to internal constants while trimming whitespace.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_normalizePathDateFormat #TODO
   * @param {*} value - format string candidate
   * @returns {*} normalized format or original value
   */
  static _normalizePathDateFormat(value) {
    // Leave non-string formats untouched
    if (typeof value !== "string") {
      // Return the original non-string value
      return value;
    }
    // Trim whitespace from the format string
    const trimmed = value.trim();
    // Return early when the trimmed value is empty
    if (!trimmed) {
      // Provide the empty string result
      return trimmed;
    }
    // Normalize known alias YYYY-MM-DD to internal constant
    if (trimmed === "YYYY-MM-DD") {
      // Return the defined day format constant
      return DATE_FORMAT_DAY;
    }
    // Normalize another common alias
    if (trimmed === "DD-MM-YYYY") {
      // Return the corresponding lowercase format
      return "dd-MM-yyyy";
    }
    // Return the trimmed value when no alias matches
    return trimmed;
  }
  /**
   * Parse a placeholder token into key and format.
   *
   * Validate the token structure and normalize date formats.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_parsePlaceholderToken #TODO
   * @param {string} token - raw placeholder token
   * @returns {{ valid: boolean, key: string, format: string }} parsed result
   */
  static _parsePlaceholderToken(token) {
    // Trim whitespace from the token string
    const trimmed = typeof token === "string" ? token.trim() : "";
    // Reject empty tokens immediately
    if (!trimmed) {
      // Return invalid placeholder structure
      return { valid: false, key: "", format: "" };
    }
    // Match the token against the placeholder pattern
    const match = PLACEHOLDER_TOKEN_PATTERN.exec(trimmed);
    // Handle tokens that fail to match the expected format
    if (!match) {
      // Return invalid structure with trimmed key
      return { valid: false, key: trimmed, format: "" };
    }
    // Extract the placeholder key from the match
    const key = match[1];
    // Normalize the optional date format component
    const format = match[2] ? Logger._normalizePathDateFormat(match[2]) : "";
    // Reject keys that are not allowed placeholders
    if (!Logger._isAllowedPlaceholder(key)) {
      // Return invalid status with captured key
      return { valid: false, key, format };
    }
    // Return the parsed, valid placeholder metadata
    return { valid: true, key, format };
  }
  /**
   * Find a matching key ignoring case.
   *
   * Cache lowercase mappings to minimize repeated work.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_findMatchingKeyInsensitive #TODO
   * @param {Object} data - placeholder data map
   * @param {string} targetKey - key to locate
   * @returns {string|undefined} canonical key when found
   */
  static _findMatchingKeyInsensitive(data, targetKey) {
    // Normalize the target key to lowercase
    const normalizedTarget = targetKey.toLowerCase();
    // Build a lowercase index on first use
    if (!Logger._CACHE_KEY_LOWER_MAP.has(data)) {
      // Construct the map of lowercase keys to originals
      const lowerMap = new Map();
      for (const key of Object.keys(data)) {
        // Map the lowercase version to its original casing
        lowerMap.set(key.toLowerCase(), key);
      }
      // Cache the mapping for future lookups
      Logger._CACHE_KEY_LOWER_MAP.set(data, lowerMap);
    }
    // Retrieve the cached lowercase map for this data object
    const lowerMap = Logger._CACHE_KEY_LOWER_MAP.get(data);
    // Return the matching key when available
    return lowerMap.get(normalizedTarget);
  }
  /**
   * Safely format dates for placeholders.
   *
   * Return fallback values when formatting produces nothing.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_safeFormatDate #TODO
   * @param {*} value - value to format as date
   * @param {string} format - desired date format
   * @param {Object} context - additional metadata for errors
   * @returns {string|null} formatted string or fallback
   */
  static _safeFormatDate(value, format, context = {}) {
    // Extract fallback and other context details
    const { fallback = null, ...contextDetails } = context;
    // Attempt to format the value via DateTime helper
    const formatted = DateTime.formatDate(String(value), format);
    // Report and return fallback when formatting yields nothing
    if (!formatted) {
      // Log the fallback usage for diagnostics
      ErrorHandler.addError("Date formatting returned fallback value", {
        origin: "Logger",
        ...contextDetails,
        fallback,
      });
      // Return the fallback when formatting failed
      return fallback;
    }
    // Return the formatted string when available
    return formatted;
  }
  /**
   * Generate a descriptor for missing placeholders.
   *
   Sanitize missing keys and combine them into a suffix.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_describeMissingPlaceholders #TODO
   * @param {string[]} missing - placeholder keys that were not provided
   * @returns {string} descriptor string for missing placeholders
   */
  static _describeMissingPlaceholders(missing = []) {
    // Return empty string when no missing placeholders exist
    if (!Array.isArray(missing) || missing.length === 0) {
      // Provide empty descriptor when nothing is missing
      return "";
    }
    // Sanitize each missing placeholder segment
    const sanitized = missing.map(Logger._sanitizePathSegment).filter(Boolean);
    // Return combined descriptor when sanitized segments remain
    return sanitized.length ? `_missing_${sanitized.join("_")}` : "";
  }
  /**
   * Retrieve route metadata for a given flag.
   *
   * Use cached definitions when available, otherwise resolve from config with fallback.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#getRouteByFlag #TODO
   * @param {string} flag - log flag identifier
   * @returns {Object} route metadata including path and retention
   */
  static getRouteByFlag(flag) {
    // Normalize the incoming flag string
    const rawFlag = typeof flag === "string" ? flag : String(flag || "");
    // Trim whitespace before normalization
    const normalizedFlag = rawFlag.trim();
    // Use lowercase version as cache key for faster lookups
    const cacheKey = normalizedFlag.toLowerCase();
    // Return cached route when available
    if (Logger._ROUTE_CACHE.has(cacheKey)) {
      // Reuse cached metadata for the flag
      return Logger._ROUTE_CACHE.get(cacheKey);
    }
    // Log cache misses for debugging purposes
    Logger.debugLog?.("debug", `[Logger] Route cache miss for flag: ${normalizedFlag}`);
    // Search log definitions in configured categories
    try {
      for (const category of Object.values(Logger.LOG_CONFIG)) {
        // Skip categories missing logs arrays
        if (!category?.logs) {
          // Continue to next category
          continue;
        }
        // Compose metadata shared across logs in this category
        const meta = {
          retention: category.retention,
          category: category.category,
          description: category.description,
          encryption: category.encryption,
        };
        // Look for a log entry matching the normalized flag
        const found = category.logs.find(
          (log) => String(log.flag || "").toLowerCase() === cacheKey,
        );
        // When a matching log is found, assemble route metadata
        if (found) {
          const route = { ...meta, ...found };
          // Cache the resolved route metadata
          Logger._ROUTE_CACHE.set(cacheKey, route);
          // Trim caches after insertion to enforce limits
          Logger._trimAllCachesIfNeeded();
          // Return the resolved route metadata
          return route;
        }
      }
    }
    // Handle metadata parsing errors gracefully
    catch (err) {
      // Report the parsing failure for audit
      ErrorHandler.addError("Logger.getRouteByFlag failed to parse route metadata", {
        origin: "Logger",
        flag: rawFlag,
        error: err?.message || "unknown",
      });
    }
    // Compose fallback metadata when no route is found
    const safeFlag = Logger._sanitizePathSegment(normalizedFlag) || "missing_route";
    const fallbackDate = Logger._safeFormatDate(
      DateTime.now(),
      DATE_FORMAT_DAY,
      {
        placeholder: "missingRouteDate",
        fallback: ISO_FALLBACK_DATE,
      },
    );
    // Log the absence of a route definition
    Logger.debugLog?.("debug", `[Logger] Route not found for flag: ${normalizedFlag}`);
    // Build fallback metadata to prevent failures
    const fallback = {
      retention: "unknown",
      category: "unknown",
      description: "Missing route definition",
      path: path.join("missingLogRoutes", safeFlag, `${fallbackDate}.log`),
      PciCompliance: false,
      critical: false,
    };
    // Cache the fallback route metadata as well
    Logger._ROUTE_CACHE.set(cacheKey, fallback);
    // Enforce cache limits after storing fallback
    Logger._trimAllCachesIfNeeded();
    // Return the fallback route
    return fallback;
  }
  /**
   * Resolve a templated log path with provided data.
   *
   * Delegate to the internal resolver to compute the actual path.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#resolvePath #TODO
   * @param {string} template - template containing placeholders
   * @param {Object} data - values used for substitution
   * @returns {{ path: string|null, missing: string[] }} resolved path metadata
   */
  static resolvePath(template, data) {
    // Delegate to the internal resolver
    return Logger._resolvePathPattern(template, data);
  }
  /**
   * Append a timestamp (and random suffix) to a relative path.
   *
   * Ensure filenames avoid collisions by appending timestamp+random suffix.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_appendTimestampToPath #TODO
   * @param {string} relativePath - path to decorate
   * @param {string|null} timestamp - optional timestamp string
   * @returns {string} timestamped path
   */
  static _appendTimestampToPath(relativePath, timestamp = null) {
    // Determine which timestamp to use (argument or current time)
    const resolvedTimestamp =
      timestamp || DateTime.now(LOG_TIMESTAMP_FORMAT);
    // Normalize the incoming relative path string
    const normalizedPath = typeof relativePath === "string"
      ? path.normalize(relativePath)
      : "";
    // Extract the file extension if present
    const extension = path.extname(normalizedPath);
    // Remove the extension to build the base path
    const basePath = extension
      ? normalizedPath.slice(0, -extension.length)
      : normalizedPath;
    // Add random suffix to prevent timestamp collisions
    const collisionSuffix = crypto.randomBytes(TIMESTAMP_COLLISION_SUFFIX_BYTES).toString("hex");
    // Return the path with timestamp and collision suffix appended
    return `${basePath}_${resolvedTimestamp}_${collisionSuffix}${extension}`;
  }
  /**
   * Add a suffix before the file extension.
   *
   Preserve the extension while injecting the provided suffix.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_appendSuffixBeforeExtension #TODO
   * @param {string} relativePath - path to modify
   * @param {string} suffix - suffix to insert
   * @returns {string} path with suffix applied
   */
  static _appendSuffixBeforeExtension(relativePath, suffix) {
    // Validate inputs before proceeding
    if (typeof relativePath !== "string" || !relativePath.trim()) return relativePath;
    if (typeof suffix !== "string" || !suffix) return relativePath;
    // Extract the extension from the path
    const extension = path.extname(relativePath);
    // Remove extension to isolate the base path
    const basePath = extension
      ? relativePath.slice(0, -extension.length)
      : relativePath;
    // Return the base path with the suffix inserted before the extension
    return `${basePath}${suffix}${extension}`;
  }

  /**
   * Build a fallback relative path with timestamp and hash suffix.
   *
   * Combine the timestamped path with a randomized fallback suffix.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#_buildFallbackRelativePath #TODO
   * @param {string} baseRelativePath - base path for the fallback entry
   * @param {string|null} fileTimestamp - optional timestamp to use
   * @returns {string} fallback-relative path
   */
  static _buildFallbackRelativePath(baseRelativePath, fileTimestamp = null) {
    // Append timestamp (and random suffix) to the base path
    const timestampedPath = Logger._appendTimestampToPath(
      baseRelativePath,
      fileTimestamp,
    );
    // Generate a short random hash for fallback filenames
    const hash = crypto.randomBytes(4).toString("hex");
    // Append the fallback suffix before the extension
    return Logger._appendSuffixBeforeExtension(timestampedPath, `_fallback_${hash}`);
  }
  static _isPermissionError(error) {
    if (!error) return false;
    return error.code === "EACCES" || error.code === "EPERM";
  }
  static async _ensureDirExists(dirPath, context = {}) {
    try {
      await fs.promises.mkdir(dirPath, { recursive: true });
    } catch (err) {
      if (Logger._isPermissionError(err)) {
        ErrorHandler.addError("Logger cannot create directory due to permissions", {
          origin: "Logger",
          path: dirPath,
          ...context,
          error: err && err.message ? err.message : "permission error",
        });
        // Don't throw on permission errors - let caller handle
        return;
      }
      throw err;
    }
  }
  static async _writeFallbackLogEntry(baseRoot, relativePath, payload, context = {}) {
    const resolved = await Logger._resolvePathWithinRoot(baseRoot, relativePath);
    await Logger._ensureDirExists(resolved.dir, { stage: "fallback-write", ...context });
    await Logger._writeFileWithRetry(resolved.full, `${payload}\n`);
  }
  static async _rotateLogFileIfNeeded(filePath) {
    try {
      // Use atomic stat + rename to reduce race condition window
      const stats = await fs.promises.stat(filePath);
      if (!stats.isFile() || stats.size < MAX_LOG_FILE_SIZE_BYTES) return;
      const rotatedPath = Logger._appendTimestampToPath(filePath);
      // Atomic rename operation - if file was modified between stat and rename, ENOENT will be caught
      await fs.promises.rename(filePath, rotatedPath);
    } catch (err) {
      // Ignore if file doesn't exist (was already rotated/removed by another process)
      if (err.code !== "ENOENT" && err.code !== "ENOTEMPTY") {
        ErrorHandler.addError("Logger failed to rotate log file", {
          origin: "Logger",
          filePath,
          error: err.message,
          code: err.code,
        });
        throw err;
      }
    }
  }
  static async _writeFileWithRetry(filePath, content, attempts = null) {
    // Acquire file descriptor
    await Logger._acquireFileDescriptor();
    try {
      // Get retry limit from env or use default
      const maxAttempts = attempts !== null ? attempts : (
        Number(Logger.ENV.LOG_WRITE_RETRY_ATTEMPTS) || 2
      );
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          // Try rotation, but don't fail the write if rotation fails (fix recovery test)
          try {
            await Logger._rotateLogFileIfNeeded(filePath);
          } catch (rotateErr) {
            // Log rotation failure but continue with write
            ErrorHandler.addError("Logger rotation failed, continuing with write", {
              origin: "Logger",
              filePath,
              error: rotateErr.message,
            });
          }
          // Add timeout to file operations
          const writePromise = fs.promises.appendFile(filePath, content);
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("File write timeout")), FILE_OPERATION_TIMEOUT_MS);
          });
          await Promise.race([writePromise, timeoutPromise]);
          return;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts) {
          // Add backoff cap
          const backoffMs = Math.min(
            RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt),
            RETRY_BACKOFF_MAX_MS
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }
      ErrorHandler.addError("Logger failed to write file after retries", {
        origin: "Logger",
        filePath,
        error: lastError && lastError.message ? lastError.message : "write failure",
      });
      throw lastError;
    } finally {
      // Release file descriptor
      Logger._releaseFileDescriptor();
    }
  }

  static _trimCache(cache) {
    // LRUCache automatically evicts when max is reached, so this method
    // is kept for backward compatibility but is effectively a no-op for LRUCache.
    // It still works if a Map is passed (for testing or edge cases).
    if (!cache || typeof cache.size !== "number") return;
    // For LRUCache, eviction is automatic, so we don't need to trim manually
    if (cache instanceof LRUCache) return;
    // For Map instances (if any remain), trim manually
    while (cache.size > CACHE_SIZE_LIMIT) {
      const key = cache.keys().next().value;
      if (key === undefined) break;
      cache.delete(key);
    }
  }
  static _getSlackTimeoutMs() {
    const configured = Number(Logger.ENV.LOG_SLACK_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : SLACK_TIMEOUT_DEFAULT;
  }
  static _canSendSlack() {
    return Date.now() >= Logger._SLACK_COOLDOWN_UNTIL;
  }
  static _recordSlackSuccess() {
    Logger._SLACK_FAILURE_COUNT = 0;
  }
  static _recordSlackFailure(err) {
    Logger._SLACK_FAILURE_COUNT += 1;
    if (Logger._SLACK_FAILURE_COUNT >= SLACK_FAILURE_THRESHOLD) {
      Logger._SLACK_FAILURE_COUNT = 0;
      Logger._SLACK_COOLDOWN_UNTIL = Date.now() + SLACK_FAILURE_COOLDOWN_MS;
      ErrorHandler.addError("Slack disabled temporarily after repeated failures", {
        origin: "Logger",
        reason: err?.message || "unknown",
      });
    }
  }

  static _scheduleSlackRetry(entry) {
    if (!entry || typeof entry !== "object") return;
    const currentAttempts = entry.__slackRetryAttempts || 0;
    if (currentAttempts >= Logger._SLACK_RETRY_LIMIT) return;
    Object.defineProperty(entry, "__slackRetryAttempts", {
      value: currentAttempts + 1,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    setTimeout(() => {
      Logger.sendToSlackCritical(entry);
    }, SLACK_FALLBACK_COOLDOWN_MS);
  }
  static _isDebugLevel(level) {
    return Object.prototype.hasOwnProperty.call(DEBUG_LEVEL_RANKS, level);
  }
  static _normalizeDebugLevel(level) {
    if (typeof level !== "string") return DEFAULT_DEBUG_LEVEL;
    const normalized = level.trim().toLowerCase();
    return Logger._isDebugLevel(normalized) ? normalized : DEFAULT_DEBUG_LEVEL;
  }
  static _parseDebugLevel(level) {
    if (typeof level !== "string") return null;
    const normalized = level.trim().toLowerCase();
    return Logger._isDebugLevel(normalized) ? normalized : null;
  }
  static _getDebugLevelRank(level) {
    const normalized = Logger._normalizeDebugLevel(level);
    return DEBUG_LEVEL_RANKS[normalized] ?? DEBUG_LEVEL_RANKS[DEFAULT_DEBUG_LEVEL];
  }




    static _normalizeEncryptionFields(targets) {
    if (!targets) return [];
    const candidateList = Array.isArray(targets) ? targets : [targets];
    const normalized = [];
    for (const candidate of candidateList) {
      if (typeof candidate !== "string") continue;
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      if (!SAFE_PLACEHOLDER_KEY_PATTERN.test(trimmed)) continue;
      normalized.push(trimmed);
    }
    return Array.from(new Set(normalized));
  }
  static _collectEncryptionTargets(route = {}, logEntry = {}) {
    // If encryption key is enabled, encrypt entire data object
    const keyBuffer = Logger._getEncryptionKeyBuffer();
    if (keyBuffer && logEntry.data && typeof logEntry.data === "object") {
      return ["__ENTIRE_DATA__"]; // Special marker to encrypt entire data object
    }
    // Fallback: no encryption if key not available
    return [];
  }
  static _getEncryptionKeyBuffer(version = null) {
    // Support key versioning for rotation
    const keyVersion = version !== null ? version : Logger._ENCRYPTION_KEY_VERSION;
    
    // Try versioned key first (e.g., LOG_ENCRYPTION_KEY_V1), then fallback to default
    const versionedKeyName = `LOG_ENCRYPTION_KEY_V${keyVersion}`;
    const rawKey = Logger.ENV[versionedKeyName] || Logger.ENV.LOG_ENCRYPTION_KEY;
    
    if (!rawKey) {
      if (version === null) {
        Logger._ENCRYPTION_KEY_BUFFER = null;
      }
      return null;
    }
    
    // Cache only the default version key
    if (version === null && Logger._ENCRYPTION_KEY_BUFFER !== undefined) {
      return Logger._ENCRYPTION_KEY_BUFFER;
    }
    
    try {
      const candidate = Buffer.from(rawKey, "base64");
      if (candidate.length !== 32) {
        throw new Error("decoded key must be 32 bytes");
      }
      // Cache the default version key
      if (version === null) {
        Logger._ENCRYPTION_KEY_BUFFER = candidate;
      }
      return candidate;
    } catch (err) {
      const message = "Logger encryption key is invalid";
      ErrorHandler.addError(message, {
        origin: "Logger",
        error: err && err.message ? err.message : "invalid key",
        version: keyVersion,
      });
      if (version === null) {
        Logger._ENCRYPTION_KEY_BUFFER = null;
      }
      return null; // Return null instead of throwing
    }
  }
  static _encryptValue(value, keyBufferOrVersion) {
    // If keyBufferOrVersion is a number, treat it as a version and get the key buffer
    // If keyBufferOrVersion is undefined, use the default key buffer
    let keyBuffer = keyBufferOrVersion;
    if (keyBufferOrVersion === undefined || keyBufferOrVersion === null) {
      keyBuffer = Logger._getEncryptionKeyBuffer();
      if (!keyBuffer) {
        throw new Error("Logger._encryptValue: encryption key not available");
      }
    } else if (typeof keyBufferOrVersion === "number") {
      keyBuffer = Logger._getEncryptionKeyBuffer(keyBufferOrVersion);
      if (!keyBuffer) {
        throw new Error(`Logger._encryptValue: encryption key not available for version ${keyBufferOrVersion}`);
      }
    }
    if (!keyBuffer || !Buffer.isBuffer(keyBuffer)) {
      throw new Error("Logger._encryptValue: keyBuffer is required and must be a Buffer");
    }
    const iv = crypto.randomBytes(ENCRYPTION_IV_BYTES);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, keyBuffer, iv);
    const encrypted = Buffer.concat([
      cipher.update(String(value), "utf8"),
      cipher.final(),
    ]);
    return {
      payload: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }
  static _decryptValue(segment, keyBuffer, algorithm = ENCRYPTION_ALGORITHM) {
    const iv = Buffer.from(segment.iv, "base64");
    const tag = Buffer.from(segment.tag, "base64");
    const encryptedPayload =
      typeof segment.payload === "string" ? segment.payload : segment.encrypted;
    const encrypted = Buffer.from(encryptedPayload || "", "base64");
    const decipher = crypto.createDecipheriv(algorithm, keyBuffer, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  }
  static _applyEncryption(entry, targets) {
    const normalizedTargets = Logger._normalizeEncryptionFields(targets);
    if (!normalizedTargets.length) return entry;
    
    // Check if we should encrypt entire data object
    const encryptEntireData = normalizedTargets.includes("__ENTIRE_DATA__");
    if (!encryptEntireData) return entry;
    
    let keyBuffer;
    try {
      keyBuffer = Logger._getEncryptionKeyBuffer();
    } catch (err) {
      ErrorHandler.addError("Logger encryption key validation failed", {
        origin: "Logger",
        error: err?.message || "invalid key",
      });
      return entry;
    }
    if (!keyBuffer) {
      ErrorHandler.addError("Logger encryption requested but key unavailable", {
        origin: "Logger",
        targets: normalizedTargets,
      });
      return entry;
    }
    if (!entry || !entry.data || typeof entry.data !== "object") return entry;
    
    // Don't encrypt empty objects
    if (Object.keys(entry.data).length === 0) return entry;
    
    try {
      // Encrypt entire data object as one unit
      const dataJson = JSON.stringify(entry.data);
      const encryptedSegment = Logger._encryptValue(dataJson, keyBuffer);
      entry.data = {
        encrypted: encryptedSegment.payload,
        iv: encryptedSegment.iv,
        tag: encryptedSegment.tag,
      };
    } catch (err) {
      ErrorHandler.addError("Logger encryption failed for entire data", {
        origin: "Logger",
        flag: entry.flag,
        error: err?.message || "encryption error",
      });
    }
    return entry;
  }
  /**
   * Attempt to decrypt an encrypted log entry's data object.
   *
   * Return decrypted data only when the structure matches the encryption schema.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#decryptEntry #TODO
   * @param {Object} entry - log entry potentially containing encrypted data
   * @returns {Object|null} decrypted payload or null when unavailable
   */
  static decryptEntry(entry) {
    // Extract the data object from the entry
    const data = entry?.data;
    // Reject when data is missing or not an object
    if (!data || typeof data !== "object") {
      // Return null when no valid encrypted payload exists
      return null;
    }
    // Check if the full data object is encrypted via expected keys
    if (!data.encrypted || !data.iv || !data.tag) {
      // Indicate not encrypted
      return null;
    }
    // Resolve the encryption key buffer, handling missing key state
    let keyBuffer;
    try {
      keyBuffer = Logger._getEncryptionKeyBuffer();
    }
    // Return null if the buffer could not be obtained
    catch {
      // Absent key means decryption cannot proceed
      return null;
    }
    // Reject if the key buffer is still missing
    if (!keyBuffer) {
      // No key available; cannot decrypt
      return null;
    }
    // Default to the standard encryption algorithm
    let algorithm = ENCRYPTION_ALGORITHM;
    // Override algorithm per route configuration when available
    if (entry?.flag) {
      try {
        // Fetch route metadata for encryption override
        const route = Logger.getRouteByFlag(entry.flag);
        // Use route-specific algorithm when defined
        if (route?.encryption?.algorithm) {
          algorithm = route.encryption.algorithm;
        }
      }
      // Fallback silently when retrieving metadata fails
      catch {
        // Default algorithm remains in use
      }
    }
    // Attempt to perform the decryption
    try {
      // Decrypt the encrypted payload segment
      const decryptedJson = Logger._decryptValue(data, keyBuffer, algorithm);
      const decryptedData = JSON.parse(decryptedJson);
      // Return the parsed decrypted object
      return decryptedData;
    }
    // Record failures for diagnostics
    catch (err) {
      ErrorHandler.addError("Logger failed to decrypt entire data", {
        origin: "Logger",
        error: err?.message || "decryption error",
      });
      // Return null when decryption fails
      return null;
    }
  }
  /**
   * Decrypt a log file by processing each entry safely.
   *
   * Read the file, decrypt entries, and write the decrypted output.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#decryptLogFile #TODO
   * @param {string} logFilePath - path to the encrypted log file
   * @returns {Promise<string>} resolved path to decrypted file
   */
  static async decryptLogFile(logFilePath) {
    // Ensure a non-empty string path was provided
    if (typeof logFilePath !== "string" || !logFilePath.trim()) {
      // Record the missing path error
      ErrorHandler.addError("Logger.decryptLogFile requires a file path", {
        origin: "Logger",
        path: logFilePath,
      });
      // Reject the operation
      throw new Error("Logger.decryptLogFile requires a file path");
    }
    // Resolve input path to absolute when necessary
    const resolvedSource = path.isAbsolute(logFilePath)
      ? logFilePath
      : path.resolve(logFilePath);
    // Confirm read access before proceeding
    try {
      // Ensure the file exists and is readable
      await fs.promises.access(resolvedSource, fs.constants.R_OK);
    }
    // Surface errors when the source cannot be read
    catch {
      ErrorHandler.addError("Logger.decryptLogFile source missing", {
        origin: "Logger",
        path: resolvedSource,
      });
      throw new Error("Logger.decryptLogFile source missing");
    }
    // Determine the destination path for decrypted output
    const decryptedPath = Logger._appendSuffixBeforeExtension(
      resolvedSource,
      "_decrypted",
    );
    // Process the file contents
    try {
      // Read the entire encrypted file into memory
      const rawContent = await fs.promises.readFile(resolvedSource, "utf8");
      // Detect whether the file appears pretty-printed
      const isPrettyPrinted = rawContent.includes("  \"") || rawContent.includes("\t\"");
      // Decide whether to preserve pretty-print formatting
      const shouldPrettyPrint = isPrettyPrinted || (Logger.ENV.LOG_PRETTY_PRINT === true || Logger.ENV.LOG_PRETTY_PRINT === "1" || Logger.ENV.LOG_PRETTY_PRINT === 1);
      // Collect decrypted lines for output
      const sanitizedLines = [];
      // Split the file into logical lines
      const lines = rawContent.split(/\r?\n/);
      // Build entries incrementally to handle pretty-printed JSON
      let currentEntry = "";
      // Track the brace depth to detect complete objects
      let braceCount = 0;
      // Iterate over each line to reconstruct JSON entries
      for (let index = 0; index < lines.length; index += 1) {
        // Extract the current line
        const line = lines[index];
        // Skip empty lines outside of an entry
        if (!line.trim() && braceCount === 0) {
          // Continue to next line when nothing to parse
          continue;
        }
        // Accumulate the current line into the ongoing entry
        currentEntry += line + "\n";
        // Adjust brace count to detect object boundaries
        for (const char of line) {
          if (char === '{') braceCount++;
          if (char === '}') braceCount--;
        }
        // When braces are balanced, try to parse the entry
        if (braceCount === 0 && currentEntry.trim()) {
          try {
            // Parse the accumulated entry text
            const parsed = JSON.parse(currentEntry.trim());
            // Attempt to decrypt the parsed entry data
            const decrypted = Logger.decryptEntry(parsed);
            // Remove encryption metadata before writing
            delete parsed.encryption;
            // Replace the data object with the decrypted version when available
            if (decrypted) {
              // Assign the decrypted data object
              parsed.data = decrypted;
            }
            // Serialize the parsed entry respecting pretty-print settings
            const serialized = shouldPrettyPrint 
              ? JSON.stringify(parsed, Logger._sanitizeLogEntryValue, 2)
              : Logger._serializeLogEntry(parsed);
            // Store the serialized entry for output
            sanitizedLines.push(serialized);
          }
          // Handle parse/decrypt errors for individual entries
          catch (innerErr) {
            // Log the inability to parse the specific line
            ErrorHandler.addError("Logger.decryptLogFile could not parse entry", {
              origin: "Logger",
              path: resolvedSource,
              line: index + 1,
              error: innerErr?.message || "parse error",
            });
            // Preserve the original text when parsing failed
            sanitizedLines.push(currentEntry.trim());
          }
          // Reset accumulation state for the next entry
          currentEntry = "";
          braceCount = 0;
        }
      }
      // Ensure the destination directory exists before writing
      await Logger._ensureDirExists(path.dirname(decryptedPath), { stage: "decrypt-output" });
      // Write the decrypted content to disk with newline-separated entries
      await fs.promises.writeFile(
        decryptedPath,
        sanitizedLines.length ? `${sanitizedLines.join("\n")}\n` : "",
        "utf8",
      );
      // Return the path to the decrypted file
      return decryptedPath;
    }
    // Handle failures while processing or writing the decrypted file
    catch (err) {
      // Propagate permission-denied errors for callers to handle
      if (Logger._isPermissionError(err)) {
        // Surface generic failure message while preserving error type
        throw new Error("Logger.decryptLogFile failed");
      }
      // Log the failure for diagnostics
      ErrorHandler.addError("Logger.decryptLogFile failed", {
        origin: "Logger",
        path: resolvedSource,
        error: err?.message || "decrypt failure",
      });
      // Throw a generic failure to signal the caller
      throw new Error("Logger.decryptLogFile failed");
    }
  }
  /**
   * Read log entries from a file with optional decryption.
   *
   * Stream each JSON line while obeying the configured entry limit.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/Logger#readLogFile #TODO
   * @param {string} logFilePath - path to the log file
   * @param {Object} options - optional settings (decrypt, limit)
   * @returns {Promise<Object[]>} parsed log entries
   */
  static async readLogFile(logFilePath, options = {}) {
    // Validate that a file path string was provided
    if (typeof logFilePath !== "string" || !logFilePath.trim()) {
      // Report the missing path scenario
      ErrorHandler.addError("Logger.readLogFile requires a file path", {
        origin: "Logger",
        path: logFilePath,
      });
      // Reject the call when path is invalid
      throw new Error("Logger.readLogFile requires a file path");
    }
    // Resolve the path to an absolute location
    const resolvedSource = path.isAbsolute(logFilePath)
      ? logFilePath
      : path.resolve(logFilePath);
    // Ensure the file is accessible before reading
    try {
      // Check read permissions
      await fs.promises.access(resolvedSource, fs.constants.R_OK);
    }
    // Handle missing source exceptions
    catch {
      ErrorHandler.addError("Logger.readLogFile source missing", {
        origin: "Logger",
        path: resolvedSource,
      });
      throw new Error("Logger.readLogFile source missing");
    }
    // Extract optional settings from the options object
    const { decrypt = false, limit = 1000 } = options || {};
    // Normalize the maximum entry count
    const maxEntries = Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Number(limit)
      : 1000;
    // Read the raw content from the file
    const rawContent = await fs.promises.readFile(resolvedSource, "utf8");
    // Prepare the container for parsed entries
    const entries = [];
    // Split the file content into individual lines/chunks
    const chunks = rawContent.split(/\r?\n/);
    // Iterate through each chunk, enforcing the limit
    for (let index = 0; index < chunks.length; index += 1) {
      // Stop when the configured entry limit is reached
      if (entries.length >= maxEntries) {
        // Exit early when maximum entries have been collected
        break;
      }
      // Process the current line chunk
      const chunk = chunks[index];
      // Skip empty lines
      if (!chunk || !chunk.trim()) {
        // Continue to the next line
        continue;
      }
      // Attempt to parse the JSON chunk
      try {
        const parsed = JSON.parse(chunk);
        // Decrypt the entry when requested
        if (decrypt) {
          // Attempt to decrypt the parsed entry data
          const decrypted = Logger.decryptEntry(parsed);
          // Replace the data object when decrypted successfully
          if (decrypted) {
            // Assign decrypted data to the entry
            parsed.data = decrypted;
          }
        }
        // Collect the parsed entry
        entries.push(parsed);
      }
      // Handle parse errors per chunk
      catch (innerErr) {
        // Log the inability to parse this specific log line
        ErrorHandler.addError("Logger.readLogFile could not parse entry", {
          origin: "Logger",
          path: resolvedSource,
          line: index + 1,
          error: innerErr?.message || "parse error",
        });
        // Fallback data structure capturing the raw chunk
        entries.push({ raw: chunk, line: index + 1, parseError: true });
      }
    }
    // Return the accumulated entries to the caller
    return entries;
  }
}

module.exports = Logger;

