// Seed demo data for payment gateway admin APIs using existing frontend mock JSON.
// - Payment gateway tables are seeded via paymentGatewayService (and direct Scylla writes for tokens).
//
// Usage (from dreamhost-tmp folder):
//   node modules/payment/scripts/seed-admin-demo-data.js

/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");

const paymentGatewayService = require("../src/services/paymentGatewayService.js");
const ScyllaDb = require("../src/utils/ScyllaDb.js");

const TABLE_PAYMENT_TOKENS = "paymentGateway_tokens";
const TABLE_PAYMENT_WEBHOOKS = "paymentGateway_webhooks";
const TABLE_PAYMENT_SCHEDULES = "paymentGateway_schedules";

function loadJson(relativePath) {
  const fullPath = path.join(__dirname, "..", "..", "..", relativePath);
  const raw = fs.readFileSync(fullPath, "utf8");
  return JSON.parse(raw);
}

async function seedPaymentGateway() {
  console.log("Seeding payment gateway tables from admin-development mocks...");

  // Ensure table configs are loaded (paymentGatewayService constructor also does this,
  // but we call ScyllaDb directly for tokens).
  const tablesPath = path.join(__dirname, "..", "src", "utils", "tables.json");
  await ScyllaDb.loadTableConfigs(tablesPath);

  const sessions = loadJson("admin-development/page/payment-sessions/data.json");
  const transactions = loadJson("admin-development/page/payment-transactions/data.json");
  const schedules = loadJson("admin-development/page/payment-schedules/data.json");
  const tokens = loadJson("admin-development/page/payment-tokens/data.json");
  const webhooks = loadJson("admin-development/page/payment-webhooks/data.json");

  // Sessions
  for (const session of sessions) {
    await paymentGatewayService.saveSession(session);
  }
  console.log(`  Seeded ${sessions.length} payment sessions.`);

  // Transactions
  for (const txn of transactions) {
    // paymentGatewayService.saveTransaction requires orderType and payloads
    const orderType = txn.orderType || txn.transactionType || "payment";
    const payloads = txn.payloads && typeof txn.payloads === "object"
      ? {
          requestData: txn.payloads.requestData || {},
          responseData: txn.payloads.responseData || {}
        }
      : { requestData: {}, responseData: {} };

    await paymentGatewayService.saveTransaction({
      ...txn,
      orderType,
      payloads,
    });
  }
  console.log(`  Seeded ${transactions.length} payment transactions.`);

  // Schedules
  // Write schedule rows directly so the table shape matches the admin UI + ADMIN_APIS.md
  // (subscriptionId, frequency, startDate, nextScheduleDate, etc.)
  for (const sched of schedules) {
    const createdAt = sched.createdAt || new Date().toISOString();
    const pk = sched.pk || `user#${sched.userId}`;
    const sk = sched.sk || `schedule#${sched.subscriptionId}#${createdAt}`;
    await ScyllaDb.putItem(TABLE_PAYMENT_SCHEDULES, {
      ...sched,
      pk,
      sk,
      createdAt,
    });
  }
  console.log(`  Seeded ${schedules.length} payment schedules.`);

  // Tokens (no saveToken helper – write raw records to paymentGateway_tokens)
  for (const token of tokens) {
    await ScyllaDb.putItem(TABLE_PAYMENT_TOKENS, token);
  }
  console.log(`  Seeded ${tokens.length} card tokens.`);

  // Webhooks (write directly to table; matches saveWebhook structure)
  for (const hook of webhooks) {
    const createdAt = hook.createdAt || new Date().toISOString();
    const item = {
      pk: hook.pk || `order#${hook.orderId}`,
      sk: hook.sk || `webhook#${hook.idempotencyKey}#${createdAt}`,
      orderId: hook.orderId,
      payload: hook.payload || {},
      actionTaken: hook.actionTaken,
      handled: hook.handled,
      idempotencyKey: hook.idempotencyKey,
      createdAt,
    };
    if (hook.subscriptionId) {
      item.subscriptionId = hook.subscriptionId;
      item.gsi1pk = `subscription#${hook.subscriptionId}`;
      item.gsi1sk = `webhook#${createdAt}`;
    }
    await ScyllaDb.putItem(TABLE_PAYMENT_WEBHOOKS, item);
  }
  console.log(`  Seeded ${webhooks.length} webhooks.`);
}

async function main() {
  try {
    await seedPaymentGateway();
    console.log("Payment gateway seeding completed successfully.");
  } catch (err) {
    console.error("Payment gateway seeding failed:", err);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
