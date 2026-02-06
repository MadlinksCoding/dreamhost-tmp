const crypto = require("crypto");
const zlib = require("zlib");
const { promisify } = require("util");
const Scylla = require("../services/scylla.js");
const {SafeUtils, Logger,DateTime,ErrorHandler} = require("../utils/index.js");

/** Resilient current timestamp (supports CJS default export and direct .now) */
function _currentTimestamp() {
  const dt = DateTime.default != null ? DateTime.default : DateTime;
  if (typeof dt.now === "function") return dt.now();
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

module.exports = class Moderation {
  static TABLE = "moderation";

  static PK = "pk"; // moderation#<userId>
  static SK = "sk"; // media#<submittedAt>#<moderationId>
  static PK_PREFIX = "moderation#"; // Partition key prefix

  static GSI_STATUS_DATE = "GSI_StatusDate"; // PK: status,              SK: submittedAt (N)
  static GSI_USER_STATUS_DATE = "GSI_UserStatusDate"; // PK: userId,              SK: statusSubmittedAt (S)
  static GSI_ALL_BY_DATE = "GSI_AllByDate"; // PK: dayKey (YYYYMMDD),   SK: submittedAt (N)
  static GSI_PRIORITY = "GSI_Priority"; // PK: priority,            SK: submittedAt (N)
  static GSI_TYPE_DATE = "GSI_TypeDate"; // PK: type,                SK: submittedAt (N)
  static GSI_BY_MOD_ID = "GSI_ByModerationId"; // PK: moderationId,        SK: userId (S)
  static GSI_MODERATED_BY = "GSI_ModeratedBy"; // PK: moderatedBy,         SK: submittedAt (N)
  static GSI_CONTENT_ID = "GSI_ContentId"; // PK: contentId,              SK: submittedAt (N)
  static GSI_ESCALATED = "GSI_Escalated"; // PK: escalatedBy,            SK: submittedAt (N)
  static GSI_ACTIONED_AT = "GSI_ActionedAt"; // PK: status,                SK: actionedAt (N)

  // Status constants
  static STATUS = {
    PENDING: "pending",
    APPROVED: "approved",
    APPROVED_GLOBAL: "approved_global",
    REJECTED: "rejected",
    ESCALATED: "escalated",
  };

  // Type constants
  static TYPE = {
    IMAGE: "image",
    VIDEO: "video",
    TEXT: "text",
    LINK: "link",
    REPORT: "report",
    TAGS: "tags",
    EMOJI: "emoji",
    ICON: "icon",
    TAG: "tag",
    PERSONAL_TAG: "personal_tag",
    GLOBAL_TAG: "global_tag",
    IMAGE_GALLERY: "image_gallery",
    GALLERY: "gallery", // Alias for image_gallery
    AUDIO: "audio",
  };

  // Priority constants
  static PRIORITY = {
    HIGH: "high",
    NORMAL: "normal",
    URGENT: "urgent",
    LOW: "low",
  };

  // Action constants
  static ACTION = {
    APPROVE: "approve",
    REJECT: "reject",
    PENDING_RESUBMISSION: "pending_resubmission",
  };

  // Pre-computed Sets for O(1) validation (performance optimization)
  static STATUS_SET = new Set(Object.values(Moderation.STATUS));
  static TYPE_SET = new Set(Object.values(Moderation.TYPE));
  static PRIORITY_SET = new Set(Object.values(Moderation.PRIORITY));
  static ACTION_SET = new Set(Object.values(Moderation.ACTION));
  
  // Moderation type constants
  static MODERATION_TYPE = {
    STANDARD: "standard",
    GLOBAL: "global",
  };
  
  // Tag status constants
  static TAG_STATUS = {
    PUBLISHED: "published",
    PENDING: "pending",
  };
  
  // Expression attribute name constants (for DynamoDB queries)
  static EXPR_ATTR_NAMES = {
    STATUS: "#s",
    USER_ID: "#uid",
    MODERATION_ID: "#mid",
    PRIORITY: "#p",
    TYPE: "#type",
    DAY_KEY: "#dk",
    SUBMITTED_AT: "#sa",
    ACTIONED_AT: "#aa",
    DELETED: "#del",
    PK: "#pk",
    SK: "#sk",
    MODERATED_BY: "#mb",
    ESCALATED_BY: "#eb",
  };
  
  // Expression attribute value prefixes (for DynamoDB queries)
  static EXPR_ATTR_VALUES = {
    STATUS: ":status",
    USER_ID: ":uid",
    MODERATION_ID: ":mid",
    PRIORITY: ":p",
    TYPE: ":type",
    DAY_KEY: ":day",
    SUBMITTED_AT: ":sa",
    ACTIONED_AT: ":aa",
    DELETED_FALSE: ":delFalse",
    MODERATED_BY: ":mb",
    ESCALATED_BY: ":eb",
  };

  // Field name constants
  static FIELD = {
    MODERATION_ID: "moderationId",
    USER_ID: "userId",
    CONTENT_ID: "contentId",
    TYPE: "type",
    STATUS: "status",
    PRIORITY: "priority",
    SUBMITTED_AT: "submittedAt",
    ACTIONED_AT: "actionedAt",
    MODERATED_BY: "moderatedBy",
    ESCALATED_BY: "escalatedBy",
    REASON: "reason",
    ACTION: "action",
    NOTES: "notes",
    META: "meta",
  };

  // Magic numbers
  static EPOCH_DIGITS = 13;
  static MAX_NOTE_LENGTH = 5000;
  static MAX_NOTES_PER_ITEM = 50; // Maximum number of notes per moderation item to prevent unbounded growth
  static MAX_HISTORY_ENTRIES = 100; // Maximum number of history entries in meta field to prevent unbounded growth
  static MAX_QUERY_RESULT_SIZE = 1000; // Maximum number of items returned per query to prevent memory exhaustion
  static PAGINATION_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL for pagination tokens
  static MAX_PAGINATION_TOKEN_SIZE = 102400; // 100KB maximum size for pagination tokens
  static DEFAULT_TIMESTAMP_MAX = 9999999999999;
  static RETRY_MAX_ATTEMPTS = 3;
  static RETRY_BACKOFF_MS = 100;
  static MAX_PAGINATION_ITERATIONS = 100;

  static async createModerationSchema() {
    try {
      const schema = {
        TableName: this.TABLE,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: this.PK, KeyType: "HASH" },
          { AttributeName: this.SK, KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: this.PK, AttributeType: "S" },
          { AttributeName: this.SK, AttributeType: "S" },
          { AttributeName: "status", AttributeType: "S" },
          { AttributeName: "submittedAt", AttributeType: "N" },
          { AttributeName: "userId", AttributeType: "S" },
          { AttributeName: "statusSubmittedAt", AttributeType: "S" },
          { AttributeName: "dayKey", AttributeType: "S" },
          { AttributeName: "priority", AttributeType: "S" },
          { AttributeName: "type", AttributeType: "S" },
          { AttributeName: "moderationId", AttributeType: "S" },
          { AttributeName: "moderatedBy", AttributeType: "S" },
          { AttributeName: "contentId", AttributeType: "S" },
          { AttributeName: "escalatedBy", AttributeType: "S" },
          { AttributeName: "actionedAt", AttributeType: "N" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: this.GSI_STATUS_DATE,
            KeySchema: [
              { AttributeName: "status", KeyType: "HASH" },
              { AttributeName: "submittedAt", KeyType: "RANGE" },
            ],
            Projection: {
              ProjectionType: "INCLUDE",
              NonKeyAttributes: ["moderationId", "userId", "priority", "type"],
            },
          },
          {
            IndexName: this.GSI_USER_STATUS_DATE,
            KeySchema: [
              { AttributeName: "userId", KeyType: "HASH" },
              { AttributeName: "statusSubmittedAt", KeyType: "RANGE" },
            ],
            Projection: {
              ProjectionType: "INCLUDE",
              NonKeyAttributes: [
                "moderationId",
                "priority",
                "type",
                "submittedAt",
                "status",
              ],
            },
          },
          {
            IndexName: this.GSI_ALL_BY_DATE,
            KeySchema: [
              { AttributeName: "dayKey", KeyType: "HASH" },
              { AttributeName: "submittedAt", KeyType: "RANGE" },
            ],
            Projection: {
              ProjectionType: "INCLUDE",
              NonKeyAttributes: [
                "moderationId",
                "userId",
                "status",
                "priority",
                "type",
              ],
            },
          },
          {
            IndexName: this.GSI_PRIORITY,
            KeySchema: [
              { AttributeName: "priority", KeyType: "HASH" },
              { AttributeName: "submittedAt", KeyType: "RANGE" },
            ],
            Projection: {
              ProjectionType: "INCLUDE",
              NonKeyAttributes: ["moderationId", "userId", "status", "type"],
            },
          },
          {
            IndexName: this.GSI_TYPE_DATE,
            KeySchema: [
              { AttributeName: "type", KeyType: "HASH" },
              { AttributeName: "submittedAt", KeyType: "RANGE" },
            ],
            Projection: {
              ProjectionType: "INCLUDE",
              NonKeyAttributes: ["moderationId", "userId", "status", "priority"],
            },
          },
          {
            IndexName: this.GSI_BY_MOD_ID,
            KeySchema: [
              { AttributeName: "moderationId", KeyType: "HASH" },
              { AttributeName: "userId", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "KEYS_ONLY" },
          },
          {
            IndexName: this.GSI_MODERATED_BY,
            KeySchema: [
              { AttributeName: "moderatedBy", KeyType: "HASH" },
              { AttributeName: "submittedAt", KeyType: "RANGE" },
            ],
            Projection: {
              ProjectionType: "INCLUDE",
              NonKeyAttributes: [
                "moderationId",
                "userId",
                "status",
                "priority",
                "type",
              ],
            },
          },
          {
            IndexName: this.GSI_CONTENT_ID,
            KeySchema: [
              { AttributeName: "contentId", KeyType: "HASH" },
              { AttributeName: "submittedAt", KeyType: "RANGE" },
            ],
            Projection: {
              ProjectionType: "INCLUDE",
              NonKeyAttributes: [
                "moderationId",
                "userId",
                "status",
                "priority",
                "type",
              ],
            },
          },
          {
            IndexName: this.GSI_ESCALATED,
            KeySchema: [
              { AttributeName: "escalatedBy", KeyType: "HASH" },
              { AttributeName: "submittedAt", KeyType: "RANGE" },
            ],
            Projection: {
              ProjectionType: "INCLUDE",
              NonKeyAttributes: [
                "moderationId",
                "userId",
                "status",
                "priority",
                "type",
              ],
            },
          },
          {
            IndexName: this.GSI_ACTIONED_AT,
            KeySchema: [
              { AttributeName: "status", KeyType: "HASH" },
              { AttributeName: "actionedAt", KeyType: "RANGE" },
            ],
            Projection: {
              ProjectionType: "INCLUDE",
              NonKeyAttributes: [
                "moderationId",
                "userId",
                "action",
                "priority",
                "type",
              ],
            },
          },
        ],
      };

      await Scylla.createTable(schema);
    } catch (error) {
      ErrorHandler.addError(`SCHEMA_CREATION_FAILED: Failed to create moderation schema: ${error.message}`, {
        code: "SCHEMA_CREATION_FAILED",
        origin: "Moderation.createModerationSchema",
        data: { schema: this.TABLE },
      });
      throw new Error(`Failed to create moderation schema: ${error.message}`);
    }
  }

  /**
   * ============================================================
   *   Helpers
   * ============================================================
   */

  /**
   * Get current timestamp in milliseconds
   * @returns {number} Current timestamp
   */
  static _getCurrentTimestamp() {
    Logger.debugLog?.(`[Moderation] [_getCurrentTimestamp] [START] Generating current timestamp`);
    try {
      return Date.now();
    } catch (error) {
      ErrorHandler.addError(`Timestamp generation failed: ${error.message}`, {
        code: "TIMESTAMP_FAILED",
        origin: "Moderation._getCurrentTimestamp",
        data: { 
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            code: error.code,
            name: error.name
          } : error
        }
      });
      throw new Error(`Timestamp generation failed: ${error.message}`);
    }
  }

  /**
   * Validate and sanitize timestamp input
   * @param {number|undefined} timestamp - Timestamp to validate
   * @returns {number} Validated timestamp
   */
  static _validateTimestamp(timestamp) {
    Logger.debugLog?.(`[Moderation] [_validateTimestamp] [START] Validating timestamp: ${timestamp}`);
    if (!SafeUtils.hasValue(timestamp)) {
      Logger.debugLog?.(`[Moderation] [_validateTimestamp] [INFO] No timestamp provided, using current timestamp.`);
      return this._getCurrentTimestamp();
    }

    const sanitized = SafeUtils.sanitizeInteger(timestamp);
    if (sanitized === null || sanitized < 0) {
      ErrorHandler.addError("Invalid timestamp: must be positive integer", {
        code: "INVALID_TIMESTAMP",
        origin: "Moderation._validateTimestamp",
        data: { timestamp }
      });
      throw new Error("Invalid timestamp: must be positive integer");
    }

    // Validate it's reasonable (not too far in past, and not in future except for small clock skew)
    const now = this._getCurrentTimestamp();
    const fiveYears = 5 * 365 * 24 * 60 * 60 * 1000;
    const clockSkewGracePeriod = 5 * 60 * 1000; // 5 minutes in milliseconds
    
    // Check if timestamp is too far in the past
    if (sanitized < now - fiveYears) {
      ErrorHandler.addError("Timestamp too far in the past", {
        code: "TIMESTAMP_TOO_OLD",
        origin: "Moderation._validateTimestamp",
        data: { sanitized, now, ageYears: (now - sanitized) / (365 * 24 * 60 * 60 * 1000) }
      });
      throw new Error("Timestamp too far in the past (more than 5 years)");
    }
    
    // Check if timestamp is too far in the future (only allow small grace period for clock skew)
    if (sanitized > now + clockSkewGracePeriod) {
      ErrorHandler.addError("Timestamp in the future beyond clock skew tolerance", {
        code: "TIMESTAMP_IN_FUTURE",
        origin: "Moderation._validateTimestamp",
        data: { 
          sanitized, 
          now, 
          futureOffset: sanitized - now,
          maxAllowed: clockSkewGracePeriod
        }
      });
      throw new Error("Timestamp cannot be more than 5 minutes in the future (clock skew tolerance exceeded)");
    }

    Logger.debugLog?.(`[Moderation] [_validateTimestamp] [SUCCESS] Timestamp validated: ${sanitized}`);
    return sanitized;
  }

  /**
   * Validate filter expression components before concatenation
   * Ensures all components use ExpressionAttributeNames and ExpressionAttributeValues
   * @param {string[]} filterExpressions - Array of filter expression strings
   * @returns {string} Validated and joined filter expression
   */
  static _validateAndJoinFilterExpressions(filterExpressions) {
    if (!Array.isArray(filterExpressions)) {
      ErrorHandler.addError("Filter expressions must be an array", {
        code: "INVALID_FILTER_EXPRESSIONS",
        origin: "Moderation._validateAndJoinFilterExpressions",
        data: { filterExpressions }
      });
      throw new Error("Filter expressions must be an array");
    }

    // Validate each component
    for (const expression of filterExpressions) {
      if (typeof expression !== 'string') {
        ErrorHandler.addError("Filter expression component must be a string", {
          code: "INVALID_FILTER_EXPRESSION_TYPE",
          origin: "Moderation._validateAndJoinFilterExpressions",
          data: { expression, type: typeof expression }
        });
        throw new Error("Filter expression component must be a string");
      }

      // Only allow patterns that match ExpressionAttributeNames (#alias) and ExpressionAttributeValues (:value)
      // Also allow operators, parentheses, and function calls like attribute_exists, attribute_not_exists, begins_with, contains
      const safePattern = /^[#:a-zA-Z0-9_().\s=<>!-]+$/;
      if (!safePattern.test(expression)) {
        ErrorHandler.addError(`Unsafe filter expression component detected: ${expression}`, {
          code: "UNSAFE_FILTER_EXPRESSION",
          origin: "Moderation._validateAndJoinFilterExpressions",
          data: { expression }
        });
        throw new Error(`Unsafe filter expression component: ${expression}`);
      }

      // Ensure field references use ExpressionAttributeNames (# prefix)
      // Allow function calls like attribute_exists(#field), attribute_not_exists(#field), begins_with(#field, :value), contains(#field, :value)
      // But reject bare field names without # prefix in comparison operations
      const hasUnsafeFieldReference = /\b[a-z][a-zA-Z0-9_]*\s*[=<>!]/i.test(expression) && 
        !expression.includes('#') && 
        !expression.match(/^(attribute_exists|attribute_not_exists|begins_with|contains|size)\s*\(/i);
      if (hasUnsafeFieldReference) {
        ErrorHandler.addError(`Filter expression contains unsafe field reference (must use ExpressionAttributeNames): ${expression}`, {
          code: "UNSAFE_FILTER_EXPRESSION",
          origin: "Moderation._validateAndJoinFilterExpressions",
          data: { expression }
        });
        throw new Error(`Filter expression must use ExpressionAttributeNames for all field references: ${expression}`);
      }
    }

    return filterExpressions.join(" AND ");
  }

  /**
   * Compress large content payloads to reduce storage and bandwidth
   * @param {*} content - Content to compress (object, string, etc.)
   * @returns {Promise<Object>} Compressed content with metadata
   */
  static async _compressContent(content) {
    if (!content) {
      return null;
    }

    try {
      // Serialize content to JSON string
      const contentString = JSON.stringify(content);
      const originalSize = Buffer.byteLength(contentString, 'utf8');
      
      // Only compress if content is larger than 10KB to avoid overhead for small payloads
      const COMPRESSION_THRESHOLD = 10 * 1024; // 10KB
      
      if (originalSize < COMPRESSION_THRESHOLD) {
        // Content is small, no compression needed
        return content;
      }

      // Compress using gzip
      const compressed = await gzip(Buffer.from(contentString, 'utf8'));
      const compressedSize = compressed.length;
      
      // Only use compression if it actually reduces size (at least 10% reduction)
      const compressionRatio = compressedSize / originalSize;
      if (compressionRatio >= 0.9) {
        // Compression didn't help much, return original
        Logger.debugLog?.(`[Moderation] [_compressContent] [INFO] Compression not beneficial (ratio: ${compressionRatio.toFixed(2)}), storing uncompressed`);
        return content;
      }

      // Return compressed content with metadata
      return {
        _compressed: true,
        _format: 'gzip',
        data: compressed.toString('base64'),
        _originalSize: originalSize,
        _compressedSize: compressedSize,
      };
    } catch (error) {
      ErrorHandler.addError(`Failed to compress content: ${error.message}`, {
        code: "CONTENT_COMPRESSION_FAILED",
        origin: "Moderation._compressContent",
        data: { error: error.message }
      });
      throw new Error(`Failed to compress content: ${error.message}`);
    }
  }

  /**
   * Decompress content if it was compressed
   * @param {*} content - Content to decompress (may be compressed or uncompressed)
   * @returns {Promise<*>} Decompressed content
   */
  static async _decompressContent(content) {
    if (!content) {
      return null;
    }

    // Check if content is compressed
    if (typeof content === 'object' && content._compressed === true && content._format === 'gzip') {
      try {
        // Decompress from base64
        const compressedBuffer = Buffer.from(content.data, 'base64');
        const decompressed = await gunzip(compressedBuffer);
        const decompressedString = decompressed.toString('utf8');
        
        // Parse back to original format
        return JSON.parse(decompressedString);
      } catch (error) {
        ErrorHandler.addError(`Failed to decompress content: ${error.message}`, {
          code: "CONTENT_DECOMPRESSION_FAILED",
          origin: "Moderation._decompressContent",
          data: { error: error.message }
        });
        throw new Error(`Failed to decompress content: ${error.message}`);
      }
    }

    // Content is not compressed, return as-is
    return content;
  }

  /**
   * Decompress content in a moderation item or array of items
   * @param {Object|Array} items - Item(s) to process
   * @returns {Promise<Object|Array>} Item(s) with decompressed content
   */
  static async _decompressItemsContent(items) {
    if (!items) {
      return items;
    }

    if (Array.isArray(items)) {
      // Process array of items
      return Promise.all(items.map(async (item) => {
        if (item && item.content) {
          item.content = await this._decompressItemContent(item);
        }
        return item;
      }));
    } else {
      // Process single item
      if (items.content) {
        items.content = await this._decompressItemContent(items);
      }
      return items;
    }
  }

  /**
   * Decompress content for a single item; handles item.contentCompressed and raw Buffer
   * @param {Object} item - Item with optional content and contentCompressed
   * @returns {Promise<*>} Decompressed content
   */
  static async _decompressItemContent(item) {
    if (!item || !item.content) {
      return item && item.content;
    }
    const content = item.content;
    const contentCompressed = !!item.contentCompressed;
    if (contentCompressed && (Buffer.isBuffer(content) || (typeof content === "object" && !content._compressed))) {
      try {
        const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
        const decompressed = await gunzip(buf);
        return decompressed.toString("utf8");
      } catch (error) {
        ErrorHandler.addError?.(`Failed to decompress content: ${error.message}`, {
          code: "CONTENT_DECOMPRESSION_FAILED",
          origin: "Moderation._decompressItemsContent",
          data: { error: error.message }
        });
        throw new Error(`Failed to decompress content: ${error.message}`);
      }
    }
    return this._decompressContent(content);
  }

  /**
   * Validate moderation data input
   * @param {Object} data - Data to validate
   * @returns {Object} Sanitized data
   */
  static _validateModerationData(data) {
    Logger.debugLog?.(`[Moderation] [_validateModerationData] [START] Validating moderation data: ${JSON.stringify(data)}`);
    if (data != null && typeof SafeUtils.safeObject === 'function') {
      data = SafeUtils.safeObject(data);
    }
    // Use static schema definition to avoid re-allocation on every call
    const baseSchema = {
      userId: { type: "string", required: true },
      moderationId: { type: "string", required: false },
      isSystemGenerated: { type: "boolean", required: false, default: false },
      isPreApproved: { type: "boolean", required: false, default: false },
      priority: {
        type: "string",
        required: true,
      },
      contentId: { type: "string", required: true },
      type: { type: "string", required: true },
      contentType: { type: "string", required: false },
      mediaType: { type: "string", required: false },
      // Optional payloads (allowed but not required)
      content: { type: "object", required: false },
      notes: { type: "array", required: false },
    };

    // Embed values into schema for SafeUtils.sanitizeValidate (only known keys to prevent prototype pollution)
    const schema = {};
    const allowedKeys = new Set(Object.keys(baseSchema));
    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        schema[key] = { ...baseSchema[key], value: data[key] };
      } else {
        schema[key] = { ...baseSchema[key], value: undefined };
      }
    }

    const sanitized = SafeUtils.sanitizeValidate(schema);
    
    // Validate contentId format
    if (sanitized.contentId) {
      sanitized.contentId = this._validateContentIdFormat(sanitized.contentId);
    }
    
    // Validate empty strings after sanitization for required fields
    if (!sanitized.userId || sanitized.userId.trim() === '') {
      ErrorHandler.addError("userId cannot be empty or whitespace-only after sanitization", {
        code: "INVALID_USERID_EMPTY",
        origin: "Moderation._validateModerationData",
        data: { userId: sanitized.userId }
      });
      throw new Error("userId cannot be empty or whitespace-only after sanitization");
    }
    
    if (!sanitized.contentId || sanitized.contentId.trim() === '') {
      ErrorHandler.addError("contentId cannot be empty or whitespace-only after sanitization", {
        code: "INVALID_CONTENTID_EMPTY",
        origin: "Moderation._validateModerationData",
        data: { contentId: sanitized.contentId }
      });
      throw new Error("contentId cannot be empty or whitespace-only after sanitization");
    }

    // Validate type enum using SafeUtils.hasValue
    if (!SafeUtils.hasValue(sanitized.type) || !this.TYPE_SET.has(sanitized.type)) {
      ErrorHandler.addError(`Invalid type: ${sanitized.type}. Must be one of: ${Object.values(this.TYPE).join(", ")}` , {
        code: "INVALID_TYPE",
        origin: "Moderation._validateModerationData",
        data: { type: sanitized.type }
      });
      throw new Error(`Invalid type: ${sanitized.type}. Must be one of: ${Object.values(this.TYPE).join(", ")}`);
    }

    // Require priority (no default for create — caller must provide)
    if (!SafeUtils.hasValue(sanitized.priority)) {
      ErrorHandler.addError("priority is required", {
        code: "INVALID_MODERATION_DATA",
        origin: "Moderation._validateModerationData",
        data: { data }
      });
      throw new Error("priority is required");
    }
    // Validate priority enum
    if (!this.PRIORITY_SET.has(sanitized.priority)) {
      ErrorHandler.addError(`Invalid priority: ${sanitized.priority}. Must be one of: ${Object.values(this.PRIORITY).join(", ")}` , {
        code: "INVALID_PRIORITY",
        origin: "Moderation._validateModerationData",
        data: { priority: sanitized.priority }
      });
      throw new Error(`Invalid priority: ${sanitized.priority}. Must be one of: ${Object.values(this.PRIORITY).join(", ")}`);
    }

    // If status is explicitly provided, validate against STATUS_SET (reject invalid/__proto__/injection)
    if (data != null && Object.prototype.hasOwnProperty.call(data, "status") && data.status != null) {
      const statusVal = SafeUtils.sanitizeString(data.status);
      if (!statusVal || !this.STATUS_SET.has(statusVal)) {
        ErrorHandler.addError(`Invalid status: ${data.status}. Must be one of: ${[...this.STATUS_SET].join(", ")}`, {
          code: "INVALID_STATUS",
          origin: "Moderation._validateModerationData",
          data: { status: data.status }
        });
        throw new Error(`Invalid status: ${data.status}. Must be one of: ${[...this.STATUS_SET].join(", ")}`);
      }
    }

    Logger.debugLog?.(`[Moderation] [_validateModerationData] [SUCCESS] Moderation data validated: ${JSON.stringify(sanitized)}`);
    return sanitized;
  }

  /**
   * Create meta field for audit trail
   * @param {string} action - Action being performed
   * @param {string} userId - User performing the action
   * @param {Object} details - Additional details
   * @returns {Object} Meta field object
   */
  static _createMetaField(action, userId, details = {}) {
    Logger.debugLog?.(`[Moderation] [_createMetaField] [START] Creating meta field for action: ${action}, userId: ${userId}`);
    const timestamp = _currentTimestamp();
    const meta = {
      createdAt: timestamp,
      createdBy: userId,
      lastModifiedAt: timestamp,
      lastModifiedBy: userId,
      version: 1,
      history: [
        {
          action,
          timestamp,
          userId,
          ...details,
        },
      ],
    };
    Logger.debugLog?.(`[Moderation] [_createMetaField] [SUCCESS] Meta field created: ${JSON.stringify(meta)}`);
    return meta;
  }

  /**
   * Update meta field with new action
   * @param {Object} existingMeta - Existing meta field
   * @param {string} action - Action being performed
   * @param {string} userId - User performing the action
   * @param {Object} details - Additional details
   * @returns {Object} Updated meta field
   */
  static _updateMetaField(existingMeta, action, userId, details = {}) {
    Logger.debugLog?.(`[Moderation] [_updateMetaField] [START] Updating meta field for action: ${action}, userId: ${userId}`);
    const timestamp = _currentTimestamp();
    const MAX_HISTORY_ENTRIES = 100;
    
    // Use push on mutable copy instead of spread to avoid memory churn
    // Also implement history truncation to prevent unbounded growth
    const history = Array.isArray(existingMeta.history) ? [...existingMeta.history] : [];
    history.push({
      action,
      timestamp,
      userId,
      ...details,
    });
    // Truncate history to last N entries to prevent unbounded growth
    if (history.length > this.MAX_HISTORY_ENTRIES) {
      history.splice(0, history.length - this.MAX_HISTORY_ENTRIES);
    }
    
    const updatedMeta = {
      ...existingMeta,
      lastModifiedAt: timestamp,
      lastModifiedBy: userId,
      version: (existingMeta.version || 0) + 1,
      history,
    };
    Logger.debugLog?.(`[Moderation] [_updateMetaField] [SUCCESS] Meta field updated: ${JSON.stringify(updatedMeta)}`);
    return updatedMeta;
  }

  /**
   * Build partition key with sanitized userId
   * @param {string} userId - User ID
   * @returns {string} Partition key
   */
  static _buildPartitionKey(userId) {
    Logger.debugLog?.(`[Moderation] [_buildPartitionKey] [START] Building partition key for userId: ${userId}`);
    const sanitized = SafeUtils.sanitizeString(userId);
    // Explicit check for empty string after sanitization (e.g., whitespace-only input)
    // This prevents creating invalid partition key "moderation#" which would cause DynamoDB query failures
    if (!sanitized || sanitized.trim() === '') {
      ErrorHandler.addError("Invalid userId for partition key: userId is empty or contains only whitespace after sanitization", {
        code: "INVALID_USERID_PARTITION_KEY",
        origin: "Moderation._buildPartitionKey",
        data: { userId, sanitized }
      });
      throw new Error("Invalid userId for partition key: userId cannot be empty or whitespace-only");
    }
    const partitionKey = `${this.PK_PREFIX}${sanitized}`;
    Logger.debugLog?.(`[Moderation] [_buildPartitionKey] [SUCCESS] Partition key built: ${partitionKey}`);
    return partitionKey;
  }

  /**
   * Encode pagination token safely
   * @param {Object} lastKey - LastEvaluatedKey from DynamoDB response
   * @returns {string|null} Base64 encoded token or null if encoding fails
   */
  static _encodeNextToken(lastKey) {
    Logger.debugLog?.(`[Moderation] [_encodeNextToken] [START] Encoding lastKey: ${lastKey ? 'present' : 'null'}`);
    if (!lastKey) {
      Logger.debugLog?.(`[Moderation] [_encodeNextToken] [INFO] No lastKey provided, returning null.`);
      return null;
    }

    const hasNonSerializable = (obj, seen = new Set()) => {
      if (obj == null || typeof obj !== "object") return typeof obj === "function" || typeof obj === "symbol";
      if (seen.has(obj)) return true;
      seen.add(obj);
      try {
        for (const key of Object.keys(obj)) {
          if (hasNonSerializable(obj[key], seen)) return true;
        }
      } finally {
        seen.delete(obj);
      }
      return false;
    };
    if (hasNonSerializable(lastKey)) {
      Logger.debugLog?.(`[Moderation] [_encodeNextToken] [INFO] lastKey contains non-serializable values, returning null.`);
      return null;
    }

    try {
      // Include timestamp in token for expiration validation
      const tokenData = {
        lastKey,
        timestamp: this._getCurrentTimestamp(),
      };
      
      // Safely stringify the token data, handling potential circular references or non-serializable values
      const jsonString = JSON.stringify(tokenData);
      
      // Check for extremely large keys that could cause issues
      if (jsonString.length > this.MAX_PAGINATION_TOKEN_SIZE) {
        ErrorHandler.addError("Pagination token too large", {
          code: "PAGINATION_TOKEN_TOO_LARGE",
          origin: "Moderation._encodeNextToken",
          data: { keySize: jsonString.length }
        });
        Logger.debugLog?.(`[Moderation] [_encodeNextToken] [ERROR] Pagination token too large: ${jsonString.length} bytes`);
        return null;
      }

      const encoded = Buffer.from(jsonString, "utf8").toString("base64");
      Logger.debugLog?.(`[Moderation] [_encodeNextToken] [SUCCESS] Encoded nextToken (${encoded.length} chars)`);
      return encoded;
    } catch (error) {
      // Handle circular references, non-serializable values, or other JSON.stringify errors
      ErrorHandler.addError("Failed to encode pagination token", {
        code: "PAGINATION_TOKEN_ENCODING_FAILED",
        origin: "Moderation._encodeNextToken",
        data: { 
          error: error.message,
          errorType: error.constructor?.name,
          lastKeyType: typeof lastKey
        }
      });
      Logger.debugLog?.(`[Moderation] [_encodeNextToken] [ERROR] Failed to encode nextToken: ${error.message}`);
      // Return null instead of throwing to allow the response to continue without pagination token
      return null;
    }
  }

  /**
   * Decode pagination token
   * @param {string} nextToken - Base64 encoded token
   * @returns {Object|null} Decoded token or null
   */
  static _decodeNextToken(nextToken) {
    Logger.debugLog?.(`[Moderation] [_decodeNextToken] [START] Decoding nextToken: ${nextToken}`);
    const sanitized = SafeUtils.sanitizeString(nextToken);
    if (!sanitized) {
      Logger.debugLog?.(`[Moderation] [_decodeNextToken] [INFO] No nextToken provided, returning null.`);
      return null;
    }

    try {
      const decoded = JSON.parse(Buffer.from(sanitized, "base64").toString("utf8"));
      
      // Validate token age if timestamp is present (new format)
      if (decoded.timestamp) {
        const tokenAge = this._getCurrentTimestamp() - decoded.timestamp;
        if (tokenAge > this.PAGINATION_TOKEN_TTL_MS) {
          ErrorHandler.addError("Pagination token expired", {
            code: "PAGINATION_TOKEN_EXPIRED",
            origin: "Moderation._decodeNextToken",
            data: { 
              nextToken, 
              tokenAge, 
              ttl: this.PAGINATION_TOKEN_TTL_MS,
              ageMinutes: Math.round(tokenAge / 60000)
            }
          });
          throw new Error(`Pagination token expired. Token age: ${Math.round(tokenAge / 60000)} minutes, TTL: ${Math.round(this.PAGINATION_TOKEN_TTL_MS / 60000)} minutes`);
        }
      }
      
      // Return lastKey (backward compatible) or the decoded object if it's the new format
      const lastKey = decoded.lastKey || decoded;
      Logger.debugLog?.(`[Moderation] [_decodeNextToken] [SUCCESS] Decoded nextToken: ${decoded.timestamp ? 'with timestamp' : 'legacy format'}`);
      return lastKey;
    } catch (error) {
      ErrorHandler.addError("Invalid pagination token", {
        code: "INVALID_PAGINATION_TOKEN",
        origin: "Moderation._decodeNextToken",
        data: { nextToken, error: error.message }
      });
      Logger.debugLog?.(`[Moderation] [_decodeNextToken] [ERROR] Invalid nextToken: ${error.message}`);
      throw new Error("Invalid pagination token");
    }
  }

  /**
   * Validate note structure (text, addedBy, addedAt)
   * @param {Object} note - Note object to validate
   * @param {number} index - Index in array (for error context)
   * @returns {boolean} True if valid
   */
  static _validateNoteStructure(note, index = null) {
    if (!note || typeof note !== 'object') {
      ErrorHandler.addError("Note must be an object", {
        code: "INVALID_NOTE_STRUCTURE",
        origin: "Moderation._validateNoteStructure",
        data: { note, index }
      });
      throw new Error(`Note at index ${index !== null ? index : 'unknown'} must be an object`);
    }
    
    if (!note.text || typeof note.text !== 'string') {
      ErrorHandler.addError("Note text is required and must be a string", {
        code: "INVALID_NOTE_STRUCTURE",
        origin: "Moderation._validateNoteStructure",
        data: { note, index, field: 'text' }
      });
      throw new Error(`Note at index ${index !== null ? index : 'unknown'} must have a text field (string)`);
    }
    
    if (!note.addedBy || typeof note.addedBy !== 'string') {
      ErrorHandler.addError("Note addedBy is required and must be a string", {
        code: "INVALID_NOTE_STRUCTURE",
        origin: "Moderation._validateNoteStructure",
        data: { note, index, field: 'addedBy' }
      });
      throw new Error(`Note at index ${index !== null ? index : 'unknown'} must have an addedBy field (string)`);
    }
    
    if (note.addedAt !== undefined && (typeof note.addedAt !== 'number' || note.addedAt < 0)) {
      ErrorHandler.addError("Note addedAt must be a positive number if provided", {
        code: "INVALID_NOTE_STRUCTURE",
        origin: "Moderation._validateNoteStructure",
        data: { note, index, field: 'addedAt' }
      });
      throw new Error(`Note at index ${index !== null ? index : 'unknown'} addedAt must be a positive number if provided`);
    }
    
    // Validate note text length
    this._validateFieldLength("note.text", note.text, this.MAX_NOTE_LENGTH);
    
    return true;
  }

  /**
   * Validate action and status consistency
   * @param {string} action - Action value
   * @param {string} status - Status value
   */
  static _validateActionStatusConsistency(action, status) {
    if (!action || !status) return; // Skip if either is null/undefined
    
    const expectedStatusMap = {
      [this.ACTION.APPROVE]: [this.STATUS.APPROVED, this.STATUS.APPROVED_GLOBAL],
      [this.ACTION.REJECT]: [this.STATUS.REJECTED],
      [this.ACTION.PENDING_RESUBMISSION]: [this.STATUS.PENDING],
    };
    
    const expectedStatuses = expectedStatusMap[action];
    if (expectedStatuses && !expectedStatuses.includes(status)) {
      ErrorHandler.addError(`Action and status inconsistency: action=${action} does not match status=${status}`, {
        code: "ACTION_STATUS_INCONSISTENCY",
        origin: "Moderation._validateActionStatusConsistency",
        data: { action, status, expectedStatuses }
      });
      // Log warning but don't throw - used for consistency checks on existing data
    }
  }
  
  /**
   * Validate isDeleted and deletedAt consistency
   * @param {boolean} isDeleted - Is deleted flag
   * @param {number|null} deletedAt - Deleted timestamp
   */
  static _validateDeletedConsistency(isDeleted, deletedAt) {
    if (isDeleted && !deletedAt) {
      ErrorHandler.addError("isDeleted is true but deletedAt is not set", {
        code: "DELETED_CONSISTENCY_ERROR",
        origin: "Moderation._validateDeletedConsistency",
        data: { isDeleted, deletedAt }
      });
      throw new Error("isDeleted is true but deletedAt must be set");
    }
    if (!isDeleted && deletedAt !== null && deletedAt !== undefined) {
      ErrorHandler.addError("isDeleted is false but deletedAt is set", {
        code: "DELETED_CONSISTENCY_ERROR",
        origin: "Moderation._validateDeletedConsistency",
        data: { isDeleted, deletedAt }
      });
      throw new Error("isDeleted is false but deletedAt must be null");
    }
  }
  
  /**
   * Validate actionedAt and action consistency
   * @param {number|null} actionedAt - Actioned timestamp
   * @param {string|null} action - Action value
   */
  static _validateActionedAtConsistency(actionedAt, action) {
    if (action && !actionedAt) {
      ErrorHandler.addError("action is set but actionedAt is not set", {
        code: "ACTIONED_AT_CONSISTENCY_ERROR",
        origin: "Moderation._validateActionedAtConsistency",
        data: { action, actionedAt }
      });
      throw new Error("action is set but actionedAt must be set");
    }
    if (!action && actionedAt !== null && actionedAt !== undefined) {
      ErrorHandler.addError("action is null but actionedAt is set", {
        code: "ACTIONED_AT_CONSISTENCY_ERROR",
        origin: "Moderation._validateActionedAtConsistency",
        data: { action, actionedAt }
      });
      throw new Error("action is null but actionedAt must be null");
    }
  }
  
  /**
   * Validate escalated status consistency
   * @param {string} status - Status value
   * @param {string|null} escalatedBy - Escalated by value
   */
  static _validateEscalatedConsistency(status, escalatedBy) {
    if (status === this.STATUS.ESCALATED && !escalatedBy) {
      ErrorHandler.addError("Status is ESCALATED but escalatedBy is not set", {
        code: "ESCALATED_CONSISTENCY_ERROR",
        origin: "Moderation._validateEscalatedConsistency",
        data: { status, escalatedBy }
      });
      throw new Error("Status is ESCALATED but escalatedBy must be set");
    }
    if (status !== this.STATUS.ESCALATED && escalatedBy !== null && escalatedBy !== undefined) {
      ErrorHandler.addError("Status is not ESCALATED but escalatedBy is set", {
        code: "ESCALATED_CONSISTENCY_ERROR",
        origin: "Moderation._validateEscalatedConsistency",
        data: { status, escalatedBy }
      });
      throw new Error("Status is not ESCALATED but escalatedBy must be null");
    }
  }
  
  /**
   * Validate statusSubmittedAt consistency with status
   * @param {string} status - Status value
   * @param {string} statusSubmittedAt - Status submitted at key
   * @param {number} submittedAt - Submitted timestamp
   */
  static _validateStatusSubmittedAtConsistency(status, statusSubmittedAt, submittedAt) {
    const expectedKey = this.statusSubmittedAtKey(status, submittedAt);
    if (statusSubmittedAt !== expectedKey) {
      ErrorHandler.addError("statusSubmittedAt does not match current status", {
        code: "STATUS_SUBMITTED_AT_INCONSISTENCY",
        origin: "Moderation._validateStatusSubmittedAtConsistency",
        data: { status, statusSubmittedAt, expectedKey, submittedAt }
      });
      // Log warning but don't throw - allow data to exist but log inconsistency
    }
  }

  /**
   * Validate field length
   * @param {string} fieldName - Field name
   * @param {string} value - Value to check
   * @param {number} maxLength - Maximum length
   */
  static _validateFieldLength(fieldName, value, maxLength) {
    Logger.debugLog?.(`[Moderation] [_validateFieldLength] [START] Validating field length for ${fieldName}, value: ${value}, maxLength: ${maxLength}`);
    if (value && value.length > maxLength) {
      ErrorHandler.addError(`${fieldName} exceeds maximum length of ${maxLength}`, {
        code: "FIELD_LENGTH_EXCEEDED",
        origin: "Moderation._validateFieldLength",
        data: { fieldName, value, maxLength }
      });
      Logger.debugLog?.(`[Moderation] [_validateFieldLength] [ERROR] ${fieldName} exceeds maximum length of ${maxLength}`);
      throw new Error(`${fieldName} exceeds maximum length of ${maxLength}`);
    }
  }

  /**
   * Validate contentId format (alphanumeric with dashes/underscores, min 1 char)
   * @param {string} contentId - Content ID to validate
   * @returns {string} Validated content ID
   */
  static _validateContentIdFormat(contentId) {
    Logger.debugLog?.(`[Moderation] [_validateContentIdFormat] [START] Validating contentId format: ${contentId}`);
    if (!contentId || typeof contentId !== 'string') {
      ErrorHandler.addError("contentId is required and must be a string", {
        code: "INVALID_CONTENT_ID_FORMAT",
        origin: "Moderation._validateContentIdFormat",
        data: { contentId }
      });
      throw new Error("contentId is required and must be a string");
    }
    // Sanitize first so path traversal etc. can be rejected
    const sanitized = SafeUtils.sanitizeString(contentId);
    if (contentId.includes("..") || /\.\.\/|\/\.\./.test(contentId)) {
      ErrorHandler.addError("contentId must not contain path traversal sequences", {
        code: "INVALID_CONTENT_ID_FORMAT",
        origin: "Moderation._validateContentIdFormat",
        data: { contentId }
      });
      throw new Error("contentId must not contain path traversal sequences");
    }
    // Validate contentId is not empty after trimming
    const trimmed = (sanitized != null ? sanitized : contentId).trim();
    if (trimmed.length === 0) {
      ErrorHandler.addError("contentId cannot be empty or whitespace-only", {
        code: "INVALID_CONTENT_ID_FORMAT",
        origin: "Moderation._validateContentIdFormat",
        data: { contentId }
      });
      throw new Error("contentId cannot be empty or whitespace-only");
    }
    
    // Validate format: alphanumeric, dashes, underscores, dots (common content ID patterns)
    // Minimum 1 character, maximum 255 characters
    if (trimmed.length > 255) {
      ErrorHandler.addError("contentId exceeds maximum length of 255 characters", {
        code: "INVALID_CONTENT_ID_FORMAT",
        origin: "Moderation._validateContentIdFormat",
        data: { contentId, length: trimmed.length }
      });
      throw new Error("contentId exceeds maximum length of 255 characters");
    }
    
    // Allow alphanumeric, dashes, underscores, dots (common content ID patterns)
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
      ErrorHandler.addError("contentId contains invalid characters. Only alphanumeric, dashes, underscores, and dots are allowed", {
        code: "INVALID_CONTENT_ID_FORMAT",
        origin: "Moderation._validateContentIdFormat",
        data: { contentId }
      });
      throw new Error("contentId contains invalid characters. Only alphanumeric, dashes, underscores, and dots are allowed");
    }
    
    Logger.debugLog?.(`[Moderation] [_validateContentIdFormat] [SUCCESS] Valid contentId format`);
    return trimmed;
  }

  /**
   * Validate moderationId format (UUID pattern)
   * @param {string} moderationId - Moderation ID to validate
   * @returns {string} Validated moderationId
   */
  static _validateModerationIdFormat(moderationId) {
    Logger.debugLog?.(`[Moderation] [_validateModerationIdFormat] [START] Validating moderationId format: ${moderationId}`);
    if (!moderationId || typeof moderationId !== "string") {
      ErrorHandler.addError("moderationId must be a non-empty string", {
        code: "INVALID_MODERATION_ID_TYPE",
        origin: "Moderation._validateModerationIdFormat",
        data: { moderationId }
      });
      throw new Error("moderationId must be a non-empty string");
    }

    // UUID format: 8-4-4-4-12 hexadecimal characters
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(moderationId)) {
      ErrorHandler.addError(`Invalid moderationId format: must be a valid UUID (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)`, {
        code: "INVALID_MODERATION_ID_FORMAT",
        origin: "Moderation._validateModerationIdFormat",
        data: { moderationId }
      });
      throw new Error(`Invalid moderationId format: must be a valid UUID (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)`);
    }

    Logger.debugLog?.(`[Moderation] [_validateModerationIdFormat] [SUCCESS] ModerationId format validated: ${moderationId}`);
    return moderationId;
  }

  /**
   * Retry operation with exponential backoff
   * @param {Function} operation - Async operation to retry
   * @param {number} maxRetries - Maximum retry attempts
   * @param {number} backoff - Initial backoff in milliseconds
   * @returns {Promise} Operation result
   */
  static async _retryOperation(
    operation,
    maxRetries = this.RETRY_MAX_ATTEMPTS,
    backoff = this.RETRY_BACKOFF_MS
  ) {
    Logger.debugLog?.(`[Moderation] [_retryOperation] [START] Retrying operation with maxRetries: ${maxRetries}, backoff: ${backoff}`);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();
        Logger.debugLog?.(`[Moderation] [_retryOperation] [SUCCESS] Operation succeeded on attempt ${attempt}`);
        return result;
      } catch (error) {
        const code = error?.code || error?.awsType || (error?.name && String(error.name));
        const nonRetryableCodes = [
          "ValidationException",
          "ResourceNotFoundException",
          "AccessDeniedException",
        ];
        const isNonRetryable = nonRetryableCodes.some(
          (c) => code && (code === c || (typeof code === "string" && code.includes(c)))
        );
        if (isNonRetryable) {
          Logger.debugLog?.(`[Moderation] [_retryOperation] [INFO] Non-retryable error (${code}), throwing immediately`);
          throw error;
        }
        if (attempt === maxRetries) {
          const errorMessage = error?.message || String(error);
          const finalError = new Error(`Operation failed after ${maxRetries} retries: ${errorMessage}`);
          finalError.originalError = error;
          
          // Ensure error is logged with full context before throwing
          // This prevents unhandled rejections by ensuring errors are always logged
          ErrorHandler.addError(`Operation failed after ${maxRetries} retries: ${errorMessage}`, {
            code: "OPERATION_RETRY_FAILED",
            origin: "Moderation._retryOperation",
            data: { 
              maxRetries, 
              backoff,
              originalError: error?.message,
              originalErrorType: error?.constructor?.name,
              stack: error?.stack,
              awsType: error?.awsType,
              awsMsg: error?.awsMsg,
              httpStatus: error?.httpStatus
            },
          });
          throw finalError;
        }

        Logger.debugLog?.(`[Moderation] [_retryOperation] [INFO] Operation failed on attempt ${attempt}, retrying in ${backoff * attempt}ms`);
        await new Promise((resolve) => setTimeout(resolve, backoff * attempt));
      }
    }
  }

  static generateModerationId() {
    Logger.debugLog?.(`[Moderation] [generateModerationId] [START] Generating moderation ID`);
    const hasWebCrypto = crypto.webcrypto && typeof crypto.webcrypto.randomUUID === 'function';
    const hasRandomUUID = typeof crypto.randomUUID === 'function';
    if (!hasWebCrypto && !hasRandomUUID) {
      ErrorHandler.addError("crypto.randomUUID is not available", {
        code: "UUID_GENERATION_FAILED",
        origin: "Moderation.generateModerationId",
        data: {}
      });
      throw new Error("crypto.randomUUID is not available");
    }
    try {
      // Prefer webcrypto API (Node 19+) which uses the same efficient implementation
      let id;
      if (hasWebCrypto) {
        id = crypto.webcrypto.randomUUID();
      } else {
        id = crypto.randomUUID();
      }
      Logger.debugLog?.(`[Moderation] [generateModerationId] [SUCCESS] Generated ID: ${id}`);
      return id;
    } catch (error) {
      ErrorHandler.addError(`Failed to generate UUID: ${error.message}`, {
        code: "UUID_GENERATION_FAILED",
        origin: "Moderation.generateModerationId",
        data: { error: error.message }
      });
      throw new Error(`Failed to generate UUID: ${error.message}`);
    }
  }

  static dayKeyFromTs(ts) {
    Logger.debugLog?.(`[Moderation] [dayKeyFromTs] [START] Generating day key from timestamp: ${ts}`);
    try {
      const validated = SafeUtils.sanitizeInteger(ts);
      if (validated === null) {
        ErrorHandler.addError("Invalid timestamp for dayKey generation", {
          code: "INVALID_TIMESTAMP_DAY_KEY",
          origin: "Moderation.dayKeyFromTs",
          data: { ts }
        });
        throw new Error("Invalid timestamp for dayKey generation");
      }
      if (validated < 0) {
        ErrorHandler.addError("Invalid timestamp: must be non-negative", {
          code: "INVALID_TIMESTAMP_DAY_KEY",
          origin: "Moderation.dayKeyFromTs",
          data: { ts, validated }
        });
        throw new Error("Invalid timestamp: must be non-negative");
      }
      const maxReasonableTs = 4133980800000; // ~2101-01-01 UTC
      if (validated > maxReasonableTs) {
        ErrorHandler.addError("Invalid timestamp: beyond reasonable date range", {
          code: "INVALID_TIMESTAMP_DAY_KEY",
          origin: "Moderation.dayKeyFromTs",
          data: { ts, validated }
        });
        throw new Error("Invalid timestamp: beyond reasonable date range");
      }
      // Use efficient inline UTC date formatting instead of DateTime utility
      // Format: YYYYMMDD in UTC (e.g., 20240115)
      const date = new Date(validated);
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      const dayKey = `${year}${month}${day}`;
      Logger.debugLog?.(`[Moderation] [dayKeyFromTs] [SUCCESS] Generated day key: ${dayKey}`);
      return dayKey;
    } catch (error) {
      ErrorHandler.addError(`Failed to generate dayKey: ${error.message}`, {
        code: "DAY_KEY_GENERATION_FAILED",
        origin: "Moderation.dayKeyFromTs",
        data: { ts },
      });
      throw new Error(`Failed to generate dayKey: ${error.message}`);
    }
  }

  static statusSubmittedAtKey(status, ts) {
    Logger.debugLog?.(`[Moderation] [statusSubmittedAtKey] [START] Generating statusSubmittedAtKey for status: ${status}, ts: ${ts}`);
    try {
      const sanitizedStatus = SafeUtils.sanitizeString(status);
      const sanitizedTs = SafeUtils.sanitizeInteger(ts);

      if (!sanitizedStatus || sanitizedTs === null) {
        ErrorHandler.addError("Invalid status or timestamp for key generation", {
          code: "INVALID_STATUS_TS_KEY",
          origin: "Moderation.statusSubmittedAtKey",
          data: { status, ts }
        });
        throw new Error("Invalid status or timestamp for key generation");
      }
      if (!this.STATUS_SET.has(sanitizedStatus)) {
        ErrorHandler.addError(`Invalid status for key: ${sanitizedStatus}`, {
          code: "INVALID_STATUS_TS_KEY",
          origin: "Moderation.statusSubmittedAtKey",
          data: { status, ts }
        });
        throw new Error(`Invalid status: ${sanitizedStatus} must be one of ${[...this.STATUS_SET].join(", ")}`);
      }

      // Use EPOCH_DIGITS constant for padding
      const padded = String(sanitizedTs).padStart(this.EPOCH_DIGITS, "0");
      const key = `${sanitizedStatus}#${padded}`;
      Logger.debugLog?.(`[Moderation] [statusSubmittedAtKey] [SUCCESS] Generated key: ${key}`);
      return key;
    } catch (error) {
      ErrorHandler.addError(`Failed to generate statusSubmittedAtKey: ${error.message}`, {
        code: "STATUS_KEY_GENERATION_FAILED",
        origin: "Moderation.statusSubmittedAtKey",
        data: { status, ts },
      });
      throw new Error(`Failed to generate statusSubmittedAtKey: ${error.message}`);
    }
  }

  /**
   * ============================================================
   *   Writes
   * ============================================================
   */

  /** Create one moderation record (GSIs update automatically) */
  static async createModerationEntry(data, timestamp = undefined) {
    Logger.debugLog?.(`[Moderation] [createModerationEntry] [START] Creating moderation entry with data: ${JSON.stringify(data)}, timestamp: ${timestamp}`);
    try {
      // Validate and sanitize input data
      const sanitizedData = this._validateModerationData(data);

      // Validate and sanitize timestamp
      const submittedAt = this._validateTimestamp(timestamp);

      // Generate or use provided moderation ID
      let moderationId;
      if (sanitizedData.moderationId) {
        // Validate format if moderationId is provided
        moderationId = this._validateModerationIdFormat(sanitizedData.moderationId);
        
        // Check for duplicate moderationId to prevent referential integrity issues
        // Query GSI_BY_MOD_ID to see if this moderationId already exists
        try {
          const existingQuery = await this._retryOperation(() =>
            Scylla.request("Query", {
              TableName: this.TABLE,
              IndexName: this.GSI_BY_MOD_ID,
              KeyConditionExpression: "#mid = :mid",
              ExpressionAttributeNames: {
                "#mid": "moderationId"
              },
              ExpressionAttributeValues: Scylla.marshalItem({
                ":mid": moderationId
              }),
              Limit: 1
            })
          );
          
          if (existingQuery.Items && existingQuery.Items.length > 0) {
            const existingItem = Scylla.unmarshalItem(existingQuery.Items[0]);
            ErrorHandler.addError(`Duplicate moderationId detected: ${moderationId} already exists`, {
              code: "DUPLICATE_MODERATION_ID",
              origin: "Moderation.createModerationEntry",
              data: { 
                moderationId,
                existingUserId: existingItem.userId,
                existingPK: existingItem[this.PK],
                existingSK: existingItem[this.SK]
              }
            });
            throw new Error(`ModerationId ${moderationId} already exists. Each moderationId must be unique.`);
          }
        } catch (error) {
          // If error is already our duplicate error, re-throw it
          if (error.message && error.message.includes("already exists")) {
            throw error;
          }
          // GSI query failed (e.g. transient or DB error); rethrow so caller gets failure after retries
          Logger.debugLog?.(`[Moderation] [createModerationEntry] [WARN] Duplicate check failed: ${error.message}`);
          throw error;
        }
      } else {
        moderationId = this.generateModerationId();
      }

      // Use userId from sanitizedData (already sanitized by _validateModerationData)
      // No need for redundant sanitization
      const sanitizedUserId = sanitizedData.userId;
      if (!sanitizedUserId || sanitizedUserId.trim() === '') {
        ErrorHandler.addError("Invalid userId: cannot be empty or whitespace-only after sanitization", {
          code: "INVALID_USERID_EMPTY",
          origin: "Moderation.createModerationEntry",
          data: { data, originalUserId: sanitizedData.userId, sanitizedUserId }
        });
        throw new Error("Invalid userId: cannot be empty or whitespace-only");
      }

      const pk = this._buildPartitionKey(sanitizedUserId);
      // Include moderationId in sort key to ensure uniqueness and prevent collisions
      // Format: media#<submittedAt>#<moderationId>
      const sk = `media#${submittedAt}#${moderationId}`;

      // Create meta field for audit trail
      const meta = this._createMetaField("create", sanitizedUserId, {
        moderationId,
        type: sanitizedData.type,
        priority: sanitizedData.priority,
      });

      const compressedContent = sanitizedData.content ? await this._compressContent(sanitizedData.content) : null;
      const contentCompressed = !!(compressedContent && typeof compressedContent === "object" && compressedContent._compressed === true);

      const item = {
        [this.PK]: pk,
        [this.SK]: sk,
        moderationId,
        userId: sanitizedUserId,
        contentId: sanitizedData.contentId,
        type: sanitizedData.type,
        status: sanitizedData.isPreApproved ? this.STATUS.APPROVED : this.STATUS.PENDING,
        priority: sanitizedData.priority,
        contentType: sanitizedData.contentType || null,
        mediaType: sanitizedData.mediaType || null,
        isSystemGenerated: !!sanitizedData.isSystemGenerated,
        isPreApproved: !!sanitizedData.isPreApproved,
        submittedAt,
        actionedAt: null,
        moderatedBy: null,
        escalatedBy: null,
        reason: null,
        action: null,
        // Don't store empty arrays, objects - save space
        // Compress large content payloads to reduce storage and bandwidth
        content: compressedContent,
        contentCompressed,
        ...(sanitizedData.notes && sanitizedData.notes.length > 0
          ? (() => {
              // Validate notes array length to prevent unbounded growth
              if (sanitizedData.notes.length > this.MAX_NOTES_PER_ITEM) {
                ErrorHandler.addError(`Notes array exceeds maximum limit (${this.MAX_NOTES_PER_ITEM}) for moderation item`, {
                  code: "MAX_NOTES_LIMIT_EXCEEDED",
                  origin: "Moderation.createModerationEntry",
                  data: { 
                    moderationId,
                    userId: sanitizedUserId,
                    notesCount: sanitizedData.notes.length,
                    maxNotes: this.MAX_NOTES_PER_ITEM
                  }
                });
                throw new Error(`Notes array exceeds maximum limit (${this.MAX_NOTES_PER_ITEM}). Provided: ${sanitizedData.notes.length}, Max: ${this.MAX_NOTES_PER_ITEM}`);
              }
              // Validate each note structure
              sanitizedData.notes.forEach((note, index) => {
                this._validateNoteStructure(note, index);
              });
              return { notes: sanitizedData.notes };
            })()
          : {}),
        // Soft delete support (future)
        isDeleted: false,
        deletedAt: null,
        // Audit trail
        meta,
        // GSI attributes
        dayKey: this.dayKeyFromTs(submittedAt),
        statusSubmittedAt: this.statusSubmittedAtKey(
          sanitizedData.isPreApproved ? this.STATUS.APPROVED : this.STATUS.PENDING,
          submittedAt
        ),
      };

      // Use retry mechanism for database operation with ConditionExpression to prevent overwrites
      // Check that PK and SK don't already exist to prevent silent data loss
      try {
        await this._retryOperation(() =>
          Scylla.putItem(this.TABLE, item, {
            ConditionExpression: "attribute_not_exists(#pk) AND attribute_not_exists(#sk)",
            ExpressionAttributeNames: {
              "#pk": this.PK,
              "#sk": this.SK
            }
          })
        );
      } catch (error) {
        // Check if it's a conditional check failure (item already exists)
        if (error.awsType && error.awsType.includes("ConditionalCheckFailedException")) {
          ErrorHandler.addError(`Moderation entry already exists for PK: ${pk}, SK: ${sk}`, {
            code: "MODERATION_ENTRY_ALREADY_EXISTS",
            origin: "Moderation.createModerationEntry",
            data: { 
              pk, 
              sk, 
              moderationId,
              userId: sanitizedUserId,
              submittedAt
            }
          });
          throw new Error(`Moderation entry already exists. This may indicate a duplicate submission or timestamp collision.`);
        }
        // Re-throw other errors (ensure they're logged if not already logged)
        if (error && !error._logged) {
          ErrorHandler.addError(`Error during moderation entry creation: ${error.message}`, {
            code: "MODERATION_ENTRY_CREATION_ERROR",
            origin: "Moderation.createModerationEntry",
            data: { error: error.message, errorType: error.constructor?.name, stack: error.stack }
          });
          error._logged = true;
        }
        throw error;
      }

      try {
        await Logger.writeLog({
          flag: "MODERATIONS",
          action: "moderationCreated",
          data: {
            moderationId,
            userId: sanitizedUserId,
            type: sanitizedData.type,
          }
        });
      } catch (logError) {
        Logger.debugLog?.(`[Moderation] [createModerationEntry] [WARN] Logging failed: ${logError?.message}`);
      }
      Logger.debugLog?.(`[Moderation] [createModerationEntry] [SUCCESS] Moderation entry created with ID: ${moderationId}`);
      return moderationId;
    } catch (error) {
      ErrorHandler.addError(`Failed to create moderation entry: ${error.message}`, {
        code: "MODERATION_ENTRY_CREATION_FAILED",
        origin: "Moderation.createModerationEntry",
        data: { data, timestamp },
      });
      throw new Error(`Failed to create moderation entry: ${error.message}`);
    }
  }


  // update moderation entry
  static async updateModerationEntry(moderationId, updates, userId = null) {
    Logger.debugLog?.(`[Moderation] [updateModerationEntry] [START] Updating moderation entry for ID: ${moderationId}, userId: ${userId}, updates: ${JSON.stringify(updates)}`);
    try {
      // Sanitize and validate moderationId
      const sanitizedModerationId = SafeUtils.sanitizeString(moderationId);
      if (!sanitizedModerationId) {
        ErrorHandler.addError("moderationId is required", {
          code: "MODERATION_ID_REQUIRED",
          origin: "Moderation.updateModerationEntry",
          data: { moderationId }
        });
        throw new Error("moderationId is required");
      }
      // Validate UUID format
      this._validateModerationIdFormat(sanitizedModerationId);
      
      // Require userId to avoid GSI eventual consistency issues
      // When userId is provided, we can use direct getItem with PK/SK for consistent reads
      const sanitizedUserId = userId ? SafeUtils.sanitizeString(userId) : null;
      if (!sanitizedUserId || sanitizedUserId.trim() === '') {
        ErrorHandler.addError("userId is required for updateModerationEntry to ensure consistent reads and avoid GSI eventual consistency issues", {
          code: "USERID_REQUIRED_FOR_UPDATE",
          origin: "Moderation.updateModerationEntry",
          data: { moderationId, userId }
        });
        throw new Error("userId is required for updateModerationEntry to ensure consistent reads");
      }

      if (!updates || typeof updates !== "object") {
        ErrorHandler.addError("Updates must be an object", {
          code: "UPDATES_MUST_BE_OBJECT",
          origin: "Moderation.updateModerationEntry",
          data: { updates }
        });
        throw new Error("Updates must be an object");
      }
      if (typeof SafeUtils.safeObject === 'function') {
        updates = SafeUtils.safeObject(updates);
      } else if (Object.prototype.hasOwnProperty.call(updates, "__proto__") || Object.prototype.hasOwnProperty.call(updates, "constructor") || Object.prototype.hasOwnProperty.call(updates, "prototype")) {
        ErrorHandler.addError("Invalid updates: prototype pollution attempt rejected", {
          code: "INVALID_UPDATES_PROTO_POLLUTION",
          origin: "Moderation.updateModerationEntry",
          data: {}
        });
        throw new Error("Invalid updates: prototype pollution attempt rejected");
      }

      // Optimistic locking: retry read-modify-write until version check succeeds
      let result;
      let retryCount = 0;
      const maxOptimisticRetries = 5;
      let validUpdates;

      while (retryCount < maxOptimisticRetries) {
      // Get existing item using direct getItem with PK/SK to avoid GSI eventual consistency issues
      // Build PK from userId and query by moderationId to get SK, then use direct getItem
      const pk = this._buildPartitionKey(sanitizedUserId);
      
      // Query GSI to find the item's SK, but only if we don't have a way to construct it directly
      // Since we have userId, we can query GSI_USER_STATUS_DATE or use GSI_BY_MOD_ID with userId
      // However, to avoid eventual consistency, we'll query GSI_BY_MOD_ID with both moderationId and userId
      // This is more reliable than querying by moderationId alone
      let item;
      try {
        const query = await this._retryOperation(() =>
          Scylla.request("Query", {
            TableName: this.TABLE,
            IndexName: this.GSI_BY_MOD_ID,
            KeyConditionExpression: "#mid = :mid AND #uid = :uid",
            ExpressionAttributeNames: {
              "#mid": "moderationId",
              "#uid": "userId"
            },
            ExpressionAttributeValues: Scylla.marshalItem({
              ":mid": sanitizedModerationId,
              ":uid": sanitizedUserId,
            }),
            Limit: 1,
          })
        );
        
        const found = (query.Items ?? []).map(Scylla.unmarshalItem)[0];
        if (!found) {
          ErrorHandler.addError(`Moderation item not found: moderationId=${sanitizedModerationId}, userId=${sanitizedUserId}`, {
            code: "MODERATION_ITEM_NOT_FOUND",
            origin: "Moderation.updateModerationEntry",
            data: { moderationId: sanitizedModerationId, userId: sanitizedUserId }
          });
          throw new Error(`Moderation item not found: moderationId=${sanitizedModerationId}, userId=${sanitizedUserId}`);
        }
        
        // Use direct getItem with PK/SK for consistent read (avoids GSI eventual consistency)
        const getItemResult = await this._retryOperation(() =>
          Scylla.getItem(this.TABLE, {
            [this.PK]: found[this.PK],
            [this.SK]: found[this.SK],
          })
        );
        const rawItem = getItemResult != null && Object.prototype.hasOwnProperty.call(getItemResult, "Item")
          ? getItemResult.Item
          : getItemResult;
        // Decompress content if it was compressed
        item = await this._decompressItemsContent(rawItem);
      } catch (error) {
        // If GSI query fails due to eventual consistency, retry with exponential backoff
        if (retryCount < maxOptimisticRetries - 1 && error.message && error.message.includes("not found")) {
          retryCount++;
          await new Promise(resolve => setTimeout(resolve, 50 * retryCount));
          continue;
        }
        // Ensure error is logged before re-throwing
        if (error && !error._logged) {
          ErrorHandler.addError(`Error during update operation: ${error.message}`, {
            code: "UPDATE_OPERATION_ERROR",
            origin: "Moderation.updateModerationEntry",
            data: { moderationId: sanitizedModerationId, userId: sanitizedUserId, error: error.message, errorType: error.constructor?.name, retryCount }
          });
          error._logged = true;
        }
        throw error;
      }
      
      if (!item) {
        ErrorHandler.addError(`Moderation item not found: ${sanitizedModerationId}`, {
          code: "MODERATION_ITEM_NOT_FOUND",
          origin: "Moderation.updateModerationEntry",
          data: { moderationId: sanitizedModerationId, userId: sanitizedUserId }
        });
        throw new Error(`Moderation item not found: ${sanitizedModerationId}`);
      }

        // Capture current version for optimistic locking
        const existingMeta = item.meta || this._createMetaField("create", item.userId);
        const currentVersion = existingMeta.version || 0;

      // Validate and prepare updates
      // We map fields from the input 'updates' (which mirrors create inputs) to DB fields
      validUpdates = {};

      // Validate isDeleted/deletedAt consistency when either is present
      if (updates.isDeleted !== undefined || updates.deletedAt !== undefined) {
        const isDeleted = updates.isDeleted !== undefined ? !!updates.isDeleted : item.isDeleted;
        const deletedAt = updates.deletedAt !== undefined ? updates.deletedAt : item.deletedAt;
        this._validateDeletedConsistency(isDeleted, deletedAt);
        validUpdates.isDeleted = !!isDeleted;
        validUpdates.deletedAt = deletedAt;
      }

      // Fields allowed to be updated (matching createModerationEntry inputs)
      if (updates.contentId)
        validUpdates.contentId = SafeUtils.sanitizeString(updates.contentId);
      if (updates.contentType)
        validUpdates.contentType = SafeUtils.sanitizeString(
          updates.contentType
        );
      if (updates.mediaType)
        validUpdates.mediaType = SafeUtils.sanitizeString(updates.mediaType);

      if (updates.isSystemGenerated !== undefined) {
        validUpdates.isSystemGenerated = !!updates.isSystemGenerated;
      }

      if (updates.isPreApproved !== undefined) {
        validUpdates.isPreApproved = !!updates.isPreApproved;
      }

      if (updates.priority) {
        const p = SafeUtils.sanitizeString(updates.priority);
        if (!this.PRIORITY_SET.has(p)) {
          ErrorHandler.addError(`Invalid priority: ${p}`, {
            code: "INVALID_PRIORITY_UPDATE",
            origin: "Moderation.updateModerationEntry",
            data: { priority: p }
          });
          throw new Error(`Invalid priority: ${p}`);
        }
        validUpdates.priority = p;
      }

      if (updates.type) {
        const t = SafeUtils.sanitizeString(updates.type);
        if (!this.TYPE_SET.has(t)) {
          ErrorHandler.addError(`Invalid type: ${t}`, {
            code: "INVALID_TYPE_UPDATE",
            origin: "Moderation.updateModerationEntry",
            data: { type: t }
          });
          throw new Error(`Invalid type: ${t}`);
        }
        validUpdates.type = t;
      }

      if (updates.status) {
        const s = SafeUtils.sanitizeString(updates.status);
        if (!this.STATUS_SET.has(s)) {
          ErrorHandler.addError(`Invalid status: ${s}`, {
            code: "INVALID_STATUS_UPDATE",
            origin: "Moderation.updateModerationEntry",
            data: { status: s }
          });
          throw new Error(`Invalid status: ${s}`);
        }
        validUpdates.status = s;
      }

      if (updates.action !== undefined) {
        const a = updates.action != null ? SafeUtils.sanitizeString(updates.action) : null;
        if (a != null && !this.ACTION_SET.has(a)) {
          ErrorHandler.addError(`Invalid action: ${a}`, {
            code: "INVALID_ACTION_UPDATE",
            origin: "Moderation.updateModerationEntry",
            data: { action: a }
          });
          throw new Error(`Invalid action: ${a}`);
        }
        validUpdates.action = a;
      }
      if (updates.actionedAt !== undefined) {
        validUpdates.actionedAt = updates.actionedAt != null ? SafeUtils.sanitizeInteger(updates.actionedAt) : null;
      }
      if (updates.escalatedBy !== undefined) {
        validUpdates.escalatedBy = updates.escalatedBy != null ? SafeUtils.sanitizeString(updates.escalatedBy) : null;
      }

      // Validate action/actionedAt and status/escalatedBy consistency when any of these are being updated
      if (updates.action !== undefined || updates.actionedAt !== undefined) {
        const effectiveAction = validUpdates.action !== undefined ? validUpdates.action : item.action;
        const effectiveActionedAt = validUpdates.actionedAt !== undefined ? validUpdates.actionedAt : item.actionedAt;
        this._validateActionedAtConsistency(effectiveActionedAt, effectiveAction);
      }
      if (updates.status !== undefined || updates.escalatedBy !== undefined) {
        const effectiveStatus = validUpdates.status !== undefined ? validUpdates.status : item.status;
        const effectiveEscalatedBy = validUpdates.escalatedBy !== undefined ? validUpdates.escalatedBy : item.escalatedBy;
        this._validateEscalatedConsistency(effectiveStatus, effectiveEscalatedBy);
      }

      // Complex objects
      if (updates.content) validUpdates.content = updates.content;
      if (updates.notes && Array.isArray(updates.notes)) {
        // Validate notes array length to prevent unbounded growth
        if (updates.notes.length > this.MAX_NOTES_PER_ITEM) {
          ErrorHandler.addError(`Notes array exceeds maximum limit (${this.MAX_NOTES_PER_ITEM}) for moderation item`, {
            code: "MAX_NOTES_LIMIT_EXCEEDED",
            origin: "Moderation.updateModerationEntry",
            data: { 
              moderationId: sanitizedModerationId,
              userId: sanitizedUserId,
              notesCount: updates.notes.length,
              maxNotes: this.MAX_NOTES_PER_ITEM
            }
          });
          throw new Error(`Notes array exceeds maximum limit (${this.MAX_NOTES_PER_ITEM}). Provided: ${updates.notes.length}, Max: ${this.MAX_NOTES_PER_ITEM}`);
        }
        // Validate each note structure
        updates.notes.forEach((note, index) => {
          this._validateNoteStructure(note, index);
        });
        validUpdates.notes = updates.notes;
      }

      // If nothing to update
      if (Object.keys(validUpdates).length === 0) {
        Logger.debugLog?.(`[Moderation] [updateModerationEntry] [INFO] No updates to apply for ID: ${sanitizedModerationId}`);
        return item;
      }

      // Update Meta
      // Use userId from existing item if not provided in updates
      const actionUserId = updates.userId
        ? SafeUtils.sanitizeString(updates.userId)
        : item.userId;

      const updatedMeta = this._updateMetaField(
        existingMeta,
        "update",
        actionUserId,
        { fields: Object.keys(validUpdates) }
      );

      validUpdates.meta = updatedMeta;

      // All validation and update preparation is complete before the atomic update
      // DynamoDB UpdateItem is atomic - all attributes in the update are updated atomically
      // Either all fields are updated successfully or the operation fails and no fields are updated
      // This ensures transactional guarantees for single-item updates

        // Perform update with optimistic locking condition
        try {
          result = await this._retryOperation(() =>
        Scylla.updateItem(
          this.TABLE,
          { [this.PK]: item[this.PK], [this.SK]: item[this.SK] },
              validUpdates,
              {
                ConditionExpression: "#meta.#version = :expectedVersion",
                ExpressionAttributeNames: {
                  "#meta": "meta",
                  "#version": "version"
                },
                ExpressionAttributeValues: Scylla.marshalItem({
                  ":expectedVersion": currentVersion
                })
              }
            )
          );
          // Success - break out of retry loop
          break;
        } catch (error) {
          // Check if it's a conditional check failure (version mismatch)
          if (error.awsType && error.awsType.includes("ConditionalCheckFailedException")) {
            retryCount++;
            if (retryCount >= maxOptimisticRetries) {
              ErrorHandler.addError(`Optimistic locking failed after ${maxOptimisticRetries} retries: ${error.message}`, {
                code: "OPTIMISTIC_LOCK_FAILED",
                origin: "Moderation.updateModerationEntry",
                data: { moderationId: sanitizedModerationId, retryCount }
              });
              throw new Error(`Update failed due to concurrent modification. Please retry.`);
            }
            // Wait briefly before retrying
            await new Promise(resolve => setTimeout(resolve, 50 * retryCount));
            continue;
          }
          // Re-throw other errors
          throw error;
        }
      }

      await Logger.writeLog({
        flag: "MODERATIONS",
        action: "moderationUpdated",
        data: {
          moderationId: sanitizedModerationId,
          updatedFields: Object.keys(validUpdates),
        }
      });
      Logger.debugLog?.(`[Moderation] [updateModerationEntry] [SUCCESS] Moderation entry updated for ID: ${sanitizedModerationId}`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to update moderation entry: ${error.message}`, {
        code: "MODERATION_ENTRY_UPDATE_FAILED",
        origin: "Moderation.updateModerationEntry",
        data: { moderationId, updates },
      });
      throw new Error(`Failed to update moderation entry: ${error.message}`);
    }
  }

  static async addNote(moderationId, userId, note, addedBy) {
    Logger.debugLog?.(`[Moderation] [addNote] [START] Adding note to moderation ID: ${moderationId}, userId: ${userId}, addedBy: ${addedBy}`);
    try {
      // Sanitize and validate inputs
      const sanitizedModerationId = SafeUtils.sanitizeString(moderationId);
      if (!sanitizedModerationId) {
        ErrorHandler.addError("moderationId is required", {
          code: "MODERATION_ID_REQUIRED",
          origin: "Moderation.addNote",
          data: { moderationId }
        });
        throw new Error("moderationId is required");
      }
      // Validate UUID format
      this._validateModerationIdFormat(sanitizedModerationId);
      
      const sanitizedUserId = SafeUtils.sanitizeString(userId);
      if (!sanitizedUserId) {
        ErrorHandler.addError("userId is required", {
          code: "USER_ID_REQUIRED",
          origin: "Moderation.addNote",
          data: { moderationId: sanitizedModerationId, userId }
        });
        throw new Error("userId is required");
      }
      const sanitizedAddedBy = SafeUtils.sanitizeString(addedBy);

      if (!sanitizedAddedBy) {
        ErrorHandler.addError("addedBy is required", {
          code: "ADDED_BY_REQUIRED",
          origin: "Moderation.addNote",
          data: { moderationId, userId, addedBy }
        });
        throw new Error("addedBy is required");
      }

      if (!note) {
        ErrorHandler.addError("Note text is required", {
          code: "NOTE_TEXT_REQUIRED",
          origin: "Moderation.addNote",
          data: { moderationId, userId, note }
        });
        throw new Error("Note text is required");
      }

      // Sanitize note text
      const sanitizedNote = SafeUtils.sanitizeTextField(note);
      if (!sanitizedNote) {
        ErrorHandler.addError("Note text is required after sanitization", {
          code: "NOTE_TEXT_REQUIRED_AFTER_SANITIZATION",
          origin: "Moderation.addNote",
          data: { moderationId, userId, note }
        });
        throw new Error("Note text is required after sanitization");
      }

      // Validate note length
      this._validateFieldLength("note", sanitizedNote, this.MAX_NOTE_LENGTH);

      // Find the moderation item using GSI, then use direct getItem for consistent read
      // This avoids GSI eventual consistency issues by using getItem after GSI lookup
      const query = await this._retryOperation(() =>
        Scylla.request("Query", {
          TableName: this.TABLE,
          IndexName: this.GSI_BY_MOD_ID,
          KeyConditionExpression: "#mid = :mid AND #uid = :uid",
          ExpressionAttributeNames: {
            "#mid": "moderationId",
            "#uid": "userId"
          },
          ExpressionAttributeValues: Scylla.marshalItem({
            ":mid": sanitizedModerationId,
            ":uid": sanitizedUserId,
          }),
          Limit: 1,
        })
      );

      const found = (query.Items ?? []).map(Scylla.unmarshalItem)[0];
      if (!found) {
        ErrorHandler.addError(`Moderation item not found: moderationId=${sanitizedModerationId}, userId=${sanitizedUserId}`, {
          code: "MODERATION_ITEM_NOT_FOUND_ADD_NOTE",
          origin: "Moderation.addNote",
          data: { moderationId: sanitizedModerationId, userId: sanitizedUserId }
        });
        throw new Error(
          `Moderation item not found: moderationId=${sanitizedModerationId}, userId=${sanitizedUserId}`
        );
      }
      
      // Use direct getItem with PK/SK for consistent read (avoids GSI eventual consistency)
      const getItemResult = await this._retryOperation(() =>
        Scylla.getItem(this.TABLE, {
          [this.PK]: found[this.PK],
          [this.SK]: found[this.SK],
        })
      );
      const rawItem = getItemResult != null && Object.prototype.hasOwnProperty.call(getItemResult, "Item")
        ? getItemResult.Item
        : getItemResult;
      // Decompress content if it was compressed
      const decompressedItem = await this._decompressItemsContent(rawItem);

      const timestamp = this._getCurrentTimestamp();
      const newNote = {
        text: sanitizedNote,
        addedBy: sanitizedAddedBy,
        addedAt: timestamp,
        isPublic: false, // Default to private for notes added via addNote endpoint
      };

      // Get existing notes or initialize empty array
      const existingNotes = Array.isArray(decompressedItem.notes) ? decompressedItem.notes : [];

      // Validate notes array length to prevent unbounded growth and DynamoDB item size limits
      if (existingNotes.length >= this.MAX_NOTES_PER_ITEM) {
        ErrorHandler.addError(`Maximum notes limit (${this.MAX_NOTES_PER_ITEM}) reached for moderation item`, {
          code: "MAX_NOTES_LIMIT_EXCEEDED",
          origin: "Moderation.addNote",
          data: { 
            moderationId: sanitizedModerationId, 
            userId: sanitizedUserId,
            currentNotesCount: existingNotes.length,
            maxNotes: this.MAX_NOTES_PER_ITEM
          }
        });
        throw new Error(`Maximum notes limit (${this.MAX_NOTES_PER_ITEM}) reached. Consider archiving old notes before adding new ones.`);
      }

      // Optional: De-duplication check
      const isDuplicate = existingNotes.some(
        (n) => n.text === sanitizedNote && n.addedBy === sanitizedAddedBy
      );

      if (isDuplicate) {
        Logger.debugLog?.(`[Moderation] [addNote] [INFO] Duplicate note detected for moderation ID: ${sanitizedModerationId}`);
        // Return existing record without performing write to prevent data bloat
        return decompressedItem;
      }

      const notes = [...existingNotes, newNote];

      // Update meta field
      const updatedMeta = this._updateMetaField(
        decompressedItem.meta || this._createMetaField("update", sanitizedUserId),
        "addNote",
        sanitizedAddedBy,
        { noteLength: sanitizedNote.length }
      );

      const result = await this._retryOperation(() =>
        Scylla.updateItem(
          this.TABLE,
          { [this.PK]: decompressedItem[this.PK], [this.SK]: decompressedItem[this.SK] },
          { notes, meta: updatedMeta }
        )
      );

      await Logger.writeLog({
        flag: "MODERATIONS",
        action: "noteAdded",
        data: {
          moderationId: sanitizedModerationId,
          userId: sanitizedUserId,
          noteCount: notes.length,
        }
      });
      Logger.debugLog?.(`[Moderation] [addNote] [SUCCESS] Note added to moderation ID: ${sanitizedModerationId}`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to add note: ${error.message}`, {
        code: "ADD_NOTE_FAILED",
        origin: "Moderation.addNote",
        data: { moderationId, userId },
      });
      throw new Error(`Failed to add note: ${error.message}`);
    }
  }

  static async applyModerationAction(
    moderationId,
    userId,
    action,
    reason = "",
    moderatorId = "",
    moderationType = "standard",
    note = null,
    publicNote = null
  ) {
    Logger.debugLog?.(`[Moderation] [applyModerationAction] [START] Applying action: ${action} to moderation ID: ${moderationId}, userId: ${userId}`);
    try {
      // Sanitize and validate inputs
      const sanitizedModerationId = SafeUtils.sanitizeString(moderationId);
      if (!sanitizedModerationId) {
        ErrorHandler.addError("moderationId is required", {
          code: "MODERATION_ID_REQUIRED",
          origin: "Moderation.applyModerationAction",
          data: { moderationId }
        });
        throw new Error("moderationId is required");
      }
      // Validate UUID format
      this._validateModerationIdFormat(sanitizedModerationId);
      
      const sanitizedUserId = SafeUtils.sanitizeString(userId);
      if (!sanitizedUserId) {
        ErrorHandler.addError("userId is required", {
          code: "USER_ID_REQUIRED",
          origin: "Moderation.applyModerationAction",
          data: { moderationId: sanitizedModerationId, userId }
        });
        throw new Error("userId is required");
      }
      const sanitizedAction = SafeUtils.sanitizeString(action);
      const sanitizedReason = SafeUtils.sanitizeTextField(reason || "") || "";
      
      // Validate reason field length to prevent unbounded growth
      if (sanitizedReason) {
        this._validateFieldLength("reason", sanitizedReason, this.MAX_NOTE_LENGTH);
      }
      const sanitizedModeratorId =
        SafeUtils.sanitizeString(moderatorId || "") || "";
      const sanitizedModerationType =
        SafeUtils.sanitizeString(moderationType) || this.MODERATION_TYPE.STANDARD;
      
      // Validate moderation type enum
      if (!Object.values(this.MODERATION_TYPE).includes(sanitizedModerationType)) {
        ErrorHandler.addError(`Invalid moderationType: ${sanitizedModerationType}. Must be one of: ${Object.values(this.MODERATION_TYPE).join(", ")}`, {
          code: "INVALID_MODERATION_TYPE",
          origin: "Moderation.applyModerationAction",
          data: { moderationType: sanitizedModerationType }
        });
        throw new Error(`Invalid moderationType: ${sanitizedModerationType}. Must be one of: ${Object.values(this.MODERATION_TYPE).join(", ")}`);
      }

      // Validate action enum
      if (!this.ACTION_SET.has(sanitizedAction)) {
        ErrorHandler.addError(`Invalid action: ${sanitizedAction}. Must be one of: ${Object.values(this.ACTION).join(", ")}`, {
          code: "INVALID_ACTION",
          origin: "Moderation.applyModerationAction",
          data: { moderationId, userId, action: sanitizedAction }
        });
        throw new Error(
          `Invalid action: ${sanitizedAction}. Must be one of: ${Object.values(
            this.ACTION
          ).join(", ")}`
        );
      }

      // Optimistic locking: retry read-modify-write until version check succeeds
      let result;
      let retryCount = 0;
      const maxOptimisticRetries = 5;
      let newStatus;

      while (retryCount < maxOptimisticRetries) {
      // Find record with retry
      const query = await this._retryOperation(() =>
        Scylla.request("Query", {
          TableName: this.TABLE,
          IndexName: this.GSI_BY_MOD_ID,
            KeyConditionExpression: "#mid = :mid AND #uid = :uid",
            ExpressionAttributeNames: {
              "#mid": "moderationId",
              "#uid": "userId"
            },
          ExpressionAttributeValues: Scylla.marshalItem({
            ":mid": sanitizedModerationId,
            ":uid": sanitizedUserId,
          }),
          Limit: 1,
        })
      );

      const item = (query.Items ?? []).map(Scylla.unmarshalItem)[0];
      if (!item) {
        ErrorHandler.addError(`Moderation item not found: moderationId=${sanitizedModerationId}, userId=${sanitizedUserId}`, {
          code: "MODERATION_ITEM_NOT_FOUND_APPLY_ACTION",
          origin: "Moderation.applyModerationAction",
          data: { moderationId: sanitizedModerationId, userId: sanitizedUserId }
        });
        throw new Error(
          `Moderation item not found: moderationId=${sanitizedModerationId}, userId=${sanitizedUserId}`
        );
      }

        // Reject applying approve when item is already rejected (action/status inconsistency)
        if (sanitizedAction === this.ACTION.APPROVE && item.status === this.STATUS.REJECTED) {
          ErrorHandler.addError(`Action and status inconsistency: cannot approve item with status=${item.status}`, {
            code: "ACTION_STATUS_INCONSISTENCY",
            origin: "Moderation.applyModerationAction",
            data: { action: sanitizedAction, currentStatus: item.status }
          });
          throw new Error(`Action and status inconsistency: cannot approve item with status=${item.status}`);
        }

        // Capture current version for optimistic locking
        const existingMeta = item.meta || this._createMetaField("update", sanitizedUserId);
        const currentVersion = existingMeta.version || 0;

      const now = this._getCurrentTimestamp();
      newStatus =
        sanitizedAction === this.ACTION.APPROVE
          ? (sanitizedModerationType === this.MODERATION_TYPE.GLOBAL
            ? this.STATUS.APPROVED_GLOBAL
            : this.STATUS.APPROVED)
          : sanitizedAction === this.ACTION.PENDING_RESUBMISSION
            ? this.STATUS.PENDING
            : this.STATUS.REJECTED;

      // Update meta field with action history
      const updatedMeta = this._updateMetaField(
          existingMeta,
        "applyAction",
        sanitizedModeratorId || sanitizedUserId,
        {
          action: sanitizedAction,
          previousStatus: item.status,
          newStatus,
          moderationType: sanitizedModerationType,
        }
      );

      // Handle notes (private and public)
      const existingNotes = Array.isArray(item.notes) ? item.notes : [];
      if (existingNotes.length >= this.MAX_NOTES_PER_ITEM) {
        ErrorHandler.addError(`Maximum notes limit (${this.MAX_NOTES_PER_ITEM}) reached for moderation item; cannot add more`, {
          code: "MAX_NOTES_LIMIT_EXCEEDED",
          origin: "Moderation.applyModerationAction",
          data: { moderationId: sanitizedModerationId, userId: sanitizedUserId, currentNotesCount: existingNotes.length, maxNotes: this.MAX_NOTES_PER_ITEM }
        });
        throw new Error(`Maximum notes limit (${this.MAX_NOTES_PER_ITEM}) reached. Consider archiving old notes before applying action.`);
      }
      const newNotes = [];

      // Add private note if provided
      if (note && SafeUtils.sanitizeTextField(note)) {
        const sanitizedNote = SafeUtils.sanitizeTextField(note);
        // Validate note length before adding
        this._validateFieldLength("note", sanitizedNote, this.MAX_NOTE_LENGTH);
        newNotes.push({
          text: sanitizedNote,
          addedBy: sanitizedModeratorId || sanitizedUserId,
          addedAt: now,
          isPublic: false,
        });
      }

      // Add public note if provided
      if (publicNote && SafeUtils.sanitizeTextField(publicNote)) {
        const sanitizedPublicNote = SafeUtils.sanitizeTextField(publicNote);
        // Validate note length before adding
        this._validateFieldLength("publicNote", sanitizedPublicNote, this.MAX_NOTE_LENGTH);
        newNotes.push({
          text: sanitizedPublicNote,
          addedBy: sanitizedModeratorId || sanitizedUserId,
          addedAt: now,
          isPublic: true,
        });
      }

      // Validate notes array length to prevent unbounded growth and DynamoDB item size limits
      const totalNotesAfterAdd = existingNotes.length + newNotes.length;
      if (totalNotesAfterAdd > this.MAX_NOTES_PER_ITEM) {
        ErrorHandler.addError(`Adding ${newNotes.length} note(s) would exceed maximum notes limit (${this.MAX_NOTES_PER_ITEM}) for moderation item`, {
          code: "MAX_NOTES_LIMIT_EXCEEDED",
          origin: "Moderation.applyModerationAction",
          data: { 
            moderationId: sanitizedModerationId, 
            userId: sanitizedUserId,
            currentNotesCount: existingNotes.length,
            newNotesCount: newNotes.length,
            totalAfterAdd: totalNotesAfterAdd,
            maxNotes: this.MAX_NOTES_PER_ITEM
          }
        });
        throw new Error(`Adding note(s) would exceed maximum notes limit (${this.MAX_NOTES_PER_ITEM}). Current: ${existingNotes.length}, Adding: ${newNotes.length}, Max: ${this.MAX_NOTES_PER_ITEM}. Consider archiving old notes before adding new ones.`);
      }

      // Combine existing notes with new notes
      const allNotes =
        newNotes.length > 0 ? [...existingNotes, ...newNotes] : existingNotes;

      const update = {
        status: newStatus,
        action: sanitizedAction,
        reason: sanitizedReason,
        moderatedBy: sanitizedModeratorId || null,
        actionedAt: now,
        statusSubmittedAt: this.statusSubmittedAtKey(
          newStatus,
          item.submittedAt
        ),
        meta: updatedMeta,
      };

      // Only include notes in update if there are notes to save
      if (allNotes.length > 0) {
        update.notes = allNotes;
      }

      // Special handling for tags type
      if (item.type === this.TYPE.TAGS) {
        // Validate and set tagStatus only for TAGS type items
        const tagStatus = [
          this.STATUS.APPROVED,
          this.STATUS.APPROVED_GLOBAL,
        ].includes(newStatus)
          ? this.TAG_STATUS.PUBLISHED
          : this.TAG_STATUS.PENDING;
        update.tagStatus = tagStatus;
      } else {
        // Ensure tagStatus is not set for non-TAGS items
        if (item.tagStatus !== undefined) {
          update.tagStatus = null;
        }
      }

      // All validation and update preparation is complete before the atomic update
      // DynamoDB UpdateItem is atomic - all attributes in the update are updated atomically
      // Either all fields are updated successfully or the operation fails and no fields are updated
      // This ensures transactional guarantees for single-item updates
      
        // Perform update with optimistic locking condition (no _retryOperation so ConditionalCheckFailedException is not retried; only one concurrent apply can succeed)
        try {
          result = await Scylla.updateItem(
            this.TABLE,
            { [this.PK]: item[this.PK], [this.SK]: item[this.SK] },
            update,
            {
              ConditionExpression: "#meta.#version = :expectedVersion",
              ExpressionAttributeNames: {
                "#meta": "meta",
                "#version": "version"
              },
              ExpressionAttributeValues: Scylla.marshalItem({
                ":expectedVersion": currentVersion
              })
            }
          );
          // Success - break out of retry loop
          break;
        } catch (error) {
          // Conditional check failure: another writer won; do not retry so only one concurrent apply succeeds
          if (error.code === "ConditionalCheckFailedException" || (error.awsType && error.awsType.includes("ConditionalCheckFailedException"))) {
            ErrorHandler.addError(`Concurrent modification: another moderator applied an action first`, {
              code: "OPTIMISTIC_LOCK_FAILED",
              origin: "Moderation.applyModerationAction",
              data: { moderationId: sanitizedModerationId }
            });
            throw new Error(`Action application failed due to concurrent modification. Please retry.`);
          }
          // Re-throw other errors
          throw error;
        }
      }

      await Logger.writeLog({
        flag: "MODERATIONS",
        action: "actionApplied",
        data: {
          moderationId: sanitizedModerationId,
          userId: sanitizedUserId,
          action: sanitizedAction,
          newStatus,
        }
      });
      Logger.debugLog?.(`[Moderation] [applyModerationAction] [SUCCESS] Action applied to moderation ID: ${sanitizedModerationId}`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to apply moderation action: ${error.message}`, {
        code: "APPLY_MODERATION_ACTION_FAILED",
        origin: "Moderation.applyModerationAction",
        data: { moderationId, userId, action },
      });
      throw new Error(`Failed to apply moderation action: ${error.message}`);
    }
  }

  static async escalateModerationItem(moderationId, userId, escalatedBy) {
    Logger.debugLog?.(`[Moderation] [escalateModerationItem] [START] Escalating moderation ID: ${moderationId}, userId: ${userId}, escalatedBy: ${escalatedBy}`);
    try {
      // Sanitize and validate inputs
      const sanitizedModerationId = SafeUtils.sanitizeString(moderationId);
      if (!sanitizedModerationId) {
        ErrorHandler.addError("moderationId is required", {
          code: "MODERATION_ID_REQUIRED",
          origin: "Moderation.escalateModerationItem",
          data: { moderationId }
        });
        throw new Error("moderationId is required");
      }
      // Validate UUID format
      this._validateModerationIdFormat(sanitizedModerationId);
      
      const sanitizedUserId = SafeUtils.sanitizeString(userId);
      if (!sanitizedUserId) {
        ErrorHandler.addError("userId is required", {
          code: "USER_ID_REQUIRED",
          origin: "Moderation.escalateModerationItem",
          data: { moderationId: sanitizedModerationId, userId }
        });
        throw new Error("userId is required");
      }
      const sanitizedEscalatedBy = SafeUtils.sanitizeString(escalatedBy);

      if (!sanitizedEscalatedBy) {
        ErrorHandler.addError("escalatedBy is required", {
          code: "ESCALATED_BY_REQUIRED",
          origin: "Moderation.escalateModerationItem",
          data: { moderationId, userId, escalatedBy }
        });
        throw new Error("escalatedBy is required");
      }

      // Optimistic locking: retry read-modify-write until version check succeeds
      let result;
      let retryCount = 0;
      const maxOptimisticRetries = 5;

      while (retryCount < maxOptimisticRetries) {
      // Find record with retry
      const query = await this._retryOperation(() =>
        Scylla.request("Query", {
          TableName: this.TABLE,
          IndexName: this.GSI_BY_MOD_ID,
            KeyConditionExpression: "#mid = :mid AND #uid = :uid",
            ExpressionAttributeNames: {
              "#mid": "moderationId",
              "#uid": "userId"
            },
          ExpressionAttributeValues: Scylla.marshalItem({
            ":mid": sanitizedModerationId,
            ":uid": sanitizedUserId,
          }),
          Limit: 1,
        })
      );

      const item = (query.Items ?? []).map(Scylla.unmarshalItem)[0];
      if (!item) {
        ErrorHandler.addError(`Moderation item not found: moderationId=${sanitizedModerationId}, userId=${sanitizedUserId}`, {
          code: "MODERATION_ITEM_NOT_FOUND_ESCALATE",
          origin: "Moderation.escalateModerationItem",
          data: { moderationId: sanitizedModerationId, userId: sanitizedUserId }
        });
        throw new Error(
          `Moderation item not found: moderationId=${sanitizedModerationId}, userId=${sanitizedUserId}`
        );
      }

        // Capture current version for optimistic locking
        const existingMeta = item.meta || this._createMetaField("update", sanitizedUserId);
        const currentVersion = existingMeta.version || 0;

      const now = this._getCurrentTimestamp();

      // Track escalation history in meta field (append, don't overwrite)
      const updatedMeta = this._updateMetaField(
          existingMeta,
        "escalate",
        sanitizedEscalatedBy,
        {
          previousStatus: item.status,
          previousEscalatedBy: item.escalatedBy,
        }
      );

      // All validation and update preparation is complete before the atomic update
      // DynamoDB UpdateItem is atomic - all attributes in the update are updated atomically
      // Either all fields are updated successfully or the operation fails and no fields are updated
      // This ensures transactional guarantees for single-item updates

        // Perform update with optimistic locking condition
        try {
          result = await this._retryOperation(() =>
        Scylla.updateItem(
          this.TABLE,
          { [this.PK]: item[this.PK], [this.SK]: item[this.SK] },
          {
            status: this.STATUS.ESCALATED,
            escalatedBy: sanitizedEscalatedBy,
            actionedAt: now,
            statusSubmittedAt: this.statusSubmittedAtKey(
              this.STATUS.ESCALATED,
              item.submittedAt
            ),
            meta: updatedMeta,
              },
              {
                ConditionExpression: "#meta.#version = :expectedVersion",
                ExpressionAttributeNames: {
                  "#meta": "meta",
                  "#version": "version"
                },
                ExpressionAttributeValues: Scylla.marshalItem({
                  ":expectedVersion": currentVersion
                })
              }
            )
          );
          // Success - break out of retry loop
          break;
        } catch (error) {
          // Check if it's a conditional check failure (version mismatch)
          if (error.awsType && error.awsType.includes("ConditionalCheckFailedException")) {
            retryCount++;
            if (retryCount >= maxOptimisticRetries) {
              ErrorHandler.addError(`Optimistic locking failed after ${maxOptimisticRetries} retries: ${error.message}`, {
                code: "OPTIMISTIC_LOCK_FAILED",
                origin: "Moderation.escalateModerationItem",
                data: { moderationId: sanitizedModerationId, retryCount }
              });
              throw new Error(`Escalation failed due to concurrent modification. Please retry.`);
            }
            // Wait briefly before retrying
            await new Promise(resolve => setTimeout(resolve, 50 * retryCount));
            continue;
          }
          // Re-throw other errors
          throw error;
        }
      }

      await Logger.writeLog({
        flag: "MODERATIONS",
        action: "itemEscalated",
        data: {
          moderationId: sanitizedModerationId,
          userId: sanitizedUserId,
          escalatedBy: sanitizedEscalatedBy,
        }
      });
      Logger.debugLog?.(`[Moderation] [escalateModerationItem] [SUCCESS] Moderation item escalated: ${sanitizedModerationId}`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to escalate moderation item: ${error.message}`, {
        code: "ESCALATE_MODERATION_ITEM_FAILED",
        origin: "Moderation.escalateModerationItem",
        data: { moderationId, userId },
      });
      throw new Error(`Failed to escalate moderation item: ${error.message}`);
    }
  }

  /**
   * ============================================================
   *   Queries via GSIs
   * ============================================================
   */
// ============================================================
  /**
   * Unified method to get moderation items with various filters.
   * Acts as an AND condition for all provided filters.
   *
   * @param {Object} filters - Filter criteria
   * @param {string} [filters.userId] - Filter by user ID
   * @param {string} [filters.status] - Filter by status (or 'all')
   * @param {string} [filters.priority] - Filter by priority
   * @param {string} [filters.type] - Filter by type
   * @param {string} [filters.dayKey] - Filter by day key (YYYYMMDD)
   * @param {Object} options - Query options
   * @param {number} [options.limit=20] - Max items to return
   * @param {string} [options.nextToken] - Pagination token
   * @param {number} [options.start] - Start timestamp
   * @param {number} [options.end] - End timestamp
   * @param {boolean} [options.asc=false] - Sort ascending
   */
  static async getModerationItems(
    { userId, status, priority, type, dayKey, moderatedBy, contentId, escalatedBy } = {},
    { limit = 20, nextToken = null, start = null, end = null, asc = false } = {}
  ) {
    Logger.debugLog?.(`[Moderation] [getModerationItems] [START] Getting moderation items with filters: userId=${userId}, status=${status}, priority=${priority}, type=${type}, dayKey=${dayKey}, moderatedBy=${moderatedBy}, contentId=${contentId}, escalatedBy=${escalatedBy}`);
    try {
      // 1. Sanitize Inputs
      const sUserId = SafeUtils.sanitizeString(userId);
      const sStatus = SafeUtils.sanitizeString(status);
      const sPriority = SafeUtils.sanitizeString(priority);
      const sType = SafeUtils.sanitizeString(type);
      const sDayKey = SafeUtils.sanitizeString(dayKey);
      const sModeratedBy = SafeUtils.sanitizeString(moderatedBy);
      const sContentId = SafeUtils.sanitizeString(contentId);
      const sEscalatedBy = SafeUtils.sanitizeString(escalatedBy);

      let sLimit = SafeUtils.sanitizeInteger(limit) || 20;
      // Enforce maximum query result size to prevent memory exhaustion
      if (sLimit > this.MAX_QUERY_RESULT_SIZE) {
        ErrorHandler.addError(`Query limit exceeds maximum allowed size (${this.MAX_QUERY_RESULT_SIZE})`, {
          code: "QUERY_RESULT_SIZE_EXCEEDED",
          origin: "Moderation.getModerationItems",
          data: { requestedLimit: sLimit, maxLimit: this.MAX_QUERY_RESULT_SIZE }
        });
        throw new Error(`Query limit cannot exceed ${this.MAX_QUERY_RESULT_SIZE}. Requested: ${sLimit}. Use pagination for larger result sets.`);
      }
      const sStart = start !== null ? SafeUtils.sanitizeInteger(start) : null;
      const sEnd = end !== null ? SafeUtils.sanitizeInteger(end) : null;

      // Validate timestamp range (no negative or invalid)
      if (sStart !== null && (sStart < 0 || !Number.isFinite(sStart))) {
        ErrorHandler.addError("Invalid start timestamp", {
          code: "INVALID_TIMESTAMP",
          origin: "Moderation.getModerationItems",
          data: { start: sStart }
        });
        throw new Error("Invalid start timestamp");
      }
      if (sEnd !== null && (sEnd < 0 || !Number.isFinite(sEnd))) {
        ErrorHandler.addError("Invalid end timestamp", {
          code: "INVALID_TIMESTAMP",
          origin: "Moderation.getModerationItems",
          data: { end: sEnd }
        });
        throw new Error("Invalid end timestamp");
      }
      if (sStart !== null && sEnd !== null && sStart > sEnd) {
        ErrorHandler.addError("Start timestamp must be less than or equal to end timestamp", {
          code: "INVALID_TIMESTAMP_RANGE",
          origin: "Moderation.getModerationItems",
          data: { start: sStart, end: sEnd }
        });
        throw new Error("Start timestamp must be less than or equal to end timestamp");
      }

      // Validate Enums if provided
      if (sStatus && !this.STATUS_SET.has(sStatus)) {
        ErrorHandler.addError(`Invalid status: ${sStatus}`, {
          code: "INVALID_STATUS",
          origin: "Moderation.getModerationItems",
          data: { userId, status: sStatus, priority, type, dayKey }
        });
        throw new Error(`Invalid status: ${sStatus}`);
      }
      if (sPriority && !this.PRIORITY_SET.has(sPriority)) {
        ErrorHandler.addError(`Invalid priority: ${sPriority}`, {
          code: "INVALID_PRIORITY",
          origin: "Moderation.getModerationItems",
          data: { userId, status, priority: sPriority, type, dayKey }
        });
        throw new Error(`Invalid priority: ${sPriority}`);
      }
      if (sType && !this.TYPE_SET.has(sType)) {
        ErrorHandler.addError(`Invalid type: ${sType}`, {
          code: "INVALID_TYPE",
          origin: "Moderation.getModerationItems",
          data: { userId, status, priority, type: sType, dayKey }
        });
        throw new Error(`Invalid type: ${sType}`);
      }
      if (sDayKey && !/^\d{8}$/.test(sDayKey)) {
        ErrorHandler.addError(`Invalid dayKey format: ${sDayKey}. Expected YYYYMMDD`, {
          code: "INVALID_DAY_KEY_FORMAT",
          origin: "Moderation.getModerationItems",
          data: { userId, status, priority, type, dayKey: sDayKey }
        });
        throw new Error(
          `Invalid dayKey format: ${sDayKey}. Expected YYYYMMDD`
        );
      }
      
      // Validate dayKey represents a valid calendar date
      if (sDayKey) {
        const year = parseInt(sDayKey.substring(0, 4), 10);
        const month = parseInt(sDayKey.substring(4, 6), 10);
        const day = parseInt(sDayKey.substring(6, 8), 10);
        const date = new Date(year, month - 1, day);
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
          ErrorHandler.addError(`Invalid dayKey: ${sDayKey} does not represent a valid calendar date`, {
            code: "INVALID_DAY_KEY_DATE",
            origin: "Moderation.getModerationItems",
            data: { dayKey: sDayKey, year, month, day }
          });
          throw new Error(`Invalid dayKey: ${sDayKey} does not represent a valid calendar date (e.g., 20241399 is invalid)`);
        }
      }

      // 2. Prepare Query Components
      let indexName = null;
      let keyCondition = [];
      let filterExpression = [];
      let attributeNames = {};
      let attributeValues = {};

      // Helper to add filter
      // All filter expressions use ExpressionAttributeNames (#alias) and ExpressionAttributeValues (:value)
      // Validation happens when joining filter expressions via _validateAndJoinFilterExpressions
      const addFilter = (field, value, nameMap = null) => {
        const key = `:${field}`;
        // Always use ExpressionAttributeNames for field references to prevent injection
          const alias = `#${field}`;
          filterExpression.push(`${alias} = ${key}`);
        // Use provided nameMap if available, otherwise use field name
        attributeNames[alias] = nameMap || field;
        attributeValues[key] = value;
      };

      // Helper to add timestamp range to Key or Filter
      const addTimeRange = (isKey = false, keyPrefix = "") => {
        const target = isKey ? keyCondition : filterExpression;
        let field;
        if (isKey) {
          if (keyPrefix) {
            // Use provided prefix (should already be an alias)
            field = keyPrefix;
          } else {
            // Use ExpressionAttributeName for submittedAt
            field = "#sa";
          attributeNames["#sa"] = "submittedAt";
          }
        } else {
          // Filter expression - use alias
          field = "#sa";
          if (sStart !== null || sEnd !== null) {
            attributeNames["#sa"] = "submittedAt";
          }
        }

        if (sStart !== null && sEnd !== null) {
          target.push(`${field} BETWEEN :start AND :end`);
          attributeValues[":start"] = sStart;
          attributeValues[":end"] = sEnd;
        } else if (sStart !== null) {
          target.push(`${field} >= :start`);
          attributeValues[":start"] = sStart;
        } else if (sEnd !== null) {
          target.push(`${field} <= :end`);
          attributeValues[":end"] = sEnd;
        }
      };

      // 3. Select Strategy (Index Selection)

      // Strategy A: User ID (Highest Priority)
      if (sUserId) {
        indexName = this.GSI_USER_STATUS_DATE;
        keyCondition.push("#uid = :uid");
        attributeNames["#uid"] = "userId";
        attributeValues[":uid"] = sUserId;

        if (sStatus) {
          // Optimized: Use composite key status#timestamp
          const startTs = sStart ?? 0;
          const endTs = sEnd ?? this.DEFAULT_TIMESTAMP_MAX;
          const startKey = this.statusSubmittedAtKey(sStatus, startTs);
          const endKey = this.statusSubmittedAtKey(sStatus, endTs);

          keyCondition.push("#ssa BETWEEN :rkStart AND :rkEnd");
          attributeNames["#ssa"] = "statusSubmittedAt";
          attributeValues[":rkStart"] = startKey;
          attributeValues[":rkEnd"] = endKey;
        } else {
          // Status is missing, filter by time if needed
          addTimeRange(false); // Filter, not key (since SK is statusSubmittedAt)
        }
      }
      // Strategy B: Day Key
      else if (sDayKey) {
        indexName = this.GSI_ALL_BY_DATE;
        keyCondition.push("#dk = :day");
        attributeNames["#dk"] = "dayKey";
        attributeValues[":day"] = sDayKey;
        addTimeRange(true); // submittedAt is SK
      }
      // Strategy C: Status (Specific)
      else if (sStatus) {
        indexName = this.GSI_STATUS_DATE;
        keyCondition.push("#s = :status");
        attributeNames["#s"] = "status";
        attributeValues[":status"] = sStatus;
        addTimeRange(true); // submittedAt is SK
      }
      // Strategy D: Priority
      else if (sPriority) {
        indexName = this.GSI_PRIORITY;
        keyCondition.push("#p = :p");
        attributeNames["#p"] = "priority";
        attributeValues[":p"] = sPriority;
        addTimeRange(true); // submittedAt is SK
      }
      // Strategy E: Type
      else if (sType) {
        indexName = this.GSI_TYPE_DATE;
        keyCondition.push("#t = :type");
        attributeNames["#t"] = "type";
        attributeValues[":type"] = sType;
        addTimeRange(true); // submittedAt is SK
      }
      // Strategy E2: ModeratedBy
      else if (sModeratedBy) {
        indexName = this.GSI_MODERATED_BY;
        keyCondition.push("#mb = :mb");
        attributeNames["#mb"] = "moderatedBy";
        attributeValues[":mb"] = sModeratedBy;
        addTimeRange(true);
      }
      // Strategy E3: ContentId
      else if (sContentId) {
        indexName = this.GSI_CONTENT_ID;
        keyCondition.push("#cid = :cid");
        attributeNames["#cid"] = "contentId";
        attributeValues[":cid"] = sContentId;
        addTimeRange(true);
      }
      // Strategy E4: EscalatedBy
      else if (sEscalatedBy) {
        indexName = this.GSI_ESCALATED;
        keyCondition.push("#eb = :eb");
        attributeNames["#eb"] = "escalatedBy";
        attributeValues[":eb"] = sEscalatedBy;
        addTimeRange(true);
      }
      // Strategy F: Scan (Fallback)
      else {
        // No index selected, use Scan
        addTimeRange(false);
      }

      // 4. Apply Remaining Filters (The "AND" logic)
      // If we didn't use the field in the KeyCondition, add it to FilterExpression

      // userId (only if not used as PK)
      if (sUserId && !keyCondition.some((k) => k.includes("userId"))) {
        addFilter("userId", sUserId);
      }

      // status (only if not used in KeyCondition)
      // Note: Strategy A handles status specially. Strategy C uses it as PK.
      if (sStatus) {
        const usedInKey =
          indexName === this.GSI_STATUS_DATE ||
          (indexName === this.GSI_USER_STATUS_DATE &&
            keyCondition.some((k) => k.includes("statusSubmittedAt")));
        if (!usedInKey) {
          addFilter("status", sStatus, "status");
        }
      }

      // priority
      if (sPriority && indexName !== this.GSI_PRIORITY) {
        addFilter("priority", sPriority);
      }

      // type
      if (sType && indexName !== this.GSI_TYPE_DATE) {
        addFilter("type", sType, "type");
      }

      // dayKey
      if (sDayKey && indexName !== this.GSI_ALL_BY_DATE) {
        addFilter("dayKey", sDayKey);
      }
      
      // Always filter out soft-deleted items unless explicitly requested
      filterExpression.push("attribute_not_exists(#del) OR #del = :delFalse");
      attributeNames["#del"] = "isDeleted";
      attributeValues[":delFalse"] = false;

      // 5. Construct Request
      const requestParams = {
        TableName: this.TABLE,
        Limit: sLimit,
        ...(nextToken && {
          ExclusiveStartKey: this._decodeNextToken(nextToken),
        }),
      };

      if (indexName) {
        // Query operation - ScanIndexForward is valid
        requestParams.IndexName = indexName;
        requestParams.KeyConditionExpression = this._validateAndJoinFilterExpressions(keyCondition);
        requestParams.ScanIndexForward = !!asc;
      } else {
        // Scan operation - ScanIndexForward is NOT valid, omit it
        // Sorting will be done in-memory after retrieval if needed
      }

      if (filterExpression.length > 0) {
        requestParams.FilterExpression = this._validateAndJoinFilterExpressions(filterExpression);
      }

      if (Object.keys(attributeNames).length > 0) {
        requestParams.ExpressionAttributeNames = attributeNames;
      }

      if (Object.keys(attributeValues).length > 0) {
        requestParams.ExpressionAttributeValues =
          Scylla.marshalItem(attributeValues);
      }

      // 6. Execute
      const method = indexName ? "Query" : "Scan";
      const result = await this._retryOperation(() =>
        Scylla.request(method, requestParams)
      );

      const items = (result.Items ?? []).map(Scylla.unmarshalItem);

      // Sort for Scan (since Scan doesn't guarantee order)
      if (
        method === "Scan" &&
        (sStart !== null || sEnd !== null || asc !== undefined)
      ) {
        items.sort((a, b) =>
          Boolean(asc)
            ? a.submittedAt - b.submittedAt
            : b.submittedAt - a.submittedAt
        );
      }

      const lastKey = result.LastEvaluatedKey ?? null;

      // Decompress content in all items
      const decompressedItems = await this._decompressItemsContent(items);

      Logger.debugLog?.(`[Moderation] [getModerationItems] [SUCCESS] Retrieved ${decompressedItems.length} moderation items`);
      return {
        items: decompressedItems,
        nextToken: this._encodeNextToken(lastKey),
        hasMore: Boolean(lastKey),
        count: result.Count || decompressedItems.length,
      };
    } catch (error) {
      ErrorHandler.addError(`Failed to get moderation items: ${error.message}`, {
        code: "GET_MODERATION_ITEMS_FAILED",
        origin: "Moderation.getModerationItems",
        data: { userId, status, priority, type, dayKey },
      });
      throw new Error(`Failed to get moderation items: ${error.message}`);
    }
  }

  static async getModerationItemsByStatus(
    status,
    { limit = 20, nextToken = null, start = null, end = null, asc = false } = {}
  ) {
    Logger.debugLog?.(`[Moderation] [getModerationItemsByStatus] [START] Getting moderation items by status: ${status}`);
    try {
      // Sanitize and validate inputs
      const sanitizedStatus = SafeUtils.sanitizeString(status);
      let sanitizedLimit = SafeUtils.sanitizeInteger(limit) || 20;
      // Enforce maximum query result size to prevent memory exhaustion
      if (sanitizedLimit > this.MAX_QUERY_RESULT_SIZE) {
        ErrorHandler.addError(`Query limit exceeds maximum allowed size (${this.MAX_QUERY_RESULT_SIZE})`, {
          code: "QUERY_RESULT_SIZE_EXCEEDED",
          origin: "Moderation.getModerationItemsByStatus",
          data: { requestedLimit: sanitizedLimit, maxLimit: this.MAX_QUERY_RESULT_SIZE }
        });
        throw new Error(`Query limit cannot exceed ${this.MAX_QUERY_RESULT_SIZE}. Requested: ${sanitizedLimit}. Use pagination for larger result sets.`);
      }
      const sanitizedStart =
        start !== null ? SafeUtils.sanitizeInteger(start) : null;
      const sanitizedEnd = end !== null ? SafeUtils.sanitizeInteger(end) : null;

      // Validate timestamp range
      if (sanitizedStart !== null && (sanitizedStart < 0 || !Number.isFinite(sanitizedStart))) {
        ErrorHandler.addError("Invalid start timestamp", {
          code: "INVALID_TIMESTAMP",
          origin: "Moderation.getModerationItemsByStatus",
          data: { start: sanitizedStart }
        });
        throw new Error("Invalid start timestamp");
      }
      if (sanitizedEnd !== null && (sanitizedEnd < 0 || !Number.isFinite(sanitizedEnd))) {
        ErrorHandler.addError("Invalid end timestamp", {
          code: "INVALID_TIMESTAMP",
          origin: "Moderation.getModerationItemsByStatus",
          data: { end: sanitizedEnd }
        });
        throw new Error("Invalid end timestamp");
      }
      if (sanitizedStart !== null && sanitizedEnd !== null && sanitizedStart > sanitizedEnd) {
        ErrorHandler.addError("Start must be less than or equal to end", {
          code: "INVALID_TIMESTAMP_RANGE",
          origin: "Moderation.getModerationItemsByStatus",
          data: { start: sanitizedStart, end: sanitizedEnd }
        });
        throw new Error("Start timestamp must be less than or equal to end timestamp");
      }

      // status is required (null/undefined or empty after sanitization)
      if (status === null || status === undefined) {
        ErrorHandler.addError("status is required", {
          code: "STATUS_REQUIRED",
          origin: "Moderation.getModerationItemsByStatus",
          data: {}
        });
        throw new Error("status is required");
      }
      if (typeof status === "string" && sanitizedStatus === "") {
        ErrorHandler.addError("status is required", {
          code: "STATUS_REQUIRED",
          origin: "Moderation.getModerationItemsByStatus",
          data: {}
        });
        throw new Error("status is required");
      }

      // Allow 'all' or no status
      if (
        sanitizedStatus &&
        sanitizedStatus !== "all" &&
        !this.STATUS_SET.has(sanitizedStatus)
      ) {
        ErrorHandler.addError(`Invalid status: ${sanitizedStatus}. Must be one of: ${Object.values(this.STATUS).join(", ")} or 'all'`, {
          code: "INVALID_STATUS_BY_STATUS",
          origin: "Moderation.getModerationItemsByStatus",
          data: { status: sanitizedStatus }
        });
        throw new Error(
          `Invalid status: ${sanitizedStatus}. Must be one of: ${Object.values(
            this.STATUS
          ).join(", ")} or 'all'`
        );
      }

      // If 'all' or no status, use Scan with submittedAt filters
      if (!sanitizedStatus || sanitizedStatus === "all") {
        const filterExpressions = [];
        const filterValues = {};

        if (sanitizedStart !== null && sanitizedEnd !== null) {
          filterExpressions.push("submittedAt BETWEEN :start AND :end");
          filterValues[":start"] = sanitizedStart;
          filterValues[":end"] = sanitizedEnd;
        } else if (sanitizedStart !== null) {
          filterExpressions.push("submittedAt >= :start");
          filterValues[":start"] = sanitizedStart;
        } else if (sanitizedEnd !== null) {
          filterExpressions.push("submittedAt <= :end");
          filterValues[":end"] = sanitizedEnd;
        }


        const scanOptions = {
          TableName: this.TABLE,
          Limit: sanitizedLimit,
          ...(filterExpressions.length > 0 && {
            FilterExpression: this._validateAndJoinFilterExpressions(filterExpressions),
            ExpressionAttributeValues: Scylla.marshalItem(filterValues),
          }),
          ...(nextToken && {
            ExclusiveStartKey: this._decodeNextToken(nextToken),
          }),
        };

        const result = await this._retryOperation(() =>
          Scylla.request("Scan", scanOptions)
        );
        const items = (result.Items ?? []).map(Scylla.unmarshalItem);

        // Best-effort in-memory sort (Scan has no sort order)
        items.sort((a, b) =>
          Boolean(asc)
            ? a.submittedAt - b.submittedAt
            : b.submittedAt - a.submittedAt
        );

        const lastKey = result.LastEvaluatedKey ?? null;
        const decompressedItems = await this._decompressItemsContent(items);
        Logger.debugLog?.(`[Moderation] [getModerationItemsByStatus] [SUCCESS] Retrieved ${decompressedItems.length} moderation items by status (scan)`);
        return {
          items: decompressedItems,
          nextToken: lastKey
            ? Buffer.from(JSON.stringify(lastKey)).toString("base64")
            : null,
          hasMore: Boolean(lastKey),
          count: result.Count || decompressedItems.length,
        };
      }

      // Existing path for a specific status (Query on GSI)
      const expression = [`#s = :status`];
      const names = { "#s": "status", "#sa": "submittedAt" };
      const vals = { ":status": sanitizedStatus };

      if (sanitizedStart !== null && sanitizedEnd !== null) {
        expression.push("#sa BETWEEN :start AND :end");
        vals[":start"] = sanitizedStart;
        vals[":end"] = sanitizedEnd;
      } else if (sanitizedStart !== null) {
        expression.push("#sa >= :start");
        vals[":start"] = sanitizedStart;
      } else if (sanitizedEnd !== null) {
        expression.push("#sa <= :end");
        vals[":end"] = sanitizedEnd;
      }
      const options = {
        TableName: this.TABLE,
        IndexName: this.GSI_STATUS_DATE,
        KeyConditionExpression: expression.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: Scylla.marshalItem(vals),
        Limit: sanitizedLimit,
        ScanIndexForward: Boolean(asc),
        ...(nextToken && {
          ExclusiveStartKey: this._decodeNextToken(nextToken),
        }),
      };

      const result = await this._retryOperation(() =>
        Scylla.request("Query", options)
      );
      const items = (result.Items ?? []).map(Scylla.unmarshalItem);
      const lastKey = result.LastEvaluatedKey ?? null;
      const decompressedItems = await this._decompressItemsContent(items);

      Logger.debugLog?.(`[Moderation] [getModerationItemsByStatus] [SUCCESS] Retrieved ${decompressedItems.length} moderation items by status (query)`);
      return {
        items: decompressedItems,
        nextToken: this._encodeNextToken(lastKey),
        hasMore: Boolean(lastKey),
        count: result.Count || decompressedItems.length,
      };
    } catch (error) {
      ErrorHandler.addError(`Failed to query moderation items by status: ${error.message}`, {
        code: "GET_MODERATION_ITEMS_BY_STATUS_FAILED",
        origin: "Moderation.getModerationItemsByStatus",
        data: { status },
      });
      throw new Error(
        `Failed to query moderation items by status: ${error.message}`
      );
    }
  }

  static async getAllByDate(
    dayKey,
    { limit = 20, nextToken = null, start = null, end = null, asc = false } = {}
  ) {
    Logger.debugLog?.(`[Moderation] [getAllByDate] [START] Getting all moderation items by date: ${dayKey}`);
    try {
      // Sanitize and validate inputs
      const sanitizedDayKey = SafeUtils.sanitizeString(dayKey);
      if (!sanitizedDayKey) {
        ErrorHandler.addError("dayKey is required", {
          code: "DAY_KEY_REQUIRED",
          origin: "Moderation.getAllByDate",
          data: { dayKey }
        });
        throw new Error("dayKey is required");
      }

      // Validate dayKey format (YYYYMMDD)
      if (!/^\d{8}$/.test(sanitizedDayKey)) {
        ErrorHandler.addError(`Invalid dayKey format: ${sanitizedDayKey}. Expected YYYYMMDD`, {
          code: "INVALID_DAY_KEY_FORMAT_ALL_BY_DATE",
          origin: "Moderation.getAllByDate",
          data: { dayKey: sanitizedDayKey }
        });
        throw new Error(
          `Invalid dayKey format: ${sanitizedDayKey}. Expected YYYYMMDD`
        );
      }

      // Validate dayKey represents a valid calendar date
      const year = parseInt(sanitizedDayKey.substring(0, 4), 10);
      const month = parseInt(sanitizedDayKey.substring(4, 6), 10);
      const day = parseInt(sanitizedDayKey.substring(6, 8), 10);
      const date = new Date(year, month - 1, day);
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        ErrorHandler.addError(`Invalid dayKey: ${sanitizedDayKey} does not represent a valid calendar date`, {
          code: "INVALID_DAY_KEY_DATE",
          origin: "Moderation.getAllByDate",
          data: { dayKey: sanitizedDayKey, year, month, day }
        });
        throw new Error(`Invalid dayKey: ${sanitizedDayKey} does not represent a valid calendar date (e.g., 20241399 is invalid)`);
      }

      let sanitizedLimit = SafeUtils.sanitizeInteger(limit) || 20;
      // Enforce maximum query result size to prevent memory exhaustion
      if (sanitizedLimit > this.MAX_QUERY_RESULT_SIZE) {
        ErrorHandler.addError(`Query limit exceeds maximum allowed size (${this.MAX_QUERY_RESULT_SIZE})`, {
          code: "QUERY_RESULT_SIZE_EXCEEDED",
          origin: "Moderation.getModerationItemsByStatus",
          data: { requestedLimit: sanitizedLimit, maxLimit: this.MAX_QUERY_RESULT_SIZE }
        });
        throw new Error(`Query limit cannot exceed ${this.MAX_QUERY_RESULT_SIZE}. Requested: ${sanitizedLimit}. Use pagination for larger result sets.`);
      }
      const sanitizedStart =
        start !== null ? SafeUtils.sanitizeInteger(start) : null;
      const sanitizedEnd = end !== null ? SafeUtils.sanitizeInteger(end) : null;

      const expression = ["#d = :day"];
      const names = { "#d": "dayKey", "#sa": "submittedAt" };
      const values = { ":day": sanitizedDayKey };

      if (sanitizedStart !== null && sanitizedEnd !== null) {
        expression.push("#sa BETWEEN :start AND :end");
        values[":start"] = sanitizedStart;
        values[":end"] = sanitizedEnd;
      } else if (sanitizedStart !== null) {
        expression.push("#sa >= :start");
        values[":start"] = sanitizedStart;
      } else if (sanitizedEnd !== null) {
        expression.push("#sa <= :end");
        values[":end"] = sanitizedEnd;
      }

      const result = await this._retryOperation(() =>
        Scylla.request("Query", {
          TableName: this.TABLE,
          IndexName: this.GSI_ALL_BY_DATE,
          KeyConditionExpression: expression.join(" AND "),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: Scylla.marshalItem(values),
          Limit: sanitizedLimit,
          ScanIndexForward: Boolean(asc),
          ...(nextToken && {
            ExclusiveStartKey: this._decodeNextToken(nextToken),
          }),
        })
      );

      const items = (result.Items ?? []).map(Scylla.unmarshalItem);
      const lastKey = result.LastEvaluatedKey ?? null;
      const decompressedItems = await this._decompressItemsContent(items);

      Logger.debugLog?.(`[Moderation] [getAllByDate] [SUCCESS] Retrieved ${decompressedItems.length} moderation items by date`);
      return {
        items: decompressedItems,
        nextToken: this._encodeNextToken(lastKey),
        hasMore: Boolean(lastKey),
        count: result.Count || decompressedItems.length,
      };
    } catch (error) {
      ErrorHandler.addError(`Failed to query moderation items by date: ${error.message}`, {
        code: "GET_ALL_BY_DATE_FAILED",
        origin: "Moderation.getAllByDate",
        data: { dayKey },
      });
      throw new Error(
        `Failed to query moderation items by date: ${error.message}`
      );
    }
  }

  static async getUserModerationItemsByStatus(
    userId,
    status,
    { limit = 20, nextToken = null, start = null, end = null, asc = false } = {}
  ) {
    Logger.debugLog?.(`[Moderation] [getUserModerationItemsByStatus] [START] Getting user moderation items by status: userId=${userId}, status=${status}`);
    try {
      // Sanitize and validate inputs
      const sanitizedUserId = SafeUtils.sanitizeString(userId);
      const sanitizedStatus = SafeUtils.sanitizeString(status);

      if (!sanitizedUserId) {
        ErrorHandler.addError("userId is required", {
          code: "USER_ID_REQUIRED",
          origin: "Moderation.getUserModerationItemsByStatus",
          data: { userId, status }
        });
        throw new Error("userId is required");
      }

      if (!sanitizedStatus) {
        ErrorHandler.addError("status is required", {
          code: "STATUS_REQUIRED",
          origin: "Moderation.getUserModerationItemsByStatus",
          data: { userId, status }
        });
        throw new Error("status is required");
      }

      // Validate status enum (allow special 'all')
      if (
        sanitizedStatus !== "all" &&
        !this.STATUS_SET.has(sanitizedStatus)
      ) {
        ErrorHandler.addError(`Invalid status: ${sanitizedStatus}. Must be one of: ${Object.values(this.STATUS).join(", ")} or 'all'`, {
          code: "INVALID_STATUS_USER_BY_STATUS",
          origin: "Moderation.getUserModerationItemsByStatus",
          data: { userId, status: sanitizedStatus }
        });
        throw new Error(
          `Invalid status: ${sanitizedStatus}. Must be one of: ${Object.values(
            this.STATUS
          ).join(", ")} or 'all'`
        );
      }

      let sanitizedLimit = SafeUtils.sanitizeInteger(limit) || 20;
      // Enforce maximum query result size to prevent memory exhaustion
      if (sanitizedLimit > this.MAX_QUERY_RESULT_SIZE) {
        ErrorHandler.addError(`Query limit exceeds maximum allowed size (${this.MAX_QUERY_RESULT_SIZE})`, {
          code: "QUERY_RESULT_SIZE_EXCEEDED",
          origin: "Moderation.getModerationItemsByStatus",
          data: { requestedLimit: sanitizedLimit, maxLimit: this.MAX_QUERY_RESULT_SIZE }
        });
        throw new Error(`Query limit cannot exceed ${this.MAX_QUERY_RESULT_SIZE}. Requested: ${sanitizedLimit}. Use pagination for larger result sets.`);
      }
      const sanitizedStart =
        start !== null && start !== undefined
          ? SafeUtils.sanitizeInteger(start)
          : null;
      const sanitizedEnd =
        end !== null && end !== undefined
          ? SafeUtils.sanitizeInteger(end)
          : null;

      // Validate timestamp range
      if (sanitizedStart !== null && (sanitizedStart < 0 || !Number.isFinite(sanitizedStart))) {
        ErrorHandler.addError("Invalid start timestamp", {
          code: "INVALID_TIMESTAMP",
          origin: "Moderation.getUserModerationItemsByStatus",
          data: { start: sanitizedStart }
        });
        throw new Error("Invalid start timestamp");
      }
      if (sanitizedEnd !== null && (sanitizedEnd < 0 || !Number.isFinite(sanitizedEnd))) {
        ErrorHandler.addError("Invalid end timestamp", {
          code: "INVALID_TIMESTAMP",
          origin: "Moderation.getUserModerationItemsByStatus",
          data: { end: sanitizedEnd }
        });
        throw new Error("Invalid end timestamp");
      }
      if (sanitizedStart !== null && sanitizedEnd !== null && sanitizedStart > sanitizedEnd) {
        ErrorHandler.addError("Start must be less than or equal to end", {
          code: "INVALID_TIMESTAMP_RANGE",
          origin: "Moderation.getUserModerationItemsByStatus",
          data: { start: sanitizedStart, end: sanitizedEnd }
        });
        throw new Error("Start timestamp must be less than or equal to end timestamp");
      }

      // If requesting all statuses, query by userId only and (optionally) filter by submittedAt
      if (sanitizedStatus === "all") {
        const keyExpression = ["#uid = :uid"].join(" AND ");
        const names = { "#uid": "userId" };
        const values = { ":uid": sanitizedUserId };

        const queryOptions = {
          TableName: this.TABLE,
          IndexName: this.GSI_USER_STATUS_DATE,
          KeyConditionExpression: keyExpression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: Scylla.marshalItem(values),
          Limit: sanitizedLimit,
          ScanIndexForward: Boolean(asc),
          ...(nextToken && {
            ExclusiveStartKey: this._decodeNextToken(nextToken),
          }),
        };

        // Optional submittedAt filters via FilterExpression
        const filterExpressions = [];
        const filterNames = {};
        const filterValues = {};

        if (sanitizedStart !== null && sanitizedEnd !== null) {
          filterExpressions.push("#sa BETWEEN :start AND :end");
          filterNames["#sa"] = "submittedAt";
          filterValues[":start"] = sanitizedStart;
          filterValues[":end"] = sanitizedEnd;
        } else if (sanitizedStart !== null) {
          filterExpressions.push("#sa >= :start");
          filterNames["#sa"] = "submittedAt";
          filterValues[":start"] = sanitizedStart;
        } else if (sanitizedEnd !== null) {
          filterExpressions.push("#sa <= :end");
          filterNames["#sa"] = "submittedAt";
          filterValues[":end"] = sanitizedEnd;
        }

        if (filterExpressions.length > 0) {
          queryOptions.FilterExpression = filterExpressions.join(" AND ");
          queryOptions.ExpressionAttributeNames = filterNames;
          // Merge key values and filter values for marshalling
          const mergedValues = { ...values, ...filterValues };
          queryOptions.ExpressionAttributeValues =
            Scylla.marshalItem(mergedValues);
        }

        const result = await this._retryOperation(() =>
          Scylla.request("Query", queryOptions)
        );
        const items = (result.Items ?? []).map(Scylla.unmarshalItem);
        const lastKey = result.LastEvaluatedKey ?? null;
        const decompressedItems = await this._decompressItemsContent(items);

        Logger.debugLog?.(`[Moderation] [getUserModerationItemsByStatus] [SUCCESS] Retrieved ${decompressedItems.length} user moderation items by status (all)`);
        return {
          items: decompressedItems,
          nextToken: lastKey
            ? Buffer.from(JSON.stringify(lastKey)).toString("base64")
            : null,
          hasMore: Boolean(lastKey),
          count: result.Count || decompressedItems.length,
        };
      }

      const startKey = this.statusSubmittedAtKey(
        sanitizedStatus,
        sanitizedStart ?? 0
      );
      const endKey = this.statusSubmittedAtKey(
        sanitizedStatus,
        sanitizedEnd ?? this.DEFAULT_TIMESTAMP_MAX
      );

      const expression = [
        "#uid = :uid",
        "#ssa BETWEEN :rkStart AND :rkEnd",
      ].join(" AND ");
      const names = {
        "#uid": "userId",
        "#ssa": "statusSubmittedAt"
      };
      const values = {
        ":uid": sanitizedUserId,
        ":rkStart": startKey,
        ":rkEnd": endKey,
      };

      const result = await this._retryOperation(() =>
        Scylla.request("Query", {
          TableName: this.TABLE,
          IndexName: this.GSI_USER_STATUS_DATE,
          KeyConditionExpression: expression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: Scylla.marshalItem(values),
          Limit: sanitizedLimit,
          ScanIndexForward: Boolean(asc),
          ...(nextToken && {
            ExclusiveStartKey: this._decodeNextToken(nextToken),
          }),
        })
      );

      const items = (result.Items ?? []).map(Scylla.unmarshalItem);
      const lastKey = result.LastEvaluatedKey ?? null;
      const decompressedItems = await this._decompressItemsContent(items);

      Logger.debugLog?.(`[Moderation] [getUserModerationItemsByStatus] [SUCCESS] Retrieved ${decompressedItems.length} user moderation items by status (specific)`);
      return {
        items: decompressedItems,
        nextToken: this._encodeNextToken(lastKey),
        hasMore: Boolean(lastKey),
        // send current page and how many pages there are
        count: result.Count || decompressedItems.length,
      };
    } catch (error) {
      ErrorHandler.addError(`Failed to query user moderation items: ${error.message}`, {
        code: "GET_USER_MODERATION_ITEMS_BY_STATUS_FAILED",
        origin: "Moderation.getUserModerationItemsByStatus",
        data: { userId, status },
      });
      throw new Error(
        `Failed to query user moderation items: ${error.message}`
      );
    }
  }

  static async getModerationItemsByPriority(
    priority,
    { limit = 20, nextToken = null, start = null, end = null, asc = false } = {}
  ) {
    Logger.debugLog?.(`[Moderation] [getModerationItemsByPriority] [START] Getting moderation items by priority: ${priority}`);
    try {
      // Sanitize and validate inputs
      const sanitizedPriority = SafeUtils.sanitizeString(priority);
      if (!sanitizedPriority) {
        ErrorHandler.addError("priority is required", {
          code: "PRIORITY_REQUIRED",
          origin: "Moderation.getModerationItemsByPriority",
          data: { priority }
        });
        throw new Error("priority is required");
      }

      // Validate priority enum
      if (!this.PRIORITY_SET.has(sanitizedPriority)) {
        ErrorHandler.addError(`Invalid priority: ${sanitizedPriority}. Must be one of: ${Object.values(this.PRIORITY).join(", ")}`, {
          code: "INVALID_PRIORITY_BY_PRIORITY",
          origin: "Moderation.getModerationItemsByPriority",
          data: { priority: sanitizedPriority }
        });
        throw new Error(
          `Invalid priority: ${sanitizedPriority}. Must be one of: ${Object.values(
            this.PRIORITY
          ).join(", ")}`
        );
      }

      let sanitizedLimit = SafeUtils.sanitizeInteger(limit) || 20;
      // Enforce maximum query result size to prevent memory exhaustion
      if (sanitizedLimit > this.MAX_QUERY_RESULT_SIZE) {
        ErrorHandler.addError(`Query limit exceeds maximum allowed size (${this.MAX_QUERY_RESULT_SIZE})`, {
          code: "QUERY_RESULT_SIZE_EXCEEDED",
          origin: "Moderation.getModerationItemsByStatus",
          data: { requestedLimit: sanitizedLimit, maxLimit: this.MAX_QUERY_RESULT_SIZE }
        });
        throw new Error(`Query limit cannot exceed ${this.MAX_QUERY_RESULT_SIZE}. Requested: ${sanitizedLimit}. Use pagination for larger result sets.`);
      }
      const sanitizedStart =
        start !== null ? SafeUtils.sanitizeInteger(start) : null;
      const sanitizedEnd = end !== null ? SafeUtils.sanitizeInteger(end) : null;

      if (sanitizedStart !== null && (sanitizedStart < 0 || !Number.isFinite(sanitizedStart))) {
        ErrorHandler.addError("Invalid start timestamp", { code: "INVALID_TIMESTAMP", origin: "Moderation.getModerationItemsByPriority", data: { start: sanitizedStart } });
        throw new Error("Invalid start timestamp");
      }
      if (sanitizedEnd !== null && (sanitizedEnd < 0 || !Number.isFinite(sanitizedEnd))) {
        ErrorHandler.addError("Invalid end timestamp", { code: "INVALID_TIMESTAMP", origin: "Moderation.getModerationItemsByPriority", data: { end: sanitizedEnd } });
        throw new Error("Invalid end timestamp");
      }
      if (sanitizedStart !== null && sanitizedEnd !== null && sanitizedStart > sanitizedEnd) {
        ErrorHandler.addError("Start must be less than or equal to end", { code: "INVALID_TIMESTAMP_RANGE", origin: "Moderation.getModerationItemsByPriority", data: { start: sanitizedStart, end: sanitizedEnd } });
        throw new Error("Start timestamp must be less than or equal to end timestamp");
      }

      const expression = ["#p = :p"];
      const names = { "#p": "priority", "#sa": "submittedAt" };
      const values = { ":p": sanitizedPriority };

      if (sanitizedStart !== null && sanitizedEnd !== null) {
        expression.push("#sa BETWEEN :start AND :end");
        values[":start"] = sanitizedStart;
        values[":end"] = sanitizedEnd;
      } else if (sanitizedStart !== null) {
        expression.push("#sa >= :start");
        values[":start"] = sanitizedStart;
      } else if (sanitizedEnd !== null) {
        expression.push("#sa <= :end");
        values[":end"] = sanitizedEnd;
      }

      const result = await this._retryOperation(() =>
        Scylla.request("Query", {
          TableName: this.TABLE,
          IndexName: this.GSI_PRIORITY,
          KeyConditionExpression: expression.join(" AND "),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: Scylla.marshalItem(values),
          Limit: sanitizedLimit,
          ScanIndexForward: Boolean(asc),
          ...(nextToken && {
            ExclusiveStartKey: this._decodeNextToken(nextToken),
          }),
        })
      );

      const items = (result.Items ?? []).map(Scylla.unmarshalItem);
      const lastKey = result.LastEvaluatedKey ?? null;
      const decompressedItems = await this._decompressItemsContent(items);

      Logger.debugLog?.(`[Moderation] [getModerationItemsByPriority] [SUCCESS] Retrieved ${decompressedItems.length} moderation items by priority`);
      return {
        items: decompressedItems,
        nextToken: this._encodeNextToken(lastKey),
        hasMore: Boolean(lastKey),
        count: result.Count || decompressedItems.length,
      };
    } catch (error) {
      ErrorHandler.addError(`Failed to query moderation items by priority: ${error.message}`, {
        code: "GET_MODERATION_ITEMS_BY_PRIORITY_FAILED",
        origin: "Moderation.getModerationItemsByPriority",
        data: { priority },
      });
      throw new Error(
        `Failed to query moderation items by priority: ${error.message}`
      );
    }
  }

  static async getModerationItemsByType(
    type,
    { limit = 20, nextToken = null, start = null, end = null, asc = false } = {}
  ) {
    Logger.debugLog?.(`[Moderation] [getModerationItemsByType] [START] Getting moderation items by type: ${type}`);
    try {
      // Sanitize and validate inputs
      const sanitizedType = SafeUtils.sanitizeString(type);
      if (!sanitizedType) {
        ErrorHandler.addError("type is required", {
          code: "TYPE_REQUIRED",
          origin: "Moderation.getModerationItemsByType",
          data: { type }
        });
        throw new Error("type is required");
      }

      // Validate type enum
      if (!this.TYPE_SET.has(sanitizedType)) {
        ErrorHandler.addError(`Invalid type: ${sanitizedType}. Must be one of: ${Object.values(this.TYPE).join(", ")}`, {
          code: "INVALID_TYPE_BY_TYPE",
          origin: "Moderation.getModerationItemsByType",
          data: { type: sanitizedType }
        });
        throw new Error(
          `Invalid type: ${sanitizedType}. Must be one of: ${Object.values(
            this.TYPE
          ).join(", ")}`
        );
      }

      let sanitizedLimit = SafeUtils.sanitizeInteger(limit) || 20;
      // Enforce maximum query result size to prevent memory exhaustion
      if (sanitizedLimit > this.MAX_QUERY_RESULT_SIZE) {
        ErrorHandler.addError(`Query limit exceeds maximum allowed size (${this.MAX_QUERY_RESULT_SIZE})`, {
          code: "QUERY_RESULT_SIZE_EXCEEDED",
          origin: "Moderation.getModerationItemsByStatus",
          data: { requestedLimit: sanitizedLimit, maxLimit: this.MAX_QUERY_RESULT_SIZE }
        });
        throw new Error(`Query limit cannot exceed ${this.MAX_QUERY_RESULT_SIZE}. Requested: ${sanitizedLimit}. Use pagination for larger result sets.`);
      }
      const sanitizedStart =
        start !== null ? SafeUtils.sanitizeInteger(start) : null;
      const sanitizedEnd = end !== null ? SafeUtils.sanitizeInteger(end) : null;

      if (sanitizedStart !== null && (sanitizedStart < 0 || !Number.isFinite(sanitizedStart))) {
        ErrorHandler.addError("Invalid start timestamp", { code: "INVALID_TIMESTAMP", origin: "Moderation.getModerationItemsByType", data: { start: sanitizedStart } });
        throw new Error("Invalid start timestamp");
      }
      if (sanitizedEnd !== null && (sanitizedEnd < 0 || !Number.isFinite(sanitizedEnd))) {
        ErrorHandler.addError("Invalid end timestamp", { code: "INVALID_TIMESTAMP", origin: "Moderation.getModerationItemsByType", data: { end: sanitizedEnd } });
        throw new Error("Invalid end timestamp");
      }
      if (sanitizedStart !== null && sanitizedEnd !== null && sanitizedStart > sanitizedEnd) {
        ErrorHandler.addError("Start must be less than or equal to end", { code: "INVALID_TIMESTAMP_RANGE", origin: "Moderation.getModerationItemsByType", data: { start: sanitizedStart, end: sanitizedEnd } });
        throw new Error("Start timestamp must be less than or equal to end timestamp");
      }

      const expression = ["#t = :type"];
      const names = { "#t": "type", "#sa": "submittedAt" };
      const values = { ":type": sanitizedType };

      if (sanitizedStart !== null && sanitizedEnd !== null) {
        expression.push("#sa BETWEEN :start AND :end");
        values[":start"] = sanitizedStart;
        values[":end"] = sanitizedEnd;
      } else if (sanitizedStart !== null) {
        expression.push("#sa >= :start");
        values[":start"] = sanitizedStart;
      } else if (sanitizedEnd !== null) {
        expression.push("#sa <= :end");
        values[":end"] = sanitizedEnd;
      }

      const result = await this._retryOperation(() =>
        Scylla.request("Query", {
          TableName: this.TABLE,
          IndexName: this.GSI_TYPE_DATE,
          KeyConditionExpression: expression.join(" AND "),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: Scylla.marshalItem(values),
          Limit: sanitizedLimit,
          ScanIndexForward: Boolean(asc),
          ...(nextToken && {
            ExclusiveStartKey: this._decodeNextToken(nextToken),
          }),
        })
      );

      const items = (result.Items ?? []).map(Scylla.unmarshalItem);
      const lastKey = result.LastEvaluatedKey ?? null;
      const decompressedItems = await this._decompressItemsContent(items);

      Logger.debugLog?.(`[Moderation] [getModerationItemsByType] [SUCCESS] Retrieved ${decompressedItems.length} moderation items by type`);
      return {
        items: decompressedItems,
        nextToken: this._encodeNextToken(lastKey),
        hasMore: Boolean(lastKey),
        count: result.Count || decompressedItems.length,
      };
    } catch (error) {
      ErrorHandler.addError(`Failed to query moderation items by type: ${error.message}`, {
        code: "GET_MODERATION_ITEMS_BY_TYPE_FAILED",
        origin: "Moderation.getModerationItemsByType",
        data: { type },
      });
      throw new Error(
        `Failed to query moderation items by type: ${error.message}`
      );
    }
  }
  // ============================================================

  static async getModerationRecordById(moderationId, userId = null, includeDeleted = false) {
    Logger.debugLog?.(`[Moderation] [getModerationRecordById] [START] Getting moderation record by ID: ${moderationId}, userId: ${userId}`);
    try {
      // Require userId to ensure unambiguous lookups and prevent cross-user data access
      // moderationId is globally unique, but requiring userId provides additional security
      if (!userId) {
        ErrorHandler.addError("userId is required for getModerationRecordById to ensure unambiguous lookups", {
          code: "USER_ID_REQUIRED_FOR_LOOKUP",
          origin: "Moderation.getModerationRecordById",
          data: { moderationId }
        });
        throw new Error("userId is required for getModerationRecordById to ensure unambiguous lookups and prevent cross-user data access");
      }
      // Sanitize and validate inputs
      const sanitizedModerationId = SafeUtils.sanitizeString(moderationId);
      if (!sanitizedModerationId) {
        ErrorHandler.addError("moderationId is required", {
          code: "MODERATION_ID_REQUIRED",
          origin: "Moderation.getModerationRecordById",
          data: { moderationId, userId }
        });
        throw new Error("moderationId is required");
      }
      // Validate UUID format
      this._validateModerationIdFormat(sanitizedModerationId);

      const sanitizedUserId = SafeUtils.sanitizeString(userId);
      if (!sanitizedUserId) {
        ErrorHandler.addError("userId is required", {
          code: "USER_ID_REQUIRED",
          origin: "Moderation.getModerationRecordById",
          data: { moderationId: sanitizedModerationId, userId }
        });
        throw new Error("userId is required");
      }

      // Always use userId for unambiguous lookups
      const expression = "#mid = :mid AND #uid = :uid";
      const names = { "#mid": "moderationId", "#uid": "userId" };
      const values = { ":mid": sanitizedModerationId, ":uid": sanitizedUserId };

      const q = await this._retryOperation(() =>
        Scylla.request("Query", {
          TableName: this.TABLE,
          IndexName: this.GSI_BY_MOD_ID,
          KeyConditionExpression: expression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: Scylla.marshalItem(values),
          Limit: 1,
        })
      );

      const item = (q.Items ?? []).map(Scylla.unmarshalItem)[0] ?? null;
      if (!item) return null;

      Logger.debugLog?.(`[Moderation] [getModerationRecordById] [SUCCESS] Retrieved moderation record by ID: ${sanitizedModerationId}`);
      const getItemResult = await this._retryOperation(() =>
        Scylla.getItem(this.TABLE, {
          [this.PK]: item[this.PK],
          [this.SK]: item[this.SK],
        })
      );
      const retrievedItem = getItemResult != null && Object.prototype.hasOwnProperty.call(getItemResult, 'Item')
        ? getItemResult.Item
        : getItemResult;

      // Decompress content if it was compressed
      const decompressedItem = await this._decompressItemsContent(retrievedItem);
      
      // Check if item is soft-deleted and filter based on includeDeleted flag
      if (decompressedItem && decompressedItem.isDeleted === true && !includeDeleted) {
        Logger.debugLog?.(`[Moderation] [getModerationRecordById] [INFO] Item is soft-deleted and includeDeleted is false, returning null`);
        return null;
      }
      
      return decompressedItem;
    } catch (error) {
      ErrorHandler.addError(`Failed to get moderation record: ${error.message}`, {
        code: "GET_MODERATION_RECORD_BY_ID_FAILED",
        origin: "Moderation.getModerationRecordById",
        data: { moderationId, userId },
      });
      throw new Error(`Failed to get moderation record: ${error.message}`);
    }
  }

  /**
   * ============================================================
   *   Meta Update Methods
   * ============================================================
   */

  /**
   * Update meta field for a moderation item
   * @param {string} moderationId - Moderation ID
   * @param {string} userId - User ID (optional, for validation)
   * @param {Object} metaUpdates - Meta field updates
   * @param {boolean} metaUpdates.contentDeleted - Content deleted flag
   * @param {number} metaUpdates.contentDeletedAt - Content deleted timestamp
   * @param {string} metaUpdates.updatedBy - User updating the meta
   * @returns {Promise<Object>} Updated moderation record
   */
  static async updateModerationMeta(
    moderationId,
    userId = null,
    metaUpdates = {}
  ) {
    Logger.debugLog?.(`[Moderation] [updateModerationMeta] [START] Updating moderation meta for ID: ${moderationId}, userId: ${userId}`);
    try {
      // Sanitize and validate inputs
      const sanitizedModerationId = SafeUtils.sanitizeString(moderationId);
      if (!sanitizedModerationId) {
        ErrorHandler.addError("moderationId is required", {
          code: "MODERATION_ID_REQUIRED_UPDATE_META",
          origin: "Moderation.updateModerationMeta",
          data: { moderationId, userId }
        });
        throw new Error("moderationId is required");
      }

      const sanitizedUserId = userId ? SafeUtils.sanitizeString(userId) : null;
      // Prevent prototype pollution in metaUpdates
      const safeMetaUpdates = typeof SafeUtils.safeObject === 'function' ? SafeUtils.safeObject(metaUpdates) : metaUpdates;
      const sanitizedUpdatedBy = safeMetaUpdates.updatedBy
        ? SafeUtils.sanitizeString(safeMetaUpdates.updatedBy)
        : null;

      // Get existing record
      const item = await this.getModerationRecordById(
        sanitizedModerationId,
        sanitizedUserId
      );
      if (!item) {
        ErrorHandler.addError(`Moderation item not found: moderationId=${sanitizedModerationId}`, {
          code: "MODERATION_ITEM_NOT_FOUND_UPDATE_META",
          origin: "Moderation.updateModerationMeta",
          data: { moderationId: sanitizedModerationId, userId: sanitizedUserId }
        });
        throw new Error(
          `Moderation item not found: moderationId=${sanitizedModerationId}`
        );
      }

      // Build meta updates (use safeMetaUpdates to avoid prototype pollution)
      const existingMeta =
        item.meta ||
        this._createMetaField("create", item.userId || sanitizedUserId);
      const updatedMeta = { ...existingMeta };

      // Update contentDeleted fields if provided
      if (safeMetaUpdates.contentDeleted !== undefined) {
        updatedMeta.contentDeleted = Boolean(safeMetaUpdates.contentDeleted);
        updatedMeta.contentDeletedAt = safeMetaUpdates.contentDeletedAt
          ? SafeUtils.sanitizeInteger(safeMetaUpdates.contentDeletedAt)
          : safeMetaUpdates.contentDeleted
          ? this._getCurrentTimestamp()
          : null;
      }

      // Update meta field with audit trail
      const finalMeta = this._updateMetaField(
        updatedMeta,
        "updateMeta",
        sanitizedUpdatedBy || sanitizedUserId || item.userId,
        {
          contentDeleted: safeMetaUpdates.contentDeleted,
          contentDeletedAt: updatedMeta.contentDeletedAt,
        }
      );

      const expectedVersion = (existingMeta && existingMeta.version) != null ? existingMeta.version : 0;
      // Update the record with optimistic locking
      const result = await this._retryOperation(() =>
        Scylla.updateItem(
          this.TABLE,
          { [this.PK]: item[this.PK], [this.SK]: item[this.SK] },
          { meta: finalMeta },
          {
            ConditionExpression: "#meta.#version = :expectedVersion",
            ExpressionAttributeNames: { "#meta": "meta", "#version": "version" },
            ExpressionAttributeValues: { ":expectedVersion": expectedVersion },
          }
        )
      );

      await Logger.writeLog({
        flag: "MODERATIONS",
        action: "metaUpdated",
        data: {
          moderationId: sanitizedModerationId,
          userId: sanitizedUserId,
          updatedBy: sanitizedUpdatedBy,
          contentDeleted: safeMetaUpdates.contentDeleted,
        }
      });
      Logger.debugLog?.(`[Moderation] [updateModerationMeta] [SUCCESS] Moderation meta updated for ID: ${sanitizedModerationId}`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to update moderation meta: ${error.message}`, {
        code: "UPDATE_MODERATION_META_FAILED",
        origin: "Moderation.updateModerationMeta",
        data: { moderationId, userId },
      });
      throw new Error(`Failed to update moderation meta: ${error.message}`);
    }
  }

  /**
   * ============================================================
   *   Delete Methods
   * ============================================================
   */

  /**
   * Soft delete a moderation item (sets isDeleted flag)
   * @param {string} moderationId - Moderation ID
   * @param {string} userId - User ID (optional, for validation)
   * @param {string} deletedBy - User performing the deletion
   * @returns {Promise<Object>} Updated moderation record
   */
  static async softDeleteModerationItem(
    moderationId,
    userId = null,
    deletedBy = null
  ) {
    Logger.debugLog?.(`[Moderation] [softDeleteModerationItem] [START] Soft deleting moderation item ID: ${moderationId}, userId: ${userId}, deletedBy: ${deletedBy}`);
    try {
      // Sanitize and validate inputs
      const sanitizedModerationId = SafeUtils.sanitizeString(moderationId);
      if (!sanitizedModerationId) {
        ErrorHandler.addError("moderationId is required", {
          code: "MODERATION_ID_REQUIRED_SOFT_DELETE",
          origin: "Moderation.softDeleteModerationItem",
          data: { moderationId, userId, deletedBy }
        });
        throw new Error("moderationId is required");
      }

      const sanitizedUserId = userId ? SafeUtils.sanitizeString(userId) : null;
      const sanitizedDeletedBy = deletedBy
        ? SafeUtils.sanitizeString(deletedBy)
        : sanitizedUserId;

      // Get existing record (include deleted so we can detect "already deleted")
      const item = await this.getModerationRecordById(
        sanitizedModerationId,
        sanitizedUserId,
        true
      );
      if (!item) {
        ErrorHandler.addError(`Moderation item not found: moderationId=${sanitizedModerationId}`, {
          code: "MODERATION_ITEM_NOT_FOUND_SOFT_DELETE",
          origin: "Moderation.softDeleteModerationItem",
          data: { moderationId: sanitizedModerationId, userId: sanitizedUserId }
        });
        throw new Error(
          `Moderation item not found: moderationId=${sanitizedModerationId}`
        );
      }

      if (item.isDeleted) {
        ErrorHandler.addError(`Moderation item is already deleted: moderationId=${sanitizedModerationId}`, {
          code: "MODERATION_ITEM_ALREADY_DELETED",
          origin: "Moderation.softDeleteModerationItem",
          data: { moderationId: sanitizedModerationId, userId: sanitizedUserId }
        });
        throw new Error(
          `Moderation item is already deleted: moderationId=${sanitizedModerationId}`
        );
      }

      const now = this._getCurrentTimestamp();

      // Update meta field with deletion history
      const existingMeta =
        item.meta ||
        this._createMetaField("create", item.userId || sanitizedUserId);
      const updatedMeta = this._updateMetaField(
        existingMeta,
        "softDelete",
        sanitizedDeletedBy || sanitizedUserId || item.userId,
        {
          previousStatus: item.status,
          deletedAt: now,
        }
      );

      const expectedVersion = (existingMeta && existingMeta.version) != null ? existingMeta.version : 0;
      // Update the record with soft delete flags (optimistic locking)
      const result = await this._retryOperation(() =>
        Scylla.updateItem(
          this.TABLE,
          { [this.PK]: item[this.PK], [this.SK]: item[this.SK] },
          {
            isDeleted: true,
            deletedAt: now,
            meta: updatedMeta,
          },
          {
            ConditionExpression: "#meta.#version = :expectedVersion",
            ExpressionAttributeNames: { "#meta": "meta", "#version": "version" },
            ExpressionAttributeValues: { ":expectedVersion": expectedVersion },
          }
        )
      );

      await Logger.writeLog({
        flag: "MODERATIONS",
        action: "itemSoftDeleted",
        data: {
          moderationId: sanitizedModerationId,
          userId: sanitizedUserId,
          deletedBy: sanitizedDeletedBy,
        }
      });
      Logger.debugLog?.(`[Moderation] [softDeleteModerationItem] [SUCCESS] Moderation item soft deleted: ${sanitizedModerationId}`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to soft delete moderation item: ${error.message}`, {
        code: "SOFT_DELETE_MODERATION_ITEM_FAILED",
        origin: "Moderation.softDeleteModerationItem",
        data: { moderationId, userId },
      });
      throw new Error(
        `Failed to soft delete moderation item: ${error.message}`
      );
    }
  }

  /**
   * Hard delete a moderation item (permanently removes from database)
   * @param {string} moderationId - Moderation ID
   * @param {string} userId - User ID (optional, for validation)
   * @returns {Promise<boolean>} True if deleted, false if not found
   */
  static async hardDeleteModerationItem(moderationId, userId = null) {
    Logger.debugLog?.(`[Moderation] [hardDeleteModerationItem] [START] Hard deleting moderation item ID: ${moderationId}, userId: ${userId}`);
    try {
      // Sanitize and validate inputs
      const sanitizedModerationId = SafeUtils.sanitizeString(moderationId);
      if (!sanitizedModerationId) {
        ErrorHandler.addError("moderationId is required", {
          code: "MODERATION_ID_REQUIRED_HARD_DELETE",
          origin: "Moderation.hardDeleteModerationItem",
          data: { moderationId, userId }
        });
        throw new Error("moderationId is required");
      }
      // Validate UUID format
      this._validateModerationIdFormat(sanitizedModerationId);

      const sanitizedUserId = userId ? SafeUtils.sanitizeString(userId) : null;

      // Get existing record to find PK/SK
      const item = await this.getModerationRecordById(
        sanitizedModerationId,
        sanitizedUserId
      );
      if (!item) {
        return false; // Not found, return false (not an error)
      }

      // Delete the item
      const deleted = await this._retryOperation(() =>
        Scylla.deleteItem(this.TABLE, {
          [this.PK]: item[this.PK],
          [this.SK]: item[this.SK],
        })
      );

      if (deleted) {
        await Logger.writeLog({
          flag: "MODERATIONS",
          action: "itemHardDeleted",
          data: {
            moderationId: sanitizedModerationId,
            userId: sanitizedUserId,
          }
        });
        Logger.debugLog?.(`[Moderation] [hardDeleteModerationItem] [SUCCESS] Moderation item hard deleted: ${sanitizedModerationId}`);
      }

      return deleted;
    } catch (error) {
      ErrorHandler.addError(`Failed to hard delete moderation item: ${error.message}`, {
        code: "HARD_DELETE_MODERATION_ITEM_FAILED",
        origin: "Moderation.hardDeleteModerationItem",
        data: { moderationId, userId },
      });
      throw new Error(
        `Failed to hard delete moderation item: ${error.message}`
      );
    }
  }

  /**
   * ============================================================
   *   Count Methods
   * ============================================================
   */

  /**
   * Count moderation items by status with optional filters
   * 
   * This method uses DynamoDB's Select: "COUNT" optimization, which returns only the count
   * without transferring item data, making it efficient for counting operations.
   * Pagination is necessary to get accurate counts across all pages when results span multiple pages.
   * 
   * For dashboard views or frequently accessed counts, consider implementing caching with TTL
   * to avoid repeated full pagination scans.
   * 
   * @param {string} status - Status to count (or 'all' for all statuses)
   * @param {Object} options - Optional filters
   * @param {string} options.userId - Filter by user ID
   * @param {string} options.moderatedBy - Filter by moderator (null for unmoderated)
   * @param {boolean} options.hasRejectionHistory - Filter items with rejection history
   * @param {number} options.start - Start timestamp filter
   * @param {number} options.end - End timestamp filter
   * @returns {Promise<number>} Count of items
   */
  static async countModerationItemsByStatus(
    status = "all",
    options = {}
  ) {
    const safeOptions = typeof SafeUtils.safeObject === 'function' ? SafeUtils.safeObject(options) : options;
    const { userId = null, moderatedBy = null, hasRejectionHistory = null, start = null, end = null, unmoderatedOnly = false } = safeOptions || {};
    Logger.debugLog?.(`[Moderation] [countModerationItemsByStatus] [START] Counting moderation items by status: ${status}, userId: ${userId}`);
    try {
      // Handle 'all' status
      if (status === "all" || status === null || status === '') {
        const allStatuses = Object.values(this.STATUS);
        const counts = await Promise.all(
          allStatuses.map((s) =>
            this.countModerationItemsByStatus(s, {
              userId,
              moderatedBy,
              hasRejectionHistory,
              start,
              end,
              unmoderatedOnly,
            })
          )
        );
        return counts.reduce((sum, count) => sum + count, 0);
      }

      // Validate status
      const sanitizedStatus = SafeUtils.sanitizeString(status);
      if (!sanitizedStatus) {
        ErrorHandler.addError("Status is required", {
          code: "STATUS_REQUIRED_COUNT",
          origin: "Moderation.countModerationItemsByStatus",
          data: { status, userId }
        });
        throw new Error("Status is required");
      }

      if (!Object.values(this.STATUS).includes(sanitizedStatus)) {
        ErrorHandler.addError(`Invalid status: ${sanitizedStatus}. Must be one of: ${Object.values(this.STATUS).join(", ")}`, {
          code: "INVALID_STATUS_COUNT",
          origin: "Moderation.countModerationItemsByStatus",
          data: { status: sanitizedStatus, userId }
        });
        throw new Error(
          `Invalid status: ${sanitizedStatus}. Must be one of: ${Object.values(
            this.STATUS
          ).join(", ")}`
        );
      }

      const sanitizedUserId = userId ? SafeUtils.sanitizeString(userId) : null;
      const sanitizedModeratedBy =
        moderatedBy !== null ? SafeUtils.sanitizeString(moderatedBy) : null;
      const sanitizedStart =
        start !== null ? SafeUtils.sanitizeInteger(start) : null;
      const sanitizedEnd = end !== null ? SafeUtils.sanitizeInteger(end) : null;

      if (sanitizedStart !== null && (sanitizedStart < 0 || !Number.isFinite(sanitizedStart))) {
        ErrorHandler.addError("Invalid start timestamp", { code: "INVALID_TIMESTAMP", origin: "Moderation.countModerationItemsByStatus", data: { start: sanitizedStart } });
        throw new Error("Invalid start timestamp");
      }
      if (sanitizedEnd !== null && (sanitizedEnd < 0 || !Number.isFinite(sanitizedEnd))) {
        ErrorHandler.addError("Invalid end timestamp", { code: "INVALID_TIMESTAMP", origin: "Moderation.countModerationItemsByStatus", data: { end: sanitizedEnd } });
        throw new Error("Invalid end timestamp");
      }
      if (sanitizedStart !== null && sanitizedEnd !== null && sanitizedStart > sanitizedEnd) {
        ErrorHandler.addError("Start must be less than or equal to end", { code: "INVALID_TIMESTAMP_RANGE", origin: "Moderation.countModerationItemsByStatus", data: { start: sanitizedStart, end: sanitizedEnd } });
        throw new Error("Start timestamp must be less than or equal to end timestamp");
      }

      // Build query based on available filters (priority: userId > moderatedBy > status)
      let totalCount = 0;
      let lastKey = null;

      // Strategy 1: User ID filter (highest priority)
      if (sanitizedUserId) {
        // Use GSI_USER_STATUS_DATE for user-specific queries
        const startKey = this.statusSubmittedAtKey(
          sanitizedStatus,
          sanitizedStart ?? 0
        );
        const endKey = this.statusSubmittedAtKey(
          sanitizedStatus,
          sanitizedEnd ?? this.DEFAULT_TIMESTAMP_MAX
        );

        const expression = [
          "#uid = :uid",
          "#ssa BETWEEN :rkStart AND :rkEnd",
        ].join(" AND ");
        const keyNames = {
          "#uid": "userId",
          "#ssa": "statusSubmittedAt"
        };
        const values = {
          ":uid": sanitizedUserId,
          ":rkStart": startKey,
          ":rkEnd": endKey,
        };

        const filterExpressions = [];
        const filterNames = {};
        const filterValues = {};

        // Handle moderatedBy filter: treat null/undefined as explicit unmoderated filter when unmoderatedOnly flag is set
        if (unmoderatedOnly || (sanitizedModeratedBy === null && moderatedBy === null)) {
          // Explicit unmoderated filter: attribute_not_exists
          filterExpressions.push("attribute_not_exists(#mb)");
          filterNames["#mb"] = "moderatedBy";
        } else if (sanitizedModeratedBy !== null) {
          if (sanitizedModeratedBy === "null") {
            filterExpressions.push("attribute_not_exists(#mb)");
            filterNames["#mb"] = "moderatedBy";
          } else {
            filterExpressions.push("#mb = :mb");
            filterNames["#mb"] = "moderatedBy";
            filterValues[":mb"] = sanitizedModeratedBy;
          }
        }

        if (hasRejectionHistory === true) {
          filterExpressions.push("attribute_exists(#rh)");
          filterNames["#rh"] = "rejectionHistory";
        }

        // Marshal values once before the loop to avoid repeated marshalling
        const hasFilterValues = Object.keys(filterValues).length > 0;
        const mergedValues = hasFilterValues
          ? { ...values, ...filterValues }
          : values;
        const marshaledKeyValues = Scylla.marshalItem(values);
        const marshaledMergedValues = hasFilterValues
          ? Scylla.marshalItem(mergedValues)
          : null;
        // Merge ExpressionAttributeNames when we have filter expressions or filter values (FilterExpression references #mb etc.)
        const mergedNames = (filterExpressions.length > 0 || hasFilterValues)
          ? { ...keyNames, ...filterNames }
          : keyNames;
        const useMergedNames = filterExpressions.length > 0 || hasFilterValues;
        const queryExpressionAttributeNames = useMergedNames ? mergedNames : keyNames;
        const queryExpressionAttributeValues = hasFilterValues ? marshaledMergedValues : marshaledKeyValues;

        // Pagination loop: Select: "COUNT" ensures only count is returned, not item data
        // This is optimal for counting operations, but pagination is still needed for accurate totals
        let iterationCount = 0;
        do {
          iterationCount++;
          if (iterationCount > this.MAX_PAGINATION_ITERATIONS) {
            ErrorHandler.addError(`Pagination limit exceeded: maximum ${this.MAX_PAGINATION_ITERATIONS} iterations allowed`, {
              code: "PAGINATION_LIMIT_EXCEEDED",
              origin: "Moderation.countModerationItemsByStatus",
              data: { 
                status: sanitizedStatus, 
                userId: sanitizedUserId,
                iterationCount,
                totalCount
              }
            });
            throw new Error(`Pagination limit exceeded: maximum ${this.MAX_PAGINATION_ITERATIONS} iterations allowed. This may indicate an extremely large dataset.`);
          }

          const queryOptions = {
            TableName: this.TABLE,
            IndexName: this.GSI_USER_STATUS_DATE,
            KeyConditionExpression: expression,
            ExpressionAttributeNames: queryExpressionAttributeNames,
            ExpressionAttributeValues: queryExpressionAttributeValues,
            Select: "COUNT",
            ...(lastKey && { ExclusiveStartKey: lastKey }),
          };

          if (filterExpressions.length > 0) {
            queryOptions.FilterExpression = filterExpressions.join(" AND ");
          }

          const result = await this._retryOperation(() =>
            Scylla.request("Query", queryOptions)
          );
          totalCount += (result && result.Count) || 0;
          lastKey = (result && result.LastEvaluatedKey) || null;
        } while (lastKey);
      }
      // Strategy 2: ModeratedBy filter (use GSI_MODERATED_BY for efficient queries)
      else if (sanitizedModeratedBy !== null && sanitizedModeratedBy !== "null") {
        // Use GSI_MODERATED_BY for moderator-specific queries
        const expression = ["#mb = :mb"];
        const names = { "#mb": "moderatedBy", "#sa": "submittedAt", "#s": "status" };
        const vals = { ":mb": sanitizedModeratedBy };

        // Add submittedAt range to key condition if provided
        if (sanitizedStart !== null && sanitizedEnd !== null) {
          expression.push("#sa BETWEEN :start AND :end");
          vals[":start"] = sanitizedStart;
          vals[":end"] = sanitizedEnd;
        } else if (sanitizedStart !== null) {
          expression.push("#sa >= :start");
          vals[":start"] = sanitizedStart;
        } else if (sanitizedEnd !== null) {
          expression.push("#sa <= :end");
          vals[":end"] = sanitizedEnd;
        }

        const filterExpressions = [];
        // Filter by status if provided
        if (sanitizedStatus) {
          filterExpressions.push("#s = :status");
          vals[":status"] = sanitizedStatus;
        }

        if (hasRejectionHistory === true) {
          filterExpressions.push("attribute_exists(#rh)");
          names["#rh"] = "rejectionHistory";
        }

        // Marshal values once before the loop to avoid repeated marshalling
        const marshaledVals = Scylla.marshalItem(vals);

        let iterationCount = 0;
        do {
          iterationCount++;
          if (iterationCount > this.MAX_PAGINATION_ITERATIONS) {
            ErrorHandler.addError(`Pagination limit exceeded: maximum ${this.MAX_PAGINATION_ITERATIONS} iterations allowed`, {
              code: "PAGINATION_LIMIT_EXCEEDED",
              origin: "Moderation.countModerationItemsByStatus",
              data: { 
                status: sanitizedStatus, 
                moderatedBy: sanitizedModeratedBy,
                iterationCount,
                totalCount
              }
            });
            throw new Error(`Pagination limit exceeded: maximum ${this.MAX_PAGINATION_ITERATIONS} iterations allowed. This may indicate an extremely large dataset.`);
          }

          const queryOptions = {
            TableName: this.TABLE,
            IndexName: this.GSI_MODERATED_BY,
            KeyConditionExpression: expression.join(" AND "),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: marshaledVals,
            Select: "COUNT",
            ...(lastKey && { ExclusiveStartKey: lastKey }),
          };

          if (filterExpressions.length > 0) {
            queryOptions.FilterExpression = filterExpressions.join(" AND ");
          }

          const result = await this._retryOperation(() =>
            Scylla.request("Query", queryOptions)
          );
          totalCount += (result && result.Count) || 0;
          lastKey = (result && result.LastEvaluatedKey) || null;
        } while (lastKey);
      }
      // Strategy 3: Status-only queries (fallback to GSI_STATUS_DATE)
      else {
        // Use GSI_STATUS_DATE for status-only queries
        const expression = [`#s = :status`];
        const names = { "#s": "status", "#sa": "submittedAt" };
        const vals = { ":status": sanitizedStatus };

        if (sanitizedStart !== null && sanitizedEnd !== null) {
          expression.push("#sa BETWEEN :start AND :end");
          vals[":start"] = sanitizedStart;
          vals[":end"] = sanitizedEnd;
        } else if (sanitizedStart !== null) {
          expression.push("#sa >= :start");
          vals[":start"] = sanitizedStart;
        } else if (sanitizedEnd !== null) {
          expression.push("#sa <= :end");
          vals[":end"] = sanitizedEnd;
        }

        const filterExpressions = [];
        // Unmoderated-only: attribute_not_exists(moderatedBy)
        if (unmoderatedOnly) {
          filterExpressions.push("attribute_not_exists(#mb)");
          names["#mb"] = "moderatedBy";
        } else if (sanitizedModeratedBy !== null) {
          if (
            sanitizedModeratedBy === "null" ||
            sanitizedModeratedBy === null
          ) {
            filterExpressions.push("attribute_not_exists(#mb)");
            names["#mb"] = "moderatedBy";
          } else {
            filterExpressions.push("#mb = :mb");
            names["#mb"] = "moderatedBy";
            vals[":mb"] = sanitizedModeratedBy;
          }
        }

        if (hasRejectionHistory === true) {
          filterExpressions.push("attribute_exists(#rh)");
          names["#rh"] = "rejectionHistory";
        }

        // Marshal values once before the loop to avoid repeated marshalling
        const marshaledVals = Scylla.marshalItem(vals);

        // Pagination loop: Select: "COUNT" ensures only count is returned, not item data
        // This is optimal for counting operations, but pagination is still needed for accurate totals
        let iterationCount = 0;
        do {
          iterationCount++;
          if (iterationCount > this.MAX_PAGINATION_ITERATIONS) {
            ErrorHandler.addError(`Pagination limit exceeded: maximum ${this.MAX_PAGINATION_ITERATIONS} iterations allowed`, {
              code: "PAGINATION_LIMIT_EXCEEDED",
              origin: "Moderation.countModerationItemsByStatus",
              data: { 
                status: sanitizedStatus, 
                userId: sanitizedUserId,
                iterationCount,
                totalCount
              }
            });
            throw new Error(`Pagination limit exceeded: maximum ${this.MAX_PAGINATION_ITERATIONS} iterations allowed. This may indicate an extremely large dataset.`);
          }

          const queryOptions = {
            TableName: this.TABLE,
            IndexName: this.GSI_STATUS_DATE,
            KeyConditionExpression: expression.join(" AND "),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: marshaledVals,
            Select: "COUNT",
            ...(lastKey && { ExclusiveStartKey: lastKey }),
          };

          if (filterExpressions.length > 0) {
            queryOptions.FilterExpression = filterExpressions.join(" AND ");
          }

          const result = await this._retryOperation(() =>
            Scylla.request("Query", queryOptions)
          );
          totalCount += (result && result.Count) || 0;
          lastKey = (result && result.LastEvaluatedKey) || null;
        } while (lastKey);
      }

      Logger.debugLog?.(`[Moderation] [countModerationItemsByStatus] [SUCCESS] Counted ${totalCount} moderation items by status: ${status}`);
      return totalCount;
    } catch (error) {
      ErrorHandler.addError(`Failed to count moderation items: ${error.message}`, {
        code: "COUNT_MODERATION_ITEMS_BY_STATUS_FAILED",
        origin: "Moderation.countModerationItemsByStatus",
        data: { status, userId },
      });
      throw new Error(`Failed to count moderation items: ${error.message}`);
    }
  }

  /**
   * Get aggregate counts for all statuses
   * @returns {Promise<Object>} Object with counts for each status
   */
  static async getAllModerationCounts() {
    Logger.debugLog?.(`[Moderation] [getAllModerationCounts] [START] Getting all moderation counts`);
    try {
      const statuses = Object.values(this.STATUS);

      // Count all statuses in parallel
      const countPromises = statuses.map((status) =>
        this.countModerationItemsByStatus(status).then((count) => ({
          status,
          count,
        }))
      );

      // Count pending resubmission (items with action='pending_resubmission')
      // If _countPendingResubmission throws, use 0 so the overall method still returns counts
      const pendingResubmissionPromise = this._countPendingResubmission().catch(() => 0);

      // Count all items
      const allCountPromise = this.countModerationItemsByStatus("all");

      // Count unmoderated (pending items with moderatedBy=null)
      const unmoderatedPromise = this.countModerationItemsByStatus(
        this.STATUS.PENDING,
        { moderatedBy: null }
      );

      const results = await Promise.all([
        ...countPromises,
        pendingResubmissionPromise,
        allCountPromise,
        unmoderatedPromise,
      ]);

      const counts = {};

      // Map status counts
      results.slice(0, statuses.length).forEach(({ status, count }) => {
        counts[status] = count;
      });

      // Add special counts
      counts.pendingResubmission = results[statuses.length]; // pending resubmission count
      counts.all = results[statuses.length + 1]; // all count
      counts.unmoderated = results[statuses.length + 2]; // unmoderated count

      Logger.debugLog?.(`[Moderation] [getAllModerationCounts] [SUCCESS] Retrieved all moderation counts`);
      return counts;
    } catch (error) {
      ErrorHandler.addError(`Failed to get moderation counts: ${error.message}`, {
        code: "GET_ALL_MODERATION_COUNTS_FAILED",
        origin: "Moderation.getAllModerationCounts",
        data: {},
      });
      throw new Error(`Failed to get moderation counts: ${error.message}`);
    }
  }

  /**
   * Count items with pending_resubmission action
   * @private
   */
  static async _countPendingResubmission() {
    Logger.debugLog?.(`[Moderation] [_countPendingResubmission] [START] Counting pending resubmission items`);
    try {
      // Query pending items and filter by action='pending_resubmission'
      let totalCount = 0;
      let lastKey = null;
      let iterationCount = 0;

      // Marshal values once before the loop to avoid repeated marshalling
      const values = {
        ":status": this.STATUS.PENDING,
        ":action": this.ACTION.PENDING_RESUBMISSION,
      };
      const marshaledValues = Scylla.marshalItem(values);
      const names = { "#s": "status", "#a": "action" };

      // Pagination loop: Select: "COUNT" ensures only count is returned, not item data
      // This is optimal for counting operations, but pagination is still needed for accurate totals
      do {
        iterationCount++;
        if (iterationCount > this.MAX_PAGINATION_ITERATIONS) {
          ErrorHandler.addError(`Pagination limit exceeded: maximum ${this.MAX_PAGINATION_ITERATIONS} iterations allowed`, {
            code: "PAGINATION_LIMIT_EXCEEDED",
            origin: "Moderation._countPendingResubmission",
            data: { 
              iterationCount,
              totalCount
            }
          });
          throw new Error(`Pagination limit exceeded: maximum ${this.MAX_PAGINATION_ITERATIONS} iterations allowed. This may indicate an extremely large dataset.`);
        }

        const queryOptions = {
          TableName: this.TABLE,
          IndexName: this.GSI_STATUS_DATE,
          KeyConditionExpression: "#s = :status",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: marshaledValues,
          FilterExpression: "#a = :action",
          Select: "COUNT",
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        };

        const result = await this._retryOperation(() =>
          Scylla.request("Query", queryOptions)
        );
        totalCount += (result && result.Count) || 0;
        lastKey = (result && result.LastEvaluatedKey) || null;
      } while (lastKey);

      Logger.debugLog?.(`[Moderation] [_countPendingResubmission] [SUCCESS] Counted ${totalCount} pending resubmission items`);
      return totalCount;
    } catch (error) {
      ErrorHandler.addError(`Failed to count pending resubmission: ${error.message}`, {
        code: "COUNT_PENDING_RESUBMISSION_FAILED",
        origin: "Moderation._countPendingResubmission",
        data: {},
      });
      // Return 0 on error to not break the aggregate counts
      return 0;
    }
  }
};
