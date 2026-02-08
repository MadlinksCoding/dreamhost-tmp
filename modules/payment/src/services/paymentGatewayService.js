const scylla_db = require("../utils/ScyllaDb.js");
const path = require("path");
const ErrorHandler = require("../utils/ErrorHandler");
let Logger;
try {
  // Logger has strict env validation at module-load time; fall back to a no-op logger in test/minimal setups.
  Logger = require("../utils/Logger");
} catch (e) {
  Logger = {
    debugLog: null,
    writeLog: () => {},
  };
}
const SafeUtils = require("../utils/SafeUtils");
const ConfigFileLoader = require("../utils/ConfigFileLoader");
const DateTime = require("../utils/DateTime");

const table_names = {
  sessions: "paymentGateway_sessions",
  transactions: "paymentGateway_transactions",
  tokens: "paymentGateway_tokens",
  schedules: "paymentGateway_schedules",
  webhooks: "paymentGateway_webhooks",
};

const gsi_attribute_names = {
  subscription_pk: "#gsi_subscription_pk",
  order_pk: "#gsi_order_pk",
  status_pk: "#gsi_status_pk",
  expiry_pk: "#gsi_expiry_pk",
};

const gsi_index_names = {
  subscription_gsi: "gsi1",
  order_gsi: "gsi1",
  status_gsi: "gsi1",
  expiry_gsi: "gsi1",
};

class paymentGatewayService {
  /**
   * Get all transactions for a user in a date range
   * @param {string} user_id - required
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   *
   *
   */

  constructor() {
    // Load table configs with absolute path
    const tablesPath = path.join(__dirname, "../utils/tables.json");
    scylla_db.loadTableConfigs(tablesPath);
  }

  static async get_user_transactions(user_id, start_date, end_date) {
    Logger.debugLog?.(`[paymentGatewayService] [get_user_transactions] [START] Method called with userId: ${user_id}, startDate: ${start_date || 'null'}, endDate: ${end_date || 'null'}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: user_id, type: "string", required: true },
      startDate: { value: start_date, type: "string", required: false },
      endDate: { value: end_date, type: "string", required: false },
    });

    try {
      const key = `user#${cleaned.userId}`;
      const expressionNames = { "#pk": "pk" };
      const expressionValues = { ":pk": key };
      const queryOptions = {
        ExpressionAttributeNames: expressionNames,
      };

      if (cleaned.startDate && cleaned.endDate) {
        const startTimestamp = DateTime.parseDateToTimestamp(cleaned.startDate);
        const endTimestamp = DateTime.parseDateToTimestamp(cleaned.endDate);

        if (startTimestamp === false || endTimestamp === false) {
          ErrorHandler.addError("Invalid date format.", {
            code: "INVALID_DATE_FORMAT",
            origin: "paymentGatewayService",
            data: { startDate: cleaned.startDate, endDate: cleaned.endDate },
          });
          throw new Error("Invalid date format.");
        }

        if (startTimestamp > endTimestamp) {
          Logger.debugLog?.(`[paymentGatewayService] [get_user_transactions] [WARNING] Start date is after end date. Returning empty array.`);
          return [];
        }

        expressionValues[":start"] = cleaned.startDate;
        expressionValues[":end"] = cleaned.endDate;
        queryOptions.FilterExpression = "created_at BETWEEN :start AND :end";
      }

      Logger.debugLog?.(`[paymentGatewayService] [get_user_transactions] [QUERY] Executing query for user: ${cleaned.userId}`);
      const result = await scylla_db.query(
        table_names.transactions,
        "#pk = :pk",
        expressionValues,
        queryOptions
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [get_user_transactions] [SUCCESS] Found ${result.length} transactions`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get user transactions: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { userId: cleaned.userId, startDate: cleaned.startDate, endDate: cleaned.endDate },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getUserTransactionsFailed",
        data: {
          userId: cleaned.userId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Payee history endpoint - Returns all transactions where the user is the payer (spent tokens)
   * Uses a partition-key query (pk = user#<userId>) for efficient retrieval
   * Supports pagination to fetch all records for a user as a payee
   * 
   * @param {string} user_id - required, user ID (payer)
   * @param {Object} options - optional pagination options
   * @param {number} options.limit - Maximum number of records to return (default: 50, max: 100)
   * @param {Object} options.cursor - Pagination cursor (ExclusiveStartKey) for next page
   * @param {string} options.orderBy - Sort order: 'asc' or 'desc' (default: 'desc')
   * @returns {Promise<{transactions: Array, nextCursor: Object|null, hasMore: boolean, count: number}>}
   */
  static async getPayeeTransactionHistory(user_id, options = {}) {
    Logger.debugLog?.(`[paymentGatewayService] [getPayeeTransactionHistory] [START] Method called with userId: ${user_id}, options: ${JSON.stringify(options)}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: user_id, type: "string", required: true },
      limit: { value: options?.limit, type: "int", required: false },
      cursor: { value: options?.cursor, type: "object", required: false },
      orderBy: { value: options?.orderBy, type: "string", required: false },
    });

    try {
      const limit = Math.min(Math.max(parseInt(cleaned.limit) || 50, 1), 100);
      const orderBy = cleaned.orderBy === 'asc' ? 'asc' : 'desc';
      const cursor = cleaned.cursor || null;

      // Use partition-key query (pk = user#<userId>) for efficient retrieval of all transactions where user is payer
      const key = `user#${cleaned.userId}`;
      const expressionNames = { "#pk": "pk" };
      const expressionValues = { ":pk": key };
      const queryOptions = { ExpressionAttributeNames: expressionNames };

      Logger.debugLog?.(`[paymentGatewayService] [getPayeeTransactionHistory] [QUERY] Executing partition-key query for payee: ${cleaned.userId}, limit: ${limit}, orderBy: ${orderBy}`);
      const queryResult = await scylla_db.query(
        table_names.transactions,
        "#pk = :pk",
        expressionValues,
        queryOptions
      );

      const result = Array.isArray(queryResult) ? queryResult : (queryResult.Items || []);

      // Stable ordering by created timestamp (fallback to 0)
      const sorted = result.sort((a, b) => {
        const aTime = new Date(a.createdAt || a.created_at || 0).getTime();
        const bTime = new Date(b.createdAt || b.created_at || 0).getTime();
        return orderBy === "asc" ? aTime - bTime : bTime - aTime;
      });

      // Cursor is expected to be { pk, sk } of the last item from the previous page
      let startIndex = 0;
      if (cursor && typeof cursor === "object") {
        const idx = sorted.findIndex((t) => t?.pk === cursor.pk && t?.sk === cursor.sk);
        if (idx >= 0) startIndex = idx + 1;
      } else if (typeof cursor === "string" && cursor.length > 0) {
        // Backward-compatible: treat cursor string as sk
        const idx = sorted.findIndex((t) => t?.sk === cursor);
        if (idx >= 0) startIndex = idx + 1;
      }

      const page = sorted.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < sorted.length;
      const nextCursor = hasMore && page.length > 0 ? { pk: page[page.length - 1].pk, sk: page[page.length - 1].sk } : null;

      Logger.debugLog?.(`[paymentGatewayService] [getPayeeTransactionHistory] [SUCCESS] Found ${page.length} transactions, hasMore: ${hasMore}`);
      return {
        transactions: page,
        nextCursor,
        hasMore,
        count: page.length
      };
    } catch (error) {
      ErrorHandler.addError(`Failed to get payee transaction history: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { userId: cleaned.userId, options },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getPayeeTransactionHistoryFailed",
        data: {
          userId: cleaned.userId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Beneficiary history endpoint - Returns all transactions where the user is the beneficiary (received tokens)
   * Returns all transaction types (not TIP-only) - includes payment, tip, subscription, donation, etc.
   * Uses a scan + filter on beneficiaryId or recipientId to find all transactions where user received tokens
   * Supports pagination to fetch all records for a user as a beneficiary
   * 
   * @param {string} user_id - required, user ID (beneficiary)
   * @param {Object} options - optional pagination options
   * @param {number} options.limit - Maximum number of records to return (default: 50, max: 100)
   * @param {Object} options.cursor - Pagination cursor (ExclusiveStartKey) for next page
   * @param {string} options.orderBy - Sort order: 'asc' or 'desc' (default: 'desc')
   * @returns {Promise<{transactions: Array, nextCursor: Object|null, hasMore: boolean, count: number}>}
   */
  static async getBeneficiaryTransactionHistory(user_id, options = {}) {
    Logger.debugLog?.(`[paymentGatewayService] [getBeneficiaryTransactionHistory] [START] Method called with userId: ${user_id}, options: ${JSON.stringify(options)}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: user_id, type: "string", required: true },
      limit: { value: options?.limit, type: "int", required: false },
      cursor: { value: options?.cursor, type: "object", required: false },
      orderBy: { value: options?.orderBy, type: "string", required: false },
    });

    try {
      const limit = Math.min(Math.max(parseInt(cleaned.limit) || 50, 1), 100);
      const orderBy = cleaned.orderBy === 'asc' ? 'asc' : 'desc';
      const cursor = cleaned.cursor || null;

      // Query transactions where userId is the beneficiary (received tokens)
      // Uses partition key query (pk = beneficiary#userId) - enabled by dual-write pattern
      // Transactions are stored with both partition keys via saveTransaction():
      // - pk = user#payerId (for payee queries)
      // - pk = beneficiary#beneficiaryId (for beneficiary queries)
      // This enables efficient queries without scan operations
      
      const beneficiaryKey = `beneficiary#${cleaned.userId}`;
      const expressionNames = { "#pk": "pk" };
      const expressionValues = { ":pk": beneficiaryKey };
      const queryOptions = { 
        ExpressionAttributeNames: expressionNames,
        // FilterExpression as safety check to ensure we only get transactions where this user is the beneficiary
        FilterExpression: "beneficiaryId = :beneficiaryId OR recipientId = :beneficiaryId",
        ExpressionAttributeValues: {
          ...expressionValues,
          ":beneficiaryId": cleaned.userId
        }
      };

      Logger.debugLog?.(`[paymentGatewayService] [getBeneficiaryTransactionHistory] [QUERY] Querying transactions for beneficiary: ${cleaned.userId}, pk: ${beneficiaryKey}, limit: ${limit}`);
      const queryResult = await scylla_db.query(
        table_names.transactions,
        "#pk = :pk",
        expressionValues,
        queryOptions
      );

      const result = Array.isArray(queryResult) ? queryResult : (queryResult.Items || []);

      // Sort results by createdAt if available
      const sorted = result.sort((a, b) => {
        const aTime = new Date(a.createdAt || a.created_at || 0).getTime();
        const bTime = new Date(b.createdAt || b.created_at || 0).getTime();
        return orderBy === 'asc' ? aTime - bTime : bTime - aTime;
      });

      let startIndex = 0;
      if (cursor && typeof cursor === "object") {
        const idx = sorted.findIndex((t) => t?.pk === cursor.pk && t?.sk === cursor.sk);
        if (idx >= 0) startIndex = idx + 1;
      } else if (typeof cursor === "string" && cursor.length > 0) {
        const idx = sorted.findIndex((t) => t?.sk === cursor);
        if (idx >= 0) startIndex = idx + 1;
      }

      const page = sorted.slice(startIndex, startIndex + limit);
      const hasMore = startIndex + limit < sorted.length;
      const nextCursor = hasMore && page.length > 0 ? { pk: page[page.length - 1].pk, sk: page[page.length - 1].sk } : null;

      Logger.debugLog?.(`[paymentGatewayService] [getBeneficiaryTransactionHistory] [SUCCESS] Found ${page.length} transactions, hasMore: ${hasMore}`);
      return {
        transactions: page,
        nextCursor,
        hasMore,
        count: page.length
      };
    } catch (error) {
      ErrorHandler.addError(`Failed to get beneficiary transaction history: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { userId: cleaned.userId, options },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getBeneficiaryTransactionHistoryFailed",
        data: {
          userId: cleaned.userId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get all schedules for a user in a date range
   * @param {string} user_id - required
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   */
  static async get_user_schedules(user_id, start_date, end_date) {
    Logger.debugLog?.(`[paymentGatewayService] [get_user_schedules] [START] Method called with userId: ${user_id}, startDate: ${start_date || 'null'}, endDate: ${end_date || 'null'}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: user_id, type: "string", required: true },
      startDate: { value: start_date, type: "string", required: false },
      endDate: { value: end_date, type: "string", required: false },
    });

    try {
      const key = `user#${cleaned.userId}`;
      const expressionNames = { "#pk": "pk" };
      const expressionValues = { ":pk": key };
      const queryOptions = { ExpressionAttributeNames: expressionNames };

      if (cleaned.startDate && cleaned.endDate) {
        const startTimestamp = DateTime.parseDateToTimestamp(cleaned.startDate);
        const endTimestamp = DateTime.parseDateToTimestamp(cleaned.endDate);
        
        if (startTimestamp === false || endTimestamp === false) {
          ErrorHandler.addError("Invalid date format.", {
            code: "INVALID_DATE_FORMAT",
            origin: "paymentGatewayService",
            data: { startDate: cleaned.startDate, endDate: cleaned.endDate },
          });
          throw new Error("Invalid date format.");
        }

        if (startTimestamp > endTimestamp) {
          Logger.debugLog?.(`[paymentGatewayService] [get_user_schedules] [WARNING] Start date is after end date. Returning empty array.`);
          return [];
        }

        expressionValues[":start"] = cleaned.startDate;
        expressionValues[":end"] = cleaned.endDate;
        queryOptions.FilterExpression = "created_at BETWEEN :start AND :end";
      }

      Logger.debugLog?.(`[paymentGatewayService] [get_user_schedules] [QUERY] Executing query for user: ${cleaned.userId}`);
      const result = await scylla_db.query(
        table_names.schedules,
        "#pk = :pk",
        expressionValues,
        queryOptions
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [get_user_schedules] [SUCCESS] Found ${result.length} schedules`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get user schedules: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { userId: cleaned.userId, startDate: cleaned.startDate, endDate: cleaned.endDate },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getUserSchedulesFailed",
        data: {
          userId: cleaned.userId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get all schedules for a subscription in a date range
   * @param {string} subscription_id - required
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   */
  static async get_subscription_schedules(
    subscription_id,
    start_date,
    end_date
  ) {
    Logger.debugLog?.(`[paymentGatewayService] [get_subscription_schedules] [START] Method called with subscriptionId: ${subscription_id}, startDate: ${start_date || 'null'}, endDate: ${end_date || 'null'}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      subscriptionId: { value: subscription_id, type: "string", required: true },
      startDate: { value: start_date, type: "string", required: false },
      endDate: { value: end_date, type: "string", required: false },
    });

    try {
      const expressionValues = {
        ":subscriptionId": cleaned.subscriptionId,
      };

      const expressionNames = {
        "#subscriptionId": "subscriptionId",
      };

      let keyCondition = "#subscriptionId = :subscriptionId";

      if (cleaned.startDate && cleaned.endDate) {
        const startTimestamp = DateTime.parseDateToTimestamp(cleaned.startDate);
        const endTimestamp = DateTime.parseDateToTimestamp(cleaned.endDate);
        
        if (startTimestamp === false || endTimestamp === false || startTimestamp > endTimestamp) {
          Logger.debugLog?.(`[paymentGatewayService] [get_subscription_schedules] [WARNING] Invalid date range. Returning empty array.`);
          return [];
        }

        const startIso = DateTime.formatDate(cleaned.startDate, DateTime.FORMATS.ISO_DATETIME_TZ);
        const endIso = DateTime.formatDate(cleaned.endDate, DateTime.FORMATS.ISO_DATETIME_TZ);

        expressionValues[":start"] = startIso !== false ? startIso : cleaned.startDate;
        expressionValues[":end"] = endIso !== false ? endIso : cleaned.endDate;

        expressionNames["#created_at"] = "created_at";
        keyCondition += " AND #created_at BETWEEN :start AND :end";
      }

      const queryOptions = {
        IndexName: "subscription_gsi",
        ExpressionAttributeNames: expressionNames,
      };

      Logger.debugLog?.(`[paymentGatewayService] [get_subscription_schedules] [QUERY] Executing query for subscription: ${cleaned.subscriptionId}`);
      const result = await scylla_db.query(
        table_names.schedules,
        keyCondition,
        expressionValues,
        queryOptions
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [get_subscription_schedules] [SUCCESS] Found ${result.length} schedules`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get subscription schedules: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { subscriptionId: cleaned.subscriptionId, startDate: cleaned.startDate, endDate: cleaned.endDate },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getSubscriptionSchedulesFailed",
        data: {
          subscriptionId: cleaned.subscriptionId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get all transactions for an order in a date range
   * @param {string} order_id - required
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   */
  static async get_order_transactions(order_id, start_date, end_date) {
    Logger.debugLog?.(`[paymentGatewayService] [get_order_transactions] [START] Method called with orderId: ${order_id}, startDate: ${start_date || 'null'}, endDate: ${end_date || 'null'}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      orderId: { value: order_id, type: "string", required: true },
      startDate: { value: start_date, type: "string", required: false },
      endDate: { value: end_date, type: "string", required: false },
    });

    try {
      const expressionValues = {
        ":orderId": cleaned.orderId,
      };

      const expressionNames = {
        "#order_id": "order_id",
      };

      let keyCondition = "#order_id = :orderId";

      if (cleaned.startDate && cleaned.endDate) {
        const startTimestamp = DateTime.parseDateToTimestamp(cleaned.startDate);
        const endTimestamp = DateTime.parseDateToTimestamp(cleaned.endDate);

        if (startTimestamp === false || endTimestamp === false || startTimestamp > endTimestamp) {
          Logger.debugLog?.(`[paymentGatewayService] [get_order_transactions] [WARNING] Invalid date range provided. Returning empty result.`);
          return [];
        }

        const startIso = DateTime.formatDate(cleaned.startDate, DateTime.FORMATS.ISO_DATETIME_TZ);
        const endIso = DateTime.formatDate(cleaned.endDate, DateTime.FORMATS.ISO_DATETIME_TZ);

        expressionValues[":start"] = startIso !== false ? startIso : cleaned.startDate;
        expressionValues[":end"] = endIso !== false ? endIso : cleaned.endDate;

        expressionNames["#created_at"] = "created_at";
        keyCondition += " AND #created_at BETWEEN :start AND :end";
      }

      const queryOptions = {
        IndexName: "order_gsi",
        ExpressionAttributeNames: expressionNames,
      };

      Logger.debugLog?.(`[paymentGatewayService] [get_order_transactions] [QUERY] Executing query for order: ${cleaned.orderId}`);
      const result = await scylla_db.query(
        table_names.transactions,
        keyCondition,
        expressionValues,
        queryOptions
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [get_order_transactions] [SUCCESS] Found ${result.length} transactions`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get order transactions: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { orderId: cleaned.orderId, startDate: cleaned.startDate, endDate: cleaned.endDate },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getOrderTransactionsFailed",
        data: {
          orderId: cleaned.orderId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get all sessions for a user in a date range
   * @param {string} user_id - required
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   */
  static async get_user_sessions(user_id, start_date, end_date) {
    Logger.debugLog?.(`[paymentGatewayService] [get_user_sessions] [START] Method called with userId: ${user_id}, startDate: ${start_date || 'null'}, endDate: ${end_date || 'null'}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: user_id, type: "string", required: true },
      startDate: { value: start_date, type: "string", required: false },
      endDate: { value: end_date, type: "string", required: false },
    });

    try {
      const expressionValues = {
        ":pk": `user#${cleaned.userId}`,
      };

      const expressionNames = {
        "#pk": "pk",
      };

      const queryOptions = {
        ExpressionAttributeNames: expressionNames,
      };

      if (cleaned.startDate && cleaned.endDate) {
        const startTimestamp = DateTime.parseDateToTimestamp(cleaned.startDate);
        const endTimestamp = DateTime.parseDateToTimestamp(cleaned.endDate);

        if (startTimestamp === false || endTimestamp === false || startTimestamp > endTimestamp) {
          Logger.debugLog?.(`[paymentGatewayService] [get_user_sessions] [WARNING] Invalid date range. Returning empty array.`);
          return [];
        }

        const startIso = DateTime.formatDate(cleaned.startDate, DateTime.FORMATS.ISO_DATETIME_TZ);
        const endIso = DateTime.formatDate(cleaned.endDate, DateTime.FORMATS.ISO_DATETIME_TZ);

        expressionValues[":start"] = startIso !== false ? startIso : cleaned.startDate;
        expressionValues[":end"] = endIso !== false ? endIso : cleaned.endDate;

        expressionNames["#created_at"] = "created_at";
        queryOptions.FilterExpression = "#created_at BETWEEN :start AND :end";
      }

      Logger.debugLog?.(`[paymentGatewayService] [get_user_sessions] [QUERY] Executing query for user: ${cleaned.userId}`);
      const result = await scylla_db.query(
        table_names.sessions,
        "#pk = :pk",
        expressionValues,
        queryOptions
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [get_user_sessions] [SUCCESS] Found ${result.length} sessions`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get user sessions: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { userId: cleaned.userId, startDate: cleaned.startDate, endDate: cleaned.endDate },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getUserSessionsFailed",
        data: {
          userId: cleaned.userId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get all sessions for an order in a date range
   * @param {string} order_id - required
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   */
  static async get_order_sessions(order_id, start_date, end_date) {
    Logger.debugLog?.(`[paymentGatewayService] [get_order_sessions] [START] Method called with orderId: ${order_id}, startDate: ${start_date || 'null'}, endDate: ${end_date || 'null'}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      orderId: { value: order_id, type: "string", required: true },
      startDate: { value: start_date, type: "string", required: false },
      endDate: { value: end_date, type: "string", required: false },
    });

    try {
      const expressionValues = {
        ":gsi": cleaned.orderId,
      };

      const expressionNames = {
        "#gsi_order_pk": "order_id",
      };

      let keyCondition = "#gsi_order_pk = :gsi";

      if (cleaned.startDate && cleaned.endDate) {
        const startTimestamp = DateTime.parseDateToTimestamp(cleaned.startDate);
        const endTimestamp = DateTime.parseDateToTimestamp(cleaned.endDate);

        if (startTimestamp === false || endTimestamp === false || startTimestamp > endTimestamp) {
          Logger.debugLog?.(`[paymentGatewayService] [get_order_sessions] [WARNING] Invalid date range provided. Returning empty result.`);
          return [];
        }

        const startIso = DateTime.formatDate(cleaned.startDate, DateTime.FORMATS.ISO_DATETIME_TZ);
        const endIso = DateTime.formatDate(cleaned.endDate, DateTime.FORMATS.ISO_DATETIME_TZ);

        expressionValues[":start"] = startIso !== false ? startIso : cleaned.startDate;
        expressionValues[":end"] = endIso !== false ? endIso : cleaned.endDate;

        expressionNames["#created_at"] = "created_at";
        keyCondition += " AND #created_at BETWEEN :start AND :end";
      }

      const queryOptions = {
        IndexName: "order_gsi",
        ExpressionAttributeNames: expressionNames,
      };

      Logger.debugLog?.(`[paymentGatewayService] [get_order_sessions] [QUERY] Executing query for order: ${cleaned.orderId}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_order_sessions] [DEBUG] KeyCondition: ${keyCondition}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_order_sessions] [DEBUG] ExpressionAttributeValues: ${JSON.stringify(expressionValues)}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_order_sessions] [DEBUG] ExpressionAttributeNames: ${JSON.stringify(expressionNames)}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_order_sessions] [DEBUG] QueryOptions: ${JSON.stringify(queryOptions)}`);

      const result = await scylla_db.query(
        table_names.sessions,
        keyCondition,
        expressionValues,
        queryOptions
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [get_order_sessions] [SUCCESS] Found ${result.length} sessions`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get order sessions: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { orderId: cleaned.orderId, startDate: cleaned.startDate, endDate: cleaned.endDate },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getOrderSessionsFailed",
        data: {
          orderId: cleaned.orderId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get sessions by field (orderId, userId, etc.)
   * @param {string} field - field name to search by
   * @param {string} value - value to search for
   */
  static async getSessionsBy(field, value) {
    Logger.debugLog?.(`[paymentGatewayService] [getSessionsBy] [START] Method called with field: ${field}, value: ${value}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      field: { value: field, type: "string", required: true },
      value: { value: value, type: "string", required: true },
    });

    try {
      if (cleaned.field === "orderId") {
        Logger.debugLog?.(`[paymentGatewayService] [getSessionsBy] [ROUTE] Routing to get_order_sessions`);
        return await this.get_order_sessions(cleaned.value);
      } else if (cleaned.field === "userId") {
        Logger.debugLog?.(`[paymentGatewayService] [getSessionsBy] [ROUTE] Routing to get_user_sessions`);
        return await this.get_user_sessions(cleaned.value);
      } else {
        Logger.debugLog?.(`[paymentGatewayService] [getSessionsBy] [WARNING] Unsupported field: ${cleaned.field}`);
        return [];
      }
    } catch (error) {
      ErrorHandler.addError(`Failed to get sessions by field: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { field: cleaned.field, value: cleaned.value },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getSessionsByFailed",
        data: {
          field: cleaned.field,
          value: cleaned.value,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Fallback method to get sessions by orderId using scan (less efficient but more reliable)
   * @param {string} orderId - order ID to search for
   */
  static async get_order_sessions_fallback(orderId) {
    Logger.debugLog?.(`[paymentGatewayService] [get_order_sessions_fallback] [START] Method called with orderId: ${orderId}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      orderId: { value: orderId, type: "string", required: true },
    });

    try {
      const scanParams = {
        FilterExpression: "orderId = :orderId OR order_id = :orderId",
        ExpressionAttributeValues: {
          ":orderId": cleaned.orderId
        }
      };

      Logger.debugLog?.(`[paymentGatewayService] [get_order_sessions_fallback] [SCAN] Using fallback scan method for orderId: ${cleaned.orderId}`);
      const result = await scylla_db.scan(table_names.sessions, scanParams);
      Logger.debugLog?.(`[paymentGatewayService] [get_order_sessions_fallback] [SUCCESS] Fallback scan found ${result.length} sessions`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Fallback scan failed: ${error.message}`, {
        code: "SCAN_FAILED",
        origin: "paymentGatewayService",
        data: { orderId: cleaned.orderId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getOrderSessionsFallbackFailed",
        data: {
          orderId: cleaned.orderId,
          error: error.message,
        },
        critical: true,
      });
      Logger.debugLog?.(`[paymentGatewayService] [get_order_sessions_fallback] [ERROR] Fallback scan failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Get all tokens for a user
   * @param {string} user_id - required
   */
  static async get_user_tokens(user_id) {
    Logger.debugLog?.(`[paymentGatewayService] [get_user_tokens] [START] Method called with userId: ${user_id}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: user_id, type: "string", required: true },
    });

    try {
      Logger.debugLog?.(`[paymentGatewayService] [get_user_tokens] [QUERY] Executing query for user: ${cleaned.userId}`);
      const result = await scylla_db.query(
        table_names.tokens,
        "#pk = :pk",
        { ":pk": `user#${cleaned.userId}` },
        {
          ExpressionAttributeNames: { "#pk": "pk" },
        }
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [get_user_tokens] [SUCCESS] Found ${result.length} tokens`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get user tokens: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { userId: cleaned.userId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getUserTokensFailed",
        data: {
          userId: cleaned.userId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get all tokens soon to expire
   * @param {string} yyyy_mm - required (e.g. '2025-07')
   */
  static async get_tokens_soon_to_expire(yyyy_mm) {
    Logger.debugLog?.(`[paymentGatewayService] [get_tokens_soon_to_expire] [START] Method called with yyyy_mm: ${yyyy_mm}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      yyyyMm: { value: yyyy_mm, type: "string", required: true },
    });

    try {
      const expressionValues = {
        ":gsi": cleaned.yyyyMm,
      };

      const expressionNames = {
        "#expiry": "expiry",
      };

      const keyCondition = "#expiry = :gsi";

      const queryOptions = {
        IndexName: "expiry_gsi",
        ExpressionAttributeNames: expressionNames,
      };

      Logger.debugLog?.(`[paymentGatewayService] [get_tokens_soon_to_expire] [QUERY] Executing query for expiry: ${cleaned.yyyyMm}`);
      const result = await scylla_db.query(
        table_names.tokens,
        keyCondition,
        expressionValues,
        queryOptions
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [get_tokens_soon_to_expire] [SUCCESS] Found ${result.length} tokens`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get tokens soon to expire: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { yyyyMm: cleaned.yyyyMm },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getTokensSoonToExpireFailed",
        data: {
          yyyyMm: cleaned.yyyyMm,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get all failed transactions by date range
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   */
  static async get_failed_transactions(start_date, end_date) {
    Logger.debugLog?.(`[paymentGatewayService] [get_failed_transactions] [START] Method called with startDate: ${start_date || 'null'}, endDate: ${end_date || 'null'}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      startDate: { value: start_date, type: "string", required: false },
      endDate: { value: end_date, type: "string", required: false },
    });

    try {
      const expressionValues = {
        ":status": "status#failed",
      };

      const expressionNames = {
        "#statusGSI": "statusGSI",
      };

      let keyCondition = "#statusGSI = :status";

      if (cleaned.startDate && cleaned.endDate) {
        const startTimestamp = DateTime.parseDateToTimestamp(cleaned.startDate);
        const endTimestamp = DateTime.parseDateToTimestamp(cleaned.endDate);

        if (startTimestamp === false || endTimestamp === false || startTimestamp > endTimestamp) {
          Logger.debugLog?.(`[paymentGatewayService] [get_failed_transactions] [WARNING] Invalid date range. Returning empty array.`);
          return [];
        }

        const startIso = DateTime.formatDate(cleaned.startDate, DateTime.FORMATS.ISO_DATETIME_TZ);
        const endIso = DateTime.formatDate(cleaned.endDate, DateTime.FORMATS.ISO_DATETIME_TZ);

        expressionValues[":start"] = startIso !== false ? startIso : cleaned.startDate;
        expressionValues[":end"] = endIso !== false ? endIso : cleaned.endDate;
        expressionNames["#created_at"] = "created_at";

        keyCondition += " AND #created_at BETWEEN :start AND :end";
      }

      const queryOptions = {
        IndexName: "status_gsi",
        ExpressionAttributeNames: expressionNames,
      };

      Logger.debugLog?.(`[paymentGatewayService] [get_failed_transactions] [QUERY] Executing query for failed transactions`);
      Logger.debugLog?.(`[paymentGatewayService] [get_failed_transactions] [DEBUG] KeyCondition: ${keyCondition}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_failed_transactions] [DEBUG] Values: ${JSON.stringify(expressionValues)}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_failed_transactions] [DEBUG] Names: ${JSON.stringify(expressionNames)}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_failed_transactions] [DEBUG] Options: ${JSON.stringify(queryOptions)}`);

      const result = await scylla_db.query(
        table_names.transactions,
        keyCondition,
        expressionValues,
        queryOptions
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [get_failed_transactions] [SUCCESS] Found ${result.length} failed transactions`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get failed transactions: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { startDate: cleaned.startDate, endDate: cleaned.endDate },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getFailedTransactionsFailed",
        data: {
          startDate: cleaned.startDate,
          endDate: cleaned.endDate,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get all webhooks for an order
   * @param {string} order_id - required
   */
  static async get_order_webhooks(order_id) {
    Logger.debugLog?.(`[paymentGatewayService] [get_order_webhooks] [START] Method called with orderId: ${order_id}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      orderId: { value: order_id, type: "string", required: true },
    });

    try {
      Logger.debugLog?.(`[paymentGatewayService] [get_order_webhooks] [QUERY] Executing query for order: ${cleaned.orderId}`);
      const result = await scylla_db.query(
        table_names.webhooks,
        "#pk = :pk",
        {
          ":pk": `order#${cleaned.orderId}`,
        },
        {
          ExpressionAttributeNames: {
            "#pk": "pk",
          },
        }
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [get_order_webhooks] [SUCCESS] Found ${result.length} webhooks`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get order webhooks: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { orderId: cleaned.orderId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getOrderWebhooksFailed",
        data: {
          orderId: cleaned.orderId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get all webhooks for a subscription
   * @param {string} subscription_id - required
   */
  static async get_subscription_webhooks(subscription_id) {
    Logger.debugLog?.(`[paymentGatewayService] [get_subscription_webhooks] [START] Method called with subscriptionId: ${subscription_id}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      subscriptionId: { value: subscription_id, type: "string", required: true },
    });

    try {
      const expressionValues = {
        ":subId": cleaned.subscriptionId,
      };

      const expressionNames = {
        "#subscriptionId": "subscriptionId",
      };

      const keyCondition = "#subscriptionId = :subId";

      const queryOptions = {
        IndexName: "subscription_gsi",
        ExpressionAttributeNames: expressionNames,
      };

      Logger.debugLog?.(`[paymentGatewayService] [get_subscription_webhooks] [QUERY] Executing query for subscription: ${cleaned.subscriptionId}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_subscription_webhooks] [DEBUG] KeyCondition: ${keyCondition}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_subscription_webhooks] [DEBUG] ExpressionAttributeValues: ${JSON.stringify(expressionValues)}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_subscription_webhooks] [DEBUG] ExpressionAttributeNames: ${JSON.stringify(expressionNames)}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_subscription_webhooks] [DEBUG] QueryOptions: ${JSON.stringify(queryOptions)}`);

      const result = await scylla_db.query(
        table_names.webhooks,
        keyCondition,
        expressionValues,
        queryOptions
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [get_subscription_webhooks] [SUCCESS] Found ${result.length} webhooks`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get subscription webhooks: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { subscriptionId: cleaned.subscriptionId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getSubscriptionWebhooksFailed",
        data: {
          subscriptionId: cleaned.subscriptionId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get all records (transactions, sessions, schedules) for a specific order
   * @param {string} order_id - required
   */
  static async get_order_full_data(order_id) {
    Logger.debugLog?.(`[paymentGatewayService] [get_order_full_data] [START] Method called with orderId: ${order_id}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      orderId: { value: order_id, type: "string", required: true },
    });

    try {
      const expressionNames = {
        "#order_id": "order_id",
        "#created_at": "created_at",
      };

      const now = DateTime.now();
      const expressionValues = {
        ":order_id": `order#${cleaned.orderId}`,
        ":start": "2000-01-01T00:00:00.000Z",
        ":end": now,
      };

      const keyCondition =
        "#order_id = :order_id AND #created_at BETWEEN :start AND :end";

      const options = {
        IndexName: "order_gsi",
        ExpressionAttributeNames: expressionNames,
      };

      Logger.debugLog?.(`[paymentGatewayService] [get_order_full_data] [QUERY] Executing parallel queries for order: ${cleaned.orderId}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_order_full_data] [DEBUG] KeyConditionExpression: ${keyCondition}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_order_full_data] [DEBUG] ExpressionAttributeValues: ${JSON.stringify(expressionValues)}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_order_full_data] [DEBUG] ExpressionAttributeNames: ${JSON.stringify(expressionNames)}`);
      Logger.debugLog?.(`[paymentGatewayService] [get_order_full_data] [DEBUG] IndexName: ${options.IndexName}`);

      const [txns, sessions, schedules] = await Promise.all([
        this.get_order_transactions(cleaned.orderId, null, null),
        this.get_order_sessions(cleaned.orderId, null, null),
        scylla_db.query(
          table_names.schedules,
          keyCondition,
          expressionValues,
          options
        ),
      ]);

      Logger.debugLog?.(`[paymentGatewayService] [get_order_full_data] [SUCCESS] Found ${txns.length} transactions, ${sessions.length} sessions, ${schedules.length} schedules`);
      return { txns, sessions, schedules };
    } catch (error) {
      ErrorHandler.addError(`Failed to get order full data: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { orderId: cleaned.orderId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getOrderFullDataFailed",
        data: {
          orderId: cleaned.orderId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Save a session record
   * @param {object} sessionData
   * @property {string} userId - required
   * @property {string} orderId - required
   * @property {string} sessionType - required ('card' | 'token')
   * @property {string} gateway - required
   * @property {string} status - required ('pending' | 'completed')
   * @property {object} payloads - required ({ requestData, responseData })
   * @property {string} [transactionId] - optional
   * @property {string} [redirectUrl] - optional
   * @property {string} [createdAt] - optional (ISO8601)
   */
  static async saveSession(sessionData) {
    Logger.debugLog?.(`[paymentGatewayService] [saveSession] [START] Method called with sessionData: ${JSON.stringify(sessionData)}`);
    
    if (!sessionData || typeof sessionData !== "object") {
      ErrorHandler.addError("sessionData must be an object", {
        code: "INVALID_INPUT",
        origin: "paymentGatewayService",
        data: { sessionData },
      });
      throw new Error("sessionData must be an object");
    }

    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: sessionData.userId, type: "string", required: true },
      orderId: { value: sessionData.orderId, type: "string", required: true },
      sessionType: { value: sessionData.sessionType, type: "string", required: true },
      gateway: { value: sessionData.gateway, type: "string", required: true },
      status: { value: sessionData.status, type: "string", required: true },
      payloads: { value: sessionData.payloads, type: "object", required: true },
      transactionId: { value: sessionData.transactionId, type: "string", required: false },
      redirectUrl: { value: sessionData.redirectUrl, type: "string", required: false },
      createdAt: { value: sessionData.createdAt, type: "string", required: false },
    });

    try {
      const dataToSave = {
        ...sessionData,
        userId: cleaned.userId,
        orderId: cleaned.orderId,
        sessionType: cleaned.sessionType,
        gateway: cleaned.gateway,
        status: cleaned.status,
        payloads: cleaned.payloads,
      };

      if (cleaned.transactionId) {
        dataToSave.transactionId = cleaned.transactionId;
      }
      if (cleaned.redirectUrl) {
        dataToSave.redirectUrl = cleaned.redirectUrl;
      }
      if (cleaned.createdAt) {
        dataToSave.createdAt = cleaned.createdAt;
      }

      Logger.debugLog?.(`[paymentGatewayService] [saveSession] [SAVE] Saving session for orderId: ${cleaned.orderId}`);
      const result = await scylla_db.putItem(table_names.sessions, dataToSave);
      Logger.debugLog?.(`[paymentGatewayService] [saveSession] [SUCCESS] Session saved successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to save session: ${error.message}`, {
        code: "SAVE_FAILED",
        origin: "paymentGatewayService",
        data: { orderId: cleaned.orderId, userId: cleaned.userId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "saveSessionFailed",
        data: {
          orderId: cleaned.orderId,
          userId: cleaned.userId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Update a session record
   * @param {string} pk - required, partition key
   * @param {string} sk - required, sort key
   * @param {object} updates - required, fields to update
   */
  static async updateSession(pk, sk, updates) {
    Logger.debugLog?.(`[paymentGatewayService] [updateSession] [START] Method called with pk: ${pk}, sk: ${sk}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: pk, type: "string", required: true },
      sk: { value: sk, type: "string", required: true },
    });

    if (!updates || typeof updates !== "object") {
      ErrorHandler.addError("updates must be an object", {
        code: "INVALID_INPUT",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk, updates },
      });
      throw new Error("updates must be an object");
    }

    try {
      Logger.debugLog?.(`[paymentGatewayService] [updateSession] [UPDATE] Updating session with pk: ${cleaned.pk}, sk: ${cleaned.sk}`);
      const result = await scylla_db.updateItem(table_names.sessions, { pk: cleaned.pk, sk: cleaned.sk }, updates);
      Logger.debugLog?.(`[paymentGatewayService] [updateSession] [SUCCESS] Session updated successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to update session: ${error.message}`, {
        code: "UPDATE_FAILED",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "updateSessionFailed",
        data: {
          pk: cleaned.pk,
          sk: cleaned.sk,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Delete a session record
   * @param {string} pk - required, partition key
   * @param {string} sk - required, sort key
   */
  static async deleteSession(pk, sk) {
    Logger.debugLog?.(`[paymentGatewayService] [deleteSession] [START] Method called with pk: ${pk}, sk: ${sk}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: pk, type: "string", required: true },
      sk: { value: sk, type: "string", required: true },
    });

    try {
      Logger.debugLog?.(`[paymentGatewayService] [deleteSession] [DELETE] Deleting session with pk: ${cleaned.pk}, sk: ${cleaned.sk}`);
      const result = await scylla_db.deleteItem(table_names.sessions, { pk: cleaned.pk, sk: cleaned.sk });
      Logger.debugLog?.(`[paymentGatewayService] [deleteSession] [SUCCESS] Session deleted successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to delete session: ${error.message}`, {
        code: "DELETE_FAILED",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "deleteSessionFailed",
        data: {
          pk: cleaned.pk,
          sk: cleaned.sk,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Save a transaction record
   * @param {object} transactionData
   * @property {string} userId - required
   * @property {string} orderId - required
   * @property {string} transactionId - required
   * @property {string} orderType - required
   * @property {string} status - required ('success' | 'failed')
   * @property {object} payloads - required ({ requestData, responseData })
   * @property {string} [cardLast4] - optional
   * @property {string} [cardType] - optional
   * @property {string} [cardHolderName] - optional
   * @property {string} [tokenId] - optional
   * @property {string} [createdAt] - optional
   */
  static async saveTransaction(transactionData) {
    Logger.debugLog?.(`[paymentGatewayService] [saveTransaction] [START] Method called with transactionData: ${JSON.stringify(transactionData)}`);
    
    if (!transactionData || typeof transactionData !== "object") {
      ErrorHandler.addError("transactionData must be an object", {
        code: "INVALID_INPUT",
        origin: "paymentGatewayService",
        data: { transactionData },
      });
      throw new Error("transactionData must be an object");
    }

    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: transactionData.userId, type: "string", required: true },
      orderId: { value: transactionData.orderId, type: "string", required: true },
      transactionId: { value: transactionData.transactionId, type: "string", required: true },
      orderType: { value: transactionData.orderType, type: "string", required: true },
      status: { value: transactionData.status, type: "string", required: true },
      payloads: { value: transactionData.payloads, type: "object", required: true },
      cardLast4: { value: transactionData.cardLast4, type: "string", required: false },
      cardType: { value: transactionData.cardType, type: "string", required: false },
      cardHolderName: { value: transactionData.cardHolderName, type: "string", required: false },
      tokenId: { value: transactionData.tokenId, type: "string", required: false },
      createdAt: { value: transactionData.createdAt, type: "string", required: false },
    });

    try {
      // Extract beneficiaryId from transactionData (could be beneficiaryId or recipientId)
      const beneficiaryId = transactionData.beneficiaryId || transactionData.recipientId || null;
      
      const dataToSave = {
        ...transactionData,
        userId: cleaned.userId,
        orderId: cleaned.orderId,
        transactionId: cleaned.transactionId,
        orderType: cleaned.orderType,
        status: cleaned.status,
        payloads: cleaned.payloads,
      };

      if (cleaned.cardLast4) {
        dataToSave.cardLast4 = cleaned.cardLast4;
      }
      if (cleaned.cardType) {
        dataToSave.cardType = cleaned.cardType;
      }
      if (cleaned.cardHolderName) {
        dataToSave.cardHolderName = cleaned.cardHolderName;
      }
      if (cleaned.tokenId) {
        dataToSave.tokenId = cleaned.tokenId;
      }
      if (cleaned.createdAt) {
        dataToSave.createdAt = cleaned.createdAt;
      }

      // Ensure beneficiaryId/recipientId are set if provided
      if (beneficiaryId) {
        dataToSave.beneficiaryId = beneficiaryId;
        dataToSave.recipientId = beneficiaryId; // Set both for consistency
      }

      // Ensure payer partition key is set correctly (pk = user#payerId)
      // This is the primary record for payee queries
      dataToSave.pk = dataToSave.pk || `user#${cleaned.userId}`;
      // Ensure sort key is set (should be txn#transactionId or similar)
      dataToSave.sk = dataToSave.sk || `txn#${cleaned.transactionId}`;

      // Dual-write pattern: Save transaction with payer partition key (pk = user#payerId)
      Logger.debugLog?.(`[paymentGatewayService] [saveTransaction] [SAVE] Saving transaction with payer partition key for transactionId: ${cleaned.transactionId}, pk: ${dataToSave.pk}`);
      const payerResult = await scylla_db.putItem(table_names.transactions, dataToSave);
      
      // If there's a beneficiary, also save with beneficiary partition key (pk = beneficiary#beneficiaryId)
      // This enables efficient beneficiary queries without scan
      if (beneficiaryId && beneficiaryId !== cleaned.userId) {
        const beneficiaryDataToSave = {
          ...dataToSave,
          pk: `beneficiary#${beneficiaryId}`, // Override pk for beneficiary partition
          // Keep the same sk so we can identify the same transaction
        };
        
        Logger.debugLog?.(`[paymentGatewayService] [saveTransaction] [SAVE] Saving transaction with beneficiary partition key for transactionId: ${cleaned.transactionId}, pk: beneficiary#${beneficiaryId}`);
        await scylla_db.putItem(table_names.transactions, beneficiaryDataToSave);
        Logger.debugLog?.(`[paymentGatewayService] [saveTransaction] [SUCCESS] Transaction saved with dual-write pattern (payer + beneficiary)`);
      } else {
        Logger.debugLog?.(`[paymentGatewayService] [saveTransaction] [SUCCESS] Transaction saved successfully (no beneficiary, single write)`);
      }
      
      return payerResult;
    } catch (error) {
      ErrorHandler.addError(`Failed to save transaction: ${error.message}`, {
        code: "SAVE_FAILED",
        origin: "paymentGatewayService",
        data: { transactionId: cleaned.transactionId, orderId: cleaned.orderId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "saveTransactionFailed",
        data: {
          transactionId: cleaned.transactionId,
          orderId: cleaned.orderId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Update a transaction record
   * @param {string} pk - required
   * @param {string} sk - required
   * @param {object} updates - required
   */
  static async updateTransaction(pk, sk, updates) {
    Logger.debugLog?.(`[paymentGatewayService] [updateTransaction] [START] Method called with pk: ${pk}, sk: ${sk}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: pk, type: "string", required: true },
      sk: { value: sk, type: "string", required: true },
    });

    if (!updates || typeof updates !== "object") {
      ErrorHandler.addError("updates must be an object", {
        code: "INVALID_INPUT",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk, updates },
      });
      throw new Error("updates must be an object");
    }

    try {
      Logger.debugLog?.(`[paymentGatewayService] [updateTransaction] [UPDATE] Updating transaction with pk: ${cleaned.pk}, sk: ${cleaned.sk}`);
      const result = await scylla_db.updateItem(table_names.transactions, { pk: cleaned.pk, sk: cleaned.sk }, updates);
      Logger.debugLog?.(`[paymentGatewayService] [updateTransaction] [SUCCESS] Transaction updated successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to update transaction: ${error.message}`, {
        code: "UPDATE_FAILED",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "updateTransactionFailed",
        data: {
          pk: cleaned.pk,
          sk: cleaned.sk,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Delete a transaction record
   * @param {string} pk - required
   * @param {string} sk - required
   */
  static async deleteTransaction(pk, sk) {
    Logger.debugLog?.(`[paymentGatewayService] [deleteTransaction] [START] Method called with pk: ${pk}, sk: ${sk}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: pk, type: "string", required: true },
      sk: { value: sk, type: "string", required: true },
    });

    try {
      Logger.debugLog?.(`[paymentGatewayService] [deleteTransaction] [DELETE] Deleting transaction with pk: ${cleaned.pk}, sk: ${cleaned.sk}`);
      const result = await scylla_db.deleteItem(table_names.transactions, { pk: cleaned.pk, sk: cleaned.sk });
      Logger.debugLog?.(`[paymentGatewayService] [deleteTransaction] [SUCCESS] Transaction deleted successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to delete transaction: ${error.message}`, {
        code: "DELETE_FAILED",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "deleteTransactionFailed",
        data: {
          pk: cleaned.pk,
          sk: cleaned.sk,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Save a schedule record
   * @param {object} scheduleData
   * @property {string} userId - required
   * @property {string} orderId - required
   * @property {string} subscriptionId - required
   * @property {string} status - required
   * @property {string} frequency - required
   * @property {string} amount - required
   * @property {string} currency - required
   * @property {string} registrationId - required
   * @property {string} startDate - required
   * @property {string} nextScheduleDate - required
   * @property {string} [checkoutId] - optional
   * @property {object} [createScheduleArgs] - optional
   * @property {object} [createScheduleResponse] - optional
   * @property {string} [notes] - optional
   * @property {string} [createdAt] - optional
   */
  static async saveSchedule(scheduleData) {
    Logger.debugLog?.(`[paymentGatewayService] [saveSchedule] [START] Method called with scheduleData: ${JSON.stringify(scheduleData)}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: scheduleData?.userId, type: "string", required: true },
      orderId: { value: scheduleData?.orderId, type: "string", required: true },
      subscriptionId: { value: scheduleData?.subscriptionId, type: "string", required: true },
      status: { value: scheduleData?.status, type: "string", required: true },
      frequency: { value: scheduleData?.frequency, type: "string", required: true },
      amount: { value: scheduleData?.amount, type: "string", required: true },
      currency: { value: scheduleData?.currency, type: "string", required: true },
      registrationId: { value: scheduleData?.registrationId, type: "string", required: true },
      startDate: { value: scheduleData?.startDate, type: "string", required: true },
      nextScheduleDate: { value: scheduleData?.nextScheduleDate, type: "string", required: true },
      checkoutId: { value: scheduleData?.checkoutId, type: "string", required: false },
      createScheduleArgs: { value: scheduleData?.createScheduleArgs, type: "object", required: false },
      createScheduleResponse: { value: scheduleData?.createScheduleResponse, type: "object", required: false },
      notes: { value: scheduleData?.notes, type: "string", required: false },
      createdAt: { value: scheduleData?.createdAt, type: "string", required: false, default: DateTime.now(DateTime.FORMATS.ISO_DATETIME_TZ) },
    });

    try {
      if (!cleaned.userId) {
        ErrorHandler.addError("Missing required parameter: userId", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: userId");
      }
      if (!cleaned.orderId) {
        ErrorHandler.addError("Missing required parameter: orderId", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: orderId");
      }
      if (!cleaned.subscriptionId) {
        ErrorHandler.addError("Missing required parameter: subscriptionId", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: subscriptionId");
      }
      if (!cleaned.status) {
        ErrorHandler.addError("Missing required parameter: status", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: status");
      }
      if (!cleaned.frequency) {
        ErrorHandler.addError("Missing required parameter: frequency", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: frequency");
      }
      if (!cleaned.amount) {
        ErrorHandler.addError("Missing required parameter: amount", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: amount");
      }
      if (!cleaned.currency) {
        ErrorHandler.addError("Missing required parameter: currency", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: currency");
      }
      if (!cleaned.registrationId) {
        ErrorHandler.addError("Missing required parameter: registrationId", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: registrationId");
      }
      if (!cleaned.startDate) {
        ErrorHandler.addError("Missing required parameter: startDate", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: startDate");
      }
      if (!cleaned.nextScheduleDate) {
        ErrorHandler.addError("Missing required parameter: nextScheduleDate", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: nextScheduleDate");
      }

      const dataToSave = {
        pk: `user#${cleaned.userId}`,
        sk: `schedule#${cleaned.subscriptionId}#${cleaned.createdAt}`,
        userId: cleaned.userId,
        orderId: cleaned.orderId,
        subscriptionId: cleaned.subscriptionId,
        status: cleaned.status,
        frequency: cleaned.frequency,
        amount: cleaned.amount,
        currency: cleaned.currency,
        registrationId: cleaned.registrationId,
        startDate: cleaned.startDate,
        nextScheduleDate: cleaned.nextScheduleDate,
        createdAt: cleaned.createdAt,
        gsi1pk: `subscription#${cleaned.subscriptionId}`,
        gsi1sk: `schedule#${cleaned.createdAt}`,
      };

      if (cleaned.checkoutId) {
        dataToSave.checkoutId = cleaned.checkoutId;
      }
      if (cleaned.createScheduleArgs) {
        dataToSave.createScheduleArgs = cleaned.createScheduleArgs;
      }
      if (cleaned.createScheduleResponse) {
        dataToSave.createScheduleResponse = cleaned.createScheduleResponse;
      }
      if (cleaned.notes) {
        dataToSave.notes = cleaned.notes;
      }

      Logger.debugLog?.(`[paymentGatewayService] [saveSchedule] [SAVE] Saving schedule for subscriptionId: ${cleaned.subscriptionId}`);
      const result = await scylla_db.putItem(table_names.schedules, dataToSave);
      Logger.debugLog?.(`[paymentGatewayService] [saveSchedule] [SUCCESS] Schedule saved successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to save schedule: ${error.message}`, {
        code: "SAVE_FAILED",
        origin: "paymentGatewayService",
        data: { subscriptionId: cleaned.subscriptionId, orderId: cleaned.orderId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "saveScheduleFailed",
        data: {
          subscriptionId: cleaned.subscriptionId,
          orderId: cleaned.orderId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Update a schedule record
   * @param {string} pk - required
   * @param {string} sk - required
   * @param {object} updates - required
   */
  static async updateSchedule(pk, sk, updates) {
    Logger.debugLog?.(`[paymentGatewayService] [updateSchedule] [START] Method called with pk: ${pk}, sk: ${sk}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: pk, type: "string", required: true },
      sk: { value: sk, type: "string", required: true },
    });

    if (!updates || typeof updates !== "object") {
      ErrorHandler.addError("updates must be an object", {
        code: "INVALID_INPUT",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk, updates },
      });
      throw new Error("updates must be an object");
    }

    try {
      Logger.debugLog?.(`[paymentGatewayService] [updateSchedule] [UPDATE] Updating schedule with pk: ${cleaned.pk}, sk: ${cleaned.sk}`);
      const result = await scylla_db.updateItem(table_names.schedules, { pk: cleaned.pk, sk: cleaned.sk }, updates);
      Logger.debugLog?.(`[paymentGatewayService] [updateSchedule] [SUCCESS] Schedule updated successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to update schedule: ${error.message}`, {
        code: "UPDATE_FAILED",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "updateScheduleFailed",
        data: {
          pk: cleaned.pk,
          sk: cleaned.sk,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Delete a schedule record
   * @param {string} pk - required
   * @param {string} sk - required
   */
  static async deleteSchedule(pk, sk) {
    Logger.debugLog?.(`[paymentGatewayService] [deleteSchedule] [START] Method called with pk: ${pk}, sk: ${sk}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: pk, type: "string", required: true },
      sk: { value: sk, type: "string", required: true },
    });

    try {
      Logger.debugLog?.(`[paymentGatewayService] [deleteSchedule] [DELETE] Deleting schedule with pk: ${cleaned.pk}, sk: ${cleaned.sk}`);
      const result = await scylla_db.deleteItem(table_names.schedules, { pk: cleaned.pk, sk: cleaned.sk });
      Logger.debugLog?.(`[paymentGatewayService] [deleteSchedule] [SUCCESS] Schedule deleted successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to delete schedule: ${error.message}`, {
        code: "DELETE_FAILED",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "deleteScheduleFailed",
        data: {
          pk: cleaned.pk,
          sk: cleaned.sk,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Save a webhook record
   * @param {object} webhookData
   * @property {string} orderId - required
   * @property {object} payload - required
   * @property {string} actionTaken - required
   * @property {boolean} handled - required
   * @property {string} idempotencyKey - required
   * @property {string} [subscriptionId] - optional
   * @property {string} [createdAt] - optional
   */
  static async saveWebhook(webhookData) {
    Logger.debugLog?.(`[paymentGatewayService] [saveWebhook] [START] Method called with webhookData: ${JSON.stringify(webhookData)}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: webhookData?.pk, type: "string", required: false },
      sk: { value: webhookData?.sk, type: "string", required: false },
      orderId: { value: webhookData?.orderId, type: "string", required: true },
      payload: { value: webhookData?.payload, type: "object", required: true },
      actionTaken: { value: webhookData?.actionTaken, type: "string", required: true },
      handled: { value: webhookData?.handled, type: "boolean", required: true },
      idempotencyKey: { value: webhookData?.idempotencyKey, type: "string", required: true },
      subscriptionId: { value: webhookData?.subscriptionId, type: "string", required: false },
      createdAt: { value: webhookData?.createdAt, type: "string", required: false, default: DateTime.now(DateTime.FORMATS.ISO_DATETIME_TZ) },
    });

    try {
      if (!cleaned.orderId) {
        ErrorHandler.addError("Missing required parameter: orderId", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: orderId");
      }
      if (!cleaned.payload) {
        ErrorHandler.addError("Missing required parameter: payload", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: payload");
      }
      if (!cleaned.actionTaken) {
        ErrorHandler.addError("Missing required parameter: actionTaken", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: actionTaken");
      }
      if (cleaned.handled === null || cleaned.handled === undefined) {
        ErrorHandler.addError("Missing required parameter: handled", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: handled");
      }
      if (!cleaned.idempotencyKey) {
        ErrorHandler.addError("Missing required parameter: idempotencyKey", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: idempotencyKey");
      }

      const dataToSave = {
        // Honor caller-provided keys (tests + some integrations pass explicit pk/sk).
        // Fallback to deterministic keys when pk/sk are not provided.
        pk: cleaned.pk || `order#${cleaned.orderId}`,
        sk: cleaned.sk || `webhook#${cleaned.idempotencyKey}#${cleaned.createdAt}`,
        orderId: cleaned.orderId,
        payload: cleaned.payload,
        actionTaken: cleaned.actionTaken,
        handled: cleaned.handled,
        idempotencyKey: cleaned.idempotencyKey,
        createdAt: cleaned.createdAt,
      };

      if (cleaned.subscriptionId) {
        dataToSave.subscriptionId = cleaned.subscriptionId;
        dataToSave.gsi1pk = `subscription#${cleaned.subscriptionId}`;
        dataToSave.gsi1sk = `webhook#${cleaned.createdAt}`;
      }

      Logger.debugLog?.(`[paymentGatewayService] [saveWebhook] [SAVE] Saving webhook for orderId: ${cleaned.orderId}`);
      const result = await scylla_db.putItem(table_names.webhooks, dataToSave);
      Logger.debugLog?.(`[paymentGatewayService] [saveWebhook] [SUCCESS] Webhook saved successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to save webhook: ${error.message}`, {
        code: "SAVE_FAILED",
        origin: "paymentGatewayService",
        data: { orderId: cleaned.orderId, idempotencyKey: cleaned.idempotencyKey },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "saveWebhookFailed",
        data: {
          orderId: cleaned.orderId,
          idempotencyKey: cleaned.idempotencyKey,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Update a webhook record
   * @param {string} pk - required
   * @param {string} sk - required
   * @param {object} updates - required
   */
  static async updateWebhook(pk, sk, updates) {
    Logger.debugLog?.(`[paymentGatewayService] [updateWebhook] [START] Method called with pk: ${pk}, sk: ${sk}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: pk, type: "string", required: true },
      sk: { value: sk, type: "string", required: true },
    });

    if (!updates || typeof updates !== "object") {
      ErrorHandler.addError("updates must be an object", {
        code: "INVALID_INPUT",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk, updates },
      });
      throw new Error("updates must be an object");
    }

    try {
      Logger.debugLog?.(`[paymentGatewayService] [updateWebhook] [UPDATE] Updating webhook with pk: ${cleaned.pk}, sk: ${cleaned.sk}`);
      const result = await scylla_db.updateItem(table_names.webhooks, { pk: cleaned.pk, sk: cleaned.sk }, updates);
      Logger.debugLog?.(`[paymentGatewayService] [updateWebhook] [SUCCESS] Webhook updated successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to update webhook: ${error.message}`, {
        code: "UPDATE_FAILED",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "updateWebhookFailed",
        data: {
          pk: cleaned.pk,
          sk: cleaned.sk,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Delete a webhook record
   * @param {string} pk - required
   * @param {string} sk - required
   */
  static async deleteWebhook(pk, sk) {
    Logger.debugLog?.(`[paymentGatewayService] [deleteWebhook] [START] Method called with pk: ${pk}, sk: ${sk}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: pk, type: "string", required: true },
      sk: { value: sk, type: "string", required: true },
    });

    try {
      Logger.debugLog?.(`[paymentGatewayService] [deleteWebhook] [DELETE] Deleting webhook with pk: ${cleaned.pk}, sk: ${cleaned.sk}`);
      const result = await scylla_db.deleteItem(table_names.webhooks, { pk: cleaned.pk, sk: cleaned.sk });
      Logger.debugLog?.(`[paymentGatewayService] [deleteWebhook] [SUCCESS] Webhook deleted successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to delete webhook: ${error.message}`, {
        code: "DELETE_FAILED",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "deleteWebhookFailed",
        data: {
          pk: cleaned.pk,
          sk: cleaned.sk,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Save a token record
   * @param {object} tokenData
   * @property {string} userId - required
   * @property {string} registrationId - required
   * @property {string} last4 - required
   * @property {string} expiry - required (YYYY-MM)
   * @property {string} name - required
   * @property {string} type - required
   * @property {string} [createdAt] - optional
   */
  static async saveToken(tokenData) {
    Logger.debugLog?.(`[paymentGatewayService] [saveToken] [START] Method called with tokenData: ${JSON.stringify(tokenData)}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: tokenData?.pk, type: "string", required: false },
      sk: { value: tokenData?.sk, type: "string", required: false },
      userId: { value: tokenData?.userId, type: "string", required: true },
      registrationId: { value: tokenData?.registrationId, type: "string", required: true },
      last4: { value: tokenData?.last4, type: "string", required: true },
      expiry: { value: tokenData?.expiry, type: "string", required: true },
      name: { value: tokenData?.name, type: "string", required: true },
      type: { value: tokenData?.type, type: "string", required: true },
      createdAt: { value: tokenData?.createdAt, type: "string", required: false, default: DateTime.now(DateTime.FORMATS.ISO_DATETIME_TZ) },
    });

    try {
      if (!cleaned.userId) {
        ErrorHandler.addError("Missing required parameter: userId", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: userId");
      }
      if (!cleaned.registrationId) {
        ErrorHandler.addError("Missing required parameter: registrationId", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: registrationId");
      }
      if (!cleaned.last4) {
        ErrorHandler.addError("Missing required parameter: last4", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: last4");
      }
      if (!cleaned.expiry) {
        ErrorHandler.addError("Missing required parameter: expiry", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: expiry");
      }
      if (!cleaned.name) {
        ErrorHandler.addError("Missing required parameter: name", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: name");
      }
      if (!cleaned.type) {
        ErrorHandler.addError("Missing required parameter: type", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: type");
      }

      const dataToSave = {
        // Honor caller-provided keys (tests + some integrations pass explicit pk/sk).
        // Fallback to deterministic keys when pk/sk are not provided.
        pk: cleaned.pk || `user#${cleaned.userId}`,
        sk: cleaned.sk || `token#${cleaned.registrationId}#${cleaned.createdAt}`,
        userId: cleaned.userId,
        registrationId: cleaned.registrationId,
        last4: cleaned.last4,
        expiry: cleaned.expiry,
        name: cleaned.name,
        type: cleaned.type,
        createdAt: cleaned.createdAt,
        gsi1pk: cleaned.expiry,
        gsi1sk: `token#${cleaned.createdAt}`,
      };

      Logger.debugLog?.(`[paymentGatewayService] [saveToken] [SAVE] Saving token for userId: ${cleaned.userId}, registrationId: ${cleaned.registrationId}`);
      const result = await scylla_db.putItem(table_names.tokens, dataToSave);
      Logger.debugLog?.(`[paymentGatewayService] [saveToken] [SUCCESS] Token saved successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to save token: ${error.message}`, {
        code: "SAVE_FAILED",
        origin: "paymentGatewayService",
        data: { userId: cleaned.userId, registrationId: cleaned.registrationId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "saveTokenFailed",
        data: {
          userId: cleaned.userId,
          registrationId: cleaned.registrationId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Update a token record
   * @param {string} pk - required
   * @param {string} sk - required
   * @param {object} updates - required
   */
  static async updateToken(pk, sk, updates) {
    Logger.debugLog?.(`[paymentGatewayService] [updateToken] [START] Method called with pk: ${pk}, sk: ${sk}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: pk, type: "string", required: true },
      sk: { value: sk, type: "string", required: true },
    });

    if (!updates || typeof updates !== "object") {
      ErrorHandler.addError("updates must be an object", {
        code: "INVALID_INPUT",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk, updates },
      });
      throw new Error("updates must be an object");
    }

    try {
      Logger.debugLog?.(`[paymentGatewayService] [updateToken] [UPDATE] Updating token with pk: ${cleaned.pk}, sk: ${cleaned.sk}`);
      const result = await scylla_db.updateItem(table_names.tokens, { pk: cleaned.pk, sk: cleaned.sk }, updates);
      Logger.debugLog?.(`[paymentGatewayService] [updateToken] [SUCCESS] Token updated successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to update token: ${error.message}`, {
        code: "UPDATE_FAILED",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "updateTokenFailed",
        data: {
          pk: cleaned.pk,
          sk: cleaned.sk,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Delete a token record
   * @param {string} pk - required
   * @param {string} sk - required
   */
  static async deleteToken(pk, sk) {
    Logger.debugLog?.(`[paymentGatewayService] [deleteToken] [START] Method called with pk: ${pk}, sk: ${sk}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: pk, type: "string", required: true },
      sk: { value: sk, type: "string", required: true },
    });

    try {
      Logger.debugLog?.(`[paymentGatewayService] [deleteToken] [DELETE] Deleting token with pk: ${cleaned.pk}, sk: ${cleaned.sk}`);
      const result = await scylla_db.deleteItem(table_names.tokens, { pk: cleaned.pk, sk: cleaned.sk });
      Logger.debugLog?.(`[paymentGatewayService] [deleteToken] [SUCCESS] Token deleted successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to delete token: ${error.message}`, {
        code: "DELETE_FAILED",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "deleteTokenFailed",
        data: {
          pk: cleaned.pk,
          sk: cleaned.sk,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get all tokens for a user
   * @param {string} userId - required
   * @returns {Promise<Array>}
   */
  static async getTokensByUser(userId) {
    Logger.debugLog?.(`[paymentGatewayService] [getTokensByUser] [START] Method called with userId: ${userId}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: userId, type: "string", required: true },
    });

    try {
      if (!cleaned.userId) {
        ErrorHandler.addError("Missing required parameter: userId", {
          code: "MISSING_REQUIRED_PARAM",
          origin: "paymentGatewayService",
        });
        throw new Error("Missing required parameter: userId");
      }

      const key = `user#${cleaned.userId}`;
      const expressionNames = { "#pk": "pk" };
      const expressionValues = { ":pk": key };
      const queryOptions = {
        ExpressionAttributeNames: expressionNames,
      };

      Logger.debugLog?.(`[paymentGatewayService] [getTokensByUser] [QUERY] Executing query for user: ${cleaned.userId}`);
      const result = await scylla_db.query(
        table_names.tokens,
        "#pk = :pk",
        expressionValues,
        queryOptions
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [getTokensByUser] [SUCCESS] Found ${result.length} tokens for user: ${cleaned.userId}`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get tokens by user: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { userId: cleaned.userId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getTokensByUserFailed",
        data: {
          userId: cleaned.userId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get tokens expiring in a given month
   * @param {string} yyyymm - required (YYYY-MM format)
   * @returns {Promise<Array>}
   */
  static async getTokensByExpiry(yyyymm) {
    Logger.debugLog?.(`[paymentGatewayService] [getTokensByExpiry] [START] Method called with yyyymm: ${yyyymm}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      yyyymm: { value: yyyymm, type: "string", required: true },
    });

    try {
      if (!cleaned.yyyymm) {
        ErrorHandler.addError("Missing required parameter: yyyymm", {
          code: "MISSING_REQUIRED_PARAM",
          origin: "paymentGatewayService",
        });
        throw new Error("Missing required parameter: yyyymm");
      }

      const expressionNames = { "#expiry": "expiry" };
      const expressionValues = { ":expiry": cleaned.yyyymm };
      const queryOptions = {
        ExpressionAttributeNames: expressionNames,
        IndexName: "expiry_gsi"
      };

      Logger.debugLog?.(`[paymentGatewayService] [getTokensByExpiry] [QUERY] Executing query for expiry: ${cleaned.yyyymm}`);
      const result = await scylla_db.query(
        table_names.tokens,
        "#expiry = :expiry",
        expressionValues,
        queryOptions
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [getTokensByExpiry] [SUCCESS] Found ${result.length} tokens expiring in: ${cleaned.yyyymm}`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get tokens by expiry: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { yyyymm: cleaned.yyyymm },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getTokensByExpiryFailed",
        data: {
          yyyymm: cleaned.yyyymm,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  // ===== SUBSCRIPTION/SCHEDULE METHODS =====

  /**
   * Save a schedule record
   * @param {object} scheduleData
   * @property {string} pk - required
   * @property {string} sk - required
   * @property {string} scheduleId - required
   * @property {string} registrationId - required
   * @property {string} userId - required
   * @property {number} amount - required
   * @property {string} currency - required
   * @property {string} subscriptionPlan - required
   * @property {string} schedule - required
   * @property {string} status - required
   * @property {string} [createdAt] - optional
   */
  static async saveSchedule(scheduleData) {
    Logger.debugLog?.(`[paymentGatewayService] [saveSchedule] [START] Method called with scheduleData: ${JSON.stringify(scheduleData)}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: scheduleData?.pk, type: "string", required: true },
      sk: { value: scheduleData?.sk, type: "string", required: true },
      scheduleId: { value: scheduleData?.scheduleId, type: "string", required: true },
      registrationId: { value: scheduleData?.registrationId, type: "string", required: true },
      userId: { value: scheduleData?.userId, type: "string", required: true },
      amount: { value: scheduleData?.amount, type: "float", required: true },
      currency: { value: scheduleData?.currency, type: "string", required: true },
      subscriptionPlan: { value: scheduleData?.subscriptionPlan, type: "string", required: true },
      schedule: { value: scheduleData?.schedule, type: "string", required: true },
      status: { value: scheduleData?.status, type: "string", required: true },
      createdAt: { value: scheduleData?.createdAt, type: "string", required: false, default: DateTime.now(DateTime.FORMATS.ISO_DATETIME_TZ) },
    });

    try {
      if (!cleaned.pk) {
        ErrorHandler.addError("Missing required parameter: pk", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: pk");
      }
      if (!cleaned.sk) {
        ErrorHandler.addError("Missing required parameter: sk", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: sk");
      }
      if (!cleaned.scheduleId) {
        ErrorHandler.addError("Missing required parameter: scheduleId", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: scheduleId");
      }
      if (!cleaned.registrationId) {
        ErrorHandler.addError("Missing required parameter: registrationId", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: registrationId");
      }
      if (!cleaned.userId) {
        ErrorHandler.addError("Missing required parameter: userId", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: userId");
      }
      if (!cleaned.amount) {
        ErrorHandler.addError("Missing required parameter: amount", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: amount");
      }
      if (!cleaned.currency) {
        ErrorHandler.addError("Missing required parameter: currency", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: currency");
      }
      if (!cleaned.subscriptionPlan) {
        ErrorHandler.addError("Missing required parameter: subscriptionPlan", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: subscriptionPlan");
      }
      if (!cleaned.schedule) {
        ErrorHandler.addError("Missing required parameter: schedule", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: schedule");
      }
      if (!cleaned.status) {
        ErrorHandler.addError("Missing required parameter: status", { code: "MISSING_REQUIRED_PARAM", origin: "paymentGatewayService" });
        throw new Error("Missing required parameter: status");
      }

      const dataToSave = {
        pk: cleaned.pk,
        sk: cleaned.sk,
        scheduleId: cleaned.scheduleId,
        registrationId: cleaned.registrationId,
        userId: cleaned.userId,
        amount: cleaned.amount,
        currency: cleaned.currency,
        subscriptionPlan: cleaned.subscriptionPlan,
        schedule: cleaned.schedule,
        status: cleaned.status,
        createdAt: cleaned.createdAt,
      };

      Logger.debugLog?.(`[paymentGatewayService] [saveSchedule] [SAVE] Saving schedule for scheduleId: ${cleaned.scheduleId}`);
      const result = await scylla_db.putItem(table_names.schedules, dataToSave);
      Logger.debugLog?.(`[paymentGatewayService] [saveSchedule] [SUCCESS] Schedule saved successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to save schedule: ${error.message}`, {
        code: "SAVE_FAILED",
        origin: "paymentGatewayService",
        data: { scheduleId: cleaned.scheduleId, userId: cleaned.userId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "saveScheduleFailed",
        data: {
          scheduleId: cleaned.scheduleId,
          userId: cleaned.userId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Update a schedule record
   * @param {string} scheduleId - required
   * @param {object} updates - required
   */
  static async updateSchedule(scheduleId, updates) {
    Logger.debugLog?.(`[paymentGatewayService] [updateSchedule] [START] Method called with scheduleId: ${scheduleId}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      scheduleId: { value: scheduleId, type: "string", required: true },
    });

    if (!updates || typeof updates !== "object") {
      ErrorHandler.addError("updates must be an object", {
        code: "INVALID_INPUT",
        origin: "paymentGatewayService",
        data: { scheduleId: cleaned.scheduleId, updates },
      });
      throw new Error("updates must be an object");
    }

    try {
      if (!cleaned.scheduleId) {
        ErrorHandler.addError("Missing required parameter: scheduleId", {
          code: "MISSING_REQUIRED_PARAM",
          origin: "paymentGatewayService",
        });
        throw new Error("Missing required parameter: scheduleId");
      }

      Logger.debugLog?.(`[paymentGatewayService] [updateSchedule] [SCAN] Finding schedule with scheduleId: ${cleaned.scheduleId}`);
      const schedules = await scylla_db.scan(table_names.schedules, {
        FilterExpression: "scheduleId = :scheduleId",
        ExpressionAttributeValues: { ":scheduleId": cleaned.scheduleId }
      });

      if (schedules.length === 0) {
        ErrorHandler.addError(`Schedule with ID ${cleaned.scheduleId} not found`, {
          code: "SCHEDULE_NOT_FOUND",
          origin: "paymentGatewayService",
          data: { scheduleId: cleaned.scheduleId },
        });
        throw new Error(`Schedule with ID ${cleaned.scheduleId} not found`);
      }

      const schedule = schedules[0];
      Logger.debugLog?.(`[paymentGatewayService] [updateSchedule] [UPDATE] Updating schedule with pk: ${schedule.pk}, sk: ${schedule.sk}`);
      const result = await scylla_db.updateItem(table_names.schedules, { pk: schedule.pk, sk: schedule.sk }, updates);
      Logger.debugLog?.(`[paymentGatewayService] [updateSchedule] [SUCCESS] Schedule updated successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to update schedule: ${error.message}`, {
        code: "UPDATE_FAILED",
        origin: "paymentGatewayService",
        data: { scheduleId: cleaned.scheduleId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "updateScheduleFailed",
        data: {
          scheduleId: cleaned.scheduleId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Delete a schedule record
   * @param {string} pk - required
   * @param {string} sk - required
   */
  static async deleteSchedule(pk, sk) {
    Logger.debugLog?.(`[paymentGatewayService] [deleteSchedule] [START] Method called with pk: ${pk}, sk: ${sk}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      pk: { value: pk, type: "string", required: true },
      sk: { value: sk, type: "string", required: true },
    });

    try {
      Logger.debugLog?.(`[paymentGatewayService] [deleteSchedule] [DELETE] Deleting schedule with pk: ${cleaned.pk}, sk: ${cleaned.sk}`);
      const result = await scylla_db.deleteItem(table_names.schedules, { pk: cleaned.pk, sk: cleaned.sk });
      Logger.debugLog?.(`[paymentGatewayService] [deleteSchedule] [SUCCESS] Schedule deleted successfully`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to delete schedule: ${error.message}`, {
        code: "DELETE_FAILED",
        origin: "paymentGatewayService",
        data: { pk: cleaned.pk, sk: cleaned.sk },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "deleteScheduleFailed",
        data: {
          pk: cleaned.pk,
          sk: cleaned.sk,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get all schedules for a user
   * @param {string} userId - required
   * @returns {Promise<Array>}
   */
  static async getSchedulesByUser(userId) {
    Logger.debugLog?.(`[paymentGatewayService] [getSchedulesByUser] [START] Method called with userId: ${userId}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: userId, type: "string", required: true },
    });

    try {
      if (!cleaned.userId) {
        ErrorHandler.addError("Missing required parameter: userId", {
          code: "MISSING_REQUIRED_PARAM",
          origin: "paymentGatewayService",
        });
        throw new Error("Missing required parameter: userId");
      }

      const key = `user#${cleaned.userId}`;
      const expressionNames = { "#pk": "pk" };
      const expressionValues = { ":pk": key };
      const queryOptions = {
        ExpressionAttributeNames: expressionNames,
      };

      Logger.debugLog?.(`[paymentGatewayService] [getSchedulesByUser] [QUERY] Executing query for user: ${cleaned.userId}`);
      const result = await scylla_db.query(
        table_names.schedules,
        "#pk = :pk",
        expressionValues,
        queryOptions
      );
      
      Logger.debugLog?.(`[paymentGatewayService] [getSchedulesByUser] [SUCCESS] Found ${result.length} schedules for user: ${cleaned.userId}`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get schedules by user: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { userId: cleaned.userId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getSchedulesByUserFailed",
        data: {
          userId: cleaned.userId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

  /**
   * Get schedule by ID
   * @param {string} scheduleId - required
   * @returns {Promise<object|null>}
   */
  static async getScheduleById(scheduleId) {
    Logger.debugLog?.(`[paymentGatewayService] [getScheduleById] [START] Method called with scheduleId: ${scheduleId}`);
    
    const cleaned = SafeUtils.sanitizeValidate({
      scheduleId: { value: scheduleId, type: "string", required: true },
    });

    try {
      if (!cleaned.scheduleId) {
        ErrorHandler.addError("Missing required parameter: scheduleId", {
          code: "MISSING_REQUIRED_PARAM",
          origin: "paymentGatewayService",
        });
        throw new Error("Missing required parameter: scheduleId");
      }

      Logger.debugLog?.(`[paymentGatewayService] [getScheduleById] [SCAN] Scanning for schedule with scheduleId: ${cleaned.scheduleId}`);
      const schedules = await scylla_db.scan(table_names.schedules, {
        FilterExpression: "scheduleId = :scheduleId",
        ExpressionAttributeValues: { ":scheduleId": cleaned.scheduleId }
      });

      const result = schedules.length > 0 ? schedules[0] : null;
      Logger.debugLog?.(`[paymentGatewayService] [getScheduleById] [SUCCESS] ${result ? 'Schedule found' : 'Schedule not found'} for scheduleId: ${cleaned.scheduleId}`);
      return result;
    } catch (error) {
      ErrorHandler.addError(`Failed to get schedule by ID: ${error.message}`, {
        code: "QUERY_FAILED",
        origin: "paymentGatewayService",
        data: { scheduleId: cleaned.scheduleId },
      });
      Logger.writeLog({
        flag: "PAYMENTGATEWAY",
        action: "getScheduleByIdFailed",
        data: {
          scheduleId: cleaned.scheduleId,
          error: error.message,
        },
        critical: true,
      });
      throw error;
    }
  }

}

module.exports = paymentGatewayService;
