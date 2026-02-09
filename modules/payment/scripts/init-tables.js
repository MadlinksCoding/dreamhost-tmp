/**
 * Initialize DynamoDB (Alternator) tables for Payment Gateway module:
 * - paymentGateway_sessions
 * - paymentGateway_transactions
 * - paymentGateway_schedules
 * - paymentGateway_tokens
 * - paymentGateway_webhooks
 *
 * Run manually:
 *   NODE_ENV=test DYNAMODB_ENDPOINT=http://localhost:8000 node modules/payment/scripts/init-tables.js
 */

const path = require('path');
const ScyllaDb = require('../src/utils/ScyllaDb.js');
const { createAllTablesFromJson } = require('../src/utils/createTable.js');

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

async function main() {
  console.log('Initializing Payment Gateway DynamoDB (Alternator) tables...');
  const endpoint = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
  console.log(`Endpoint: ${endpoint}`);

  await waitForAlternator();

  const paymentTablesPath = path.join(__dirname, '..', 'src', 'utils', 'tables.json');
  await createAllTablesFromJson(paymentTablesPath);

  console.log('Payment Gateway tables initialization completed.');
}

main().catch((err) => {
  console.error('Payment Gateway init failed:', err.message || err);
  process.exit(1);
});
