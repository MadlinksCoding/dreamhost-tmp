const TokenManager = require('../services/TokenManager');
const ScyllaDb = require('../utils/ScyllaDb');
const DateTime = require('../utils/DateTime');
const SafeUtils = require('../../../../utils/SafeUtils');

/**
 * Aggregate user balances from transaction records
 * Similar to TokenManager.#aggregateBalances but returns admin-friendly format
 */
function aggregateUserBalances(records = []) {
  const byUser = new Map();

  const ensureUser = (userId) => {
    if (!byUser.has(userId)) {
      byUser.set(userId, {
        userId,
        paidTokens: 0,
        systemFreeTokens: 0,
        creatorFreeTokens: 0,
      });
    }
    return byUser.get(userId);
  };

  for (const tx of records) {
    const userId = tx.userId;
    const beneficiaryId = tx.beneficiaryId || TokenManager.SYSTEM_BENEFICIARY_ID;
    const isSystemBeneficiary = beneficiaryId === TokenManager.SYSTEM_BENEFICIARY_ID;

    // CREDIT_PAID
    if (tx.transactionType === TokenManager.TRANSACTION_TYPES.CREDIT_PAID) {
      const user = ensureUser(userId);
      user.paidTokens += tx.amount;
    }

    // CREDIT_FREE
    if (tx.transactionType === TokenManager.TRANSACTION_TYPES.CREDIT_FREE) {
      // Skip expired free tokens
      if (tx.expiresAt && tx.expiresAt !== "9999-12-31T23:59:59.999Z" && DateTime.isPast(tx.expiresAt)) {
        continue;
      }
      const user = ensureUser(userId);
      if (isSystemBeneficiary) {
        user.systemFreeTokens += tx.amount;
      } else {
        user.creatorFreeTokens += tx.amount;
      }
    }

    // DEBIT
    if (tx.transactionType === TokenManager.TRANSACTION_TYPES.DEBIT) {
      const user = ensureUser(userId);
      user.paidTokens -= tx.amount;
      const beneficiaryFreeConsumed = tx.freeBeneficiaryConsumed || 0;
      const systemFreeConsumed = tx.freeSystemConsumed || 0;
      if (beneficiaryFreeConsumed > 0 && !isSystemBeneficiary) {
        user.creatorFreeTokens = Math.max(0, user.creatorFreeTokens - beneficiaryFreeConsumed);
      }
      if (systemFreeConsumed > 0) {
        user.systemFreeTokens = Math.max(0, user.systemFreeTokens - systemFreeConsumed);
      }
    }

    // HOLD
    if (tx.transactionType === TokenManager.TRANSACTION_TYPES.HOLD) {
      const user = ensureUser(userId);
      const state = tx.state || TokenManager.HOLD_STATES.OPEN;
      if (state !== TokenManager.HOLD_STATES.REVERSED) {
        const beneficiaryFreeConsumed = tx.freeBeneficiaryConsumed || 0;
        const systemFreeConsumed = tx.freeSystemConsumed || 0;
        if (beneficiaryFreeConsumed > 0 && !isSystemBeneficiary) {
          user.creatorFreeTokens = Math.max(0, user.creatorFreeTokens - beneficiaryFreeConsumed);
        }
        if (systemFreeConsumed > 0) {
          user.systemFreeTokens = Math.max(0, user.systemFreeTokens - systemFreeConsumed);
        }
        user.paidTokens -= tx.amount;
      }
    }

    // TIP (transfer)
    if (tx.transactionType === TokenManager.TRANSACTION_TYPES.TIP) {
      const sender = ensureUser(userId);
      sender.paidTokens -= tx.amount;
      const beneficiaryFreeConsumed = tx.freeBeneficiaryConsumed || 0;
      const systemFreeConsumed = tx.freeSystemConsumed || 0;
      if (beneficiaryFreeConsumed > 0 && !isSystemBeneficiary) {
        sender.creatorFreeTokens = Math.max(0, sender.creatorFreeTokens - beneficiaryFreeConsumed);
      }
      if (systemFreeConsumed > 0) {
        sender.systemFreeTokens = Math.max(0, sender.systemFreeTokens - systemFreeConsumed);
      }
      const receiver = ensureUser(tx.beneficiaryId);
      receiver.paidTokens += tx.amount;
    }
  }

  return Array.from(byUser.values());
}

/**
 * GET /user-tokens
 * List user token balances with cursor-based pagination (limit + nextToken)
 */
async function list(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      // UI uses "q" for userId search; keep userId for exact match
      q: { value: req.query.q, type: "string", required: false },
      userId: { value: req.query.userId, type: "string", required: false },
      limit: { value: req.query.limit, type: "int", required: false },
      // Cursor-based pagination: opaque nextToken representing an integer offset
      nextToken: { value: req.query.nextToken, type: "string", required: false },
      // Offset-based pagination (PageRenderer default)
      offset: { value: req.query.offset, type: "int", required: false },
    });

    const search = cleaned.q ? String(cleaned.q).trim() : null;
    const userId = cleaned.userId ? String(cleaned.userId).trim() : null;
    const requestedLimit = cleaned.limit;
    if (requestedLimit !== undefined && requestedLimit !== null && (requestedLimit < 1 || requestedLimit > 1000)) {
      return res.status(400).json({
        error: 'Invalid limit',
        message: 'limit must be between 1 and 1000',
        status: 400
      });
    }
    const limit = requestedLimit !== undefined && requestedLimit !== null ? requestedLimit : 20;
    const offset =
      cleaned.offset !== undefined && cleaned.offset !== null
        ? cleaned.offset
        : cleaned.nextToken
        ? parseInt(cleaned.nextToken, 10) || 0
        : 0;

    if (offset < 0) {
      return res.status(400).json({
        error: 'Invalid offset',
        message: 'offset must be >= 0',
        status: 400
      });
    }

    let allRecords = [];

    if (userId) {
      // Filter by specific user - need to get both payer and beneficiary transactions
      const userRecords = await ScyllaDb.query(
        TokenManager.TABLES.TOKEN_REGISTRY,
        "userId = :uid",
        { ":uid": userId },
        { IndexName: TokenManager.INDEXES.USER_ID_CREATED_AT }
      );
      
      // Also get transactions where user is beneficiary (for TIPs, CAPTURED HOLDs, etc.)
      const beneficiaryRecords = await ScyllaDb.query(
        TokenManager.TABLES.TOKEN_REGISTRY,
        "beneficiaryId = :bid",
        { ":bid": userId },
        { IndexName: TokenManager.INDEXES.BENEFICIARY_ID_CREATED_AT }
      );
      
      // Combine and deduplicate by id
      const allUserRecords = [...userRecords, ...beneficiaryRecords];
      const uniqueRecords = Array.from(
        new Map(allUserRecords.map(tx => [tx.id, tx])).values()
      );
      allRecords = uniqueRecords;
    } else {
      // Get all records (for admin view)
      allRecords = await ScyllaDb.scan(TokenManager.TABLES.TOKEN_REGISTRY);
    }

    // Aggregate balances
    const userBalances = aggregateUserBalances(allRecords);

    // Apply search filter on userId (substring match, case-insensitive)
    let filteredBalances = userBalances;
    if (search) {
      const s = search.toLowerCase();
      filteredBalances = filteredBalances.filter((u) =>
        String(u.userId || "").toLowerCase().includes(s)
      );
    }
    // Apply exact userId match if provided (takes precedence)
    if (userId) {
      filteredBalances = filteredBalances.filter((u) => u.userId === userId);
    }

    // Apply pagination
    const total = filteredBalances.length;
    const paginated = filteredBalances.slice(offset, offset + limit);
    const items = paginated.map((u) => ({
      userId: u.userId,
      paidTokens: u.paidTokens,
      systemFreeTokens: u.systemFreeTokens,
      creatorFreeTokens: u.creatorFreeTokens,
      // Aliases for admin UI contract
      paidBalance: u.paidTokens,
      freeSystemBalance: u.systemFreeTokens,
      freeCreatorBalance: u.creatorFreeTokens,
      expiry: null, // aggregated list has no single expiry
    }));

    const nextToken =
      offset + limit < total ? String(offset + limit) : null;

    res.json({
      items,
      nextToken,
      total,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /user-tokens/count
 * Get count of user token records (admin-spec: { total })
 */
async function count(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      q: { value: req.query.q, type: "string", required: false },
      userId: { value: req.query.userId, type: "string", required: false },
    });

    const search = cleaned.q ? String(cleaned.q).trim() : null;
    const userId = cleaned.userId ? String(cleaned.userId).trim() : null;

    let allRecords = [];

    if (userId) {
      // Filter by specific user - need to get both payer and beneficiary transactions
      const userRecords = await ScyllaDb.query(
        TokenManager.TABLES.TOKEN_REGISTRY,
        "userId = :uid",
        { ":uid": userId },
        { IndexName: TokenManager.INDEXES.USER_ID_CREATED_AT }
      );
      
      // Also get transactions where user is beneficiary (for TIPs, CAPTURED HOLDs, etc.)
      const beneficiaryRecords = await ScyllaDb.query(
        TokenManager.TABLES.TOKEN_REGISTRY,
        "beneficiaryId = :bid",
        { ":bid": userId },
        { IndexName: TokenManager.INDEXES.BENEFICIARY_ID_CREATED_AT }
      );
      
      // Combine and deduplicate by id
      const allUserRecords = [...userRecords, ...beneficiaryRecords];
      const uniqueRecords = Array.from(
        new Map(allUserRecords.map(tx => [tx.id, tx])).values()
      );
      allRecords = uniqueRecords;
    } else {
      // Get all records
      allRecords = await ScyllaDb.scan(TokenManager.TABLES.TOKEN_REGISTRY);
    }

    // Aggregate to get unique users
    const userBalances = aggregateUserBalances(allRecords);
    let filteredBalances = userBalances;
    if (search) {
      const s = search.toLowerCase();
      filteredBalances = filteredBalances.filter((u) =>
        String(u.userId || "").toLowerCase().includes(s)
      );
    }
    if (userId) {
      filteredBalances = filteredBalances.filter((u) => u.userId === userId);
    }
    const total = filteredBalances.length;

    res.json({
      total,
      // Keep legacy field name for any existing callers/tests
      count: total,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /user-tokens/creator-free-tokens
 * Raw creator free token grants used by admin UI to build
 * "Free (Creator) Balance – Active Grants" summary.
 */
async function listCreatorFreeTokens(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      creatorId: { value: req.query.creatorId, type: "string", required: false },
    });

    const creatorIdFilter = cleaned.creatorId || null;

    // For now, we scan the registry and filter in memory. This is acceptable
    // for admin/test environments and keeps the implementation simple.
    const allRecords = await ScyllaDb.scan(TokenManager.TABLES.TOKEN_REGISTRY);

    const items = allRecords
      .filter((tx) => tx.transactionType === TokenManager.TRANSACTION_TYPES.CREDIT_FREE)
      .filter((tx) => {
        const creatorId = tx.beneficiaryId;
        if (!creatorId || creatorId === TokenManager.SYSTEM_BENEFICIARY_ID) {
          return false;
        }
        if (creatorIdFilter && creatorId !== creatorIdFilter) {
          return false;
        }
        return true;
      })
      .map((tx) => ({
        userId: tx.userId,
        creatorId: tx.beneficiaryId,
        balance: tx.amount || 0,
        expiry: tx.expiresAt || null,
        // Optional source field – try metadata.source then purpose
        source: (() => {
          const metadata = tx.metadata
            ? (typeof tx.metadata === 'string'
                ? (() => {
                    try {
                      return JSON.parse(tx.metadata);
                    } catch {
                      return null;
                    }
                  })()
                : tx.metadata)
            : null;
          if (metadata && metadata.source) {
            return metadata.source;
          }
          return tx.purpose || null;
        })(),
      }));

    res.json(items);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  count,
  listCreatorFreeTokens,
  /**
   * GET /user-tokens/:userId/drilldown
   * Thin wrapper around TokenManager.getUserBalanceWithDrilldown(userId)
   * that returns the object in ADMIN_APIS.md §1.2.
   */
  async drilldown(req, res, next) {
    try {
      const cleaned = SafeUtils.sanitizeValidate({
        userId: { value: req.params.userId, type: "string", required: true },
      });

      const result = await TokenManager.getUserBalanceWithDrilldown(cleaned.userId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
};
