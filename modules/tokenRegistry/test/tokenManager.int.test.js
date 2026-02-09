/**
 * Integration tests for TokenManager using real ScyllaDB
 * 
 * These tests run against:
 * - Real ScyllaDB instance (Docker)
 * - Real schema
 * - Real utils
 * - Real TokenManager class
 * 
 * No mocks, stubs, or in-memory DBs.
 * 
 * Cleanup uses query by userId (GSI) instead of scan; scan is banned in tests.
 */

const TokenManager = require("../src/services/TokenManager.js");
const ScyllaDb = require("../src/utils/ScyllaDb.js");
const DateTime = require("../src/utils/DateTime.js");

// Set test environment
process.env.NODE_ENV = 'test';

/** Query-based cleanup: delete items with testing=true for given userIds. No scan. */
async function cleanupTestingItems(tableName, userIds) {
  for (const userId of userIds) {
    try {
      const items = await ScyllaDb.query(
        tableName,
        'userId = :uid',
        { ':uid': userId },
        {
          IndexName: TokenManager.INDEXES.USER_ID_CREATED_AT,
          FilterExpression: '#testing = :true',
          ExpressionAttributeNames: { '#testing': 'testing' },
          ExpressionAttributeValues: { ':true': true }
        }
      );
      for (const item of items) {
        await ScyllaDb.deleteItem(tableName, { id: item.id });
      }
    } catch (error) {
      console.warn('Cleanup warning:', error.message);
    }
  }
}

// Phase 1 user IDs (each test uses unique userId; add new IDs when adding tests)
const PHASE_1_USER_IDS = [
  'test-user-1.1.1', 'test-user-1.1.2', 'test-user-1.1.3',
  'test-user-1.2.1', 'test-user-1.2.2',
  'test-user-1.3.1', 'test-user-1.3.2',
  'test-user-1.4.1', 'test-user-1.4.2',
  'test-user-1.5.1', 'test-user-1.5.2'
];

describe('TokenManager Integration Tests - Phase 1: Core CRUD', () => {
  const tableName = TokenManager.TABLES.TOKEN_REGISTRY;

  beforeAll(async () => {
    // Ensure connection
    await ScyllaDb.ping();
  });

  afterEach(async () => {
    await cleanupTestingItems(tableName, PHASE_1_USER_IDS);
  });

  afterAll(async () => {
    // Close connection
    await ScyllaDb.close();
  });

  describe('1.1 - Create token entries (CREDIT)', () => {
    test('1.1.1 - Create CREDIT_PAID transaction and verify in DB', async () => {
      const userId = 'test-user-1.1.1';
      const amount = 100;
      const purpose = 'test_purchase';
      const metadata = { orderId: 'order-123', testing: true };

      // Call real TokenManager
      const transaction = await TokenManager.creditPaidTokens(userId, amount, purpose, metadata);

      // Assert: Query DB directly using DynamoDB API
      const item = await ScyllaDb.getItem(tableName, { id: transaction.id });

      expect(item).toBeDefined();
      expect(item.id).toBe(transaction.id);
      expect(item.userId).toBe(userId);
      expect(item.transactionType).toBe(TokenManager.TRANSACTION_TYPES.CREDIT_PAID);
      expect(Number(item.amount)).toBe(amount);
      expect(item.purpose).toBe(purpose);
      expect(item.testing).toBe(true); // Must have testing flag
    });

    test('1.1.2 - Create CREDIT_PAID and verify balance via getUserBalance', async () => {
      const userId = 'test-user-1.1.2';
      const amount = 150;

      // Seed: Insert directly via DynamoDB API
      const transactionId = require('crypto').randomUUID();
      const now = DateTime.now();
      await ScyllaDb.putItem(tableName, {
        id: transactionId,
        userId: userId,
        beneficiaryId: TokenManager.SYSTEM_BENEFICIARY_ID,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: amount,
        purpose: 'test_seed',
        refId: `ref-${transactionId}`,
        expiresAt: '9999-12-31T23:59:59.999Z',
        createdAt: now,
        metadata: {},
        version: 1,
        testing: true
      });

      // Call real TokenManager
      const balance = await TokenManager.getUserBalance(userId);

      // Assert
      expect(balance.paidTokens).toBe(amount);
      expect(balance.totalFreeTokens).toBe(0);
    });

    test('1.1.3 - Create multiple CREDIT_PAID transactions and verify aggregate balance', async () => {
      const userId = 'test-user-1.1.3';

      // Seed: Insert multiple transactions via DynamoDB API
      const now = DateTime.now();
      const amounts = [50, 75, 25];
      for (const amount of amounts) {
        const transactionId = require('crypto').randomUUID();
        await ScyllaDb.putItem(tableName, {
          id: transactionId,
          userId: userId,
          beneficiaryId: TokenManager.SYSTEM_BENEFICIARY_ID,
          transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          amount: amount,
          purpose: 'test_seed',
          refId: `ref-${transactionId}`,
          expiresAt: '9999-12-31T23:59:59.999Z',
          createdAt: now,
          metadata: {},
          version: 1,
          testing: true
        });
      }

      // Call real TokenManager
      const balance = await TokenManager.getUserBalance(userId);

      // Assert
      const expectedTotal = amounts.reduce((a, b) => a + b, 0);
      expect(balance.paidTokens).toBe(expectedTotal);

      // Verify count in DB
      const transactions = await ScyllaDb.query(
        tableName,
        'userId = :uid',
        { ':uid': userId },
        {
          IndexName: TokenManager.INDEXES.USER_ID_CREATED_AT,
          FilterExpression: 'transactionType = :type AND testing = :true',
          ExpressionAttributeValues: {
            ':type': TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
            ':true': true
          }
        }
      );
      expect(transactions.length).toBe(amounts.length);
    });
  });

  describe('1.2 - Read transactions', () => {
    test('1.2.1 - Read transaction by ID via getItem', async () => {
      const userId = 'test-user-1.2.1';
      const amount = 200;

      // Seed: Insert via DynamoDB API
      const transactionId = require('crypto').randomUUID();
      const now = DateTime.now();
      await ScyllaDb.putItem(tableName, {
        id: transactionId,
        userId: userId,
        beneficiaryId: TokenManager.SYSTEM_BENEFICIARY_ID,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: amount,
        purpose: 'test_seed',
        refId: `ref-${transactionId}`,
        expiresAt: '9999-12-31T23:59:59.999Z',
        createdAt: now,
        metadata: { test: 'data' },
        version: 1,
        testing: true
      });

      // Call real TokenManager (via internal getItem usage in other methods)
      // We'll verify by checking getUserBalance which internally queries
      const balance = await TokenManager.getUserBalance(userId);

      // Assert
      expect(balance.paidTokens).toBe(amount);

      // Also verify direct DB read
      const item = await ScyllaDb.getItem(tableName, { id: transactionId });
      expect(item).toBeDefined();
      expect(Number(item.amount)).toBe(amount);
    });

    test('1.2.2 - Read user transactions via query', async () => {
      const userId = 'test-user-1.2.2';

      // Seed: Insert multiple transactions
      const now = DateTime.now();
      const transactions = [];
      for (let i = 0; i < 3; i++) {
        const transactionId = require('crypto').randomUUID();
        await ScyllaDb.putItem(tableName, {
          id: transactionId,
          userId: userId,
          beneficiaryId: TokenManager.SYSTEM_BENEFICIARY_ID,
          transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          amount: 10 * (i + 1),
          purpose: 'test_seed',
          refId: `ref-${transactionId}`,
          expiresAt: '9999-12-31T23:59:59.999Z',
          createdAt: now,
          metadata: {},
          version: 1,
          testing: true
        });
        transactions.push(transactionId);
      }

      // Call real TokenManager - getUserBalance queries user transactions
      const balance = await TokenManager.getUserBalance(userId);

      // Assert
      expect(balance.paidTokens).toBe(60); // 10 + 20 + 30

      // Verify via direct query
      const result = await ScyllaDb.query(
        tableName,
        'userId = :uid',
        { ':uid': userId },
        {
          IndexName: TokenManager.INDEXES.USER_ID_CREATED_AT,
          FilterExpression: 'testing = :true',
          ExpressionAttributeValues: { ':true': true }
        }
      );
      expect(result.length).toBe(3);
    });
  });

  describe('1.3 - Update balance via DEBIT', () => {
    test('1.3.1 - DEBIT reduces paid token balance', async () => {
      const userId = 'test-user-1.3.1';
      const creditAmount = 100;
      const debitAmount = 30;

      // Seed: Insert CREDIT_PAID via DynamoDB API
      const creditId = require('crypto').randomUUID();
      const now = DateTime.now();
      await ScyllaDb.putItem(tableName, {
        id: creditId,
        userId: userId,
        beneficiaryId: TokenManager.SYSTEM_BENEFICIARY_ID,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: creditAmount,
        purpose: 'test_seed',
        refId: `ref-${creditId}`,
        expiresAt: '9999-12-31T23:59:59.999Z',
        createdAt: now,
        metadata: {},
        version: 1,
        testing: true
      });

      // Verify initial balance
      let balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(creditAmount);

      // Call real TokenManager - deduct tokens
      const debitTransaction = await TokenManager.deductTokens(userId, debitAmount, {
        beneficiaryId: 'merchant-1',
        purpose: 'purchase',
        metadata: { testing: true }
      });

      // Assert: Verify balance after debit
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(creditAmount - debitAmount);

      // Assert: Verify DEBIT transaction in DB
      const item = await ScyllaDb.getItem(tableName, { id: debitTransaction.id });
      expect(item).toBeDefined();
      expect(item.transactionType).toBe(TokenManager.TRANSACTION_TYPES.DEBIT);
      expect(Number(item.amount)).toBe(debitAmount);
      expect(item.testing).toBe(true);
    });

    test('1.3.2 - Multiple DEBITs reduce balance correctly', async () => {
      const userId = 'test-user-1.3.2';
      const creditAmount = 200;
      const debitAmount1 = 50;
      const debitAmount2 = 75;

      // Seed: Insert CREDIT_PAID
      const creditId = require('crypto').randomUUID();
      const now = DateTime.now();
      await ScyllaDb.putItem(tableName, {
        id: creditId,
        userId: userId,
        beneficiaryId: TokenManager.SYSTEM_BENEFICIARY_ID,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: creditAmount,
        purpose: 'test_seed',
        refId: `ref-${creditId}`,
        expiresAt: '9999-12-31T23:59:59.999Z',
        createdAt: now,
        metadata: {},
        version: 1,
        testing: true
      });

      // First debit
      await TokenManager.deductTokens(userId, debitAmount1, {
        beneficiaryId: 'merchant-1',
        purpose: 'purchase-1',
        metadata: { testing: true }
      });

      // Verify intermediate balance
      let balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(creditAmount - debitAmount1);

      // Second debit
      await TokenManager.deductTokens(userId, debitAmount2, {
        beneficiaryId: 'merchant-2',
        purpose: 'purchase-2',
        metadata: { testing: true }
      });

      // Assert: Final balance
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(creditAmount - debitAmount1 - debitAmount2);

      // Verify DEBIT count in DB
      const transactions = await ScyllaDb.query(
        tableName,
        'userId = :uid',
        { ':uid': userId },
        {
          IndexName: TokenManager.INDEXES.USER_ID_CREATED_AT,
          FilterExpression: 'transactionType = :type AND testing = :true',
          ExpressionAttributeValues: {
            ':type': TokenManager.TRANSACTION_TYPES.DEBIT,
            ':true': true
          }
        }
      );
      expect(transactions.length).toBe(2);
    });
  });

  describe('1.4 - Expire tokens', () => {
    test('1.4.1 - Expired CREDIT_FREE tokens are excluded from balance', async () => {
      const userId = 'test-user-1.4.1';

      // Seed: Insert expired CREDIT_FREE via DynamoDB API
      const expiredId = require('crypto').randomUUID();
      const pastDate = DateTime.now();
      // Set expiresAt to past (subtract 1 day in seconds)
      const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      
      await ScyllaDb.putItem(tableName, {
        id: expiredId,
        userId: userId,
        beneficiaryId: TokenManager.SYSTEM_BENEFICIARY_ID,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
        amount: 50,
        purpose: 'test_seed',
        refId: `ref-${expiredId}`,
        expiresAt: expiredAt,
        createdAt: pastDate,
        metadata: {},
        version: 1,
        testing: true
      });

      // Seed: Insert non-expired CREDIT_FREE
      const validId = require('crypto').randomUUID();
      const futureDate = DateTime.future(30 * 24 * 60 * 60); // 30 days
      await ScyllaDb.putItem(tableName, {
        id: validId,
        userId: userId,
        beneficiaryId: TokenManager.SYSTEM_BENEFICIARY_ID,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
        amount: 30,
        purpose: 'test_seed',
        refId: `ref-${validId}`,
        expiresAt: futureDate,
        createdAt: pastDate,
        metadata: {},
        version: 1,
        testing: true
      });

      // Call real TokenManager
      const balance = await TokenManager.getUserBalance(userId);

      // Assert: Only non-expired tokens should be counted
      expect(balance.totalFreeTokens).toBe(30); // Only the valid one
      expect(balance.freeTokensPerBeneficiary[TokenManager.SYSTEM_BENEFICIARY_ID]).toBe(30);
    });

    test('1.4.2 - processExpiredHolds expires HOLD transactions', async () => {
      const userId = 'test-user-1.4.2';

      // Seed: CREDIT_PAID via TokenManager
      await TokenManager.creditPaidTokens(userId, 100, 'test_seed', { testing: true });

      // Create HOLD via TokenManager with 2-second expiry (ensures GSI is populated)
      const hold = await TokenManager.holdTokens(userId, 20, 'merchant-1', {
        refId: 'ref-process-expired-1.4.2',
        expiresAfter: 2,
        metadata: { testing: true }
      });

      // Verify HOLD exists and is OPEN
      let item = await ScyllaDb.getItem(tableName, { id: hold.id });
      expect(item.state).toBe(TokenManager.HOLD_STATES.OPEN);

      // Wait for hold to expire (expiresAt in the past)
      await new Promise(r => setTimeout(r, 3000));

      // Call real TokenManager - process expired holds (expiredForSeconds=0 means any expired)
      await TokenManager.processExpiredHolds(0, 1000);

      // Assert: HOLD should be reversed
      item = await ScyllaDb.getItem(tableName, { id: hold.id });
      expect(item.state).toBe(TokenManager.HOLD_STATES.REVERSED);
    });
  });

  describe('1.5 - Validate balances after operations', () => {
    test('1.5.1 - Balance consistency: CREDIT then DEBIT', async () => {
      const userId = 'test-user-1.5.1';
      const creditAmount = 100;
      const debitAmount = 40;

      // Seed: CREDIT_PAID
      const creditId = require('crypto').randomUUID();
      const now = DateTime.now();
      await ScyllaDb.putItem(tableName, {
        id: creditId,
        userId: userId,
        beneficiaryId: TokenManager.SYSTEM_BENEFICIARY_ID,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: creditAmount,
        purpose: 'test_seed',
        refId: `ref-${creditId}`,
        expiresAt: '9999-12-31T23:59:59.999Z',
        createdAt: now,
        metadata: {},
        version: 1,
        testing: true
      });

      // Verify initial balance
      let balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(creditAmount);

      // DEBIT
      await TokenManager.deductTokens(userId, debitAmount, {
        beneficiaryId: 'merchant-1',
        purpose: 'purchase',
        metadata: { testing: true }
      });

      // Assert: Final balance via TokenManager
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(creditAmount - debitAmount);

      // Assert: Verify via raw DB query
      const creditTransactions = await ScyllaDb.query(
        tableName,
        'userId = :uid',
        { ':uid': userId },
        {
          IndexName: TokenManager.INDEXES.USER_ID_CREATED_AT,
          FilterExpression: 'transactionType = :type AND testing = :true',
          ExpressionAttributeValues: {
            ':type': TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
            ':true': true
          }
        }
      );
      const debitTransactions = await ScyllaDb.query(
        tableName,
        'userId = :uid',
        { ':uid': userId },
        {
          IndexName: TokenManager.INDEXES.USER_ID_CREATED_AT,
          FilterExpression: 'transactionType = :type AND testing = :true',
          ExpressionAttributeValues: {
            ':type': TokenManager.TRANSACTION_TYPES.DEBIT,
            ':true': true
          }
        }
      );

      const totalCredits = creditTransactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
      const totalDebits = debitTransactions.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
      expect(totalCredits - totalDebits).toBe(creditAmount - debitAmount);
    });

    test('1.5.2 - Balance invariants: paid + free = total usable', async () => {
      const userId = 'test-user-1.5.2';

      // Seed: CREDIT_PAID
      await TokenManager.creditPaidTokens(userId, 100, 'test', { testing: true });

      // Seed: CREDIT_FREE via DynamoDB API
      const freeId = require('crypto').randomUUID();
      const now = DateTime.now();
      const futureDate = DateTime.future(30 * 24 * 60 * 60);
      await ScyllaDb.putItem(tableName, {
        id: freeId,
        userId: userId,
        beneficiaryId: TokenManager.SYSTEM_BENEFICIARY_ID,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
        amount: 50,
        purpose: 'test_seed',
        refId: `ref-${freeId}`,
        expiresAt: futureDate,
        createdAt: now,
        metadata: {},
        version: 1,
        testing: true
      });

      // Call real TokenManager
      const balance = await TokenManager.getUserBalance(userId);

      // Assert: Invariants
      expect(balance.paidTokens).toBe(100);
      expect(balance.totalFreeTokens).toBe(50);
      expect(balance.paidTokens + balance.totalFreeTokens).toBe(150);
    });
  });
});

// Phase 2 user IDs (each test uses unique userId; add new IDs when adding tests)
const PHASE_2_USER_IDS = [
  'test-user-2.1.1', 'test-user-2.1.2', 'test-user-2.1.3',
  'test-payer-2.1.4', 'test-beneficiary-2.1.4',
  'test-user-2.2.1', 'test-user-2.2.2', 'test-user-2.2.3',
  'test-sender-2.3.1', 'test-receiver-2.3.1',
  'test-sender-2.3.2', 'test-receiver-2.3.2',
  'test-user-2.4.1', 'test-user-2.4.2', 'test-user-2.4.3'
];

describe('TokenManager Integration Tests - Phase 2: HOLD Operations, CREDIT_FREE, and Advanced Scenarios', () => {
  const tableName = TokenManager.TABLES.TOKEN_REGISTRY;

  beforeAll(async () => {
    // Ensure connection
    await ScyllaDb.ping();
  });

  afterEach(async () => {
    await cleanupTestingItems(tableName, PHASE_2_USER_IDS);
  });

  afterAll(async () => {
    // Close connection
    await ScyllaDb.close();
  });

  describe('2.1 - HOLD Operations', () => {
    test('2.1.1 - Create HOLD transaction and verify in DB', async () => {
      const userId = 'test-user-2.1.1';
      const beneficiaryId = 'merchant-1';
      const holdAmount = 50;

      // Seed: Insert CREDIT_PAID
      await TokenManager.creditPaidTokens(userId, 100, 'test_seed', { testing: true });

      // Call real TokenManager - create HOLD
      const hold = await TokenManager.holdTokens(userId, holdAmount, beneficiaryId, {
        refId: 'booking-123',
        purpose: 'booking_hold',
        metadata: { testing: true }
      });

      // Assert: Verify HOLD transaction in DB
      const item = await ScyllaDb.getItem(tableName, { id: hold.id });
      expect(item).toBeDefined();
      expect(item.transactionType).toBe(TokenManager.TRANSACTION_TYPES.HOLD);
      expect(item.state).toBe(TokenManager.HOLD_STATES.OPEN);
      expect(Number(item.amount)).toBe(holdAmount);
      expect(item.userId).toBe(userId);
      expect(item.beneficiaryId).toBe(beneficiaryId);
      expect(item.testing).toBe(true);

      // Assert: Balance should reflect HOLD deduction
      const balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(100 - holdAmount); // HOLD reduces available balance
    });

    test('2.1.2 - Capture HOLD and verify state change', async () => {
      const userId = 'test-user-2.1.2';
      const beneficiaryId = 'merchant-2';
      const holdAmount = 30;

      // Seed: Insert CREDIT_PAID
      await TokenManager.creditPaidTokens(userId, 100, 'test_seed', { testing: true });

      // Create HOLD
      const hold = await TokenManager.holdTokens(userId, holdAmount, beneficiaryId, {
        refId: 'booking-456',
        metadata: { testing: true }
      });

      // Verify HOLD is OPEN
      let item = await ScyllaDb.getItem(tableName, { id: hold.id });
      expect(item.state).toBe(TokenManager.HOLD_STATES.OPEN);

      // Call real TokenManager - capture HOLD
      const captured = await TokenManager.captureHeldTokens({ transactionId: hold.id });

      // Assert: HOLD state should be CAPTURED
      item = await ScyllaDb.getItem(tableName, { id: hold.id });
      expect(item.state).toBe(TokenManager.HOLD_STATES.CAPTURED);

      // Assert: Balance should remain reduced (captured HOLD doesn't restore balance)
      const balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(100 - holdAmount);
    });

    test('2.1.3 - Reverse HOLD and verify balance restoration', async () => {
      const userId = 'test-user-2.1.3';
      const beneficiaryId = 'merchant-3';
      const holdAmount = 25;

      // Seed: Insert CREDIT_PAID
      await TokenManager.creditPaidTokens(userId, 100, 'test_seed', { testing: true });

      // Create HOLD
      const hold = await TokenManager.holdTokens(userId, holdAmount, beneficiaryId, {
        refId: 'booking-789',
        metadata: { testing: true }
      });

      // Verify balance reduced
      let balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(100 - holdAmount);

      // Call real TokenManager - reverse HOLD
      await TokenManager.reverseHeldTokens({ transactionId: hold.id });

      // Assert: HOLD state should be REVERSED
      const item = await ScyllaDb.getItem(tableName, { id: hold.id });
      expect(item.state).toBe(TokenManager.HOLD_STATES.REVERSED);

      // Assert: Balance should be restored
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(100); // Reversed HOLD restores balance
    });

    test('2.1.4 - HOLD with different payer and beneficiary', async () => {
      const payer = 'test-payer-2.1.4';
      const beneficiary = 'test-beneficiary-2.1.4';
      const holdAmount = 40;

      // Seed: Insert CREDIT_PAID for payer
      await TokenManager.creditPaidTokens(payer, 100, 'test_seed', { testing: true });

      // Create HOLD (payer holds tokens for beneficiary)
      const hold = await TokenManager.holdTokens(payer, holdAmount, beneficiary, {
        refId: 'transfer-hold-1',
        metadata: { testing: true }
      });

      // Assert: Payer balance reduced
      let payerBalance = await TokenManager.getUserBalance(payer);
      expect(payerBalance.paidTokens).toBe(100 - holdAmount);

      // Assert: Beneficiary balance not yet increased (only on capture)
      let beneficiaryBalance = await TokenManager.getUserBalance(beneficiary);
      expect(beneficiaryBalance.paidTokens).toBe(0);

      // Capture HOLD
      await TokenManager.captureHeldTokens({ transactionId: hold.id });

      // Assert: Beneficiary should receive tokens
      beneficiaryBalance = await TokenManager.getUserBalance(beneficiary);
      expect(beneficiaryBalance.paidTokens).toBe(holdAmount);

      // Assert: Payer balance still reduced
      payerBalance = await TokenManager.getUserBalance(payer);
      expect(payerBalance.paidTokens).toBe(100 - holdAmount);
    });
  });

  describe('2.2 - CREDIT_FREE Operations', () => {
    test('2.2.1 - Create CREDIT_FREE with system beneficiary', async () => {
      const userId = 'test-user-2.2.1';
      const amount = 75;
      const expiresAt = DateTime.future(30 * 24 * 60 * 60); // 30 days

      // Call real TokenManager - credit free tokens
      const transaction = await TokenManager.creditFreeTokens(
        userId,
        TokenManager.SYSTEM_BENEFICIARY_ID,
        amount,
        expiresAt,
        'promo_grant',
        { testing: true }
      );

      // Assert: Verify CREDIT_FREE transaction in DB
      const item = await ScyllaDb.getItem(tableName, { id: transaction.id });
      expect(item).toBeDefined();
      expect(item.transactionType).toBe(TokenManager.TRANSACTION_TYPES.CREDIT_FREE);
      expect(item.beneficiaryId).toBe(TokenManager.SYSTEM_BENEFICIARY_ID);
      expect(Number(item.amount)).toBe(amount);
      expect(item.testing).toBe(true);

      // Assert: Balance should include free tokens
      const balance = await TokenManager.getUserBalance(userId);
      expect(balance.totalFreeTokens).toBe(amount);
      expect(balance.freeTokensPerBeneficiary[TokenManager.SYSTEM_BENEFICIARY_ID]).toBe(amount);
    });

    test('2.2.2 - Create CREDIT_FREE with creator beneficiary', async () => {
      const userId = 'test-user-2.2.2';
      const creatorId = 'creator-123';
      const amount = 50;
      const expiresAt = DateTime.future(60 * 24 * 60 * 60); // 60 days

      // Call real TokenManager - credit free tokens
      await TokenManager.creditFreeTokens(userId, creatorId, amount, expiresAt, 'subscription_bonus', { testing: true });

      // Assert: Balance should include creator-specific free tokens
      const balance = await TokenManager.getUserBalance(userId);
      expect(balance.totalFreeTokens).toBe(amount);
      expect(balance.freeTokensPerBeneficiary[creatorId]).toBe(amount);
      expect(balance.freeTokensPerBeneficiary[TokenManager.SYSTEM_BENEFICIARY_ID] || 0).toBe(0);
    });

    test('2.2.3 - Multiple CREDIT_FREE from different beneficiaries', async () => {
      const userId = 'test-user-2.2.3';
      const creator1 = 'creator-1';
      const creator2 = 'creator-2';
      const systemAmount = 100;
      const creator1Amount = 50;
      const creator2Amount = 25;

      // Seed: Insert multiple CREDIT_FREE via DynamoDB API
      const now = DateTime.now();
      const futureDate = DateTime.future(30 * 24 * 60 * 60);

      // System free tokens
      const systemId = require('crypto').randomUUID();
      await ScyllaDb.putItem(tableName, {
        id: systemId,
        userId: userId,
        beneficiaryId: TokenManager.SYSTEM_BENEFICIARY_ID,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
        amount: systemAmount,
        purpose: 'system_promo',
        refId: `ref-${systemId}`,
        expiresAt: futureDate,
        createdAt: now,
        metadata: {},
        version: 1,
        testing: true
      });

      // Creator 1 free tokens
      const creator1Id = require('crypto').randomUUID();
      await ScyllaDb.putItem(tableName, {
        id: creator1Id,
        userId: userId,
        beneficiaryId: creator1,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
        amount: creator1Amount,
        purpose: 'creator1_bonus',
        refId: `ref-${creator1Id}`,
        expiresAt: futureDate,
        createdAt: now,
        metadata: {},
        version: 1,
        testing: true
      });

      // Creator 2 free tokens
      const creator2Id = require('crypto').randomUUID();
      await ScyllaDb.putItem(tableName, {
        id: creator2Id,
        userId: userId,
        beneficiaryId: creator2,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
        amount: creator2Amount,
        purpose: 'creator2_bonus',
        refId: `ref-${creator2Id}`,
        expiresAt: futureDate,
        createdAt: now,
        metadata: {},
        version: 1,
        testing: true
      });

      // Call real TokenManager
      const balance = await TokenManager.getUserBalance(userId);

      // Assert: All free tokens should be counted
      expect(balance.totalFreeTokens).toBe(systemAmount + creator1Amount + creator2Amount);
      expect(balance.freeTokensPerBeneficiary[TokenManager.SYSTEM_BENEFICIARY_ID]).toBe(systemAmount);
      expect(balance.freeTokensPerBeneficiary[creator1]).toBe(creator1Amount);
      expect(balance.freeTokensPerBeneficiary[creator2]).toBe(creator2Amount);
    });
  });

  describe('2.3 - Transfer Operations (TIP)', () => {
    test('2.3.1 - Transfer tokens between users', async () => {
      const senderId = 'test-sender-2.3.1';
      const receiverId = 'test-receiver-2.3.1';
      const transferAmount = 30;

      // Seed: Insert CREDIT_PAID for sender
      await TokenManager.creditPaidTokens(senderId, 100, 'test_seed', { testing: true });

      // Call real TokenManager - transfer tokens
      const tipTransaction = await TokenManager.transferTokens(
        senderId,
        receiverId,
        transferAmount,
        'tip',
        { refId: 'tip-123', metadata: { testing: true } }
      );

      // Assert: Verify TIP transaction in DB
      const item = await ScyllaDb.getItem(tableName, { id: tipTransaction.transactionId });
      expect(item).toBeDefined();
      expect(item.transactionType).toBe(TokenManager.TRANSACTION_TYPES.TIP);
      expect(Number(item.amount)).toBe(transferAmount);
      expect(item.userId).toBe(senderId);
      expect(item.beneficiaryId).toBe(receiverId);
      expect(item.testing).toBe(true);

      // Assert: Sender balance reduced
      const senderBalance = await TokenManager.getUserBalance(senderId);
      expect(senderBalance.paidTokens).toBe(100 - transferAmount);

      // Assert: Receiver balance increased
      const receiverBalance = await TokenManager.getUserBalance(receiverId);
      expect(receiverBalance.paidTokens).toBe(transferAmount);
    });

    test('2.3.2 - Transfer with free token consumption priority', async () => {
      const senderId = 'test-sender-2.3.2';
      const receiverId = 'test-receiver-2.3.2';
      const transferAmount = 40;

      // Seed: Insert CREDIT_PAID
      await TokenManager.creditPaidTokens(senderId, 50, 'test_seed', { testing: true });

      // Seed: Insert beneficiary-specific CREDIT_FREE
      const creatorId = 'creator-transfer';
      await TokenManager.creditFreeTokens(senderId, creatorId, 30, DateTime.future(30 * 24 * 60 * 60), 'bonus', { testing: true });

      // Seed: Insert system CREDIT_FREE
      await TokenManager.creditFreeTokens(senderId, TokenManager.SYSTEM_BENEFICIARY_ID, 20, DateTime.future(30 * 24 * 60 * 60), 'promo', { testing: true });

      // Verify initial balance
      let balance = await TokenManager.getUserBalance(senderId);
      expect(balance.paidTokens).toBe(50);
      expect(balance.totalFreeTokens).toBe(50); // 30 + 20

      // Call real TokenManager - transfer (should consume free tokens first)
      await TokenManager.transferTokens(senderId, receiverId, transferAmount, 'tip', { metadata: { testing: true } });

      // Assert: Sender balance after transfer
      balance = await TokenManager.getUserBalance(senderId);
      // Transfer should consume: 30 (beneficiary) + 10 (system) = 40, leaving 10 system free + 50 paid
      expect(balance.totalFreeTokens).toBe(10); // 20 - 10 = 10 system free remaining
      expect(balance.paidTokens).toBe(50); // Paid tokens not consumed

      // Assert: Receiver received full amount
      const receiverBalance = await TokenManager.getUserBalance(receiverId);
      expect(receiverBalance.paidTokens).toBe(transferAmount);
    });
  });

  describe('2.4 - Complex Balance Scenarios', () => {
    test('2.4.1 - Mixed transaction types: CREDIT_PAID, CREDIT_FREE, HOLD, DEBIT', async () => {
      const userId = 'test-user-2.4.1';

      // Seed: CREDIT_PAID
      await TokenManager.creditPaidTokens(userId, 200, 'purchase', { testing: true });

      // Seed: CREDIT_FREE (system)
      await TokenManager.creditFreeTokens(userId, TokenManager.SYSTEM_BENEFICIARY_ID, 50, DateTime.future(30 * 24 * 60 * 60), 'promo', { testing: true });

      // Seed: CREDIT_FREE (creator)
      const creatorId = 'creator-mixed';
      await TokenManager.creditFreeTokens(userId, creatorId, 30, DateTime.future(30 * 24 * 60 * 60), 'bonus', { testing: true });

      // Verify initial balance
      let balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(200);
      expect(balance.totalFreeTokens).toBe(80); // 50 + 30

      // Create HOLD
      const hold = await TokenManager.holdTokens(userId, 40, 'merchant-1', { refId: 'hold-mixed', metadata: { testing: true } });

      // Verify balance after HOLD
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(160); // 200 - 40

      // DEBIT (consumes free tokens first: 30 from 80 free, so paid stays 160)
      await TokenManager.deductTokens(userId, 30, { beneficiaryId: 'merchant-2', purpose: 'purchase', metadata: { testing: true } });

      // Verify balance after DEBIT
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(160); // DEBIT used 30 free, paid unchanged
      expect(balance.totalFreeTokens).toBe(50); // 80 - 30 free consumed

      // Capture HOLD
      await TokenManager.captureHeldTokens({ transactionId: hold.id });

      // Verify final balance
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(160); // Still 160 (captured HOLD doesn't change paid)
      expect(balance.totalFreeTokens).toBe(50); // Free tokens reduced by DEBIT
    });

    test('2.4.2 - DEBIT consumes free tokens before paid (priority order)', async () => {
      const userId = 'test-user-2.4.2';
      const beneficiaryId = 'merchant-priority';

      // Seed: CREDIT_PAID
      await TokenManager.creditPaidTokens(userId, 100, 'purchase', { testing: true });

      // Seed: Beneficiary-specific CREDIT_FREE
      await TokenManager.creditFreeTokens(userId, beneficiaryId, 25, DateTime.future(30 * 24 * 60 * 60), 'bonus', { testing: true });

      // Seed: System CREDIT_FREE
      await TokenManager.creditFreeTokens(userId, TokenManager.SYSTEM_BENEFICIARY_ID, 15, DateTime.future(30 * 24 * 60 * 60), 'promo', { testing: true });

      // DEBIT that consumes: 25 (beneficiary) + 15 (system) + 10 (paid) = 50
      await TokenManager.deductTokens(userId, 50, { beneficiaryId, purpose: 'purchase', metadata: { testing: true } });

      // Assert: Balance after DEBIT
      const balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(90); // 100 - 10
      expect(balance.totalFreeTokens).toBe(0); // All free tokens consumed
      expect(balance.freeTokensPerBeneficiary[beneficiaryId] || 0).toBe(0);
      expect(balance.freeTokensPerBeneficiary[TokenManager.SYSTEM_BENEFICIARY_ID] || 0).toBe(0);

      // Verify DEBIT transaction has free token tracking
      const debitTransactions = await ScyllaDb.query(
        tableName,
        'userId = :uid',
        { ':uid': userId },
        {
          IndexName: TokenManager.INDEXES.USER_ID_CREATED_AT,
          FilterExpression: 'transactionType = :type AND testing = :true',
          ExpressionAttributeValues: {
            ':type': TokenManager.TRANSACTION_TYPES.DEBIT,
            ':true': true
          }
        }
      );
      expect(debitTransactions.length).toBe(1);
      const debitItem = debitTransactions[0];
      const freeBeneficiaryConsumed = Number(debitItem.freeBeneficiaryConsumed || 0);
      const freeSystemConsumed = Number(debitItem.freeSystemConsumed || 0);
      expect(freeBeneficiaryConsumed).toBe(25);
      expect(freeSystemConsumed).toBe(15);
      expect(Number(debitItem.amount)).toBe(10); // Only paid portion
    });

    test('2.4.3 - HOLD lifecycle: create, capture, verify balance invariants', async () => {
      const userId = 'test-user-2.4.3';
      const beneficiaryId = 'merchant-lifecycle';
      const holdAmount = 35;

      // Seed: CREDIT_PAID
      await TokenManager.creditPaidTokens(userId, 100, 'purchase', { testing: true });

      // Create HOLD
      const hold = await TokenManager.holdTokens(userId, holdAmount, beneficiaryId, { refId: 'lifecycle-1', metadata: { testing: true } });

      // Verify HOLD state and balance
      let item = await ScyllaDb.getItem(tableName, { id: hold.id });
      expect(item.state).toBe(TokenManager.HOLD_STATES.OPEN);
      
      let balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(100 - holdAmount);

      // Capture HOLD
      await TokenManager.captureHeldTokens({ transactionId: hold.id });

      // Verify HOLD state changed
      item = await ScyllaDb.getItem(tableName, { id: hold.id });
      expect(item.state).toBe(TokenManager.HOLD_STATES.CAPTURED);
      
      // Verify balance unchanged (captured HOLD doesn't restore)
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(100 - holdAmount);

      // Verify version was incremented
      const version = Number(item.version || 1);
      expect(version).toBeGreaterThan(1); // Version should increment on update
    });
  });
});
