/**
 * Initialize DynamoDB (Alternator) tables for Token Registry module:
 * - TokenRegistry (with all GSIs)
 *
 * Run manually:
 *   NODE_ENV=test DYNAMODB_ENDPOINT=http://localhost:8000 node modules/tokenRegistry/scripts/init-tables.js
 */

const ScyllaDb = require('../src/utils/ScyllaDb.js');
const TokenManager = require('../src/services/TokenManager.js');

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
  console.log('Initializing Token Registry DynamoDB (Alternator) tables...');
  const endpoint = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
  console.log(`Endpoint: ${endpoint}`);

  await waitForAlternator();

  await ensureTokenRegistry();

  console.log('Token Registry tables initialization completed.');
}

main().catch((err) => {
  console.error('Token Registry init failed:', err.message || err);
  process.exit(1);
});
