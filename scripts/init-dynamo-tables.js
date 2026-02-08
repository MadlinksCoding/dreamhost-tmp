/**
 * Create all DynamoDB (Alternator) tables required by the API:
 * - TokenRegistry (user-tokens, token-registry/sales-registry)
 * - paymentGateway_sessions, paymentGateway_transactions, paymentGateway_schedules,
 *   paymentGateway_tokens, paymentGateway_webhooks
 *
 * Run automatically before API start in Docker, or manually:
 *   NODE_ENV=test DYNAMODB_ENDPOINT=http://scylladb:8000 node scripts/init-dynamo-tables.js
 */

const path = require('path');
const ScyllaDb = require('../modules/tokenRegistry/src/utils/ScyllaDb.js');
const { createAllTablesFromJson } = require('../modules/tokenRegistry/src/utils/createTable.js');
const TokenManager = require('../modules/tokenRegistry/src/services/TokenManager.js');

const TABLE_TOKEN_REGISTRY = TokenManager.TABLES.TOKEN_REGISTRY;

async function waitForAlternator(maxRetries = 30, delayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await ScyllaDb.ping();
      console.log('Alternator (DynamoDB API) is ready.');
      return;
    } catch (err) {
      if (i < maxRetries - 1) {
        console.log(`Waiting for Alternator... (${i + 1}/${maxRetries})`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

async function ensureTokenRegistry() {
  const exists = await ScyllaDb.tableExists(TABLE_TOKEN_REGISTRY).catch(() => false);
  if (exists) {
    console.log(`Table ${TABLE_TOKEN_REGISTRY} already exists.`);
    return;
  }
  console.log(`Creating table ${TABLE_TOKEN_REGISTRY}...`);
  await ScyllaDb.createTable({
    TableName: TABLE_TOKEN_REGISTRY,
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'beneficiaryId', AttributeType: 'S' },
      { AttributeName: 'createdAt', AttributeType: 'S' },
      { AttributeName: 'expiresAt', AttributeType: 'S' },
      { AttributeName: 'refId', AttributeType: 'S' },
      { AttributeName: 'state', AttributeType: 'S' },
      { AttributeName: 'transactionType', AttributeType: 'S' }
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userIdCreatedAtIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        IndexName: 'beneficiaryIdCreatedAtIndex',
        KeySchema: [
          { AttributeName: 'beneficiaryId', KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        IndexName: 'userIdExpiresAtIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'expiresAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        IndexName: 'userIdRefIdIndex',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
          { AttributeName: 'refId', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        IndexName: 'refIdTransactionTypeIndex',
        KeySchema: [
          { AttributeName: 'refId', KeyType: 'HASH' },
          { AttributeName: 'transactionType', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        IndexName: 'refIdStateIndex',
        KeySchema: [
          { AttributeName: 'refId', KeyType: 'HASH' },
          { AttributeName: 'state', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      },
      {
        IndexName: 'transactionTypeExpiresAtIndex',
        KeySchema: [
          { AttributeName: 'transactionType', KeyType: 'HASH' },
          { AttributeName: 'expiresAt', KeyType: 'RANGE' }
        ],
        Projection: { ProjectionType: 'ALL' }
      }
    ],
    BillingMode: 'PAY_PER_REQUEST'
  });
  console.log(`Table ${TABLE_TOKEN_REGISTRY} created with all GSIs.`);
}

async function main() {
  console.log('Initializing DynamoDB (Alternator) tables...');
  const endpoint = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
  console.log(`Endpoint: ${endpoint}`);

  await waitForAlternator();

  await ensureTokenRegistry();

  const tokenTablesPath = path.join(__dirname, '..', 'modules', 'tokenRegistry', 'src', 'utils', 'tables.json');
  await createAllTablesFromJson(tokenTablesPath);

  // also create payment module tables if present
  const paymentTablesPath = path.join(__dirname, '..', 'modules', 'payment', 'src', 'utils', 'tables.json');
  try {
    await createAllTablesFromJson(paymentTablesPath);
  } catch (e) {
    console.log('No payment tables to create or error creating payment tables:', e.message || e);
  }

  console.log('DynamoDB tables initialization completed.');
}

main().catch((err) => {
  console.error('Init failed:', err.message || err);
  process.exit(1);
});
