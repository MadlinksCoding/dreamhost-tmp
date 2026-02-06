import crypto from "node:crypto";
import ScyllaDb from "./scylla/scyllaDb.js";
import { ErrorHandler, Logger, SafeUtils, DateTime, ConfigFileLoader } from '../utils/index.js';

// Helper to build ScyllaDB scan options
function buildScanOptions(filters) {
  if (!filters || Object.keys(filters).length === 0) return {};

  const expressions = [];
  const values = {};
  const names = {};

  Object.keys(filters).filter(key => Object.prototype.hasOwnProperty.call(filters, key)).forEach((key, index) => {
    const value = filters[key];
    if (value !== undefined && value !== null && value !== "" && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
      const attrName = `#attr${index}`;
      const attrValue = `:val${index}`;
      expressions.push(`${attrName} = ${attrValue}`);
      names[attrName] = key;
      // Return raw values - scanPaginated will marshal them
      values[attrValue] = value;
    }
  });

  if (expressions.length === 0) return {};

  return {
    FilterExpression: expressions.join(" AND "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

function notifyUser(userId, type, data = {}) {
  Logger.debugLog?.(`[BlockService] [notifyUser] [NOTIFY] User ${userId} -> ${type}: ${JSON.stringify(data)}`);
}

/**
 * Simple in-memory rate limiter for API operations.
 */
class RateLimiter {
  /**
   * Creates a rate limiter instance.
   * @param {number} windowMs - Time window in milliseconds.
   * @param {number} maxRequests - Maximum requests allowed in the window.
   */
  constructor(windowMs = 60000, maxRequests = 10) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.requests = new Map();
  }

  /**
   * Checks if a request is allowed for the given key.
   * @param {string} key - The rate limit key.
   * @returns {boolean} True if allowed, false if rate limited.
   */
  isAllowed(key) {
    const now = Date.now();
    if (!this.requests.has(key)) {
      this.requests.set(key, []);
    }
    const timestamps = this.requests.get(key);
    // Remove old timestamps
    while (timestamps.length > 0 && now - timestamps[0] > this.windowMs) {
      timestamps.shift();
    }
    if (timestamps.length < this.maxRequests) {
      timestamps.push(now);
      return true;
    }
    return false;
  }
}

export class BlockService {
  /**
   * Private-like static method containing suspension configuration data.
   * @returns {Object} The configuration map.
   */
  static _getMisconductRules() {
    return {
      fraud: {
        text: "Your Account is suspended due to potential fraudulent activities",
        action: "Contact Support",
      },
      abuse: {
        text: "Your Account will be suspended due to reported abusive behavior",
        action: "Contact Support",
      },
      violence: {
        text: "Your Account is suspended due to violence",
        action: "Contact Support",
      },
      unacceptable_behavior: {
        text: "Your Account is suspended due to unacceptable behavior",
        action: "Contact Support",
      },
      exploitation: {
        text: "Your Account is suspended due to exploitation - non-consensual media",
        action: "Contact Support",
      },
      hate: {
        text: "Your Account is suspended due to hateful activities",
        action: "Contact Support",
      },
      harassment: {
        text: "Your Account will be suspended due to harassment and criticism",
        action: "Contact Support",
      },
      child_safety: {
        text: "Your Account is suspended due to child safety",
        action: "Contact Support",
      },
      self_injury: {
        text: "Your Account is suspended due to self-injury or harmful behavior",
        action: "Contact Support",
      },
      graphic_violence: {
        text: "Your Account is suspended due to graphic violence or threats",
        action: "Contact Support",
      },
      dangerous_activities: {
        text: "Your Account is suspended due to dangerous activities",
        action: "Contact Support",
      },
      impersonation: {
        text: "Your Account will be suspended due to impersonation",
        action: "Contact Support",
      },
      security: {
        text: "Your Account is suspended due to site security and access",
        action: "Contact Support",
      },
      spam: {
        text: "Your Account will be suspended due to spam detection",
        action: "Contact Support",
      },
    };
  }
  static  SCOPE = ['private_chat','feed','call', 'global', 'app'];
  
  // Business logic constants
  static DEFAULT_TTL_SECONDS = 86400; // 24 hours
  static MAX_TTL_SECONDS = 31536000; // 1 year
  static PAGINATION_LIMIT = 1000; // Default pagination limit for counting operations

  // Rate limiter for critical operations
  static rateLimiter = new RateLimiter(60000, 5); // 5 requests per minute per key

  /**
   * Checks if a block record is active (not deleted, not expired, and permanent or not expired).
   * @param {Object} block - The block record.
   * @returns {boolean} True if the block is active.
   */
  static isActiveBlock(block) {
    if (!block) return false;
    if (block.deleted_at) return false;
    if (block.is_permanent === 1) return true;
    if (block.expires_at !== null && block.expires_at > DateTime.parseDateToTimestamp(DateTime.now()) * 1000) return true;
    return false;
  }

  /**
   * Retrieves the text and slug based on the flag.
   * @param {string} flag - The misconduct flag.
   * @returns {Object | null} The details object or null if not found.
   */
  static getMisconductDetails(flag) {
    Logger.debugLog?.(`[BlockService] [getMisconductDetails] [START] Payload received: ${JSON.stringify({ flag })}`);
    const cleaned = SafeUtils.sanitizeValidate({
      flag: { value: flag, type: "string", required: true },
    });
    const { flag: validatedFlag } = cleaned;

    const rules = this._getMisconductRules();
    const result = rules[validatedFlag] || null;
    Logger.debugLog?.(`[BlockService] [getMisconductDetails] [SUCCESS] Returned details for flag: ${validatedFlag}`);
    return result;
  }

  /**
   * Lists user blocks with optional filtering and pagination.
   * @param {Object} filters - Filter criteria (to, from, scope, is_permanent).
   * @param {number} limit - Maximum number of items to return.
   * @param {string} nextToken - Pagination token for next page.
   * @param {boolean} show_total_count - Whether to include total count.
   * @returns {Object} Object containing items array and optional nextToken/totalCount.
   * @throws {Error} If validation fails.
   */
  static async listUserBlocks(filters = {}, limit = 20, nextToken = null, show_total_count) {
    Logger.debugLog?.(`[BlockService] [listUserBlocks] [START] Payload received: ${JSON.stringify({ filters, limit, nextToken, show_total_count })}`);
    const cleaned = SafeUtils.sanitizeValidate({
      limit: { value: limit, type: "integer", required: false, default: 20, min: 1, max: 1000 },
      nextToken: { value: nextToken, type: "string", required: false, maxLength: 2048 },
      showTotalCount: { value: show_total_count, type: "boolean", required: false, default: false },
      sortBy: { value: filters.sort_by, type: "string", required: false, default: 'created_at', enum: ['created_at', 'updated_at'] },
      sortOrder: { value: filters.sort_order, type: "string", required: false, default: 'desc', enum: ['asc', 'desc', 'ASC', 'DESC'] },
      blockerId: { value: filters.blocker_id, type: "string", required: false, maxLength: 100 },
      blockedId: { value: filters.blocked_id, type: "string", required: false, maxLength: 100 },
      scope: { value: filters.scope, type: "string", required: false, maxLength: 50 },
      isPermanent: { value: filters.is_permanent, type: "boolean", required: false },
      id: { value: filters.id, type: "string", required: false, maxLength: 100 },
      q: { value: filters.q, type: "string", required: false, maxLength: 100 },
      flag: { value: filters.flag, type: "string", required: false, enum: ['unspecified', 'dangerous_activities', 'child_safety', 'hate', 'harassment', 'self_injury', 'spam', 'violence'] },
      expired: { value: filters.expired, type: "boolean", required: false },
      createdFrom: { value: filters.created_from, type: "string", required: false },
      createdTo: { value: filters.created_to, type: "string", required: false }
    });
    const { limit: validatedLimit, nextToken: validatedNextToken, showTotalCount: validatedShowTotalCount, sortBy: validatedSortBy, sortOrder: validatedSortOrder, blockerId: validatedBlockerId, blockedId: validatedBlockedId, scope: validatedScope, isPermanent: validatedIsPermanent, id: validatedId, q: validatedQ, flag: validatedFlag, expired: validatedExpired, createdFrom: validatedCreatedFrom, createdTo: validatedCreatedTo } = cleaned;
    
    // Additional validation for limit
    if (validatedLimit < 1 || validatedLimit > 1000) {
      throw new Error("limit must be between 1 and 1000");
    }
    const validatedFilters = filters || {};

    // Additional validation for nextToken length
    if (validatedNextToken && validatedNextToken.length > 2048) {
      throw new Error("nextToken exceeds maximum length of 2048 characters");
    }

    let results;
    let totalCount;

    try {
      // If id is provided, use GSI query for efficient id lookup
      if (validatedId) {
        const queryParams = {
          TableName: "user_blocks",
          IndexName: "id-index", // Assuming GSI with id as hash key
          KeyConditionExpression: 'id = :id',
          ExpressionAttributeValues: {
            ':id': { S: validatedId }
          }
        };

        // Handle pagination
        if (validatedLimit) {
          queryParams.Limit = validatedLimit;
        }

        if (validatedNextToken) {
          try {
            queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(validatedNextToken, 'base64').toString());
          } catch (err) {
            throw new Error("Invalid nextToken format");
          }
        }

        results = await ScyllaDb.request('Query', queryParams);
        results.items = results.Items || [];
        
        // Convert DynamoDB format to regular objects
        results.items = results.items.map(item => ScyllaDb.unmarshalItem(item));
        
        // Apply additional filters that can't be done at database level
        if (validatedQ) {
          const searchTerm = validatedQ.toLowerCase();
          results.items = results.items.filter(item =>
            item.blocker_id.toLowerCase().includes(searchTerm) ||
            item.blocked_id.toLowerCase().includes(searchTerm)
          );
        }

        if (validatedFlag) {
          results.items = results.items.filter(item => item.flag === validatedFlag);
        }

        if (validatedExpired !== undefined) {
          const now = Date.now();
          if (validatedExpired) {
            // Filter for expired blocks
            results.items = results.items.filter(item =>
              item.expires_at && item.expires_at <= now
            );
          } else {
            // Filter for non-expired blocks
            results.items = results.items.filter(item =>
              !item.expires_at || item.expires_at > now
            );
          }
        }

        if (validatedCreatedFrom) {
          const fromTime = new Date(validatedCreatedFrom).getTime();
          results.items = results.items.filter(item => item.created_at >= fromTime);
        }

        if (validatedCreatedTo) {
          const toTime = new Date(validatedCreatedTo).getTime();
          results.items = results.items.filter(item => item.created_at <= toTime);
        }

        // Handle total count for ID queries
        if (validatedShowTotalCount) {
          totalCount = results.items.length;
        }

        // Override nextToken based on item count
        if (results.items.length === 0 || (validatedLimit && results.items.length < validatedLimit)) {
          results.nextToken = null;
        } else if (results.LastEvaluatedKey) {
          results.nextToken = Buffer.from(JSON.stringify(results.LastEvaluatedKey)).toString('base64');
        }

      // If blocker_id is provided, use query for efficient filtering
      } else if (validatedBlockerId) {
        // Build query parameters
        const queryParams = {
          TableName: "user_blocks",
        };

        const useCreatedAtIndex = validatedSortBy === 'created_at';
        const useUpdatedAtIndex = validatedSortBy === 'updated_at';
        if (useCreatedAtIndex) {
          queryParams.IndexName = 'blocker_id-created_at-index';
        } else if (useUpdatedAtIndex) {
          queryParams.IndexName = 'blocker_id-updated_at-index';
        }

        if (useCreatedAtIndex || useUpdatedAtIndex) {
          queryParams.ScanIndexForward = validatedSortOrder.toLowerCase() === 'asc';
        }

        // Handle pagination
        if (validatedLimit) {
          queryParams.Limit = validatedLimit;
        }

        if (validatedNextToken) {
          try {
            queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(validatedNextToken, 'base64').toString());
          } catch (err) {
            throw new Error("Invalid nextToken format");
          }
        }

        // Build KeyConditionExpression and ExpressionAttributeValues for blocker_id filtering
        let expressionAttributeValues = {};

        queryParams.KeyConditionExpression = 'blocker_id = :blocker_id';
        expressionAttributeValues[':blocker_id'] = { S: validatedBlockerId };

        // Build FilterExpression for additional filters
        let filterParts = [];
        if (validatedBlockedId) {
          filterParts.push('blocked_id = :blocked_id');
          expressionAttributeValues[':blocked_id'] = { S: validatedBlockedId };
        }
        if (validatedScope) {
          filterParts.push('scope = :scope');
          expressionAttributeValues[':scope'] = { S: validatedScope };
        }
        if (validatedIsPermanent !== undefined && validatedIsPermanent !== null) {
          filterParts.push('is_permanent = :is_permanent');
          expressionAttributeValues[':is_permanent'] = { N: validatedIsPermanent.toString() };
        }
        if (validatedFilters.testing !== undefined) {
          filterParts.push('testing = :testing');
          expressionAttributeValues[':testing'] = { BOOL: validatedFilters.testing };
        }
        if (filterParts.length > 0) {
          queryParams.FilterExpression = filterParts.join(' AND ');
        }

        queryParams.ExpressionAttributeValues = expressionAttributeValues;

        // Execute query
        const response = await ScyllaDb.request('Query', queryParams);

        // Unmarshal items
        results = {
          items: (response.Items ?? []).map(item => ScyllaDb.unmarshalItem(item)),
          nextToken: response.LastEvaluatedKey ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString('base64') : null,
          count: response.Count || 0
        };

        // Apply additional filters that can't be done at database level
        if (validatedQ) {
          const searchTerm = validatedQ.toLowerCase();
          results.items = results.items.filter(item =>
            item.blocker_id.toLowerCase().includes(searchTerm) ||
            item.blocked_id.toLowerCase().includes(searchTerm)
          );
        }

        if (validatedFlag) {
          results.items = results.items.filter(item => item.flag === validatedFlag);
        }

        if (validatedExpired !== undefined) {
          const now = Date.now();
          if (validatedExpired) {
            // Filter for expired blocks
            results.items = results.items.filter(item =>
              item.expires_at && item.expires_at <= now
            );
          } else {
            // Filter for non-expired blocks
            results.items = results.items.filter(item =>
              !item.expires_at || item.expires_at > now
            );
          }
        }

        if (validatedCreatedFrom) {
          const fromTime = new Date(validatedCreatedFrom).getTime();
          results.items = results.items.filter(item => item.created_at >= fromTime);
        }

        if (validatedCreatedTo) {
          const toTime = new Date(validatedCreatedTo).getTime();
          results.items = results.items.filter(item => item.created_at <= toTime);
        }

        // Override nextToken based on item count - if fewer items than limit, no more pages
        if (results.items.length === 0 || (validatedLimit && results.items.length < validatedLimit)) {
          results.nextToken = null;
        }

        // Get total count if requested
        if (validatedShowTotalCount) {
          // For total count, we need to do a separate query without limit
          const countQueryParams = { ...queryParams };
          delete countQueryParams.Limit;
          delete countQueryParams.ExclusiveStartKey;

          let count = 0;
          let lastKey = null;
          do {
            if (lastKey) {
              countQueryParams.ExclusiveStartKey = lastKey;
            }
            const countResponse = await ScyllaDb.request('Query', countQueryParams);
            count += countResponse.Count || 0;
            lastKey = countResponse.LastEvaluatedKey;
            // If no items in this page, don't continue
            if ((countResponse.Count || 0) === 0) {
              lastKey = null;
            }
          } while (lastKey);

          totalCount = count;
        }
      } else if (validatedSortBy === 'created_at' || validatedSortBy === 'updated_at') {
        // No blocker_id filter, use global time index for ordering
        const queryParams = {
          TableName: "user_blocks",
          IndexName: validatedSortBy === 'created_at' ? 'global-created_at-index' : 'global-updated_at-index',
          KeyConditionExpression: 'gpk = :gpk',
          ExpressionAttributeValues: {
            ':gpk': { S: 'ALL' }
          },
          ScanIndexForward: validatedSortOrder.toLowerCase() === 'asc'
        };

        if (validatedLimit) {
          queryParams.Limit = validatedLimit;
        }

        if (validatedNextToken) {
          try {
            queryParams.ExclusiveStartKey = JSON.parse(Buffer.from(validatedNextToken, 'base64').toString());
          } catch (err) {
            throw new Error("Invalid nextToken format");
          }
        }

        // Build FilterExpression for additional filters
        const filterParts = [];
        if (validatedBlockedId) {
          filterParts.push('blocked_id = :blocked_id');
          queryParams.ExpressionAttributeValues[':blocked_id'] = { S: validatedBlockedId };
        }
        if (validatedScope) {
          filterParts.push('scope = :scope');
          queryParams.ExpressionAttributeValues[':scope'] = { S: validatedScope };
        }
        if (validatedIsPermanent !== undefined && validatedIsPermanent !== null) {
          filterParts.push('is_permanent = :is_permanent');
          queryParams.ExpressionAttributeValues[':is_permanent'] = { N: validatedIsPermanent.toString() };
        }
        if (validatedFilters.testing !== undefined) {
          filterParts.push('testing = :testing');
          queryParams.ExpressionAttributeValues[':testing'] = { BOOL: validatedFilters.testing };
        }
        if (filterParts.length > 0) {
          queryParams.FilterExpression = filterParts.join(' AND ');
        }

        const response = await ScyllaDb.request('Query', queryParams);

        results = {
          items: (response.Items ?? []).map(item => ScyllaDb.unmarshalItem(item)),
          nextToken: response.LastEvaluatedKey ? Buffer.from(JSON.stringify(response.LastEvaluatedKey)).toString('base64') : null,
          count: response.Count || 0
        };

        // Apply additional filters that can't be done at database level
        if (validatedQ) {
          const searchTerm = validatedQ.toLowerCase();
          results.items = results.items.filter(item =>
            item.blocker_id.toLowerCase().includes(searchTerm) ||
            item.blocked_id.toLowerCase().includes(searchTerm)
          );
        }

        if (validatedFlag) {
          results.items = results.items.filter(item => item.flag === validatedFlag);
        }

        if (validatedExpired !== undefined) {
          const now = Date.now();
          if (validatedExpired) {
            results.items = results.items.filter(item =>
              item.expires_at && item.expires_at <= now
            );
          } else {
            results.items = results.items.filter(item =>
              !item.expires_at || item.expires_at > now
            );
          }
        }

        if (validatedCreatedFrom) {
          const fromTime = new Date(validatedCreatedFrom).getTime();
          results.items = results.items.filter(item => item.created_at >= fromTime);
        }

        if (validatedCreatedTo) {
          const toTime = new Date(validatedCreatedTo).getTime();
          results.items = results.items.filter(item => item.created_at <= toTime);
        }

        if (results.items.length === 0 || (validatedLimit && results.items.length < validatedLimit)) {
          results.nextToken = null;
        }

        if (validatedShowTotalCount) {
          const countQueryParams = { ...queryParams };
          delete countQueryParams.Limit;
          delete countQueryParams.ExclusiveStartKey;

          let count = 0;
          let lastKey = null;
          do {
            if (lastKey) {
              countQueryParams.ExclusiveStartKey = lastKey;
            }
            const countResponse = await ScyllaDb.request('Query', countQueryParams);
            count += countResponse.Count || 0;
            lastKey = countResponse.LastEvaluatedKey;
            if ((countResponse.Count || 0) === 0) {
              lastKey = null;
            }
          } while (lastKey);

          totalCount = count;
        }
      } else {
        // No blocker_id filter, use scan with filters
        const scanFilters = {};
        if (validatedBlockedId) scanFilters.blocked_id = validatedBlockedId;
        if (validatedScope) scanFilters.scope = validatedScope;
        if (validatedIsPermanent !== undefined) scanFilters.is_permanent = validatedIsPermanent;
        if (validatedFilters.testing !== undefined) scanFilters.testing = validatedFilters.testing;

        const scanOptions = buildScanOptions(scanFilters);
        // Always paginate when limit is provided
        scanOptions.Limit = validatedLimit;
        scanOptions.nextToken = validatedNextToken;

        if (validatedShowTotalCount) {
          try {
            // For filtered total count, we need to scan with filters but without pagination
            const countFilters = {};
            if (validatedBlockedId) countFilters.blocked_id = validatedBlockedId;
            if (validatedScope) countFilters.scope = validatedScope;
            if (validatedIsPermanent !== undefined) countFilters.is_permanent = validatedIsPermanent;
            if (validatedFilters.testing !== undefined) countFilters.testing = validatedFilters.testing;

            const countOptions = buildScanOptions(countFilters);
            // Remove pagination options for counting
            delete countOptions.Limit;
            delete countOptions.nextToken;

            let count = 0;
            let countToken = null;
            do {
              const pageOptions = { ...countOptions };
              if (countToken) pageOptions.nextToken = countToken;
              pageOptions.Limit = 100; // Use reasonable page size for counting

              const countResults = await ScyllaDb.scanPaginated("user_blocks", pageOptions);
              count += countResults.items.length;
              countToken = countResults.nextToken;
            } while (countToken);

            totalCount = count;
          } catch (err) {
            ErrorHandler.addError(err.message || 'Error counting filtered user blocks', { error: err });
            throw err;
          }
        }

        results = await ScyllaDb.scanPaginated("user_blocks", scanOptions);
        // Filter out any null items or items missing required fields
        results.items = results.items.filter(item => item != null && item.blocker_id && item.sk_scope);

        // Apply additional filters that can't be done at database level
        if (validatedQ) {
          const searchTerm = validatedQ.toLowerCase();
          results.items = results.items.filter(item =>
            item.blocker_id.toLowerCase().includes(searchTerm) ||
            item.blocked_id.toLowerCase().includes(searchTerm)
          );
        }

        if (validatedFlag) {
          results.items = results.items.filter(item => item.flag === validatedFlag);
        }

        if (validatedExpired !== undefined) {
          const now = Date.now();
          if (validatedExpired) {
            // Filter for expired blocks
            results.items = results.items.filter(item =>
              item.expires_at && item.expires_at <= now
            );
          } else {
            // Filter for non-expired blocks
            results.items = results.items.filter(item =>
              !item.expires_at || item.expires_at > now
            );
          }
        }

        if (validatedCreatedFrom) {
          const fromTime = new Date(validatedCreatedFrom).getTime();
          results.items = results.items.filter(item => item.created_at >= fromTime);
        }

        if (validatedCreatedTo) {
          const toTime = new Date(validatedCreatedTo).getTime();
          results.items = results.items.filter(item => item.created_at <= toTime);
        }

        // Override nextToken based on item count - if fewer items than limit, no more pages
        if (results.items.length === 0 || (validatedLimit && results.items.length < validatedLimit)) {
          results.nextToken = null;
        }
      }

    } catch (err) {
      ErrorHandler.addError(err.message || 'Database query error', { error: err });
      throw err;
    }

    // Apply sorting to all results (default is created_at descending)
    if (results.items.length > 0) {
      const sortField = validatedSortBy;
      const sortDirection = validatedSortOrder.toLowerCase() === 'asc' ? 1 : -1;

      results.items.sort((a, b) => {
        const aValue = parseInt(a[sortField]) || 0;
        const bValue = parseInt(b[sortField]) || 0;
        return (aValue - bValue) * sortDirection;
      });
    }

    // Ensure deleted_at is always present in list responses
    results.items = results.items.map(item => ({
      ...item,
      deleted_at: item.deleted_at ?? null
    }));

    const response = {
      items: results.items,
      count: results.count || results.items.length,
      nextToken: results.nextToken,
    };

    if (totalCount !== undefined) {
      response.totalCount = totalCount;
    }

    Logger.debugLog?.(`[BlockService] [listUserBlocks] [SUCCESS] Returned ${response.items.length} items`);
    return response;
  }

  static async _CountUserBlocks() {
    Logger.debugLog?.(`[BlockService] [_CountUserBlocks] [START] Counting user blocks`);
    let count = 0;
    let token = null;
    do {
      const options = { Limit: this.PAGINATION_LIMIT };
      if (token) options.nextToken = token;
      let result;
    try {
      result = await ScyllaDb.scanPaginated("user_blocks", options);
    } catch (err) {
      ErrorHandler.addError(err.message || 'Database scanPaginated error', { error: err });
      throw err;
    }
      count += result.items.length;
      token = result.nextToken;
    } while (token);
    Logger.debugLog?.(`[BlockService] [_CountUserBlocks] [SUCCESS] Counted ${count} user blocks`);
    return count;
  }

  /**
   * Blocks a user from interacting with another user in a specific scope.
   * @param {string} from - The user ID initiating the block.
   * @param {string} to - The user ID being blocked.
   * @param {string} scope - The scope of the block (e.g., 'private_chat', 'feed').
   * @param {Object} options - Additional options for the block.
   * @param {string} options.reason - Reason for the block.
   * @param {string} options.flag - Flag associated with the block.
   * @param {boolean} options.is_permanent - Whether the block is permanent.
   * @param {number} options.expires_at - Expiration time in seconds from now.
   * @param {boolean} options.testing - Whether this is a test operation.
   * @returns {Object} The created block record.
   * @throws {Error} If validation fails, block already exists, or rate limit exceeded.
   */
  static async blockUser(from, to, scope, options = {}) {
    Logger.debugLog?.(`[BlockService] [blockUser] [START] Payload received: ${JSON.stringify({ from, to, scope, options })}`);
    const cleaned = SafeUtils.sanitizeValidate({
      from: { value: from, type: "string", required: true },
      to: { value: to, type: "string", required: true },
      scope: { value: scope, type: "string", required: true, minLength: 1 },
      options: { value: options, type: "object", required: false, default: {} },
    });
    const { from: validatedFrom, to: validatedTo, scope: validatedScope, options: validatedOptions } = cleaned;

    // Additional validation for optional fields within options
    const optionsCleaned = SafeUtils.sanitizeValidate({
      reason: { value: validatedOptions.reason, type: "string", required: false, default: "unspecified", maxLength: 500 },
      flag: { value: validatedOptions.flag, type: "string", required: false, default: "unspecified", maxLength: 100 },
      is_permanent: { value: validatedOptions.is_permanent, type: "boolean", required: false, default: false },
      expires_at: { value: validatedOptions.expires_at, type: "integer", required: false, min: 1 },
      testing: { value: validatedOptions.testing, type: "boolean", required: false, default: false },
    });
    const { reason: validatedReason, flag: validatedFlag, is_permanent: validatedIsPermanent, expires_at: validatedExpiresAt, testing: validatedTesting } = optionsCleaned;

    if (!this.SCOPE.includes(validatedScope)) {
      throw new Error("Invalid scope");
    }

    // Rate limiting
    if (!this.rateLimiter.isAllowed(`${validatedFrom}:blockUser`)) {
      throw new Error(`Rate limit exceeded for user ${validatedFrom} on blockUser operation`);
    }

    // Prevent self-blocking
    if (validatedFrom === validatedTo) {
      Logger.debugLog?.(`[BlockService] [blockUser] [VALIDATION] Attempted self-block: ${validatedFrom}`);
      throw new Error("Cannot block yourself");
    }

    // Check for existing active block to prevent duplicates
    const existingBlock = await this.isUserBlocked(validatedFrom, validatedTo, validatedScope);
    if (existingBlock) {
      throw new Error(`Block already exists for user ${validatedFrom} blocking ${validatedTo} in scope ${validatedScope}`);
    }

    const now = DateTime.parseDateToTimestamp(DateTime.now()) * 1000;
    const ttl = validatedIsPermanent ? null : validatedExpiresAt ?? this.DEFAULT_TTL_SECONDS;

    // If TTL is 0 or negative, treat as permanent
    const effectiveTtl = ttl && ttl > 0 ? ttl : null;
    Logger.debugLog?.(`[BlockService] [blockUser] [CALC] TTL calculation: isPermanent=${validatedIsPermanent}, expiresAt=${validatedExpiresAt}, ttl=${ttl}, effectiveTtl=${effectiveTtl}`);

    if (effectiveTtl && effectiveTtl > this.MAX_TTL_SECONDS) {
      throw new Error("TTL too large");
    }

    const item = {
      id: crypto.randomUUID(),
      gpk: "ALL",
      blocker_id: validatedFrom,
      blocked_id: validatedTo,
      scope: validatedScope,
      sk_scope: `${validatedScope}::${String(9999999999999 - now).padStart(13, '0')}::${String(9999999999999 - now).padStart(13, '0')}::${validatedTo}`,
      reason: validatedReason,
      flag: validatedFlag,
      is_permanent: validatedIsPermanent ? 1 : 0,
      expires_at: effectiveTtl ? now + effectiveTtl * 1000 : null,
      created_at: now,
      updated_at: now,
      testing: validatedTesting
    };

    // Only include deleted_at if it's not null
    if (false) { // deleted_at is always null for new blocks
      item.deleted_at = null;
    }
    let result;
    try {
      result = await ScyllaDb.putItem("user_blocks", item);
    } catch (err) {
      ErrorHandler.addError(err.message || 'Database putItem error', { error: err });
      throw err;
    }
    notifyUser(validatedTo, "blocked", { scope: validatedScope, reason: item.reason, flag: item.flag });
    Logger.debugLog?.(`[BlockService] [blockUser] [SUCCESS] Blocked user: ${JSON.stringify(item)}`);
    return result;
  }

  /**
   * Removes a block between two users in a specific scope.
   * @param {string} from - The user ID who initiated the block.
   * @param {string} to - The user ID being unblocked.
   * @param {string} scope - The scope of the block to remove.
   * @returns {Object} The result of the unblock operation.
   * @throws {Error} If validation fails or the block doesn't exist.
   */
  static async unblockUser(from, to, scope) {
    Logger.debugLog?.(`[BlockService] [unblockUser] [START] Payload received: ${JSON.stringify({ from, to, scope })}`);
    const cleaned = SafeUtils.sanitizeValidate({
      from: { value: from, type: "string", required: true },
      to: { value: to, type: "string", required: true },
      scope: { value: scope, type: "string", required: true, minLength: 1 },
    });
    const { from: validatedFrom, to: validatedTo, scope: validatedScope } = cleaned;

    if (!this.SCOPE.includes(validatedScope)) {
      throw new Error("Invalid scope");
    }

    let result;
    try {
      // First find the active block to get the correct sk_scope
      const existingBlock = await this.isUserBlocked(validatedFrom, validatedTo, validatedScope);
      if (!existingBlock) {
        throw new Error(`No active block found for user ${validatedFrom} blocking ${validatedTo} in scope ${validatedScope}`);
      }

      const now = DateTime.parseDateToTimestamp(DateTime.now()) * 1000;
      result = await ScyllaDb.updateItem(
        "user_blocks",
        {
          blocker_id: validatedFrom,
          sk_scope: existingBlock.sk_scope,
        },
        {
          deleted_at: now,
          updated_at: now,
        }
      );
    } catch (err) {
      ErrorHandler.addError(err.message || 'Database updateItem error', { error: err });
      throw err;
    }
    notifyUser(validatedTo, "unblocked", { scope: validatedScope });
    Logger.debugLog?.(`[BlockService] [unblockUser] [SUCCESS] Unblocked user`);
    return result;
  }

  /**
   * Checks if a user is blocked by another user in a specific scope.
   * @param {string} from - The user ID who might have blocked.
   * @param {string} to - The user ID who might be blocked.
   * @param {string} scope - The scope to check for blocking.
   * @returns {Object|null} The block record if blocked, null otherwise.
   * @throws {Error} If validation fails.
   */
  static async isUserBlocked(from, to, scope) {
    Logger.debugLog?.(`[BlockService] [isUserBlocked] [START] Payload received: ${JSON.stringify({ from, to, scope })}`);
    const cleaned = SafeUtils.sanitizeValidate({
      from: { value: from, type: "string", required: true },
      to: { value: to, type: "string", required: true },
      scope: { value: scope, type: "string", required: true, minLength: 1 },
    });
    const { from: validatedFrom, to: validatedTo, scope: validatedScope } = cleaned;

    if (!this.SCOPE.includes(validatedScope)) {
      throw new Error("Invalid scope");
    }

    try {
      const params = {
        TableName: "user_blocks",
        KeyConditionExpression: 'blocker_id = :pk',
        ExpressionAttributeValues: {
          ':pk': { S: validatedFrom },
        },
      };

      const result = await ScyllaDb.query("user_blocks", params);
      
      // Filter out deleted items and find the most recent active block
      const activeItems = (result || []).filter(item => !item.deleted_at && item.sk_scope.startsWith(`${validatedScope}::`) && item.blocked_id === validatedTo);
      
      if (activeItems.length === 0) {
        Logger.debugLog?.(`[BlockService] [isUserBlocked] [RESULT] No active blocks found`);
        Logger.debugLog?.(`[BlockService] [isUserBlocked] [SUCCESS] Checked block status: blocked=false`);
        return null;
      }

      // Since items are sorted by sk_scope (which includes inverted timestamps), the first one is the most recent
      const item = activeItems[0];
      Logger.debugLog?.(`[BlockService] [isUserBlocked] [RESULT] Active block found: ${JSON.stringify(item)}`);
      Logger.debugLog?.(`[BlockService] [isUserBlocked] [SUCCESS] Checked block status: blocked=true`);
      return item;
    } catch (err) {
      ErrorHandler.addError(err.message || 'Database query error', { error: err });
      throw err;
    }
  }

  /**
   * Retrieves all block-related data for a user from multiple tables.
   *
   * @async
   * @param {string} to - The ID of the user to get blocks for.
   * @param {boolean} [show_deleted=false] - Whether to include soft-deleted records. Defaults to false (active records only).
   * @returns {Promise<Object>} A promise that resolves to an object containing user_blocks, system_blocks, and manual_actions arrays.
   */
  static async GetBlocksForUser(to, show_deleted = false) {
    Logger.debugLog?.(`[BlockService] [GetBlocksForUser] [START] Payload received: ${JSON.stringify({ to, show_deleted })}`);
    const cleaned = SafeUtils.sanitizeValidate({
      to: { value: to, type: "string", required: true },
      showDeleted: { value: show_deleted, type: "boolean", required: false, default: false },
    });
    const { to: validatedTo, showDeleted: validatedShowDeleted } = cleaned;

    const userBlocksOptions = {
      IndexName: "blocked_id-scope-index",
      KeyConditionExpression: "blocked_id = :bid",
      ExpressionAttributeValues: { ":bid": validatedTo },
    };
    if (!validatedShowDeleted) {
      userBlocksOptions.FilterExpression = "deleted_at = :del";
      userBlocksOptions.ExpressionAttributeValues[":del"] = null;
    }
    const systemBlocksOptions = {
      KeyConditionExpression: "identifier = :id",
      ExpressionAttributeValues: { ":id": validatedTo },
    };
    const manualActionsOptions = {
      KeyConditionExpression: "user_id = :uid",
      ExpressionAttributeValues: { ":uid": validatedTo },
    };

    const [user_blocks, system_blocks, manual_actions] = await Promise.all([
      ScyllaDb.query("user_blocks", userBlocksOptions).catch(err => { ErrorHandler.addError(err); throw err; }),
      ScyllaDb.query("system_blocks", systemBlocksOptions).catch(err => { ErrorHandler.addError(err); throw err; }),
      ScyllaDb.query("manual_actions", manualActionsOptions).catch(err => { ErrorHandler.addError(err); throw err; }),
    ]);

    const response = {
      count: user_blocks.length + system_blocks.length + manual_actions.length,
      blocks: {
        user_blocks,
        system_blocks,
        manual_actions,
      },
    };
    Logger.debugLog?.(`[BlockService] [GetBlocksForUser] [SUCCESS] Retrieved ${response.count} blocks for user ${validatedTo}`);
    return response;
  } 
  /**
   * Get user activity stats: all blocks, points per block, and total risk score
   * Uses GetBlocksForUser to aggregate all block types.
   * @param {string} userId - The user to check
   * @returns {Promise<{blocks: Array, blockScores: Array, totalScore: number, threshold: number, flagged: boolean}>}
   */
  static async getUserActivityStats(userId) {
    Logger.debugLog?.(`[BlockService] [getUserActivityStats] [START] Payload received: ${JSON.stringify({ userId })}`);
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: userId, type: "string", required: true },
    });
    const { userId: validatedUserId } = cleaned;

    const config = ConfigFileLoader.loadConfig("./configs/riskScoreConfig.json");
    if (!config) {
      throw new Error("Failed to load risk score configuration");
    }
    const { blocks } = await this.GetBlocksForUser(validatedUserId, true);
    const now = DateTime.now();
    // Grouped summary
    let summary = {
      userBlocks: {
        private_chat: { active: 0, expired: 0 },
        call: { active: 0, expired: 0 },
        purchase: { active: 0, expired: 0 },
        feed: { active: 0, expired: 0 },
        global: { active: 0, expired: 0 }
      },
      systemBlocks: { app: { active: 0, expired: 0 } },
      manualActions: { warning: { active: 0, expired: 0 }, suspension: { active: 0, expired: 0 } }
    };
    // User blocks
    for (const block of blocks.user_blocks || []) {
      const expired = block.deleted_at || (block.expires_at !== null && block.expires_at < now);
      const scope = block.scope;
      if (config.userBlock?.[scope] && summary.userBlocks[scope]) {
        if (expired) {
          summary.userBlocks[scope].expired += config.userBlock[scope].expired || 0;
        } else {
          summary.userBlocks[scope].active += config.userBlock[scope].active || 0;
        }
      }
    }
    // System blocks (only app type)
    for (const block of blocks.system_blocks || []) {
      if (block.sk_type === 'app') {
        const expired = block.deleted_at || (block.expires_at !== null && block.expires_at < now);
        if (expired) {
          summary.systemBlocks.app.expired += config.systemBlock?.app?.expired || 0;
        } else {
          summary.systemBlocks.app.active += config.systemBlock?.app?.active || 0;
        }
      }
    }
    // Manual actions
    for (const block of blocks.manual_actions || []) {
      const expired = block.deleted_at || (block.expires_at !== null && block.expires_at < now);
      if (block.type === 'warning') {
        if (expired) {
          summary.manualActions.warning.expired += config.manualAction?.warning?.expired || 0;
        } else {
          summary.manualActions.warning.active += config.manualAction?.warning?.active || 0;
        }
      } else if (block.type === 'suspend' || block.type === 'suspension') {
        if (expired) {
          summary.manualActions.suspension.expired += config.manualAction?.suspension?.expired || 0;
        } else {
          summary.manualActions.suspension.active += config.manualAction?.suspension?.active || 0;
        }
      }
    }
    // Calculate total
    const totalScore = [
      ...Object.values(summary.userBlocks).flatMap(obj => [obj.active, obj.expired]),
      ...Object.values(summary.systemBlocks).flatMap(obj => [obj.active, obj.expired]),
      ...Object.values(summary.manualActions).flatMap(obj => [obj.active, obj.expired])
    ].reduce((sum, v) => sum + v, 0);
    const threshold = config.threshold || 500;
    const flagged = totalScore >= threshold;
    const response = { blockScores: summary, totalScore, threshold, flagged };
    Logger.debugLog?.(`[BlockService] [getUserActivityStats] [SUCCESS] Calculated stats for user ${validatedUserId}: totalScore ${totalScore}, flagged ${flagged}`);
    return response;
  }

  /**
   * Checks multiple user block relationships in batches to prevent DB overload.
   * @param {Array} blocks - Array of block objects with from, to, scope properties.
   * @returns {Array} Array of results with blocked status for each pair.
   * @throws {Error} If validation fails.
   */
  static async batchCheckUserBlocks(blocks = []) {
    Logger.debugLog?.(`[BlockService] [batchCheckUserBlocks] [START] Payload received: ${JSON.stringify({ blocks })}`);
    const cleaned = SafeUtils.sanitizeValidate({
      blocks: { value: blocks, type: "array", required: false, default: [] },
    });
    const { blocks: validatedBlocks } = cleaned;

    const concurrencyLimit = 10; // Limit concurrent DB operations
    const results = [];
    for (let i = 0; i < validatedBlocks.length; i += concurrencyLimit) {
      const chunk = validatedBlocks.slice(i, i + concurrencyLimit);
      const chunkResults = await Promise.all(
        chunk.map(async ({ from, to, scope }) => {
          const result = await this.isUserBlocked(from, to, scope);
          return !!result;
        })
      );
      results.push(...chunkResults);
    }

    const response = results.map((res, i) => ({
      ...validatedBlocks[i],
      blocked: res,
    }));
    Logger.debugLog?.(`[BlockService] [batchCheckUserBlocks] [SUCCESS] Checked ${response.length} blocks`);
    return response;
  }

  static async listSystemBlocks(filters = {}, limit = 20, nextToken = null) {
    Logger.debugLog?.(`[BlockService] [listSystemBlocks] [START] Payload received: ${JSON.stringify({ filters, limit, nextToken })}`);
    const cleaned = SafeUtils.sanitizeValidate({
      filters: { value: filters, type: "object", required: false, default: {} },
      limit: { value: limit, type: "integer", required: false, default: 20 },
      nextToken: { value: nextToken, type: "string", required: false, maxLength: 2048 },
    });
    const { filters: validatedFilters, limit: validatedLimit, nextToken: validatedNextToken } = cleaned;

    // Additional validation for nextToken length
    if (validatedNextToken && validatedNextToken.length > 2048) {
      throw new Error("nextToken exceeds maximum length of 2048 characters");
    }

    // Strip meta fields from filters
    const { show_total_count, ...scanFilters } = validatedFilters;

    const options = buildScanOptions(scanFilters);
    options.Limit = validatedLimit;
    options.nextToken = validatedNextToken;
    let totalCount;
    if (show_total_count) {
      // For filtered total count, scan with filters but without pagination
      const countOptions = buildScanOptions(scanFilters);
      let count = 0;
      let countToken = null;
      do {
        const pageOptions = { ...countOptions };
        if (countToken) pageOptions.nextToken = countToken;
        pageOptions.Limit = this.PAGINATION_LIMIT;
        
        const countResults = await ScyllaDb.scanPaginated("system_blocks", pageOptions);
        count += countResults.items.length;
        countToken = countResults.nextToken;
      } while (countToken);
      
      totalCount = count;
    }
    const results = await ScyllaDb.scanPaginated("system_blocks", options);
    let { items = [], nextToken: token, ...rest } = results;
    // sort items by created_at descending (newest first)
    const response = { 
      items, 
      count: items.length,
      ...rest 
    };
    if (totalCount !== undefined) response.totalCount = totalCount;
    if (items.length > 0 && token) response.nextToken = token;
    Logger.debugLog?.(`[BlockService] [listSystemBlocks] [SUCCESS] Returned ${response.items.length} system blocks`);
    return response;
  }

  static async _CountSystemBlocks() {
    Logger.debugLog?.(`[BlockService] [_CountSystemBlocks] [START] Counting system blocks`);
    let count = 0;
    let token = null;
    do {
      const options = { Limit: this.PAGINATION_LIMIT };
      if (token) options.nextToken = token;
      let result;
      try {
        result = await ScyllaDb.scanPaginated("system_blocks", options);
      } catch (err) {
        ErrorHandler.addError(err);
        throw err;
      }
      count += result.items.length;
      token = result.nextToken;
    } while (token);
    Logger.debugLog?.(`[BlockService] [_CountSystemBlocks] [SUCCESS] Counted ${count} system blocks`);
    return count;
  }
  

  
  static async blockIP(
    ip,
    reason = "unspecified",
    is_permanent = true,
    expires_at,
    options
  ) {
    Logger.debugLog?.(`[BlockService] [blockIP] [START] Payload received: ${JSON.stringify({ ip, reason, is_permanent, expires_at, options })}`);
    const validationObj = {
      ip: { value: ip, type: "string", required: true },
      reason: { value: reason, type: "string", required: false, default: "unspecified", maxLength: 500 },
      isPermanent: { value: is_permanent, type: "boolean", required: false, default: true },
      options: { value: options, type: "object", required: false },
    };
    
    // Only validate expiresAt if it's provided
    if (expires_at !== null && expires_at !== undefined) {
      validationObj.expiresAt = { value: expires_at, type: "integer", required: false };
    }
    
    const cleaned = SafeUtils.sanitizeValidate(validationObj);
    const { ip: validatedIp, reason: validatedReason, isPermanent: validatedIsPermanent, expiresAt: validatedExpiresAt, options: validatedOptions } = cleaned;

    if (!validatedIsPermanent && !validatedExpiresAt) {
      throw new Error("expires_at is required for non-permanent blocks");
    }

    const now = DateTime.parseDateToTimestamp(DateTime.now()) * 1000;
    const item = {
      id: crypto.randomUUID(),
      identifier: validatedIp,
      type: "ip",
      sk_type: `ip::${String(9999999999999 - now).padStart(13, '0')}::${String(9999999999999 - now).padStart(13, '0')}`,
      scope: "auth",
      reason: validatedReason,
      is_permanent: validatedIsPermanent ? 1 : 0,
      expires_at: validatedExpiresAt,
      testing: validatedOptions?.testing || false,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    try {
      await ScyllaDb.putItem("system_blocks", item);
    } catch (err) {
      ErrorHandler.addError(err);
      throw err;
    }
    Logger.debugLog?.(`[BlockService] [blockIP] [SUCCESS] Blocked IP: ${validatedIp}`);
  }

  // Source of truth: SELECT * FROM system_blocks WHERE identifier=? AND type=\'ip\'
  static async isIPBlocked(ip) {
    Logger.debugLog?.(`[BlockService] [isIPBlocked] [START] Payload received: ${JSON.stringify({ ip })}`);
    const cleaned = SafeUtils.sanitizeValidate({
      ip: { value: ip, type: "string", required: true },
    });
    const { ip: validatedIp } = cleaned;

    let dboutput;
    try {
      const results = await ScyllaDb.scan("system_blocks", {
        FilterExpression: "identifier = :id AND begins_with(sk_type, :type)",
        ExpressionAttributeValues: {
          ":id": validatedIp,
          ":type": "ip"
        },
      });
      dboutput = results.length > 0 ? results[0] : null;
    } catch (err) {
      ErrorHandler.addError(err);
      throw err;
    }
    const active = this.isActiveBlock(dboutput);
    const response = { db: active ? dboutput : null };
    Logger.debugLog?.(`[BlockService] [isIPBlocked] [SUCCESS] Checked IP block for: ${validatedIp}, active: ${active}`);
    return response;
  }

  static async blockEmail(email, reason = "unspecified", permanent = true, expires_at, options) {
    const validationObj = {
      email: { value: email, type: "string", required: true, minLength: 1 },
      reason: { value: reason, type: "string", required: true, maxLength: 500 },
      permanent: { value: permanent, type: "boolean", required: false, default: true },
    };
    
    // Only validate expiresAt if it's provided
    if (expires_at !== null && expires_at !== undefined) {
      validationObj.expiresAt = { value: expires_at, type: "integer", required: false };
    }
    
    const validated = SafeUtils.sanitizeValidate(validationObj);
    const validatedEmail = validated.email;
    const validatedReason = validated.reason;
    const validatedPermanent = validated.permanent;
    const validatedExpiresAt = validated.expiresAt;

    if (!validatedPermanent && !validatedExpiresAt) {
      throw new Error("expires_at is required for non-permanent blocks");
    }

    Logger.debugLog?.(`[BlockService] [blockEmail] [START] Blocking email: ${validatedEmail}, reason: ${validatedReason}, permanent: ${validatedPermanent}`);

    const now = DateTime.parseDateToTimestamp(DateTime.now()) * 1000;
    const item = {
      id: crypto.randomUUID(),
      identifier: crypto.createHash("sha256").update(validatedEmail.toLowerCase().trim() + (process.env.HASH_SALT || "default_salt")).digest("hex"),
      type: "email",
      sk_type: `email::${String(9999999999999 - now).padStart(13, '0')}::${String(9999999999999 - now).padStart(13, '0')}`,
      scope: "auth",
      reason: validatedReason,
      is_permanent: validatedPermanent ? 1 : 0,
      expires_at: validatedExpiresAt,
      testing: options?.testing || false,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    await ScyllaDb.putItem("system_blocks", item);

    Logger.debugLog?.(`[BlockService] [blockEmail] [SUCCESS] Email blocked successfully`);
  }

  // Source of truth: SELECT * FROM system_blocks WHERE identifier=HASH(email) AND type=\'email\'
  static async isEmailBlocked(email) {
    const validated = SafeUtils.sanitizeValidate({
      email: { value: email, type: "string", required: true, minLength: 1 },
    });
    const validatedEmail = validated.email;

    Logger.debugLog?.(`[BlockService] [isEmailBlocked] [START] Checking if email is blocked: ${validatedEmail}`);

    let dboutput;
    try {
      const results = await ScyllaDb.scan("system_blocks", {
        FilterExpression: "identifier = :id AND begins_with(sk_type, :type)",
        ExpressionAttributeValues: {
          ":id": crypto.createHash("sha256").update(validatedEmail.toLowerCase().trim() + (process.env.HASH_SALT || "default_salt")).digest("hex"),
          ":type": "email"
        },
      });
      dboutput = results.length > 0 ? results[0] : null;
    } catch (err) {
      ErrorHandler.addError(err);
      throw err;
    }

    const active = this.isActiveBlock(dboutput);
    Logger.debugLog?.(`[BlockService] [isEmailBlocked] [SUCCESS] Email block check completed, active: ${active}`);

    return { db: active ? dboutput : null };
  }

  static async blockAppAccess(
    userId,
    scope,
    reason = "unspecified",
    is_permanent = true,
    expires_at,
    options
  ) {
    const validationObj = {
      userId: { value: userId, type: "string", required: true, minLength: 1 },
      scope: { value: scope, type: "string", required: true, minLength: 1 },
      reason: { value: reason, type: "string", required: true, maxLength: 500 },
      is_permanent: { value: is_permanent, type: "boolean", required: false, default: true },
    };
    
    // Only validate expires_at if it's provided
    if (expires_at !== null && expires_at !== undefined) {
      validationObj.expires_at = { value: expires_at, type: "integer", required: false };
    }
    
    const validated = SafeUtils.sanitizeValidate(validationObj);
    const validatedUserId = validated.userId;
    const validatedScope = validated.scope;
    const validatedReason = validated.reason;
    const validatedIsPermanent = validated.is_permanent;
    const validatedExpiresAt = validated.expires_at;

    if (!validatedIsPermanent && !validatedExpiresAt) {
      throw new Error("expires_at is required for non-permanent blocks");
    }

    if (!this.SCOPE.includes(validatedScope)) {
      throw new Error("Invalid scope");
    }

    Logger.debugLog?.(`[BlockService] [blockAppAccess] [START] Blocking app access for user: ${validatedUserId}, scope: ${validatedScope}, reason: ${validatedReason}, permanent: ${validatedIsPermanent}`);

    const now = DateTime.parseDateToTimestamp(DateTime.now()) * 1000;
    const item = {
      id: crypto.randomUUID(),
      identifier: validatedUserId,
      type: "app",
      sk_type: `app::${String(9999999999999 - now).padStart(13, '0')}::${String(9999999999999 - now).padStart(13, '0')}`,
      scope: validatedScope,
      reason: validatedReason,
      is_permanent: validatedIsPermanent ? 1 : 0,
      expires_at: expires_at,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      testing: options?.testing || false,
    };
    await ScyllaDb.putItem("system_blocks", item);

    Logger.debugLog?.(`[BlockService] [blockAppAccess] [SUCCESS] App access blocked successfully`);
  }

  // Source of truth: SELECT * FROM system_blocks WHERE identifier=? AND type=\'app\' AND scope=?
  static async isAppAccessBlocked(userId, scope) {
    const validated = SafeUtils.sanitizeValidate({
      userId: { value: userId, type: "string", required: true, minLength: 1 },
      scope: { value: scope, type: "string", required: true, minLength: 1 },
    });
    const validatedUserId = validated.userId;
    const validatedScope = validated.scope;

    if (!this.SCOPE.includes(validatedScope)) {
      throw new Error("Invalid scope");
    }

    Logger.debugLog?.(`[BlockService] [isAppAccessBlocked] [START] Checking if app access is blocked for user: ${validatedUserId}, scope: ${validatedScope}`);

    let dboutput;
    try {
      const results = await ScyllaDb.scan("system_blocks", {
        FilterExpression: "identifier = :id AND begins_with(sk_type, :type) AND #scope = :scope",
        ExpressionAttributeNames: { "#scope": "scope" },
        ExpressionAttributeValues: {
          ":id": validatedUserId,
          ":type": "app", 
          ":scope": validatedScope
        },
      });
      dboutput = results.length > 0 ? results[0] : null;
    } catch (err) {
      ErrorHandler.addError(err);
      throw err;
    }

    const active = this.isActiveBlock(dboutput);
    Logger.debugLog?.(`[BlockService] [isAppAccessBlocked] [SUCCESS] App access block check completed, active: ${active}`);

    return { db: active ? dboutput : null };
  }

  static async listManualActions(filters = {}, limit = 20, nextToken = null) {
    const validated = SafeUtils.sanitizeValidate({
      filters: { value: filters, type: "object", required: false },
      limit: { value: limit, type: "number", required: true, min: 1 },
      nextToken: { value: nextToken, type: "string", required: false, maxLength: 2048 },
    });
    const validatedFilters = validated.filters || {};
    const validatedLimit = validated.limit;
    const validatedNextToken = validated.nextToken;

    // Additional validation for nextToken length
    if (validatedNextToken && validatedNextToken.length > 2048) {
      throw new Error("nextToken exceeds maximum length of 2048 characters");
    }

    // Strip meta fields from filters
    const { show_total_count, ...scanFilters } = validatedFilters;

    Logger.debugLog?.(`[BlockService] [listManualActions] [START] Listing manual actions with filters: ${JSON.stringify(scanFilters)}, limit: ${validatedLimit}, nextToken: ${validatedNextToken}`);

    const options = buildScanOptions(scanFilters);
    options.Limit = validatedLimit;
    options.nextToken = validatedNextToken;
    let totalCount;
    if (show_total_count) {
      // Count filtered items for totalCount
      const countOptions = buildScanOptions(scanFilters);
      countOptions.Limit = this.PAGINATION_LIMIT;
      let count = 0;
      let countToken = null;
      do {
        if (countToken) countOptions.nextToken = countToken;
        const countResult = await ScyllaDb.scanPaginated("manual_actions", countOptions);
        count += countResult.items.length;
        countToken = countResult.nextToken;
      } while (countToken);
      totalCount = count;
    }
    const results = await ScyllaDb.scanPaginated("manual_actions", options);
    let { items = [], nextToken: token, ...rest } = results;
    // sort items by created_at descending (newest first)
    const response = { items, count: items.length, ...rest };
    if (totalCount !== undefined) response.totalCount = totalCount;
    if (items.length > 0 && token) response.nextToken = token;

    Logger.debugLog?.(`[BlockService] [listManualActions] [SUCCESS] Manual actions listed successfully`);

    return response;
  }
  
  static async _CountManualActions() {
    Logger.debugLog?.(`[BlockService] [_CountManualActions] [START] Counting manual actions`);
    let count = 0;
    let token = null;
    do {
      const options = { Limit: this.PAGINATION_LIMIT };
      if (token) options.nextToken = token;
      let result;
      try {
        result = await ScyllaDb.scanPaginated("manual_actions", options);
      } catch (err) {
        ErrorHandler.addError(err.message || 'Database scanPaginated error', { error: err });
        throw err;
      }
      count += result.items.length;
      token = result.nextToken;
    } while (token);
    Logger.debugLog?.(`[BlockService] [_CountManualActions] [SUCCESS] Counted ${count} manual actions`);
    return count;
  }

  /**
   * Suspends a user account with a given reason.
   * @param {string} userId - The user ID to suspend.
   * @param {string} reason - The reason for suspension.
   * @param {string} adminId - The admin ID performing the suspension.
   * @param {string} flag - Optional misconduct flag.
   * @param {string} note - Optional internal note.
   * @param {Object} options - Additional options.
   * @throws {Error} If validation fails or rate limit exceeded.
   */
  static async suspendUser(userId, reason, adminId, flag = null, note = "", options) {
    const validated = SafeUtils.sanitizeValidate({
      userId: { value: userId, type: "string", required: true, minLength: 1 },
      reason: { value: reason, type: "string", required: true },
      adminId: { value: adminId, type: "string", required: true, minLength: 1 },
      flag: { value: flag, type: "string", required: false, maxLength: 100 },
      note: { value: note, type: "string", required: false },
    });
    const validatedUserId = validated.userId;
    const validatedReason = validated.reason;
    const validatedAdminId = validated.adminId;
    const validatedFlag = validated.flag;
    const validatedNote = validated.note;

    // Rate limiting
    if (!this.rateLimiter.isAllowed(`${validatedAdminId}:suspendUser`)) {
      throw new Error(`Rate limit exceeded for admin ${validatedAdminId} on suspendUser operation`);
    }

    Logger.debugLog?.(`[BlockService] [suspendUser] [START] Suspending user: ${validatedUserId}, reason: ${validatedReason}, admin: ${validatedAdminId}`);

    const now = DateTime.now();
    const timestamp = DateTime.parseDateToTimestamp(now) * 1000;
    const item = {
      id: crypto.randomUUID(),
      user_id: validatedUserId,
      type: "suspend",
      reason: validatedReason,
      flag: validatedFlag,
      internal_note: validatedNote,
      admin_id: validatedAdminId,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
      sk_ts: now,
      is_permanent: 1,
      testing: options?.testing || false,
    };
    await ScyllaDb.putItem("manual_actions", item);
    notifyUser(validatedUserId, "suspended", { reason: validatedReason, flag: validatedFlag });

    Logger.debugLog?.(`[BlockService] [suspendUser] [SUCCESS] User suspended successfully`);
  }

  // Source of truth: SELECT * FROM manual_actions WHERE user_id=? AND type='suspend'
  static async isUserSuspended(userId) {
    const validated = SafeUtils.sanitizeValidate({
      userId: { value: userId, type: "string", required: true, minLength: 1 },
    });
    const validatedUserId = validated.userId;

    Logger.debugLog?.(`[BlockService] [isUserSuspended] [START] Checking if user is suspended: ${validatedUserId}`);

    // Query for suspend actions - scan with filter since type is not a key attribute
    const suspensions = await ScyllaDb.scan("manual_actions", {
      FilterExpression: "user_id = :uid AND #type = :type",
      ExpressionAttributeNames: { "#type": "type" },
      ExpressionAttributeValues: {
        ":uid": validatedUserId,
        ":type": "suspend",
      },
    });
    // Sort by timestamp descending to get most recent
    suspensions.sort((a, b) => (DateTime.parseDateToTimestamp(b.sk_ts) || 0) - (DateTime.parseDateToTimestamp(a.sk_ts) || 0));
    const mostRecent = suspensions[0];
    const active = mostRecent && this.isActiveBlock(mostRecent);

    Logger.debugLog?.(`[BlockService] [isUserSuspended] [SUCCESS] User suspension check completed, active: ${active}`);

    return { db: active ? mostRecent : null };
  }

  static async unsuspendUser(userId) {
    const validated = SafeUtils.sanitizeValidate({
      userId: { value: userId, type: "string", required: true, minLength: 1 },
    });
    const validatedUserId = validated.userId;

    Logger.debugLog?.(`[BlockService] [unsuspendUser] [START] Unsuspending user: ${validatedUserId}`);

    // Find active suspensions
    const actions = await ScyllaDb.query("manual_actions", "user_id = :uid", {
      ":uid": validatedUserId,
    });
    const suspendActions = actions.filter((a) => a.type === "suspend");

    // Delete all suspend actions
    for (const action of suspendActions) {
      if (action.sk_ts) {
        await ScyllaDb.deleteItem("manual_actions", {
          user_id: validatedUserId,
          sk_ts: action.sk_ts,
        });
      }
    }

    notifyUser(validatedUserId, "unsuspended");

    Logger.debugLog?.(`[BlockService] [unsuspendUser] [SUCCESS] User unsuspended successfully`);
  }

  /**
   * Issues a warning to a user for misconduct.
   * @param {string} userId - The user ID to warn.
   * @param {string} flag - The misconduct flag (e.g., 'spam').
   * @param {string} adminId - The admin ID issuing the warning.
   * @param {string} note - Optional internal note.
   * @param {Object} options - Additional options.
   * @throws {Error} If validation fails or rate limit exceeded.
   */
  static async warnUser(userId, flag, adminId, note = "", options) {
    const validated = SafeUtils.sanitizeValidate({
      userId: { value: userId, type: "string", required: true, minLength: 1 },
      flag: { value: flag, type: "string", required: true, minLength: 1, maxLength: 100 },
      adminId: { value: adminId, type: "string", required: true, minLength: 1 },
      note: { value: note, type: "string", required: false },
    });
    const validatedUserId = validated.userId;
    const validatedFlag = validated.flag;
    const validatedAdminId = validated.adminId;
    const validatedNote = validated.note;

    // Rate limiting
    if (!this.rateLimiter.isAllowed(`${validatedAdminId}:warnUser`)) {
      throw new Error(`Rate limit exceeded for admin ${validatedAdminId} on warnUser operation`);
    }

    Logger.debugLog?.(`[BlockService] [warnUser] [START] Warning user: ${validatedUserId}, flag: ${validatedFlag}, admin: ${validatedAdminId}`);

    const details = this.getMisconductDetails(validatedFlag);
    if (!details) {
      Logger.debugLog?.(`[BlockService] [warnUser] [VALIDATION] Invalid flag provided: ${validatedFlag}`);
      ErrorHandler.addError?.(`Invalid flag: ${validatedFlag}`);
      throw new Error("Invalid flag");
    }
    Logger.debugLog?.(`[BlockService] [warnUser] [DETAILS] Retrieved misconduct details: ${JSON.stringify(details)}`);

    const now = DateTime.now();
    const timestamp = DateTime.parseDateToTimestamp(now) * 1000;
    const item = {
      id: crypto.randomUUID(),
      user_id: validatedUserId,
      type: "warning",
      flag: validatedFlag,
      reason: details.text, // Use the detailed text as the reason
      internal_note: validatedNote,
      admin_id: validatedAdminId,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
      sk_ts: now,
      testing: options?.testing || false,
    };
    await ScyllaDb.putItem("manual_actions", item);
    notifyUser(validatedUserId, "warned", {
      reason: item.reason,
      flag: validatedFlag,
      action: details.action,
      slug: details.slug,
    });

    Logger.debugLog?.(`[BlockService] [warnUser] [SUCCESS] User warned successfully`);
  }

  static async getUserManualActions(userId) {
    const validated = SafeUtils.sanitizeValidate({
      userId: { value: userId, type: "string", required: true, minLength: 1 },
    });
    const validatedUserId = validated.userId;

    Logger.debugLog?.(`[BlockService] [getUserManualActions] [START] Getting manual actions for user: ${validatedUserId}`);

    const result = await ScyllaDb.query("manual_actions", "user_id = :uid", {
      ":uid": validatedUserId,
    });

    Logger.debugLog?.(`[BlockService] [getUserManualActions] [SUCCESS] Manual actions retrieved`);

    return result;
  }

  static async getSuspensionDetails(userId) {
    const validated = SafeUtils.sanitizeValidate({
      userId: { value: userId, type: "string", required: true, minLength: 1 },
    });
    const validatedUserId = validated.userId;

    Logger.debugLog?.(`[BlockService] [getSuspensionDetails] [START] Getting suspension details for user: ${validatedUserId}`);

    const actions = await ScyllaDb.query("manual_actions", "user_id = :uid", {
      ":uid": validatedUserId,
    });
    // Sort by created_at descending to get the latest
    const sorted = actions.sort((a, b) => b.created_at - a.created_at);
    const activeSuspension = sorted.find((a) => a.type === "suspend" && this.isActiveBlock(a));

    if (!activeSuspension) {
      Logger.debugLog?.(`[BlockService] [getSuspensionDetails] [SUCCESS] No active suspension found`);
      return null;
    }

    // Enrich with misconduct details if available
    let misconductDetails = {};
    if (activeSuspension.flag) {
      const details = this.getMisconductDetails(activeSuspension.flag);
      if (details) {
        misconductDetails = {
          text: details.text,
          action: details.action,
          slug: details.slug,
        };
      }
    }

    Logger.debugLog?.(`[BlockService] [getSuspensionDetails] [SUCCESS] Suspension details retrieved`);

    return {
      reason: activeSuspension.reason,
      flag: activeSuspension.flag,
      created_at: activeSuspension.created_at,
      admin_id: activeSuspension.admin_id,
      ...misconductDetails,
    };
  }
  static async clearTestData() {
    Logger.debugLog?.(`[BlockService] [clearTestData] [START] Clearing test data from ScyllaDB`);

    const tables = ["user_blocks", "system_blocks", "manual_actions"];

    // Helper function to scan with retries for eventual consistency
    const scanWithRetry = async (table, scanOptions, maxRetries = 5) => {
      // Initial delay to allow for eventual consistency
      await new Promise(resolve => setTimeout(resolve, 2000));
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          let allItems = [];
          let token = null;
          do {
            const result = await ScyllaDb.scanPaginated(table, { ...scanOptions, nextToken: token, Limit: 100 });
            allItems.push(...result.items);
            token = result.nextToken;
          } while (token);
          return allItems;
        } catch (err) {
          if (attempt === maxRetries) throw err;
          Logger.debugLog?.(`[BlockService] [clearTestData] [RETRY] Scan attempt ${attempt} failed, retrying...`);
          await new Promise(resolve => setTimeout(resolve, 300 * attempt)); // Increased exponential backoff
        }
      }
    };

    for (const table of tables) {
      try {
        // Scan for items with testing = true (boolean true) with retries
        const allTestItems = await scanWithRetry(table, {
          FilterExpression: "testing = :testing",
          ExpressionAttributeValues: ScyllaDb.marshalItem({ ":testing": true })
        });

        for (const item of allTestItems) {
          const schema = ScyllaDb.getSchemaFromConfig(table);
          const key = {
            [schema.PK]: item[schema.PK],
            ...(schema.SK ? { [schema.SK]: item[schema.SK] } : {}),
          };
          await ScyllaDb.deleteItem(table, key);
        }

        // Also scan for items that might have testing as a string "true" (legacy) with retries
        const allLegacyTestItems = await scanWithRetry(table, {
          FilterExpression: "testing = :testing_str",
          ExpressionAttributeValues: ScyllaDb.marshalItem({ ":testing_str": "true" })
        });

        for (const item of allLegacyTestItems) {
          const schema = ScyllaDb.getSchemaFromConfig(table);
          const key = {
            [schema.PK]: item[schema.PK],
            ...(schema.SK ? { [schema.SK]: item[schema.SK] } : {}),
          };
          await ScyllaDb.deleteItem(table, key);
        }

        Logger.debugLog?.(`[BlockService] [clearTestData] [INFO] Cleared ${allTestItems.length + allLegacyTestItems.length} test data items from table: ${table}`);
      } catch (err) {
        ErrorHandler.addError(err.message || 'Error clearing test data', { error: err, table });
        throw err;
      }
    }

    Logger.debugLog?.(`[BlockService] [clearTestData] [SUCCESS] Test data clearance complete`);
  }

  /**
   * Determine if access from `from` to user `to` should be blocked for a given resource/scope.
   *
   * Decision order (fail fast):
   * 1) Manual suspensions: Any `manual_actions` record with type "suspend" blocks all access.
   * 2) System app blocks: Any `system_blocks` record for this user with `sk_type === "app"`
   *    that matches the requested scope (or is global/app) blocks access.
   * 3) User-user blocks: Any `user_blocks` record that is active and either
   *    - has `blocker_id === "system"` (global block, applies to all scopes and sources), or
   *    - is created by the specific `from` user and whose scope matches (requested/global/app).
   *
   * Notes:
   * - An active user block is one without `deleted_at` and not expired by `expires_at`.
   * - Scope matching treats "global" and "app" as supersets that apply to any requested scope.
   */
  static async handleIsUserBlocked({ to, from, scope }) {
    const validated = SafeUtils.sanitizeValidate({
      to: { value: to, type: "string", required: true, minLength: 1 },
      from: { value: from, type: "string", required: true, minLength: 1 },
      scope: { value: scope, type: "string", required: false },
    });
    const validatedTo = validated.to;
    const validatedFrom = validated.from;
    const validatedScope = validated.scope;

    Logger.debugLog?.(`[BlockService] [handleIsUserBlocked] [START] Checking if user blocked: to=${validatedTo}, from=${validatedFrom}, scope=${validatedScope}`);

    const now = DateTime.now();
    const requestedScope = validatedScope || "global";

    // Pull all block-like sources for the target `to` user
    const { blocks } = await this.GetBlocksForUser(validatedTo);
    const user_blocks = (blocks && blocks.user_blocks) || [];
    const system_blocks = (blocks && blocks.system_blocks) || [];
    const manual_actions = (blocks && blocks.manual_actions) || [];

    // Helper: a user-user block is active when:
    // - it's not soft-deleted, and
    // - it's permanent (is_permanent === 1, expires_at expected to be null), or
    // - it's temporary and the expiry is in the future
    const isUserBlockActive = (b) =>
      !b.deleted_at && (b.is_permanent === 1 || (b.expires_at !== null && b.expires_at > DateTime.now()));

    // Helper: scopes that apply to the requested resource
    const matchesRequestedScope = (s) =>
      s === requestedScope || s === "global" || s === "app";

    // 1) Manual suspension blocks all resources immediately
    const suspended = manual_actions.some((a) => !a.deleted_at && a.type === "suspend" && (a.expires_at === null || a.expires_at > now));
    if (suspended) {
      Logger.debugLog?.(`[BlockService] [handleIsUserBlocked] [SUCCESS] User is blocked due to suspension`);
      return true;
    }

    // 2) System-level app blocks for this user (identifier = user id)
    const activeSystemAppBlocks = system_blocks.filter(sb => this.isActiveBlock(sb) && sb.identifier === validatedTo && sb.sk_type.startsWith("app"));
    const blockedScopes = new Set(activeSystemAppBlocks.map(sb => sb.scope));
    const systemBlocked = blockedScopes.has("global") || blockedScopes.has(requestedScope) || blockedScopes.has("app");
    if (systemBlocked) {
      Logger.debugLog?.(`[BlockService] [handleIsUserBlocked] [SUCCESS] User is blocked due to system app block`);
      return true;
    }

    // 3) User-user blocks:
    //    - Global system-originated user block: `blocker_id === "system"` means block universally
    //    - Direct user block: specific `from` user blocked `to` for requested/global/app
    const activeUserBlocks = user_blocks.filter(isUserBlockActive);
    const systemUserBlock = activeUserBlocks.some(ub => ub.blocker_id === "system");
    if (systemUserBlock) {
      Logger.debugLog?.(`[BlockService] [handleIsUserBlocked] [SUCCESS] User is blocked due to system user block`);
      return true;
    }
    const userBlocked = activeUserBlocks.some(ub => ub.blocker_id === validatedFrom && matchesRequestedScope(ub.scope));
    if (userBlocked) {
      Logger.debugLog?.(`[BlockService] [handleIsUserBlocked] [SUCCESS] User is blocked due to user-user block`);
      return true;
    }

    // If none matched, access is allowed
    Logger.debugLog?.(`[BlockService] [handleIsUserBlocked] [SUCCESS] User is not blocked`);
    return false;
  }
}
