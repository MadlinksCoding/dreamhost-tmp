/**
 * Wait for ScyllaDB to be ready and create keyspace + tables using native CQL.
 * Uses cassandra-driver directly rather than ScyllaDb wrapper.
 *
 * Run with:
 *   SCYLLA_CONTACT_POINTS=scylladb:9042 node scripts/wait-and-init.js
 *
 * Environment Variables:
 *   SCYLLA_CONTACT_POINTS - defaults to "127.0.0.1:9042"
 *   SCYLLA_KEYSPACE - defaults to "app_keyspace"
 *   SCYLLA_LOCAL_DATACENTER - defaults to "datacenter1"
 */

const cassandra = require('cassandra-driver');

const CONTACT_POINTS = (process.env.SCYLLA_CONTACT_POINTS || '127.0.0.1:9042').split(',');
const KEYSPACE = process.env.SCYLLA_KEYSPACE || 'app_keyspace';
const LOCAL_DATACENTER = process.env.SCYLLA_LOCAL_DATACENTER || 'datacenter1';
const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 1000;

const client = new cassandra.Client({
  contactPoints: CONTACT_POINTS,
  localDataCenter: LOCAL_DATACENTER,
  keyspace: undefined // Don't set keyspace yet
});

async function waitForScylla() {
  let lastErr;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      await client.connect();
      console.log('ScyllaDB connection established');
      return;
    } catch (err) {
      lastErr = err;
      if (i < MAX_RETRIES - 1) {
        console.log(`Connecting to ScyllaDB... attempt ${i + 1}/${MAX_RETRIES}`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  throw new Error(`Failed to connect to ScyllaDB after ${MAX_RETRIES} attempts: ${lastErr.message}`);
}

async function createKeyspace() {
  const query = `
    CREATE KEYSPACE IF NOT EXISTS ${KEYSPACE}
    WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
  `;
  await client.execute(query);
  console.log(`Keyspace '${KEYSPACE}' ensured`);
}

async function switchToKeyspace() {
  await client.execute(`USE ${KEYSPACE}`);
  console.log(`Switched to keyspace '${KEYSPACE}'`);
}

async function createTokenregistryTable() {
  const query = `
    CREATE TABLE IF NOT EXISTS tokenregistry (
      id TEXT PRIMARY KEY,
      userId TEXT,
      beneficiaryId TEXT,
      createdAt TEXT,
      type TEXT,
      amount DECIMAL,
      currencyCode TEXT,
      status TEXT,
      holdState TEXT,
      expiresAt TEXT,
      purpose TEXT,
      metadata MAP<TEXT, TEXT>,
      updatedAt TEXT
    )
  `;
  await client.execute(query);
  console.log('Table tokenregistry created');
}

async function createSecondaryIndexes() {
  const tableRef = `${KEYSPACE}.tokenregistry`;
  const indexes = [
    [`idx_tokenregistry_userId`, `userId`],
    [`idx_tokenregistry_beneficiaryId`, `beneficiaryId`],
    [`idx_tokenregistry_createdAt`, `createdAt`],
    [`idx_tokenregistry_type`, `type`],
    [`idx_tokenregistry_status`, `status`],
    [`idx_tokenregistry_expiresAt`, `expiresAt`],
    [`idx_tokenregistry_holdState`, `holdState`]
  ];

  for (const [name, column] of indexes) {
    try {
      await client.execute(`CREATE INDEX IF NOT EXISTS ${name} ON ${tableRef} (${column})`);
    } catch (err) {
      if (err.message && (err.message.includes('already exists') || err.message.includes('Duplicate'))) {
        console.log(`Index ${name} already exists, skipping`);
      } else {
        throw err;
      }
    }
  }
  console.log('Secondary indexes created');
}

async function main() {
  console.log(`Waiting for ScyllaDB at ${CONTACT_POINTS.join(', ')}...`);

  try {
    await waitForScylla();
    await createKeyspace();
    await switchToKeyspace();
    await createTokenregistryTable();
    await createSecondaryIndexes();
    console.log('ScyllaDB initialization completed successfully');
  } catch (err) {
    console.error('Initialization failed:', err.message);
    process.exit(1);
  } finally {
    await client.shutdown();
  }
}

main();
