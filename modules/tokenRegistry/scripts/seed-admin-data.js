/**
 * Seed script for Admin API (token-registry, user-tokens, creator-free-tokens).
 * Data shape matches admin-development user-tokens and sales-registry data.json.
 *
 * Run with: NODE_ENV=test node scripts/seed-admin-data.js
 * (Ensure DynamoDB tables exist: run init-dynamo-tables.js first.)
 */

const crypto = require('crypto');
process.env.NODE_ENV = 'test';

const TokenManager = require('../src/services/TokenManager');
const ScyllaDb = require('../src/utils/ScyllaDb');

const TABLE = TokenManager.TABLES.TOKEN_REGISTRY;
const TYPES = TokenManager.TRANSACTION_TYPES;
const HOLD_STATES = TokenManager.HOLD_STATES;
const SYSTEM = TokenManager.SYSTEM_BENEFICIARY_ID;

function uniqueId(prefix = 'txn') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

async function seed() {
  console.log('Seeding admin data (user-tokens + sales-registry style)...');
  await ScyllaDb.ping();

  const exists = await ScyllaDb.tableExists(TABLE).catch(() => false);
  if (!exists) {
    console.log('Creating TokenRegistry table...');
    await ScyllaDb.createTable({
      TableName: TABLE,
      AttributeDefinitions: [
        { AttributeName: 'id', AttributeType: 'S' },
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'beneficiaryId', AttributeType: 'S' },
        { AttributeName: 'createdAt', AttributeType: 'S' }
      ],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        { IndexName: 'userIdCreatedAtIndex', KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }, { AttributeName: 'createdAt', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
        { IndexName: 'beneficiaryIdCreatedAtIndex', KeySchema: [{ AttributeName: 'beneficiaryId', KeyType: 'HASH' }, { AttributeName: 'createdAt', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } }
      ],
      BillingMode: 'PAY_PER_REQUEST'
    });
    console.log('TokenRegistry table created.');
  }

  // ---- 1) Sales-registry list: 24 rows matching sales-registry/data.json (txn_001..txn_024) ----
  const salesRegistryRows = [
    { id: 'txn_001', createdAt: '2026-01-15T10:30:00Z', transactionType: TYPES.CREDIT_PAID, userId: 'user_001', beneficiaryId: 'user_002', amount: 25.5, purpose: 'subscription', state: 'completed', refId: 'ref_abc123', metadata: { subscriptionId: 'sub_001', plan: 'premium' } },
    { id: 'txn_002', createdAt: '2026-01-16T14:20:00Z', transactionType: TYPES.TIP, userId: 'user_003', beneficiaryId: 'user_001', amount: 100, purpose: 'tip', state: 'completed', refId: 'ref_def456', metadata: { contentId: 'content_001', message: 'Great content!' } },
    { id: 'txn_003', createdAt: '2026-01-17T09:15:00Z', transactionType: TYPES.CREDIT_PAID, userId: 'user_002', beneficiaryId: 'user_004', amount: 50, purpose: 'purchase', state: 'pending', refId: 'ref_ghi789', metadata: { productId: 'prod_001', quantity: 1 } },
    { id: 'txn_004', createdAt: '2026-01-18T16:45:00Z', transactionType: TYPES.DEBIT, userId: 'user_004', beneficiaryId: 'user_002', amount: 50, purpose: 'refund', state: 'completed', refId: 'ref_jkl012', metadata: { originalTxnId: 'txn_003', reason: 'customer_request' } },
    { id: 'txn_005', createdAt: '2026-01-19T11:30:00Z', transactionType: TYPES.CREDIT_PAID, userId: 'user_001', beneficiaryId: 'user_005', amount: 75.25, purpose: 'subscription', state: 'failed', refId: 'ref_mno345', metadata: { subscriptionId: 'sub_002', error: 'insufficient_funds' } },
    { id: 'txn_006', createdAt: '2026-01-20T13:20:00Z', transactionType: TYPES.TIP, userId: 'user_005', beneficiaryId: 'user_003', amount: 30, purpose: 'tip', state: 'cancelled', refId: 'ref_pqr678', metadata: { contentId: 'content_002', cancelledBy: 'user_005' } },
    { id: 'txn_007', createdAt: '2026-01-21T08:10:00Z', transactionType: TYPES.CREDIT_PAID, userId: 'user_002', beneficiaryId: 'user_001', amount: 150, purpose: 'purchase', state: 'completed', refId: 'ref_stu901', metadata: { productId: 'prod_002', quantity: 2 } },
    { id: 'txn_008', createdAt: '2026-01-22T15:55:00Z', transactionType: TYPES.TIP, userId: 'user_004', beneficiaryId: 'user_005', amount: 20, purpose: 'tip', state: 'pending', refId: 'ref_vwx234', metadata: { contentId: 'content_003' } },
    { id: 'txn_009', createdAt: '2026-01-23T10:40:00Z', transactionType: TYPES.CREDIT_PAID, userId: 'user_003', beneficiaryId: 'user_002', amount: 200, purpose: 'subscription', state: 'completed', refId: 'ref_yza567', metadata: { subscriptionId: 'sub_003', plan: 'enterprise' } },
    { id: 'txn_010', createdAt: '2026-01-24T12:25:00Z', transactionType: TYPES.DEBIT, userId: 'user_001', beneficiaryId: 'user_003', amount: 100, purpose: 'refund', state: 'completed', refId: 'ref_bcd890', metadata: { originalTxnId: 'txn_009', reason: 'service_issue' } },
    { id: 'txn_011', createdAt: '2026-01-25T09:05:00Z', transactionType: TYPES.CREDIT_PAID, userId: 'user_005', beneficiaryId: 'user_004', amount: 45.75, purpose: 'purchase', state: 'failed', refId: 'ref_efg123', metadata: { productId: 'prod_003', error: 'payment_gateway_error' } },
    { id: 'txn_012', createdAt: '2026-01-26T14:50:00Z', transactionType: TYPES.TIP, userId: 'user_001', beneficiaryId: 'user_003', amount: 15, purpose: 'tip', state: 'completed', refId: 'ref_hij456', metadata: { contentId: 'content_004' } },
    { id: 'txn_013', createdAt: '2026-01-27T11:00:00Z', transactionType: TYPES.HOLD, userId: 'user_002', beneficiaryId: 'user_005', amount: 60, purpose: 'tip', state: 'open', refId: 'ref_held001', metadata: { contentId: 'content_005', holdReason: 'review' } },
    { id: 'txn_014', createdAt: '2026-01-28T09:30:00Z', transactionType: TYPES.HOLD, userId: 'user_004', beneficiaryId: 'user_001', amount: 120, purpose: 'subscription', state: 'open', refId: 'ref_held002', metadata: { subscriptionId: 'sub_004', holdReason: 'verification' } },
    { id: 'txn_015', createdAt: '2026-01-29T10:15:00Z', transactionType: TYPES.CREDIT_PAID, userId: 'user_006', beneficiaryId: 'user_002', amount: 80, purpose: 'subscription', state: 'completed', refId: 'ref_extra001', metadata: { subscriptionId: 'sub_005', plan: 'standard' } },
    { id: 'txn_016', createdAt: '2026-01-30T14:45:00Z', transactionType: TYPES.TIP, userId: 'user_002', beneficiaryId: 'user_006', amount: 40, purpose: 'tip', state: 'pending', refId: 'ref_extra002', metadata: { contentId: 'content_006' } },
    { id: 'txn_017', createdAt: '2026-01-31T08:20:00Z', transactionType: TYPES.DEBIT, userId: 'user_003', beneficiaryId: 'user_004', amount: 35, purpose: 'refund', state: 'completed', refId: 'ref_extra003', metadata: { originalTxnId: 'txn_007', reason: 'duplicate_charge' } },
    { id: 'txn_018', createdAt: '2026-02-01T12:05:00Z', transactionType: TYPES.CREDIT_PAID, userId: 'user_001', beneficiaryId: 'user_006', amount: 55.5, purpose: 'purchase', state: 'failed', refId: 'ref_extra004', metadata: { productId: 'prod_004', error: 'card_declined' } },
    { id: 'txn_019', createdAt: '2026-02-02T17:40:00Z', transactionType: TYPES.TIP, userId: 'user_005', beneficiaryId: 'user_002', amount: 22, purpose: 'tip', state: 'completed', refId: 'ref_extra005', metadata: { contentId: 'content_007' } },
    { id: 'txn_020', createdAt: '2026-02-03T09:55:00Z', transactionType: TYPES.CREDIT_PAID, userId: 'user_006', beneficiaryId: 'user_003', amount: 130, purpose: 'subscription', state: 'completed', refId: 'ref_extra006', metadata: { subscriptionId: 'sub_006', plan: 'premium' } },
    { id: 'txn_021', createdAt: '2026-02-04T13:10:00Z', transactionType: TYPES.HOLD, userId: 'user_003', beneficiaryId: 'user_006', amount: 18, purpose: 'tip', state: 'open', refId: 'ref_extra007', metadata: { contentId: 'content_008', holdReason: 'manual_review' } },
    { id: 'txn_022', createdAt: '2026-02-05T11:25:00Z', transactionType: TYPES.DEBIT, userId: 'user_002', beneficiaryId: 'user_005', amount: 90, purpose: 'refund', state: 'completed', refId: 'ref_extra008', metadata: { originalTxnId: 'txn_018', reason: 'customer_request' } },
    { id: 'txn_023', createdAt: '2026-02-06T16:00:00Z', transactionType: TYPES.CREDIT_PAID, userId: 'user_004', beneficiaryId: 'user_002', amount: 75, purpose: 'purchase', state: 'completed', refId: 'ref_extra009', metadata: { productId: 'prod_005', quantity: 3 } },
    { id: 'txn_024', createdAt: '2026-02-07T19:35:00Z', transactionType: TYPES.TIP, userId: 'user_001', beneficiaryId: 'user_004', amount: 27, purpose: 'tip', state: 'completed', refId: 'ref_extra010', metadata: { contentId: 'content_009' } },
  ];

  for (const row of salesRegistryRows) {
    const item = {
      id: row.id,
      userId: row.userId,
      beneficiaryId: row.beneficiaryId,
      transactionType: row.transactionType,
      amount: row.amount,
      purpose: row.purpose,
      refId: row.refId,
      expiresAt: '9999-12-31T23:59:59.999Z',
      createdAt: row.createdAt,
      metadata: typeof row.metadata === 'string' ? row.metadata : JSON.stringify(row.metadata || {}),
      state: row.state || 'completed',
      version: 1,
    };
    if (row.transactionType === TYPES.TIP || row.transactionType === TYPES.DEBIT) {
      item.freeBeneficiaryConsumed = 0;
      item.freeSystemConsumed = 0;
    }
    await ScyllaDb.putItem(TABLE, item);
  }
  console.log(`Seeded ${salesRegistryRows.length} token-registry rows (sales-registry style).`);

  // ---- 2) Balance rows so user-tokens aggregation matches user-tokens/data.json ----
  // Net from sales-registry (24 rows) for user_001..user_005: we compensate so final = data.json.
  // Targets: user_001 (150.5, 25, 10), user_002 (0, 5, 0), user_003 (500.75, 50, 30), user_004 (75.25, 15, 5), user_005 (0, 0, 0).
  const createdBase = '2026-01-01T00:00:00Z';

  // 2a) Compensating CREDIT_PAID / DEBIT so net paid matches data.json (sales rows already contribute).
  const paidBalanceRows = [
    { userId: 'user_001', type: TYPES.CREDIT_PAID, amount: 91.75, beneficiaryId: SYSTEM },
    { userId: 'user_002', type: TYPES.DEBIT, amount: 70, beneficiaryId: SYSTEM },
    { userId: 'user_003', type: TYPES.CREDIT_PAID, amount: 453.75, beneficiaryId: SYSTEM },
    { userId: 'user_004', type: TYPES.CREDIT_PAID, amount: 265.25, beneficiaryId: SYSTEM },
    { userId: 'user_005', type: TYPES.CREDIT_PAID, amount: 32, beneficiaryId: SYSTEM },
  ];
  for (let i = 0; i < paidBalanceRows.length; i++) {
    const r = paidBalanceRows[i];
    const item = {
      id: uniqueId('bal'),
      userId: r.userId,
      beneficiaryId: r.beneficiaryId,
      transactionType: r.type,
      amount: r.amount,
      purpose: 'balance_seed',
      refId: `ref_bal_paid_${i}`,
      expiresAt: '9999-12-31T23:59:59.999Z',
      createdAt: createdBase,
      metadata: JSON.stringify({}),
      state: 'completed',
      version: 1,
    };
    if (r.type === TYPES.DEBIT) {
      item.freeBeneficiaryConsumed = 0;
      item.freeSystemConsumed = 0;
    }
    await ScyllaDb.putItem(TABLE, item);
  }

  // 2b) System free tokens (matches data.json systemFreeTokens).
  const systemFreeRows = [
    { userId: 'user_001', amount: 25 },
    { userId: 'user_002', amount: 5 },
    { userId: 'user_003', amount: 50 },
    { userId: 'user_004', amount: 15 },
  ];
  for (let i = 0; i < systemFreeRows.length; i++) {
    const r = systemFreeRows[i];
    await ScyllaDb.putItem(TABLE, {
      id: uniqueId('bal'),
      userId: r.userId,
      beneficiaryId: SYSTEM,
      transactionType: TYPES.CREDIT_FREE,
      amount: r.amount,
      purpose: 'balance_seed',
      refId: `ref_bal_sys_${i}`,
      expiresAt: '9999-12-31T23:59:59.999Z',
      createdAt: createdBase,
      metadata: JSON.stringify({}),
      state: 'completed',
      version: 1,
    });
  }

  // 2c) Creator free tokens: exact shape from page/user-tokens/creator-free-tokens.json for "Free (Creator) Tokens" nested table.
  const creatorFreeGrants = [
    { userId: 'user_001', creatorId: 'creator_001', balance: 5, expiry: '2026-12-31T23:59:59Z' },
    { userId: 'user_001', creatorId: 'creator_002', balance: 5, expiry: '2026-06-30T23:59:59Z' },
    { userId: 'user_003', creatorId: 'creator_001', balance: 10, expiry: '2027-01-15T23:59:59Z' },
    { userId: 'user_003', creatorId: 'creator_002', balance: 20, expiry: '2026-12-31T23:59:59Z' },
    { userId: 'user_004', creatorId: 'creator_003', balance: 5, expiry: '2026-03-20T23:59:59Z' },
  ];
  for (let i = 0; i < creatorFreeGrants.length; i++) {
    const g = creatorFreeGrants[i];
    await ScyllaDb.putItem(TABLE, {
      id: uniqueId('cf'),
      userId: g.userId,
      beneficiaryId: g.creatorId,
      transactionType: TYPES.CREDIT_FREE,
      amount: g.balance,
      purpose: 'creator_grant',
      refId: `ref_cf_${i}`,
      expiresAt: g.expiry,
      createdAt: createdBase,
      metadata: JSON.stringify({ source: 'subscription_plan_basic' }),
      state: 'completed',
      version: 1,
    });
  }

  console.log('Seeded balance + creator-free rows for user-tokens (matches data.json + creator-free-tokens.json).');

  console.log('Admin seed complete.');
  if (typeof ScyllaDb.close === 'function') await ScyllaDb.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
