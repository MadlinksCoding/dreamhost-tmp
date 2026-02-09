const test = require("node:test");
const assert = require("node:assert/strict");

const TokenManager = require("../src/services/TokenManager.js");
const ScyllaDb = require("../src/utils/ScyllaDb.js");
const ErrorHandler = require("../src/utils/ErrorHandler.js");
const DateTime = require("../src/utils/DateTime.js");

const tableName = TokenManager.TABLES.TOKEN_REGISTRY;

async function cleanupByUserIds(userIds) {
  for (const userId of userIds) {
    try {
      const items = await ScyllaDb.query(
        tableName,
        "userId = :uid",
        { ":uid": userId },
        { IndexName: TokenManager.INDEXES.USER_ID_CREATED_AT }
      );
      for (const item of items) {
        await ScyllaDb.deleteItem(tableName, { id: item.id });
      }
      const asBeneficiary = await ScyllaDb.query(
        tableName,
        "beneficiaryId = :bid",
        { ":bid": userId },
        { IndexName: TokenManager.INDEXES.BENEFICIARY_ID_CREATED_AT }
      );
      for (const item of asBeneficiary) {
        await ScyllaDb.deleteItem(tableName, { id: item.id });
      }
    } catch (e) {
      // Ignore
    }
  }
}

const NODE_TEST_USER_IDS = [
  "u1", "payer", "payee", "user-drilldown", "user-drilldown-query",
  "user-list", "user-beneficiary", "user-a", "user-b", "user-adjust", "user-adjust-free",
  "user-0", "user-1", "user-2", "user-3", "user-4", "other-user"
];

test.beforeEach(async () => {
  await cleanupByUserIds(NODE_TEST_USER_IDS);
  ErrorHandler._clear();
});

test("CRUD: create CREDIT_PAID and read via getUserBalance", async () => {
  const userId = "u1";

  await TokenManager.creditPaidTokens(userId, 100, "purchase", { orderId: "o1" });
  const balance = await TokenManager.getUserBalance(userId);

  assert.equal(balance.paidTokens, 100);
  assert.equal(balance.totalFreeTokens, 0);
});

test("CRUD: HOLD lifecycle update + 1.7 guard prevents double-count when payer==beneficiary", async () => {
  const userId = "u1";
  await TokenManager.creditPaidTokens(userId, 100, "purchase", {});

  const hold = await TokenManager.holdTokens(userId, 10, userId, { refId: "booking-1" });
  assert.equal(hold.transactionType, TokenManager.TRANSACTION_TYPES.HOLD);
  assert.equal(hold.state, TokenManager.HOLD_STATES.OPEN);

  // While OPEN, balance reflects hold deduction (OPEN reduces balance)
  const b1 = await TokenManager.getUserBalance(userId);
  assert.equal(b1.paidTokens, 90);

  // Capture the hold; guard must prevent re-adding to the same user's balance
  await TokenManager.captureHeldTokens({ transactionId: hold.id });
  const b2 = await TokenManager.getUserBalance(userId);
  assert.equal(b2.paidTokens, 90);
});

test("CRUD: captured HOLD credits beneficiary when payer!=beneficiary", async () => {
  const payer = "payer";
  const beneficiary = "payee";

  await TokenManager.creditPaidTokens(payer, 50, "purchase", {});

  const hold = await TokenManager.holdTokens(payer, 10, beneficiary, { refId: "booking-2" });

  // Before capture, beneficiary should NOT see the hold credited (only CAPTURED is credited to beneficiary)
  const b0 = await TokenManager.getUserBalance(beneficiary);
  assert.equal(b0.paidTokens, 0);

  await TokenManager.captureHeldTokens({ transactionId: hold.id });

  const b1 = await TokenManager.getUserBalance(beneficiary);
  assert.equal(b1.paidTokens, 10);
});

test("CRUD: purgeOldRegistryRecords deletes old records (non-dry-run)", async () => {
  const userId = "u1";
  const tx = await TokenManager.addTransaction({
    userId,
    transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
    amount: 1,
    purpose: "old",
    metadata: {},
  });

  // Make the transaction "old" by overwriting it in the in-memory DB
  await ScyllaDb.putItem(TokenManager.TABLES.TOKEN_REGISTRY, { ...tx, createdAt: "2000-01-01T00:00:00.000Z" });

  const result = await TokenManager.purgeOldRegistryRecords({
    olderThanDays: 1,
    limit: 1000,
    dryRun: false,
    archive: false,
    maxSeconds: 25,
  });

  assert.ok(result.deleted >= 1);

  const after = await ScyllaDb.getItem(TokenManager.TABLES.TOKEN_REGISTRY, { id: tx.id });
  assert.equal(after, undefined);
});

test("getUserBalanceWithDrilldown: includes creator-specific and system free tokens", async () => {
  const userId = "user-drilldown";
  const creatorId = "creator-123";

  // Add paid tokens
  await TokenManager.creditPaidTokens(userId, 200, "purchase", {});

  // Add system free tokens (beneficiaryId = "system")
  await TokenManager.creditFreeTokens(
    userId,
    TokenManager.SYSTEM_BENEFICIARY_ID,
    50,
    DateTime.future(30 * 24 * 60 * 60), // 30 days
    "promo"
  );

  // Add creator-specific free tokens (beneficiaryId = creatorId)
  await TokenManager.creditFreeTokens(
    userId,
    creatorId,
    30,
    DateTime.future(30 * 24 * 60 * 60), // 30 days
    "subscription"
  );

  const drilldown = await TokenManager.getUserBalanceWithDrilldown(userId);

  assert.equal(drilldown.userId, userId);
  assert.equal(drilldown.paidTokens, 200);
  assert.equal(drilldown.totalFreeTokens, 80); // 50 + 30
  assert.equal(drilldown.systemFreeTokens, 50);
  assert.equal(drilldown.freeTokensPerBeneficiary[TokenManager.SYSTEM_BENEFICIARY_ID], 50);
  assert.equal(drilldown.freeTokensPerBeneficiary[creatorId], 30);

  // Check breakdown structure
  assert.ok(drilldown.freeTokensBreakdown[TokenManager.SYSTEM_BENEFICIARY_ID]);
  assert.equal(drilldown.freeTokensBreakdown[TokenManager.SYSTEM_BENEFICIARY_ID].total, 50);
  assert.ok(Array.isArray(drilldown.freeTokensBreakdown[TokenManager.SYSTEM_BENEFICIARY_ID].byExpiry));
  assert.equal(drilldown.freeTokensBreakdown[TokenManager.SYSTEM_BENEFICIARY_ID].byExpiry.length, 1);
  assert.equal(drilldown.freeTokensBreakdown[TokenManager.SYSTEM_BENEFICIARY_ID].byExpiry[0].amount, 50);

  assert.ok(drilldown.freeTokensBreakdown[creatorId]);
  assert.equal(drilldown.freeTokensBreakdown[creatorId].total, 30);
  assert.equal(drilldown.freeTokensBreakdown[creatorId].byExpiry.length, 1);
  assert.equal(drilldown.freeTokensBreakdown[creatorId].byExpiry[0].amount, 30);
});

test("tokenRegistryQuery: countAll", async () => {
  await TokenManager.creditPaidTokens("u1", 10, "test", {});
  await TokenManager.creditPaidTokens("u2", 20, "test", {});
  await TokenManager.holdTokens("u1", 5, "u2", { refId: "hold-1" });

  const result = await TokenManager.tokenRegistryQuery({ operation: "countAll" });
  assert.ok(result.count >= 3);
});

test("tokenRegistryQuery: countHolds", async () => {
  await TokenManager.creditPaidTokens("u1", 100, "test", {});
  await TokenManager.holdTokens("u1", 10, "u2", { refId: "hold-1" });
  await TokenManager.holdTokens("u1", 15, "u3", { refId: "hold-2" });

  const allHolds = await TokenManager.tokenRegistryQuery({ operation: "countHolds" });
  assert.ok(allHolds.count >= 2);

  const openHolds = await TokenManager.tokenRegistryQuery({
    operation: "countHolds",
    state: TokenManager.HOLD_STATES.OPEN,
  });
  assert.ok(openHolds.count >= 2);
});

test("tokenRegistryQuery: listAll (paginated)", async () => {
  // Create multiple records
  for (let i = 0; i < 5; i++) {
    await TokenManager.creditPaidTokens(`user-${i}`, 10, "test", {});
  }

  const page1 = await TokenManager.tokenRegistryQuery({ operation: "listAll", limit: 2 });
  assert.ok(page1.records.length <= 2);
  assert.ok(page1.records.length > 0);
  assert.ok(typeof page1.pageToken === "string" || page1.pageToken === null);

  if (page1.pageToken) {
    const page2 = await TokenManager.tokenRegistryQuery({
      operation: "listAll",
      limit: 2,
      pageToken: page1.pageToken,
    });
    assert.ok(page2.records.length >= 0);
  }
});

test("tokenRegistryQuery: listHolds (paginated)", async () => {
  await TokenManager.creditPaidTokens("u1", 100, "test", {});
  await TokenManager.holdTokens("u1", 10, "u2", { refId: "hold-1" });
  await TokenManager.holdTokens("u1", 15, "u3", { refId: "hold-2" });
  await TokenManager.holdTokens("u1", 20, "u4", { refId: "hold-3" });

  const page1 = await TokenManager.tokenRegistryQuery({ operation: "listHolds", limit: 2 });
  assert.ok(page1.records.length <= 2);
  assert.ok(page1.records.every((r) => r.transactionType === TokenManager.TRANSACTION_TYPES.HOLD));
});

test("tokenRegistryQuery: listUserRecords", async () => {
  const userId = "user-list";
  await TokenManager.creditPaidTokens(userId, 100, "test", {});
  await TokenManager.creditFreeTokens(userId, TokenManager.SYSTEM_BENEFICIARY_ID, 50, null, "promo");
  await TokenManager.holdTokens(userId, 10, "beneficiary", { refId: "hold-1" });

  const records = await TokenManager.tokenRegistryQuery({
    operation: "listUserRecords",
    userId,
    limit: 10,
  });

  assert.ok(records.records.length >= 3, `expected >= 3 records, got ${records.records.length}`);
  assert.ok(records.records.every((r) => r.userId === userId));
});

test("tokenRegistryQuery: listUserRecords with beneficiary records", async () => {
  const userId = "user-beneficiary";

  // User's own transactions
  await TokenManager.creditPaidTokens(userId, 100, "test", {});
  // User as beneficiary (received from someone else)
  await TokenManager.creditPaidTokens("other-user", 50, "transfer", {
    beneficiaryId: userId,
  });

  const withoutBeneficiary = await TokenManager.tokenRegistryQuery({
    operation: "listUserRecords",
    userId,
    includeBeneficiaryRecords: false,
  });

  const withBeneficiary = await TokenManager.tokenRegistryQuery({
    operation: "listUserRecords",
    userId,
    includeBeneficiaryRecords: true,
  });

  assert.ok(withBeneficiary.records.length >= withoutBeneficiary.records.length);
});

test("tokenRegistryQuery: getUserBalanceDrilldown", async () => {
  const userId = "user-drilldown-query";
  const creatorId = "creator-456";

  await TokenManager.creditPaidTokens(userId, 150, "test", {});
  await TokenManager.creditFreeTokens(userId, TokenManager.SYSTEM_BENEFICIARY_ID, 40, null, "promo");
  await TokenManager.creditFreeTokens(userId, creatorId, 25, null, "subscription");

  const result = await TokenManager.tokenRegistryQuery({
    operation: "getUserBalanceDrilldown",
    userId,
  });

  assert.equal(result.userId, userId);
  assert.equal(result.paidTokens, 150);
  assert.equal(result.totalFreeTokens, 65);
  assert.ok(result.freeTokensBreakdown);
});

test("tokenRegistryQuery: listAllUserBalances", async () => {
  await TokenManager.creditPaidTokens("user-a", 100, "test", {});
  await TokenManager.creditPaidTokens("user-b", 200, "test", {});
  await TokenManager.creditFreeTokens("user-a", TokenManager.SYSTEM_BENEFICIARY_ID, 50, null, "promo");
  await TokenManager.creditFreeTokens("user-b", "creator-789", 30, null, "promo");

  const result = await TokenManager.tokenRegistryQuery({
    operation: "listAllUserBalances",
  });

  assert.ok(Array.isArray(result.users));
  assert.ok(result.users.length >= 2);

  const userA = result.users.find((u) => u.userId === "user-a");
  assert.ok(userA);
  assert.equal(userA.paidTokens, 100);
  assert.equal(userA.totalFreeTokens, 50);

  const userB = result.users.find((u) => u.userId === "user-b");
  assert.ok(userB);
  assert.equal(userB.paidTokens, 200);
  assert.equal(userB.totalFreeTokens, 30);
  assert.equal(userB.freeTokensPerBeneficiary["creator-789"], 30);
});

test("tokenRegistryQuery: manualAdjustBalance (paid)", async () => {
  const userId = "user-adjust";
  await TokenManager.creditPaidTokens(userId, 100, "initial", {});

  const before = await TokenManager.getUserBalance(userId);
  assert.equal(before.paidTokens, 100);

  await TokenManager.tokenRegistryQuery({
    operation: "manualAdjustBalance",
    userId,
    amount: 25,
    type: "paid",
    reason: "admin adjustment",
  });

  const after = await TokenManager.getUserBalance(userId);
  assert.equal(after.paidTokens, 125);
});

test("tokenRegistryQuery: manualAdjustBalance (free with beneficiary)", async () => {
  const userId = "user-adjust-free";
  const creatorId = "creator-adjust";

  const before = await TokenManager.getUserBalance(userId);
  assert.equal(before.totalFreeTokens, 0);

  await TokenManager.tokenRegistryQuery({
    operation: "manualAdjustBalance",
    userId,
    amount: 40,
    type: "free",
    beneficiaryId: creatorId,
    reason: "admin grant",
    expiresAt: DateTime.future(365 * 24 * 60 * 60),
  });

  const after = await TokenManager.getUserBalance(userId);
  assert.equal(after.totalFreeTokens, 40);
  assert.equal(after.freeTokensPerBeneficiary[creatorId], 40);
});

test("tokenRegistryQuery: error handling for missing required params", async () => {
  await assert.rejects(
    async () => {
      await TokenManager.tokenRegistryQuery({ operation: "listUserRecords" });
    },
    /userId is required/
  );

  await assert.rejects(
    async () => {
      await TokenManager.tokenRegistryQuery({ operation: "getUserBalanceDrilldown" });
    },
    /userId is required/
  );

  await assert.rejects(
    async () => {
      await TokenManager.tokenRegistryQuery({ operation: "manualAdjustBalance" });
    },
    /required/
  );

  await assert.rejects(
    async () => {
      await TokenManager.tokenRegistryQuery({ operation: "invalidOperation" });
    },
    /Unsupported operation/
  );
});
