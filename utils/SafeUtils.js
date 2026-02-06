/*
 * Methods:
 *    hasValue() — Determine value presence.
 *    sanitizeValidate() — Sanitize and validate schema inputs.
 *    sanitizeUrl() — Normalize and validate URLs.
 *    sanitizeTextField() — Strip tags from text safely.
 *    escUrl() — Escape and serialize URLs safely.
 *    sanitizeArray() — Coerce inputs into arrays.
 *    sanitizeIterable() — Sanitize iterable collections.
 *    sanitizeString() — Create a trimmed escaped string.
 *    isPlainObject() — Detect plain objects safely.
 *    escapeHtmlEntities() — Escape HTML entities safely.
 *    escapeHtmlQuotes() — Escape only HTML quotes.
 *    sanitizeInteger() — Parse safe integers.
 *    sanitizeFloat() — Parse safe floats.
 *    sanitizeBoolean() — Coerce boolean values safely.
 *    sanitizeObject() — Sanitize plain objects safely.
 *    sanitizeEmail() — Normalize and validate email.
 *    sanitizePhone() — Sanitize and validate phone number.
 *    sanitizeIpAddress() — Sanitize and validate IP address (IPv4/IPv6).
 *    parseArgs() — Merge entries into defaults safely.
 *    parseUrl() — Parse a URL into parts.
 *    addQueryArg() — Add or update query arguments.
 *    getArrayType() — Infer array element type.
 *    formatError() — Format error message.
 *    sanitizeHtmlWithWhitelist() — Sanitize HTML with a whitelist.
 */

"use strict";

const { LRUCache } = require("lru-cache");

/**
 * Class SafeUtils
 *
 * A collection of defensive sanitizers, parsers, and helpers for safely handling untrusted inputs.
 *
 * @link #TODO
 */
class SafeUtils {
  // Global debug flag to enable noisy logs in utility functions when needed.
  // Default is false to avoid polluting production logs.
  /**
   * A placeholder to avoid linting warnings before static properties are defined.
   * Actual defaults are attached after the class declaration.
   */
  static DEBUG;
  static _regexCache;
  
  /**
   *
   * Get or compile regex pattern (performance optimization).
   *
   * Caches compiled regex patterns to avoid repeated compilation.
   *
   * @param {string} pattern - Regex pattern string
   * @param {string} [flags] - Regex flags (e.g., 'i', 'g')
   * @returns {RegExp} Compiled regex pattern
   */
  static getRegex(pattern, flags = "") {
    const cacheKey = `${pattern}:${flags}`;
    if (!this._regexCache.has(cacheKey)) {
      this._regexCache.set(cacheKey, new RegExp(pattern, flags));
    }
    return this._regexCache.get(cacheKey);
  }
  
  /**
   * Get detailed validation error information.
   * 
   * Returns structured error data for validation failures.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#getValidationError #TODO
   * @param {string} field - Field name that failed validation
   * @param {*} value - The invalid value
   * @param {string} type - Type of validation that failed
   * @param {string} reason - Reason for validation failure
   * @returns {ValidationError} Structured error object
   */
  static getValidationError(field, value, type, reason) {
    // Build structured error response
    return {
      // Normalize the field name
      field: String(field || ""),
      // Preserve the invalid value
      value: value,
      // Normalize the validation type
      type: String(type || ""),
      // Normalize the failure reason
      reason: String(reason || "Validation failed"),
    };
  }
  
  /**
   * Validate with error details.
   * 
   * Similar to sanitize methods but returns error details instead of null on failure.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#validateWithDetails #TODO
   * @param {*} value - Value to validate
   * @param {string} type - Type of validation (int, float, email, etc.)
   * @param {string} fieldName - Field name for error context
   * @returns {{valid: boolean, value: *, error: ValidationError|null}} Validation result with error details
   */
  static validateWithDetails(value, type, fieldName = "field") {
    // Initialize sanitized placeholder
    let sanitized = null;
    // Initialize error container
    let error = null;
    // Execute type-specific validation branches
    try {
      // Dispatch based on validation type
      switch (type) {
        // Handle integer variants
        case "int":
          // Attempt integer sanitization
          sanitized = this.sanitizeInteger(value);
          // Check for failure to sanitize
          if (sanitized === null) {
            // Record integer validation failure
            error = this.getValidationError(
              fieldName,
              value,
              type,
              `Value "${value}" is not a valid integer`,
            );
          }
          // Exit integer handling
          break;
        // Handle integer alias
        case "integer":
          // Attempt integer sanitization for alias
          sanitized = this.sanitizeInteger(value);
          // Record failure when sanitization returns null
          if (sanitized === null) {
            // Record integer alias validation failure
            error = this.getValidationError(
              fieldName,
              value,
              type,
              `Value "${value}" is not a valid integer`,
            );
          }
          // Exit alias handling
          break;
        // Handle float variants
        case "float":
          // Attempt float sanitization
          sanitized = this.sanitizeFloat(value);
          // Check whether conversion failed
          if (sanitized === null) {
            // Record float validation failure
            error = this.getValidationError(
              fieldName,
              value,
              type,
              `Value "${value}" is not a valid float`,
            );
          }
          // Exit float handling
          break;
        // Handle numeric alias
        case "numeric":
          // Attempt numeric sanitization
          sanitized = this.sanitizeFloat(value);
          // Record failure when null result returned
          if (sanitized === null) {
            // Record numeric validation failure
            error = this.getValidationError(
              fieldName,
              value,
              type,
              `Value "${value}" is not a valid float`,
            );
          }
          // Exit numeric alias handling
          break;
        // Handle boolean variants
        case "bool":
          // Attempt boolean sanitization
          sanitized = this.sanitizeBoolean(value);
          // Record failure when sanitization returns null
          if (sanitized === null) {
            // Record boolean validation failure
            error = this.getValidationError(
              fieldName,
              value,
              type,
              `Value "${value}" is not a valid boolean`,
            );
          }
          // Exit boolean handling
          break;
        // Handle boolean alias
        case "boolean":
          // Attempt boolean sanitization for alias
          sanitized = this.sanitizeBoolean(value);
          // Record failure when result is null
          if (sanitized === null) {
            // Record boolean alias validation failure
            error = this.getValidationError(
              fieldName,
              value,
              type,
              `Value "${value}" is not a valid boolean`,
            );
          }
          // Exit boolean alias handling
          break;
        // Handle email validation
        case "email":
          // Attempt email sanitization
          sanitized = this.sanitizeEmail(value);
          // Record failure when email is invalid
          if (sanitized === null) {
            // Record email validation failure
            error = this.getValidationError(
              fieldName,
              value,
              type,
              `Value "${value}" is not a valid email address`,
            );
          }
          // Exit email handling
          break;
        // Handle phone validation
        case "phone":
          // Attempt phone sanitization
          sanitized = this.sanitizePhone(value);
          // Record failure when phone is invalid
          if (sanitized === null) {
            // Record phone validation failure
            error = this.getValidationError(
              fieldName,
              value,
              type,
              `Value "${value}" is not a valid phone number`,
            );
          }
          // Exit phone handling
          break;
        // Handle IP address validation
        case "ip":
          // Attempt IP sanitization
          sanitized = this.sanitizeIpAddress(value);
          // Record failure when IP is invalid
          if (sanitized === null) {
            // Record IP validation failure
            error = this.getValidationError(
              fieldName,
              value,
              type,
              `Value "${value}" is not a valid IP address`,
            );
          }
          // Exit IP handling
          break;
        // Handle IP address alias
        case "ipaddress":
          // Attempt IP sanitization for alias
          sanitized = this.sanitizeIpAddress(value);
          // Record failure when IP is invalid
          if (sanitized === null) {
            // Record IP alias validation failure
            error = this.getValidationError(
              fieldName,
              value,
              type,
              `Value "${value}" is not a valid IP address`,
            );
          }
          // Exit IP alias handling
          break;
        // Handle unknown validation types
        default:
          // Record unknown type failure
          error = this.getValidationError(
            fieldName,
            value,
            type,
            `Unknown validation type: ${type}`,
          );
      }
    }
    // Capture parsing errors
    catch (err) {
      // Record caught error details
      error = this.getValidationError(
        fieldName,
        value,
        type,
        `Validation error: ${err.message}`,
      );
    }
    // Build the response object
    return {
      // Determine validity flag
      valid: error === null,
      // Include sanitized result
      value: sanitized,
      // Attach validation error when present
      error: error,
    };
  }

  /**
   * Determine value presence.
   * 
   * Checks whether the provided value counts as present across strings, numbers, arrays, and objects.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#hasValue #TODO
   * @param {*} valueCandidate - Value to test for presence.
   * @returns {boolean} Indicator that the value is considered present.
   */
  static hasValue(valueCandidate) {
    // Check for null or undefined inputs
    if (valueCandidate === null || valueCandidate === undefined) {
      // Return false for absent candidates
      return false;
    }
    // Handle string inputs via trimmed length
    if (typeof valueCandidate === "string") {
      // Return true when trimmed string has characters
      return valueCandidate.trim().length > 0;
    }
    // Handle numeric inputs by excluding NaN
    if (typeof valueCandidate === "number") {
      // Return true when number is valid
      return !Number.isNaN(valueCandidate);
    }
    // Handle array inputs through length check
    if (Array.isArray(valueCandidate)) {
      // Return true when array contains entries
      return valueCandidate.length > 0;
    }
    // Handle object inputs by inspecting own properties
    if (typeof valueCandidate === "object") {
      // Gather own property keys and symbols
      const ownPropertyIdentifiers = [...Object.getOwnPropertyNames(valueCandidate), ...Object.getOwnPropertySymbols(valueCandidate)];
      // Return false when no own properties exist
      if (ownPropertyIdentifiers.length === 0) {
        // Return false for empty objects
        return false;
      }
      // Return true when any own property has a defined value
      return ownPropertyIdentifiers.some((ownPropertyKey) => {
        // Read the value for the current property
        const ownPropertyValue = valueCandidate[ownPropertyKey];
        // Return true if the current property is defined
        return ownPropertyValue !== null && ownPropertyValue !== undefined;
      });
    }
    // Return true for other primitives or types
    return true;
  }

  /**
   * Sanitize and validate schema inputs.
   * 
   * Applies type-specific sanitizers per rule to ensure final values match expected shapes and defaults.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeValidate #TODO
   * @param {Object} schemaDefinition - Schema map defining value, type, and requirements.
   * @param {string} pipelineLabel - Pipeline label for error context.
   * @returns {Object} Object of sanitized values keyed by schema keys.
   */
  static sanitizeValidate(schemaDefinition = {}, pipelineLabel = "method") {
    // Define helper for plain object checks
    const isPlainObjectCandidate = (candidateValue) =>
      SafeUtils.isPlainObject(candidateValue);
    // Validate that schema is a plain object
    if (!isPlainObjectCandidate(schemaDefinition)) {
      // Throw formatted error when schema is invalid
      throw SafeUtils.formatError(
        "sanitizeValidate",
        `schema must be a plain object (pipeline: ${pipelineLabel})`,
      );
    }
    // Define mapping of types to sanitizers
    const sanitizerByTypeMap = {
      int: SafeUtils.sanitizeInteger,
      integer: SafeUtils.sanitizeInteger,
      float: SafeUtils.sanitizeFloat,
      numeric: SafeUtils.sanitizeFloat,
      bool: SafeUtils.sanitizeBoolean,
      boolean: SafeUtils.sanitizeBoolean,
      string: SafeUtils.sanitizeTextField,
      text: SafeUtils.sanitizeTextField,
      array: SafeUtils.sanitizeArray,
      iterable: SafeUtils.sanitizeIterable,
      email: SafeUtils.sanitizeEmail,
      url: SafeUtils.sanitizeUrl,
      html: SafeUtils.sanitizeHtmlWithWhitelist,
      object: SafeUtils.sanitizeObject,
    };
    // Prepare sanitized output container
    const sanitizedResults = {};
    // Iterate over schema entries
    for (const [fieldName, fieldRule] of Object.entries(schemaDefinition)) {
      // Ensure each schema rule is a plain object with a type string
      if (
        !isPlainObjectCandidate(fieldRule) ||
        typeof fieldRule.type !== "string"
      ) {
        // Throw when schema rule structure is invalid
        throw new TypeError(
          `sanitizeValidate(): invalid schema for "${fieldName}" (pipeline: ${pipelineLabel})`,
        );
      }
      // Destructure metadata from the schema rule
      const { type, required = false, default: defaultFieldValue } = fieldRule;
      // Capture inline schema value when provided
      const submittedValue = Object.prototype.hasOwnProperty.call(
        fieldRule,
        "value",
      )
        ? fieldRule.value
        : undefined;
      // Lookup sanitizer based on declared type
      const sanitizerFunction = sanitizerByTypeMap[type.toLowerCase()];
      // Ensure the sanitizer is callable
      if (typeof sanitizerFunction !== "function") {
        // Throw when the declared type is unknown
        throw new TypeError(
        `sanitizeValidate(): unknown type "${type}" for "${fieldName}" (pipeline: ${pipelineLabel})`,
        );
      }
      // Handle optional values that are absent
      if (!required && !SafeUtils.hasValue(submittedValue)) {
        // Apply default when provided
        if ("default" in fieldRule) {
          // Sanitize the default entry
          const sanitizedDefaultFieldValue = sanitizerFunction(defaultFieldValue);
          // Ensure the sanitized default is present
          if (!SafeUtils.hasValue(sanitizedDefaultFieldValue)) {
            // Throw when default sanitization fails
            throw new TypeError(
          `sanitizeValidate(): "${fieldName}" has invalid default for type ${type} (pipeline: ${pipelineLabel})`,
            );
          }
          // Assign sanitized default to output storage
          sanitizedResults[fieldName] = sanitizedDefaultFieldValue;
        } else {
          // Assign null for absent optional defaults
          sanitizedResults[fieldName] = null;
        }
        // Continue to next schema rule when optional value absent
        continue;
      }
      // Enforce presence for required values
      if (required && !SafeUtils.hasValue(submittedValue)) {
        // Allow iterables to be handled by their sanitizer
        if (type.toLowerCase() === "iterable") {
          // Continue without throwing for iterables
          continue;
        } else {
          // Throw when required parameter is missing
          throw new TypeError(
            `Missing required parameter: ${fieldName} (pipeline: ${pipelineLabel})`,
          );
        }
      }
      // Sanitize the provided value
      const sanitizedFieldValue = sanitizerFunction(submittedValue);
      // Reject null sanitization outcomes
      if (sanitizedFieldValue === null) {
        // Throw when sanitization nulls out the value
        throw new TypeError(
          `sanitizeValidate(): "${fieldName}" failed sanitization. Expected ${type}. (pipeline: ${pipelineLabel})`,
        );
      }
      // Store the sanitized value
      sanitizedResults[fieldName] = sanitizedFieldValue;
    }
    // Return the assembled sanitized output
    return sanitizedResults;
  }

  /**
   * Normalize and validate URLs safely.
   * 
   * Accepts only safe schemes, enforces length limits, and returns a normalized href when valid.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeUrl #TODO
   * @param {string} unvalidatedUrl - Raw URL string to validate.
   * @returns {string|null} Normalized URL string or null if invalid.
   */
  static sanitizeUrl(unvalidatedUrl) {
    // Validate that the input is a string
    if (typeof unvalidatedUrl !== "string") {
      // Return null for invalid string inputs
      return null;
    }
    // Reject control characters inside the raw URL
    if (/[\u0000-\u001F\u007F]/.test(unvalidatedUrl)) {
      // Return null when control characters are present
      return null;
    }
    // Inspect authority portion for non-ASCII hostnames
    const authorityMatchResult = unvalidatedUrl.match(/^[^:]+:\/\/([^\/?#]+)/);
    // Validate the raw host portion when authority exists
    if (authorityMatchResult) {
      // Extract the authority host segment
      const authorityHostSegment = authorityMatchResult[1];
      // Reject non-ASCII characters in the authority host
      if (/[^\x00-\x7F]/.test(authorityHostSegment)) {
        // Log debug warning when enabled
        if (SafeUtils.DEBUG) {
          // Log parsing warning details
          console.warn(
            // Describe the log message prefix
            "sanitizeUrl parsing error",
            // Provide rejection reason
            new TypeError("Non-ASCII hostname rejected"),
          );
        }
        // Return null after rejecting the authority host
        return null;
      }
    }
    // Attempt to parse the value as a URL
    try {
      // Create a URL instance from input
      const validatedUrlInstance = new URL(unvalidatedUrl);
      // Reject protocols that are not http or https
      if (!["http:", "https:"].includes(validatedUrlInstance.protocol)) {
        // Return null for disallowed protocols
        return null;
      }
      // Clear any username portion
      validatedUrlInstance.username = "";
      // Clear any password portion
      validatedUrlInstance.password = "";
      // Reject hostnames that end with a dot
      if (validatedUrlInstance.hostname.endsWith(".")) {
        // Return null for invalid hostnames
        return null;
      }
      // Reject hostnames containing non-ASCII characters
      if (/[^\x00-\x7F]/.test(validatedUrlInstance.hostname)) {
        // Return null when hostname contains invalid characters
        return null;
      }
      // Convert the URL instance back to a string
      const normalizedUrlString = validatedUrlInstance.toString();
      // Reject URLs that exceed the maximum length
      if (normalizedUrlString.length > 2048) {
        // Return null when URL is too long
        return null;
      }
      // Reject normalized URLs containing control characters
      if (/[\u0000-\u001F\u007F]/.test(normalizedUrlString)) {
        // Return null when control characters persist
        return null;
      }
      // Return the validated and normalized URL
      return normalizedUrlString;
    } catch (urlParseError) {
      // Handle parsing errors consistently
      if (SafeUtils.DEBUG) {
        // Log parse error details when debug mode is active
        console.warn(
          // Describe the log message prefix
          "sanitizeUrl parsing error",
          // Provide the caught parse error
          urlParseError,
        );
      }
      // Return null for parse failures
      return null;
    }
  }

  /**
   * Strip tags from text safely.
   * 
   * Cleans markup, removes control characters, and optionally escapes HTML entities for safe output.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeTextField #TODO
   * @param {string} rawTextInput - Input text to sanitize.
   * @param {boolean} shouldEscapeHtmlEntities - Whether to HTML-escape reserved characters.
   * @returns {string|null} Cleaned string or null when empty or invalid.
   */
  static sanitizeTextField(rawTextInput, shouldEscapeHtmlEntities = false) {
    // Verify that the input is a string
    if (typeof rawTextInput !== "string") {
      // Return null for non-string inputs
      return null;
    }
    // Remove HTML tags from the input string
    let cleanedText = rawTextInput.replace(/<[^>]*>/g, "");
    // Remove zero-width characters and BOM remnants
    cleanedText = cleanedText.replace(/[\u200B-\u200D\uFEFF]/g, "");
    // Strip control character ranges that are not safe
    cleanedText = cleanedText.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
    // Trim leading or trailing form feed and vertical whitespace
    cleanedText = cleanedText.replace(/^[ \f\v]+|[ \f\v]+$/g, "");
    // Attempt to normalize the cleaned text
    try {
      // Normalize to NFC form when available
      cleanedText = cleanedText.normalize("NFC");
    }
    // Catch normalization failures silently
    catch {
    }
    // Check whether HTML escaping is requested
    if (shouldEscapeHtmlEntities) {
      // Escape entities via sanitizeString helper
      cleanedText = SafeUtils.sanitizeString(cleanedText, true);
    }
    // Return cleaned text when it still has content
    return cleanedText.length ? cleanedText : null;
  }

  /**
   * Escape and serialize URLs safely.
   * 
   * Validates allowed protocols, strips credentials, and returns an encoded URL or an empty string fallback.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#escUrl #TODO
   * @param {string} candidateUrlString - Raw URL (absolute or relative).
   * @param {string[]} allowedProtocols - Whitelisted protocols.
   * @returns {string} Safely escaped URL string or empty string when invalid.
   */
  static escUrl(candidateUrlString, allowedProtocols = ["http:", "https:"]) {
    // Validate that the candidate is a non-empty string
    if (typeof candidateUrlString !== "string" || candidateUrlString.length === 0) {
      // Return empty string for invalid candidate types
      return "";
    }
    // Reject unsafe percent encodings
    if (
      /%(?:0[0-9A-Fa-f]|1[0-9A-Fa-f]|7[Ff]|8[0-9A-Fa-f]|9[0-9A-Fa-f])/.test(
        candidateUrlString,
      )
    ) {
      // Return empty string for suspicious encodings
      return "";
    }
    // Attempt to parse the candidate URL safely
    try {
      // Accept relative or fragment-style URLs directly
      if (/^(\/|\?|#|\.\/|\.\.\/)/.test(candidateUrlString)) {
        // Reject control characters in relative URLs
        if (/[\u0000-\u001F\u007F]/.test(candidateUrlString)) {
          // Return empty string for control-character relative URLs
          return "";
        }
        // Return the relative URL candidate when safe
        return candidateUrlString;
      }
      // Parse the URL using a base to support relative inputs
      const parsedUrlWithBase = new URL(candidateUrlString, "http://_base_/");
      // Reject disallowed protocols
      if (!allowedProtocols.includes(parsedUrlWithBase.protocol)) {
        // Return empty string for disallowed protocols
        return "";
      }
      // Handle absolute URLs with a valid origin
      if (parsedUrlWithBase.origin !== "null") {
        // Clear the username portion before returning
        parsedUrlWithBase.username = "";
        // Clear the password portion before returning
        parsedUrlWithBase.password = "";
        // Return the sanitized absolute URL string
        return parsedUrlWithBase.toString();
      }
      // Prepare fallback for relative URL strings
      const relativeUrlCandidate = candidateUrlString;
      // Reject relative fallbacks containing control characters
      if (/[\u0000-\u001F\u007F]/.test(relativeUrlCandidate)) {
        // Return empty string for invalid relative fallbacks
        return "";
      }
      // Return the safe relative URL string
      return relativeUrlCandidate;
    }
    // Catch parsing failures gracefully
    catch (urlParseError) {
      // Return empty string when parsing fails
      return "";
    }
  }

  /**
   * Coerce inputs into arrays safely.
   * 
   * Ensures the result is always an array that only contains present entries.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeArray #TODO
   * @param {*} arrayValueCandidate - Any input to coerce into an array.
   * @returns {Array} Cleaned array of present values.
   */
  static sanitizeArray(arrayValueCandidate) {
    // Check if the candidate is null or undefined
    if (arrayValueCandidate == null) {
      // Return an empty array for nullish inputs
      return [];
    }
    // Normalize the candidate into an array
    const normalizedArray = Array.isArray(arrayValueCandidate)
      // Reuse the array when the input is already an array
      ? arrayValueCandidate
      // Wrap the single value inside a new array
      : [arrayValueCandidate];
    // Filter out entries that do not have values
    return normalizedArray.filter((arrayEntryValue) => {
      // Include entries only when they have values
      return SafeUtils.hasValue(arrayEntryValue);
    });
  }

  /**
   * Sanitize iterable collections safely.
   * 
   * Attempts to convert an iterable to an array and filters out invalid values, returning null on failure.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeIterable #TODO
   * @param {Iterable} iterableInputCandidate - The iterable value to sanitize.
   * @returns {Array|null} The sanitized array or null if conversion fails.
   */
  static sanitizeIterable(iterableInputCandidate) {
    // Try to convert iterable candidate to an array
    try {
      // Reject strings because they should not be handled here
      if (typeof iterableInputCandidate === "string") {
        // Return null for string inputs
        return null;
      }
      // Determine if the candidate lacks the iterator protocol
      const lacksIterator = iterableInputCandidate == null || typeof iterableInputCandidate[Symbol.iterator] !== "function";
      // Return null when iterator protocol is missing
      if (lacksIterator) {
        // Return null for non-iterable candidates
        return null;
      }
      // Convert iterable to an array for filtering
      const convertedArray = Array.from(iterableInputCandidate);
      // Filter out entries without values
      return convertedArray.filter((arrayEntry) => {
        // Include entry only when it has a value
        return SafeUtils.hasValue(arrayEntry);
      });
    }
    // Catch conversion errors gracefully
    catch (conversionError) {
      // Log warning when debug mode is enabled
      if (SafeUtils.DEBUG) {
        // Log conversion failure details
        console.warn(
          // Provide context for the warning
          "Conversion failed for sanitizeIterable:",
          // Append the caught error object
          conversionError,
        );
      }
      // Return null when conversion fails
      return null;
    }
  }

  /**
   * Create a trimmed escaped string.
   * 
   * Coerces any input to string, trims whitespace, and optionally HTML-escapes reserved characters.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeString #TODO
   * @param {string} rawValueCandidate - Value to stringify and trim.
   * @param {boolean} shouldEscapeHtmlEntities - Whether to HTML-escape reserved characters.
   * @returns {string} The sanitized string.
   */
  static sanitizeString(rawValueCandidate = "", shouldEscapeHtmlEntities = false) {
    // Coerce the raw value into a string result
    let sanitizedStringResult =
      typeof rawValueCandidate === "string"
        ? rawValueCandidate
        : String(rawValueCandidate);
    // Trim whitespace from the string
    sanitizedStringResult = sanitizedStringResult.trim();
    // Determine if HTML entity escaping is required
    if (shouldEscapeHtmlEntities) {
      // Escape HTML characters safely
      sanitizedStringResult = SafeUtils.escapeHtmlEntities(sanitizedStringResult);
    }
    // Return the sanitized string result
    return sanitizedStringResult;
  }

  /**
   * Detect plain objects safely.
   *
   * Determine whether the provided value is a plain object across realms.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#isPlainObject #TODO
   * @param {*} valueCandidate - Value to check.
   * @returns {boolean} True when the value is a plain object.
   */
  static isPlainObject(valueCandidate) {
    // Evaluate whether the input represents a plain object
    return (
      // Ensure the candidate is not null
      valueCandidate !== null &&
      // Ensure the candidate is an object type
      typeof valueCandidate === "object" &&
      // Ensure the candidate is not an array
      !Array.isArray(valueCandidate) &&
      // Confirm the internal [[Class]] is Object
      Object.prototype.toString.call(valueCandidate) === "[object Object]"
    );
  }

  /**
   * Escape HTML entities safely.
   * 
   * Converts characters to entities while preserving existing named, numeric, and hex entities.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#escapeHtmlEntities #TODO
   * @param {string} htmlStringInput - Input string to escape.
   * @returns {string} Escaped string with preserved entities.
   */
  static escapeHtmlEntities(htmlStringInput) {
    // Ensure input is string typed
    if (typeof htmlStringInput !== "string") {
      // Coerce non-string input to string
      htmlStringInput = String(htmlStringInput);
    }
    // Define pattern matching entities or special characters
    const entityOrCharacterRegex = /&(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);|[&<>\"']/g;
    // Replace matches using replacer function
    return htmlStringInput.replace(entityOrCharacterRegex, (entityMatch) => {
      // Determine whether the match is a complete HTML entity
      const isWellFormedEntity = entityMatch[0] === "&" && entityMatch.length > 1 && entityMatch[entityMatch.length - 1] === ";";
      // Return the original entity when detected
      if (isWellFormedEntity) {
        // Preserve the original entity value
        return entityMatch;
      }
      // Define escape sequences for special characters
      const escapeSequences = {
        // Ampersand replacement
        "&": "&amp;",
        // Less-than replacement
        "<": "&lt;",
        // Greater-than replacement
        ">": "&gt;",
        // Double-quote replacement
        '"': "&quot;",
        // Single-quote replacement
        "'": "&#39;",
      };
      // Return the escaped result for the matched input
      return escapeSequences[entityMatch];
    });
  }

  /**
   * Escape only HTML quotes safely.
   * 
   * Preserves ampersands while converting double and single quotes to entities.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#escapeHtmlQuotes #TODO
   * @param {string} htmlQuoteString - Input string to escape quotes.
   * @returns {string} String with HTML quotes escaped.
   */
  static escapeHtmlQuotes(htmlQuoteString) {
    // Ensure the input value is string typed
    if (typeof htmlQuoteString !== "string") {
      // Coerce non-string input to string
      htmlQuoteString = String(htmlQuoteString);
    }
    // Define pattern to detect entities and quotes
    const entityOrQuoteRegex = /&(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);|[\"']/g;
    // Replace matches with preserved entities or escaped quotes
    return htmlQuoteString.replace(entityOrQuoteRegex, (entityOrQuoteMatch) => {
      // Determine whether the match is a complete HTML entity
      const isEntity =
        entityOrQuoteMatch[0] === "&" &&
        entityOrQuoteMatch.length > 1 &&
        entityOrQuoteMatch[entityOrQuoteMatch.length - 1] === ";";
      // Return the original entity when detected
      if (isEntity) {
        // Preserve the original entity text
        return entityOrQuoteMatch;
      }
      // Define escape sequences for quote characters
      const quoteEscapes = {
        // Double-quote entity
        '"': "&quot;",
        // Single-quote entity
        "'": "&#39;",
      };
      // Return escaped quote for the match
      return quoteEscapes[entityOrQuoteMatch];
    });
  }

  /**
   * Parse safe integers.
   * 
   * Accepts finite numbers or base-10 integer strings within the JavaScript safe integer range.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeInteger #TODO
   * @param {*} integerInputCandidate - Candidate integer value.
   * @returns {number|null} Parsed safe integer or null if invalid.
   */
  static sanitizeInteger(integerInputCandidate) {
    // Reject null or undefined candidates immediately
    if (integerInputCandidate === null || integerInputCandidate === undefined) {
      // Return null for absent inputs
      return null;
    }
    // Handle numeric candidates directly
    if (typeof integerInputCandidate === "number") {
      // Reject non-integer numbers
      if (!Number.isInteger(integerInputCandidate)) {
        // Return null when candidate is not an integer
        return null;
      }
      // Reject non-finite numbers
      if (!Number.isFinite(integerInputCandidate)) {
        // Return null when candidate is not finite
        return null;
      }
      // Reject numbers outside the safe integer range
      if (!Number.isSafeInteger(integerInputCandidate)) {
        // Return null when candidate exceeds safe integer limits
        return null;
      }
      // Return the already valid integer
      return integerInputCandidate;
    }
    // Handle string representations carefully
    if (typeof integerInputCandidate === "string") {
      // Trim whitespace from the candidate string
      const trimmedString = integerInputCandidate.trim();
      // Reject strings that are not base-10 integers
      if (!/^[+-]?\d+$/.test(trimmedString)) {
        // Return null for invalid formats
        return null;
      }
      // Convert the trimmed string into a number
      const parsedInteger = Number(trimmedString);
      // Reject parsed values that are not finite or safe
      if (!Number.isFinite(parsedInteger) || !Number.isSafeInteger(parsedInteger)) {
        // Return null when parsed value is invalid
        return null;
      }
      // Return the parsed safe integer
      return parsedInteger;
    }
    // Return null for unsupported candidate types
    return null;
  }

  /**
   * Parse safe floats.
   * 
   * Accepts finite numbers or strictly validated float strings, including exponent notation, while rejecting malformed values.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeFloat #TODO
   * @param {*} floatInputCandidate - Candidate floating-point value.
   * @returns {number|null} Finite number or null if invalid.
   */
  static sanitizeFloat(floatInputCandidate) {
    // Reject null or undefined candidates
    if (floatInputCandidate == null) {
      // Return null for missing inputs
      return null;
    }
    // Handle numeric candidates directly
    if (typeof floatInputCandidate === "number") {
      // Return the number when it is finite
      return Number.isFinite(floatInputCandidate) ? floatInputCandidate : null;
    }
    // Handle string candidates by validating their format
    if (typeof floatInputCandidate === "string") {
      // Trim whitespace from the string
      const trimmedFloatString = floatInputCandidate.trim();
      // Reject empty strings
      if (trimmedFloatString === "") {
        // Return null for empty string input
        return null;
      }
      // Reject values containing comma separators
      if (/,/.test(trimmedFloatString)) {
        // Return null for comma-containing strings
        return null;
      }
      // Reject strings that lack digits or contain invalid characters
      if (
        !/[0-9]/.test(trimmedFloatString) ||
        /[^0-9+\-eE.]/.test(trimmedFloatString)
      ) {
        // Return null for malformed numeric strings
        return null;
      }
      // Parse the cleaned string into a number
      const parsedFloatValue = Number(trimmedFloatString);
      // Return the parsed value when finite
      return Number.isFinite(parsedFloatValue) ? parsedFloatValue : null;
    }
    // Log unsupported types when debugging
    if (SafeUtils.DEBUG) {
      // Warn about unsupported candidate types
      console.warn("Unsupported type for sanitizeFloat:", floatInputCandidate);
    }
    // Return null for all other types
    return null;
  }

  /**
   * Coerce boolean values safely.
   * 
   * Interprets booleans, numeric flags, and common string toggles while returning null for unknown inputs.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeBoolean #TODO
   * @param {*} booleanInputCandidate - Candidate boolean value.
   * @returns {boolean|null} True/false or null when unrecognized.
   */
  static sanitizeBoolean(booleanInputCandidate) {
    // Return the value when it is already a boolean
    if (typeof booleanInputCandidate === "boolean") {
      // Return the original boolean
      return booleanInputCandidate;
    }
    // Handle numeric inputs separately
    if (typeof booleanInputCandidate === "number") {
      // Reject NaN or infinite numbers
      if (Number.isNaN(booleanInputCandidate) || !Number.isFinite(booleanInputCandidate)) {
        // Return null for invalid numeric values
        return null;
      }
      // Map 1 to true, 0 to false
      if (booleanInputCandidate === 1) {
        // Return true for numeric one
        return true;
      }
      if (booleanInputCandidate === 0) {
        // Return false for numeric zero
        return false;
      }
      // Return null for other numeric values
      return null;
    }
    // Handle string representations
    if (typeof booleanInputCandidate === "string") {
      // Normalize whitespace and casing
      const normalizedInputString = booleanInputCandidate.trim().toLowerCase();
      // Define truthy strings
      const truthyStringValues = new Set(["true", "1", "yes", "y", "on"]);
      // Define falsy strings
      const falsyStringValues = new Set(["false", "0", "no", "n", "off"]);
      // Return true when the string matches a truthy value
      if (truthyStringValues.has(normalizedInputString)) {
        return true;
      }
      // Return false when the string matches a falsy value
      if (falsyStringValues.has(normalizedInputString)) {
        return false;
      }
      // Return null when the string is unrecognized
      return null;
    }
    // Return null for all other types
    return null;
  }

  /**
   * Sanitize plain objects safely.
   * 
   * Clones non-null plain objects while filtering unsafe keys and returning null for empty results.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeObject #TODO
   * @param {*} objectInputCandidate - Candidate object to validate.
   * @returns {Object|null} Safe shallow-cloned object or null.
   */
  static sanitizeObject(objectInputCandidate) {
    // Reject values that are not plain objects
    if (!SafeUtils.isPlainObject(objectInputCandidate)) {
      // Return null for invalid objects
      return null;
    }
    // Create sanitized result container
    const sanitizedObject = {};
    // Collect prototype property names to block
    const prototypePropertyNames = Object.getOwnPropertyNames(Object.prototype || {});
    // Combine prototype names with explicit pollution keys
    const explicitBlockedProperties = prototypePropertyNames.concat(["__proto__", "prototype", "constructor"]);
    // Create set of blocked property names
    const blockedPropertyNames = new Set(explicitBlockedProperties);
    // Iterate over each own property of the input object
    for (const [propertyKey, propertyValue] of Object.entries(objectInputCandidate)) {
      // Skip blocked keys entirely
      if (blockedPropertyNames.has(propertyKey)) {
        // Continue to next property when blocked
        continue;
      }
      // Copy safe property to sanitized object
      sanitizedObject[propertyKey] = propertyValue;
    }
    // Return sanitized object when it contains entries, otherwise null
    return Object.keys(sanitizedObject).length > 0 ? sanitizedObject : null;
  }

  /**
   * Normalize and validate email safely.
   * 
   * Trims, lowercases domain, checks length and ASCII patterns, and enforces a basic structure before returning the normalized value.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since 1.0.0
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeEmail #TODO
   * @param {string} emailInputCandidate - Input email string.
   * @returns {string|null} Normalized email or null if invalid.
   */
  static sanitizeEmail(emailInputCandidate) {
    // Validate that the email input is a string
    if (typeof emailInputCandidate !== "string") {
      // Return null for non-string inputs
      return null;
    }
    // Trim whitespace from the email candidate
    const trimmedEmailString = emailInputCandidate.trim();
    // Return null when the trimmed string is empty
    if (trimmedEmailString === "") {
      // Return null for empty email values
      return null;
    }
    // Locate the final at-sign in the trimmed string
    const lastAtIndex = trimmedEmailString.lastIndexOf("@");
    // Reject emails missing a proper at-sign placement
    if (lastAtIndex < 1 || lastAtIndex === trimmedEmailString.length - 1) {
      // Return null for invalid at-sign positioning
      return null;
    }
    // Extract the domain segment after the at-sign
    const domainSegment = trimmedEmailString.slice(lastAtIndex + 1);
    // Locate any prior at-sign to determine the true local part
    const previousAtIndex = trimmedEmailString.lastIndexOf("@", lastAtIndex - 1);
    // Declare storage for the local part value
    let actualLocalPart;
    // Use the substring before the last at-sign when no prior at-sign exists
    if (previousAtIndex === -1) {
      // Assign the substring before the last at-sign
      actualLocalPart = trimmedEmailString.slice(0, lastAtIndex);
    } else {
      // Assign the substring between the two most recent at-signs
      actualLocalPart = trimmedEmailString.slice(previousAtIndex + 1, lastAtIndex);
    }
    // Reject components that exceed allowed lengths
    if (actualLocalPart.length > 64 || domainSegment.length > 255) {
      // Return null when local or domain segment is too long
      return null;
    }
    // Reject domains ending with a dot character
    if (domainSegment.endsWith(".")) {
      // Return null for domains with trailing dots
      return null;
    }
    // Split the domain into individual labels
    const domainLabels = domainSegment.split(".");
    // Detect invalid label lengths or empty labels
    const hasInvalidLabel = domainLabels.some(
      (label) => label.length < 1 || label.length > 63,
    );
    // Return null when any domain label is invalid
    if (hasInvalidLabel) {
      // Return null for invalid domain labels
      return null;
    }
    // Define ASCII-only validation pattern
    const asciiOnlyPattern = /^[\x00-\x7F]+$/;
    // Reject inputs containing non-ASCII characters
    if (
      !asciiOnlyPattern.test(actualLocalPart) ||
      !asciiOnlyPattern.test(domainSegment)
    ) {
      // Return null for non-ASCII segments
      return null;
    }
    // Build the normalized email string
    const normalizedEmailCandidate = `${actualLocalPart.toLowerCase()}@${domainSegment.toLowerCase()}`;
    // Define the standard email regex for final checking
    const standardEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    // Reject normalized values that do not match the pattern
    if (!standardEmailPattern.test(normalizedEmailCandidate)) {
      // Return null for pattern mismatches
      return null;
    }
    // Return the cleaned and normalized email
    return normalizedEmailCandidate;
  }

  /**
   * Sanitize and validate phone numbers safely.
   * 
   * Normalize formatting, enforce digits only, and ensure a reasonable length before returning the cleaned value.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizePhone #TODO
   * @param {string} phoneInputCandidate - Input phone number string.
   * @returns {string|null} Normalized phone number (digits only) or null if invalid.
   */
  static sanitizePhone(phoneInputCandidate) {
    // Reject non-string inputs immediately
    if (typeof phoneInputCandidate !== "string") {
      // Return null for invalid types
      return null;
    }
    // Trim whitespace from the candidate
    const trimmedPhoneString = phoneInputCandidate.trim();
    // Return null for empty strings
    if (trimmedPhoneString === "") {
      // Return null when no digits remain
      return null;
    }
    // Remove common formatting characters to extract digits
    const digitsOnlyString = trimmedPhoneString.replace(/[\s\-()\.\+]/g, "");
    // Ensure the cleaned string contains only digits
    if (!/^\d+$/.test(digitsOnlyString)) {
      // Return null for non-digit characters
      return null;
    }
    // Validate the allowed length range for phone numbers
    if (digitsOnlyString.length < 7 || digitsOnlyString.length > 15) {
      // Return null when length falls outside expected boundaries
      return null;
    }
    // Return the normalized digit-only phone number
    return digitsOnlyString;
  }

  /**
   * Sanitize and validate IP addresses safely.
   * 
   * Validate IPv4 and IPv6 formats, enforce boundary rules, and return normalized strings when valid.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeIpAddress #TODO
   * @param {string} ipStringCandidate - Input IP address string.
   * @returns {string|null} Normalized IP address or null if invalid.
   */
  static sanitizeIpAddress(ipStringCandidate) {
    // Reject non-string inputs early
    if (typeof ipStringCandidate !== "string") {
      // Return null for invalid types
      return null;
    }
    // Trim whitespace from the candidate
    const trimmedIpString = ipStringCandidate.trim();
    // Return null when the trimmed string is empty
    if (trimmedIpString === "") {
      // Return null for empty inputs
      return null;
    }
    // Define a strict IPv4 matching pattern
    const ipv4Pattern = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    // Attempt IPv4 parsing
    const ipv4Match = trimmedIpString.match(ipv4Pattern);
    // Return normalized IPv4 when all octets are within range
    if (ipv4Match) {
      // Parse octets into numbers
      const octets = ipv4Match.slice(1).map(Number);
      // Validate octet ranges
      if (octets.every((octet) => octet >= 0 && octet <= 255)) {
        // Return the normalized IPv4 string
        return trimmedIpString;
      }
      // Reject IPv4 values with out-of-range octets
      return null;
    }
    // Define a permissive IPv6 pattern
    const ipv6Pattern = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    // Validate against the IPv6 pattern
    if (ipv6Pattern.test(trimmedIpString)) {
      // Count occurrences of the double colon shorthand
      const doubleColonCount = (trimmedIpString.match(/::/g) || []).length;
      // Only a single double colon is allowed
      if (doubleColonCount <= 1) {
        // Split segments for further inspection
        const segments = trimmedIpString.split(":");
        // Collect non-empty segments
        const nonEmptySegments = segments.filter(
          (segment) => segment.length > 0,
        );
        // Validate fully expanded IPv6 addresses
        if (doubleColonCount === 0 && segments.length === 8) {
          // Ensure each segment has valid hex digits
          if (
            segments.every((segment) => /^[0-9a-fA-F]{1,4}$/.test(segment))
          ) {
            // Return normalized lowercase IPv6 string
            return trimmedIpString.toLowerCase();
          }
        }
        // Handle IPv6 addresses that use :: shorthand
        else if (doubleColonCount === 1) {
          // Compute how many segments are missing due to the shorthand
          const missingSegments = 8 - nonEmptySegments.length;
          // Ensure shorthand is plausible and there are enough segments
          if (
            missingSegments > 0 &&
            missingSegments <= 7 &&
            nonEmptySegments.length >= 2
          ) {
            // Verify each explicit segment is well-formed
            if (
              nonEmptySegments.every((segment) =>
                /^[0-9a-fA-F]{1,4}$/.test(segment),
              )
            ) {
              // Return normalized lowercase IPv6 shorthand string
              return trimmedIpString.toLowerCase();
            }
          }
        }
      }
    }
    // Return null when no valid IP format matched
    return null;
  }

  /**
   * Merge entries into defaults safely.
   * 
   * Parse URL/search/data inputs into sanitized key/value pairs before applying defaults.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since 1.0.0
   * @updated -
   * @link https://docs.example.com/SafeUtils#parseArgs #TODO
   * @param {(URLSearchParams|string|Array|Object|null|undefined)} argumentSource - Source of entries.
   * @param {Object} [defaultValues={}] - Default key/value pairs.
   * @returns {Object} Resulting merged arguments object.
   */
  static parseArgs(argumentSource, defaultEntries = {}) {
    // Validate that defaults is a plain object
    if (
      // Ensure defaults exist
      !defaultEntries ||
      // Ensure defaults are of object type
      typeof defaultEntries !== "object" ||
      // Ensure defaults are not arrays
      Array.isArray(defaultEntries)
    ) {
      // Throw when defaults are invalid
    }
    // Clone defaults into the merged result
    const mergedResult = Object.assign({}, defaultEntries);
    // Define helper for assigning sanitized entries
    const assignSanitizedEntry = (parameterKey, parameterValue) => {
      // Reject prototype pollution keys
      if (
        parameterKey === "__proto__" ||
        parameterKey === "constructor" ||
        parameterKey === "prototype"
      ) {
        // Skip prohibited keys
        return;
      }
      // Preserve primitive values without additional sanitization
      if (
        typeof parameterValue === "number" ||
        typeof parameterValue === "boolean" ||
        parameterValue === null
      ) {
        // Directly assign safe primitives
        mergedResult[parameterKey] = parameterValue;
        // Exit helper after assignment
        return;
      }
      // Coerce other values to string
      const stringCandidate = String(parameterValue);
      // Sanitize the string representation
      let sanitizedEntry = SafeUtils.sanitizeTextField(stringCandidate);
      // Trim whitespace from the sanitized entry
      sanitizedEntry = sanitizedEntry.trim();
      // Assign the sanitized entry
      mergedResult[parameterKey] = sanitizedEntry;
    };
    // Return defaults when argumentSource is null or undefined
    if (argumentSource == null) {
      // Return defaults when argumentSource is null or undefined
      return mergedResult;
    }
    // Handle string query inputs
    if (typeof argumentSource === "string") {
      // Normalize the query string by trimming the leading question mark
      const queryString = argumentSource.startsWith("?")
        ? argumentSource.slice(1)
        : argumentSource;
      // Parse string into URLSearchParams
      const urlSearchParams = new URLSearchParams(queryString);
      // Iterate through parsed entries
      for (const [paramKey, paramValue] of urlSearchParams.entries()) {
        // Assign each sanitized entry
        assignSanitizedEntry(paramKey, paramValue);
      }
      // Return merged output for string argument
      return mergedResult;
    }
    // Handle URLSearchParams argument inputs directly
    if (argumentSource instanceof URLSearchParams) {
      // Iterate through URLSearchParams entries
      for (const [paramKey, paramValue] of argumentSource.entries()) {
        // Assign each sanitized entry
        assignSanitizedEntry(paramKey, paramValue);
      }
      // Return merged output for URLSearchParams argument
      return mergedResult;
    }
    // Handle array-of-pairs arguments
    if (Array.isArray(argumentSource)) {
      // Iterate through array entries
      for (const pair of argumentSource) {
        // Only process pairs that contain exactly two elements
        if (Array.isArray(pair) && pair.length === 2) {
          // Destructure the pair into key and value
          const [arrayPairKey, arrayPairValue] = pair;
          // Only handle string keys
          if (typeof arrayPairKey === "string") {
            // Coerce the value to string when needed
            const coercedPairValue =
              typeof arrayPairValue === "string"
                ? arrayPairValue
                : String(arrayPairValue);
            // Assign the sanitized entry for the coerced value
            assignSanitizedEntry(arrayPairKey, coercedPairValue);
          }
        }
      }
      // Return merged output for array arguments
      return mergedResult;
    }
    // Handle plain object arguments
    if (typeof argumentSource === "object") {
      // Iterate through object entries
      for (const [objectKey, objectValue] of Object.entries(argumentSource)) {
        // Assign entries only when keys are strings
        if (typeof objectKey === "string") {
          // Assign the sanitized entry for the object value
          assignSanitizedEntry(objectKey, objectValue);
        }
      }
      // Return merged output for object arguments
      return mergedResult;
    }
    // Return defaults when argument type is unsupported
    return mergedResult;
  }

  /**
   * Parse a URL into parts safely.
   * 
   * Light URL parser supporting absolute and relative inputs; optionally returns one component.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since 1.0.0
   * @updated -
   * @link https://docs.example.com/SafeUtils#parseUrl #TODO
   * @param {string} rawUrlString - URL string to parse.
   * @param {string|null} [requestedComponentKey=null] - Specific component key to return.
   * @returns {(false|Object|string|null)} False if invalid; parts object or selected component.
   */
  static parseUrl(rawUrlString, requestedComponentKey = null) {
    // Reject invalid raw URL strings
    if (typeof rawUrlString !== "string" || rawUrlString.length === 0) {
      // Return false when URL is not a non-empty string
      return false;
    }
    // Reject excessively long inputs
    if (rawUrlString.length > 4096) {
      // Return false when URL exceeds safe length
      return false;
    }
    // Reject control characters within the raw URL
    if (/[\u0000-\u001F\u007F]/.test(rawUrlString)) {
      // Return false when control characters are present
      return false;
    }
    // Attempt to parse the URL safely
    try {
      // Construct a URL instance with a base to support relative strings
      const parsedUrlInstance = new URL(rawUrlString, "http://_base_/");
      // Identify whether the input is absolute
      const isAbsoluteInput = /^[A-Za-z][A-Za-z0-9+.\-]*:/.test(rawUrlString);
      // Build parsed component map
      const parsedComponents = {
        // Include scheme for absolute inputs only
        scheme: isAbsoluteInput
          ? parsedUrlInstance.protocol.replace(/:$/, "") || ""
          : "",
        host: isAbsoluteInput ? parsedUrlInstance.hostname || "" : "",
        port:
          isAbsoluteInput && parsedUrlInstance.port
            ? Number(parsedUrlInstance.port)
            : null,
        path: parsedUrlInstance.pathname || "",
        query: parsedUrlInstance.search
          ? parsedUrlInstance.search.replace(/^\?/, "")
          : "",
        fragment: parsedUrlInstance.hash
          ? parsedUrlInstance.hash.replace(/^#/, "")
          : "",
      };
      // Return the components map when no specific key is requested
      if (requestedComponentKey == null) {
        // Return the full component map
        return parsedComponents;
      }
      // Reject host or scheme requests for relative inputs
      if (
        !isAbsoluteInput &&
        ["host", "scheme", "port"].includes(requestedComponentKey)
      ) {
        // Return false for unavailable components
        return false;
      }
      // Return raw relative string when path requested without leading slash
      if (
        requestedComponentKey === "path" &&
        !isAbsoluteInput &&
        !rawUrlString.startsWith("/")
      ) {
        // Return the original relative path
        return rawUrlString;
      }
      // Return requested component when it exists within the map
      if (
        Object.prototype.hasOwnProperty.call(
          parsedComponents,
          requestedComponentKey,
        )
      ) {
        // Return the desired component value
        return parsedComponents[requestedComponentKey];
      }
      // Return false for unknown component keys
      return false;
    }
    // Handle parsing failures gracefully
    catch (parseError) {
      // Return false when parsing throws
      return false;
    }
  }

  /**
   * Add or update query arguments safely.
   * 
   * Accepts a key/value pair or params object, preserving fragments and existing parameters.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since 1.0.0
   * @updated -
   * @link https://docs.example.com/SafeUtils#addQueryArg #TODO
   * @param {(Object|string|number|null|undefined)} parameterKeyOrMap - Key name or params object.
   * @param {*} valueOrUrlCandidate - Value for key, or URL when parameterKeyOrMap is a params object.
   * @param {(string|number|undefined)} targetUrlCandidate - URL when parameterKeyOrMap is a single key.
   * @returns {string} URL with updated query string.
   */
  static addQueryArg(
    parameterKeyOrMap,
    valueOrUrlCandidate,
    targetUrlCandidate,
  ) {
    // Helper to apply parameters to a URL string
    const applyQueryParamsToUrl = (baseUrl, parameterMap) => {
      // Attempt to create a URL instance
      let urlInstance;
      try {
        // Build URL instance from base
        urlInstance = new URL(baseUrl);
      }
      // Return base URL when parsing fails
      catch {
        // Return unmodified base when URL creation fails
        return baseUrl;
      }
      // Access current search parameters
      const searchParams = urlInstance.searchParams;
      // Iterate through provided parameter entries
      for (const [parameterKey, parameterValue] of Object.entries(parameterMap)) {
        // Skip keys that are not strings or numbers
        if (typeof parameterKey !== "string" && typeof parameterKey !== "number") {
          // Continue when encountering disallowed keys
          continue;
        }
        // Remove parameters when value is nullish
        if (parameterValue === null || parameterValue === undefined) {
          // Delete the parameter when absent
          searchParams.delete(String(parameterKey));
        } else {
          try {
            // Set or update the parameter
            searchParams.set(String(parameterKey), String(parameterValue));
          }
          // Skip setting when value causes errors
          catch {
            // Skip invalid parameter values
          }
        }
      }
      // Update the URL search string with serialized params
      urlInstance.search = searchParams.toString();
      // Return the sanitized URL string
      return urlInstance.toString();
    };
    // Handle object argument containing parameter mappings
    if (
      typeof parameterKeyOrMap === "object" &&
      parameterKeyOrMap !== null &&
      !Array.isArray(parameterKeyOrMap)
    ) {
      // Apply object entries directly to the provided URL
      return applyQueryParamsToUrl(
        String(valueOrUrlCandidate || ""),
        parameterKeyOrMap,
      );
    }
    // Normalize arguments when single key/value provided
    const parameterKey = parameterKeyOrMap;
    // Preserve the provided value or URL candidate for assignment
    const parameterValue = valueOrUrlCandidate;
    // Ensure we always operate on a string URL
    const targetUrlString = String(targetUrlCandidate || "");
    // Return the target URL when the key is invalid
    if (typeof parameterKey !== "string" && typeof parameterKey !== "number") {
      // Return the sanitized target URL unchanged
      return targetUrlString;
    }
    // Apply the single parameter to the target URL
    return applyQueryParamsToUrl(targetUrlString, {
      [String(parameterKey)]: parameterValue,
    });
  }

  /**
   * Infer array element type safely.
   * 
   * Returns a simple annotation like "number[]" or "mixed[]" without deep schema checks.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since 1.0.0
   * @updated -
   * @link https://docs.example.com/SafeUtils#getArrayType #TODO
   * @param {Array} arrayInputCandidate - Array to analyze.
   * @returns {string} Element type annotation for the array.
   */
  static getArrayType(arrayInputCandidate) {
    // Ensure the argument is an array
    if (!Array.isArray(arrayInputCandidate)) {
      // Throw when the input is not an array
      throw new TypeError("getArrayType(): expected an array input");
    }
    // Return mixed[] for empty arrays
    if (arrayInputCandidate.length === 0) {
      // Return default annotation for empty inputs
      return "mixed[]";
    }
    // Map each element to its inferred type
    const elementTypeSignatures = arrayInputCandidate.map((elementValue) => {
      // Handle nested arrays recursively
      if (Array.isArray(elementValue)) {
        // Determine nested array type
        return SafeUtils.getArrayType(elementValue);
      }
      // Return the primitive type of the element
      return typeof elementValue;
    });
    // Deduplicate the type signatures
    const uniqueElementTypes = [...new Set(elementTypeSignatures)];
    // Return single type annotation when uniform
    if (uniqueElementTypes.length === 1) {
      // Append array suffix to the uniform type
      return uniqueElementTypes[0] + "[]";
    }
    // Return mixed[] when multiple types exist
    return "mixed[]";
  }

  /**
   * Format error message safely.
   * 
   * Creates and returns a new TypeError with the given method name and message.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since 1.0.0
   * @updated -
   * @link https://docs.example.com/SafeUtils#formatError #TODO
   * @param {string} methodIdentifier - The method name associated with the error.
   * @param {string} errorMessage - The error message to include.
   * @returns {TypeError} A new TypeError instance with formatted message.
   */
  static formatError(methodIdentifier, errorMessage) {
    // Coerce method identifier to string
    const methodIdentifierString = String(methodIdentifier);
    // Coerce error message to string
    const messageDetail = String(errorMessage);
    // Return the formatted TypeError instance
    return new TypeError(`${methodIdentifierString}(): ${messageDetail}`);
  }

  /**
   * Sanitize HTML with a whitelist safely.
   * 
   * Removes disallowed tags/attributes, comments, and optionally escapes text nodes.
   * 
   * @author Linden May
   * @version 1.0.0
   * @since 1.0.0
   * @updated -
   * @link https://docs.example.com/SafeUtils#sanitizeHtmlWithWhitelist #TODO
   * @param {string} rawHtmlInput - Raw HTML input to sanitize.
   * @param {boolean} shouldEscapeTextNodesFlag - Whether to escape special characters in text nodes.
   * @returns {string} Sanitized HTML string.
   */
  static sanitizeHtmlWithWhitelist(rawHtmlInput, shouldEscapeTextNodesFlag = false) {
    // Return empty string for non-string or empty inputs
    if (typeof rawHtmlInput !== "string" || rawHtmlInput === "") {
      // Return empty string when input is invalid
      return "";
    }
    // Use cached JSDOM implementation when available
    let JSDOMImplementation = SafeUtils._JSDOM || null;
    // Load JSDOM if not already loaded
    if (!JSDOMImplementation) {
      try {
        // Destructure JSDOM from the module
        ({ JSDOM: JSDOMImplementation } = require("jsdom"));
      }
      // Fallback when JSDOM cannot be loaded
      catch {
        // Strip tags and trim fallback text
        let fallbackResult = rawHtmlInput.replace(/<[^>]*>/g, "").trim();
        // Escape text nodes when requested
        if (shouldEscapeTextNodesFlag) {
          // Escape HTML special characters in the fallback
          fallbackResult = fallbackResult
            // Escape ampersands first
            .replace(/&/g, "&amp;")
            // Escape less-than signs
            .replace(/</g, "&lt;")
            // Escape greater-than signs
            .replace(/>/g, "&gt;")
            // Escape double quotes
            .replace(/"/g, "&quot;")
            // Escape single quotes
            .replace(/'/g, "&#39;");
        }
        // Return the fallback result
        return fallbackResult;
      }
    }
    // Create a DOM instance wrapping the HTML input
    const domInstance = new JSDOMImplementation(`<body>${rawHtmlInput}</body>`);
    // Destructure the sanitized document from the DOM
    const { document: sanitizedDocument } = domInstance.window;
    // Define allowed tags and their permitted attributes
    const allowedTagAttributes = {
      // Define attributes allowed for anchor tags
      A: ["href", "title", "target", "rel"],
      // Define attributes allowed for abbreviation tags
      ABBR: ["title"],
      // Define attributes allowed for bold tags
      B: [],
      // Define attributes allowed for blockquote tags
      BLOCKQUOTE: ["cite"],
      // Define attributes allowed for line break tags
      BR: [],
      // Define attributes allowed for citation tags
      CITE: [],
      // Define attributes allowed for code tags
      CODE: [],
      // Define attributes allowed for deletion tags
      DEL: ["datetime"],
      // Define attributes allowed for emphasis tags
      EM: [],
      // Define attributes allowed for italic tags
      I: [],
      // Define attributes allowed for inserted text tags
      INS: ["datetime"],
      // Define attributes allowed for list item tags
      LI: [],
      // Define attributes allowed for ordered list tags
      OL: [],
      // Define attributes allowed for paragraph tags
      P: [],
      // Define attributes allowed for quote tags
      Q: ["cite"],
      // Define attributes allowed for span tags
      SPAN: [],
      // Define attributes allowed for strong tags
      STRONG: [],
      // Define attributes allowed for unordered list tags
      UL: [],
    };
    // Determine whether a tag is allowed
    const isTagAllowed = (elementNode) =>
      // Check allowedTagAttributes map for the node name
      Object.prototype.hasOwnProperty.call(allowedTagAttributes, elementNode.tagName);
    // Recursively sanitize DOM nodes
    function sanitizeNode(domNode) {
      // Iterate children in reverse to allow safe removals
      for (let i = domNode.childNodes.length - 1; i >= 0; i--) {
        // Extract the current child node
        const childNode = domNode.childNodes[i];
        // Handle element nodes
        if (childNode.nodeType === 1) {
          // Determine uppercase tag name
          const tagName = childNode.tagName.toUpperCase();
          // Replace disallowed tags with text nodes
          if (!isTagAllowed(childNode)) {
            // Create a text node with the original text content
            const replacementTextNode = sanitizedDocument.createTextNode(
              // Use the child text content or default to empty string
              childNode.textContent || "",
            );
            // Replace the element with text
            domNode.replaceChild(replacementTextNode, childNode);
            // Continue processing the remaining nodes
            continue;
          }
          // Build a set of allowed attributes for the tag
          const allowedAttributeSet = new Set(allowedTagAttributes[tagName]);
          // Iterate through attributes to drop disallowed ones
          for (const attr of Array.from(childNode.attributes)) {
            // Remove attributes not in the allowed set
            if (!allowedAttributeSet.has(attr.name)) {
              childNode.removeAttribute(attr.name);
            }
          }
          // Additional cleanup for anchor tags
          if (tagName === "A") {
            // Get the raw href attribute
            const rawHrefValue = childNode.getAttribute("href");
            // Sanitize the href attribute
            let sanitizedHrefValue = SafeUtils.escUrl(rawHrefValue, ["http:", "https:"]);
            // Remove trailing slash from sanitized href
            if (sanitizedHrefValue && sanitizedHrefValue.endsWith("/")) {
              // Trim trailing slash
              sanitizedHrefValue = sanitizedHrefValue.slice(0, -1);
            }
            // Replace the link with text when href is unsafe
            if (!sanitizedHrefValue) {
              // Create a text node fallback
              const anchorReplacementText = sanitizedDocument.createTextNode(
                // Use the anchor text content or default to empty string
                childNode.textContent || "",
              );
              // Replace the anchor with text
              domNode.replaceChild(anchorReplacementText, childNode);
              // Continue iterating other nodes
              continue;
            }
            // Set the sanitized href attribute
            childNode.setAttribute("href", sanitizedHrefValue);
            // Enforce noopener/noreferrer when opening in new tab
            if (childNode.getAttribute("target") === "_blank") {
              // Set rel attribute to prevent tabnabbing
              childNode.setAttribute("rel", "noopener noreferrer");
            }
          }
          // Recursively sanitize children of this element
          sanitizeNode(childNode);
          // Continue to the next sibling
          continue;
        }
        // Remove comment nodes
        if (childNode.nodeType === 8) {
          // Delete the comment from the DOM
          domNode.removeChild(childNode);
          // Continue to next child
          continue;
        }
        // Escape text nodes when requested
        if (childNode.nodeType === 3 && shouldEscapeTextNodesFlag) {
          // Retrieve the current text node value
          const textNodeValue = childNode.nodeValue || "";
          // Escape quotes within the text node
          const escapedTextNodeValue = SafeUtils.escapeHtmlQuotes(textNodeValue);
          // Update the node when escaped content differs
          if (escapedTextNodeValue !== textNodeValue) {
            // Assign the escaped text back to the node
            childNode.nodeValue = escapedTextNodeValue;
          }
        }
      }
    }
    // Start sanitizing from the document body
    sanitizeNode(sanitizedDocument.body);
    // Capture the sanitized HTML string
    let sanitizedResult = sanitizedDocument.body.innerHTML;
    // Normalize escaped quotes when text node escaping was applied
    if (shouldEscapeTextNodesFlag) {
      // Replace double-escaped ampersand quotes
      sanitizedResult = sanitizedResult
        // Replace double-escaped double quotes
        .replace(/&amp;quot;/g, "&quot;")
        // Replace double-escaped single quotes
        .replace(/&amp;#39;/g, "&#39;");
    }
    // Return the sanitized HTML output
    return sanitizedResult;
  }
}

// Set static defaults outside of the class to avoid unsupported syntax.
SafeUtils.DEBUG = false;
SafeUtils._regexCache = new LRUCache({
  max: 500,
  updateAgeOnGet: false,
  updateAgeOnHas: false,
});

module.exports = SafeUtils;