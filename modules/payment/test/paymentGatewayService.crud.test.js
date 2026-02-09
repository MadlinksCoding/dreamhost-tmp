// CRUD Tests for paymentGatewayService
const http = require("http");
const path = require("path");

const ScyllaDb = require("../src/utils/ScyllaDb.js");
const CreateTableModule = require("../src/utils/createTable.js");
const paymentGatewayService = require("../src/services/paymentGatewayService.js");

const { createAllTablesFromJson } = CreateTableModule;

// Helper: Check ScyllaDB is running
async function checkScyllaDB() {
  const endpoint = process.env.DYNAMODB_ENDPOINT || 'http://localhost:8000';
  return new Promise((resolve, reject) => {
    const req = http.get(endpoint, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        res.destroy();
        resolve();
      });
    });
    req.on('error', (err) => {
      req.destroy();
      reject(err);
    });
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error('ScyllaDB not accessible'));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('ScyllaDB not accessible'));
    });
  });
}

// Helper: Generate unique test IDs
function generateTestId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// Helper: Create test data factories
const testDataFactory = {
  session: (userId, orderId, pk, sk) => ({
    pk,
    sk,
    userId,
    orderId,
    order_id: orderId,
    sessionType: 'card',
    gateway: 'axcess',
    status: 'pending',
    payloads: { requestData: {}, responseData: {} },
    checkoutId: generateTestId('checkout'),
    amount: '100.00',
    currency: 'USD',
    createdAt: new Date().toISOString()
  }),
  
  transaction: (userId, orderId, txnId, pk, sk, beneficiaryId = null) => ({
    pk,
    sk,
    transactionId: txnId,
    orderId,
    order_id: orderId,
    userId,
    beneficiaryId: beneficiaryId || null,
    recipientId: beneficiaryId || null, // Alternative field name
    orderType: 'payment',
    amount: '50.00',
    currency: 'USD',
    status: 'success',
    statusGSI: 'status#success',
    payloads: { requestData: {}, responseData: {} },
    resultCode: '000.100.110',
    description: 'Transaction successful',
    createdAt: new Date().toISOString()
  }),
  
  schedule: (userId, scheduleId, pk, sk) => {
    const orderId = generateTestId('order');
    const createdAt = new Date().toISOString();
    return {
      pk,
      sk: sk || `schedule#${scheduleId}#${createdAt}`,
      scheduleId,
      subscriptionId: scheduleId,
      orderId,
      registrationId: generateTestId('reg'),
      userId,
      amount: '25.00',
      currency: 'USD',
      subscriptionPlan: 'basic',
      schedule: 'monthly',
      frequency: 'monthly',
      status: 'active',
      startDate: '2025-01-01',
      nextScheduleDate: '2025-02-01',
      createdAt
    };
  },
  
  token: (userId, registrationId, pk, sk) => ({
    pk,
    sk,
    userId,
    registrationId,
    gateway: 'axcess',
    brand: 'VISA',
    last4: '1234',
    expiry: '2025-12',
    name: 'Test Card',
    type: 'card',
    createdAt: new Date().toISOString()
  }),
  
  webhook: (orderId, pk, sk) => ({
    pk,
    sk,
    orderId,
    payload: { event: 'payment.success' },
    actionTaken: 'processed',
    handled: true,
    idempotencyKey: generateTestId('idempotency'),
    createdAt: new Date().toISOString()
  })
};

// Tests use real ScyllaDB only. No in-memory stub. No scan in test code.

beforeAll(async () => {
  // Install in‑memory ScyllaDb stub so tests never hit real AWS/DynamoDB.
  try {
    await checkScyllaDB();
  } catch (error) {
    throw new Error('ScyllaDB is not running. Start with: cd modules/payment && docker compose up -d scylla');
  }

  // Load table configs and create tables (no‑op for in‑memory stub but keeps
  // the tested service code path consistent with production wiring).
  const tablesPath = path.join(__dirname, '../src/utils/tables.json');
  await ScyllaDb.loadTableConfigs?.(tablesPath);

  try {
    await createAllTablesFromJson(tablesPath);
  } catch (error) {
    // Tables might already exist or stub does not care; safe to ignore.
  }

  // Service is static, no initialization needed
});

afterAll(async () => {
  try {
    ScyllaDb.endSession();
  } catch (error) {
    // Ignore
  }
  await new Promise(resolve => setTimeout(resolve, 100));
});

describe('Payment Gateway Service CRUD Tests', () => {
  
  describe('Sessions CRUD', () => {
    const testUserId = generateTestId('user-session');
    const testOrderId = generateTestId('order-session');
    const testPk = `user#${testUserId}`;
    const testSk = `checkout#${testOrderId}`;

    test('should save a session', async () => {
      const sessionData = testDataFactory.session(testUserId, testOrderId, testPk, testSk);
      const result = await paymentGatewayService.saveSession(sessionData);
      expect(result).toBeDefined();
    });

    test('should get user sessions', async () => {
      const sessions = await paymentGatewayService.get_user_sessions(testUserId);
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.some(s => s.orderId === testOrderId)).toBe(true);
    });

    test('should update a session', async () => {
      const updates = { status: 'completed', updatedAt: new Date().toISOString() };
      const result = await paymentGatewayService.updateSession(testPk, testSk, updates);
      expect(result).toBeDefined();
    });

    test('should delete a session', async () => {
      const result = await paymentGatewayService.deleteSession(testPk, testSk);
      expect(result).toBeDefined();
    });
  });

  describe('Transactions CRUD', () => {
    const testUserId = generateTestId('user-txn');
    const testOrderId = generateTestId('order-txn');
    const testTxnId = generateTestId('txn');
    const testPk = `user#${testUserId}`;
    const testSk = `txn#${testTxnId}`;

    test('should save a transaction', async () => {
      const transactionData = testDataFactory.transaction(testUserId, testOrderId, testTxnId, testPk, testSk);
      const result = await paymentGatewayService.saveTransaction(transactionData);
      expect(result).toBeDefined();
    });

    test('should get user transactions', async () => {
      const transactions = await paymentGatewayService.get_user_transactions(testUserId);
      expect(Array.isArray(transactions)).toBe(true);
      expect(transactions.length).toBeGreaterThan(0);
      expect(transactions.some(t => t.transactionId === testTxnId)).toBe(true);
    });

    test('should update a transaction', async () => {
      const updates = { status: 'failed', statusGSI: 'status#failed', updatedAt: new Date().toISOString() };
      const result = await paymentGatewayService.updateTransaction(testPk, testSk, updates);
      expect(result).toBeDefined();
    });

    test('should delete a transaction', async () => {
      const result = await paymentGatewayService.deleteTransaction(testPk, testSk);
      expect(result).toBeDefined();
    });
  });

  describe('Transaction History - Payee and Beneficiary', () => {
    const payeeUserId = generateTestId('payee-user');
    const beneficiaryUserId = generateTestId('beneficiary-user');
    
    // Create multiple transactions for payee
    const payeeTransactions = [];
    for (let i = 0; i < 5; i++) {
      const orderId = generateTestId(`order-payee-${i}`);
      const txnId = generateTestId(`txn-payee-${i}`);
      const pk = `user#${payeeUserId}`;
      const sk = `txn#${txnId}`;
      const txn = testDataFactory.transaction(payeeUserId, orderId, txnId, pk, sk);
      payeeTransactions.push({ orderId, txnId, pk, sk, txn });
    }

    // Create multiple transactions for beneficiary (different types, not just tips)
    const beneficiaryTransactions = [];
    for (let i = 0; i < 5; i++) {
      const payerUserId = generateTestId(`payer-${i}`);
      const orderId = generateTestId(`order-beneficiary-${i}`);
      const txnId = generateTestId(`txn-beneficiary-${i}`);
      const pk = `user#${payerUserId}`;
      const sk = `txn#${txnId}`;
      const orderType = i === 0 ? 'tip' : i === 1 ? 'payment' : i === 2 ? 'subscription' : 'donation';
      const txn = {
        ...testDataFactory.transaction(payerUserId, orderId, txnId, pk, sk, beneficiaryUserId),
        orderType
      };
      beneficiaryTransactions.push({ orderId, txnId, pk, sk, txn });
    }

    beforeAll(async () => {
      // Save all payee transactions
      for (const { txn } of payeeTransactions) {
        await paymentGatewayService.saveTransaction(txn);
      }
      
      // Save all beneficiary transactions
      for (const { txn } of beneficiaryTransactions) {
        await paymentGatewayService.saveTransaction(txn);
      }
    });

    describe('Payee Transaction History', () => {
      test('should get payee transaction history without pagination', async () => {
        const result = await paymentGatewayService.getPayeeTransactionHistory(payeeUserId);
        
        expect(result).toBeDefined();
        expect(result.transactions).toBeDefined();
        expect(Array.isArray(result.transactions)).toBe(true);
        expect(result.count).toBeGreaterThanOrEqual(5);
        expect(result.transactions.length).toBeGreaterThanOrEqual(5);
        expect(result.transactions.every(t => t.userId === payeeUserId)).toBe(true);
        expect(result.hasMore).toBeDefined();
        expect(typeof result.hasMore).toBe('boolean');
      });

      test('should get payee transaction history with limit', async () => {
        const result = await paymentGatewayService.getPayeeTransactionHistory(payeeUserId, { limit: 3 });
        
        expect(result).toBeDefined();
        expect(result.transactions).toBeDefined();
        expect(Array.isArray(result.transactions)).toBe(true);
        expect(result.transactions.length).toBeLessThanOrEqual(3);
        expect(result.count).toBeLessThanOrEqual(3);
        expect(result.hasMore).toBeDefined();
      });

      test('should get payee transaction history with pagination', async () => {
        // First page
        const firstPage = await paymentGatewayService.getPayeeTransactionHistory(payeeUserId, { limit: 2 });
        
        expect(firstPage).toBeDefined();
        expect(firstPage.transactions.length).toBeLessThanOrEqual(2);
        expect(firstPage.nextCursor).toBeDefined();
        expect(firstPage.hasMore).toBe(true);
        
        // Second page using cursor
        if (firstPage.nextCursor) {
          const secondPage = await paymentGatewayService.getPayeeTransactionHistory(payeeUserId, {
            limit: 2,
            cursor: firstPage.nextCursor
          });
          
          expect(secondPage).toBeDefined();
          expect(secondPage.transactions).toBeDefined();
          expect(Array.isArray(secondPage.transactions)).toBe(true);
          // Ensure no duplicates
          const firstPageIds = firstPage.transactions.map(t => t.transactionId);
          const secondPageIds = secondPage.transactions.map(t => t.transactionId);
          const duplicates = firstPageIds.filter(id => secondPageIds.includes(id));
          expect(duplicates.length).toBe(0);
        }
      });

      test('should get payee transaction history in ascending order', async () => {
        const result = await paymentGatewayService.getPayeeTransactionHistory(payeeUserId, {
          limit: 10,
          orderBy: 'asc'
        });
        
        expect(result).toBeDefined();
        expect(result.transactions.length).toBeGreaterThan(0);
        // Check ordering (if createdAt is available)
        if (result.transactions.length > 1) {
          const dates = result.transactions.map(t => new Date(t.createdAt || 0).getTime());
          const isAscending = dates.every((date, i) => i === 0 || dates[i - 1] <= date);
          expect(isAscending).toBe(true);
        }
      });
    });

    describe('Beneficiary Transaction History', () => {
      test('should get beneficiary transaction history without pagination', async () => {
        const result = await paymentGatewayService.getBeneficiaryTransactionHistory(beneficiaryUserId);
        
        expect(result).toBeDefined();
        expect(result.transactions).toBeDefined();
        expect(Array.isArray(result.transactions)).toBe(true);
        expect(result.count).toBeGreaterThanOrEqual(5);
        expect(result.transactions.length).toBeGreaterThanOrEqual(5);
        // Verify all transactions have this user as beneficiary
        expect(result.transactions.every(t => 
          t.beneficiaryId === beneficiaryUserId || t.recipientId === beneficiaryUserId
        )).toBe(true);
        expect(result.hasMore).toBeDefined();
        expect(typeof result.hasMore).toBe('boolean');
      });

      test('should get beneficiary transaction history with limit', async () => {
        const result = await paymentGatewayService.getBeneficiaryTransactionHistory(beneficiaryUserId, { limit: 3 });
        
        expect(result).toBeDefined();
        expect(result.transactions).toBeDefined();
        expect(Array.isArray(result.transactions)).toBe(true);
        expect(result.transactions.length).toBeLessThanOrEqual(3);
        expect(result.count).toBeLessThanOrEqual(3);
        expect(result.hasMore).toBeDefined();
      });

      test('should get beneficiary transaction history with pagination', async () => {
        // First page
        const firstPage = await paymentGatewayService.getBeneficiaryTransactionHistory(beneficiaryUserId, { limit: 2 });
        
        expect(firstPage).toBeDefined();
        expect(firstPage.transactions.length).toBeLessThanOrEqual(2);
        expect(firstPage.hasMore).toBeDefined();
        
        // Second page using cursor if available
        if (firstPage.nextCursor) {
          const secondPage = await paymentGatewayService.getBeneficiaryTransactionHistory(beneficiaryUserId, {
            limit: 2,
            cursor: firstPage.nextCursor
          });
          
          expect(secondPage).toBeDefined();
          expect(secondPage.transactions).toBeDefined();
          expect(Array.isArray(secondPage.transactions)).toBe(true);
          // Ensure no duplicates
          const firstPageIds = firstPage.transactions.map(t => t.transactionId);
          const secondPageIds = secondPage.transactions.map(t => t.transactionId);
          const duplicates = firstPageIds.filter(id => secondPageIds.includes(id));
          expect(duplicates.length).toBe(0);
        }
      });

      test('should get all beneficiary transaction types (not just tips)', async () => {
        const result = await paymentGatewayService.getBeneficiaryTransactionHistory(beneficiaryUserId, { limit: 10 });
        
        expect(result).toBeDefined();
        expect(result.transactions.length).toBeGreaterThanOrEqual(5);
        
        // Verify different order types are included
        const orderTypes = result.transactions.map(t => t.orderType).filter(Boolean);
        expect(orderTypes.length).toBeGreaterThan(0);
        // Should include more than just 'tip'
        const uniqueTypes = [...new Set(orderTypes)];
        expect(uniqueTypes.length).toBeGreaterThan(1);
      });

      test('should get beneficiary transaction history in descending order', async () => {
        const result = await paymentGatewayService.getBeneficiaryTransactionHistory(beneficiaryUserId, {
          limit: 10,
          orderBy: 'desc'
        });
        
        expect(result).toBeDefined();
        expect(result.transactions.length).toBeGreaterThan(0);
        // Check ordering (if createdAt is available)
        if (result.transactions.length > 1) {
          const dates = result.transactions.map(t => new Date(t.createdAt || 0).getTime());
          const isDescending = dates.every((date, i) => i === 0 || dates[i - 1] >= date);
          expect(isDescending).toBe(true);
        }
      });
    });

    describe('Transaction History Edge Cases', () => {
      test('should handle empty payee history', async () => {
        const emptyUserId = generateTestId('empty-user');
        const result = await paymentGatewayService.getPayeeTransactionHistory(emptyUserId);
        
        expect(result).toBeDefined();
        expect(result.transactions).toBeDefined();
        expect(Array.isArray(result.transactions)).toBe(true);
        expect(result.transactions.length).toBe(0);
        expect(result.count).toBe(0);
        expect(result.hasMore).toBe(false);
        expect(result.nextCursor).toBeNull();
      });

      test('should handle empty beneficiary history', async () => {
        const emptyUserId = generateTestId('empty-beneficiary');
        const result = await paymentGatewayService.getBeneficiaryTransactionHistory(emptyUserId);
        
        expect(result).toBeDefined();
        expect(result.transactions).toBeDefined();
        expect(Array.isArray(result.transactions)).toBe(true);
        expect(result.transactions.length).toBe(0);
        expect(result.count).toBe(0);
        expect(result.hasMore).toBe(false);
        expect(result.nextCursor).toBeNull();
      });

      test('should respect max limit', async () => {
        const result = await paymentGatewayService.getPayeeTransactionHistory(payeeUserId, { limit: 200 });
        
        expect(result).toBeDefined();
        expect(result.transactions.length).toBeLessThanOrEqual(100); // Max limit is 100
      });

      test('should handle invalid limit gracefully', async () => {
        const result = await paymentGatewayService.getPayeeTransactionHistory(payeeUserId, { limit: -5 });
        
        expect(result).toBeDefined();
        expect(result.transactions).toBeDefined();
        expect(Array.isArray(result.transactions)).toBe(true);
      });
    });
  });

  describe('Schedules CRUD', () => {
    const testUserId = generateTestId('user-schedule');
    const testScheduleId = generateTestId('schedule');
    const testPk = `user#${testUserId}`;
    const testSk = `schedule#${testScheduleId}`;

    test('should save a schedule', async () => {
      const scheduleData = testDataFactory.schedule(testUserId, testScheduleId, testPk, testSk);
      const result = await paymentGatewayService.saveSchedule(scheduleData);
      expect(result).toBeDefined();
    });

    test('should get user schedules', async () => {
      const schedules = await paymentGatewayService.get_user_schedules(testUserId);
      expect(Array.isArray(schedules)).toBe(true);
      expect(schedules.length).toBeGreaterThan(0);
      expect(schedules.some(s => s.scheduleId === testScheduleId)).toBe(true);
    });

    test('should update a schedule', async () => {
      const updates = { status: 'paused', updatedAt: new Date().toISOString() };
      const result = await paymentGatewayService.updateSchedule(testScheduleId, updates);
      expect(result).toBeDefined();
    });

    test('should delete a schedule', async () => {
      const result = await paymentGatewayService.deleteSchedule(testPk, testSk);
      expect(result).toBeDefined();
    });
  });

  describe('Tokens CRUD', () => {
    const testUserId = generateTestId('user-token');
    const testRegistrationId = generateTestId('reg');
    const testPk = `user#${testUserId}`;
    const testSk = `token#${testRegistrationId}`;

    test('should save a token', async () => {
      const tokenData = testDataFactory.token(testUserId, testRegistrationId, testPk, testSk);
      const result = await paymentGatewayService.saveToken(tokenData);
      expect(result).toBeDefined();
    });

    test('should get user tokens', async () => {
      const tokens = await paymentGatewayService.get_user_tokens(testUserId);
      expect(Array.isArray(tokens)).toBe(true);
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.some(t => t.registrationId === testRegistrationId)).toBe(true);
    });

    test('should update a token', async () => {
      const updates = { expiry: '2026-12', updatedAt: new Date().toISOString() };
      const result = await paymentGatewayService.updateToken(testPk, testSk, updates);
      expect(result).toBeDefined();
    });

    test('should delete a token', async () => {
      const result = await paymentGatewayService.deleteToken(testPk, testSk);
      expect(result).toBeDefined();
    });
  });

  describe('Webhooks CRUD', () => {
    const testOrderId = generateTestId('order-webhook');
    const testPk = `order#${testOrderId}`;
    let testSk;

    test('should save a webhook', async () => {
      testSk = `webhook#${Date.now()}`;
      const webhookData = testDataFactory.webhook(testOrderId, testPk, testSk);
      const result = await paymentGatewayService.saveWebhook(webhookData);
      expect(result).toBeDefined();
    });

    test('should get order webhooks', async () => {
      const webhooks = await paymentGatewayService.get_order_webhooks(testOrderId);
      expect(Array.isArray(webhooks)).toBe(true);
      expect(webhooks.length).toBeGreaterThan(0);
    });

    test('should update a webhook', async () => {
      const updates = { handled: false, updatedAt: new Date().toISOString() };
      const result = await paymentGatewayService.updateWebhook(testPk, testSk, updates);
      expect(result).toBeDefined();
    });

    test('should delete a webhook', async () => {
      const result = await paymentGatewayService.deleteWebhook(testPk, testSk);
      expect(result).toBeDefined();
    });
  });

});
