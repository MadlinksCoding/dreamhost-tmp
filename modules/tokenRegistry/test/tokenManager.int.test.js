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
 */

const TokenManager = require("../src/services/TokenManager.js");
const ScyllaDb = require("../src/utils/ScyllaDb.js");
const DateTime = require("../src/utils/DateTime.js");

// Set test environment
process.env.NODE_ENV = 'test';

describe('TokenManager Integration Tests - Phase 1: Core CRUD', () => {
  const keyspace = process.env.SCYLLA_KEYSPACE || 'app_keyspace';
  const tableName = TokenManager.TABLES.TOKEN_REGISTRY;

  beforeAll(async () => {
    // Ensure connection
    await ScyllaDb.execute('SELECT now() FROM system.local', []);
    
    // Add testing column if it doesn't exist
    try {
      await ScyllaDb.execute(
        `ALTER TABLE ${keyspace}.${tableName} ADD IF NOT EXISTS testing boolean`,
        []
      );
    } catch (error) {
      // Column might already exist, or table might not exist yet
      // If table doesn't exist, we'll need to create it first
      if (error.message.includes('does not exist')) {
        throw new Error(`Table ${tableName} does not exist. Please create it first.`);
      }
      // If column already exists, that's fine
      if (!error.message.includes('already exists') && !error.message.includes('Invalid')) {
        throw error;
      }
    }
  });

  afterEach(async () => {
    // Cleanup: Delete all rows with testing = true
    try {
      await ScyllaDb.execute(
        `DELETE FROM ${keyspace}.${tableName} WHERE testing = true`,
        []
      );
    } catch (error) {
      // If no rows match, that's fine
      if (!error.message.includes('does not exist')) {
        console.warn('Cleanup warning:', error.message);
      }
    }
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
      const metadata = { orderId: 'order-123' };

      // Call real TokenManager
      const transaction = await TokenManager.creditPaidTokens(userId, amount, purpose, metadata);

      // Assert: Query DB directly using raw CQL
      const result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [transaction.id]
      );

      expect(result.rows.length).toBe(1);
      const row = result.rows[0];

      // cassandra-driver Row objects support .get() method and property access
      // Column names are lowercase in ScyllaDB (unquoted identifiers)
      const rowId = row.get ? row.get('id') : row.id;
      const rowUserId = row.get ? row.get('userid') : row.userid;
      const rowTransactionType = row.get ? row.get('transactiontype') : row.transactiontype;
      const rowAmount = row.get ? row.get('amount') : row.amount;
      const rowPurpose = row.get ? row.get('purpose') : row.purpose;
      const rowTesting = row.get ? row.get('testing') : row.testing;

      expect(rowId?.toString()).toBe(transaction.id);
      expect(rowUserId?.toString()).toBe(userId);
      expect(rowTransactionType?.toString()).toBe(TokenManager.TRANSACTION_TYPES.CREDIT_PAID);
      expect(Number(rowAmount)).toBe(amount);
      expect(rowPurpose?.toString()).toBe(purpose);
      expect(rowTesting).toBe(true); // Must have testing flag
    });

    test('1.1.2 - Create CREDIT_PAID and verify balance via getUserBalance', async () => {
      const userId = 'test-user-1.1.2';
      const amount = 150;

      // Seed: Insert directly via CQL
      const transactionId = require('crypto').randomUUID();
      const now = DateTime.now();
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transactionId,
          userId,
          TokenManager.SYSTEM_BENEFICIARY_ID,
          TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          amount,
          'test_seed',
          `ref-${transactionId}`,
          '9999-12-31T23:59:59.999Z',
          now,
          JSON.stringify({}),
          1,
          true
        ]
      );

      // Call real TokenManager
      const balance = await TokenManager.getUserBalance(userId);

      // Assert
      expect(balance.paidTokens).toBe(amount);
      expect(balance.totalFreeTokens).toBe(0);
    });

    test('1.1.3 - Create multiple CREDIT_PAID transactions and verify aggregate balance', async () => {
      const userId = 'test-user-1.1.3';

      // Seed: Insert multiple transactions via CQL
      const now = DateTime.now();
      const amounts = [50, 75, 25];
      for (const amount of amounts) {
        const transactionId = require('crypto').randomUUID();
        await ScyllaDb.execute(
          `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            transactionId,
            userId,
            TokenManager.SYSTEM_BENEFICIARY_ID,
            TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
            amount,
            'test_seed',
            `ref-${transactionId}`,
            '9999-12-31T23:59:59.999Z',
            now,
            JSON.stringify({}),
            1,
            true
          ]
        );
      }

      // Call real TokenManager
      const balance = await TokenManager.getUserBalance(userId);

      // Assert
      const expectedTotal = amounts.reduce((a, b) => a + b, 0);
      expect(balance.paidTokens).toBe(expectedTotal);

      // Verify count in DB
      const result = await ScyllaDb.execute(
        `SELECT COUNT(*) as count FROM ${keyspace}.${tableName} WHERE userid = ? AND transactiontype = ? AND testing = true ALLOW FILTERING`,
        [userId, TokenManager.TRANSACTION_TYPES.CREDIT_PAID]
      );
      const countRow = result.rows[0];
      expect(Number(countRow.get('count') ?? countRow.count)).toBe(amounts.length);
    });
  });

  describe('1.2 - Read transactions', () => {
    test('1.2.1 - Read transaction by ID via getItem', async () => {
      const userId = 'test-user-1.2.1';
      const amount = 200;

      // Seed: Insert via CQL
      const transactionId = require('crypto').randomUUID();
      const now = DateTime.now();
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transactionId,
          userId,
          TokenManager.SYSTEM_BENEFICIARY_ID,
          TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          amount,
          'test_seed',
          `ref-${transactionId}`,
          '9999-12-31T23:59:59.999Z',
          now,
          JSON.stringify({ test: 'data' }),
          1,
          true
        ]
      );

      // Call real TokenManager (via internal getItem usage in other methods)
      // We'll verify by checking getUserBalance which internally queries
      const balance = await TokenManager.getUserBalance(userId);

      // Assert
      expect(balance.paidTokens).toBe(amount);

      // Also verify direct DB read
      const result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [transactionId]
      );
      expect(result.rows.length).toBe(1);
      const row = result.rows[0];
      expect(Number(row.get('amount') ?? row.amount)).toBe(amount);
    });

    test('1.2.2 - Read user transactions via query', async () => {
      const userId = 'test-user-1.2.2';

      // Seed: Insert multiple transactions
      const now = DateTime.now();
      const transactions = [];
      for (let i = 0; i < 3; i++) {
        const transactionId = require('crypto').randomUUID();
        await ScyllaDb.execute(
          `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            transactionId,
            userId,
            TokenManager.SYSTEM_BENEFICIARY_ID,
            TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
            10 * (i + 1),
            'test_seed',
            `ref-${transactionId}`,
            '9999-12-31T23:59:59.999Z',
            now,
            JSON.stringify({}),
            1,
            true
          ]
        );
        transactions.push(transactionId);
      }

      // Call real TokenManager - getUserBalance queries user transactions
      const balance = await TokenManager.getUserBalance(userId);

      // Assert
      expect(balance.paidTokens).toBe(60); // 10 + 20 + 30

      // Verify via direct query
      const result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE userid = ? AND testing = true ALLOW FILTERING`,
        [userId]
      );
      expect(result.rows.length).toBe(3);
    });
  });

  describe('1.3 - Update balance via DEBIT', () => {
    test('1.3.1 - DEBIT reduces paid token balance', async () => {
      const userId = 'test-user-1.3.1';
      const creditAmount = 100;
      const debitAmount = 30;

      // Seed: Insert CREDIT_PAID via CQL
      const creditId = require('crypto').randomUUID();
      const now = DateTime.now();
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          creditId,
          userId,
          TokenManager.SYSTEM_BENEFICIARY_ID,
          TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          creditAmount,
          'test_seed',
          `ref-${creditId}`,
          '9999-12-31T23:59:59.999Z',
          now,
          JSON.stringify({}),
          1,
          true
        ]
      );

      // Verify initial balance
      let balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(creditAmount);

      // Call real TokenManager - deduct tokens
      const debitTransaction = await TokenManager.deductTokens(userId, debitAmount, {
        beneficiaryId: 'merchant-1',
        purpose: 'purchase'
      });

      // Assert: Verify balance after debit
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(creditAmount - debitAmount);

      // Assert: Verify DEBIT transaction in DB
      const result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [debitTransaction.id]
      );
      expect(result.rows.length).toBe(1);
      const row = result.rows[0];
      expect(row.get('transactiontype')?.toString() || row.transactiontype?.toString()).toBe(TokenManager.TRANSACTION_TYPES.DEBIT);
      expect(Number(row.get('amount') ?? row.amount)).toBe(debitAmount);
      expect(row.get('testing') ?? row.testing).toBe(true);
    });

    test('1.3.2 - Multiple DEBITs reduce balance correctly', async () => {
      const userId = 'test-user-1.3.2';
      const creditAmount = 200;
      const debitAmount1 = 50;
      const debitAmount2 = 75;

      // Seed: Insert CREDIT_PAID
      const creditId = require('crypto').randomUUID();
      const now = DateTime.now();
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          creditId,
          userId,
          TokenManager.SYSTEM_BENEFICIARY_ID,
          TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          creditAmount,
          'test_seed',
          `ref-${creditId}`,
          '9999-12-31T23:59:59.999Z',
          now,
          JSON.stringify({}),
          1,
          true
        ]
      );

      // First debit
      await TokenManager.deductTokens(userId, debitAmount1, {
        beneficiaryId: 'merchant-1',
        purpose: 'purchase-1'
      });

      // Verify intermediate balance
      let balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(creditAmount - debitAmount1);

      // Second debit
      await TokenManager.deductTokens(userId, debitAmount2, {
        beneficiaryId: 'merchant-2',
        purpose: 'purchase-2'
      });

      // Assert: Final balance
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(creditAmount - debitAmount1 - debitAmount2);

      // Verify DEBIT count in DB
      const result = await ScyllaDb.execute(
        `SELECT COUNT(*) as count FROM ${keyspace}.${tableName} WHERE userid = ? AND transactiontype = ? AND testing = true ALLOW FILTERING`,
        [userId, TokenManager.TRANSACTION_TYPES.DEBIT]
      );
      const countRow = result.rows[0];
      expect(Number(countRow.get('count') ?? countRow.count)).toBe(2);
    });
  });

  describe('1.4 - Expire tokens', () => {
    test('1.4.1 - Expired CREDIT_FREE tokens are excluded from balance', async () => {
      const userId = 'test-user-1.4.1';

      // Seed: Insert expired CREDIT_FREE via CQL
      const expiredId = require('crypto').randomUUID();
      const pastDate = DateTime.now();
      // Set expiresAt to past (subtract 1 day in seconds)
      const expiredAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          expiredId,
          userId,
          TokenManager.SYSTEM_BENEFICIARY_ID,
          TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
          50,
          'test_seed',
          `ref-${expiredId}`,
          expiredAt,
          pastDate,
          JSON.stringify({}),
          1,
          true
        ]
      );

      // Seed: Insert non-expired CREDIT_FREE
      const validId = require('crypto').randomUUID();
      const futureDate = DateTime.future(30 * 24 * 60 * 60); // 30 days
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          validId,
          userId,
          TokenManager.SYSTEM_BENEFICIARY_ID,
          TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
          30,
          'test_seed',
          `ref-${validId}`,
          futureDate,
          pastDate,
          JSON.stringify({}),
          1,
          true
        ]
      );

      // Call real TokenManager
      const balance = await TokenManager.getUserBalance(userId);

      // Assert: Only non-expired tokens should be counted
      expect(balance.totalFreeTokens).toBe(30); // Only the valid one
      expect(balance.freeTokensPerBeneficiary[TokenManager.SYSTEM_BENEFICIARY_ID]).toBe(30);
    });

    test('1.4.2 - processExpiredHolds expires HOLD transactions', async () => {
      const userId = 'test-user-1.4.2';

      // Seed: Insert CREDIT_PAID
      const creditId = require('crypto').randomUUID();
      const now = DateTime.now();
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          creditId,
          userId,
          TokenManager.SYSTEM_BENEFICIARY_ID,
          TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          100,
          'test_seed',
          `ref-${creditId}`,
          '9999-12-31T23:59:59.999Z',
          now,
          JSON.stringify({}),
          1,
          true
        ]
      );

      // Seed: Insert expired HOLD (created more than 1800 seconds ago)
      const holdId = require('crypto').randomUUID();
      const oldCreatedAt = new Date(Date.now() - 2000 * 1000).toISOString(); // 2000 seconds ago
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, state, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          holdId,
          userId,
          userId,
          TokenManager.TRANSACTION_TYPES.HOLD,
          20,
          'test_hold',
          `ref-${holdId}`,
          '9999-12-31T23:59:59.999Z',
          oldCreatedAt,
          JSON.stringify({}),
          1,
          TokenManager.HOLD_STATES.OPEN,
          true
        ]
      );

      // Verify HOLD exists and is OPEN
      let result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [holdId]
      );
      let row = result.rows[0];
      expect(row.get('state')?.toString() || row.state?.toString()).toBe(TokenManager.HOLD_STATES.OPEN);

      // Call real TokenManager - process expired holds
      await TokenManager.processExpiredHolds(1800, 1000);

      // Assert: HOLD should be reversed
      result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [holdId]
      );
      row = result.rows[0];
      expect(row.get('state')?.toString() || row.state?.toString()).toBe(TokenManager.HOLD_STATES.REVERSED);
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
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          creditId,
          userId,
          TokenManager.SYSTEM_BENEFICIARY_ID,
          TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          creditAmount,
          'test_seed',
          `ref-${creditId}`,
          '9999-12-31T23:59:59.999Z',
          now,
          JSON.stringify({}),
          1,
          true
        ]
      );

      // Verify initial balance
      let balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(creditAmount);

      // DEBIT
      await TokenManager.deductTokens(userId, debitAmount, {
        beneficiaryId: 'merchant-1',
        purpose: 'purchase'
      });

      // Assert: Final balance via TokenManager
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(creditAmount - debitAmount);

      // Assert: Verify via raw DB query
      const creditResult = await ScyllaDb.execute(
        `SELECT SUM(amount) as total FROM ${keyspace}.${tableName} WHERE userid = ? AND transactiontype = ? AND testing = true ALLOW FILTERING`,
        [userId, TokenManager.TRANSACTION_TYPES.CREDIT_PAID]
      );
      const debitResult = await ScyllaDb.execute(
        `SELECT SUM(amount) as total FROM ${keyspace}.${tableName} WHERE userid = ? AND transactiontype = ? AND testing = true ALLOW FILTERING`,
        [userId, TokenManager.TRANSACTION_TYPES.DEBIT]
      );

      const creditRow = creditResult.rows[0];
      const debitRow = debitResult.rows[0];
      const totalCredits = Number(creditRow.get('total') ?? creditRow.total ?? 0);
      const totalDebits = Number(debitRow.get('total') ?? debitRow.total ?? 0);
      expect(totalCredits - totalDebits).toBe(creditAmount - debitAmount);
    });

    test('1.5.2 - Balance invariants: paid + free = total usable', async () => {
      const userId = 'test-user-1.5.2';

      // Seed: CREDIT_PAID
      await TokenManager.creditPaidTokens(userId, 100, 'test', {});

      // Seed: CREDIT_FREE via CQL
      const freeId = require('crypto').randomUUID();
      const now = DateTime.now();
      const futureDate = DateTime.future(30 * 24 * 60 * 60);
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          freeId,
          userId,
          TokenManager.SYSTEM_BENEFICIARY_ID,
          TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
          50,
          'test_seed',
          `ref-${freeId}`,
          futureDate,
          now,
          JSON.stringify({}),
          1,
          true
        ]
      );

      // Call real TokenManager
      const balance = await TokenManager.getUserBalance(userId);

      // Assert: Invariants
      expect(balance.paidTokens).toBe(100);
      expect(balance.totalFreeTokens).toBe(50);
      expect(balance.paidTokens + balance.totalFreeTokens).toBe(150);
    });
  });
});

describe('TokenManager Integration Tests - Phase 2: HOLD Operations, CREDIT_FREE, and Advanced Scenarios', () => {
  const keyspace = process.env.SCYLLA_KEYSPACE || 'app_keyspace';
  const tableName = TokenManager.TABLES.TOKEN_REGISTRY;

  beforeAll(async () => {
    // Ensure connection
    await ScyllaDb.execute('SELECT now() FROM system.local', []);
  });

  afterEach(async () => {
    // Cleanup: Delete all rows with testing = true
    try {
      await ScyllaDb.execute(
        `DELETE FROM ${keyspace}.${tableName} WHERE testing = true`,
        []
      );
    } catch (error) {
      if (!error.message.includes('does not exist')) {
        console.warn('Cleanup warning:', error.message);
      }
    }
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
      await TokenManager.creditPaidTokens(userId, 100, 'test_seed', {});

      // Call real TokenManager - create HOLD
      const hold = await TokenManager.holdTokens(userId, holdAmount, beneficiaryId, {
        refId: 'booking-123',
        purpose: 'booking_hold'
      });

      // Assert: Verify HOLD transaction in DB
      const result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [hold.id]
      );
      expect(result.rows.length).toBe(1);
      const row = result.rows[0];
      expect(row.get('transactiontype')?.toString() || row.transactiontype?.toString()).toBe(TokenManager.TRANSACTION_TYPES.HOLD);
      expect(row.get('state')?.toString() || row.state?.toString()).toBe(TokenManager.HOLD_STATES.OPEN);
      expect(Number(row.get('amount') ?? row.amount)).toBe(holdAmount);
      expect(row.get('userid')?.toString() || row.userid?.toString()).toBe(userId);
      expect(row.get('beneficiaryid')?.toString() || row.beneficiaryid?.toString()).toBe(beneficiaryId);
      expect(row.get('testing') ?? row.testing).toBe(true);

      // Assert: Balance should reflect HOLD deduction
      const balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(100 - holdAmount); // HOLD reduces available balance
    });

    test('2.1.2 - Capture HOLD and verify state change', async () => {
      const userId = 'test-user-2.1.2';
      const beneficiaryId = 'merchant-2';
      const holdAmount = 30;

      // Seed: Insert CREDIT_PAID
      await TokenManager.creditPaidTokens(userId, 100, 'test_seed', {});

      // Create HOLD
      const hold = await TokenManager.holdTokens(userId, holdAmount, beneficiaryId, {
        refId: 'booking-456'
      });

      // Verify HOLD is OPEN
      let result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [hold.id]
      );
      let row = result.rows[0];
      expect(row.get('state')?.toString() || row.state?.toString()).toBe(TokenManager.HOLD_STATES.OPEN);

      // Call real TokenManager - capture HOLD
      const captured = await TokenManager.captureHeldTokens({ transactionId: hold.id });

      // Assert: HOLD state should be CAPTURED
      result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [hold.id]
      );
      row = result.rows[0];
      expect(row.get('state')?.toString() || row.state?.toString()).toBe(TokenManager.HOLD_STATES.CAPTURED);

      // Assert: Balance should remain reduced (captured HOLD doesn't restore balance)
      const balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(100 - holdAmount);
    });

    test('2.1.3 - Reverse HOLD and verify balance restoration', async () => {
      const userId = 'test-user-2.1.3';
      const beneficiaryId = 'merchant-3';
      const holdAmount = 25;

      // Seed: Insert CREDIT_PAID
      await TokenManager.creditPaidTokens(userId, 100, 'test_seed', {});

      // Create HOLD
      const hold = await TokenManager.holdTokens(userId, holdAmount, beneficiaryId, {
        refId: 'booking-789'
      });

      // Verify balance reduced
      let balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(100 - holdAmount);

      // Call real TokenManager - reverse HOLD
      await TokenManager.reverseHeldTokens({ transactionId: hold.id });

      // Assert: HOLD state should be REVERSED
      const result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [hold.id]
      );
      const row = result.rows[0];
      expect(row.get('state')?.toString() || row.state?.toString()).toBe(TokenManager.HOLD_STATES.REVERSED);

      // Assert: Balance should be restored
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(100); // Reversed HOLD restores balance
    });

    test('2.1.4 - HOLD with different payer and beneficiary', async () => {
      const payer = 'test-payer-2.1.4';
      const beneficiary = 'test-beneficiary-2.1.4';
      const holdAmount = 40;

      // Seed: Insert CREDIT_PAID for payer
      await TokenManager.creditPaidTokens(payer, 100, 'test_seed', {});

      // Create HOLD (payer holds tokens for beneficiary)
      const hold = await TokenManager.holdTokens(payer, holdAmount, beneficiary, {
        refId: 'transfer-hold-1'
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
        'promo_grant'
      );

      // Assert: Verify CREDIT_FREE transaction in DB
      const result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [transaction.id]
      );
      expect(result.rows.length).toBe(1);
      const row = result.rows[0];
      expect(row.get('transactiontype')?.toString() || row.transactiontype?.toString()).toBe(TokenManager.TRANSACTION_TYPES.CREDIT_FREE);
      expect(row.get('beneficiaryid')?.toString() || row.beneficiaryid?.toString()).toBe(TokenManager.SYSTEM_BENEFICIARY_ID);
      expect(Number(row.get('amount') ?? row.amount)).toBe(amount);
      expect(row.get('testing') ?? row.testing).toBe(true);

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
      await TokenManager.creditFreeTokens(userId, creatorId, amount, expiresAt, 'subscription_bonus');

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

      // Seed: Insert multiple CREDIT_FREE via CQL
      const now = DateTime.now();
      const futureDate = DateTime.future(30 * 24 * 60 * 60);

      // System free tokens
      const systemId = require('crypto').randomUUID();
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [systemId, userId, TokenManager.SYSTEM_BENEFICIARY_ID, TokenManager.TRANSACTION_TYPES.CREDIT_FREE, systemAmount, 'system_promo', `ref-${systemId}`, futureDate, now, JSON.stringify({}), 1, true]
      );

      // Creator 1 free tokens
      const creator1Id = require('crypto').randomUUID();
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [creator1Id, userId, creator1, TokenManager.TRANSACTION_TYPES.CREDIT_FREE, creator1Amount, 'creator1_bonus', `ref-${creator1Id}`, futureDate, now, JSON.stringify({}), 1, true]
      );

      // Creator 2 free tokens
      const creator2Id = require('crypto').randomUUID();
      await ScyllaDb.execute(
        `INSERT INTO ${keyspace}.${tableName} (id, userid, beneficiaryid, transactiontype, amount, purpose, refid, expiresat, createdat, metadata, version, testing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [creator2Id, userId, creator2, TokenManager.TRANSACTION_TYPES.CREDIT_FREE, creator2Amount, 'creator2_bonus', `ref-${creator2Id}`, futureDate, now, JSON.stringify({}), 1, true]
      );

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
      await TokenManager.creditPaidTokens(senderId, 100, 'test_seed', {});

      // Call real TokenManager - transfer tokens
      const tipTransaction = await TokenManager.transferTokens(
        senderId,
        receiverId,
        transferAmount,
        'tip',
        { refId: 'tip-123' }
      );

      // Assert: Verify TIP transaction in DB
      const result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [tipTransaction.id]
      );
      expect(result.rows.length).toBe(1);
      const row = result.rows[0];
      expect(row.get('transactiontype')?.toString() || row.transactiontype?.toString()).toBe(TokenManager.TRANSACTION_TYPES.TIP);
      expect(Number(row.get('amount') ?? row.amount)).toBe(transferAmount);
      expect(row.get('userid')?.toString() || row.userid?.toString()).toBe(senderId);
      expect(row.get('beneficiaryid')?.toString() || row.beneficiaryid?.toString()).toBe(receiverId);
      expect(row.get('testing') ?? row.testing).toBe(true);

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
      await TokenManager.creditPaidTokens(senderId, 50, 'test_seed', {});

      // Seed: Insert beneficiary-specific CREDIT_FREE
      const creatorId = 'creator-transfer';
      await TokenManager.creditFreeTokens(senderId, creatorId, 30, DateTime.future(30 * 24 * 60 * 60), 'bonus');

      // Seed: Insert system CREDIT_FREE
      await TokenManager.creditFreeTokens(senderId, TokenManager.SYSTEM_BENEFICIARY_ID, 20, DateTime.future(30 * 24 * 60 * 60), 'promo');

      // Verify initial balance
      let balance = await TokenManager.getUserBalance(senderId);
      expect(balance.paidTokens).toBe(50);
      expect(balance.totalFreeTokens).toBe(50); // 30 + 20

      // Call real TokenManager - transfer (should consume free tokens first)
      await TokenManager.transferTokens(senderId, receiverId, transferAmount, 'tip');

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
      await TokenManager.creditPaidTokens(userId, 200, 'purchase', {});

      // Seed: CREDIT_FREE (system)
      await TokenManager.creditFreeTokens(userId, TokenManager.SYSTEM_BENEFICIARY_ID, 50, DateTime.future(30 * 24 * 60 * 60), 'promo');

      // Seed: CREDIT_FREE (creator)
      const creatorId = 'creator-mixed';
      await TokenManager.creditFreeTokens(userId, creatorId, 30, DateTime.future(30 * 24 * 60 * 60), 'bonus');

      // Verify initial balance
      let balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(200);
      expect(balance.totalFreeTokens).toBe(80); // 50 + 30

      // Create HOLD
      const hold = await TokenManager.holdTokens(userId, 40, 'merchant-1', { refId: 'hold-mixed' });

      // Verify balance after HOLD
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(160); // 200 - 40

      // DEBIT
      await TokenManager.deductTokens(userId, 30, { beneficiaryId: 'merchant-2', purpose: 'purchase' });

      // Verify balance after DEBIT
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(130); // 160 - 30

      // Capture HOLD
      await TokenManager.captureHeldTokens({ transactionId: hold.id });

      // Verify final balance
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(130); // Still reduced (captured HOLD doesn't restore)
      expect(balance.totalFreeTokens).toBe(80); // Free tokens unchanged
    });

    test('2.4.2 - DEBIT consumes free tokens before paid (priority order)', async () => {
      const userId = 'test-user-2.4.2';
      const beneficiaryId = 'merchant-priority';

      // Seed: CREDIT_PAID
      await TokenManager.creditPaidTokens(userId, 100, 'purchase', {});

      // Seed: Beneficiary-specific CREDIT_FREE
      await TokenManager.creditFreeTokens(userId, beneficiaryId, 25, DateTime.future(30 * 24 * 60 * 60), 'bonus');

      // Seed: System CREDIT_FREE
      await TokenManager.creditFreeTokens(userId, TokenManager.SYSTEM_BENEFICIARY_ID, 15, DateTime.future(30 * 24 * 60 * 60), 'promo');

      // DEBIT that consumes: 25 (beneficiary) + 15 (system) + 10 (paid) = 50
      await TokenManager.deductTokens(userId, 50, { beneficiaryId, purpose: 'purchase' });

      // Assert: Balance after DEBIT
      const balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(90); // 100 - 10
      expect(balance.totalFreeTokens).toBe(0); // All free tokens consumed
      expect(balance.freeTokensPerBeneficiary[beneficiaryId] || 0).toBe(0);
      expect(balance.freeTokensPerBeneficiary[TokenManager.SYSTEM_BENEFICIARY_ID] || 0).toBe(0);

      // Verify DEBIT transaction has free token tracking
      const debitResult = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE userid = ? AND transactiontype = ? AND testing = true ALLOW FILTERING`,
        [userId, TokenManager.TRANSACTION_TYPES.DEBIT]
      );
      expect(debitResult.rows.length).toBe(1);
      const debitRow = debitResult.rows[0];
      const freeBeneficiaryConsumed = Number(debitRow.get('freebeneficiaryconsumed') ?? debitRow.freebeneficiaryconsumed ?? 0);
      const freeSystemConsumed = Number(debitRow.get('freesystemconsumed') ?? debitRow.freesystemconsumed ?? 0);
      expect(freeBeneficiaryConsumed).toBe(25);
      expect(freeSystemConsumed).toBe(15);
      expect(Number(debitRow.get('amount') ?? debitRow.amount)).toBe(10); // Only paid portion
    });

    test('2.4.3 - HOLD lifecycle: create, capture, verify balance invariants', async () => {
      const userId = 'test-user-2.4.3';
      const beneficiaryId = 'merchant-lifecycle';
      const holdAmount = 35;

      // Seed: CREDIT_PAID
      await TokenManager.creditPaidTokens(userId, 100, 'purchase', {});

      // Create HOLD
      const hold = await TokenManager.holdTokens(userId, holdAmount, beneficiaryId, { refId: 'lifecycle-1' });

      // Verify HOLD state and balance
      let result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [hold.id]
      );
      let row = result.rows[0];
      expect(row.get('state')?.toString() || row.state?.toString()).toBe(TokenManager.HOLD_STATES.OPEN);
      
      let balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(100 - holdAmount);

      // Capture HOLD
      await TokenManager.captureHeldTokens({ transactionId: hold.id });

      // Verify HOLD state changed
      result = await ScyllaDb.execute(
        `SELECT * FROM ${keyspace}.${tableName} WHERE id = ?`,
        [hold.id]
      );
      row = result.rows[0];
      expect(row.get('state')?.toString() || row.state?.toString()).toBe(TokenManager.HOLD_STATES.CAPTURED);
      
      // Verify balance unchanged (captured HOLD doesn't restore)
      balance = await TokenManager.getUserBalance(userId);
      expect(balance.paidTokens).toBe(100 - holdAmount);

      // Verify version was incremented
      const version = Number(row.get('version') ?? row.version ?? 1);
      expect(version).toBeGreaterThan(1); // Version should increment on update
    });
  });
});
