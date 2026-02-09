const TokenManager = require('../services/TokenManager');
const ScyllaDb = require('../utils/ScyllaDb');
const DateTime = require('../utils/DateTime');
const SafeUtils = require('../../../../utils/SafeUtils');

/** Purpose values used for user-tokens/creator-free seed only; excluded from token-registry list so list matches sales-registry/data.json (24 rows). */
const TOKEN_REGISTRY_EXCLUDED_PURPOSES = ['balance_seed', 'creator_grant'];

/**
 * Apply combined filters to TokenRegistry records (AND logic).
 * Matches ADMIN_APIS.md + frontend `sales-registry` filters:
 * - payee        → tx.userId (substring, case-insensitive)
 * - beneficiary  → tx.beneficiaryId (substring, case-insensitive)
 * - type         → tx.transactionType (exact, case-insensitive)
 * - state        → tx.state (exact, case-insensitive)
 * - refId        → tx.refId (substring, case-insensitive)
 * - purpose      → tx.purpose (substring, case-insensitive)
 * - from/to      → createdAt range (inclusive; to supports date-only)
 * - Excludes internal seed rows (balance_seed, creator_grant) so list matches sales-registry data.json.
 */
function applyFilters(records, filters) {
  let filtered = [...records];

  // Exclude internal seed rows so token-registry list/count match sales-registry (24 transactions).
  filtered = filtered.filter((tx) => {
    const p = String(tx.purpose || '').toLowerCase();
    return !TOKEN_REGISTRY_EXCLUDED_PURPOSES.includes(p);
  });

  if (filters.payee) {
    const v = String(filters.payee).toLowerCase();
    filtered = filtered.filter((tx) =>
      String(tx.userId || "").toLowerCase().includes(v)
    );
  }

  if (filters.beneficiary) {
    const v = String(filters.beneficiary).toLowerCase();
    filtered = filtered.filter((tx) =>
      String(tx.beneficiaryId || "").toLowerCase().includes(v)
    );
  }

  if (filters.state) {
    const s = String(filters.state).toLowerCase();
    filtered = filtered.filter((tx) => String(tx.state || "").toLowerCase() === s);
  }

  if (filters.type) {
    const t = String(filters.type).toLowerCase();
    filtered = filtered.filter(
      (tx) => String(tx.transactionType || "").toLowerCase() === t
    );
  }

  if (filters.refId) {
    const v = String(filters.refId).toLowerCase();
    filtered = filtered.filter((tx) =>
      String(tx.refId || "").toLowerCase().includes(v)
    );
  }

  if (filters.purpose) {
    const v = String(filters.purpose).toLowerCase();
    filtered = filtered.filter((tx) =>
      String(tx.purpose || "").toLowerCase().includes(v)
    );
  }

  if (filters.from) {
    const fromTs = DateTime.parseDateToTimestamp(filters.from);
    filtered = filtered.filter((tx) => {
      const txDate = DateTime.parseDateToTimestamp(tx.createdAt);
      return txDate >= fromTs;
    });
  }

  if (filters.to) {
    let toValue = String(filters.to);
    if (!toValue.includes("T")) {
      toValue = `${toValue}T23:59:59.999Z`;
    }
    const toTs = DateTime.parseDateToTimestamp(toValue);
    filtered = filtered.filter((tx) => {
      const txDate = DateTime.parseDateToTimestamp(tx.createdAt);
      return txDate <= toTs;
    });
  }

  return filtered;
}

/**
 * Parse metadata if it's a JSON string
 */
function parseMetadata(metadata) {
  if (!metadata) return null;
  if (typeof metadata === 'object') return metadata;
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata);
    } catch {
      return metadata; // Return as string if not valid JSON
    }
  }
  return metadata;
}

/**
 * Transform transaction record to admin API format
 * Includes aliases (created, type, payeeId) and metadata.rawPayload for View modal.
 * Uses fallbacks for records with alternate/missing field names (e.g. from different test data).
 */
function transformTransaction(tx) {
  const metadata = parseMetadata(tx.metadata);
  const createdAt = tx.createdAt ?? tx.created;
  const transactionType = tx.transactionType ?? tx.type;
  const userId = tx.userId ?? tx.payeeId;

  const rawPayload = {
    id: tx.id,
    userId,
    beneficiaryId: tx.beneficiaryId || null,
    amount: tx.amount || 0,
    createdAt,
    state: tx.state || null,
    transactionType,
    purpose: tx.purpose || null,
    refId: tx.refId || null,
    expiresAt: tx.expiresAt || null,
    version: tx.version || 1,
    metadata,
  };

  return {
    id: tx.id,
    userId,
    beneficiaryId: tx.beneficiaryId || null,
    transactionType,
    amount: tx.amount || 0,
    purpose: tx.purpose || null,
    refId: tx.refId || null,
    expiresAt: tx.expiresAt || null,
    createdAt,
    state: tx.state || null,
    version: tx.version || 1,
    freeBeneficiaryConsumed: tx.freeBeneficiaryConsumed || 0,
    freeSystemConsumed: tx.freeSystemConsumed || 0,
    // Aliases for admin UI contract (always present; use fallback when primary field missing)
    created: createdAt ?? new Date(0).toISOString(),
    type: transactionType ?? null,
    payeeId: userId ?? null,
    metadata: { ...(metadata || {}), rawPayload },
  };
}

/**
 * GET /token-registry
 * List token registry transactions with combined filters and pagination
 */
async function list(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      payee: { value: req.query.payee, type: "string", required: false },
      beneficiary: { value: req.query.beneficiary, type: "string", required: false },
      state: { value: req.query.state, type: "string", required: false },
      type: { value: req.query.type, type: "string", required: false },
      // UI/contract uses refId; keep referenceId for backward compat
      refId: { value: req.query.refId, type: "string", required: false },
      referenceId: { value: req.query.referenceId, type: "string", required: false },
      purpose: { value: req.query.purpose, type: "string", required: false },
      from: { value: req.query.from, type: "string", required: false },
      to: { value: req.query.to, type: "string", required: false },
      limit: { value: req.query.limit, type: "int", required: false },
      // Cursor-based pagination: opaque nextToken representing an integer offset
      nextToken: { value: req.query.nextToken, type: "string", required: false },
      // Offset-based pagination (PageRenderer default)
      offset: { value: req.query.offset, type: "int", required: false },
    });

    // Validate pagination parameters before applying default (so limit=0 returns 400)
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

    // Validate date formats if provided (parseDateToTimestamp returns false on invalid)
    if (cleaned.from) {
      const fromTs = DateTime.parseDateToTimestamp(cleaned.from);
      if (fromTs === false) {
        return res.status(400).json({
          error: 'Invalid from',
          message: 'from must be a valid ISO 8601 date/datetime string',
          status: 400
        });
      }
    }

    if (cleaned.to) {
      const toValue = cleaned.to.includes('T')
        ? cleaned.to
        : `${cleaned.to}T23:59:59.999Z`;
      const toTs = DateTime.parseDateToTimestamp(toValue);
      if (toTs === false) {
        return res.status(400).json({
          error: 'Invalid to',
          message: 'to must be a valid ISO 8601 date/datetime string',
          status: 400
        });
      }
    }

    // Optimize: Use indexed queries when we have specific filters
    // All filters are combined in a single operation (ANDed together)
    let allRecords = [];

    // If we have payee only, use indexed query
    if (cleaned.payee && !cleaned.beneficiary && !cleaned.referenceId && !cleaned.purpose) {
      try {
        allRecords = await ScyllaDb.query(
          TokenManager.TABLES.TOKEN_REGISTRY,
          "userId = :uid",
          { ":uid": cleaned.payee },
          { IndexName: TokenManager.INDEXES.USER_ID_CREATED_AT }
        );
      } catch (error) {
        // Fallback to scan if index query fails
        allRecords = await ScyllaDb.scan(TokenManager.TABLES.TOKEN_REGISTRY);
      }
    }
    // If we have beneficiary only, use indexed query
    else if (cleaned.beneficiary && !cleaned.payee && !cleaned.referenceId && !cleaned.purpose) {
      try {
        allRecords = await ScyllaDb.query(
          TokenManager.TABLES.TOKEN_REGISTRY,
          "beneficiaryId = :bid",
          { ":bid": cleaned.beneficiary },
          { IndexName: TokenManager.INDEXES.BENEFICIARY_ID_CREATED_AT }
        );
      } catch (error) {
        // Fallback to scan if index query fails
        allRecords = await ScyllaDb.scan(TokenManager.TABLES.TOKEN_REGISTRY);
      }
    }
    // Otherwise, scan all records (will be filtered in memory)
    else {
      allRecords = await ScyllaDb.scan(TokenManager.TABLES.TOKEN_REGISTRY);
    }

    // Apply combined filters
    const filters = {
      payee: cleaned.payee,
      beneficiary: cleaned.beneficiary,
      state: cleaned.state,
      type: cleaned.type,
      refId: cleaned.refId || cleaned.referenceId,
      purpose: cleaned.purpose,
      from: cleaned.from,
      to: cleaned.to,
    };

    const filtered = applyFilters(allRecords, filters);

    // Sort by createdAt descending (most recent first)
    filtered.sort((a, b) => {
      const aTime = DateTime.parseDateToTimestamp(a.createdAt || DateTime.now());
      const bTime = DateTime.parseDateToTimestamp(b.createdAt || DateTime.now());
      return bTime - aTime; // Descending
    });

    // Apply pagination
    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    // Transform to admin API format
    const items = paginated.map(transformTransaction);

    // Calculate opaque nextToken
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
 * GET /token-registry/count
 * Get count of token registry transactions matching filters
 * Returns comprehensive breakdowns for admin UI filter tabs
 */
async function count(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      payee: { value: req.query.payee, type: "string", required: false },
      beneficiary: { value: req.query.beneficiary, type: "string", required: false },
      state: { value: req.query.state, type: "string", required: false },
      type: { value: req.query.type, type: "string", required: false },
      refId: { value: req.query.refId, type: "string", required: false },
      referenceId: { value: req.query.referenceId, type: "string", required: false },
      purpose: { value: req.query.purpose, type: "string", required: false },
      from: { value: req.query.from, type: "string", required: false },
      to: { value: req.query.to, type: "string", required: false },
    });

    // Validate date formats if provided (parseDateToTimestamp returns false on invalid)
    if (cleaned.from) {
      const fromTs = DateTime.parseDateToTimestamp(cleaned.from);
      if (fromTs === false) {
        return res.status(400).json({
          error: 'Invalid from',
          message: 'from must be a valid ISO 8601 date/datetime string',
          status: 400
        });
      }
    }

    if (cleaned.to) {
      const toValue = cleaned.to.includes('T')
        ? cleaned.to
        : `${cleaned.to}T23:59:59.999Z`;
      const toTs = DateTime.parseDateToTimestamp(toValue);
      if (toTs === false) {
        return res.status(400).json({
          error: 'Invalid to',
          message: 'to must be a valid ISO 8601 date/datetime string',
          status: 400
        });
      }
    }

    // Optimize: Use indexed queries when we have specific filters
    let allRecords = [];

    // If we have payee only, use indexed query
    if (cleaned.payee && !cleaned.beneficiary && !cleaned.referenceId && !cleaned.purpose) {
      try {
        allRecords = await ScyllaDb.query(
          TokenManager.TABLES.TOKEN_REGISTRY,
          "userId = :uid",
          { ":uid": cleaned.payee },
          { IndexName: TokenManager.INDEXES.USER_ID_CREATED_AT }
        );
      } catch (error) {
        // Fallback to scan if index query fails
        allRecords = await ScyllaDb.scan(TokenManager.TABLES.TOKEN_REGISTRY);
      }
    }
    // If we have beneficiary only, use indexed query
    else if (cleaned.beneficiary && !cleaned.payee && !cleaned.referenceId && !cleaned.purpose) {
      try {
        allRecords = await ScyllaDb.query(
          TokenManager.TABLES.TOKEN_REGISTRY,
          "beneficiaryId = :bid",
          { ":bid": cleaned.beneficiary },
          { IndexName: TokenManager.INDEXES.BENEFICIARY_ID_CREATED_AT }
        );
      } catch (error) {
        // Fallback to scan if index query fails
        allRecords = await ScyllaDb.scan(TokenManager.TABLES.TOKEN_REGISTRY);
      }
    }
    // Otherwise, scan all records (will be filtered in memory)
    else {
      allRecords = await ScyllaDb.scan(TokenManager.TABLES.TOKEN_REGISTRY);
    }

    // Apply combined filters (all filters are ANDed together)
    const filters = {
      payee: cleaned.payee,
      beneficiary: cleaned.beneficiary,
      state: cleaned.state,
      type: cleaned.type,
      refId: cleaned.refId || cleaned.referenceId,
      purpose: cleaned.purpose,
      from: cleaned.from,
      to: cleaned.to,
    };

    const filtered = applyFilters(allRecords, filters);

    const total = filtered.length;

    // New admin-spec shape: minimal, list-and-count consistent
    res.json({
      total,
      // Keep legacy field for any existing tests/tools
      count: total,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /token-registry/:id
 * Get a single transaction by ID
 */
async function getById(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      id: { value: req.params.id, type: "string", required: true },
    });

    const transaction = await TokenManager.getTransactionById(cleaned.id);

    if (!transaction) {
      return res.status(404).json({
        error: 'Transaction not found',
        message: `Transaction with id ${cleaned.id} not found`,
        status: 404
      });
    }

    const transformed = transformTransaction(transaction);

    res.json(transformed);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  list,
  count,
  getById
};
