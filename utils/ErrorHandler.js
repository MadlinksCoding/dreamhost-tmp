"use strict";

const Joi = require("joi");
const { LRUCache } = require("lru-cache");

/**
 * Class ErrorHandler
 *
 * Handles error logging, storage, and retrieval for the application.
 *
 * @link https://docs.example.com/ErrorHandler #TODO
 */
class ErrorHandler {
  // Constants
  // Define the default max entries to keep in cache
  static #DEFAULT_MAX_ERRORS = 500;
  // Define text placeholder when serialization is not possible
  static #UNSERIALIZABLE_PLACEHOLDER = "[unserializable]";
  // Define the separator used for signature deduplication
  static #SIGNATURE_SEPARATOR = "\x1E"; // Record Separator (RS) character - unlikely in messages
  // Define the maximum length for error messages
  static #MAX_MESSAGE_LENGTH = 10000;
  // Define the allowed byte size for error data
  static #MAX_DATA_SIZE_BYTES = 100000; // 100KB max data size
  // Define maximum depth used during JSON inspections
  static #MAX_JSON_DEPTH = 10;
  // Define maximum serialization string length for signatures
  static #MAX_JSON_STRING_LENGTH = 50000;
  // LRU cache: signature -> ErrorEntry
  static #errorCache = new LRUCache({
    max: ErrorHandler.#DEFAULT_MAX_ERRORS,
    updateAgeOnGet: false, // Don't update age on get, only on set
    updateAgeOnHas: false, // Don't update age on has, only on set
  });
  // Total count of error occurrences since last flush.
  static totalErrorCount = 0;
  // Max number of unique errors to keep (LRU cache size).
  static #_maxErrorsStored = ErrorHandler.#DEFAULT_MAX_ERRORS;
  // Count of dropped/evicted errors.
  static droppedCount = 0;
  // Getter/setter for maxErrorsStored that keeps cache in sync
  static get maxErrorsStored() {
    // Return the tracked maximum entry count
    return this.#_maxErrorsStored;
  }
  // Setter to update maxErrorsStored via method
  static set maxErrorsStored(value) {
    // If setting directly, use setMaxErrorsStored to keep cache in sync
    this.setMaxErrorsStored(value);
  }

  /**
   * Add error entry to cache.
   *
   * Append a new error message and associated data into the cache while handling deduplication and overflow.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#addError #TODO
   * @param {string} errorMessage - The error message to log.
   * @param {object} [errorDetails={}] - Optional additional error details.
   * @returns {void} Logs the error in the internal cache.
   */
  static addError(errorMessage, errorDetails = {}) {
    // Validate the error message input
    const { error: messageValidationError } = this.#getMessageSchema().validate(errorMessage);
    // Check if message validation failed
    if (messageValidationError) {
      // Throw error for invalid message
      throw new Error(`ErrorHandler.addError: ${messageValidationError.details[0].message}`);
    }
    // Validate the error details input
    const { value: validatedData } = this.#getDataSchema().validate(errorDetails, {
      // Prevent Joi from stripping unknown keys automatically
      stripUnknown: false,
      // Allow unknown properties to be processed manually
      allowUnknown: true,
    });
    // Sanitize the validated error details
    const sanitizedErrorData = this.#sanitizeData(validatedData || {});
    // Check for total error count overflow
    if (this.totalErrorCount >= Number.MAX_SAFE_INTEGER) {
      // Reset the total error count
      this.totalErrorCount = 0;
    }
    // Generate the current timestamp for the error
    const currentTimestamp = new Date().toISOString();
    // Build the deduplication signature from message and data
    const errorSignature = this.#buildSignature(errorMessage, errorDetails);
    // Increment the global error counter
    this.totalErrorCount += 1;
    // Retrieve an existing entry with the same signature
    const existingErrorEntry = this.#errorCache.get(errorSignature);
    // Check if the error is already recorded
    if (existingErrorEntry) {
      // Guard against per-entry counter overflow
      if (existingErrorEntry.count >= Number.MAX_SAFE_INTEGER) {
        // Reset the existing entry occurrence count
        existingErrorEntry.count = 1;
      }
      // Otherwise increase the occurrence count
      else {
        // Increment the existing entry occurrence count
        existingErrorEntry.count += 1;
      }
      // Update the last seen timestamp for the entry
      existingErrorEntry.lastTimestamp = currentTimestamp;
      // Update the cache entry to mark it as recently used
      this.#errorCache.set(errorSignature, existingErrorEntry);
      // Exit after updating the duplicate entry
      return;
    }
    // Record whether the cache was at capacity before insertion
    const wasCacheAtCapacity = this.#errorCache.size >= this.maxErrorsStored;
    // Create a new error entry object with null prototype
    const newErrorEntry = Object.create(null);
    // Set the error message on the new entry
    newErrorEntry.message = errorMessage;
    // Assign the sanitized data to the entry
    newErrorEntry.data = sanitizedErrorData;
    // Timestamp the entry creation
    newErrorEntry.timestamp = currentTimestamp;
    // Keep the last seen timestamp in sync
    newErrorEntry.lastTimestamp = currentTimestamp;
    // Initialize the occurrence count
    newErrorEntry.count = 1;
    // Persist the deduplication signature with the entry
    newErrorEntry.signature = errorSignature;
    // Cache size prior to adding the entry
    const previousCacheSize = this.#errorCache.size;
    // Insert the new error into the cache
    this.#errorCache.set(errorSignature, newErrorEntry);
    // Detect if an eviction occurred because the cache was at capacity
    if (wasCacheAtCapacity && this.#errorCache.size === previousCacheSize) {
      // Increment the dropped entry counter
      this.droppedCount += 1;
    }
  }

  /**
   * Check if any errors have been logged.
   *
   * Returns a boolean indicating whether the error log contains entries.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#hasErrors #TODO
   *
   * @returns {boolean} True if there are logged errors, false otherwise.
   */
  static hasErrors() {
    // Determine whether the cache currently holds any entries
    return this.#errorCache.size > 0;
  }

  /**
   * Return defensive snapshot of logged errors.
   *
   * Clone stored entries and return them in oldest-first order to protect cache state.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#getAllErrors #TODO
   * @returns {Array<ErrorEntry>} Cloned array of logged error entries preserving internal ordering
   */
  static getAllErrors() {
    // Define helper that clones error payloads defensively
    const cloneErrorData = (dataValue) => {
      // Return null or undefined values as-is
      if (dataValue === null || dataValue === undefined) {
        // Return the nullish value directly
        return dataValue;
      }
      // Return primitives without cloning
      if (typeof dataValue !== "object") {
        // Return the primitive value directly
        return dataValue;
      }
      // Determine if the source object already has a null prototype
      const hasNullProto = Object.getPrototypeOf(dataValue) === null;
      // Create a clone with a matching prototype
      const clonedData = hasNullProto ? Object.create(null) : {};
      // Iterate over each property to clone nested structures
      for (const [propertyKey, propertyValue] of Object.entries(dataValue)) {
        // Check if the value is a nested plain object
        if (typeof propertyValue === "object" && propertyValue !== null && !Array.isArray(propertyValue)) {
          // Recursively clone nested objects
          clonedData[propertyKey] = cloneErrorData(propertyValue);
        }
        // Handle non-object values and arrays
        else {
          // Preserve the value directly
          clonedData[propertyKey] = propertyValue;
        }
      }
      // Return the deep cloned object
      return clonedData;
    };
    // Convert cache entries into array from oldest to newest
    const orderedErrorEntries = Array.from(this.#errorCache.keys())
      // Reverse the key order to expose oldest entries first
      .reverse()
      // Map each signature to its cloned entry
      .map((cacheSignature) => {
        // Retrieve the cached entry by signature
        const cachedErrorEntry = this.#errorCache.get(cacheSignature);
        // Return a cloned copy of the cached entry
        return {
          // Preserve the error message
          message: cachedErrorEntry.message,
          // Clone the error data defensively
          data: cloneErrorData(cachedErrorEntry.data),
          // Preserve the original timestamp
          timestamp: cachedErrorEntry.timestamp,
          // Preserve the most recent timestamp
          lastTimestamp: cachedErrorEntry.lastTimestamp,
          // Preserve the occurrence count
          count: cachedErrorEntry.count,
          // Preserve the deduplication signature
          signature: cachedErrorEntry.signature,
        };
      });
    // Return the ordered and cloned entries
    return orderedErrorEntries;
  }

  /**
   * Group cached errors by origin.
   *
   * Iterate through stored entries and bucket them by their origin field for analysis or filtering.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#getErrorsByCategory #TODO
   * @param {string} [originFilter=null] - Optional origin to filter the grouped errors.
   * @returns {Object|Array<ErrorEntry>} Object keyed by origin or filtered array when originFilter is provided.
   */
  static getErrorsByCategory(originFilter = null) {
    // Initialize map to collect errors grouped by origin
    const errorsByOrigin = {};
    // Iterate through cache signatures for grouping
    for (const cacheSignature of this.#errorCache.keys()) {
      // Retrieve the entry associated with the current signature
      const cachedErrorEntry = this.#errorCache.get(cacheSignature);
      // Capture the data payload from the cached entry
      const entryData = cachedErrorEntry.data;
      // Determine the origin category for the entry or fallback to unknown
      const originCategory = entryData && entryData.origin ? entryData.origin : "unknown";
      // Check if this origin category already has a collection
      if (!errorsByOrigin[originCategory]) {
        // Initialize the array for this origin
        errorsByOrigin[originCategory] = [];
      }
      // Append the error entry to the origin group
      errorsByOrigin[originCategory].push(cachedErrorEntry);
    }
    // Check if a specific origin filter was provided
    if (originFilter !== null && typeof originFilter === "string") {
      // Return the filtered array or empty list when origin not found
      return errorsByOrigin[originFilter] || [];
    }
    // Return the full grouped collection
    return errorsByOrigin;
  }

  /**
   * Clear all logged errors.
   *
   * Reset the internal cache, occurrence counters, and dropped count for a fresh state.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#clear #TODO
   * @returns {void} Empties stored errors and resets related counters
   */
  static clear() {
    // Remove every entry from the internal cache
    this.#errorCache.clear();
    // Reset the total number of recorded errors
    this.totalErrorCount = 0;
    // Reset the dropped/evicted entry counter
    this.droppedCount = 0;
  }

  /**
   * Clear only the cached errors.
   *
   * Reset the cache while leaving error counters intact for telemetry continuity.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#clearErrorsOnly #TODO
   * @returns {void} Empties the cache but preserves statistical counters
   */
  static clearErrorsOnly() {
    // Clear all entries while keeping counters unchanged
    this.#errorCache.clear();
  }

  /**
   * Resize the stored error capacity.
   *
   * Validate the requested capacity and rebuild the internal cache to enforce the new limit.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#setMaxErrorsStored #TODO
   * @param {number} requestedMaxErrorEntries - Desired maximum number of stored unique errors.
   * @returns {void} Applies the validated size to the cache while preserving recent entries.
   */
  static setMaxErrorsStored(requestedMaxErrorEntries) {
    // Validate the requested limit using Joi schema
    const { error: validationError, value: sanitizedMaxErrorLimit } = this.#getMaxErrorsStoredSchema().validate(requestedMaxErrorEntries, { convert: false });
    // Check if validation failed
    if (validationError) {
      // Throw when the requested limit is invalid
      throw new Error(`ErrorHandler.setMaxErrorsStored: ${validationError.details[0].message}`);
    }
    // Update the tracked maximum entries value
    this.#_maxErrorsStored = sanitizedMaxErrorLimit;
    // Capture the cache size before rebuilding
    const previousCacheSize = this.#errorCache.size;
    // Determine whether the cache needs trimming
    if (sanitizedMaxErrorLimit < previousCacheSize) {
      // Create a new cache limited to the smaller size
      const newCache = new LRUCache({ max: sanitizedMaxErrorLimit, updateAgeOnGet: false, updateAgeOnHas: false });
      // Build array of existing signatures oldest first
      const allCacheSignatures = Array.from(this.#errorCache.keys()).reverse();
      // Select the most recent signatures to keep
      const signaturesToRetain = allCacheSignatures.slice(-sanitizedMaxErrorLimit);
      // Copy each retained entry into the new cache
      for (const signature of signaturesToRetain) {
        // Retrieve the entry matching the signature
        const entry = this.#errorCache.get(signature);
        // Store the entry inside the new cache
        newCache.set(signature, entry);
      }
      // Calculate how many entries were dropped due to the resize
      const evictionCount = previousCacheSize - newCache.size;
      // Check if any evictions occurred
      if (evictionCount > 0) {
        // Increment the dropped counter for the evicted entries
        this.droppedCount += evictionCount;
      }
      // Replace the old cache with the pruned cache
      this.#errorCache = newCache;
    }
    // Keep all entries when capacity increases or stays the same
    else {
      // Create a new cache with the expanded capacity
      const newCache = new LRUCache({ max: sanitizedMaxErrorLimit, updateAgeOnGet: false, updateAgeOnHas: false });
      // Copy every existing entry into the new cache
      for (const signature of this.#errorCache.keys()) {
        // Retrieve the entry for the current signature
        const entry = this.#errorCache.get(signature);
        // Set the entry into the expanded cache
        newCache.set(signature, entry);
      }
      // Replace the cache with the expanded version
      this.#errorCache = newCache;
    }
  }

  /**
   * Sanitize data object to prevent prototype pollution.
   *
   * Run through the provided object, recursively filter blocked properties, and protect against circular references.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#sanitizeData #TODO
   * @param {object} rawErrorData - Incoming error payload to sanitize.
   * @returns {object} Sanitized data object with safe prototype.
   */
  static #sanitizeData(rawErrorData) {
    // Handle non-object inputs by returning an empty null-prototyped object
    if (rawErrorData === null || typeof rawErrorData !== "object") {
      // Return a new null-prototype placeholder
      return Object.create(null);
    }
    // Create a sanitized object based on null prototype
    const sanitized = Object.create(null);
    // Define keys that must be filtered out
    const blockedKeys = new Set(["__proto__", "prototype", "constructor"]);
    // Track visited references to prevent infinite recursion
    const visitedReferences = new WeakSet();
    // Recursive helper to sanitize values safely
    const sanitizeValue = (valueToSanitize, depth = 0) => {
      // Abort if maximum recursion depth is exceeded
      if (depth > this.#MAX_JSON_DEPTH) {
        // Return undefined when depth limit reached
        return undefined;
      }
      // Handle null values by returning null
      if (valueToSanitize === null) {
        // Preserve null values
        return null;
      }
      // Return primitive values directly
      if (typeof valueToSanitize === "string" || typeof valueToSanitize === "number" || typeof valueToSanitize === "boolean") {
        // Preserve primitive value without cloning
        return valueToSanitize;
      }
      // Discard functions, symbols, and bigints for safety
      if (typeof valueToSanitize === "function" || typeof valueToSanitize === "symbol" || typeof valueToSanitize === "bigint") {
        // Filter out unsupported types
        return undefined;
      }
      // Handle arrays with circular reference protection
      if (Array.isArray(valueToSanitize)) {
        // Detect circular references for arrays
        if (visitedReferences.has(valueToSanitize)) {
          // Return undefined when circular reference detected
          return undefined;
        }
        // Track current array to prevent cycles
        visitedReferences.add(valueToSanitize);
        // Sanitize each array element recursively
        const result = valueToSanitize
          // Sanitize array item
          .map((arrayItem) => sanitizeValue(arrayItem, depth + 1))
          // Remove undefined items from sanitized array
          .filter((arrayItem) => arrayItem !== undefined);
        // Remove the array from visited set after processing
        visitedReferences.delete(valueToSanitize);
        // Return the sanitized array
        return result;
      }
      // Handle plain objects with prototype pollution guard
      if (typeof valueToSanitize === "object" && Object.getPrototypeOf(valueToSanitize) === Object.prototype) {
        // Detect circular references for objects
        if (visitedReferences.has(valueToSanitize)) {
          // Return undefined to avoid recursion loops
          return undefined;
        }
        // Track the object while sanitizing its properties
        visitedReferences.add(valueToSanitize);
        // Create an object clone with null prototype
        const sanitizedObject = Object.create(null);
        // Iterate through each property in the object
        for (const [propertyKey, propertyValue] of Object.entries(valueToSanitize)) {
          // Only handle string keys that are not blocked
          if (!blockedKeys.has(propertyKey) && typeof propertyKey === "string") {
            // Recursively sanitize the property value
            const sanitizedProperty = sanitizeValue(propertyValue, depth + 1);
            // Assign sanitized value when defined
            if (sanitizedProperty !== undefined) {
              // Set the sanitized property on the clone
              sanitizedObject[propertyKey] = sanitizedProperty;
            }
          }
        }
        // Remove the object from the visited set after recursion
        visitedReferences.delete(valueToSanitize);
        // Return the sanitized object clone
        return sanitizedObject;
      }
      // Filter out unsupported types that reach this point
      return undefined;
    };
    // Enumerate the top-level raw data properties
    for (const [propertyKey, propertyValue] of Object.entries(rawErrorData)) {
      // Skip blocked or non-string keys
      if (!blockedKeys.has(propertyKey) && typeof propertyKey === "string") {
        // Sanitize the property value recursively
        const sanitizedPropertyValue = sanitizeValue(propertyValue, 0);
        // Assign sanitized value when it is defined
        if (sanitizedPropertyValue !== undefined) {
          // Set the sanitized property on the root object
          sanitized[propertyKey] = sanitizedPropertyValue;
        }
      }
    }
    // Check total data size after sanitization to avoid serialization issues
    let estimatedSize = 0;
    try {
      // Serialize sanitized object to measure size
      const testString = JSON.stringify(sanitized);
      // Measure the byte length of the serialized string
      estimatedSize = Buffer.byteLength(testString, "utf8");
      // Truncate data when it exceeds the configured limit
      if (estimatedSize > this.#MAX_DATA_SIZE_BYTES) {
        // Return truncated placeholder when size limit is reached
        return Object.assign(Object.create(null), { _truncated: `Data exceeded maximum size of ${this.#MAX_DATA_SIZE_BYTES} bytes` });
      }
    } catch {
      // Return truncated placeholder when serialization fails
      return Object.assign(Object.create(null), { _truncated: "Data could not be serialized for size check" });
    }
    // Return the fully sanitized data object
    return sanitized;
  }

  /**
   * Build deduplication signature string.
   *
   * Compose the unique signature used for deduplicating error entries by combining the message and serialized payload.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#buildSignature #TODO
   * @param {string} errorMessage - Error message to include in the signature.
   * @param {object} errorData - Error data whose serialization is appended.
   * @returns {string} Unique signature for the message and data pair.
   */
  static #buildSignature(errorMessage, errorData) {
    // Define the base message portion of the signature
    const messageBase = typeof errorMessage === "string" ? errorMessage : String(errorMessage);
    // Initialize serialized data placeholder
    let serializedDataString = "";
    // Attempt to serialize the data safely
    try {
      // Serialize the payload respecting the configured depth limit
      serializedDataString = this.#safeStringify(errorData, this.#MAX_JSON_DEPTH);
      // Check if the serialized string exceeds the allowed length
      if (serializedDataString.length > this.#MAX_JSON_STRING_LENGTH) {
        // Truncate the serialized string to keep the signature bounded
        serializedDataString = `${serializedDataString.substring(0, this.#MAX_JSON_STRING_LENGTH)}...[truncated]`;
      }
    }
    // Handle serialization failures gracefully
    catch {
      // Fall back to the placeholder when serialization is not possible
      serializedDataString = this.#UNSERIALIZABLE_PLACEHOLDER;
    }
    // Combine the message and serialized data into the final signature using the reserved separator
    return `${messageBase}${this.#SIGNATURE_SEPARATOR}${serializedDataString}`;
  }

  /**
   * Safely serialize values.
   *
   * Recursively stringify the provided value while guarding against depth overflows and circular references.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#safeStringify #TODO
   * @param {*} inputValue - Value to stringify safely.
   * @param {number} maximumDepth - Maximum depth to traverse.
   * @returns {string} Stringified value respecting limits.
   */
  static #safeStringify(inputValue, maximumDepth) {
    // Track references that have already been visited
    const visited = new WeakSet();
    // Recursive helper that enforces depth and cycle detection
    function stringifyWithDepth(currentValue, currentDepth) {
      // Prevent recursion when depth exceeds the configured limit
      if (currentDepth > maximumDepth) {
        // Return placeholder for excessive depth
        return '"[max depth exceeded]"';
      }
      // Handle explicit null values
      if (currentValue === null) {
        // Return JSON literal for null
        return "null";
      }
      // Handle string primitives
      if (typeof currentValue === "string") {
        // Serialize the string via JSON
        return JSON.stringify(currentValue);
      }
      // Handle numeric primitives
      if (typeof currentValue === "number") {
        // Convert the number to string
        return String(currentValue);
      }
      // Handle boolean primitives
      if (typeof currentValue === "boolean") {
        // Convert the boolean to string
        return String(currentValue);
      }
      // Handle unsupported primitive types
      if (typeof currentValue !== "object") {
        // Return placeholder for unserializable values
        return '"[unserializable]"';
      }
      // Detect circular references before object traversal
      if (visited.has(currentValue)) {
        // Return placeholder for circular structures
        return '"[circular reference]"';
      }
      // Serialize array structures explicitly
      if (Array.isArray(currentValue)) {
        // Mark the array as visited to detect cycles
        visited.add(currentValue);
        // Map each array element through the serializer
        const serializedItems = currentValue.map((arrayItem) =>
          stringifyWithDepth(arrayItem, currentDepth + 1)
        );
        // Remove the array from the visited set after processing
        visited.delete(currentValue);
        // Return the joined serialized array literal
        return `[${serializedItems.join(",")}]`;
      }
      // Mark the object as visited before iterating keys
      visited.add(currentValue);
      // Collect keys to iterate over the object
      const objectKeys = Object.keys(currentValue);
      // Convert keys to serialized key:value strings
      const pairs = objectKeys.map((objectKey) => {
        // Serialize the property key
        const serializedKey = JSON.stringify(objectKey);
        // Serialize the property value recursively
        const serializedValue = stringifyWithDepth(currentValue[objectKey], currentDepth + 1);
        // Return the serialized key/value pair
        return `${serializedKey}:${serializedValue}`;
      });
      // Remove the object from the visited set after serialization
      visited.delete(currentValue);
      // Return the serialized object literal
      return `{${pairs.join(",")}}`;
    }
    // Start serialization from the root value
    return stringifyWithDepth(inputValue, 0);
  }
 /**
   * Build message validation schema.
   *
   * Return the Joi string schema used to enforce length and presence rules.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#getMessageSchema #TODO
   * @returns {Joi.StringSchema} Message validation schema
   */
  static #getMessageSchema() {
    // Return the Joi string schema builder
    return Joi.string()
      // Restrict the message length to the configured maximum
      .max(this.#MAX_MESSAGE_LENGTH)
      // Allow empty string entries as tests require
      .allow("")
      // Require the presence of the message
      .required()
      // Provide custom validation error messages
      .messages({
        // Message when value is not a string
        "string.base": "message must be a string",
        // Message when value exceeds the allowed length
        "string.max": `message exceeds maximum length`,
        // Message when value is missing
        "any.required": "message must be a string",
      });
  }

  /**
   * Build schema for max errors configuration.
   *
   * Returns the Joi number schema that enforces bounds and strict typing for maxErrorsStored.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#getMaxErrorsStoredSchema #TODO
   * @returns {Joi.NumberSchema} MaxErrorsStored validation schema
   */
  static #getMaxErrorsStoredSchema() {
    // Build Joi number schema with strict settings
    return Joi.number()
      // Require integer values
      .integer()
      // Enforce minimum limit of 1
      .min(1)
      // Enforce maximum limit of 10000
      .max(10000)
      // Block implicit value coercion
      .strict()
      // Supply consistent error messages for failures
      .messages({
        // Message for values not recognized as numbers
        "number.base": "must be an integer between 1 and 10000",
        // Message for values failing integer check
        "number.integer": "must be an integer between 1 and 10000",
        // Message for values below minimum
        "number.min": "must be an integer between 1 and 10000",
        // Message for values above maximum
        "number.max": "must be an integer between 1 and 10000",
        // Message when value is missing
        "any.required": "must be an integer between 1 and 10000",
      });
  }

  /**
   * Define the error data schema.
   *
   * Construct the Joi object schema used to validate supplemental error data before sanitization.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/ErrorHandler#getDataSchema #TODO
   * @returns {Joi.ObjectSchema} Data validation schema for error payloads
   */
  static #getDataSchema() {
    // Return Joi object schema for error data
    return Joi.object()
      // Allow unknown keys inside the error payload
      .unknown(true)
      // Permit explicit null values when provided
      .allow(null)
      // Default missing data to an empty object
      .default({});
  }
}

module.exports = ErrorHandler;