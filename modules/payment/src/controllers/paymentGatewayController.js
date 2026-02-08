const paymentGatewayService = require('../services/paymentGatewayService.js');
const ScyllaDb = require('../utils/ScyllaDb');
const SafeUtils = require('../../../../utils/SafeUtils');
const DateTime = require('../utils/DateTime');

const TABLES = {
  SESSIONS: 'paymentGateway_sessions',
  TRANSACTIONS: 'paymentGateway_transactions',
  SCHEDULES: 'paymentGateway_schedules',
  TOKENS: 'paymentGateway_tokens',
  WEBHOOKS: 'paymentGateway_webhooks',
};

/**
 * Normalize and validate common pagination query params.
 */
function getPaginationParams(req) {
  const cleaned = SafeUtils.sanitizeValidate({
    limit: { value: req.query.limit, type: 'int', required: false },
    offset: { value: req.query.offset, type: 'int', required: false },
  });

  const limit =
    cleaned.limit !== undefined && cleaned.limit !== null ? cleaned.limit : 20;
  const offset =
    cleaned.offset !== undefined && cleaned.offset !== null ? cleaned.offset : 0;

  if (limit < 1 || limit > 1000) {
    const err = new Error('limit must be between 1 and 1000');
    err.status = 400;
    throw err;
  }
  if (offset < 0) {
    const err = new Error('offset must be >= 0');
    err.status = 400;
    throw err;
  }

  return { limit, offset };
}

function toTs(value, endOfDay = false) {
  if (!value) return null;
  let v = String(value);
  if (endOfDay && !v.includes('T')) v = `${v}T23:59:59.999Z`;
  return DateTime.parseDateToTimestamp(v);
}

function sortByCreatedDesc(items) {
  items.sort((a, b) => {
    const aTime = DateTime.parseDateToTimestamp(a.createdAt || a.created_at || DateTime.now());
    const bTime = DateTime.parseDateToTimestamp(b.createdAt || b.created_at || DateTime.now());
    return bTime - aTime;
  });
  return items;
}

/**
 * GET /payment-sessions
 */
async function listSessions(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: req.query.userId, type: 'string', required: false },
      orderId: { value: req.query.orderId, type: 'string', required: false },
      sessionType: { value: req.query.sessionType, type: 'string', required: false },
      status: { value: req.query.status, type: 'string', required: false },
      from: { value: req.query.from, type: 'string', required: false },
      to: { value: req.query.to, type: 'string', required: false },
    });

    const { limit, offset } = getPaginationParams(req);

    let sessions = await ScyllaDb.scan(TABLES.SESSIONS);

    if (cleaned.userId) {
      const v = String(cleaned.userId).toLowerCase();
      sessions = sessions.filter((s) => String(s.userId || '').toLowerCase().includes(v));
    }
    if (cleaned.orderId) {
      const v = String(cleaned.orderId).toLowerCase();
      sessions = sessions.filter((s) =>
        String(s.orderId || s.order_id || s.checkoutId || '').toLowerCase().includes(v)
      );
    }
    if (cleaned.sessionType) {
      const v = String(cleaned.sessionType).toLowerCase();
      sessions = sessions.filter((s) => String(s.sessionType || '').toLowerCase() === v);
    }
    if (cleaned.status) {
      const v = String(cleaned.status).toLowerCase();
      sessions = sessions.filter((s) => String(s.status || '').toLowerCase() === v);
    }
    if (cleaned.from) {
      const from = toTs(cleaned.from, false);
      sessions = sessions.filter((s) => toTs(s.createdAt || s.created_at) >= from);
    }
    if (cleaned.to) {
      const to = toTs(cleaned.to, true);
      sessions = sessions.filter((s) => toTs(s.createdAt || s.created_at) <= to);
    }

    sortByCreatedDesc(sessions);

    const total = sessions.length;
    const items = sessions.slice(offset, offset + limit);

    res.json({
      items,
      total,
      nextCursor: offset + limit < total ? offset + limit : null,
      prevCursor: offset > 0 ? Math.max(0, offset - limit) : null,
    });
  } catch (err) {
    next(err);
  }
}

async function countSessions(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: req.query.userId, type: 'string', required: false },
      orderId: { value: req.query.orderId, type: 'string', required: false },
      sessionType: { value: req.query.sessionType, type: 'string', required: false },
      status: { value: req.query.status, type: 'string', required: false },
      from: { value: req.query.from, type: 'string', required: false },
      to: { value: req.query.to, type: 'string', required: false },
    });

    let sessions = await ScyllaDb.scan(TABLES.SESSIONS);
    if (cleaned.userId) {
      const v = String(cleaned.userId).toLowerCase();
      sessions = sessions.filter((s) => String(s.userId || '').toLowerCase().includes(v));
    }
    if (cleaned.orderId) {
      const v = String(cleaned.orderId).toLowerCase();
      sessions = sessions.filter((s) =>
        String(s.orderId || s.order_id || s.checkoutId || '').toLowerCase().includes(v)
      );
    }
    if (cleaned.sessionType) {
      const v = String(cleaned.sessionType).toLowerCase();
      sessions = sessions.filter((s) => String(s.sessionType || '').toLowerCase() === v);
    }
    if (cleaned.status) {
      const v = String(cleaned.status).toLowerCase();
      sessions = sessions.filter((s) => String(s.status || '').toLowerCase() === v);
    }
    if (cleaned.from) {
      const from = toTs(cleaned.from, false);
      sessions = sessions.filter((s) => toTs(s.createdAt || s.created_at) >= from);
    }
    if (cleaned.to) {
      const to = toTs(cleaned.to, true);
      sessions = sessions.filter((s) => toTs(s.createdAt || s.created_at) <= to);
    }
    const total = sessions.length;
    res.json({ total, count: total });
  } catch (err) {
    next(err);
  }
}

async function getAxcessSession(req, res, next) {
  try {
    const id = String(req.params.id || '').trim();
    const sessions = await ScyllaDb.scan(TABLES.SESSIONS);
    const match = sessions.find((s) =>
      s.id === id ||
      s.checkoutId === id ||
      s.orderId === id ||
      s.order_id === id
    );
    if (!match) {
      return res.status(404).json({
        error: 'Session not found',
        message: `No payment session found for id ${id}`,
        status: 404,
      });
    }
    res.json(match);
  } catch (err) {
    next(err);
  }
}

async function listFailedTransactions(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      from: { value: req.query.from, type: 'string', required: false },
      to: { value: req.query.to, type: 'string', required: false },
    });

    let startDate = cleaned.from || null;
    let endDate = cleaned.to || null;

    if (startDate && !startDate.includes('T')) {
      startDate = DateTime.formatDate(startDate, DateTime.FORMATS.ISO_DATETIME_TZ);
    }
    if (endDate && !endDate.includes('T')) {
      endDate = `${endDate}T23:59:59.999Z`;
    }

    const transactions =
      await paymentGatewayService.get_failed_transactions(startDate, endDate);

    const { limit, offset } = getPaginationParams(req);
    const total = transactions.length;
    const items = transactions.slice(offset, offset + limit);

    res.json({
      items,
      total,
      nextCursor: offset + limit < total ? offset + limit : null,
      prevCursor: offset > 0 ? Math.max(0, offset - limit) : null,
    });
  } catch (err) {
    next(err);
  }
}

async function listOrderWebhooks(req, res, next) {
  try {
    const { orderId } = req.params;
    const webhooks = await paymentGatewayService.get_order_webhooks(orderId);
    res.json({ items: webhooks, total: webhooks.length });
  } catch (err) {
    next(err);
  }
}

async function listSubscriptionWebhooks(req, res, next) {
  try {
    const { subscriptionId } = req.params;
    const webhooks =
      await paymentGatewayService.get_subscription_webhooks(subscriptionId);
    res.json({ items: webhooks, total: webhooks.length });
  } catch (err) {
    next(err);
  }
}

async function listTransactions(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: req.query.userId, type: 'string', required: false },
      beneficiaryId: { value: req.query.beneficiaryId, type: 'string', required: false },
      orderType: { value: req.query.orderType, type: 'string', required: false },
      status: { value: req.query.status, type: 'string', required: false },
      referenceId: { value: req.query.referenceId, type: 'string', required: false },
      from: { value: req.query.from, type: 'string', required: false },
      to: { value: req.query.to, type: 'string', required: false },
    });

    const { limit, offset } = getPaginationParams(req);

    let txns = await ScyllaDb.scan(TABLES.TRANSACTIONS);
    if (cleaned.userId) {
      const v = String(cleaned.userId).toLowerCase();
      txns = txns.filter((t) => String(t.userId || '').toLowerCase().includes(v));
    }
    if (cleaned.beneficiaryId) {
      const v = String(cleaned.beneficiaryId).toLowerCase();
      txns = txns.filter((t) =>
        String(t.beneficiaryId || t.recipientId || '').toLowerCase().includes(v)
      );
    }
    if (cleaned.orderType) {
      const v = String(cleaned.orderType).toLowerCase();
      txns = txns.filter((t) =>
        String(t.orderType || t.transactionType || '').toLowerCase() === v
      );
    }
    if (cleaned.status) {
      const v = String(cleaned.status).toLowerCase();
      txns = txns.filter((t) => String(t.status || '').toLowerCase() === v);
    }
    if (cleaned.referenceId) {
      const v = String(cleaned.referenceId).toLowerCase();
      txns = txns.filter((t) =>
        String(t.orderId || t.transactionId || '').toLowerCase().includes(v)
      );
    }
    if (cleaned.from) {
      const from = toTs(cleaned.from, false);
      txns = txns.filter((t) => toTs(t.createdAt || t.created_at) >= from);
    }
    if (cleaned.to) {
      const to = toTs(cleaned.to, true);
      txns = txns.filter((t) => toTs(t.createdAt || t.created_at) <= to);
    }

    sortByCreatedDesc(txns);
    const seen = new Set();
    const deduped = txns.filter((t) => {
      const id = t.transactionId || t.sk;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const total = deduped.length;
    const items = deduped.slice(offset, offset + limit);

    res.json({
      items,
      total,
      nextCursor: offset + limit < total ? offset + limit : null,
      prevCursor: offset > 0 ? Math.max(0, offset - limit) : null,
    });
  } catch (err) {
    next(err);
  }
}

async function countTransactions(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: req.query.userId, type: 'string', required: false },
      beneficiaryId: { value: req.query.beneficiaryId, type: 'string', required: false },
      orderType: { value: req.query.orderType, type: 'string', required: false },
      status: { value: req.query.status, type: 'string', required: false },
      referenceId: { value: req.query.referenceId, type: 'string', required: false },
      from: { value: req.query.from, type: 'string', required: false },
      to: { value: req.query.to, type: 'string', required: false },
    });
    let txns = await ScyllaDb.scan(TABLES.TRANSACTIONS);
    if (cleaned.userId) {
      const v = String(cleaned.userId).toLowerCase();
      txns = txns.filter((t) => String(t.userId || '').toLowerCase().includes(v));
    }
    if (cleaned.beneficiaryId) {
      const v = String(cleaned.beneficiaryId).toLowerCase();
      txns = txns.filter((t) =>
        String(t.beneficiaryId || t.recipientId || '').toLowerCase().includes(v)
      );
    }
    if (cleaned.orderType) {
      const v = String(cleaned.orderType).toLowerCase();
      txns = txns.filter((t) =>
        String(t.orderType || t.transactionType || '').toLowerCase() === v
      );
    }
    if (cleaned.status) {
      const v = String(cleaned.status).toLowerCase();
      txns = txns.filter((t) => String(t.status || '').toLowerCase() === v);
    }
    if (cleaned.referenceId) {
      const v = String(cleaned.referenceId).toLowerCase();
      txns = txns.filter((t) =>
        String(t.orderId || t.transactionId || '').toLowerCase().includes(v)
      );
    }
    if (cleaned.from) {
      const from = toTs(cleaned.from, false);
      txns = txns.filter((t) => toTs(t.createdAt || t.created_at) >= from);
    }
    if (cleaned.to) {
      const to = toTs(cleaned.to, true);
      txns = txns.filter((t) => toTs(t.createdAt || t.created_at) <= to);
    }
    const seen = new Set();
    const deduped = txns.filter((t) => {
      const id = t.transactionId || t.sk;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const total = deduped.length;
    res.json({ total, count: total });
  } catch (err) {
    next(err);
  }
}

async function listSchedules(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: req.query.userId, type: 'string', required: false },
      referenceId: { value: req.query.referenceId, type: 'string', required: false },
      frequency: { value: req.query.frequency, type: 'string', required: false },
      status: { value: req.query.status, type: 'string', required: false },
      from: { value: req.query.from, type: 'string', required: false },
      to: { value: req.query.to, type: 'string', required: false },
    });

    const { limit, offset } = getPaginationParams(req);
    let schedules = await ScyllaDb.scan(TABLES.SCHEDULES);
    if (cleaned.userId) {
      const v = String(cleaned.userId).toLowerCase();
      schedules = schedules.filter((s) => String(s.userId || '').toLowerCase().includes(v));
    }
    if (cleaned.referenceId) {
      const v = String(cleaned.referenceId).toLowerCase();
      schedules = schedules.filter((s) =>
        String(s.orderId || s.subscriptionId || s.registrationId || '').toLowerCase().includes(v)
      );
    }
    if (cleaned.frequency) {
      const v = String(cleaned.frequency).toLowerCase();
      schedules = schedules.filter((s) => String(s.frequency || s.schedule || '').toLowerCase() === v);
    }
    if (cleaned.status) {
      const v = String(cleaned.status).toLowerCase();
      schedules = schedules.filter((s) => String(s.status || '').toLowerCase() === v);
    }
    if (cleaned.from) {
      const from = toTs(cleaned.from, false);
      schedules = schedules.filter((s) => toTs(s.createdAt || s.startDate) >= from);
    }
    if (cleaned.to) {
      const to = toTs(cleaned.to, true);
      schedules = schedules.filter((s) => toTs(s.createdAt || s.nextScheduleDate) <= to);
    }

    sortByCreatedDesc(schedules);

    const total = schedules.length;
    const items = schedules.slice(offset, offset + limit).map((s) => ({
      ...s,
      subscriptionId: s.subscriptionId || s.scheduleId,
      frequency: s.frequency || s.schedule,
    }));

    res.json({
      items,
      total,
      nextCursor: offset + limit < total ? offset + limit : null,
      prevCursor: offset > 0 ? Math.max(0, offset - limit) : null,
    });
  } catch (err) {
    next(err);
  }
}

async function countSchedules(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: req.query.userId, type: 'string', required: false },
      referenceId: { value: req.query.referenceId, type: 'string', required: false },
      frequency: { value: req.query.frequency, type: 'string', required: false },
      status: { value: req.query.status, type: 'string', required: false },
      from: { value: req.query.from, type: 'string', required: false },
      to: { value: req.query.to, type: 'string', required: false },
    });
    let schedules = await ScyllaDb.scan(TABLES.SCHEDULES);
    if (cleaned.userId) {
      const v = String(cleaned.userId).toLowerCase();
      schedules = schedules.filter((s) => String(s.userId || '').toLowerCase().includes(v));
    }
    if (cleaned.referenceId) {
      const v = String(cleaned.referenceId).toLowerCase();
      schedules = schedules.filter((s) =>
        String(s.orderId || s.subscriptionId || s.registrationId || '').toLowerCase().includes(v)
      );
    }
    if (cleaned.frequency) {
      const v = String(cleaned.frequency).toLowerCase();
      schedules = schedules.filter((s) => String(s.frequency || s.schedule || '').toLowerCase() === v);
    }
    if (cleaned.status) {
      const v = String(cleaned.status).toLowerCase();
      schedules = schedules.filter((s) => String(s.status || '').toLowerCase() === v);
    }
    if (cleaned.from) {
      const from = toTs(cleaned.from, false);
      schedules = schedules.filter((s) => toTs(s.createdAt || s.startDate) >= from);
    }
    if (cleaned.to) {
      const to = toTs(cleaned.to, true);
      schedules = schedules.filter((s) => toTs(s.createdAt || s.nextScheduleDate) <= to);
    }
    const total = schedules.length;
    res.json({ total, count: total });
  } catch (err) {
    next(err);
  }
}

async function listTokens(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: req.query.userId, type: 'string', required: false },
      registrationId: { value: req.query.registrationId, type: 'string', required: false },
      type: { value: req.query.type, type: 'string', required: false },
      status: { value: req.query.status, type: 'string', required: false },
      from: { value: req.query.from, type: 'string', required: false },
      to: { value: req.query.to, type: 'string', required: false },
    });

    const { limit, offset } = getPaginationParams(req);
    let tokens = await ScyllaDb.scan(TABLES.TOKENS);
    if (cleaned.userId) {
      const v = String(cleaned.userId).toLowerCase();
      tokens = tokens.filter((t) => String(t.userId || '').toLowerCase().includes(v));
    }
    if (cleaned.registrationId) {
      const v = String(cleaned.registrationId).toLowerCase();
      tokens = tokens.filter((t) => String(t.registrationId || t.id || '').toLowerCase().includes(v));
    }
    if (cleaned.type) {
      const v = String(cleaned.type).toLowerCase();
      tokens = tokens.filter((t) => String(t.type || '').toLowerCase() === v);
    }
    if (cleaned.status) {
      const v = String(cleaned.status).toLowerCase();
      tokens = tokens.filter((t) => String(t.status || '').toLowerCase() === v);
    }
    if (cleaned.from) {
      const from = toTs(cleaned.from, false);
      tokens = tokens.filter((t) => toTs(t.createdAt) >= from);
    }
    if (cleaned.to) {
      const to = toTs(cleaned.to, true);
      tokens = tokens.filter((t) => toTs(t.createdAt) <= to);
    }

    sortByCreatedDesc(tokens);
    const total = tokens.length;
    const items = tokens.slice(offset, offset + limit).map((t) => ({
      ...t,
      name: t.name || t.cardHolder || t.cardHolderName || null,
    }));

    res.json({
      items,
      total,
      nextCursor: offset + limit < total ? offset + limit : null,
      prevCursor: offset > 0 ? Math.max(0, offset - limit) : null,
    });
  } catch (err) {
    next(err);
  }
}

async function countTokens(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: req.query.userId, type: 'string', required: false },
      registrationId: { value: req.query.registrationId, type: 'string', required: false },
      type: { value: req.query.type, type: 'string', required: false },
      status: { value: req.query.status, type: 'string', required: false },
      from: { value: req.query.from, type: 'string', required: false },
      to: { value: req.query.to, type: 'string', required: false },
    });
    let tokens = await ScyllaDb.scan(TABLES.TOKENS);
    if (cleaned.userId) {
      const v = String(cleaned.userId).toLowerCase();
      tokens = tokens.filter((t) => String(t.userId || '').toLowerCase().includes(v));
    }
    if (cleaned.registrationId) {
      const v = String(cleaned.registrationId).toLowerCase();
      tokens = tokens.filter((t) => String(t.registrationId || t.id || '').toLowerCase().includes(v));
    }
    if (cleaned.type) {
      const v = String(cleaned.type).toLowerCase();
      tokens = tokens.filter((t) => String(t.type || '').toLowerCase() === v);
    }
    if (cleaned.status) {
      const v = String(cleaned.status).toLowerCase();
      tokens = tokens.filter((t) => String(t.status || '').toLowerCase() === v);
    }
    if (cleaned.from) {
      const from = toTs(cleaned.from, false);
      tokens = tokens.filter((t) => toTs(t.createdAt) >= from);
    }
    if (cleaned.to) {
      const to = toTs(cleaned.to, true);
      tokens = tokens.filter((t) => toTs(t.createdAt) <= to);
    }
    const total = tokens.length;
    res.json({ total, count: total });
  } catch (err) {
    next(err);
  }
}

async function listWebhooks(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      orderId: { value: req.query.orderId, type: 'string', required: false },
      actionTaken: { value: req.query.actionTaken, type: 'string', required: false },
      handled: { value: req.query.handled, type: 'string', required: false },
      from: { value: req.query.from, type: 'string', required: false },
      to: { value: req.query.to, type: 'string', required: false },
    });

    const { limit, offset } = getPaginationParams(req);
    let webhooks = await ScyllaDb.scan(TABLES.WEBHOOKS);
    if (cleaned.orderId) {
      const v = String(cleaned.orderId).toLowerCase();
      webhooks = webhooks.filter((w) =>
        String(w.orderId || w.idempotencyKey || '').toLowerCase().includes(v)
      );
    }
    if (cleaned.actionTaken) {
      const v = String(cleaned.actionTaken).toLowerCase();
      webhooks = webhooks.filter((w) => String(w.actionTaken || '').toLowerCase() === v);
    }
    if (cleaned.handled !== undefined && cleaned.handled !== null && cleaned.handled !== '') {
      const handledVal = String(cleaned.handled) === 'true';
      webhooks = webhooks.filter((w) => w.handled === handledVal);
    }
    if (cleaned.from) {
      const from = toTs(cleaned.from, false);
      webhooks = webhooks.filter((w) => toTs(w.createdAt) >= from);
    }
    if (cleaned.to) {
      const to = toTs(cleaned.to, true);
      webhooks = webhooks.filter((w) => toTs(w.createdAt) <= to);
    }

    sortByCreatedDesc(webhooks);

    const total = webhooks.length;
    const items = webhooks.slice(offset, offset + limit);

    res.json({
      items,
      total,
      nextCursor: offset + limit < total ? offset + limit : null,
      prevCursor: offset > 0 ? Math.max(0, offset - limit) : null,
    });
  } catch (err) {
    next(err);
  }
}

async function countWebhooks(req, res, next) {
  try {
    const cleaned = SafeUtils.sanitizeValidate({
      orderId: { value: req.query.orderId, type: 'string', required: false },
      actionTaken: { value: req.query.actionTaken, type: 'string', required: false },
      handled: { value: req.query.handled, type: 'string', required: false },
      from: { value: req.query.from, type: 'string', required: false },
      to: { value: req.query.to, type: 'string', required: false },
    });
    let webhooks = await ScyllaDb.scan(TABLES.WEBHOOKS);
    if (cleaned.orderId) {
      const v = String(cleaned.orderId).toLowerCase();
      webhooks = webhooks.filter((w) =>
        String(w.orderId || w.idempotencyKey || '').toLowerCase().includes(v)
      );
    }
    if (cleaned.actionTaken) {
      const v = String(cleaned.actionTaken).toLowerCase();
      webhooks = webhooks.filter((w) => String(w.actionTaken || '').toLowerCase() === v);
    }
    if (cleaned.handled !== undefined && cleaned.handled !== null && cleaned.handled !== '') {
      const handledVal = String(cleaned.handled) === 'true';
      webhooks = webhooks.filter((w) => w.handled === handledVal);
    }
    if (cleaned.from) {
      const from = toTs(cleaned.from, false);
      webhooks = webhooks.filter((w) => toTs(w.createdAt) >= from);
    }
    if (cleaned.to) {
      const to = toTs(cleaned.to, true);
      webhooks = webhooks.filter((w) => toTs(w.createdAt) <= to);
    }
    const total = webhooks.length;
    res.json({ total, count: total });
  } catch (err) {
    next(err);
  }
}

async function getAxcessTransaction(req, res, next) {
  try {
    const id = String(req.params.id || '').trim();
    const txns = await ScyllaDb.scan(TABLES.TRANSACTIONS);
    const match = txns.find((t) =>
      t.transactionId === id ||
      t.gatewayTxnId === id ||
      t.id === id
    );
    if (!match) {
      return res.status(404).json({
        error: 'Transaction not found',
        message: `No payment transaction found for id ${id}`,
        status: 404,
      });
    }
    res.json(match);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listSessions,
  countSessions,
  getAxcessSession,
  listTransactions,
  countTransactions,
  getAxcessTransaction,
  listSchedules,
  countSchedules,
  listTokens,
  countTokens,
  listWebhooks,
  countWebhooks,
  listFailedTransactions,
  listOrderWebhooks,
  listSubscriptionWebhooks,
};
