/*
 * Methods:
 *    identifyDateFormatFromString() — Determine the detected format for a date string.
 *    generateRelativeTimestamp() — Generate a formatted timestamp optionally offset by an interval.
 *    parseIntervalToDuration() — Translate an interval descriptor into a Luxon Duration.
 *    resolveTimeZone() — Resolve an input timezone string or fall back to the default zone.
 *    applyIntervalToDateTime() — Apply an interval directive to a base Luxon DateTime.
 *    hasExceededTimestamp() — Determine whether the provided timestamp goes past the current moment.
 *    phpToLuxonFormat() — Translate PHP-style date tokens into Luxon format tokens.
 *    parseStringToLuxon() — Parse a string or timestamp into a Luxon DateTime with optional zone override.
 *    parseDateToTimestamp() — Convert a date string into a Unix timestamp in seconds.
 *    diffInSeconds() — Compute the number of seconds between two date strings.
 *    diffInHumanReadable() — Generate a human-friendly span between two dates.
 *    isValidDate() — Validates whether a date string matches a specific format exactly.
 *    getStartOfDay() — Returns the start of the day (00:00:00) for a given date.
 *    getEndOfDay() — Returns the end of the day (23:59:59) for a given date.
 *    addDays() — Add a number of days to a given date string.
 *    getNextOccurrence() — Calculate the next weekday occurrence at a specified time.
 *    convertTimezone() — Convert a value into a datetime string in another timezone.
 *    buildDateTimeForConversion() — Build a Luxon DateTime from various input types for conversion helpers.
 *    isPast() — Determine whether the provided date string refers to a past moment.
 *    isFuture() — Determine whether the provided date string occurs in the future.
 *    isBetween() — Check whether a date string lies within a provided range.
 *    isValidFormat() — Validate whether the provided format string is supported.
 *    now() — Returns the current time formatted, with optional timezone.
 *    timeToMinutes() — Converts a time string (HH:mm or HH:mm:ss) to total minutes.
 *    getRelativeTime() — Convert a Unix timestamp into a condensed relative label.
 *    formatPrettyRelativeTime() — Return a human-friendly relative time string like '2 minutes ago'.
 *    formatDate() — Converts a date from one format to another.
 *    getDefaultTimeZone() — Return the current default timezone applied by helpers.
 *    setDefaultTimeZone() — Configure the default timezone used by future helpers.
 *    normalizeToHongKong() — Normalize supported inputs into a Luxon DateTime set to the default zone.
 *    isWithinPastSeconds() — Assess whether a timestamp lies within the past N seconds.
 *    isWithinNextSeconds() — Determine if a timestamp occurs within the upcoming seconds window.
 *    isWithinRelativeWindow() — Check whether a timestamp is within a configurable past and future window.
 *    isDateStringWithinRelativeWindow() — Validate that a date string parses inside a relative window around now.
 *    isNowBetweenOffsetSeconds() — Check if the current time lies within offset bounds around a base timestamp.
 *    isTimestampBetween() — Determine whether a timestamp lies between two bounds.
 *    getTimezoneOffsetInMinutes() — Calculate the offset in minutes between two zones at a reference instant.
 *    getTimezoneOffsetFromHongKongToLocal() — Compute the minute offset from Hong Kong to a local zone.
 *    convertHongKongToLocal() — Convert a Hong Kong timestamp string into a specified local timezone.
 *    convertLocalToHongKong() — Convert a local timezone date string to Hong Kong/default timezone.
 *    toUnixTimestamp() — Convert supported values into a Unix timestamp in seconds.
 *    getDayOfWeek() — Determine the weekday index for a date string.
 *    getWeekNumber() — Retrieve the ISO week number for a date string.
 *    fromUnixTimestamp() — Format a Unix timestamp into a string in the desired timezone.
 *    isNowBetween() — Evaluate whether the current moment falls between two date strings.
 *    isDateTimeBetween() — Determine whether an arbitrary datetime falls inside a window, supporting overnight spans.
 *    doRangesOverlap() — Determine whether two date ranges overlap.
 *    listDaysInRange() — List each ISO date string for a range of days between two dates.
 */

"use strict";

const { DateTime: LuxonDateTime, Duration, Settings } = require("luxon");
const { LRUCache } = require("lru-cache");

// App-level defaults so every helper uses the same IANA zone and formatter.
// Keep the zone in sync with Luxon by applying it immediately.
// Default timezone shared across DateTime helpers.
const DEFAULT_TIME_ZONE = process.env.TIME_ZONE || "Asia/Hong_Kong";
// Default string format for output when none is provided.
const DEFAULT_OUTPUT_FORMAT = "yyyy-MM-dd HH:mm:ss";

// Apply the default timezone to Luxon's global Settings.
Settings.defaultZone = DEFAULT_TIME_ZONE;

/**
 * Class DateTime
 *
 * A collection of static methods for date and time manipulation using Luxon.
 *
 * @link #TODO
 */
class DateTime {
  // Reflects the compiled constant so callers can read it without instantiating.
  static DEFAULT_TIME_ZONE = DEFAULT_TIME_ZONE;
  // Tracks the runtime override when `setDefaultTimeZone` updates the zone.
  static _runtimeDefaultTimeZone = DEFAULT_TIME_ZONE;
  
  // Cache for expensive operations (performance optimization)
  // Using LRUCache for automatic eviction of old entries
  static #formatCache = new LRUCache({
    max: 500,
    updateAgeOnGet: false,
    updateAgeOnHas: false,
  }); // Cache for phpToLuxonFormat conversions
  static #timezoneCache = new LRUCache({
    max: 200,
    updateAgeOnGet: false,
    updateAgeOnHas: false,
  }); // Cache for timezone validations
  
  /**
   * Get cached format conversion or compute and cache (performance optimization).
   *
   * Caches phpToLuxonFormat conversions to avoid repeated string operations.
   *
   * @param {string} phpFormat - PHP format string
   * @returns {string} Luxon format string
   */
  static #getCachedFormat(phpFormat) {
    if (!this.#formatCache.has(phpFormat)) {
      const luxonFormat = this.phpToLuxonFormat(phpFormat);
      this.#formatCache.set(phpFormat, luxonFormat);
    }
    return this.#formatCache.get(phpFormat);
  }
  
  // Common date format constants for easier use
  static FORMATS = Object.freeze({
    ISO_DATE: "yyyy-MM-dd",
    ISO_DATETIME: "yyyy-MM-dd HH:mm:ss",
    ISO_DATETIME_MS: "yyyy-MM-dd HH:mm:ss.SSS",
    ISO_DATETIME_TZ: "yyyy-MM-dd'T'HH:mm:ssZZ",
    ISO_DATETIME_MS_TZ: "yyyy-MM-dd'T'HH:mm:ss.SSSZZ",
    US_DATE: "MM/dd/yyyy",
    US_DATETIME: "MM/dd/yyyy HH:mm:ss",
    EU_DATE: "dd/MM/yyyy",
    EU_DATETIME: "dd/MM/yyyy HH:mm:ss",
    UK_DATE: "dd-MM-yyyy",
    UK_DATETIME: "dd-MM-yyyy HH:mm:ss",
    TIME_24: "HH:mm:ss",
    TIME_12: "hh:mm:ss a",
    DATE_TIME_COMPACT: "yyyyMMddHHmmss",
    DATE_COMPACT: "yyyyMMdd",
    MONTH_YEAR: "MMMM yyyy",
    MONTH_DAY: "MMMM d",
    DAY_NAME: "EEEE",
    DAY_SHORT: "EEE",
    MONTH_NAME: "MMMM",
    MONTH_SHORT: "MMM",
    YEAR_MONTH: "yyyy-MM",
    RFC822: "EEE, dd MMM yyyy HH:mm:ss ZZZ",
    RFC3339: "yyyy-MM-dd'T'HH:mm:ssZZ",
    UNIX_TIMESTAMP: "X", // Unix timestamp in seconds
    UNIX_TIMESTAMP_MS: "x", // Unix timestamp in milliseconds
  });

  /**
   * Detect format identifier.
   *
   * Evaluate the string to determine which known format it matches.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#identifyDateFormatFromString #TODO
   * @param {string} inputDateString - Input string to examine.
   * @returns {string|false} Format identifier or false when detection fails.
   */
  static identifyDateFormatFromString(inputDateString) {
    // Validate the input is a non-empty string
    if (typeof inputDateString !== "string" || !inputDateString.trim()) {
      // Return false when the input cannot be interpreted
      return false;
    }
    // Trim whitespace from the input
    const trimmedDateString = inputDateString.trim();
    // Check if the string contains an ISO T separator
    if (trimmedDateString.includes("T")) {
      // Attempt to parse the value as ISO format
      const isoParsingResult = LuxonDateTime.fromISO(trimmedDateString);
      // Confirm the ISO parse result is valid
      if (isoParsingResult.isValid) {
        // Return iso identifier when parsing succeeds
        return "iso";
      }
    }
    // Detect full datetime when a space separates date and time
    if (trimmedDateString.includes(" ")) {
      // Return the Y-m-d H:i:s identifier for full datetime
      return "Y-m-d H:i:s";
    }
    // Count dash separators to infer date structure
    const dashSeparatorCount = (trimmedDateString.match(/-/g) || []).length;
    // When two dashes are present treat as Y-m-d
    if (dashSeparatorCount === 2) {
      // Split into segments to verify numeric content
      const fullDateSegments = trimmedDateString.split("-");
      // Confirm all three segments are digits
      if (
        fullDateSegments.length === 3 &&
        fullDateSegments.every((dateSegment) => /^\d+$/.test(dateSegment))
      ) {
        // Return full date identifier
        return "Y-m-d";
      }
    }
    // When one dash is present treat as Y-m
    if (dashSeparatorCount === 1) {
      // Split into year and month parts
      const yearMonthParts = trimmedDateString.split("-");
      // Confirm both year and month segments are numeric
      if (
        yearMonthParts.length === 2 &&
        yearMonthParts.every((dateSegment) => /^\d+$/.test(dateSegment))
      ) {
        // Return year-month identifier
        return "Y-m";
      }
    }
    // Check for a plain four-digit year string
    if (inputDateString.length === 4 && /^\d{4}$/.test(inputDateString)) {
      // Return year identifier when string is exactly four digits
      return "Y";
    }
    // Return false when no format can be detected
    return false;
  }

  /**
   * Generate a formatted timestamp optionally offset by an interval.
   *
   * Build a Luxon DateTime in the resolved zone and format the output accordingly.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#generateRelativeTimestamp #TODO
   * @param {string} outputFormatCandidate - Desired Luxon format string.
   * @param {string|number|null} intervalDescriptor - Offset interval or Unix timestamp to apply.
   * @param {string|null} overrideTimeZone - Optional IANA timezone override.
   * @returns {string|false} Formatted timestamp or false when adjustment fails.
   */
  static generateRelativeTimestamp(
    outputFormatCandidate = DEFAULT_OUTPUT_FORMAT,
    intervalDescriptor = null,
    overrideTimeZone = null,
  ) {
    // Resolve the timezone to operate in
    const resolvedTimeZone = this.resolveTimeZone(overrideTimeZone);
    // Build the baseline DateTime in the resolved timezone
    let baselineDateTimeInResolvedZone = LuxonDateTime.now().setZone(resolvedTimeZone);
    // Check if the baseline DateTime is invalid in the resolved zone
    if (!baselineDateTimeInResolvedZone.isValid) {
      // Recreate the DateTime using the runtime default timezone
      baselineDateTimeInResolvedZone = LuxonDateTime.now().setZone(this.getDefaultTimeZone());
    }
    // Choose the output format or use the default pattern
    const formatPatternToUse = outputFormatCandidate || DEFAULT_OUTPUT_FORMAT;
    // When no interval descriptor is provided, format the baseline directly
    if (intervalDescriptor === null || intervalDescriptor === undefined) {
      // Return the formatted baseline timestamp
      return baselineDateTimeInResolvedZone.toFormat(formatPatternToUse);
    }
    // Apply the interval descriptor or unix timestamp
    const intervalAdjustedDateTime = this.applyIntervalToDateTime(baselineDateTimeInResolvedZone, intervalDescriptor, resolvedTimeZone);
    // Ensure the adjusted DateTime is valid
    if (!intervalAdjustedDateTime || !intervalAdjustedDateTime.isValid) {
      // Return false when adjustment cannot be applied
      return false;
    }
    // Format and return the adjusted DateTime
    return intervalAdjustedDateTime.toFormat(formatPatternToUse);
  }

  /**
   * Translate an interval descriptor into a Luxon Duration.
   *
   * Parse value-unit pairs from the string and accumulate totals per unit.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#parseIntervalToDuration #TODO
   * @param {string} intervalDescriptorString - Relative interval string to evaluate.
   * @returns {Duration} Duration object representing the parsed interval.
   */
  static parseIntervalToDuration(intervalDescriptorString) {
    // Validate the interval descriptor is a non-empty string
    if (typeof intervalDescriptorString !== "string" || !intervalDescriptorString.trim()) {
      // Throw when the descriptor format is invalid
      throw new Error("Invalid interval format");
    }
    // Define the regex pattern for interval tokens
    const intervalTokenPattern = /([+-]?\d+)\s*(second|minute|hour|day|week|month|year)s?/gi;
    // Match all tokens from the interval descriptor
    const matchedIntervalTokens = [...intervalDescriptorString.matchAll(intervalTokenPattern)];
    // Throw when the descriptor contains no recognizable tokens
    if (!matchedIntervalTokens.length) {
      // Throw when the descriptor format is invalid
      throw new Error("Invalid interval format");
    }
    // Initialize the duration accumulator
    const durationTotalsByUnit = {};
    // Iterate each matched token to accumulate totals
    matchedIntervalTokens.forEach((matchedToken) => {
      // Extract the numeric quantity from the token
      const matchedQuantity = parseInt(matchedToken[1], 10);
      // Normalize the unit name to lowercase
      const matchedUnit = matchedToken[2].toLowerCase();
      // Add the quantity to the corresponding unit total
      durationTotalsByUnit[matchedUnit] =
        (durationTotalsByUnit[matchedUnit] || 0) + matchedQuantity;
    });
    // Return the Duration constructed from the totals
    return Duration.fromObject(durationTotalsByUnit);
  }

  /**
   * Resolve an input timezone string or fall back to the default zone.
   *
   * Validate the trimmed timezone using Luxon and return it when valid.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#resolveTimeZone #TODO
   * @param {string|null} timeZoneInput - Candidate timezone identifier.
   * @returns {string} Final timezone to use.
   */
  static resolveTimeZone(timeZoneInput) {
    // Validate that the timezone input is a non-empty string
    if (typeof timeZoneInput === "string" && timeZoneInput.trim()) {
      // Trim whitespace from the timezone input
      const normalizedTimeZoneInput = timeZoneInput.trim();
      // Return cached value when available
      if (this.#timezoneCache.has(normalizedTimeZoneInput)) {
        return this.#timezoneCache.get(normalizedTimeZoneInput);
      }
      // Build a DateTime to validate the normalized timezone
      const validationDateTimeForNormalizedZone = LuxonDateTime.now().setZone(
        normalizedTimeZoneInput,
      );
      // Cache and return the normalized value when valid
      if (validationDateTimeForNormalizedZone.isValid) {
        this.#timezoneCache.set(normalizedTimeZoneInput, normalizedTimeZoneInput);
        return normalizedTimeZoneInput;
      }
    }
    // Default to the runtime default timezone when input is invalid
    const fallbackTimeZone = this.getDefaultTimeZone();
    // Cache the fallback for the provided input when possible
    if (timeZoneInput && typeof timeZoneInput === "string") {
      this.#timezoneCache.set(timeZoneInput.trim(), fallbackTimeZone);
    }
    // Return the fallback timezone
    return fallbackTimeZone;
  }

  /**
   * Apply an interval directive to a base Luxon DateTime.
   *
   * Support numeric timestamps or human-friendly interval strings to adjust the base.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#applyIntervalToDateTime #TODO
   * @param {LuxonDateTime} baseDateTime - DateTime to adjust.
   * @param {string|number} intervalDescriptorOrUnixTimestamp - Interval string or Unix timestamp.
   * @param {string|null} targetZoneIdentifier - Timezone to apply for numeric timestamps.
   * @returns {LuxonDateTime|null} Adjusted DateTime or null when invalid.
   */
  static applyIntervalToDateTime(
    baseDateTime,
    intervalDescriptorOrUnixTimestamp,
    targetZoneIdentifier,
  ) {
    // Handle numeric intervals by interpreting as Unix seconds
    if (typeof intervalDescriptorOrUnixTimestamp === "number") {
      // Build numeric DateTime from Unix seconds in the target zone
      const numericDateTimeInTargetZone = LuxonDateTime.fromSeconds(intervalDescriptorOrUnixTimestamp).setZone(
        // Apply the target timezone identifier
        targetZoneIdentifier,
      // Close the target zone assignment
      );
      // Check numeric DateTime validity
      if (numericDateTimeInTargetZone.isValid) {
        // Return numeric DateTime when valid
        return numericDateTimeInTargetZone;
      }
      // Fall back to default timezone when numeric DateTime invalid
      return LuxonDateTime.fromSeconds(intervalDescriptorOrUnixTimestamp).setZone(
        // Apply the default timezone identifier
        this.getDefaultTimeZone(),
      // Close the default timezone assignment
      );
    }
    // Handle string intervals by parsing them into durations
    if (
      // Check that the descriptor is a string
      typeof intervalDescriptorOrUnixTimestamp === "string" &&
      // Ensure the descriptor contains non-whitespace characters
      intervalDescriptorOrUnixTimestamp.trim()
    ) {
      // Attempt to parse the descriptor as a Duration
      try {
        // Convert the interval descriptor into a Duration
        const parsedDuration = this.parseIntervalToDuration(intervalDescriptorOrUnixTimestamp);
        // Return the DateTime adjusted by the parsed duration
        return baseDateTime.plus(parsedDuration);
      // Catch duration parsing failures
      } catch (durationParsingError) {
        // Return null when parsing fails
        return null;
      }
    }
    // Return null for unsupported interval descriptors
    return null;
  }

  /**
   * Determine whether the provided timestamp goes past the current moment.
   *
   * Parse the timestamp and optional interval, then compare the offset value to now.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#hasExceededTimestamp #TODO
   * @param {string} timestampString - The timestamp string to evaluate.
   * @param {string} [relativeIntervalDescriptor] - Optional relative interval to shift the timestamp.
   * @returns {boolean} True when now is after the computed timestamp.
   */
  static hasExceededTimestamp(
    timestampString,
    relativeIntervalDescriptor = "",
  ) {
    // Parse the timestamp string into a Luxon DateTime
    const parsedLocalDateTime = this.parseStringToLuxon(timestampString, "local");
    // Validate that the parsed DateTime is present and valid
    if (!parsedLocalDateTime || !parsedLocalDateTime.isValid) {
      // Return false when parsing fails
      return false;
    }
    // Set the reference time in the default timezone
    let referenceDateTimeInDefaultZone = parsedLocalDateTime.setZone(this.getDefaultTimeZone());
    // Ensure the reference DateTime is valid
    if (!referenceDateTimeInDefaultZone.isValid) {
      // Return false when the reference DateTime is invalid
      return false;
    }
    // Check if an interval descriptor string is provided
    if (
      // Confirm the descriptor is non-empty
      relativeIntervalDescriptor &&
      // Confirm the descriptor is a string
      typeof relativeIntervalDescriptor === "string"
    ) {
      // Attempt to parse the interval into a Duration
      try {
        // Create a Duration from the interval descriptor
        const intervalDuration = this.parseIntervalToDuration(relativeIntervalDescriptor);
        // Add the interval to the reference DateTime
        referenceDateTimeInDefaultZone = referenceDateTimeInDefaultZone.plus(intervalDuration);
      } catch (intervalParsingError) {
        // Return false when interval parsing fails
        return false;
      }
    }
    // Build the current moment in Hong Kong time
    const currentHongKongDateTime = LuxonDateTime.now().setZone("Asia/Hong_Kong");
    // Return whether the reference is before now
    return currentHongKongDateTime > referenceDateTimeInDefaultZone;
  }

  /**
   * Translate PHP-style date tokens into Luxon format tokens.
   *
   * Provide a replacement map to swap recognized PHP characters with Luxon tokens.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#phpToLuxonFormat #TODO
   * @param {string} rawPhpFormatString - PHP-style format string.
   * @returns {string} Format string with Luxon-compatible tokens.
   */
  static phpToLuxonFormat(rawPhpFormatString) {
    // Validate that the input is a non-empty string
    if (
      // Check that the input value is a string
      typeof rawPhpFormatString !== "string" ||
      // Ensure the string is not empty
      rawPhpFormatString.length === 0
    ) {
      // Return an empty string when the input is invalid
      return "";
    }
    // Define the PHP-to-Luxon token map
    const phpToLuxonTokenMap = {
      // Map four-digit years
      Y: "yyyy",
      // Map two-digit years
      y: "yy",
      // Map zero-padded months
      m: "MM",
      // Map non-padded months
      n: "M",
      // Map zero-padded days
      d: "dd",
      // Map minimal day number
      j: "d",
      // Map 24-hour hours
      H: "HH",
      // Map 12-hour hours with leading zero
      h: "hh",
      // Map 12-hour hours without leading zero
      g: "h",
      // Map minutes
      i: "mm",
      // Map seconds
      s: "ss",
      // Map lowercase meridiem
      a: "a",
      // Map uppercase meridiem
      A: "a",
    };
    // Replace each PHP character using the map when available
    return rawPhpFormatString.replace(
      // Match every character
      /./g,
      // Swap the character with the mapped token or keep it
      (phpCharacter) => phpToLuxonTokenMap[phpCharacter] || phpCharacter,
    );
  }

  /**
   * Parse string or timestamp into Luxon DateTime.
   *
   * Detect the format, choose the zone, and return a Luxon object when valid.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#parseStringToLuxon #TODO
   * @param {string} inputDateString - Input string to parse.
   * @param {string|null} zoneOverride - Optional IANA timezone name.
   * @returns {LuxonDateTime|false} Parsed DateTime or false on failure.
   */
  static parseStringToLuxon(inputDateString, zoneOverride = null) {
    // Detect the format associated with the input
    const detectedInputFormat = this.identifyDateFormatFromString(inputDateString);
    // Return false when the format cannot be detected
    if (!detectedInputFormat) {
      // Return false when detection fails
      return false;
    }
    // Resolve the zone identifier for parsing
    const resolvedZoneIdentifier = zoneOverride || this.getDefaultTimeZone();
    // Handle ISO inputs directly to avoid formatting translation
    if (detectedInputFormat === "iso") {
      // Parse the ISO string using the resolved timezone
      return LuxonDateTime.fromISO(inputDateString, {
        // Apply the resolved zone
        zone: resolvedZoneIdentifier,
      });
    }
    // Translate the detected format into Luxon tokens
    const translatedLuxonFormat = this.phpToLuxonFormat(detectedInputFormat);
    // Return false when translation yields no format
    if (!translatedLuxonFormat) {
      // Return false when translation fails
      return false;
    }
    // Parse the string using the translated format and resolved zone
    return LuxonDateTime.fromFormat(inputDateString, translatedLuxonFormat, {
      // Apply the resolved timezone
      zone: resolvedZoneIdentifier,
    });
  }

  /**
   * Convert a date string into a Unix timestamp in seconds.
   *
   * Use `parseStringToLuxon` before reducing to seconds.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#parseDateToTimestamp #TODO
   * @param {string} inputDateString - The string representing a date.
   * @param {string|null} timeZoneIdentifier - Optional timezone for parsing.
   * @returns {number|false} Unix timestamp in seconds or false on failure.
   */
  static parseDateToTimestamp(inputDateString, timeZoneIdentifier = null) {
    // Parse the date string into a Luxon DateTime
    const parsedLuxonDateTime = this.parseStringToLuxon(
      // Provide the input date string
      inputDateString,
      // Provide the optional timezone override
      timeZoneIdentifier,
    );
    // Validate the parsed DateTime object
    if (!parsedLuxonDateTime || !parsedLuxonDateTime.isValid) {
      // Return false when parsing fails
      return false;
    }
    // Return the floored Unix seconds value
    return Math.floor(parsedLuxonDateTime.toSeconds());
  }

  /**
   * Compute seconds difference between date strings.
   *
   * Convert both inputs to timestamps and subtract to obtain the delta.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#diffInSeconds #TODO
   * @param {string} sourceStartDateString - Starting point for the difference.
   * @param {string} sourceEndDateString - Ending point for the difference.
   * @returns {number|false} Seconds distance or false when inputs are invalid.
   */
  static diffInSeconds(
    sourceStartDateString,
    sourceEndDateString,
  ) {
    // Parse the start boundary timestamp
    const startBoundaryTimestampSeconds = this.parseDateToTimestamp(sourceStartDateString);
    // Parse the end boundary timestamp
    const endBoundaryTimestampSeconds = this.parseDateToTimestamp(sourceEndDateString);
    // Return false when either parse failed
    if (startBoundaryTimestampSeconds === false || endBoundaryTimestampSeconds === false) {
      // Return false when inputs are invalid
      return false;
    }
    // Return the difference between end and start timestamps
    return endBoundaryTimestampSeconds - startBoundaryTimestampSeconds;
  }

  /**
   * Generate human-friendly span between date strings.
   *
   * Build a description using the top units that cover the delta between inputs.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#diffInHumanReadable #TODO
   * @param {string} startDateString - Start date string.
   * @param {string} endDateString - End date string.
   * @returns {string|false} Readable span or false when inputs are invalid.
   */
  static diffInHumanReadable(startDateString, endDateString) {
    // Parse the start date string to a timestamp
    const startTimestampSeconds = this.parseDateToTimestamp(startDateString);
    // Parse the end date string to a timestamp
    const endTimestampSeconds = this.parseDateToTimestamp(endDateString);
    // Return false when either timestamp parse failed
    if (startTimestampSeconds === false || endTimestampSeconds === false) {
      // Return false when invalid inputs are supplied
      return false;
    }
    // Compute the absolute difference in seconds
    let remainingSeconds = Math.abs(
      // Calculate the raw difference between end and start timestamps
      endTimestampSeconds - startTimestampSeconds,
    );
    // Define the ordered units used for spans
    const timeUnits = [
      // Include years
      { name: "year", seconds: 31536000 },
      // Include months
      { name: "month", seconds: 2592000 },
      // Include days
      { name: "day", seconds: 86400 },
      // Include hours
      { name: "hour", seconds: 3600 },
      // Include minutes
      { name: "minute", seconds: 60 },
      // Include seconds
      { name: "second", seconds: 1 },
    ];
    // Prepare the accumulator for span segments
    const spanSegments = [];
    // Iterate through each unit definition
    for (const unitDefinition of timeUnits) {
      // Check if the remaining seconds can cover the current unit
      if (remainingSeconds >= unitDefinition.seconds) {
        // Determine how many whole units fit in the remaining seconds
        const wholeUnitCount = Math.floor(
          // Divide remaining seconds by the unit length
          remainingSeconds / unitDefinition.seconds,
        );
        // Push the formatted segment with pluralization
        spanSegments.push(
          // Build the segment label
          `${wholeUnitCount} ${unitDefinition.name}${
            wholeUnitCount !== 1 ? "s" : ""
          }`,
        );
        // Subtract the accounted seconds from the remainder
        remainingSeconds -= wholeUnitCount * unitDefinition.seconds;
      }
      // Limit to the top two segments
      if (spanSegments.length >= 2) {
        // Break once enough segments have been collected
        break;
      }
    }
    // Return the assembled human-readable span
    return spanSegments.join(", ");
  }

  /**
   * Validate exact date format match.
   *
   * Ensure the provided string reproduces the supplied format without normalization.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isValidDate #TODO
   * @param {string} inputDateString - The date string to validate.
   * @param {string} expectedFormatPattern - The expected format.
   * @returns {boolean} True when the string matches the format exactly.
   */
  static isValidDate(inputDateString, expectedFormatPattern = "yyyy-MM-dd") {
    // Check that the input string is non-empty
    if (typeof inputDateString !== "string" || inputDateString.trim() === "") {
      // Return false when the input is invalid
      return false;
    }
    // Create a DateTime using the expected format
    const validatedDateTime = LuxonDateTime.fromFormat(
      // Provide the input string
      inputDateString,
      // Provide the expected format pattern
      expectedFormatPattern,
    );
    // Return whether the formatted value matches the original string
    return (
      validatedDateTime.isValid &&
      validatedDateTime.toFormat(expectedFormatPattern) === inputDateString
    );
  }

  /**
   * Format a date string with explicit or detected pattern.
   *
   * Use the provided explicit format when available or let the parser infer the pattern before formatting.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#formatDate #TODO
   * @param {string} sourceDateString - The input date string.
   * @param {string} [targetFormatPattern='dd/MM/yyyy'] - The desired output format.
   * @param {string|null} explicitInputFormatPattern - Optional input format to use.
   * @returns {string|false} Formatted date string or false if invalid.
   */
  static formatDate(
    sourceDateString,
    targetFormatPattern = "dd/MM/yyyy",
    explicitInputFormatPattern = null,
  ) {
    // Prepare a placeholder for the normalized DateTime
    let normalizedDateTime;
    // Check whether an explicit input format pattern was supplied
    if (explicitInputFormatPattern) {
      // Parse the string using the explicit format pattern
      normalizedDateTime = LuxonDateTime.fromFormat(
        // Provide the source string for explicit parsing
        sourceDateString,
        // Provide the explicit format pattern
        explicitInputFormatPattern,
      );
    // Skip explicit parsing when no format pattern exists
    } else {
      // Parse using automatic format detection
      normalizedDateTime = this.parseStringToLuxon(sourceDateString);
    }
    // Validate the normalized DateTime before formatting
    if (!normalizedDateTime || !normalizedDateTime.isValid) {
      // Return false when normalization fails
      return false;
    }
    // Return the formatted result using the target pattern
    return normalizedDateTime.toFormat(targetFormatPattern);
  }

  /**
   * Get the start of day for a given date string.
   *
   * Normalize the input to the beginning of the day in the resolved timezone.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#getStartOfDay #TODO
   * @param {string} sourceDateString - The input date string.
   * @param {string|null} targetTimeZoneIdentifier - Optional IANA timezone name.
   * @returns {string|false} Formatted datetime string or false if invalid.
   */
  static getStartOfDay(sourceDateString, targetTimeZoneIdentifier = null) {
    // Parse the source date string into a timestamp
    const referenceTimestampSeconds = this.parseDateToTimestamp(
      // Provide the source date for parsing
      sourceDateString,
      // Provide the timezone override when supplied
      targetTimeZoneIdentifier,
    );
    // Handle invalid timestamp parsing results
    if (referenceTimestampSeconds === false) {
      // Return false when parsing fails
      return false;
    }
    // Determine the timezone identifier for normalization
    const resolvedZoneIdentifier =
      // Use the override or fall back to Hong Kong
      targetTimeZoneIdentifier || "Asia/Hong_Kong";
    // Build the DateTime representing the start of the day
    const startOfDayDateTimeValue = LuxonDateTime.fromSeconds(
      // Provide the validated timestamp in seconds
      referenceTimestampSeconds,
    )
      // Apply the resolved timezone identifier
      .setZone(resolvedZoneIdentifier)
      // Snap to the start of the day
      .startOf("day");
    // Return the formatted start-of-day string
    return startOfDayDateTimeValue.toFormat("yyyy-MM-dd HH:mm:ss");
  }

  /**
   * Get the end of day for a given date string.
   *
   * Normalize the input to the end of the day in the resolved timezone.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#getEndOfDay #TODO
   * @param {string} sourceDateString - The input date string.
   * @param {string|null} targetTimeZoneIdentifier - Optional IANA timezone name.
   * @returns {string|false} Formatted datetime string or false if invalid.
   */
  static getEndOfDay(sourceDateString, targetTimeZoneIdentifier = null) {
    // Determine the timezone to use for parsing
    const resolvedTimeZoneIdentifier =
      targetTimeZoneIdentifier || this.getDefaultTimeZone();
    // Parse the input string into a Luxon DateTime
    const normalizedDateTime = this.parseStringToLuxon(
      sourceDateString,
      resolvedTimeZoneIdentifier,
    );
    // Return false when the parsed DateTime is invalid
    if (!normalizedDateTime || !normalizedDateTime.isValid) {
      // Return false for unsupported inputs
      return false;
    }
    // Build the end-of-day DateTime in the resolved zone
    const endOfDayDateTime = normalizedDateTime
      .endOf("day")
      .setZone(resolvedTimeZoneIdentifier);
    // Return the formatted end-of-day string
    return endOfDayDateTime.toFormat("yyyy-MM-dd HH:mm:ss");
  }

  /**
   * Add or subtract days from the input string.
   *
   * Parse the input date, apply the requested day delta, and format the result.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#addDays #TODO
   *
   * @param {string} baseDateString - The input date string.
   * @param {number} dayDeltaQuantity - Number of days to add (can be negative).
   * @param {string|null} optionalTimeZoneIdentifier - Optional timezone.
   * @returns {string|false} Formatted datetime or false on failure.
   */
  static addDays(
    baseDateString,
    dayDeltaQuantity,
    optionalTimeZoneIdentifier = null,
  ) {
    // Start the day adjustment flow
    try {
      // Resolve the timezone to use
      const resolvedTimeZoneIdentifier =
        // Prefer the override when provided
        optionalTimeZoneIdentifier || "Asia/Hong_Kong";
      // Parse the source string into Luxon
      const normalizedDateTime = this.parseStringToLuxon(
        // Provide the source date string
        baseDateString,
        // Provide the resolved timezone identifier
        resolvedTimeZoneIdentifier,
      // Close the parse call
      );
      // Validate the parsed DateTime
      if (!normalizedDateTime || !normalizedDateTime.isValid) {
        // Return false when parsing fails
        return false;
      }
      // Convert the day delta input into a number
      const parsedDayDeltaValue = Number(dayDeltaQuantity);
      // Ensure the delta is finite
      if (!Number.isFinite(parsedDayDeltaValue)) {
        // Return false when delta is invalid
        return false;
      }
      // Apply the day delta to the normalized DateTime
      const adjustedDateTime = normalizedDateTime.plus({
        // Set the days property
        days: parsedDayDeltaValue,
      // Close the addition call
      });
      // Return the formatted adjusted DateTime
      return adjustedDateTime.toFormat("yyyy-MM-dd HH:mm:ss");
    // Handle unexpected errors gracefully
    } catch (unexpectedError) {
      // Return false when an unexpected error occurs
      return false;
    }
  }

  /**
   * Calculate the next weekday occurrence at a specified time.
   *
   * Validate inputs, compute the target day offset, and format the resulting DateTime.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#getNextOccurrence #TODO
   * @param {string} desiredWeekdayName - e.g., 'Monday', 'Friday'.
   * @param {string} [scheduledTimeOfDay='00:00:00'] - Time in HH:mm:ss format.
   * @param {string|null} optionalTargetTimeZone - Optional timezone.
   * @returns {string|false} Formatted datetime or false on error.
   */
  static getNextOccurrence(
    desiredWeekdayName,
    scheduledTimeOfDay = "00:00:00",
    optionalTargetTimeZone = null,
  ) {
    // Begin forced execution with error handling
    try {
      // Validate weekday input type and presence
      if (
        // Ensure the weekday name is a string
        typeof desiredWeekdayName !== "string" ||
        // Ensure the weekday name is not blank
        !desiredWeekdayName.trim()
      ) {
        // Signal invalid weekday input
        throw new Error("Invalid weekday");
      }
      // Map weekday names to their numeric values
      const weekdayNameToNumberMap = {
        // Monday
        monday: 1,
        // Tuesday
        tuesday: 2,
        // Wednesday
        wednesday: 3,
        // Thursday
        thursday: 4,
        // Friday
        friday: 5,
        // Saturday
        saturday: 6,
        // Sunday
        sunday: 7,
      };
      // Normalize the weekday name for lookup
      const normalizedWeekdayName = desiredWeekdayName.toLowerCase();
      // Retrieve the numeric weekday target
      const targetWeekdayNumber =
        // Lookup the normalized weekday
        weekdayNameToNumberMap[normalizedWeekdayName];
      // Ensure the weekday lookup succeeded
      if (!targetWeekdayNumber) {
        // Signal invalid weekday name
        throw new Error(`Invalid weekday: "${desiredWeekdayName}"`);
      }
      // Split the scheduled time into segments
      const timeSegments = scheduledTimeOfDay.split(":");
      // Validate segment count for HH:mm[:ss]
      if (timeSegments.length < 2 || timeSegments.length > 3) {
        // Signal invalid time format
        throw new Error("Invalid time format");
      }
      // Destructure the time segments with a default for seconds
      const [hourSegment, minuteSegment, secondSegment = "0"] = timeSegments;
      // Parse the hour segment
      const parsedHour = parseInt(hourSegment, 10);
      // Parse the minute segment
      const parsedMinute = parseInt(minuteSegment, 10);
      // Parse the second segment
      const parsedSecond = parseInt(secondSegment, 10);
      // Validate numeric ranges for each time component
      if (
        // Check hour validity
        Number.isNaN(parsedHour) ||
        // Check minute validity
        Number.isNaN(parsedMinute) ||
        // Check second validity
        Number.isNaN(parsedSecond) ||
        // Ensure hour is within 0-23
        parsedHour < 0 ||
        parsedHour > 23 ||
        // Ensure minute is within 0-59
        parsedMinute < 0 ||
        parsedMinute > 59 ||
        // Ensure second is within 0-59
        parsedSecond < 0 ||
        parsedSecond > 59
      ) {
        // Signal invalid time format
        throw new Error("Invalid time format");
      }
      // Build a UTC reference DateTime for now
      const utcReferenceDateTime =
        // Use the current milliseconds in UTC
        LuxonDateTime.fromMillis(Date.now()).setZone("UTC");
      // Determine how many days until the next target weekday
      const daysUntilNextTargetWeekday =
        // Compute offset modulo 7
        (targetWeekdayNumber - utcReferenceDateTime.weekday + 7) % 7;
      // Construct the candidate UTC DateTime for the target weekday
      const candidateUtcDateTimeForWeekday = utcReferenceDateTime
        // Move forward by the needed number of days
        .plus({ days: daysUntilNextTargetWeekday })
        // Snap to the start of that day
        .startOf("day")
        // Apply the scheduled time components
        .set({
          // Hour component
          hour: parsedHour,
          // Minute component
          minute: parsedMinute,
          // Second component
          second: parsedSecond,
        });
      // Determine the final timezone for output
      const finalOutputZoneIdentifier =
        // Use override or default timezone
        optionalTargetTimeZone || this.getDefaultTimeZone();
      // Convert the candidate DateTime into the target zone
      const convertedDateTimeInTargetZone =
        // Apply the final zone identifier
        candidateUtcDateTimeForWeekday.setZone(finalOutputZoneIdentifier);
      // Validate the converted DateTime
      if (!convertedDateTimeInTargetZone.isValid) {
        // Signal invalid timezone conversion
        throw new Error("Invalid timezone");
      }
      // Return the formatted final DateTime string
      return convertedDateTimeInTargetZone.toFormat("yyyy-MM-dd HH:mm:ss");
    // Catch and handle any validation failures
    } catch (exception) {
      // Return false when computation fails
      return false;
    }
  }

  /**
   * Convert a interpreted value between timezones.
   *
   * Build a DateTime from the source value, change zones, and format the output string.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#convertTimezone #TODO
   * @param {number|string|Date|LuxonDateTime} valueToInterpret - Value to interpret for conversion.
   * @param {string} sourceTimeZoneIdentifier - Original timezone identifier.
   * @param {string} targetTimeZoneIdentifier - Target timezone identifier.
   * @param {string} [desiredOutputFormat='yyyy-MM-dd HH:mm:ss'] - Desired output format.
   * @returns {string|false} Converted datetime string or false on failure.
   */
  static convertTimezone(
    valueToInterpret,
    sourceTimeZoneIdentifier,
    targetTimeZoneIdentifier,
    desiredOutputFormat = "yyyy-MM-dd HH:mm:ss",
  ) {
    // Guard the conversion flow
    try {
      // Build a Luxon DateTime from the source value with the declared timezone
      const sourceDateTimeForConversion = this.buildDateTimeForConversion(
        valueToInterpret,
        sourceTimeZoneIdentifier,
      );
      // Reject when the DateTime normalization failed
      if (!sourceDateTimeForConversion) {
        // Signal failure when the DateTime could not be created
        return false;
      }
      // Reject when the built DateTime is marked invalid
      if (!sourceDateTimeForConversion.isValid) {
        // Signal failure to keep the helper non-fatal
        return false;
      }
      // Convert the DateTime into the target timezone
      const convertedDateTimeInTargetZone = sourceDateTimeForConversion.setZone(
        targetTimeZoneIdentifier,
      );
      // Reject when the target zone conversion is invalid
      if (!convertedDateTimeInTargetZone.isValid) {
        // Signal failure so callers can detect conversion issues
        return false;
      }
      // Format the converted DateTime into the desired output pattern
      const formattedConvertedDateTime =
        convertedDateTimeInTargetZone.toFormat(desiredOutputFormat);
      // Return the formatted timezone-converted datetime string
      return formattedConvertedDateTime;
    // Handle any unexpected parsing or conversion errors
    } catch (conversionError) {
      // Signal failure for unexpected exceptions
      return false;
    }
  }


  /**
   * Build a Luxon DateTime from various input types for conversion helpers.
   *
   * Accept strings, Unix seconds, JS Dates, or Luxon DateTime instances.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#buildDateTimeForConversion #TODO
   * @param {number|Date|LuxonDateTime|string} valueToNormalize - Input to normalize.
   * @param {string} targetTimeZoneIdentifier - Timezone for the resulting DateTime.
   * @returns {LuxonDateTime|false} Normalized DateTime or false when unsupported.
   */
  static buildDateTimeForConversion(
    valueToNormalize,
    targetTimeZoneIdentifier,
  ) {
    // Check for a string input and parse it with the requested zone
    if (typeof valueToNormalize === "string") {
      // Parse the string using Luxon with the target timezone
      return this.parseStringToLuxon(
        valueToNormalize,
        targetTimeZoneIdentifier,
      );
    }
    // Check for a numeric Unix timestamp input
    if (
      typeof valueToNormalize === "number" &&
      Number.isFinite(valueToNormalize)
    ) {
      // Build the DateTime using seconds and the desired zone
      return LuxonDateTime.fromSeconds(valueToNormalize).setZone(
        targetTimeZoneIdentifier,
      );
    }
    // Check for a native JS Date object
    if (valueToNormalize instanceof Date) {
      // Create a DateTime from the JS Date and set the zone
      return LuxonDateTime.fromJSDate(valueToNormalize).setZone(
        targetTimeZoneIdentifier,
      );
    }
    // Check whether the value is already a Luxon DateTime
    if (LuxonDateTime.isDateTime(valueToNormalize)) {
      // Guard against missing or invalid Luxon instances
      if (!valueToNormalize || !valueToNormalize.isValid) {
        // Return false when the input is unusable
        return false;
      }
      // Guard against missing or invalid timezone identifiers
      if (
        !targetTimeZoneIdentifier ||
        typeof targetTimeZoneIdentifier !== "string"
      ) {
        // Return false for unsupported zone arguments
        return false;
      }
      // Shift the existing DateTime into the target zone
      const converted = valueToNormalize.setZone(targetTimeZoneIdentifier);
      // Ensure the converted DateTime remains valid
      if (!converted || !converted.isValid) {
        // Return false when conversion produced an invalid DateTime
        return false;
      }
      // Return the timezone-shifted DateTime instance
      return converted;
    }
    // Return false when the type cannot be normalized
    return false;
  }

  /**
   * Determine if a date string occurs before now.
   *
   * Parse the string into Unix seconds and compare it to the current timestamp.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isPast #TODO
   * @param {string} targetDateStringToEvaluate - Date string to evaluate.
   * @returns {boolean|false} True when date is before now, false otherwise.
   */
  static isPast(targetDateStringToEvaluate) {
    // Parse the supplied date into Unix seconds
    const parsedTimestampSeconds = this.parseDateToTimestamp(
      targetDateStringToEvaluate,
    );
    // Return false when the parse fails
    if (parsedTimestampSeconds === false) {
      // Return false to signal invalid input
      return false;
    }
    // Return whether the parsed timestamp is less than now
    return parsedTimestampSeconds < Math.floor(Date.now() / 1000);
  }

  /**
   * Determine if a date string occurs after now.
   *
   * Parse the input into Unix seconds and compare it with the current timestamp.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isFuture #TODO
   * @param {string} targetDateStringToEvaluate - Date string to evaluate.
   * @returns {boolean|false} True when the date is after now, false otherwise.
   */
  static isFuture(targetDateStringToEvaluate) {
    // Parse the supplied date into Unix seconds
    const parsedTimestampSeconds = this.parseDateToTimestamp(
      targetDateStringToEvaluate,
    );
    // Return false when the parse fails
    if (parsedTimestampSeconds === false) {
      // Return false to signal invalid input
      return false;
    }
    // Return whether the parsed timestamp is greater than now
    return parsedTimestampSeconds > Math.floor(Date.now() / 1000);
  }

  /**
   * Check whether a date string lies within a provided range.
   *
   * Build timestamps for each border and ensure the target falls between them inclusively.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isBetween #TODO
   * @param {string} candidateDateString - The date to check.
   * @param {string} rangeStartDateString - Start boundary date.
   * @param {string} rangeEndDateString - End boundary date.
   * @returns {boolean|false} True when the date is within bounds, false when invalid.
   */
  static isBetween(
    candidateDateString,
    rangeStartDateString,
    rangeEndDateString,
  ) {
    // Parse the candidate into Unix seconds
    const targetTimestampSeconds = this.parseDateToTimestamp(
      candidateDateString,
    );
    // Parse the start boundary
    const rangeStartTimestampSeconds =
      this.parseDateToTimestamp(rangeStartDateString);
    // Parse the end boundary
    const rangeEndTimestampSeconds =
      this.parseDateToTimestamp(rangeEndDateString);
    // Check whether any parse operation failed
    if (
      targetTimestampSeconds === false ||
      rangeStartTimestampSeconds === false ||
      rangeEndTimestampSeconds === false
    ) {
      // Return false when inputs are invalid
      return false;
    }
    // Return whether the candidate sits between the boundaries inclusively
    return (
      targetTimestampSeconds >= rangeStartTimestampSeconds &&
      targetTimestampSeconds <= rangeEndTimestampSeconds
    );
  }

  /**
   * Validate whether the provided format string is supported.
   *
   * Attempt to format and re-parse the current time with the format to ensure Luxon accepts it.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isValidFormat #TODO
   *
   * @param {string} proposedFormatString - The format to check.
   * @returns {boolean} True when the format is valid for Luxon, false otherwise.
   */
  static isValidFormat(proposedFormatString) {
    // Ensure the format identifier is a string
    if (typeof proposedFormatString !== "string") {
      // Return false when the format is not a string
      return false;
    }
    // Provide a shortcut for the empty string (Luxon accepts it)
    if (proposedFormatString === "") {
      // Return true when the format string is empty
      return true;
    }
    // Validate the format via round-tripping through Luxon
    try {
      // Capture the current moment for reference
      const referenceDateTime = LuxonDateTime.now();
      // Format the reference moment using the proposed format
      const formattedReference = referenceDateTime.toFormat(
        proposedFormatString,
      );
      // Attempt to parse the formatted string back into a DateTime
      const roundTripDateTime = LuxonDateTime.fromFormat(
        formattedReference,
        proposedFormatString,
      );
      // Return whether the round-tripped DateTime is valid
      return roundTripDateTime.isValid;
    } catch (formatValidationError) {
      // Return false when Luxon raises during validation
      return false;
    }
  }

  /**
   * Get the Luxon format string for a known alias.
   *
   * Provide an alias-to-format map for frequently used patterns.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#getCommonFormat #TODO
   * @param {string} formatAliasInput - Format alias (e.g., 'iso', 'us', 'eu').
   * @returns {string|null} Luxon format string or null when alias is unknown.
   */
  static getCommonFormat(formatAliasInput) {
    // Guard when the alias is not provided as a string
    if (typeof formatAliasInput !== "string") {
      // Return null for unsupported alias types
      return null;
    }
    // Map alias values to Luxon format strings
    const formatAliasMap = {
      iso: this.FORMATS.ISO_DATETIME,
      "iso-date": this.FORMATS.ISO_DATE,
      "iso-datetime": this.FORMATS.ISO_DATETIME,
      "iso-datetime-ms": this.FORMATS.ISO_DATETIME_MS,
      "iso-datetime-tz": this.FORMATS.ISO_DATETIME_TZ,
      us: this.FORMATS.US_DATE,
      "us-date": this.FORMATS.US_DATE,
      "us-datetime": this.FORMATS.US_DATETIME,
      eu: this.FORMATS.EU_DATE,
      "eu-date": this.FORMATS.EU_DATE,
      "eu-datetime": this.FORMATS.EU_DATETIME,
      uk: this.FORMATS.UK_DATE,
      "uk-date": this.FORMATS.UK_DATE,
      "uk-datetime": this.FORMATS.UK_DATETIME,
      time: this.FORMATS.TIME_24,
      "time-24": this.FORMATS.TIME_24,
      "time-12": this.FORMATS.TIME_12,
      rfc822: this.FORMATS.RFC822,
      rfc3339: this.FORMATS.RFC3339,
      unix: this.FORMATS.UNIX_TIMESTAMP,
      "unix-ms": this.FORMATS.UNIX_TIMESTAMP_MS,
    };
    // Lookup the normalized alias and return the matching format
    return formatAliasMap[formatAliasInput.toLowerCase()] || null;
  }

  /**
   * Return the current moment formatted in the desired zone.
   *
   * Resolve the timezone, validate the format, and emit the formatted string or false on failure.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#now #TODO
   * @param {string} [formatPatternCandidate='yyyy-MM-dd HH:mm:ss'] - Output format.
   * @param {string|null} [zoneOverride=null] - Optional timezone override.
   * @returns {string|false} Current formatted LuxonDateTime or false on failure.
   */
  static now(
    formatPatternCandidate = DEFAULT_OUTPUT_FORMAT,
    zoneOverride = null,
  ) {
    // Resolve the timezone identifier for rendering
    const resolvedTimeZone =
      zoneOverride || this.getDefaultTimeZone();
    // Return false when a strftime-style format was provided
    if (formatPatternCandidate.includes("%")) {
      // Return false for unsupported format tokens
      return false;
    }
    // Build the DateTime for the resolved zone
    const currentDateTimeInZone = LuxonDateTime.now().setZone(resolvedTimeZone);
    // Attempt to format via a validated pattern
    try {
      // Avoid invalid format strings by falling back to the default
      if (!this.isValidFormat(formatPatternCandidate)) {
        // Return the fallback formatted string
        return currentDateTimeInZone.toFormat(DEFAULT_OUTPUT_FORMAT);
      }
      // Return the formatted DateTime via the requested pattern
      return currentDateTimeInZone.toFormat(formatPatternCandidate);
    // Return false when Luxon throws during formatting
    } catch (formattingError) {
      // Return false for unexpected formatting errors
      return false;
    }
  }

  /**
   * Convert a simplified time string into whole minutes.
   *
   * Split the string by colon, validate, and return the sum of hours and minutes.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#timeToMinutes #TODO
   * @param {string} timeStringToConvert - Time string to convert.
   * @returns {number} Total minutes.
   * @throws {Error} When the input format is invalid.
   */
  static timeToMinutes(timeStringToConvert) {
    // Break apart the time string into colon-separated segments
    const timeSegments = timeStringToConvert.split(":");
    // Require at least hours and minutes
    if (timeSegments.length < 2) {
      // Signal invalid format when there are too few segments
      throw new Error("Invalid time string format");
    }
    // Parse the hour component and use absolute value
    const absoluteHourValue = Math.abs(parseInt(timeSegments[0], 10));
    // Parse the minute component and use absolute value
    const absoluteMinuteValue = Math.abs(parseInt(timeSegments[1], 10));
    // Validate the parsed numbers
    if (
      !Number.isFinite(absoluteHourValue) ||
      !Number.isFinite(absoluteMinuteValue)
    ) {
      // Throw when parsing produced non-finite values
      throw new Error("Invalid time string format");
    }
    // Return the total minutes represented by the input
    return absoluteHourValue * 60 + absoluteMinuteValue;
  }

  /**
   * Derive a concise relative label from a Unix timestamp.
   *
   * Calculate the seconds difference from now and emit the first matching threshold description.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#getRelativeTime #TODO
   * @param {number} unixTimestampSeconds - Unix seconds to describe.
   * @returns {string|false} Relative label or false when input invalid.
   */
  static getRelativeTime(unixTimestampSeconds) {
    // Ensure the input is a finite number
    if (
      // Check the type is numeric
      typeof unixTimestampSeconds !== "number" ||
      // Ensure it is not NaN
      isNaN(unixTimestampSeconds)
    ) {
      // Return false for invalid inputs
      return false;
    }
    // Capture the current moment in Unix seconds
    const currentUnixTimestampSeconds = Math.floor(Date.now() / 1000);
    // Calculate how many seconds have elapsed
    const elapsedSeconds = currentUnixTimestampSeconds - unixTimestampSeconds;
    // Provide an immediate label for recent timestamps
    if (elapsedSeconds < 60) {
      // Return the short label for recent events
      return "just now";
    }
    // Define thresholds for relative time tokens
    const relativeThresholdSecondsMapping = {
      "1y": 31536000,
      "1m": 2592000,
      "2w": 1209600,
      "1w": 604800,
      "1d": 86400,
      "1h": 3600,
    };
    // Iterate each threshold to find a suitable label
    for (const [thresholdTag, thresholdDurationSeconds] of Object.entries(
      relativeThresholdSecondsMapping,
    )) {
      // Return the label when the elapsed time meets the threshold
      if (elapsedSeconds >= thresholdDurationSeconds) {
        // Format the relative label using the quotient
        return `${Math.floor(elapsedSeconds / thresholdDurationSeconds)}${
          thresholdTag[thresholdTag.length - 1]
        }`;
      }
    }
    // Fallback label when no thresholds matched
    return "just now";
  }

  /**
   * Return a human-friendly relative time string like '2 minutes ago'.
   *
   * Compare now with the timestamp to build a readable description from elapsed seconds.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#formatPrettyRelativeTime #TODO
   * @param {number} unixTimestampSeconds - Unix timestamp in seconds.
   * @returns {string|false} Readable relative time or false when invalid.
   */
  static formatPrettyRelativeTime(unixTimestampSeconds) {
    // Ensure the input is a valid number
    if (
      // Check that the value is numeric
      typeof unixTimestampSeconds !== "number" ||
      // Check that it is not NaN
      isNaN(unixTimestampSeconds)
    ) {
      // Return false when the input is invalid
      return false;
    }
    // Capture the current time in seconds
    const currentUnixTimestampSeconds = Math.floor(Date.now() / 1000);
    // Calculate how many seconds have elapsed
    let elapsedSeconds = currentUnixTimestampSeconds - unixTimestampSeconds;
    // Give a quick label for durations under a minute
    if (elapsedSeconds < 60) {
      // Return the short form for very recent times
      return "just now";
    }
    // Define the units to consider for turning seconds into text
    const relativeUnitDefinitions = [
      // Years
      { name: "year", seconds: 31536000 },
      // Months
      { name: "month", seconds: 2592000 },
      // Weeks
      { name: "week", seconds: 604800 },
      // Days
      { name: "day", seconds: 86400 },
      // Hours
      { name: "hour", seconds: 3600 },
      // Minutes
      { name: "minute", seconds: 60 },
    ];
    // Iterate through units to find the best match
    for (const relativeUnitDefinition of relativeUnitDefinitions) {
      // Return when the elapsed duration exceeds the unit
      if (elapsedSeconds >= relativeUnitDefinition.seconds) {
        // Determine how many units fit in the elapsed time
        const unitCount = Math.floor(
          elapsedSeconds / relativeUnitDefinition.seconds,
        );
        // Return the formatted label with pluralization awareness
        return `${unitCount} ${relativeUnitDefinition.name}${
          unitCount !== 1 ? "s" : ""
        } ago`;
      }
    }
    // Fallback for unusually small durations after the loop
    return "just now";
  }

  /**
   * Return the current default timezone applied by helpers.
   *
   * Prefer the runtime override when available, otherwise fall back to the constant.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#getDefaultTimeZone #TODO
   *
   * @returns {string} The default timezone identifier.
   */
  static getDefaultTimeZone() {
    // Return the runtime override when it exists
    return this._runtimeDefaultTimeZone || DEFAULT_TIME_ZONE;
  }

  /**
   * Configure the default timezone used by future helpers.
   *
   * Validate the input and update the runtime override when the zone is acceptable.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#setDefaultTimeZone #TODO
   *
   * @param {string} timeZoneCandidate - Candidate IANA timezone string.
   * @returns {boolean} True when the timezone is valid and set, false otherwise.
   */
  static setDefaultTimeZone(timeZoneCandidate) {
    // Reject non-string inputs immediately
    if (typeof timeZoneCandidate !== "string") {
      // Return false when the argument is invalid
      return false;
    }
    // Trim whitespace from the timezone string
    const trimmedTimeZoneIdentifier = timeZoneCandidate.trim();
    // Reject empty strings
    if (!trimmedTimeZoneIdentifier) {
      // Return false when trimming yields nothing
      return false;
    }

    // Validate the timezone with Luxon
    const validationDateTime = LuxonDateTime.now().setZone(
      trimmedTimeZoneIdentifier,
    );
    // Reject invalid Luxon zone results
    if (!validationDateTime.isValid) {
      // Return false when Luxon rejects the zone
      return false;
    }

    // Store the validated timezone override
    this._runtimeDefaultTimeZone = trimmedTimeZoneIdentifier;
    // Signal success to the caller
    return true;
  }

  /**
   * Normalize a supported value to the default Hong Kong DateTime zone.
   *
   * Accept numeric timestamps, JS Date instances, Luxon DateTimes, or recognized strings and return a DateTime in the configured zone.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#normalizeToHongKong #TODO
   * @param {number|Date|LuxonDateTime|string} valueToNormalize - Value to normalize.
   * @returns {LuxonDateTime|false} DateTime in the default zone or false when unsupported.
   */
  static normalizeToHongKong(valueToNormalize) {
    // Resolve the runtime default timezone
    const defaultZoneIdentifier = this.getDefaultTimeZone();

    // Check for numeric timestamp input
    if (typeof valueToNormalize === "number" && Number.isFinite(valueToNormalize)) {
      // Build DateTime from seconds timestamp
      return LuxonDateTime.fromSeconds(valueToNormalize).setZone(
        // Use resolved default timezone identifier
        defaultZoneIdentifier,
        // Complete the timezone adjustment call
      );
    }

    // Check for JavaScript Date objects
    if (valueToNormalize instanceof Date) {
      // Build DateTime from JS Date
      return LuxonDateTime.fromJSDate(valueToNormalize).setZone(
        // Use resolved default timezone identifier
        defaultZoneIdentifier,
        // Complete the timezone adjustment call
      );
    }

    // Handle Luxon DateTime instances
    if (LuxonDateTime.isDateTime(valueToNormalize)) {
      // Reject invalid Luxon DateTime objects
      if (!valueToNormalize.isValid) {
        // Return false when the DateTime cannot be normalized
        return false;
      }
      // Adjust the DateTime to the default timezone
      const normalizedDateTime = valueToNormalize.setZone(defaultZoneIdentifier);
      // Return the normalized DateTime
      return normalizedDateTime;
    }

    // Check for non-empty string input
    if (typeof valueToNormalize === "string" && valueToNormalize.trim() !== "") {
      // Parse the string into a Luxon DateTime
      const parsedDateTime = this.parseStringToLuxon(
        // Provide the original string
        valueToNormalize,
        // Apply the default timezone during parsing
        defaultZoneIdentifier,
        // Complete the parsing invocation
      );
      // Return the parsed DateTime when valid or false otherwise
      return parsedDateTime && parsedDateTime.isValid ? parsedDateTime : false;
    }

    // Return false for any unsupported value
    return false;
  }

  /**
   * Assess whether a timestamp falls inside a recent past interval.
   *
   * Normalize the inputs to numeric values and verify the target lies between now minus the window and the current moment.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isWithinPastSeconds #TODO
   * @param {number} targetTimestampSeconds - Unix timestamp to evaluate.
   * @param {number} pastWindowSeconds - Number of seconds defining the past window.
   * @returns {boolean} True when the timestamp sits within the past window.
   */
  static isWithinPastSeconds(targetTimestampSeconds, pastWindowSeconds) {
    // Validate that both inputs are finite numbers
    if (
      // Check that the target timestamp is a number
      typeof targetTimestampSeconds !== "number" ||
      // Check that the target timestamp is finite
      !Number.isFinite(targetTimestampSeconds) ||
      // Check that the window duration is a number
      typeof pastWindowSeconds !== "number" ||
      // Check that the window duration is finite
      !Number.isFinite(pastWindowSeconds)
    ) {
      // Reject invalid inputs
      return false;
    }
    // Capture the current Unix timestamp in seconds
    const currentUnixTimestamp = Math.floor(Date.now() / 1000);
    // Normalize the window size into an absolute whole number
    const windowSizeSeconds = Math.abs(Math.floor(pastWindowSeconds));
    // Determine when the past window begins
    const pastWindowStart = currentUnixTimestamp - windowSizeSeconds;
    // Evaluate whether the target falls within the computed range
    return (
      // Check that the target is after the start of the window
      targetTimestampSeconds >= pastWindowStart &&
      // Check that the target is no later than now
      targetTimestampSeconds <= currentUnixTimestamp
    );
  }

  /**
   * Confirm a timestamp lands within a short-term future window.
   *
   * Normalize the inputs, compute the upper bound from now plus the window, and verify the target occurs before that bound.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isWithinNextSeconds #TODO
   * @param {number} targetTimestampSeconds - Unix timestamp to evaluate.
   * @param {number} futureWindowSeconds - Number of seconds advancing from now.
   * @returns {boolean} True when timestamp falls within the next window.
   */
  static isWithinNextSeconds(targetTimestampSeconds, futureWindowSeconds) {
    // Validate that both inputs are finite numbers
    if (
      // Check that the target timestamp is a number
      typeof targetTimestampSeconds !== "number" ||
      // Check that the target timestamp is finite
      !Number.isFinite(targetTimestampSeconds) ||
      // Check that the future window duration is a number
      typeof futureWindowSeconds !== "number" ||
      // Check that the future window duration is finite
      !Number.isFinite(futureWindowSeconds)
    ) {
      // Reject invalid inputs
      return false;
    }
    // Capture the current Unix timestamp in seconds
    const currentUnixTimestamp = Math.floor(Date.now() / 1000);
    // Normalize the window size into an absolute whole number
    const windowSizeSeconds = Math.abs(Math.floor(futureWindowSeconds));
    // Determine when the future window ends
    const futureWindowEnd = currentUnixTimestamp + windowSizeSeconds;
    // Verify the timestamp sits between now and the future cut-off
    return (
      // The target cannot exceed the future endpoint
      targetTimestampSeconds <= futureWindowEnd &&
      // The target must be no earlier than the current moment
      targetTimestampSeconds >= currentUnixTimestamp
    );
  }

  /**
   * Confirm a timestamp resides between configurable past and future bounds.
   *
   Normalize the offsets, compute the start and end bounds around now, and check that the target timestamp falls within them.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isWithinRelativeWindow #TODO
   * @param {number} targetTimestampSeconds - Unix timestamp to evaluate.
   * @param {number} pastWindowSeconds - Backward offset in seconds.
   * @param {number} futureWindowSeconds - Forward offset in seconds.
   * @returns {boolean} True when timestamp lies between window bounds.
   */
  static isWithinRelativeWindow(
    targetTimestampSeconds,
    pastWindowSeconds,
    futureWindowSeconds,
  ) {
    // Validate that inputs are numeric and finite
    if (
      // Check that the target timestamp is a number
      typeof targetTimestampSeconds !== "number" ||
      // Check that the target timestamp is finite
      !Number.isFinite(targetTimestampSeconds) ||
      // Check that the past window duration is a number
      typeof pastWindowSeconds !== "number" ||
      // Check that the past window duration is finite
      !Number.isFinite(pastWindowSeconds) ||
      // Check that the future window duration is a number
      typeof futureWindowSeconds !== "number" ||
      // Check that the future window duration is finite
      !Number.isFinite(futureWindowSeconds)
    ) {
      // Reject invalid inputs
      return false;
    }
    // Capture the current Unix timestamp in seconds
    const currentUnixTimestamp = Math.floor(Date.now() / 1000);
    // Normalize the past window size into an absolute whole number
    const pastWindowSizeSeconds = Math.abs(Math.floor(pastWindowSeconds));
    // Normalize the future window size into an absolute whole number
    const futureWindowSizeSeconds = Math.abs(Math.floor(futureWindowSeconds));
    // Compute the start bound of the relative window
    const relativeWindowStart = currentUnixTimestamp - pastWindowSizeSeconds;
    // Compute the end bound of the relative window
    const relativeWindowEnd = currentUnixTimestamp + futureWindowSizeSeconds;
    // Confirm the timestamp falls between the start and end bounds
    return (
      // Ensure the target is not before the start bound
      targetTimestampSeconds >= relativeWindowStart &&
      // Ensure the target is not after the end bound
      targetTimestampSeconds <= relativeWindowEnd
    );
  }

  /**
   * Validate that a date string falls inside a relative window around now.
   *
   * Normalize the past and future offsets, parse the string within the resolved timezone, and confirm it yields a timestamp.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isDateStringWithinRelativeWindow #TODO
   * @param {string} dateStringToEvaluate - Date string to evaluate.
   * @param {number} pastWindowSeconds - Past offset window.
   * @param {number} futureWindowSeconds - Future offset window.
   * @param {string|null} timeZoneIdentifier - Optional timezone for parsing.
   * @returns {boolean} True when the string yields a timestamp.
   */
  static isDateStringWithinRelativeWindow(
    dateStringToEvaluate,
    pastWindowSeconds,
    futureWindowSeconds,
    timeZoneIdentifier = null,
  ) {
    // Validate that past and future window offsets are finite numbers
    if (
      // Confirm the past window offset is a number
      typeof pastWindowSeconds !== "number" ||
      // Confirm the past window offset is finite
      !Number.isFinite(pastWindowSeconds) ||
      // Confirm the future window offset is a number
      typeof futureWindowSeconds !== "number" ||
      // Confirm the future window offset is finite
      !Number.isFinite(futureWindowSeconds)
    ) {
      // Reject invalid window offsets
      return false;
    }
    // Resolve the timezone for parsing operations
    const resolvedZone = timeZoneIdentifier || this.getDefaultTimeZone();
    // Parse the input string into a timestamp
    const parsedTimestamp = this.parseDateToTimestamp(
      // Provide the original date string
      dateStringToEvaluate,
      // Apply the resolved timezone
      resolvedZone,
    );
    // Check if parsing failed
    if (parsedTimestamp === false) {
      // Return false when parsing does not succeed
      return false;
    }
    // Indicate that a valid timestamp was produced
    return parsedTimestamp !== false;
  }

  /**
   * Determine if now sits inside the offsets around a base timestamp.
   *
   Normalize window offsets, compute the boundaries around the base timestamp, and verify the current moment lands between them.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isNowBetweenOffsetSeconds #TODO
   * @param {number} baseTimestampSeconds - Center point timestamp in seconds.
   * @param {number} pastOffsetSeconds - Past offset to subtract.
   * @param {number} futureOffsetSeconds - Future offset to add.
   * @returns {boolean} True when now sits within the offset window.
   */
  static isNowBetweenOffsetSeconds(
    baseTimestampSeconds,
    pastOffsetSeconds,
    futureOffsetSeconds,
  ) {
    // Validate that all offsets are numeric and finite
    if (
      // Check that the base timestamp is a number
      typeof baseTimestampSeconds !== "number" ||
      // Check that the base timestamp is finite
      !Number.isFinite(baseTimestampSeconds) ||
      // Check that the past offset is a number
      typeof pastOffsetSeconds !== "number" ||
      // Check that the past offset is finite
      !Number.isFinite(pastOffsetSeconds) ||
      // Check that the future offset is a number
      typeof futureOffsetSeconds !== "number" ||
      // Check that the future offset is finite
      !Number.isFinite(futureOffsetSeconds)
    ) {
      // Reject invalid offset inputs
      return false;
    }
    // Capture the current Unix timestamp
    const currentUnixTimestamp = Math.floor(Date.now() / 1000);
    // Normalize the past offset into an absolute whole number
    const pastOffsetSizeSeconds = Math.abs(Math.floor(pastOffsetSeconds));
    // Normalize the future offset into an absolute whole number
    const futureOffsetSizeSeconds = Math.abs(Math.floor(futureOffsetSeconds));
    // Compute the start of the offset window
    const offsetWindowStart = baseTimestampSeconds - pastOffsetSizeSeconds;
    // Compute the end of the offset window
    const offsetWindowEnd = baseTimestampSeconds + futureOffsetSizeSeconds;
    // Check that the current moment lies between the window bounds
    return (
      // Ensure current time is not before the window start
      currentUnixTimestamp >= offsetWindowStart &&
      // Ensure current time is not after the window end
      currentUnixTimestamp <= offsetWindowEnd
    );
  }

  /**
   * Assess whether a timestamp lies between two bounds.
   *
   Normalize the inputs, derive ordered bounds, and evaluate the target using inclusive or exclusive semantics.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isTimestampBetween #TODO
   * @param {number} targetTimestampSeconds - The timestamp to check.
   * @param {number} startTimestampSeconds - Start boundary timestamp.
   * @param {number} endTimestampSeconds - End boundary timestamp.
   * @param {boolean} [inclusive=true] - Include the boundaries when true.
   * @returns {boolean} True when the target sits within the specified range.
   */
  static isTimestampBetween(
    targetTimestampSeconds,
    startTimestampSeconds,
    endTimestampSeconds,
    inclusive = true,
  ) {
    // Validate that each bound and target are numeric and finite
    if (
      // Confirm the target timestamp is a number
      typeof targetTimestampSeconds !== "number" ||
      // Confirm the target timestamp is finite
      !Number.isFinite(targetTimestampSeconds) ||
      // Confirm the start boundary is a number
      typeof startTimestampSeconds !== "number" ||
      // Confirm the start boundary is finite
      !Number.isFinite(startTimestampSeconds) ||
      // Confirm the end boundary is a number
      typeof endTimestampSeconds !== "number" ||
      // Confirm the end boundary is finite
      !Number.isFinite(endTimestampSeconds)
    ) {
      // Reject invalid numeric inputs
      return false;
    }
    // Derive the lower bound from the sorted pair
    const rangeLowerBound = Math.min(
      // Provide the start candidate
      startTimestampSeconds,
      // Provide the end candidate
      endTimestampSeconds,
    );
    // Derive the upper bound from the sorted pair
    const rangeUpperBound = Math.max(
      // Provide the start candidate
      startTimestampSeconds,
      // Provide the end candidate
      endTimestampSeconds,
    );
    // Handle inclusive boundary checks
    if (inclusive) {
      // Allow equality at either boundary when inclusive
      return (
        // Ensure the target is not below the lower bound
        targetTimestampSeconds >= rangeLowerBound &&
        // Ensure the target is not above the upper bound
        targetTimestampSeconds <= rangeUpperBound
      );
    }
    // Enforce strict comparison when exclusive
    return (
      // Ensure the target is strictly above the lower bound
      targetTimestampSeconds > rangeLowerBound &&
      // Ensure the target is strictly below the upper bound
      targetTimestampSeconds < rangeUpperBound
    );
  }

  /**
   * Calculate the minute offset between two time zones at an optional reference moment.
   *
   * Ensure both identifiers are valid, derive a reference DateTime if needed, and subtract the resulting offsets.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#getTimezoneOffsetInMinutes #TODO
   * @param {string} sourceZoneIdentifier - Source timezone identifier.
   * @param {string} targetZoneIdentifier - Target timezone identifier.
   * @param {LuxonDateTime|string|null} referenceDateTimeOrIso - Optional reference in Luxon or ISO form.
   * @returns {number|false} Offset in minutes or false on failure.
   */
  static getTimezoneOffsetInMinutes(
    sourceZoneIdentifier,
    targetZoneIdentifier,
    referenceDateTimeOrIso = null,
  ) {
    // Validate the source and target timezone identifiers
    if (
      // Check that the source identifier is a string
      typeof sourceZoneIdentifier !== "string" ||
      // Check that the source identifier is not empty
      !sourceZoneIdentifier.trim() ||
      // Check that the target identifier is a string
      typeof targetZoneIdentifier !== "string" ||
      // Check that the target identifier is not empty
      !targetZoneIdentifier.trim()
    ) {
      // Return false when identifiers are invalid
      return false;
    }
    // Prepare the reference moment variable
    let referenceDateTimeCandidate;
    // Handle explicit Luxon DateTime references
    if (LuxonDateTime.isDateTime(referenceDateTimeOrIso)) {
      // Validate the provided DateTime
      if (!referenceDateTimeOrIso.isValid) {
        // Return false when the reference is invalid
        return false;
      }
      // Reuse the valid DateTime as the reference
      referenceDateTimeCandidate = referenceDateTimeOrIso;
    } else if (typeof referenceDateTimeOrIso === "string") {
      // Parse the ISO string into a DateTime
      referenceDateTimeCandidate = LuxonDateTime.fromISO(referenceDateTimeOrIso);
      // Validate the parsed candidate
      if (!referenceDateTimeCandidate.isValid) {
        // Return false when parsing fails
        return false;
      }
    } else {
      // Use the current moment when no reference is supplied
      referenceDateTimeCandidate = LuxonDateTime.now();
    }
    // Convert the reference into the source zone
    const sourceZoneDateTime =
      referenceDateTimeCandidate.setZone(sourceZoneIdentifier);
    // Convert the reference into the target zone
    const targetZoneDateTime =
      referenceDateTimeCandidate.setZone(targetZoneIdentifier);
    // Ensure both derived DateTimes are valid
    if (!sourceZoneDateTime.isValid || !targetZoneDateTime.isValid) {
      // Return false when zone conversion fails
      return false;
    }
    // Return the difference in offsets between the zones
    return targetZoneDateTime.offset - sourceZoneDateTime.offset;
  }

  /**
   * Compute the minute offset from Hong Kong to a local zone.
   *
   * Delegate to the general offset helper using the configured default source zone.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#getTimezoneOffsetFromHongKongToLocal #TODO
   * @param {string} localZoneIdentifier - Target local timezone.
   * @param {LuxonDateTime|string|null} referenceDateTimeOrIso - Optional reference moment.
   * @returns {number|false} Offset in minutes or false on failure.
   */
  static getTimezoneOffsetFromHongKongToLocal(
    localZoneIdentifier,
    referenceDateTimeOrIso = null,
  ) {
    // Delegate to the shared helper with the default source zone
    return this.getTimezoneOffsetInMinutes(
      // Provide the configured source timezone identifier
      this.getDefaultTimeZone(),
      // Provide the local target timezone identifier
      localZoneIdentifier,
      // Forward the optional reference moment
      referenceDateTimeOrIso,
    );
  }

  /**
   * Convert a Hong Kong timestamp string into a specified local timezone.
   *
   * Wrap the generic timezone helper, using the configured default source zone to convert Hong Kong strings into the target.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#convertHongKongToLocal #TODO
   * @param {string} sourceHongKongDateString - The Hong Kong/localized date string.
   * @param {string} targetTimeZoneIdentifier - Target timezone for conversion.
   * @param {string} [desiredOutputFormat='yyyy-MM-dd HH:mm:ss'] - Output format for the result.
   * @returns {string|false} Converted datetime string or false on failure.
   */
  static convertHongKongToLocal(
    sourceHongKongDateString,
    targetTimeZoneIdentifier,
    desiredOutputFormat = "yyyy-MM-dd HH:mm:ss",
  ) {
    // Delegate to the shared timezone conversion helper
    return this.convertTimezone(
      // Provide the source Hong Kong string
      sourceHongKongDateString,
      // Use the configured default source timezone
      this.getDefaultTimeZone(),
      // Provide the requested target timezone
      targetTimeZoneIdentifier,
      // Supply the desired output format
      desiredOutputFormat,
    );
  }

  /**
   * Convert a local timezone date string to the Hong Kong/default timezone.
   *
   Wrap the shared timezone helper while enforcing the configured default target zone for Hong Kong output.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#convertLocalToHongKong #TODO
   * @param {string} sourceLocalDateString - Date string in the local timezone.
   * @param {string} sourceTimeZoneIdentifier - Source timezone of the input.
   * @param {string} [desiredOutputFormat='yyyy-MM-dd HH:mm:ss'] - Desired output format.
   * @returns {string|false} Converted datetime string or false on failure.
   */
  static convertLocalToHongKong(
    sourceLocalDateString,
    sourceTimeZoneIdentifier,
    desiredOutputFormat = "yyyy-MM-dd HH:mm:ss",
  ) {
    // Delegate to the shared timezone conversion helper
    return this.convertTimezone(
      // Provide the source local string
      sourceLocalDateString,
      // Provide the source timezone identifier
      sourceTimeZoneIdentifier,
      // Use the configured default target timezone
      this.getDefaultTimeZone(),
      // Supply the desired output format
      desiredOutputFormat,
    );
  }

  /**
   * Convert supported values into a Unix timestamp in seconds.
   *
   * Detect the input type and normalize it into seconds, using parsing helpers when necessary.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#toUnixTimestamp #TODO
   *
   * @param {number|Date|LuxonDateTime|string} valueToCoerce - Value to coerce.
   * @param {string|null} optionalTimeZoneIdentifier - Optional timezone for string parsing.
   * @returns {number|false} Unix timestamp or false on failure.
   */
  static toUnixTimestamp(valueToCoerce, optionalTimeZoneIdentifier = null) {
    // Handle numeric inputs already in seconds
    if (typeof valueToCoerce === "number" && Number.isFinite(valueToCoerce)) {
      // Return the normalized whole seconds
      return Math.floor(valueToCoerce);
    }
    // Handle native Date instances
    if (valueToCoerce instanceof Date) {
      // Return the epoch seconds representation
      return Math.floor(valueToCoerce.getTime() / 1000);
    }
    // Handle Luxon DateTime instances
    if (LuxonDateTime.isDateTime(valueToCoerce)) {
      // Ensure the DateTime is valid before extracting seconds
      if (!valueToCoerce.isValid) {
        // Return false when the DateTime is invalid
        return false;
      }
      // Capture the seconds value from the DateTime
      const seconds = valueToCoerce.toSeconds();
      // Validate that the extracted seconds are finite
      if (!Number.isFinite(seconds)) {
        // Return false when the extracted seconds are invalid
        return false;
      }
      // Return the floored second value
      return Math.floor(seconds);
    }
    // Handle string inputs by parsing them
    if (typeof valueToCoerce === "string" && valueToCoerce.trim() !== "") {
      // Parse the string into a Unix timestamp
      return this.parseDateToTimestamp(
        valueToCoerce,
        optionalTimeZoneIdentifier || this.getDefaultTimeZone(),
      );
    }
    // Reject unsupported input types
    return false;
  }

  /**
   * Determine the weekday index for a date string.
   *
   Parse the input with the optional timezone and return Luxon’s weekday (1-7) when valid.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#getDayOfWeek #TODO
   * @param {string} sourceDateString - Date string to evaluate.
   * @param {string|null} optionalTimeZoneIdentifier - Optional timezone for parsing.
   * @returns {number|false} Weekday number (1-7) or false on failure.
   */
  static getDayOfWeek(sourceDateString, optionalTimeZoneIdentifier = null) {
    // Parse the input string into a Luxon DateTime
    const normalizedDateTime = this.parseStringToLuxon(
      sourceDateString,
      optionalTimeZoneIdentifier,
    );
    // Return false when parsing fails to produce a valid DateTime
    if (!normalizedDateTime || !normalizedDateTime.isValid) {
      // Signal failure for invalid inputs
      return false;
    }
    // Return the weekday index from Luxon
    return normalizedDateTime.weekday;
  }

  /**
   * Retrieve the ISO week number for a date string.
   *
   Parse the input with an optional timezone and return Luxon’s week number when valid.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#getWeekNumber #TODO
   * @param {string} sourceDateString - Input date string.
   * @param {string|null} optionalTimeZoneIdentifier - Optional timezone override.
   * @returns {number|false} Week number or false when parsing fails.
   */
  static getWeekNumber(sourceDateString, optionalTimeZoneIdentifier = null) {
    // Parse the input string into a Luxon DateTime
    const normalizedDateTime = this.parseStringToLuxon(
      sourceDateString,
      optionalTimeZoneIdentifier,
    );
    // Return false when parsing fails or DateTime is invalid
    if (!normalizedDateTime || !normalizedDateTime.isValid) {
      // Signal failure for invalid parsing results
      return false;
    }
    // Return the ISO week number from Luxon
    return normalizedDateTime.weekNumber;
  }

  /**
   * Format a Unix timestamp in the desired timezone.
   *
   * Coerce the seconds into Luxon, adjust the zone, and return the formatted string or false when invalid.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#fromUnixTimestamp #TODO
   * @param {number} timestampSeconds - Unix seconds to convert.
   * @param {string} [outputFormat=DEFAULT_OUTPUT_FORMAT] - Output format string.
   * @param {string|null} timeZoneIdentifier - Optional timezone override.
   * @returns {string|false} Formatted datetime string or false on failure.
   */
  static fromUnixTimestamp(
    unixTimestampSeconds,
    outputFormatPattern = DEFAULT_OUTPUT_FORMAT,
    optionalTimeZoneIdentifier = null,
  ) {
    // Validate that the timestamp is a finite number
    if (
      typeof unixTimestampSeconds !== "number" ||
      !Number.isFinite(unixTimestampSeconds)
    ) {
      // Return false when the timestamp is invalid
      return false;
    }
    // Resolve which timezone to use for formatting
    const resolvedTimeZone =
      optionalTimeZoneIdentifier || this.getDefaultTimeZone();
    // Build a Luxon DateTime from the Unix seconds and zone
    const dateTimeValue =
      LuxonDateTime.fromSeconds(unixTimestampSeconds).setZone(resolvedTimeZone);
    // Return the formatted string when valid otherwise false
    return dateTimeValue.isValid
      ? dateTimeValue.toFormat(outputFormatPattern)
      : false;
  }

  /**
   * Evaluate whether the current moment lies between normalized date boundaries.
   *
   Normalize both boundaries into the same timezone, compare now to their timestamps, and handle wrapping ranges.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isNowBetween #TODO
   * @param {string} startDateString - Start boundary date string.
   * @param {string} endDateString - End boundary date string.
   * @param {string|null} timeZoneIdentifier - Optional timezone for evaluation.
   * @returns {boolean} True when now lies between the normalized boundaries.
   */
  static isNowBetween(
    windowStartDateString,
    windowEndDateString,
    optionalTimeZoneIdentifier = null,
  ) {
    // Resolve the comparison timezone identifier
    const comparisonTimeZoneIdentifier =
      // Use the override or fall back to the default
      optionalTimeZoneIdentifier || this.getDefaultTimeZone();
    // Capture the currently configured default timezone identifier
    const defaultZoneIdentifier = this.getDefaultTimeZone();
    // Parse the start boundary into a timestamp
    const startBoundaryTimestampSeconds = this.parseDateToTimestamp(
      // Provide the start window string
      windowStartDateString,
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Parse the end boundary into a timestamp
    const endBoundaryTimestampSeconds = this.parseDateToTimestamp(
      // Provide the end window string
      windowEndDateString,
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Validate that both boundary timestamps were derived successfully
    if (
      // Check whether the start boundary failed parsing
      startBoundaryTimestampSeconds === false ||
      // Check whether the end boundary failed parsing
      endBoundaryTimestampSeconds === false
    ) {
      // Return false when either boundary could not be parsed
      return false;
    }
    // Build a UTC reference DateTime at the current moment
    const utcReferenceDateTime = LuxonDateTime.fromMillis(Date.now(), {
      // Force UTC zone for the reference
      zone: "UTC",
    });
    // Reapply the default zone while retaining the local time
    const defaultZoneReferenceDateTime = utcReferenceDateTime.setZone(
      // Provide the default zone identifier
      defaultZoneIdentifier,
      {
        // Keep local time during the zone shift
        keepLocalTime: true,
      },
    );
    // Shift the reference into the comparison timezone
    const comparisonMomentDateTime = defaultZoneReferenceDateTime.setZone(
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Convert the start boundary into the comparison zone
    const startBoundaryDateTimeInZone = LuxonDateTime.fromSeconds(
      // Supply the parsed start boundary timestamp
      startBoundaryTimestampSeconds,
    ).setZone(
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Convert the end boundary into the comparison zone
    const endBoundaryDateTimeInZone = LuxonDateTime.fromSeconds(
      // Supply the parsed end boundary timestamp
      endBoundaryTimestampSeconds,
    ).setZone(
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Capture the comparison moment timestamp in seconds
    const comparisonMomentTimestampSeconds = Math.floor(
      // Get the comparison moment seconds
      comparisonMomentDateTime.toSeconds(),
    );
    // Capture the normalized start boundary seconds
    const normalizedStartBoundarySeconds = Math.floor(
      // Get the start boundary seconds in the zone
      startBoundaryDateTimeInZone.toSeconds(),
    );
    // Capture the normalized end boundary seconds
    const normalizedEndBoundarySeconds = Math.floor(
      // Get the end boundary seconds in the zone
      endBoundaryDateTimeInZone.toSeconds(),
    );
    // Handle the straightforward range when start precedes end
    if (normalizedStartBoundarySeconds <= normalizedEndBoundarySeconds) {
      // Guard the comparison using the timestamp helper
      return this.isTimestampBetween(
        // Provide the comparison moment seconds
        comparisonMomentTimestampSeconds,
        // Provide the normalized start seconds
        normalizedStartBoundarySeconds,
        // Provide the normalized end seconds
        normalizedEndBoundarySeconds,
        // Enforce inclusive bounds
        true,
      );
    }
    // Compute the wrapped end boundary one day later
    const wrappedEndBoundarySeconds = Math.floor(
      // Add one day before converting to seconds
      endBoundaryDateTimeInZone.plus({ days: 1 }).toSeconds(),
    );
    // Check the wrapped range by verifying now lies past the start or before the wrapped end
    return (
      // Compare against the normalized start bound
      comparisonMomentTimestampSeconds >= normalizedStartBoundarySeconds ||
      // Compare against the wrapped end bound
      comparisonMomentTimestampSeconds <= wrappedEndBoundarySeconds
    );
  }

  /**
   * Determine whether a datetime string sits within a rolling window.
   *
   Normalize the inputs in one timezone, compare the timestamps, and handle overnight spans gracefully.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#isDateTimeBetween #TODO
   * @param {string} targetDateTimeString - The datetime to test.
   * @param {string} windowStartDateString - Start boundary of the window.
   * @param {string} windowEndDateString - End boundary of the window.
   * @param {string|null} optionalTimeZoneIdentifier - Optional timezone for parsing.
   * @returns {boolean} True when the datetime lies within the window.
   */
  static isDateTimeBetween(
    targetDateTimeString,
    windowStartDateString,
    windowEndDateString,
    optionalTimeZoneIdentifier = null,
  ) {
    // Resolve which timezone to use for all comparisons
    const comparisonTimeZoneIdentifier =
      // Use the override when provided
      optionalTimeZoneIdentifier || this.getDefaultTimeZone();
    // Parse the target datetime into seconds
    const targetDateTimeTimestampSeconds = this.parseDateToTimestamp(
      // Provide the target datetime string
      targetDateTimeString,
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Parse the window start boundary into seconds
    const startBoundaryTimestampSeconds = this.parseDateToTimestamp(
      // Provide the start boundary string
      windowStartDateString,
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Parse the window end boundary into seconds
    const endBoundaryTimestampSeconds = this.parseDateToTimestamp(
      // Provide the end boundary string
      windowEndDateString,
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Reject when any parsing attempt failed
    if (
      // Check the target parsing result
      targetDateTimeTimestampSeconds === false ||
      // Check the start boundary parsing result
      startBoundaryTimestampSeconds === false ||
      // Check the end boundary parsing result
      endBoundaryTimestampSeconds === false
    ) {
      // Return false when a parsing step failed
      return false;
    }
    // Build Luxon DateTimes for the parsed timestamps
    const targetDateTimeInZone = LuxonDateTime.fromSeconds(
      // Supply the parsed target timestamp
      targetDateTimeTimestampSeconds,
    ).setZone(
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Build the start boundary DateTime
    const startBoundaryDateTimeInZone = LuxonDateTime.fromSeconds(
      // Supply the parsed start timestamp
      startBoundaryTimestampSeconds,
    ).setZone(
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Build the end boundary DateTime
    const endBoundaryDateTimeInZone = LuxonDateTime.fromSeconds(
      // Supply the parsed end timestamp
      endBoundaryTimestampSeconds,
    ).setZone(
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Capture the normalized target seconds
    const normalizedTargetBoundarySeconds = Math.floor(
      // Convert the target DateTime to seconds
      targetDateTimeInZone.toSeconds(),
    );
    // Capture the normalized start boundary seconds
    const normalizedStartBoundarySeconds = Math.floor(
      // Convert the start DateTime to seconds
      startBoundaryDateTimeInZone.toSeconds(),
    );
    // Capture the normalized end boundary seconds
    const normalizedEndBoundarySeconds = Math.floor(
      // Convert the end DateTime to seconds
      endBoundaryDateTimeInZone.toSeconds(),
    );
    // Handle the standard window that does not wrap overnight
    if (normalizedStartBoundarySeconds <= normalizedEndBoundarySeconds) {
      // Delegate to the timestamp helper for the inclusive check
      return this.isTimestampBetween(
        // Provide the comparison target seconds
        normalizedTargetBoundarySeconds,
        // Provide the normalized start seconds
        normalizedStartBoundarySeconds,
        // Provide the normalized end seconds
        normalizedEndBoundarySeconds,
        // Allow equality at the bounds
        true,
      );
    }
    // Compute the wrapped end boundary a day ahead
    const wrappedEndBoundaryDaySeconds = Math.floor(
      // Add one day before converting to seconds
      endBoundaryDateTimeInZone.plus({ days: 1 }).toSeconds(),
    );
    // Evaluate the wrapped window by comparing the target to start or wrapped end
    return (
      // Check whether the target is after the start boundary
      normalizedTargetBoundarySeconds >= normalizedStartBoundarySeconds ||
      // Check whether the target falls before the wrapped end
      normalizedTargetBoundarySeconds <= wrappedEndBoundaryDaySeconds
    );
  }

  /**
   * Determine whether two date ranges overlap.
   *
   Normalize each boundary timestamp and confirm that the intervals intersect by comparing ordered bounds.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#doRangesOverlap #TODO
   * @param {string} firstRangeStartString - Start of the first range.
   * @param {string} firstRangeEndString - End of the first range.
   * @param {string} secondRangeStartString - Start of the second range.
   * @param {string} secondRangeEndString - End of the second range.
   * @param {string|null} optionalTimeZoneIdentifier - Optional timezone for parsing.
   * @returns {boolean|false} True when ranges overlap, false otherwise.
   */
  static doRangesOverlap(
    firstRangeStartString,
    firstRangeEndString,
    secondRangeStartString,
    secondRangeEndString,
    optionalTimeZoneIdentifier = null,
  ) {
    // Resolve the timezone identifier for parsing boundaries
    const comparisonTimeZoneIdentifier =
      // Use override or fall back to default
      optionalTimeZoneIdentifier || this.getDefaultTimeZone();
    // Convert the first range start into seconds
    const firstRangeStartTimestampSeconds = this.parseDateToTimestamp(
      // Provide the first range start string
      firstRangeStartString,
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Convert the first range end into seconds
    const firstRangeEndTimestampSeconds = this.parseDateToTimestamp(
      // Provide the first range end string
      firstRangeEndString,
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Convert the second range start into seconds
    const secondRangeStartTimestampSeconds = this.parseDateToTimestamp(
      // Provide the second range start string
      secondRangeStartString,
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Convert the second range end into seconds
    const secondRangeEndTimestampSeconds = this.parseDateToTimestamp(
      // Provide the second range end string
      secondRangeEndString,
      // Provide the comparison timezone identifier
      comparisonTimeZoneIdentifier,
    );
    // Validate that all boundary parsing succeeded
    if (
      // Check first range start
      firstRangeStartTimestampSeconds === false ||
      // Check first range end
      firstRangeEndTimestampSeconds === false ||
      // Check second range start
      secondRangeStartTimestampSeconds === false ||
      // Check second range end
      secondRangeEndTimestampSeconds === false
    ) {
      // Return false when any boundary parsing failed
      return false;
    }
    // Determine the lower bound for the first range
    const firstRangeLowerBound = Math.min(
      // Provide the parsed start seconds
      firstRangeStartTimestampSeconds,
      // Provide the parsed end seconds
      firstRangeEndTimestampSeconds,
    );
    // Determine the upper bound for the first range
    const firstRangeUpperBound = Math.max(
      // Provide the parsed start seconds
      firstRangeStartTimestampSeconds,
      // Provide the parsed end seconds
      firstRangeEndTimestampSeconds,
    );
    // Determine the lower bound for the second range
    const secondRangeLowerBound = Math.min(
      // Provide the parsed start seconds
      secondRangeStartTimestampSeconds,
      // Provide the parsed end seconds
      secondRangeEndTimestampSeconds,
    );
    // Determine the upper bound for the second range
    const secondRangeUpperBound = Math.max(
      // Provide the parsed start seconds
      secondRangeStartTimestampSeconds,
      // Provide the parsed end seconds
      secondRangeEndTimestampSeconds,
    );
    // Check whether the ranges overlap by comparing bounds
    return (
      // Ensure first range begins before second range ends
      firstRangeLowerBound <= secondRangeUpperBound &&
      // Ensure second range begins before first range ends
      secondRangeLowerBound <= firstRangeUpperBound
    );
  }

  /**
   * List each ISO date string for a range of days between two dates.
   *
   * Normalize the range endpoints, ensure validity, and accumulate each day sequentially.
   *
   * @author Linden May
   * @version 1.0.0
   * @since -
   * @updated -
   * @link https://docs.example.com/DateTime#listDaysInRange #TODO
   * @param {string} inclusiveStartDateString - Inclusive start date string.
   * @param {string} inclusiveEndDateString - Inclusive end date string.
   * @param {string|null} optionalTimeZoneIdentifier - Optional timezone override.
   * @returns {string[]|false} Sequence of ISO date strings or false on error.
   */
  static listDaysInRange(
    inclusiveStartDateString,
    inclusiveEndDateString,
    optionalTimeZoneIdentifier = null,
  ) {
    // Resolve which timezone should be used
    const resolvedTimeZoneIdentifier =
      // Prefer the override when provided
      optionalTimeZoneIdentifier || this.getDefaultTimeZone();
    // Parse the inclusive start date into seconds
    const inclusiveStartTimestampSeconds = this.parseDateToTimestamp(
      // Supply the start date string
      inclusiveStartDateString,
      // Apply the resolved timezone
      resolvedTimeZoneIdentifier,
    );
    // Parse the inclusive end date into seconds
    const inclusiveEndTimestampSeconds = this.parseDateToTimestamp(
      // Supply the end date string
      inclusiveEndDateString,
      // Apply the resolved timezone
      resolvedTimeZoneIdentifier,
    );
    // Validate that both endpoints parsed successfully
    if (
      // Check the start parsing result
      inclusiveStartTimestampSeconds === false ||
      // Check the end parsing result
      inclusiveEndTimestampSeconds === false
    ) {
      // Return false when parsing any boundary fails
      return false;
    }
    // Enforce increasing order of the range
    if (inclusiveStartTimestampSeconds > inclusiveEndTimestampSeconds) {
      // Return false when the start occurs after the end
      return false;
    }
    // Initialize the iterator at the start of the inclusive day
    let currentDayIterator = LuxonDateTime.fromSeconds(
      // Provide the start timestamp
      inclusiveStartTimestampSeconds,
    )
      // Apply the resolved timezone
      .setZone(
        // Provide the resolved timezone identifier
        resolvedTimeZoneIdentifier,
      )
      // Align to the start of the day
      .startOf("day");
    // Initialize the end boundary day DateTime
    const endDayDateTime = LuxonDateTime.fromSeconds(
      // Provide the end timestamp
      inclusiveEndTimestampSeconds,
    )
      // Apply the resolved timezone
      .setZone(
        // Supply the timezone identifier
        resolvedTimeZoneIdentifier,
      )
      // Align to the start of the end day
      .startOf("day");
    // Ensure both DateTimes are valid
    if (!currentDayIterator.isValid || !endDayDateTime.isValid) {
      // Return false when either DateTime is invalid
      return false;
    }
    // Start collecting ISO date strings
    const accumulatedDays = [];
    // Capture the millisecond cutoff for the loop
    const endDayMillis = endDayDateTime.toMillis();
    // Iterate through each day until the end day is reached
    while (currentDayIterator.toMillis() <= endDayMillis) {
      // Append the current day as an ISO date string
      accumulatedDays.push(currentDayIterator.toFormat("yyyy-MM-dd"));
      // Advance to the next day
      currentDayIterator = currentDayIterator.plus({ days: 1 });
    }
    // Return the accumulated list of ISO dates
    return accumulatedDays;
  }
}

module.exports = DateTime;