// Seed demo data for token registry admin APIs using existing frontend mock JSON.
// - TokenManager tables are seeded so user-token APIs return values similar to user-tokens/data.json.
//
// Usage (from dreamhost-tmp folder):
//   node modules/tokenRegistry/scripts/seed-admin-demo-data.js

/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");

const TokenManager = require("../src/services/TokenManager.js");
const ScyllaDb = require("../src/utils/ScyllaDb.js");

const TABLE_TOKEN_REGISTRY = "TokenRegistry";

function loadJson(relativePath) {
  const fullPath = path.join(__dirname, "..", "..", "..", relativePath);
  const raw = fs.readFileSync(fullPath, "utf8");
  return JSON.parse(raw);
}

async function seedTokenManager() {
  console.log("Seeding TokenManager tables to satisfy user-tokens and token-registry APIs...");

  // NOTE: We approximate underlying transactions so aggregates match user-tokens/data.json.
  // Amounts are rounded to integers because TokenManager stores token counts, not decimals.

  // Ensure TokenRegistry table exists in Dynamo (used by TokenManager)
  const tokenRegistryExists = await ScyllaDb.tableExists(TABLE_TOKEN_REGISTRY).catch(() => false);
  if (!tokenRegistryExists) {
    console.log("  TokenRegistry table not found in DynamoDB, creating...");
    await ScyllaDb.createTable({
      TableName: TABLE_TOKEN_REGISTRY,
      AttributeDefinitions: [
        { AttributeName: "id", AttributeType: "S" },
        { AttributeName: "userId", AttributeType: "S" },
        { AttributeName: "beneficiaryId", AttributeType: "S" },
        { AttributeName: "transactionType", AttributeType: "S" },
        { AttributeName: "refId", AttributeType: "S" },
        { AttributeName: "state", AttributeType: "S" },
        { AttributeName: "createdAt", AttributeType: "S" },
        { AttributeName: "expiresAt", AttributeType: "S" }
      ],
      KeySchema: [
        { AttributeName: "id", KeyType: "HASH" }
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "userIdCreatedAtIndex",
          KeySchema: [
            { AttributeName: "userId", KeyType: "HASH" },
            { AttributeName: "createdAt", KeyType: "RANGE" }
          ],
          Projection: { ProjectionType: "ALL" }
        },
        {
          IndexName: "beneficiaryIdCreatedAtIndex",
          KeySchema: [
            { AttributeName: "beneficiaryId", KeyType: "HASH" },
            { AttributeName: "createdAt", KeyType: "RANGE" }
          ],
          Projection: { ProjectionType: "ALL" }
        },
        {
          IndexName: "userIdExpiresAtIndex",
          KeySchema: [
            { AttributeName: "userId", KeyType: "HASH" },
            { AttributeName: "expiresAt", KeyType: "RANGE" }
          ],
          Projection: { ProjectionType: "ALL" }
        },
        {
          IndexName: "userIdRefIdIndex",
          KeySchema: [
            { AttributeName: "userId", KeyType: "HASH" },
            { AttributeName: "refId", KeyType: "RANGE" }
          ],
          Projection: { ProjectionType: "ALL" }
        },
        {
          IndexName: "refIdTransactionTypeIndex",
          KeySchema: [
            { AttributeName: "refId", KeyType: "HASH" },
            { AttributeName: "transactionType", KeyType: "RANGE" }
          ],
          Projection: { ProjectionType: "ALL" }
        },
        {
          IndexName: "refIdStateIndex",
          KeySchema: [
            { AttributeName: "refId", KeyType: "HASH" },
            { AttributeName: "state", KeyType: "RANGE" }
          ],
          Projection: { ProjectionType: "ALL" }
        },
        {
          IndexName: "transactionTypeExpiresAtIndex",
          KeySchema: [
            { AttributeName: "transactionType", KeyType: "HASH" },
            { AttributeName: "expiresAt", KeyType: "RANGE" }
          ],
          Projection: { ProjectionType: "ALL" }
        }
      ],
      BillingMode: "PAY_PER_REQUEST"
    });
    console.log("  TokenRegistry table created.");
  }

  const userTokens = loadJson("admin-development/page/user-tokens/data.json");
  const creatorGrants = loadJson("admin-development/page/user-tokens/creator-free-tokens.json");

  // Index creator grants per user for CREDIT_FREE entries
  const creatorGrantsByUser = {};
  for (const grant of creatorGrants) {
    if (!grant.userId || !grant.creatorId || !grant.balance) continue;
    if (!creatorGrantsByUser[grant.userId]) creatorGrantsByUser[grant.userId] = [];
    creatorGrantsByUser[grant.userId].push(grant);
  }

  for (const row of userTokens) {
    const userId = row.userId;
    if (!userId) continue;

    const paidTokens = Math.round(row.paidTokens || 0);
    const systemFree = Math.round(row.systemFreeTokens || 0);
    const creatorFree = Math.round(row.creatorFreeTokens || 0);

    // Seed paid tokens as one CREDIT_PAID transaction
    if (paidTokens > 0) {
      await TokenManager.creditPaidTokens(userId, paidTokens, "seed_paid_balance");
    }

    // Seed system free tokens as one CREDIT_FREE with system beneficiary
    if (systemFree > 0) {
      await TokenManager.creditFreeTokens(
        userId,
        TokenManager.SYSTEM_BENEFICIARY_ID,
        systemFree,
        null,
        "seed_system_free"
      );
    }

    // Seed creator free tokens from creator-free-tokens.json (per creator/expiry)
    const grants = creatorGrantsByUser[userId] || [];
    for (const grant of grants) {
      const amount = Math.round(grant.balance || 0);
      if (amount <= 0) continue;
      await TokenManager.creditFreeTokens(
        userId,
        grant.creatorId,
        amount,
        grant.expiry || null,
        "seed_creator_free"
      );
    }

    // If creatorFreeTokens > 0 but there are no explicit grants, create a single generic grant.
    if (creatorFree > 0 && grants.length === 0) {
      await TokenManager.creditFreeTokens(
        userId,
        "creator_generic",
        creatorFree,
        null,
        "seed_creator_free"
      );
    }
  }

  // Seed token registry records to match the admin Token Registry mocks (sales-registry/data.json)
  // This gives the admin UI a realistic mix (HOLD open/captured, DEBIT, TIP, etc.) for demos.
  const tokenRegistryRecords = loadJson("admin-development/page/sales-registry/data.json");
  let tokenRegistrySeeded = 0;
  for (const rec of tokenRegistryRecords) {
    if (!rec || !rec.id) continue;
    const item = {
      id: rec.id,
      userId: rec.userId || null,
      beneficiaryId: rec.beneficiaryId || null,
      transactionType: rec.transactionType || null,
      amount: rec.amount != null ? Number(rec.amount) : 0,
      purpose: rec.purpose || null,
      refId: rec.refId || null,
      expiresAt: rec.expiresAt || "9999-12-31T23:59:59.999Z",
      createdAt: rec.createdAt || new Date().toISOString(),
      state: rec.state || null,
      version: rec.version || 1,
      freeBeneficiaryConsumed: rec.freeBeneficiaryConsumed || 0,
      freeSystemConsumed: rec.freeSystemConsumed || 0,
      metadata: rec.metadata || {},
    };
    await ScyllaDb.putItem(TABLE_TOKEN_REGISTRY, item);
    tokenRegistrySeeded += 1;
  }

  console.log(`  Seeded TokenManager balances for ${userTokens.length} users.`);
  console.log(`  Seeded ${tokenRegistrySeeded} TokenRegistry records from sales-registry mocks.`);
  console.log("  TokenRegistry entries can be browsed via the Token Registry (sales-registry) admin page.");
}

async function main() {
  try {
    await seedTokenManager();
    console.log("Token registry seeding completed successfully.");
  } catch (err) {
    console.error("Token registry seeding failed:", err);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
