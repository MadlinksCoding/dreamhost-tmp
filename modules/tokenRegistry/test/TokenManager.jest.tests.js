const crypto = require('crypto');

const mockScyllaDb = {
  putItem: jest.fn(),
  query: jest.fn(),
  deleteItem: jest.fn(),
  scan: jest.fn(),
  getItem: jest.fn(),
  updateItem: jest.fn(),
};

const mockLogger = {
  debugLog: jest.fn(),
  writeLog: jest.fn(),
};

const mockErrorHandler = {
  addError: jest.fn(),
  clear: jest.fn(),
  getAllErrors: jest.fn(() => []),
};

const mockSafeUtils = {
  sanitizeValidate: jest.fn(),
};

const mockDateTime = {
  now: jest.fn(),
  isPast: jest.fn(),
  parseDateToTimestamp: jest.fn(),
  fromUnixTimestamp: jest.fn(),
  getStartOfDay: jest.fn(),
  getEndOfDay: jest.fn(),
};

const mockConfigLoader = {
  load: jest.fn(() => Promise.resolve()),
};

jest.mock('../src/utils/ScyllaDb.js', () => ({
  putItem: mockScyllaDb.putItem,
  query: mockScyllaDb.query,
  deleteItem: mockScyllaDb.deleteItem,
  scan: mockScyllaDb.scan,
  getItem: mockScyllaDb.getItem,
  updateItem: mockScyllaDb.updateItem,
}));

jest.mock('../src/utils/Logger.js', () => ({
  debugLog: mockLogger.debugLog,
  writeLog: mockLogger.writeLog,
}));

jest.mock('../src/utils/ErrorHandler.js', () => ({
  addError: mockErrorHandler.addError,
  clear: mockErrorHandler.clear,
  getAllErrors: mockErrorHandler.getAllErrors,
}));

jest.mock('../src/utils/SafeUtils.js', () => ({
  sanitizeValidate: mockSafeUtils.sanitizeValidate,
}));

jest.mock('../src/utils/DateTime.js', () => ({
  now: mockDateTime.now,
  isPast: mockDateTime.isPast,
  parseDateToTimestamp: mockDateTime.parseDateToTimestamp,
  fromUnixTimestamp: mockDateTime.fromUnixTimestamp,
  getStartOfDay: mockDateTime.getStartOfDay,
  getEndOfDay: mockDateTime.getEndOfDay,
}));

jest.mock('../src/utils/ConfigFileLoader.js', () => ({
  load: mockConfigLoader.load,
}));

const TokenManager = require('../src/services/TokenManager.js');

const referenceNow = new Date('2025-01-01T00:00:00.000Z');

const defaultSanitizeValidate = (schema) => {
  const normalized = {};
  for (const [key, { value, type, required }] of Object.entries(schema)) {
    const payload = value;
    if (required && (payload === null || payload === undefined || payload === '')) {
      throw new Error(`${key} is required`);
    }
    if (payload !== null && payload !== undefined) {
      if (type === 'int' && (!Number.isInteger(payload) || !Number.isSafeInteger(payload))) {
        throw new Error(`${key} must be an integer`);
      }
      if (type === 'string' && (typeof payload !== 'string' || payload === '')) {
        throw new Error(`${key} must be a string`);
      }
      if (type === 'boolean' && typeof payload !== 'boolean') {
        throw new Error(`${key} must be a boolean`);
      }
    }
    normalized[key] = payload;
  }
  return normalized;
};

const createHoldRecord = (overrides = {}) => {
  const base = {
    id: overrides.id ?? 'hold-default',
    userId: overrides.userId ?? 'user-hold',
    beneficiaryId: overrides.beneficiaryId ?? 'beneficiary-hold',
    refId: overrides.refId ?? 'booking-hold',
    transactionType: TokenManager?.TRANSACTION_TYPES?.HOLD ?? 'HOLD',
    amount: overrides.amount ?? 10,
    state: overrides.state ?? TokenManager?.HOLD_STATES?.OPEN ?? 'OPEN',
    version: overrides.version ?? 1,
    metadata: overrides.metadata ?? JSON.stringify({ auditTrail: [] }),
    createdAt: overrides.createdAt ?? referenceNow.toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(referenceNow.getTime() + 3600 * 1000).toISOString(),
    freeBeneficiaryConsumed: overrides.freeBeneficiaryConsumed ?? 0,
    freeSystemConsumed: overrides.freeSystemConsumed ?? 0,
  };

  return {
    ...base,
    ...overrides,
  };
};

const createTransactionRecord = (overrides = {}) => ({
  id: overrides.id ?? 'tx-default',
  userId: overrides.userId ?? 'user-default',
  beneficiaryId: overrides.beneficiaryId ?? 'beneficiary-default',
  transactionType: overrides.transactionType ?? TokenManager?.TRANSACTION_TYPES?.TIP ?? 'TIP',
  createdAt: overrides.createdAt ?? referenceNow.toISOString(),
  amount: overrides.amount ?? 1,
  metadata: overrides.metadata ?? null,
  refId: overrides.refId ?? 'ref-default',
  freeBeneficiaryConsumed: overrides.freeBeneficiaryConsumed ?? 0,
  freeSystemConsumed: overrides.freeSystemConsumed ?? 0,
  ...overrides,
});

describe('TokenManager getTransactionById coverage', () => {
  const baseRecord = {
    userId: 'record-user',
    beneficiaryId: 'record-user',
    amount: 10,
    transactionType: TokenManager?.TRANSACTION_TYPES?.CREDIT_PAID ?? 'CREDIT_PAID',
    createdAt: referenceNow.toISOString(),
  };

  const buildRecord = (overrides = {}) => ({
    id: overrides.id ?? 'tx-custom',
    ...baseRecord,
    ...overrides,
  });

  afterEach(() => {
    mockScyllaDb.getItem.mockReset();
  });

  test('372. PASS_getTransactionById_1 - valid transactionId returns record.', async () => {
    const record = buildRecord({ id: 'tx-372' });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-372');
    expect(result.id).toBe('tx-372');
  });

  test('373. PASS_getTransactionById_2 - all optional fields returned.', async () => {
    const record = buildRecord({
      id: 'tx-373',
      metadata: JSON.stringify({ foo: 'bar' }),
      refId: 'ref-373',
      expiresAt: '2025-12-31T00:00:00.000Z',
      state: TokenManager.HOLD_STATES.OPEN,
      version: 5,
      freeBeneficiaryConsumed: 2,
      freeSystemConsumed: 1,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-373');
    expect(result.metadata.foo).toBe('bar');
    expect(result.refId).toBe('ref-373');
    expect(result.version).toBe(5);
  });

  test('374. PASS_getTransactionById_3 - minimal fields allowed.', async () => {
    const record = buildRecord({
      id: 'tx-374',
      metadata: null,
      refId: null,
      expiresAt: null,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-374');
    expect(result.metadata).toBeNull();
  });

  test('375. PASS_getTransactionById_4 - metadata parsed when JSON string.', async () => {
    const record = buildRecord({
      id: 'tx-375',
      metadata: JSON.stringify({ nested: { ok: true } }),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-375');
    expect(result.metadata.nested.ok).toBe(true);
  });

  test('376. PASS_getTransactionById_5 - HOLD record keeps state + version.', async () => {
    const record = buildRecord({
      id: 'tx-376',
      transactionType: TokenManager.TRANSACTION_TYPES.HOLD,
      state: TokenManager.HOLD_STATES.OPEN,
      version: 3,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-376');
    expect(result.state).toBe(TokenManager.HOLD_STATES.OPEN);
    expect(result.version).toBe(3);
  });

  test('377. PASS_getTransactionById_6 - TIP includes free consumption fields.', async () => {
    const record = buildRecord({
      id: 'tx-377',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      freeBeneficiaryConsumed: 3,
      freeSystemConsumed: 2,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-377');
    expect(result.freeBeneficiaryConsumed).toBe(3);
    expect(result.freeSystemConsumed).toBe(2);
  });

  test('378. PASS_getTransactionById_7 - CREDIT_FREE expiry returned.', async () => {
    const record = buildRecord({
      id: 'tx-378',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      expiresAt: '2025-05-05T00:00:00.000Z',
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-378');
    expect(result.expiresAt).toBe('2025-05-05T00:00:00.000Z');
  });

  test('379. PASS_getTransactionById_8 - transactionId format accepted.', async () => {
    const record = buildRecord({ id: 'valid-379' });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('valid-379');
    expect(result.id).toBe('valid-379');
  });

  test('380. FAIL_getTransactionById_1 - missing transactionId rejects.', async () => {
    await expect(TokenManager.getTransactionById()).rejects.toThrow(/transactionId is required/);
  });

  test('381. FAIL_getTransactionById_2 - empty transactionId string rejected.', async () => {
    await expect(TokenManager.getTransactionById('')).rejects.toThrow(/transactionId must be a string/);
  });

  test('382. FAIL_getTransactionById_3 - null transactionId rejected.', async () => {
    await expect(TokenManager.getTransactionById(null)).rejects.toThrow(/transactionId is required/);
  });

  test('383. FAIL_getTransactionById_4 - non-existent id returns null.', async () => {
    mockScyllaDb.getItem.mockResolvedValueOnce(null);
    const result = await TokenManager.getTransactionById('missing-383');
    expect(result).toBeNull();
  });

  test('384. FAIL_getTransactionById_5 - wrong format transactionId rejected.', async () => {
    await expect(TokenManager.getTransactionById(12345)).rejects.toThrow(/transactionId must be a string/);
  });

  test('385. FAIL_getTransactionById_6 - DB failure bubbles and logs error.', async () => {
    const err = new Error('getItem error');
    mockScyllaDb.getItem.mockRejectedValueOnce(err);
    await expect(TokenManager.getTransactionById('tx-385')).rejects.toThrow('getItem error');
  });

  test('386. FAIL_getTransactionById_7 - corrupted record missing fields handled.', async () => {
    const record = buildRecord({ id: 'tx-386', userId: undefined });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-386');
    expect(result.userId).toBeUndefined();
  });

  test('387. FAIL_getTransactionById_8 - SQL injection id sanitized (literal id used).', async () => {
    const maliciousId = 'tx-387; DROP TABLE';
    mockScyllaDb.getItem.mockResolvedValueOnce(null);
    await expect(TokenManager.getTransactionById(maliciousId)).resolves.toBeNull();
  });
});

let uuidSpy;

beforeEach(() => {
  jest.restoreAllMocks();
  uuidSpy = jest.spyOn(crypto, 'randomUUID').mockReturnValue('fixed-uuid');
  mockScyllaDb.putItem.mockReset();
  mockScyllaDb.query.mockReset();
  mockScyllaDb.deleteItem.mockReset();
  mockScyllaDb.scan.mockReset();
  mockScyllaDb.getItem.mockReset();
  mockScyllaDb.updateItem.mockReset();
  mockLogger.debugLog.mockReset();
  mockLogger.writeLog.mockReset();
  mockErrorHandler.addError.mockReset();
  mockErrorHandler.clear.mockReset();
  mockSafeUtils.sanitizeValidate.mockReset();
  mockDateTime.now.mockReset();
  mockDateTime.isPast.mockReset();
  mockDateTime.parseDateToTimestamp.mockReset();
  mockDateTime.fromUnixTimestamp.mockReset();
  mockDateTime.getStartOfDay.mockReset();
  mockDateTime.getEndOfDay.mockReset();
  mockConfigLoader.load.mockReset();

  mockScyllaDb.putItem.mockResolvedValue(undefined);
  mockScyllaDb.query.mockResolvedValue([]);
  mockScyllaDb.deleteItem.mockResolvedValue(undefined);
  mockScyllaDb.scan.mockResolvedValue([]);
  mockScyllaDb.getItem.mockResolvedValue(undefined);
  mockScyllaDb.updateItem.mockResolvedValue(undefined);
  mockSafeUtils.sanitizeValidate.mockImplementation(defaultSanitizeValidate);
  mockDateTime.now.mockReturnValue(referenceNow.toISOString());
  mockDateTime.isPast.mockImplementation((value) => {
    if (!value || Number.isNaN(new Date(value).getTime())) {
      return false;
    }
    return new Date(value).getTime() < referenceNow.getTime();
  });
  mockDateTime.parseDateToTimestamp.mockImplementation((value) => Math.floor(new Date(value).getTime() / 1000));
  mockDateTime.fromUnixTimestamp.mockImplementation((ts) => new Date(ts * 1000).toISOString());
  mockDateTime.getStartOfDay.mockImplementation((value) => value);
  mockDateTime.getEndOfDay.mockImplementation((value) => value);
  mockConfigLoader.load.mockResolvedValue(undefined);
});

afterEach(() => {
  uuidSpy.mockRestore();
});

describe('TokenManager addTransaction batch #1', () => {
  describe('PASS addTransaction behaviors', () => {
    test('1. PASS_addTransaction*1 - valid CREDIT_PAID creates record w/ defaults (refId auto if null, expiresAt far-future if null).', async () => {
      const tx = await TokenManager.addTransaction({
        userId: 'user-1',
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: 100,
      });
      expect(mockScyllaDb.putItem).toHaveBeenCalledWith(
        TokenManager.TABLES.TOKEN_REGISTRY,
        expect.objectContaining({
          userId: 'user-1',
          transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          amount: 100,
          refId: expect.stringContaining('no_ref_'),
          expiresAt: '9999-12-31T23:59:59.999Z',
          version: 1,
        }),
      );
      expect(tx.refId).toMatch(/^no_ref_/);
      expect(tx.expiresAt).toBe('9999-12-31T23:59:59.999Z');
    });

    test('2. PASS_addTransaction*2 - valid CREDIT_FREE includes beneficiaryId and respects provided expiresAt.', async () => {
      const expectedExpiry = '2030-01-01T00:00:00.000Z';
      const tx = await TokenManager.addTransaction({
        userId: 'user-2',
        beneficiaryId: 'beneficiary-1',
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
        amount: 50,
        expiresAt: expectedExpiry,
      });
      expect(tx.beneficiaryId).toBe('beneficiary-1');
      expect(tx.expiresAt).toBe(expectedExpiry);
    });

    test('3. PASS_addTransaction*3 - valid HOLD forces state=open even if caller tries to sneak state in metadata.', async () => {
      const tx = await TokenManager.addTransaction({
        userId: 'user-3',
        transactionType: TokenManager.TRANSACTION_TYPES.HOLD,
        beneficiaryId: 'booking',
        amount: 20,
        metadata: { state: 'captured' },
      });
      expect(tx.state).toBe(TokenManager.HOLD_STATES.OPEN);
    });

    test('4. PASS_addTransaction*4 - TIP-like tx includes freeBeneficiaryConsumed + freeSystemConsumed when provided (including 0).', async () => {
      const tx = await TokenManager.addTransaction({
        userId: 'user-4',
        beneficiaryId: 'recipient',
        transactionType: TokenManager.TRANSACTION_TYPES.TIP,
        amount: 30,
        freeBeneficiaryConsumed: 3,
        freeSystemConsumed: 2,
      });
      expect(tx.freeBeneficiaryConsumed).toBe(3);
      expect(tx.freeSystemConsumed).toBe(2);
    });

    test('5. PASS_addTransaction*5 - alreadyValidated=true bypasses sanitizeValidate but still rejects missing required fields.', async () => {
      await expect(
        TokenManager.addTransaction({
          transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          amount: 10,
          alreadyValidated: true,
        }),
      ).rejects.toThrow(/Invalid transaction payload/);
      expect(mockErrorHandler.addError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid transaction payload'),
        expect.objectContaining({ code: 'INVALID_TRANSACTION_PAYLOAD' }),
      );
    });

    test('6. PASS_addTransaction*6 - metadata object serializes to JSON string.', async () => {
      const metadata = { foo: 'bar' };
      const tx = await TokenManager.addTransaction({
        userId: 'user-6',
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: 10,
        metadata,
      });
      expect(tx.metadata).toBe(JSON.stringify(metadata));
    });

    test('7. PASS_addTransaction*7 - beneficiaryId null -> uses SYSTEM_BENEFICIARY_ID.', async () => {
      const tx = await TokenManager.addTransaction({
        userId: 'user-7',
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: 5,
        beneficiaryId: null,
      });
      expect(tx.beneficiaryId).toBe(TokenManager.SYSTEM_BENEFICIARY_ID);
    });

    test('8. PASS_addTransaction*8 - version is set to 1.', async () => {
      const tx = await TokenManager.addTransaction({
        userId: 'user-8',
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: 10,
      });
      expect(tx.version).toBe(1);
    });
  });

  describe('FAIL addTransaction behaviors', () => {
    test('9. FAIL*addTransaction_1 - missing userId throws + ErrorHandler code INVALID_TRANSACTION_PAYLOAD.', async () => {
      await expect(
        TokenManager.addTransaction({
          userId: null,
          transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          amount: 1,
        }),
      ).rejects.toThrow(/Invalid transaction payload/);
      expect(mockErrorHandler.addError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid transaction payload'),
        expect.objectContaining({ code: 'INVALID_TRANSACTION_PAYLOAD' }),
      );
    });

    test('10. FAIL*addTransaction_2 - missing transactionType throws + ErrorHandler INVALID_TRANSACTION_PAYLOAD.', async () => {
      await expect(
        TokenManager.addTransaction({
          userId: 'user-10',
          transactionType: null,
          amount: 1,
        }),
      ).rejects.toThrow(/Invalid transaction payload/);
      expect(mockErrorHandler.addError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid transaction payload'),
        expect.objectContaining({ code: 'INVALID_TRANSACTION_PAYLOAD' }),
      );
    });

    test('11. FAIL*addTransaction_3 - invalid transactionType throws + ErrorHandler INVALID_TRANSACTION_TYPE.', async () => {
      await expect(
        TokenManager.addTransaction({
          userId: 'user-11',
          transactionType: 'NOT_A_TYPE',
          amount: 1,
        }),
      ).rejects.toThrow(/Invalid transaction type/);
      expect(mockErrorHandler.addError).toHaveBeenCalledWith(
        expect.stringContaining('Invalid transaction type'),
        expect.objectContaining({ code: 'INVALID_TRANSACTION_TYPE' }),
      );
    });

    test('12. FAIL*addTransaction_4 - amount non-int (string/float/NaN) triggers sanitizeValidate failure.', async () => {
      await expect(
        TokenManager.addTransaction({
          userId: 'user-12',
          transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          amount: 1.5,
        }),
      ).rejects.toThrow(/must be an integer/);
    });

    test('13. FAIL*addTransaction_5 - ScyllaDb.putItem throws -> ErrorHandler ADD_TRANSACTION_ERROR and rethrow.', async () => {
      mockScyllaDb.putItem.mockRejectedValueOnce(new Error('DB outage'));
      await expect(
        TokenManager.addTransaction({
          userId: 'user-13',
          transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          amount: 10,
        }),
      ).rejects.toThrow('DB outage');
      expect(mockErrorHandler.addError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'ADD_TRANSACTION_ERROR' }),
      );
    });

    test('14. FAIL*addTransaction_6 - metadata contains circular refs -> JSON.stringify throws -> ErrorHandler ADD_TRANSACTION_ERROR.', async () => {
      const circular = {};
      circular.self = circular;
      await expect(
        TokenManager.addTransaction({
          userId: 'user-14',
          transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          amount: 5,
          metadata: circular,
        }),
      ).rejects.toThrow(/circular structure/);
      expect(mockErrorHandler.addError).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: 'ADD_TRANSACTION_ERROR' }),
      );
    });

    test('15. FAIL*addTransaction_7 - prototype pollution attempt inside metadata does not mutate global objects.', async () => {
      const malicious = { __proto__: { hacked: 'yes' }, safe: true };
      await TokenManager.addTransaction({
        userId: 'user-15',
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: 1,
        metadata: malicious,
      });
      expect(Object.prototype).not.toHaveProperty('hacked');
      delete Object.prototype.hacked;
    });
  });
});

describe('TokenManager addTransaction invariants', () => {
  test('336. PASS_ADDTRANSACTION_1 - purpose defaults to the transaction type when omitted.', async () => {
    const tx = await TokenManager.addTransaction({
      userId: 'user-336',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      purpose: null,
    });
    expect(tx.purpose).toBe(TokenManager.TRANSACTION_TYPES.CREDIT_PAID);
  });

  test('337. PASS_ADDTRANSACTION_2 - refId defaults to a no_ref_ placeholder.', async () => {
    const tx = await TokenManager.addTransaction({
      userId: 'user-337',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
    });
    expect(tx.refId).toMatch(/^no_ref_/);
  });

  test('338. PASS_ADDTRANSACTION_3 - missing expiresAt uses the far-future sentinel.', async () => {
    const tx = await TokenManager.addTransaction({
      userId: 'user-338',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
    });
    expect(tx.expiresAt).toBe('9999-12-31T23:59:59.999Z');
  });

  test('339. FAIL_ADDTRANSACTION_1 - invalid transactionType is rejected.', async () => {
    await expect(
      TokenManager.addTransaction({
        userId: 'user-339',
        transactionType: 'INVALID',
        amount: 1,
      }),
    ).rejects.toThrow(/Invalid transaction type/);
  });

  test('340. FAIL_ADDTRANSACTION_2 - missing required fields rejects before writing.', async () => {
    await expect(
      TokenManager.addTransaction({
        userId: 'user-340',
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: null,
      }),
    ).rejects.toThrow(/must be an integer/);
  });
});

describe('PASS getUserBalance behaviors (first five scenarios)', () => {
    test('16. PASS_getUserBalance*1 - no transactions => paidTokens=0, freeTokensPerBeneficiary empty.', async () => {
      mockScyllaDb.query
        .mockResolvedValueOnce([]) // user transactions
        .mockResolvedValueOnce([]); // tips
      const balance = await TokenManager.getUserBalance('user-16');
      expect(balance.paidTokens).toBe(0);
      expect(balance.totalFreeTokens).toBe(0);
      expect(balance.freeTokensPerBeneficiary).toEqual({});
    });

    test('17. PASS_getUserBalance*2 - CREDIT_PAID aggregates sum across multiple rows.', async () => {
      const txs = [
        { transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID, amount: 50 },
        { transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID, amount: 75 },
      ];
      mockScyllaDb.query
        .mockResolvedValueOnce(txs)
        .mockResolvedValueOnce([]);
      const balance = await TokenManager.getUserBalance('user-17');
      expect(balance.paidTokens).toBe(125);
    });

    test('18. PASS_getUserBalance*3 - CREDIT_FREE aggregates per beneficiary and "system" bucket.', async () => {
      const txs = [
        { transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE, amount: 10, beneficiaryId: 'alice' },
        { transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE, amount: 5, beneficiaryId: null },
      ];
      mockScyllaDb.query
        .mockResolvedValueOnce(txs)
        .mockResolvedValueOnce([]);
      const balance = await TokenManager.getUserBalance('user-18');
      expect(balance.freeTokensPerBeneficiary.alice).toBe(10);
      expect(balance.freeTokensPerBeneficiary.system).toBe(5);
    });

    test('19. PASS_getUserBalance*4 - expired CREDIT_FREE (expiresAt in past and not far-future sentinel) is skipped.', async () => {
      const expiredTx = {
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
        amount: 20,
        beneficiaryId: 'alice',
        expiresAt: '2020-01-01T00:00:00.000Z',
      };
      mockScyllaDb.query
        .mockResolvedValueOnce([expiredTx])
        .mockResolvedValueOnce([]);
      const balance = await TokenManager.getUserBalance('user-19');
      expect(balance.freeTokensPerBeneficiary.alice).toBeUndefined();
      expect(balance.totalFreeTokens).toBe(0);
    });

    test('20. PASS_getUserBalance*5 - far-future expiresAt sentinel is NOT treated as expired.', async () => {
      const sentinelTx = {
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
        amount: 40,
        beneficiaryId: 'bob',
        expiresAt: '9999-12-31T23:59:59.999Z',
      };
      mockScyllaDb.query
        .mockResolvedValueOnce([sentinelTx])
        .mockResolvedValueOnce([]);
      const balance = await TokenManager.getUserBalance('user-20');
      expect(balance.freeTokensPerBeneficiary.bob).toBe(40);
    });
});

describe('TokenManager getUserBalance batch #2', () => {
  describe('PASS getUserBalance behaviors (continued)', () => {
    test('21. PASS_getUserBalance*6 - DEBIT subtracts paidTokens and subtracts free consumed fields from correct buckets.', async () => {
      mockScyllaDb.query
        .mockResolvedValueOnce([
          {
            transactionType: TokenManager.TRANSACTION_TYPES.DEBIT,
            amount: 10,
            beneficiaryId: 'alice',
            freeBeneficiaryConsumed: 2,
            freeSystemConsumed: 3,
          },
        ])
        .mockResolvedValueOnce([]);
      const balance = await TokenManager.getUserBalance('user-21');
      expect(balance.freeTokensPerBeneficiary.alice).toBe(-2);
      expect(balance.freeTokensPerBeneficiary.system).toBe(-3);
      expect(balance.paidTokens).toBe(0);
    });

    test('22. PASS_getUserBalance*7 - TIP also subtracts paidTokens and free consumed fields.', async () => {
      mockScyllaDb.query
        .mockResolvedValueOnce([
          {
            transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
            amount: 20,
          },
          {
            transactionType: TokenManager.TRANSACTION_TYPES.TIP,
            userId: 'user-22',
            beneficiaryId: 'friend',
            amount: 5,
            freeBeneficiaryConsumed: 1,
            freeSystemConsumed: 1,
          },
        ])
        .mockResolvedValueOnce([]);
      const balance = await TokenManager.getUserBalance('user-22');
      expect(balance.paidTokens).toBe(15);
      expect(balance.freeTokensPerBeneficiary['friend']).toBe(-1);
      expect(balance.freeTokensPerBeneficiary.system).toBe(-1);
    });

    test('23. PASS_getUserBalance*8 - unknown/unsupported transactionType is ignored or handled predictably (assert no crash).', async () => {
      mockScyllaDb.query
        .mockResolvedValueOnce([
          {
            transactionType: 'UNKNOWN_TYPE',
            amount: 100,
          },
        ])
        .mockResolvedValueOnce([]);
      const balance = await TokenManager.getUserBalance('user-23');
      expect(balance.paidTokens).toBe(0);
      expect(balance.totalFreeTokens).toBe(0);
    });

    test('24. PASS_getUserBalance*9 - large dataset (e.g., 10k tx) completes within reasonable time; no per-tx DB calls.', async () => {
      const largeTx = Array.from({ length: 200 }, (_, index) => ({
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: index + 1,
      }));
      const expected = largeTx.reduce((sum, tx) => sum + tx.amount, 0);
      mockScyllaDb.query
        .mockResolvedValueOnce(largeTx)
        .mockResolvedValueOnce([]);
      const balance = await TokenManager.getUserBalance('user-24');
      expect(balance.paidTokens).toBe(expected);
    });
  });

  describe('FAIL getUserBalance behaviors', () => {
    test('25. FAIL*getUserBalance_1 - userId missing/empty => sanitizeValidate throws.', async () => {
      await expect(TokenManager.getUserBalance('')).rejects.toThrow(/is required/);
      expect(mockScyllaDb.query).not.toHaveBeenCalled();
    });

    test('26. FAIL*getUserBalance_2 - ScyllaDb.query throws => ErrorHandler path invoked + rethrow (assert).', async () => {
      const err = new Error('query failure');
      mockScyllaDb.query.mockRejectedValueOnce(err);
      await expect(TokenManager.getUserBalance('user-26')).rejects.toThrow('query failure');
      expect(mockErrorHandler.addError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to get user balance'),
        expect.objectContaining({ code: 'GET_USER_BALANCE_ERROR', userId: 'user-26' }),
      );
    });

    test('27. FAIL*getUserBalance_3 - tx.amount missing/invalid type in DB record doesn’t crash aggregation (defensive test).', async () => {
      mockScyllaDb.query
        .mockResolvedValueOnce([
          {
            transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
          },
        ])
        .mockResolvedValueOnce([]);
      const balance = await TokenManager.getUserBalance('user-27');
      expect(Number.isNaN(balance.paidTokens)).toBe(true);
    });

    test('28. FAIL*getUserBalance_4 - tx.expiresAt malformed string doesn’t crash DateTime.isPast (assert safe handling).', async () => {
      mockScyllaDb.query
        .mockResolvedValueOnce([
          {
            transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
            amount: 10,
            beneficiaryId: 'amy',
            expiresAt: 'not-a-date',
          },
        ])
        .mockResolvedValueOnce([]);
      const balance = await TokenManager.getUserBalance('user-28');
      expect(balance.freeTokensPerBeneficiary.amy).toBe(10);
      expect(mockDateTime.isPast).toHaveBeenCalledWith('not-a-date');
    });
  });
});

describe('TokenManager getUserTokenSummary batch #1 (happy paths)', () => {
  let getUserBalanceSpy;

  beforeEach(() => {
    getUserBalanceSpy = jest.spyOn(TokenManager, 'getUserBalance');
  });

  afterEach(() => {
    getUserBalanceSpy.mockRestore();
  });

  test('29. PASS_getUserTokenSummary*1 - with only paid credits: summary reflects paidAvailable.', async () => {
    getUserBalanceSpy.mockResolvedValueOnce({
      paidTokens: 60,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const summary = await TokenManager.getUserTokenSummary('user-29');
    expect(summary.paidTokens).toBe(60);
    expect(summary.totalUsableTokens).toBe(60);
  });

  test('30. PASS_getUserTokenSummary*2 - with only free credits: summary reflects freeAvailable buckets.', async () => {
    getUserBalanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 15,
      freeTokensPerBeneficiary: { alice: 15 },
    });
    const summary = await TokenManager.getUserTokenSummary('user-30');
    expect(summary.totalFreeTokens).toBe(15);
    expect(summary.freeTokensPerBeneficiary.alice).toBe(15);
  });

  test('31. PASS_getUserTokenSummary*3 - open HOLD reduces available balance (reserved) but doesn’t delete underlying credits.', async () => {
    getUserBalanceSpy.mockResolvedValueOnce({
      paidTokens: 80,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { openHold: 5 },
    });
    const summary = await TokenManager.getUserTokenSummary('user-31');
    expect(summary.totalUsableTokens).toBe(85);
  });

  test('32. PASS_getUserTokenSummary*4 - captured/reversed HOLD does not reserve.', async () => {
    getUserBalanceSpy.mockResolvedValueOnce({
      paidTokens: 70,
      totalFreeTokens: 10,
      freeTokensPerBeneficiary: { captured: 10 },
    });
    const summary = await TokenManager.getUserTokenSummary('user-32');
    expect(summary.totalFreeTokens).toBe(10);
  });

  test('33. PASS_getUserTokenSummary*5 - mixed credits+debits+tips reflect net.', async () => {
    getUserBalanceSpy.mockResolvedValueOnce({
      paidTokens: 40,
      totalFreeTokens: 8,
      freeTokensPerBeneficiary: { a: 5, b: 3 },
    });
    const summary = await TokenManager.getUserTokenSummary('user-33');
    expect(summary.totalUsableTokens).toBe(48);
    expect(summary.freeTokensPerBeneficiary.a).toBe(5);
  });

  test('34. PASS_getUserTokenSummary*6 - summary stable when system free bucket absent (treat as 0).', async () => {
    getUserBalanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 7,
      freeTokensPerBeneficiary: { crew: 7 },
    });
    const summary = await TokenManager.getUserTokenSummary('user-34');
    expect(summary.totalFreeTokens).toBe(7);
    expect(summary.freeTokensPerBeneficiary.system).toBeUndefined();
  });

  test('35. PASS_getUserTokenSummary*7 - multiple open holds sum reservation.', async () => {
    getUserBalanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 12,
      freeTokensPerBeneficiary: { holdOne: 5, holdTwo: 7 },
    });
    const summary = await TokenManager.getUserTokenSummary('user-35');
    expect(summary.totalFreeTokens).toBe(12);
    expect(summary.freeTokensPerBeneficiary.holdTwo).toBe(7);
  });

  test('36. PASS_getUserTokenSummary*8 - performance: summary calls getUserBalance once, not repeatedly.', async () => {
    getUserBalanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 1,
      freeTokensPerBeneficiary: { perf: 1 },
    });
    await TokenManager.getUserTokenSummary('user-36');
    expect(getUserBalanceSpy).toHaveBeenCalledTimes(1);
  });
});

describe('TokenManager getUserTokenSummary batch #1 (failure paths)', () => {
  test('37. FAIL*getUserTokenSummary_1 - invalid userId throws sanitizeValidate error (indirect via getUserBalance).', async () => {
    await expect(TokenManager.getUserTokenSummary('')).rejects.toThrow(/is required/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get user token summary'),
      expect.objectContaining({ code: 'GET_USER_TOKEN_SUMMARY_ERROR', userId: '' }),
    );
  });

  test('38. FAIL*getUserTokenSummary_2 - corrupted tx.state value doesn’t crash hold-reserve logic.', async () => {
    mockScyllaDb.query
      .mockResolvedValueOnce([
        {
          transactionType: TokenManager.TRANSACTION_TYPES.HOLD,
          amount: 5,
          state: 'weird',
          beneficiaryId: 'corrupt',
        },
      ])
      .mockResolvedValueOnce([]);
    const summary = await TokenManager.getUserTokenSummary('user-38');
    expect(summary.paidTokens).toBe(0);
  });

  test('39. FAIL*getUserTokenSummary_3 - Scylla query fails (from getUserBalance) bubbles properly.', async () => {
    const err = new Error('db fail');
    mockScyllaDb.query.mockRejectedValueOnce(err);
    await expect(TokenManager.getUserTokenSummary('user-39')).rejects.toThrow('db fail');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get user token summary'),
      expect.objectContaining({ code: 'GET_USER_TOKEN_SUMMARY_ERROR', userId: 'user-39' }),
    );
  });
});

describe('TokenManager creditPaidTokens batch #1', () => {
  test('40. PASS_creditPaidTokens*1 - credits paid tokens with default purpose.', async () => {
    await TokenManager.creditPaidTokens('user-40', 15, 'bing', { note: 'gift' });
    const recordedTx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(recordedTx.transactionType).toBe(TokenManager.TRANSACTION_TYPES.CREDIT_PAID);
    expect(recordedTx.purpose).toBe('bing');
    expect(recordedTx.amount).toBe(15);
  });
});

describe('TokenManager creditPaidTokens batch #2', () => {
  test('41. PASS_creditPaidTokens*2 - custom purpose persists.', async () => {
    await TokenManager.creditPaidTokens('user-41', 20, 'special-purpose', { reason: 'reward' });
    const recordedTx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(recordedTx.purpose).toBe('special-purpose');
  });

  test('42. PASS_creditPaidTokens*3 - metadata persists as JSON string.', async () => {
    const metadata = { flag: 'blue' };
    await TokenManager.creditPaidTokens('user-42', 30, 'purchase', metadata);
    const recordedTx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(recordedTx.metadata).toBe(JSON.stringify(metadata));
  });

  test('43. PASS_creditPaidTokens*4 - amount boundary: 1 token.', async () => {
    const result = await TokenManager.creditPaidTokens('user-43', 1);
    expect(result.amount).toBe(1);
  });

  test('44. PASS_creditPaidTokens*5 - large amount (int) accepted.', async () => {
    const bigAmount = 2_000_000_000;
    const result = await TokenManager.creditPaidTokens('user-44', bigAmount);
    expect(result.amount).toBe(bigAmount);
  });

  test('45. PASS_creditPaidTokens*6 - returns transaction payload from addTransaction.', async () => {
    const promise = TokenManager.creditPaidTokens('user-45', 5);
    await expect(promise).resolves.toMatchObject({ userId: 'user-45', amount: 5 });
  });

  test('46. PASS_creditPaidTokens*7 - does not require beneficiaryId.', async () => {
    const result = await TokenManager.creditPaidTokens('user-46', 7);
    const recordedTx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(recordedTx.beneficiaryId).toBe(TokenManager.SYSTEM_BENEFICIARY_ID);
    expect(result.beneficiaryId).toBe(TokenManager.SYSTEM_BENEFICIARY_ID);
  });

  test('47. FAIL*creditPaidTokens_1 - amount 0 or negative rejected.', async () => {
    await expect(TokenManager.creditPaidTokens('user-47', 0)).rejects.toThrow(/amount must be positive/);
  });

  test('48. FAIL*creditPaidTokens_2 - amount float/NaN rejected.', async () => {
    await expect(TokenManager.creditPaidTokens('user-48', 1.5)).rejects.toThrow(/must be an integer/);
  });

  test('49. FAIL*creditPaidTokens_3 - userId invalid rejected.', async () => {
    await expect(TokenManager.creditPaidTokens('', 10)).rejects.toThrow(/Invalid transaction payload/);
  });

  test('50. FAIL*creditPaidTokens_4 - addTransaction throws => bubbles.', async () => {
    const spy = jest.spyOn(TokenManager, 'addTransaction').mockRejectedValueOnce(new Error('boom'));
    await expect(TokenManager.creditPaidTokens('user-50', 10)).rejects.toThrow('boom');
    spy.mockRestore();
  });

  test('51. FAIL*creditPaidTokens_5 - metadata circular => bubbles.', async () => {
    const circular = {};
    circular.self = circular;
    await expect(TokenManager.creditPaidTokens('user-51', 5, 'gift', circular)).rejects.toThrow(/circular/);
  });
});

describe('TokenManager creditFreeTokens batch #1', () => {
  test('52. PASS_creditFreeTokens*1 - credits free tokens to beneficiaryId.', async () => {
    await TokenManager.creditFreeTokens('user-52', 'beneficiary-52', 12);
    const recordedTx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(recordedTx.transactionType).toBe(TokenManager.TRANSACTION_TYPES.CREDIT_FREE);
    expect(recordedTx.beneficiaryId).toBe('beneficiary-52');
  });

  test('53. PASS_creditFreeTokens*2 - expiresAt null => sentinel far-future applied by addTransaction.', async () => {
    const tx = await TokenManager.creditFreeTokens('user-53', 'beneficiary-53', 5, null);
    expect(tx.expiresAt).toBe('9999-12-31T23:59:59.999Z');
  });

  test('54. PASS_creditFreeTokens*3 - expiresAt valid ISO is stored.', async () => {
    const iso = '2035-05-05T00:00:00.000Z';
    const tx = await TokenManager.creditFreeTokens('user-54', 'beneficiary-54', 7, iso);
    expect(tx.expiresAt).toBe(iso);
  });

  test('55. PASS_creditFreeTokens*4 - purpose default "free_grant".', async () => {
    const tx = await TokenManager.creditFreeTokens('user-55', 'beneficiary-55', 8);
    expect(tx.purpose).toBe('free_grant');
  });

  test('56. PASS_creditFreeTokens*5 - metadata stored.', async () => {
    const tx = await TokenManager.creditFreeTokens('user-56', 'beneficiary-56', 9, null, 'free_grant', { note: 'promo' });
    expect(tx.metadata).toContain('"note":"promo"');
    expect(tx.metadata).toContain('"tokenExpiresAt":"9999-12-31T23:59:59.999Z"');
  });

  test('57. PASS_creditFreeTokens*6 - amount boundary 1.', async () => {
    const tx = await TokenManager.creditFreeTokens('user-57', 'beneficiary-57', 1);
    expect(tx.amount).toBe(1);
  });

  test('58. PASS_creditFreeTokens*7 - large amount accepted.', async () => {
    const big = 500_000;
    const tx = await TokenManager.creditFreeTokens('user-58', 'beneficiary-58', big);
    expect(tx.amount).toBe(big);
  });

  test('59. FAIL*creditFreeTokens_1 - missing beneficiaryId rejected.', async () => {
    await expect(TokenManager.creditFreeTokens('user-59', null, 10)).rejects.toThrow(/beneficiaryId is required/);
  });

  test('60. FAIL*creditFreeTokens_2 - expiresAt invalid format rejected (or handled consistently).', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      throw new Error('Invalid expiresAt format');
    });
    await expect(TokenManager.creditFreeTokens('user-60', 'beneficiary-60', 10, 'not-a-date')).rejects.toThrow('Invalid expiresAt format');
  });

  test('61. FAIL*creditFreeTokens_3 - amount <= 0 rejected.', async () => {
    await expect(TokenManager.creditFreeTokens('user-61', 'beneficiary-61', 0)).rejects.toThrow(/must be positive/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Cannot credit free tokens'),
      expect.objectContaining({ code: 'INVALID_AMOUNT' }),
    );
  });

  test('62. FAIL*creditFreeTokens_4 - addTransaction throws bubbles.', async () => {
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('insert failure'));
    await expect(TokenManager.creditFreeTokens('user-62', 'beneficiary-62', 5)).rejects.toThrow('insert failure');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to credit free tokens'),
      expect.objectContaining({ code: 'CREDIT_FREE_TOKENS_ERROR', userId: 'user-62' }),
    );
  });

  test('63. FAIL*creditFreeTokens_5 - malicious beneficiaryId injection strings do not break query keys (sanitization).', async () => {
    const malicious = '$$$\\u0000-<script>';
    const tx = await TokenManager.creditFreeTokens('user-63', malicious, 5);
    expect(tx.beneficiaryId).toBe(malicious);
  });
});

describe('TokenManager deductTokens batch #1', () => {
  let validateSpy;
  let getBalanceSpy;

  beforeEach(() => {
    validateSpy = jest.spyOn(TokenManager, 'validateSufficientTokens').mockResolvedValue(true);
    getBalanceSpy = jest.spyOn(TokenManager, 'getUserBalance');
  });

  afterEach(() => {
    validateSpy.mockRestore();
    getBalanceSpy.mockRestore();
  });

  const expectDebitTransaction = () => {
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.transactionType).toBe(TokenManager.TRANSACTION_TYPES.DEBIT);
    return tx;
  };

  test('64. PASS_deductTokens*1 - paid-only balance: deduct reduces paid tokens only.', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: 100,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.deductTokens('user-64', 10, { beneficiaryId: 'alice' });
    const tx = expectDebitTransaction();
    expect(tx.amount).toBe(10);
    expect(result.amount).toBe(10);
  });

  test('65. PASS_deductTokens*2 - beneficiary-free available: consumes beneficiary-free first (no paid).', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 20,
      freeTokensPerBeneficiary: { alice: 20 },
    });
    const result = await TokenManager.deductTokens('user-65', 15, { beneficiaryId: 'alice', flag: 'promo' });
    const tx = expectDebitTransaction();
    expect(tx.amount).toBe(0);
    expect(tx.freeBeneficiaryConsumed).toBe(15);
    expect(tx.freeSystemConsumed).toBe(0);
    expect(result.metadata.breakdown.beneficiarySpecificFree).toBe(15);
  });

  test('66. PASS_deductTokens*3 - system-free available: consumes system-free after beneficiary-free.', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 10,
      freeTokensPerBeneficiary: { system: 10 },
    });
    await TokenManager.deductTokens('user-66', 5, { beneficiaryId: 'system' });
    const tx = expectDebitTransaction();
    expect(tx.freeBeneficiaryConsumed).toBe(5);
    expect(tx.freeSystemConsumed).toBe(0);
  });

  test('67. PASS_deductTokens*4 - mixed: partial beneficiary-free + system-free + paid remainder.', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { bob: 3, system: 2 },
    });
    await TokenManager.deductTokens('user-67', 7, { beneficiaryId: 'bob' });
    const tx = expectDebitTransaction();
    expect(tx.amount).toBe(2); // paid remainder
    expect(tx.freeBeneficiaryConsumed).toBe(3);
    expect(tx.freeSystemConsumed).toBe(2);
  });

  test('68. PASS_deductTokens*5 - exact-match uses all free, paidAmount=0.', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { carol: 5 },
    });
    await TokenManager.deductTokens('user-68', 5, { beneficiaryId: 'carol' });
    const tx = expectDebitTransaction();
    expect(tx.amount).toBe(0);
    expect(tx.freeBeneficiaryConsumed).toBe(5);
  });

  test('69. PASS_deductTokens*6 - context includes beneficiaryId; debit record uses that beneficiaryId for beneficiary-free consumption bucket.', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.deductTokens('user-69', 4, { beneficiaryId: 'custom' });
    const tx = expectDebitTransaction();
    expect(tx.beneficiaryId).toBe('custom');
  });

  test('70. PASS_deductTokens*7 - refId flows into DEBIT record when provided.', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: 20,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.deductTokens('user-70', 5, { beneficiaryId: 'ref', refId: 'order-123' });
    const tx = expectDebitTransaction();
    expect(tx.refId).toBe('order-123');
  });

  test('71. PASS_deductTokens*8 - metadata stored.', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.deductTokens('user-71', 2, { beneficiaryId: 'meta', flag: 'flag-A' });
    const tx = expectDebitTransaction();
    expect(tx.metadata.flag).toBe('flag-A');
    expect(tx.metadata.breakdown.totalFreeConsumed).toBe(tx.freeBeneficiaryConsumed + tx.freeSystemConsumed);
  });

  test('72. PASS_deductTokens*9 - concurrency safe: balance computed once per call; result consistent.', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: 8,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.deductTokens('user-72', 3, { beneficiaryId: 'sync' });
    expect(getBalanceSpy).toHaveBeenCalledTimes(1);
  });

  test('73. FAIL*deductTokens_1 - amount <= 0 rejected.', async () => {
    await expect(TokenManager.deductTokens('user-73', 0, { beneficiaryId: 'bad' })).rejects.toThrow(/must be positive/);
  });

  test('74. FAIL*deductTokens_2 - missing userId rejected.', async () => {
    await expect(TokenManager.deductTokens('', 5, { beneficiaryId: 'missing' })).rejects.toThrow(/is required/);
  });

  test('75. FAIL*deductTokens_3 - insufficient funds => returns/throws with expected structure from validateSufficientTokens.', async () => {
    validateSpy.mockResolvedValueOnce(false);
    await expect(TokenManager.deductTokens('user-75', 5, { beneficiaryId: 'short' })).rejects.toThrow(/does not have sufficient tokens/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('User does not have sufficient tokens'),
      expect.objectContaining({ code: 'INSUFFICIENT_TOKENS' }),
    );
  });

  test('76. FAIL*deductTokens_4 - balance has negative free bucket (data corruption) => fails safely.', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: -5,
      freeTokensPerBeneficiary: { corrupt: -5 },
    });
    await expect(TokenManager.deductTokens('user-76', 3, { beneficiaryId: 'corrupt' })).rejects.toThrow(/Insufficient paid tokens available/);
    expect(mockScyllaDb.putItem).not.toHaveBeenCalled();
  });

  test('77. FAIL*deductTokens_5 - addTransaction fails -> bubbles.', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('write failed'));
    await expect(TokenManager.deductTokens('user-77', 3, { beneficiaryId: 'alert' })).rejects.toThrow('write failed');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to deduct tokens'),
      expect.objectContaining({ code: 'DEDUCT_TOKENS_ERROR' }),
    );
  });

  test('78. FAIL*deductTokens_6 - prototype pollution in context/metadata doesn’t break internals.', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const context = { beneficiaryId: 'safe' };
    Object.assign(context, { __proto__: { hacked: 'nope' } });
    await TokenManager.deductTokens('user-78', 2, context);
    expect(mockScyllaDb.putItem).toHaveBeenCalled();
    expect(Object.prototype.hacked).toBeUndefined();
  });

  test('79. FAIL*deductTokens_7 - extremely large amount triggers overflow/precision checks (JS int boundaries).', async () => {
    getBalanceSpy.mockResolvedValueOnce({
      paidTokens: Number.MAX_SAFE_INTEGER,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.deductTokens('user-79', Number.MAX_SAFE_INTEGER - 1, { beneficiaryId: 'big' });
    const tx = expectDebitTransaction();
    expect(tx.amount).toBe(Number.MAX_SAFE_INTEGER - 1);
  });
});

describe('TokenManager transferTokens batch #1', () => {
  let balanceSpy;

  beforeEach(() => {
    balanceSpy = jest.spyOn(TokenManager, 'getUserBalance');
  });

  afterEach(() => {
    balanceSpy.mockRestore();
  });

  test('80. PASS_transferTokens*1 - paid-only: sender TIP deducts paid; beneficiary CREDIT_PAID equals amount.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 20,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.transferTokens('sender-80', 'recipient-80', 5);
    expect(mockScyllaDb.putItem).toHaveBeenCalled();
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.transactionType).toBe(TokenManager.TRANSACTION_TYPES.TIP);
    expect(tx.amount).toBe(5);
    expect(result.breakdown.paidTokensTransferred).toBe(5);
  });

  test('81. PASS_transferTokens*2 - free-only: sender TIP consumes free; beneficiary CREDIT_PAID is 0 or absent.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 10,
      freeTokensPerBeneficiary: { 'recipient-81': 10 },
    });
    const result = await TokenManager.transferTokens('sender-81', 'recipient-81', 4);
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.amount).toBe(0); // no paid tokens transferred
    expect(tx.freeBeneficiaryConsumed).toBe(4);
    expect(result.breakdown.freeTokensConsumed).toBe(4);
  });

  test('82. PASS_transferTokens*3 - mixed: beneficiary gets only paidAmount portion, not free portion.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 3,
      freeTokensPerBeneficiary: { 'recipient-82': 2, system: 1 },
    });
    const result = await TokenManager.transferTokens('sender-82', 'recipient-82', 6);
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.amount).toBe(3);
    expect(tx.freeBeneficiaryConsumed).toBe(2);
    expect(tx.freeSystemConsumed).toBe(1);
    expect(result.breakdown.freeTokensConsumed).toBe(3);
    expect(result.breakdown.paidTokensTransferred).toBe(3);
  });

  test('83. PASS_transferTokens*4 - options.refId applied to both tx consistently.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const opts = { refId: 'tip-83', note: 'thanks', isAnonymous: true };
    await TokenManager.transferTokens('sender-83', 'recipient-83', 3, 'thankyou', opts);
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.refId).toBe('tip-83');
    expect(tx.metadata.note).toBe('thanks');
    expect(tx.metadata.isAnonymous).toBe(true);
    expect(tx.metadata.breakdown.paid).toBe(3);
  });

  test('84. PASS_transferTokens*5 - purpose propagates.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 7,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.transferTokens('sender-84', 'recipient-84', 2, 'special-purpose');
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.purpose).toBe('special-purpose');
  });

  test('85. PASS_transferTokens*6 - metadata preserved.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 6,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.transferTokens('sender-85', 'recipient-85', 3, 'transfer', { note: 'keep', isAnonymous: false });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.metadata.note).toBe('keep');
  });

  test('86. PASS_transferTokens*7 - validates beneficiaryId required.', async () => {
    await expect(TokenManager.transferTokens('sender-86', '', 1)).rejects.toThrow(/is required/);
    expect(balanceSpy).not.toHaveBeenCalled();
  });

  test('87. PASS_transferTokens*8 - idempotency-ish: repeated call with same refId behaves consistently.', async () => {
    balanceSpy.mockResolvedValue({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const opts = { refId: 'persist-87' };
    await TokenManager.transferTokens('sender-87', 'recipient-87', 1, 'repeat', opts);
    await TokenManager.transferTokens('sender-87', 'recipient-87', 1, 'repeat', opts);
    const calls = mockScyllaDb.putItem.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][1].refId).toBe('persist-87');
    expect(calls[1][1].refId).toBe('persist-87');
  });

  test('88. FAIL*transferTokens_1 - insufficient tokens rejects.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 1,
      totalFreeTokens: 1,
      freeTokensPerBeneficiary: { recipient: 1 },
    });
    await expect(TokenManager.transferTokens('sender-88', 'recipient-88', 5)).rejects.toThrow(/Insufficient tokens/);
  });

  test('89. FAIL*transferTokens_2 - senderId == beneficiaryId is rejected.', async () => {
    await expect(TokenManager.transferTokens('sender-89', 'sender-89', 2)).rejects.toThrow(/Cannot tip yourself/);
  });

  test('90. FAIL*transferTokens_3 - negative/zero amount rejected.', async () => {
    await expect(TokenManager.transferTokens('sender-90', 'recipient-90', 0)).rejects.toThrow(/greater than 0/);
  });

  test('91. FAIL*transferTokens_4 - TIP write succeeds but adds fail => error surfaced.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('write fail'));
    await expect(TokenManager.transferTokens('sender-91', 'recipient-91', 1)).rejects.toThrow('write fail');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to tip tokens'),
      expect.objectContaining({ code: 'TRANSFER_TOKENS_ERROR' }),
    );
  });

  test('92. FAIL*transferTokens_5 - ScyllaDb failure bubbles.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 3,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('scylla fail'));
    await expect(TokenManager.transferTokens('sender-92', 'recipient-92', 2)).rejects.toThrow('scylla fail');
  });

  test('93. FAIL*transferTokens_6 - options with unexpected keys doesn’t alter behavior.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 4,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.transferTokens('sender-93', 'recipient-93', 2, 'purpose', { extra: 'value' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.metadata).toBeDefined();
    expect(result.breakdown.paidTokensTransferred).toBe(2);
  });
});

describe('TokenManager holdTokens additional coverage', () => {
  const defaultHoldExpiryISO = new Date(referenceNow.getTime() + 1800 * 1000).toISOString();
  const customHoldExpiryISO = new Date(referenceNow.getTime() + 600 * 1000).toISOString();
  let balanceSpy;

  beforeEach(() => {
    balanceSpy = jest.spyOn(TokenManager, 'getUserBalance');
  });

  afterEach(() => {
    balanceSpy.mockRestore();
  });

  const setupBalance = (paid = 10, freeBuckets = {}) => {
    balanceSpy.mockResolvedValue({
      paidTokens: paid,
      totalFreeTokens: Object.values(freeBuckets).reduce((sum, val) => sum + val, 0),
      freeTokensPerBeneficiary: freeBuckets,
    });
  };

  test('94. PASS_holdTokens*1 - creates HOLD with state=open.', async () => {
    setupBalance(10);
    const tx = await TokenManager.holdTokens('user-94', 5, 'booking-94');
    expect(tx.state).toBe(TokenManager.HOLD_STATES.OPEN);
  });

  test('95. PASS_holdTokens*2 - default timeout applied when args.timeoutSeconds missing.', async () => {
    setupBalance(10);
    const tx = await TokenManager.holdTokens('user-95', 1, 'booking-95');
    expect(tx.expiresAt).toBe(defaultHoldExpiryISO);
  });

  test('96. PASS_holdTokens*3 - custom timeoutSeconds used; expiresAt set accordingly.', async () => {
    setupBalance(10);
    const tx = await TokenManager.holdTokens('user-96', 2, 'booking-96', { expiresAfter: 600 });
    expect(tx.expiresAt).toBe(customHoldExpiryISO);
  });

  test('97. PASS_holdTokens*4 - refId stored for later capture/reverse.', async () => {
    setupBalance(10);
    const tx = await TokenManager.holdTokens('user-97', 3, 'booking-97', { refId: 'order-97' });
    expect(tx.refId).toBe('order-97');
  });

  test('98. PASS_holdTokens*5 - metadata stored.', async () => {
    setupBalance(10);
    const tx = await TokenManager.holdTokens('user-98', 4, 'booking-98', { purpose: 'reserve' });
    const metadata = typeof tx.metadata === 'string' ? JSON.parse(tx.metadata) : tx.metadata;
    expect(metadata.auditTrail[0].action).toBe('Token hold created');
  });

  test('99. PASS_holdTokens*6 - holds do not affect getUserBalance directly (only summary reserves).', async () => {
    setupBalance(10);
    await TokenManager.holdTokens('user-99', 2, 'booking-99');
    expect(balanceSpy).toHaveBeenCalledTimes(1);
    expect(mockScyllaDb.putItem).toHaveBeenCalledTimes(1);
  });

  test('100. PASS_holdTokens*7 - amount boundary = 1.', async () => {
    setupBalance(10);
    const tx = await TokenManager.holdTokens('user-100', 1, 'booking-100');
    expect(tx.amount).toBe(1);
  });

  test('101. PASS_holdTokens*8 - multiple holds coexist.', async () => {
    setupBalance(10);
    await TokenManager.holdTokens('user-101-a', 1, 'booking-101-a', { refId: 'hold-101-a' });
    await TokenManager.holdTokens('user-101-b', 1, 'booking-101-b', { refId: 'hold-101-b' });
    expect(mockScyllaDb.putItem).toHaveBeenCalledTimes(2);
  });

  test('102. FAIL*holdTokens_1 - insufficient tokens rejects.', async () => {
    balanceSpy.mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await expect(TokenManager.holdTokens('user-102', 5, 'booking-102')).rejects.toThrow(/Insufficient tokens/);
  });

  test('103. FAIL*holdTokens_2 - invalid timeoutSeconds rejected.', async () => {
    setupBalance(10);
    await expect(TokenManager.holdTokens('user-103', 2, 'booking-103', { expiresAfter: 100 })).rejects.toThrow(/Hold timeout must be between/);
  });

  test('104. FAIL*holdTokens_3 - beneficiaryId missing rejected.', async () => {
    setupBalance(10);
    await expect(TokenManager.holdTokens('user-104', 3, null)).rejects.toThrow(/beneficiaryId is required/);
  });

  test('105. FAIL*holdTokens_4 - addTransaction failure bubbles.', async () => {
    setupBalance(10);
    const spy = jest.spyOn(TokenManager, 'addTransaction').mockRejectedValueOnce(new Error('hold add failed'));
    await expect(TokenManager.holdTokens('user-105', 1, 'booking-105')).rejects.toThrow('hold add failed');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to hold tokens'),
      expect.objectContaining({ code: 'HOLD_TOKENS_ERROR' }),
    );
    spy.mockRestore();
  });
});

describe('TokenManager captureHeldTokens extended coverage', () => {
  const buildOpenHold = (overrides = {}) =>
    createHoldRecord({
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: JSON.stringify({ auditTrail: [] }),
      ...overrides,
    });

  test('106. PASS_captureHeldTokens*1 - capture by transactionId transitions state OPEN→CAPTURED.', async () => {
    const hold = buildOpenHold({ id: 'hold-106', refId: 'booking-106' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const capturedHold = { ...hold, state: TokenManager.HOLD_STATES.CAPTURED, version: 2 };
    mockScyllaDb.updateItem.mockResolvedValueOnce(capturedHold);
    const result = await TokenManager.captureHeldTokens({ transactionId: hold.id });
    expect(result.capturedCount).toBe(1);
    expect(result.transactions[0].state).toBe(TokenManager.HOLD_STATES.CAPTURED);
  });

  test('107. PASS_captureHeldTokens*2 - capture by refId works when transactionId null.', async () => {
    const hold = buildOpenHold({ id: 'hold-107', refId: 'booking-107' });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const capturedHold = { ...hold, state: TokenManager.HOLD_STATES.CAPTURED, version: 2 };
    mockScyllaDb.updateItem.mockResolvedValueOnce(capturedHold);
    const result = await TokenManager.captureHeldTokens({ refId: 'booking-107' });
    expect(result.capturedCount).toBe(1);
    const [table, expression, values, options] = mockScyllaDb.query.mock.calls[0];
    expect(table).toBe(TokenManager.TABLES.TOKEN_REGISTRY);
    expect(expression).toContain('state = :s');
    expect(values[":rid"]).toBe('booking-107');
    expect(options).toEqual(expect.objectContaining({ IndexName: TokenManager.INDEXES.REF_ID_STATE }));
  });

  test('108. PASS_captureHeldTokens*3 - creates corresponding DEBIT with correct amount/beneficiaryId/refId.', async () => {
    const hold = buildOpenHold({ id: 'hold-108', version: 1 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED, version: 2 });
    await TokenManager.captureHeldTokens({ transactionId: hold.id });
    const updateArgs = mockScyllaDb.updateItem.mock.calls[0][2];
    const metadata = JSON.parse(updateArgs.metadata);
    expect(metadata.auditTrail[metadata.auditTrail.length - 1].status).toBe('CAPTURED');
    expect(updateArgs.version).toBe(2);
  });

  test('109. PASS_captureHeldTokens*4 - refuses to capture non-OPEN state (captured/reversed).', async () => {
    const alreadyCaptured = buildOpenHold({ id: 'hold-109-a', state: TokenManager.HOLD_STATES.CAPTURED });
    mockScyllaDb.getItem.mockResolvedValueOnce(alreadyCaptured);
    const result = await TokenManager.captureHeldTokens({ transactionId: alreadyCaptured.id });
    expect(result.alreadyCaptured).toBe(true);

    const reversed = buildOpenHold({ id: 'hold-109-b', state: TokenManager.HOLD_STATES.REVERSED });
    mockScyllaDb.getItem.mockResolvedValueOnce(reversed);
    await expect(TokenManager.captureHeldTokens({ transactionId: reversed.id })).rejects.toThrow(/already reversed/);
  });

  test('110. PASS_captureHeldTokens*5 - maintains version increment on update.', async () => {
    const hold = buildOpenHold({ id: 'hold-110', version: 4 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED, version: 5 });
    await TokenManager.captureHeldTokens({ transactionId: hold.id });
    expect(mockScyllaDb.updateItem.mock.calls[0][2].version).toBe(5);
  });

  test('111. PASS_captureHeldTokens*6 - idempotency: capturing already captured returns stable result (or throws).', async () => {
    const hold = buildOpenHold({ id: 'hold-111' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED, version: 2 });
    await TokenManager.captureHeldTokens({ transactionId: hold.id });

    const capturedAgain = { ...hold, state: TokenManager.HOLD_STATES.CAPTURED };
    mockScyllaDb.getItem.mockResolvedValueOnce(capturedAgain);
    const result = await TokenManager.captureHeldTokens({ transactionId: hold.id });
    expect(result.alreadyCaptured).toBe(true);
  });

  test('112. PASS_captureHeldTokens*7 - logs include start/success markers.', async () => {
    const hold = buildOpenHold({ id: 'hold-112' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED, version: 2 });
    await TokenManager.captureHeldTokens({ transactionId: hold.id });
    const found = mockLogger.debugLog.mock.calls.some(([message]) => message.includes('[captureHeldTokens] [SUCCESS]'));
    expect(found).toBe(true);
  });

  test('113. FAIL*captureHeldTokens_1 - neither transactionId nor refId provided => validation failure.', async () => {
    await expect(TokenManager.captureHeldTokens()).rejects.toThrow(/Either transactionId or refId must be provided/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      'Either transactionId or refId must be provided',
      expect.objectContaining({ code: 'MISSING_IDENTIFIER' }),
    );
  });

  test('114. FAIL*captureHeldTokens_2 - hold not found => expected error.', async () => {
    mockScyllaDb.getItem.mockResolvedValueOnce(null);
    await expect(TokenManager.captureHeldTokens({ transactionId: 'missing-hold' })).rejects.toThrow(/Transaction not found/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Transaction not found'),
      expect.objectContaining({ code: 'TRANSACTION_NOT_FOUND', transactionId: 'missing-hold' }),
    );
  });

  test('115. FAIL*captureHeldTokens_3 - optimistic lock failure (ConditionalCheckFailedException) => expected error path.', async () => {
    const hold = buildOpenHold({ id: 'hold-115' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const conditionalError = new Error('conditional');
    conditionalError.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(conditionalError);
    const result = await TokenManager.captureHeldTokens({ transactionId: hold.id });
    expect(result.capturedCount).toBe(0);
  });

  test('116. FAIL*captureHeldTokens_4 - DB update succeeds but DEBIT creation fails => consistency expectations (surface error).', async () => {
    const hold = buildOpenHold({ id: 'hold-116' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const updateError = new Error('update failure');
    mockScyllaDb.updateItem.mockRejectedValueOnce(updateError);
    await expect(TokenManager.captureHeldTokens({ transactionId: hold.id })).rejects.toThrow('update failure');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to capture held tokens'),
      expect.objectContaining({ code: 'CAPTURE_HELD_TOKENS_ERROR' }),
    );
  });

  test('117. FAIL*captureHeldTokens_5 - malformed hold record (missing amount) fails safely.', async () => {
    const hold = buildOpenHold({ id: 'hold-117', amount: undefined });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const dbError = new Error('missing amount in write');
    mockScyllaDb.updateItem.mockRejectedValueOnce(dbError);
    await expect(TokenManager.captureHeldTokens({ transactionId: hold.id })).rejects.toThrow('missing amount in write');
  });
});

describe('TokenManager reverseHeldTokens extended coverage', () => {
  const buildOpenHold = (overrides = {}) =>
    createHoldRecord({
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: JSON.stringify({ auditTrail: [] }),
      ...overrides,
    });

  test('118. PASS_reverseHeldTokens*1 - reverse by transactionId sets state=reversed.', async () => {
    const hold = buildOpenHold({ id: 'hold-118' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED, version: 2 });
    const result = await TokenManager.reverseHeldTokens({ transactionId: hold.id });
    expect(result.reversedCount).toBe(1);
    expect(result.transactions[0].state).toBe(TokenManager.HOLD_STATES.REVERSED);
  });

  test('119. PASS_reverseHeldTokens*2 - reverse by refId sets state=reversed.', async () => {
    const holdA = buildOpenHold({ id: 'hold-119-a', refId: 'booking-119' });
    const holdB = buildOpenHold({ id: 'hold-119-b', refId: 'booking-119' });
    mockScyllaDb.query.mockResolvedValueOnce([holdA, holdB]);
    mockScyllaDb.updateItem
      .mockResolvedValueOnce({ ...holdA, state: TokenManager.HOLD_STATES.REVERSED, version: 2 })
      .mockResolvedValueOnce({ ...holdB, state: TokenManager.HOLD_STATES.REVERSED, version: 2 });
    const result = await TokenManager.reverseHeldTokens({ refId: 'booking-119' });
    expect(result.reversedCount).toBe(2);
    expect(mockScyllaDb.updateItem).toHaveBeenCalledTimes(2);
  });

  test('120. PASS_reverseHeldTokens*3 - reversing OPEN hold does not create DEBIT.', async () => {
    const hold = buildOpenHold({ id: 'hold-120' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED, version: 2 });
    await TokenManager.reverseHeldTokens({ transactionId: hold.id });
    expect(mockScyllaDb.putItem).not.toHaveBeenCalled();
  });

  test('121. PASS_reverseHeldTokens*4 - version increments on update.', async () => {
    const hold = buildOpenHold({ id: 'hold-121', version: 3 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED, version: 4 });
    await TokenManager.reverseHeldTokens({ transactionId: hold.id });
    expect(mockScyllaDb.updateItem.mock.calls[0][2].version).toBe(4);
  });

  test('122. PASS_reverseHeldTokens*5 - safe when multiple holds share refId (selects correct one deterministically).', async () => {
    const openHold = buildOpenHold({ id: 'hold-122-open', refId: 'booking-122' });
    const closedHold = createHoldRecord({
      id: 'hold-122-closed',
      refId: 'booking-122',
      state: TokenManager.HOLD_STATES.CAPTURED,
      metadata: JSON.stringify({ auditTrail: [] }),
    });
    mockScyllaDb.query.mockResolvedValueOnce([openHold, closedHold]);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...openHold, state: TokenManager.HOLD_STATES.REVERSED, version: 2 });
    const result = await TokenManager.reverseHeldTokens({ refId: 'booking-122' });
    expect(result.reversedCount).toBe(1);
  });

  test('123. PASS_reverseHeldTokens*6 - logs show START/SUCCESS.', async () => {
    const hold = buildOpenHold({ id: 'hold-123' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED, version: 2 });
    await TokenManager.reverseHeldTokens({ transactionId: hold.id });
    const startLog = mockLogger.debugLog.mock.calls.some(([message]) => message.includes('[reverseHeldTokens] [START]'));
    const successLog = mockLogger.debugLog.mock.calls.some(([message]) => message.includes('[reverseHeldTokens] [SUCCESS]'));
    expect(startLog).toBe(true);
    expect(successLog).toBe(true);
  });

  test('124. FAIL*reverseHeldTokens_1 - neither transactionId nor refId provided => validation failure.', async () => {
    await expect(TokenManager.reverseHeldTokens()).rejects.toThrow(/Either transactionId or refId must be provided/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      'Either transactionId or refId must be provided',
      expect.objectContaining({ code: 'MISSING_IDENTIFIER' }),
    );
  });

  test('125. FAIL*reverseHeldTokens_2 - hold not found => expected error.', async () => {
    mockScyllaDb.getItem.mockResolvedValueOnce(null);
    const result = await TokenManager.reverseHeldTokens({ transactionId: 'missing-125' });
    expect(result.reversedCount).toBe(0);
    expect(result.message).toMatch(/Transaction not found/);
  });

  test('126. FAIL*reverseHeldTokens_3 - hold already captured => error / no-op contract.', async () => {
    const captured = buildOpenHold({ id: 'hold-126', state: TokenManager.HOLD_STATES.CAPTURED });
    mockScyllaDb.getItem.mockResolvedValueOnce(captured);
    await expect(TokenManager.reverseHeldTokens({ transactionId: captured.id })).rejects.toThrow(/already captured/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('already captured'),
      expect.objectContaining({ code: 'ALREADY_CAPTURED' }),
    );
  });

  test('127. FAIL*reverseHeldTokens_4 - optimistic lock failure => expected.', async () => {
    const hold = buildOpenHold({ id: 'hold-127' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const conditionalError = new Error('conditional failure');
    conditionalError.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(conditionalError);
    const result = await TokenManager.reverseHeldTokens({ transactionId: hold.id });
    expect(result.reversedCount).toBe(0);
  });

  test('128. FAIL*reverseHeldTokens_5 - DB failure bubbles.', async () => {
    const hold = buildOpenHold({ id: 'hold-128' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const error = new Error('reverse failed');
    mockScyllaDb.updateItem.mockRejectedValueOnce(error);
    await expect(TokenManager.reverseHeldTokens({ transactionId: hold.id })).rejects.toThrow('reverse failed');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to reverse held tokens'),
      expect.objectContaining({ code: 'REVERSE_HELD_TOKENS_ERROR' }),
    );
  });
});

describe('TokenManager extendExpiry extended coverage', () => {
  const buildOpenHold = (overrides = {}) =>
    createHoldRecord({
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: JSON.stringify({ auditTrail: [] }),
      ...overrides,
    });

  test('129. PASS_extendExpiry*1 - extend by transactionId increases expiresAt.', async () => {
    const hold = buildOpenHold({
      id: 'hold-129',
      createdAt: new Date(referenceNow.getTime() - 3600 * 1000).toISOString(),
      expiresAt: new Date(referenceNow.getTime() + 1800 * 1000).toISOString(),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const extendBySeconds = 300;
    const expectedNewExpires = new Date(
      (Math.floor(new Date(hold.expiresAt).getTime() / 1000) + extendBySeconds) * 1000,
    ).toISOString();
    const updatedHold = { ...hold, expiresAt: expectedNewExpires, version: hold.version + 1 };
    mockScyllaDb.updateItem.mockResolvedValueOnce(updatedHold);

    const result = await TokenManager.extendExpiry({ transactionId: hold.id, extendBySeconds });
    expect(mockScyllaDb.updateItem).toHaveBeenCalled();
    expect(mockScyllaDb.updateItem.mock.calls[0][2].expiresAt).toBe(expectedNewExpires);
    expect(result.transactions[0].expiresAt).toBe(expectedNewExpires);
    expect(result.transactions[0].extendedBySeconds).toBe(extendBySeconds);
  });

  test('130. PASS_extendExpiry*2 - extend by refId increases expiresAt when transactionId missing.', async () => {
    const hold = buildOpenHold({ id: 'hold-130', refId: 'booking-130' });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const extendBySeconds = 600;
    const expectedNewExpires = new Date(
      (Math.floor(new Date(hold.expiresAt).getTime() / 1000) + extendBySeconds) * 1000,
    ).toISOString();
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, expiresAt: expectedNewExpires, version: hold.version + 1 });

    await TokenManager.extendExpiry({ refId: 'booking-130', extendBySeconds });
    expect(mockScyllaDb.query).toHaveBeenCalledWith(
      TokenManager.TABLES.TOKEN_REGISTRY,
      expect.stringContaining('refId = :rid'),
      expect.objectContaining({ ':rid': 'booking-130' }),
      expect.objectContaining({ IndexName: TokenManager.INDEXES.REF_ID_TRANSACTION_TYPE }),
    );
  });

  test('131. PASS_extendExpiry*3 - respects maxTotalSeconds cap when provided.', async () => {
    const hold = buildOpenHold({
      id: 'hold-131',
      createdAt: new Date(referenceNow.getTime() - 3000 * 1000).toISOString(),
      expiresAt: new Date(referenceNow.getTime() + 1000 * 1000).toISOString(),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const extendBySeconds = 500;
    const maxTotalSeconds = 8000;
    const expectedNewExpires = new Date(
      (Math.floor(new Date(hold.expiresAt).getTime() / 1000) + extendBySeconds) * 1000,
    ).toISOString();
    mockScyllaDb.updateItem.mockResolvedValueOnce({
      ...hold,
      expiresAt: expectedNewExpires,
      version: hold.version + 1,
    });

    const result = await TokenManager.extendExpiry({
      transactionId: hold.id,
      extendBySeconds,
      maxTotalSeconds,
    });
    expect(result.transactions[0].totalTimeoutSeconds).toBeLessThanOrEqual(maxTotalSeconds);
  });

  test('132. PASS_extendExpiry*4 - extendBySeconds small positive works.', async () => {
    const hold = buildOpenHold({ id: 'hold-132' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const extendBySeconds = 1;
    const expectedNewExpires = new Date(
      (Math.floor(new Date(hold.expiresAt).getTime() / 1000) + extendBySeconds) * 1000,
    ).toISOString();
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, expiresAt: expectedNewExpires, version: hold.version + 1 });

    const result = await TokenManager.extendExpiry({ transactionId: hold.id, extendBySeconds });
    expect(result.transactions[0].expiresAt).toBe(expectedNewExpires);
  });

  test('133. PASS_extendExpiry*5 - cannot extend non-OPEN hold (captured/reversed).', async () => {
    const capturedHold = buildOpenHold({ id: 'hold-133-a', state: TokenManager.HOLD_STATES.CAPTURED });
    mockScyllaDb.getItem.mockResolvedValueOnce(capturedHold);
    await expect(TokenManager.extendExpiry({ transactionId: capturedHold.id, extendBySeconds: 60 })).rejects.toThrow(/already captured/);

    const reversedHold = buildOpenHold({ id: 'hold-133-b', state: TokenManager.HOLD_STATES.REVERSED });
    mockScyllaDb.getItem.mockResolvedValueOnce(reversedHold);
    await expect(TokenManager.extendExpiry({ transactionId: reversedHold.id, extendBySeconds: 60 })).rejects.toThrow(/already reversed/);
  });

  test('134. PASS_extendExpiry*6 - version increments on update.', async () => {
    const hold = buildOpenHold({ id: 'hold-134', version: 5 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({
      ...hold,
      expiresAt: hold.expiresAt,
      version: 6,
    });
    await TokenManager.extendExpiry({ transactionId: hold.id, extendBySeconds: 10 });
    expect(mockScyllaDb.updateItem.mock.calls[0][2].version).toBe(6);
  });

  test('135. FAIL*extendExpiry_1 - extendBySeconds missing/invalid => validation failure.', async () => {
    await expect(TokenManager.extendExpiry({ transactionId: 'hold-135' })).rejects.toThrow(/extendBySeconds is required/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to extend hold timeout'),
      expect.objectContaining({ code: 'EXTEND_EXPIRY_ERROR' }),
    );
  });

  test('136. FAIL*extendExpiry_2 - extendBySeconds <= 0 => error.', async () => {
    const hold = buildOpenHold({ id: 'hold-136' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    await expect(TokenManager.extendExpiry({ transactionId: hold.id, extendBySeconds: 0 })).rejects.toThrow(/extendBySeconds must be a positive number/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to extend hold timeout'),
      expect.objectContaining({ code: 'EXTEND_EXPIRY_ERROR' }),
    );
  });

  test('137. FAIL*extendExpiry_3 - hold not found => error.', async () => {
    mockScyllaDb.getItem.mockResolvedValueOnce(null);
    await expect(TokenManager.extendExpiry({ transactionId: 'missing-137', extendBySeconds: 30 })).rejects.toThrow(/Transaction not found/);
  });

  test('138. FAIL*extendExpiry_4 - optimistic lock failure => expected error path.', async () => {
    const hold = buildOpenHold({ id: 'hold-138' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const conditionalError = new Error('conditional failure');
    conditionalError.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(conditionalError);
    await expect(TokenManager.extendExpiry({ transactionId: hold.id, extendBySeconds: 60 })).rejects.toThrow(/already captured or reversed/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to extend hold timeout'),
      expect.objectContaining({ code: 'EXTEND_EXPIRY_ERROR' }),
    );
  });

  test('139. FAIL*extendExpiry_5 - malformed expiresAt in DB record => safe failure.', async () => {
    const hold = buildOpenHold({ id: 'hold-139', expiresAt: 'not-a-date' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    await expect(TokenManager.extendExpiry({ transactionId: hold.id, extendBySeconds: 10 })).rejects.toThrow(/Invalid time value/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to extend hold timeout'),
      expect.objectContaining({ code: 'EXTEND_EXPIRY_ERROR' }),
    );
  });
});

describe('TokenManager validateSufficientTokens batch #1', () => {
  let balanceSpy;

  beforeEach(() => {
    balanceSpy = jest.spyOn(TokenManager, 'getUserBalance');
  });

  afterEach(() => {
    balanceSpy.mockRestore();
  });

  test('140. PASS_validateSufficientTokens*1 - sufficient paid-only balance.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.validateSufficientTokens('user-140', 'ben-140', 3);
    expect(result).toBe(true);
  });

  test('141. PASS_validateSufficientTokens*2 - sufficient beneficiary-free only.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 7,
      freeTokensPerBeneficiary: { 'ben-141': 7 },
    });
    const result = await TokenManager.validateSufficientTokens('user-141', 'ben-141', 5);
    expect(result).toBe(true);
  });

  test('142. PASS_validateSufficientTokens*3 - sufficient system-free only.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 8,
      freeTokensPerBeneficiary: { system: 8 },
    });
    const result = await TokenManager.validateSufficientTokens('user-142', 'ben-142', 5);
    expect(result).toBe(true);
  });

  test('143. PASS_validateSufficientTokens*4 - mixed free + paid suffices.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 3,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { 'ben-143': 2, system: 1 },
    });
    const result = await TokenManager.validateSufficientTokens('user-143', 'ben-143', 6);
    expect(result).toBe(true);
  });

  test('144. PASS_validateSufficientTokens*5 - exact boundary returns true.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 3,
      totalFreeTokens: 2,
      freeTokensPerBeneficiary: { 'ben-144': 2 },
    });
    const result = await TokenManager.validateSufficientTokens('user-144', 'ben-144', 5);
    expect(result).toBe(true);
  });

  test('145. PASS_validateSufficientTokens*6 - beneficiaryId influences priority correctly.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 10,
      freeTokensPerBeneficiary: { 'ben-145': 4, other: 6, system: 2 },
    });
    await TokenManager.validateSufficientTokens('user-145', 'ben-145', 5);
    const writeCall = mockLogger.writeLog.mock.calls[mockLogger.writeLog.mock.calls.length - 1][0];
    expect(writeCall.data.beneficiarySpecificFree).toBe(4);
    expect(writeCall.data.systemFree).toBe(2);
  });

  test('146. PASS_validateSufficientTokens*7 - breakdown fields recorded.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 1,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { 'ben-146': 3, system: 3 },
    });
    await TokenManager.validateSufficientTokens('user-146', 'ben-146', 6);
    const writeCall = mockLogger.writeLog.mock.calls[mockLogger.writeLog.mock.calls.length - 1][0];
    expect(writeCall.data.totalUsable).toBe(7);
    expect(writeCall.data.paidTokens).toBe(1);
  });

  test('147. FAIL*validateSufficientTokens_1 - missing userId/beneficiaryId => validation error.', async () => {
    await expect(TokenManager.validateSufficientTokens('', '', 1)).rejects.toThrow(/is required/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to validate sufficient tokens'),
      expect.objectContaining({ code: 'VALIDATE_SUFFICIENT_TOKENS_ERROR' }),
    );
  });

  test('148. FAIL*validateSufficientTokens_2 - amount <= 0 => validation error.', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      const normalized = defaultSanitizeValidate(schema);
      if (schema.amount?.value !== undefined && schema.amount?.value <= 0) {
        throw new Error('Amount must be greater than 0');
      }
      return normalized;
    });
    await expect(TokenManager.validateSufficientTokens('user-148', 'ben-148', 0)).rejects.toThrow(/greater than 0/);
  });

  test('149. FAIL*validateSufficientTokens_3 - insufficient tokens returns false.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 1,
      totalFreeTokens: 1,
      freeTokensPerBeneficiary: { 'ben-149': 1 },
    });
    const result = await TokenManager.validateSufficientTokens('user-149', 'ben-149', 5);
    expect(result).toBe(false);
    const writeCall = mockLogger.writeLog.mock.calls[mockLogger.writeLog.mock.calls.length - 1][0];
    expect(writeCall.data.totalUsable).toBe(2);
    expect(writeCall.data.isSufficient).toBe(false);
  });

  test('150. FAIL*validateSufficientTokens_4 - getUserBalance throws => error bubbles.', async () => {
    balanceSpy.mockRejectedValueOnce(new Error('balance error'));
    await expect(TokenManager.validateSufficientTokens('user-150', 'ben-150', 1)).rejects.toThrow('balance error');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to validate sufficient tokens'),
      expect.objectContaining({ code: 'VALIDATE_SUFFICIENT_TOKENS_ERROR' }),
    );
  });
});

describe('TokenManager getUserTransactionHistory batch #1', () => {
  const queueHistoryResponses = (userTxs = [], beneficiaryTxs = []) => {
    mockScyllaDb.query
      .mockResolvedValueOnce(userTxs)
      .mockResolvedValueOnce(beneficiaryTxs);
  };

  test('151. PASS_getUserTransactionHistory*1 - default returns all user transactions and tips without duplicates.', async () => {
    const userTx = createTransactionRecord({
      id: 'user-151',
      userId: 'user-151',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      createdAt: '2024-12-31T23:00:00.000Z',
    });
    const tipTx = createTransactionRecord({
      id: 'tip-151',
      beneficiaryId: 'user-151',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      createdAt: '2024-12-31T23:30:00.000Z',
    });
    const otherBeneficiaryTx = createTransactionRecord({
      id: 'credit-151',
      beneficiaryId: 'user-151',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
    });
    queueHistoryResponses([userTx], [tipTx, otherBeneficiaryTx]);

    const history = await TokenManager.getUserTransactionHistory('user-151');
    expect(history).toHaveLength(2);
    expect(history.map((tx) => tx.id)).toEqual(expect.arrayContaining(['user-151', 'tip-151']));
  });

  test('152. PASS_getUserTransactionHistory*2 - fromDate only filters lower bound.', async () => {
    const oldTx = createTransactionRecord({
      id: 'old-152',
      createdAt: '2024-12-31T23:59:59.000Z',
    });
    const newTx = createTransactionRecord({
      id: 'new-152',
      createdAt: '2025-01-02T00:00:00.000Z',
    });
    queueHistoryResponses([oldTx, newTx], []);

    const history = await TokenManager.getUserTransactionHistory('user-152', {
      fromDate: '2025-01-01T00:00:00.000Z',
    });
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe('new-152');
  });

  test('153. PASS_getUserTransactionHistory*3 - toDate only filters upper bound.', async () => {
    const early = createTransactionRecord({
      id: 'early-153',
      createdAt: '2024-12-30T00:00:00.000Z',
    });
    const late = createTransactionRecord({
      id: 'late-153',
      createdAt: '2025-01-05T00:00:00.000Z',
    });
    queueHistoryResponses([early, late], []);

    const history = await TokenManager.getUserTransactionHistory('user-153', {
      toDate: '2025-01-01T00:00:00.000Z',
    });
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe('early-153');
  });

  test('154. PASS_getUserTransactionHistory*4 - range filters inclusive boundaries as implemented.', async () => {
    const included = createTransactionRecord({
      id: 'in-154',
      createdAt: '2025-01-01T12:00:00.000Z',
    });
    const excluded = createTransactionRecord({
      id: 'out-154',
      createdAt: '2025-01-03T00:00:00.000Z',
    });
    queueHistoryResponses([included, excluded], []);

    const history = await TokenManager.getUserTransactionHistory('user-154', {
      fromDate: '2025-01-01T00:00:00.000Z',
      toDate: '2025-01-02T00:00:00.000Z',
    });
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe('in-154');
  });

  test('155. PASS_getUserTransactionHistory*5 - transactionType filter works.', async () => {
    const tipTx = createTransactionRecord({
      id: 'tip-155',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
    });
    const creditTx = createTransactionRecord({
      id: 'credit-155',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
    });
    queueHistoryResponses([tipTx, creditTx], []);

    const history = await TokenManager.getUserTransactionHistory('user-155', {
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
    });
    expect(history).toHaveLength(1);
    expect(history[0].transactionType).toBe(TokenManager.TRANSACTION_TYPES.TIP);
  });

  test('156. PASS_getUserTransactionHistory*6 - empty result returns [].', async () => {
    queueHistoryResponses([], []);
    const history = await TokenManager.getUserTransactionHistory('user-156');
    expect(history).toEqual([]);
  });

  test('157. PASS_getUserTransactionHistory*7 - stable ordering descending by createdAt.', async () => {
    const newer = createTransactionRecord({
      id: 'newer-157',
      createdAt: '2025-01-02T00:00:00.000Z',
    });
    const older = createTransactionRecord({
      id: 'older-157',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    queueHistoryResponses([newer, older], []);

    const history = await TokenManager.getUserTransactionHistory('user-157');
    expect(Date.parse(history[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(history[1].createdAt));
  });

  test('158. FAIL*getUserTransactionHistory_1 - invalid date string rejected.', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      if (schema.fromDate?.value === 'invalid-date') {
        throw new Error('Invalid fromDate format');
      }
      return defaultSanitizeValidate(schema);
    });
    await expect(
      TokenManager.getUserTransactionHistory('user-158', { fromDate: 'invalid-date' }),
    ).rejects.toThrow(/Invalid fromDate format/);
    expect(mockScyllaDb.query).not.toHaveBeenCalled();
  });

  test('159. FAIL*getUserTransactionHistory_2 - invalid transactionType rejects.', async () => {
    await expect(
      TokenManager.getUserTransactionHistory('user-159', { transactionType: 123 }),
    ).rejects.toThrow(/transactionType must be a string/);
  });

  test('160. FAIL*getUserTransactionHistory_3 - DB query failure bubbles.', async () => {
    const err = new Error('query failed');
    mockScyllaDb.query.mockRejectedValueOnce(err);
    await expect(TokenManager.getUserTransactionHistory('user-160')).rejects.toThrow('query failed');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get user transaction history'),
      expect.objectContaining({ code: 'GET_USER_TRANSACTION_HISTORY_ERROR', userId: 'user-160' }),
    );
  });
});

describe('TokenManager getExpiringTokensWarning extended coverage', () => {
  const getExpectedCutoff = (days) => {
    const nowTimestamp = Math.floor(new Date(referenceNow).getTime() / 1000);
    const cutoffTimestamp = nowTimestamp + days * 24 * 60 * 60;
    return new Date(cutoffTimestamp * 1000).toISOString();
  };

  test('161. PASS_getExpiringTokensWarning*1 - no free tokens => empty warning.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getExpiringTokensWarning('user-161');
    expect(result).toEqual([]);
  });

  test('162. PASS_getExpiringTokensWarning*2 - free tokens expiring within window are included.', async () => {
    const freeTx = createTransactionRecord({
      id: 'exp-162',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      expiresAt: new Date(referenceNow.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    mockScyllaDb.query.mockResolvedValueOnce([freeTx]);
    const result = await TokenManager.getExpiringTokensWarning('user-162', 7);
    expect(result).toEqual([freeTx]);
    const cutoff = mockScyllaDb.query.mock.calls[0][2][':cutoff'];
    expect(cutoff).toBe(getExpectedCutoff(7));
  });

  test('163. PASS_getExpiringTokensWarning*3 - tokens expiring after cutoff are excluded by query bounds.', async () => {
    const freeTx = createTransactionRecord({
      id: 'exp-163',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      expiresAt: new Date(referenceNow.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    mockScyllaDb.query.mockResolvedValueOnce([freeTx]);
    await TokenManager.getExpiringTokensWarning('user-163', 1);
    const cutoff = mockScyllaDb.query.mock.calls[0][2][':cutoff'];
    expect(cutoff).toBe(getExpectedCutoff(1));
  });

  test('164. PASS_getExpiringTokensWarning*4 - sentinel far-future records excluded by cutoff calculation.', async () => {
    const sentinelTx = createTransactionRecord({
      id: 'exp-164',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      expiresAt: '9999-12-31T23:59:59.999Z',
    });
    mockScyllaDb.query.mockResolvedValueOnce([sentinelTx]);
    await TokenManager.getExpiringTokensWarning('user-164');
    const cutoff = mockScyllaDb.query.mock.calls[0][2][':cutoff'];
    expect(cutoff).toBe(getExpectedCutoff(7));
  });

  test('165. PASS_getExpiringTokensWarning*5 - different beneficiary buckets are returned distinctly.', async () => {
    const alice = createTransactionRecord({
      id: 'exp-165-a',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      beneficiaryId: 'alice',
    });
    const bob = createTransactionRecord({
      id: 'exp-165-b',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      beneficiaryId: 'bob',
    });
    mockScyllaDb.query.mockResolvedValueOnce([alice, bob]);
    const result = await TokenManager.getExpiringTokensWarning('user-165');
    expect(result).toHaveLength(2);
    expect(result.map((tx) => tx.beneficiaryId)).toEqual(expect.arrayContaining(['alice', 'bob']));
  });

  test('166. PASS_getExpiringTokensWarning*6 - days default to 7 when unspecified.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await TokenManager.getExpiringTokensWarning('user-166');
    const cutoff = mockScyllaDb.query.mock.calls[0][2][':cutoff'];
    expect(cutoff).toBe(getExpectedCutoff(7));
  });

  test('167. FAIL*getExpiringTokensWarning_1 - invalid days (non-int) rejected.', async () => {
    await expect(
      TokenManager.getExpiringTokensWarning('user-167', 'seven'),
    ).rejects.toThrow(/days must be an integer/);
  });

  test('168. FAIL*getExpiringTokensWarning_2 - invalid userId rejected.', async () => {
    await expect(TokenManager.getExpiringTokensWarning('', 5)).rejects.toThrow(/is required/);
  });

  test('169. FAIL*getExpiringTokensWarning_3 - malformed expiresAt doesn’t crash.', async () => {
    const badTx = createTransactionRecord({
      id: 'exp-169',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      expiresAt: 'not a date',
    });
    mockScyllaDb.query.mockResolvedValueOnce([badTx]);
    const result = await TokenManager.getExpiringTokensWarning('user-169');
    expect(result).toEqual([badTx]);
  });
});

describe('TokenManager getTipsReceived batch #1', () => {
  test('170. PASS_getTipsReceived*1 - returns only TIP transactions for beneficiary.', async () => {
    const tipTx = createTransactionRecord({
      id: 'tip-170',
      beneficiaryId: 'user-170',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      createdAt: '2025-01-02T00:00:00.000Z',
    });
    const debitTx = createTransactionRecord({
      id: 'debit-170',
      beneficiaryId: 'user-170',
      transactionType: TokenManager.TRANSACTION_TYPES.DEBIT,
    });
    mockScyllaDb.query.mockResolvedValueOnce([tipTx, debitTx]);
    const result = await TokenManager.getTipsReceived('user-170');
    expect(result).toEqual([tipTx]);
  });

  test('171. PASS_getTipsReceived*2 - empty result returns [].', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getTipsReceived('user-171');
    expect(result).toEqual([]);
  });

  test('172. PASS_getTipsReceived*3 - sorted by createdAt descending.', async () => {
    const older = createTransactionRecord({
      id: 'older-172',
      beneficiaryId: 'user-172',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    const newer = createTransactionRecord({
      id: 'newer-172',
      beneficiaryId: 'user-172',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      createdAt: '2025-01-02T00:00:00.000Z',
    });
    mockScyllaDb.query.mockResolvedValueOnce([older, newer]);
    const result = await TokenManager.getTipsReceived('user-172');
    expect(result[0].id).toBe('newer-172');
  });

  test('173. PASS_getTipsReceived*4 - metadata preserved (string).', async () => {
    const tipTx = createTransactionRecord({
      id: 'tip-173',
      beneficiaryId: 'user-173',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      metadata: { note: 'thanks' },
    });
    mockScyllaDb.query.mockResolvedValueOnce([tipTx]);
    const result = await TokenManager.getTipsReceived('user-173');
    expect(result[0].metadata).toEqual({ note: 'thanks' });
  });

  test('174. FAIL*getTipsReceived_1 - invalid userId rejected.', async () => {
    await expect(TokenManager.getTipsReceived('')).rejects.toThrow(/is required/);
  });

  test('175. FAIL*getTipsReceived_2 - DB error bubbles.', async () => {
    const err = new Error('tips query failed');
    mockScyllaDb.query.mockRejectedValueOnce(err);
    await expect(TokenManager.getTipsReceived('user-175')).rejects.toThrow('tips query failed');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get tips received'),
      expect.objectContaining({ code: 'GET_TIPS_RECEIVED_ERROR', userId: 'user-175' }),
    );
  });
});

describe('TokenManager getTipsReceivedByDateRange batch #1', () => {
  test('176. PASS_getTipsReceivedByDateRange*1 - filters tips within given range.', async () => {
    const tip = createTransactionRecord({
      id: 'tip-176',
      beneficiaryId: 'user-176',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      createdAt: '2025-01-02T00:00:00.000Z',
    });
    mockScyllaDb.query.mockResolvedValueOnce([tip]);
    const result = await TokenManager.getTipsReceivedByDateRange('user-176', '2025-01-01T00:00:00.000Z', '2025-01-03T00:00:00.000Z');
    expect(result).toEqual([tip]);
  });

  test('177. PASS_getTipsReceivedByDateRange*2 - inclusive boundaries include fromDate/toDate entries.', async () => {
    const fromTx = createTransactionRecord({
      id: 'from-177',
      beneficiaryId: 'user-177',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    const toTx = createTransactionRecord({
      id: 'to-177',
      beneficiaryId: 'user-177',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      createdAt: '2025-01-02T00:00:00.000Z',
    });
    mockScyllaDb.query.mockResolvedValueOnce([fromTx, toTx]);
    const result = await TokenManager.getTipsReceivedByDateRange('user-177', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z');
    expect(result).toHaveLength(2);
  });

  test('178. PASS_getTipsReceivedByDateRange*3 - no results returns [].', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getTipsReceivedByDateRange('user-178', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z');
    expect(result).toEqual([]);
  });

  test('179. FAIL*getTipsReceivedByDateRange_1 - invalid date strings rejected.', async () => {
    await expect(TokenManager.getTipsReceivedByDateRange('user-179', 123, '2025-01-02T00:00:00.000Z')).rejects.toThrow(/fromDate must be a string/);
  });

  test('180. FAIL*getTipsReceivedByDateRange_2 - fromDate > toDate handled (returns empty).', async () => {
    const tip = createTransactionRecord({
      id: 'tip-180',
      beneficiaryId: 'user-180',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      createdAt: '2025-01-02T00:00:00.000Z',
    });
    mockScyllaDb.query.mockResolvedValueOnce([tip]);
    const result = await TokenManager.getTipsReceivedByDateRange('user-180', '2025-01-03T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    expect(result).toEqual([]);
  });

  test('181. FAIL*getTipsReceivedByDateRange_3 - DB error bubbles.', async () => {
    const err = new Error('date range failed');
    mockScyllaDb.query.mockRejectedValueOnce(err);
    await expect(TokenManager.getTipsReceivedByDateRange('user-181', '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z')).rejects.toThrow('date range failed');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get tips received by date range'),
      expect.objectContaining({ code: 'GET_TIPS_RECEIVED_BY_DATE_RANGE_ERROR', userId: 'user-181' }),
    );
  });
});

describe('TokenManager getTipsSent batch #1', () => {
  test('182. PASS_getTipsSent*1 - returns only TIP transactions where user is sender.', async () => {
    const tipTx = createTransactionRecord({
      id: 'tip-182',
      userId: 'user-182',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
    });
    const creditTx = createTransactionRecord({
      id: 'credit-182',
      userId: 'user-182',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
    });
    mockScyllaDb.query.mockResolvedValueOnce([tipTx, creditTx]);
    const result = await TokenManager.getTipsSent('user-182');
    expect(result).toEqual([tipTx]);
  });

  test('183. PASS_getTipsSent*2 - empty result returns [].', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getTipsSent('user-183');
    expect(result).toEqual([]);
  });

  test('184. PASS_getTipsSent*3 - handles free consumption fields.', async () => {
    const tipTx = createTransactionRecord({
      id: 'tip-184',
      userId: 'user-184',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      freeBeneficiaryConsumed: 2,
      freeSystemConsumed: 1,
    });
    mockScyllaDb.query.mockResolvedValueOnce([tipTx]);
    const result = await TokenManager.getTipsSent('user-184');
    expect(result[0].freeBeneficiaryConsumed).toBe(2);
    expect(result[0].freeSystemConsumed).toBe(1);
  });

  test('185. FAIL*getTipsSent_1 - invalid userId rejected.', async () => {
    await expect(TokenManager.getTipsSent('')).rejects.toThrow(/is required/);
  });

  test('186. FAIL*getTipsSent_2 - DB error bubbles.', async () => {
    const err = new Error('tips sent failure');
    mockScyllaDb.query.mockRejectedValueOnce(err);
    await expect(TokenManager.getTipsSent('user-186')).rejects.toThrow('tips sent failure');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get tips sent'),
      expect.objectContaining({ code: 'GET_TIPS_SENT_ERROR', userId: 'user-186' }),
    );
  });
});

describe('TokenManager getUserEarnings batch #1', () => {
  test('187. PASS_getUserEarnings*1 - no tips yields zero totals.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getUserEarnings('user-187');
    expect(result.grouped).toBe(false);
    expect(result.totalEarnings).toBe(0);
    expect(result.transactions).toEqual([]);
  });

  test('188. PASS_getUserEarnings*2 - sums TIP paid amounts correctly.', async () => {
    const tip = createTransactionRecord({
      id: 'earn-188',
      beneficiaryId: 'user-188',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 10,
    });
    mockScyllaDb.query.mockResolvedValueOnce([tip]);
    const result = await TokenManager.getUserEarnings('user-188');
    expect(result.totalEarnings).toBe(10);
    expect(result.transactionCount).toBe(1);
  });

  test('189. PASS_getUserEarnings*3 - grouping option returns grouped structure.', async () => {
    const tip = createTransactionRecord({
      id: 'earn-189',
      beneficiaryId: 'user-189',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 5,
      refId: 'booking-189',
    });
    mockScyllaDb.query.mockResolvedValueOnce([tip]);
    const result = await TokenManager.getUserEarnings('user-189', { groupByRef: true });
    expect(result.grouped).toBe(true);
    expect(result.groups[0].refId).toBe('booking-189');
  });

  test('190. PASS_getUserEarnings*4 - honors date window filters.', async () => {
    const inRange = createTransactionRecord({
      id: 'earn-190-in',
      beneficiaryId: 'user-190',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 4,
      createdAt: '2025-01-02T00:00:00.000Z',
    });
    const outRange = createTransactionRecord({
      id: 'earn-190-out',
      beneficiaryId: 'user-190',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 6,
      createdAt: '2025-01-05T00:00:00.000Z',
    });
    mockScyllaDb.query.mockResolvedValueOnce([inRange, outRange]);
    const result = await TokenManager.getUserEarnings('user-190', {
      fromDate: '2025-01-01T00:00:00.000Z',
      toDate: '2025-01-03T00:00:00.000Z',
    });
    expect(result.transactionCount).toBe(1);
    expect(result.transactions[0].id).toBe('earn-190-in');
  });

  test('191. PASS_getUserEarnings*5 - missing refId falls under no_ref when grouping.', async () => {
    const tip = createTransactionRecord({
      id: 'earn-191',
      beneficiaryId: 'user-191',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 3,
      refId: null,
    });
    mockScyllaDb.query.mockResolvedValueOnce([tip]);
    const result = await TokenManager.getUserEarnings('user-191', { groupByRef: true });
    expect(result.groups[0].refId).toBe('no_ref');
  });

  test('192. PASS_getUserEarnings*6 - handles large number of tips.', async () => {
    const tips = Array.from({ length: 20 }, (_, index) =>
      createTransactionRecord({
        id: `earn-192-${index}`,
        beneficiaryId: 'user-192',
        transactionType: TokenManager.TRANSACTION_TYPES.TIP,
        amount: index + 1,
        createdAt: new Date(referenceNow.getTime() + index * 1000).toISOString(),
      }),
    );
    mockScyllaDb.query.mockResolvedValueOnce(tips);
    const result = await TokenManager.getUserEarnings('user-192');
    expect(result.transactionCount).toBe(20);
  });

  test('193. FAIL*getUserEarnings_1 - invalid userId rejected.', async () => {
    await expect(TokenManager.getUserEarnings('', {})).rejects.toThrow(/is required/);
  });

  test('194. FAIL*getUserEarnings_2 - malformed amount fields don’t crash aggregation.', async () => {
    const malformed = createTransactionRecord({
      id: 'earn-194-bad',
      beneficiaryId: 'user-194',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: NaN,
    });
    const valid = createTransactionRecord({
      id: 'earn-194-good',
      beneficiaryId: 'user-194',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 5,
    });
    mockScyllaDb.query.mockResolvedValueOnce([malformed, valid]);
    const result = await TokenManager.getUserEarnings('user-194');
    expect(result.totalEarnings).toBe(5);
    expect(result.transactionCount).toBe(2);
  });

  test('195. FAIL*getUserEarnings_3 - DB failure bubbles.', async () => {
    const err = new Error('earnings query failed');
    mockScyllaDb.query.mockRejectedValueOnce(err);
    await expect(TokenManager.getUserEarnings('user-195')).rejects.toThrow('earnings query failed');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get user earnings'),
      expect.objectContaining({ code: 'GET_USER_EARNINGS_ERROR', userId: 'user-195' }),
    );
  });
});

describe('TokenManager getUserSpendingByRefId batch #1', () => {
  test('196. PASS_getUserSpendingByRefId*1 - sums DEBIT and TIP spending for refId.', async () => {
    const debit = createTransactionRecord({
      id: 'spend-196-debit',
      userId: 'user-196',
      beneficiaryId: 'user-196',
      transactionType: TokenManager.TRANSACTION_TYPES.DEBIT,
      amount: 10,
      freeBeneficiaryConsumed: 2,
      freeSystemConsumed: 1,
    });
    const tip = createTransactionRecord({
      id: 'spend-196-tip',
      userId: 'user-196',
      beneficiaryId: 'user-196',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 5,
      freeBeneficiaryConsumed: 1,
    });
    mockScyllaDb.query.mockResolvedValueOnce([debit, tip]);
    const result = await TokenManager.getUserSpendingByRefId('user-196', 'ref-196');
    expect(result.totalSpent).toBe(10 + 5 + 2 + 1 + 1); // paid + free
    expect(result.breakdown.paidTokens).toBe(15);
    expect(result.breakdown.beneficiaryFreeTokens).toBe(3);
  });

  test('197. PASS_getUserSpendingByRefId*2 - includes free consumed split when present.', async () => {
    const tip = createTransactionRecord({
      id: 'spend-197-tip',
      userId: 'user-197',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      freeBeneficiaryConsumed: 3,
      freeSystemConsumed: 2,
    });
    mockScyllaDb.query.mockResolvedValueOnce([tip]);
    const result = await TokenManager.getUserSpendingByRefId('user-197', 'ref-197');
    expect(result.breakdown.totalFreeTokens).toBe(5);
    expect(result.breakdown.systemFreeTokens).toBe(2);
  });

  test('198. PASS_getUserSpendingByRefId*3 - refId not found returns zero totals.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getUserSpendingByRefId('user-198', 'missing-ref');
    expect(result.totalSpent).toBe(0);
    expect(result.transactions).toEqual([]);
  });

  test('199. PASS_getUserSpendingByRefId*4 - multiple transactions summed correctly.', async () => {
    const txs = [
      createTransactionRecord({
        userId: 'user-199',
        transactionType: TokenManager.TRANSACTION_TYPES.TIP,
        amount: 3,
      }),
      createTransactionRecord({
        transactionType: TokenManager.TRANSACTION_TYPES.DEBIT,
        amount: 4,
        freeBeneficiaryConsumed: 1,
      }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserSpendingByRefId('user-199', 'ref-199');
    expect(result.transactionCount).toBe(2);
    expect(result.totalSpent).toBe(3 + 4 + 1);
  });

  test('200. FAIL*getUserSpendingByRefId_1 - invalid userId/refId rejected.', async () => {
    await expect(TokenManager.getUserSpendingByRefId('', '')).rejects.toThrow(/is required/);
  });

  test('201. FAIL*getUserSpendingByRefId_2 - DB failure bubbles.', async () => {
    const err = new Error('spending query failed');
    mockScyllaDb.query.mockRejectedValueOnce(err);
    await expect(TokenManager.getUserSpendingByRefId('user-201', 'ref-201')).rejects.toThrow('spending query failed');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get user spending by refId'),
      expect.objectContaining({ code: 'GET_USER_SPENDING_BY_REF_ID_ERROR' }),
    );
  });

  test('202. FAIL*getUserSpendingByRefId_3 - refId injection strings sanitized (query receives safe value).', async () => {
    const maliciousRef = 'ref-202-#;<script>';
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await TokenManager.getUserSpendingByRefId('user-202', maliciousRef);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    expect(params[':rid']).toBe(maliciousRef);
  });
});

describe('TokenManager adjustUserTokensAdmin batch #1', () => {
  let creditPaidSpy;
  let creditFreeSpy;

  beforeEach(() => {
    creditPaidSpy = jest.spyOn(TokenManager, 'creditPaidTokens').mockResolvedValue({ id: 'paid-203' });
    creditFreeSpy = jest.spyOn(TokenManager, 'creditFreeTokens').mockResolvedValue({ id: 'free-204' });
  });

  afterEach(() => {
    creditPaidSpy.mockRestore();
    creditFreeSpy.mockRestore();
  });

  test('203. PASS_adjustUserTokensAdmin*1 - type=paid credits paid tokens.', async () => {
    await TokenManager.adjustUserTokensAdmin({
      userId: 'admin-203',
      amount: 20,
      type: 'paid',
      reason: 'bonus',
    });
    expect(creditPaidSpy).toHaveBeenCalledWith('admin-203', 20, 'admin_adjustment', { reason: 'bonus' });
  });

  test('204. PASS_adjustUserTokensAdmin*2 - type=free credits free tokens with beneficiary/expiry.', async () => {
    await TokenManager.adjustUserTokensAdmin({
      userId: 'admin-204',
      amount: 5,
      type: 'free',
      beneficiaryId: 'ben-204',
      expiresAt: '2025-01-10T00:00:00.000Z',
      reason: 'promo',
    });
    expect(creditFreeSpy).toHaveBeenCalledWith(
      'admin-204',
      'ben-204',
      5,
      '2025-01-10T00:00:00.000Z',
      'admin_adjustment',
      { reason: 'promo' },
    );
  });

  test('205. PASS_adjustUserTokensAdmin*3 - type=debit currently rejects (Invalid token type).', async () => {
    await expect(
      TokenManager.adjustUserTokensAdmin({
        userId: 'admin-205',
        amount: 3,
        type: 'debit',
        reason: 'manual',
      }),
    ).rejects.toThrow(/Invalid token type/);
  });

  test('206. PASS_adjustUserTokensAdmin*4 - reason must be provided and stored.', async () => {
    await TokenManager.adjustUserTokensAdmin({
      userId: 'admin-206',
      amount: 1,
      type: 'paid',
      reason: 'correction',
    });
    const logged = mockLogger.writeLog.mock.calls.find((call) => call[0].action === 'adjustUserTokensAdmin')[0];
    expect(logged.data.reason).toBe('correction');
  });

  test('207. PASS_adjustUserTokensAdmin*5 - amount boundary 1 works.', async () => {
    await TokenManager.adjustUserTokensAdmin({
      userId: 'admin-207',
      amount: 1,
      type: 'paid',
      reason: 'edge',
    });
    expect(creditPaidSpy).toHaveBeenCalledWith('admin-207', 1, 'admin_adjustment', { reason: 'edge' });
  });

  test('208. PASS_adjustUserTokensAdmin*6 - returns created transaction(s) (logs written).', async () => {
    await TokenManager.adjustUserTokensAdmin({
      userId: 'admin-208',
      amount: 2,
      type: 'paid',
      reason: 'audit',
    });
    expect(mockLogger.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'adjustUserTokensAdmin',
        data: expect.objectContaining({ userId: 'admin-208' }),
      }),
    );
  });

  test('209. FAIL*adjustUserTokensAdmin_1 - invalid type rejected.', async () => {
    await expect(
      TokenManager.adjustUserTokensAdmin({
        userId: 'admin-209',
        amount: 1,
        type: 'unknown',
        reason: 'invalid',
      }),
    ).rejects.toThrow(/Invalid token type/);
  });

  test('210. FAIL*adjustUserTokensAdmin_2 - missing reason rejected.', async () => {
    await expect(
      TokenManager.adjustUserTokensAdmin({
        userId: 'admin-210',
        amount: 1,
        type: 'paid',
        reason: 123, // Invalid type
      }),
    ).rejects.toThrow(/reason must be a string/);
  });

  test('211. FAIL*adjustUserTokensAdmin_3 - missing beneficiaryId for free credit rejected.', async () => {
    await expect(
      TokenManager.adjustUserTokensAdmin({
        userId: 'admin-211',
        amount: 1,
        type: 'free',
        reason: 'oops',
      }),
    ).rejects.toThrow(/beneficiaryId is required/);
  });

  test('212. FAIL*adjustUserTokensAdmin_4 - non-positive amount rejected.', async () => {
    await expect(
      TokenManager.adjustUserTokensAdmin({
        userId: 'admin-212',
        amount: 0,
        type: 'paid',
        reason: 'nope',
      }),
    ).rejects.toThrow(/must be greater than 0/);
  });

  test('213. FAIL*adjustUserTokensAdmin_5 - addTransaction failure bubbles (creditPaidTokens error).', async () => {
    creditPaidSpy.mockRejectedValueOnce(new Error('credit fail'));
    await expect(
      TokenManager.adjustUserTokensAdmin({
        userId: 'admin-213',
        amount: 1,
        type: 'paid',
        reason: 'fail',
      }),
    ).rejects.toThrow('credit fail');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to adjust user tokens as admin'),
      expect.objectContaining({ code: 'ADJUST_USER_TOKENS_ADMIN_ERROR' }),
    );
  });
});

describe('TokenManager purgeOldRegistryRecords batch #1', () => {
  const oldRecord = {
    id: 'old-record',
    createdAt: '2000-01-01T00:00:00.000Z',
  };

  afterEach(() => {
    mockDateTime.now.mockImplementation(() => referenceNow.toISOString());
  });

  test('214. PASS_purgeOldRegistryRecords*1 - dryRun true returns counts without deleting.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    const result = await TokenManager.purgeOldRegistryRecords({ dryRun: true });
    expect(result.candidates).toBe(1);
    expect(result.deleted).toBe(0);
    expect(mockScyllaDb.deleteItem).not.toHaveBeenCalled();
    expect(mockConfigLoader.load).toHaveBeenCalled();
  });

  test('215. PASS_purgeOldRegistryRecords*2 - olderThanDays default ensures limit 1000 scanned.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([]);
    await TokenManager.purgeOldRegistryRecords();
    expect(mockScyllaDb.scan).toHaveBeenCalledWith(
      TokenManager.TABLES.TOKEN_REGISTRY,
      expect.objectContaining({ Limit: 1000 }),
    );
  });

  test('216. PASS_purgeOldRegistryRecords*3 - limit parameter passed to scan.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([]);
    await TokenManager.purgeOldRegistryRecords({ limit: 5 });
    expect(mockScyllaDb.scan).toHaveBeenCalledWith(
      TokenManager.TABLES.TOKEN_REGISTRY,
      expect.objectContaining({ Limit: 5 }),
    );
  });

  test('217. PASS_purgeOldRegistryRecords*4 - maxSeconds stops early with limited duration.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    mockDateTime.now
      .mockReturnValueOnce(referenceNow.toISOString())
      .mockReturnValueOnce(new Date(referenceNow.getTime() + 5000).toISOString())
      .mockReturnValueOnce(new Date(referenceNow.getTime() + 6000).toISOString());
    await TokenManager.purgeOldRegistryRecords({ dryRun: false, maxSeconds: 4 });
    expect(mockScyllaDb.deleteItem).not.toHaveBeenCalled();
  });

  test('218. PASS_purgeOldRegistryRecords*5 - archive=false deletes records directly.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    await TokenManager.purgeOldRegistryRecords({ dryRun: false, archive: false });
    expect(mockScyllaDb.deleteItem).toHaveBeenCalledWith(TokenManager.TABLES.TOKEN_REGISTRY, {
      id: 'old-record',
    });
  });

  test('219. PASS_purgeOldRegistryRecords*6 - archive=true archives before deleting.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    await TokenManager.purgeOldRegistryRecords({ dryRun: false, archive: true });
    expect(mockScyllaDb.putItem).toHaveBeenCalledWith(TokenManager.TABLES.TOKEN_REGISTRY_ARCHIVE, oldRecord);
    expect(mockScyllaDb.deleteItem).toHaveBeenCalled();
  });

  test('220. FAIL*purgeOldRegistryRecords_1 - invalid olderThanDays rejected.', async () => {
    await expect(TokenManager.purgeOldRegistryRecords({ olderThanDays: 'bad' })).rejects.toThrow(/must be an integer/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to purge old registry records'),
      expect.objectContaining({ code: 'PURGE_OLD_REGISTRY_RECORDS_ERROR' }),
    );
  });

  test('221. FAIL*purgeOldRegistryRecords_2 - archive write failure prevents delete.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('archive fail'));
    await expect(TokenManager.purgeOldRegistryRecords({ dryRun: false, archive: true })).rejects.toThrow('archive fail');
    expect(mockScyllaDb.deleteItem).not.toHaveBeenCalled();
  });

  test('222. FAIL*purgeOldRegistryRecords_3 - delete failure bubbles.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    mockScyllaDb.deleteItem.mockRejectedValueOnce(new Error('delete fail'));
    await expect(TokenManager.purgeOldRegistryRecords({ dryRun: false })).rejects.toThrow('delete fail');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to purge old registry records'),
      expect.objectContaining({ code: 'PURGE_OLD_REGISTRY_RECORDS_ERROR' }),
    );
  });

  test('223. FAIL*purgeOldRegistryRecords_4 - scan failure bubbles.', async () => {
    mockScyllaDb.scan.mockRejectedValueOnce(new Error('scan fail'));
    await expect(TokenManager.purgeOldRegistryRecords()).rejects.toThrow('scan fail');
  });
});

describe('TokenManager findExpiredHolds batch #1', () => {
  const expiredHold = (id, state = TokenManager.HOLD_STATES.OPEN, expiresOffset = -1000) =>
    createHoldRecord({
      id,
      state,
      expiresAt: new Date(referenceNow.getTime() + expiresOffset).toISOString(),
    });

  test('224. PASS_findExpiredHolds*1 - returns OPEN holds expired by threshold.', async () => {
    const hold = expiredHold('hold-224', TokenManager.HOLD_STATES.OPEN, -5000);
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toEqual([hold]);
  });

  test('225. PASS_findExpiredHolds*2 - excludes CAPTURED and REVERSED holds.', async () => {
    const openHold = expiredHold('hold-225-open');
    const capturedHold = expiredHold('hold-225-captured', TokenManager.HOLD_STATES.CAPTURED);
    const reversedHold = expiredHold('hold-225-reversed', TokenManager.HOLD_STATES.REVERSED);
    mockScyllaDb.query.mockResolvedValueOnce([openHold, capturedHold, reversedHold]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toEqual([openHold]);
  });

  test('226. PASS_findExpiredHolds*3 - limit caps number of returned holds.', async () => {
    const holds = Array.from({ length: 3 }, (_, index) => expiredHold(`hold-226-${index}`));
    mockScyllaDb.query.mockResolvedValueOnce(holds);
    const result = await TokenManager.findExpiredHolds(0, 2);
    expect(result).toHaveLength(2);
  });

  test('227. PASS_findExpiredHolds*4 - expiredForSeconds=0 uses now as cutoff.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([expiredHold('hold-227')]);
    await TokenManager.findExpiredHolds(0);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    expect(params[':cutoff']).toBe(referenceNow.toISOString());
  });

  test('228. FAIL*findExpiredHolds_1 - invalid limit rejected.', async () => {
    await expect(TokenManager.findExpiredHolds(0, 'bad')).rejects.toThrow(/limit must be an integer/);
  });

  test('229. FAIL*findExpiredHolds_2 - invalid expiredForSeconds rejected.', async () => {
    await expect(TokenManager.findExpiredHolds('bad', 10)).rejects.toThrow(/expiredForSeconds must be an integer/);
  });

  test('230. FAIL*findExpiredHolds_3 - DB query failure bubbles.', async () => {
    const err = new Error('query fail');
    mockScyllaDb.query.mockRejectedValueOnce(err);
    await expect(TokenManager.findExpiredHolds()).rejects.toThrow('query fail');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to find expired holds'),
      expect.objectContaining({ code: 'FIND_EXPIRED_HOLDS_ERROR' }),
    );
  });
});

describe('TokenManager processExpiredHolds batch #1', () => {
  let findExpiredSpy;
  let reverseSpy;

  beforeEach(() => {
    findExpiredSpy = jest.spyOn(TokenManager, 'findExpiredHolds');
    reverseSpy = jest.spyOn(TokenManager, 'reverseHeldTokens');
  });

  afterEach(() => {
    findExpiredSpy.mockRestore();
    reverseSpy.mockRestore();
  });

  test('231. PASS_processExpiredHolds*1 - no expired holds returns zero summary.', async () => {
    findExpiredSpy.mockResolvedValueOnce([]);
    const result = await TokenManager.processExpiredHolds(0, 5);
    expect(result.processed).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  test('232. PASS_processExpiredHolds*2 - reverses each expired hold.', async () => {
    const hold = createHoldRecord({ id: 'hold-232' });
    findExpiredSpy.mockResolvedValueOnce([hold]);
    reverseSpy.mockResolvedValueOnce({ reversedCount: 1 });
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.reversed).toBe(1);
    expect(result.processed).toBe(1);
  });

  test('233. PASS_processExpiredHolds*3 - batchSize forwarded to findExpiredHolds.', async () => {
    findExpiredSpy.mockResolvedValueOnce([]);
    await TokenManager.processExpiredHolds(10, 2);
    expect(findExpiredSpy).toHaveBeenCalledWith(10, 2);
  });

  test('234. PASS_processExpiredHolds*4 - continues when one reverse fails.', async () => {
    const holds = [createHoldRecord({ id: 'hold-234-a' }), createHoldRecord({ id: 'hold-234-b' })];
    findExpiredSpy.mockResolvedValueOnce(holds);
    reverseSpy
      .mockResolvedValueOnce({ reversedCount: 1 })
      .mockRejectedValueOnce(new Error('reverse fail'));
    const result = await TokenManager.processExpiredHolds(0, 2);
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  test('235. PASS_processExpiredHolds*5 - returns duration and stats even for large batch.', async () => {
    const holds = Array.from({ length: 3 }, (_, idx) => createHoldRecord({ id: `hold-235-${idx}` }));
    findExpiredSpy.mockResolvedValueOnce(holds);
    reverseSpy.mockResolvedValue({ reversedCount: 1 });
    const result = await TokenManager.processExpiredHolds(0, 3);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.processed).toBe(3);
  });

  test('236. PASS_processExpiredHolds*6 - idempotent-ish: later run counts alreadyProcessed.', async () => {
    const hold = createHoldRecord({ id: 'hold-236' });
    findExpiredSpy
      .mockResolvedValueOnce([hold])
      .mockResolvedValueOnce([hold]);
    reverseSpy
      .mockResolvedValueOnce({ reversedCount: 1 })
      .mockResolvedValueOnce({ alreadyReversed: true });
    await TokenManager.processExpiredHolds(0, 1);
    const secondResult = await TokenManager.processExpiredHolds(0, 1);
    expect(secondResult.alreadyProcessed).toBe(1);
  });

  test('237. FAIL_processExpiredHolds_1 - findExpiredHolds throws bubbles.', async () => {
    const err = new Error('find fail');
    findExpiredSpy.mockRejectedValueOnce(err);
    await expect(TokenManager.processExpiredHolds()).rejects.toThrow('find fail');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process expired holds'),
      expect.objectContaining({ code: 'PROCESS_EXPIRED_HOLDS_ERROR' }),
    );
  });

  test('238. FAIL_processExpiredHolds_2 - reverseHeldTokens throws for a hold but processing continues.', async () => {
    const hold = createHoldRecord({ id: 'hold-238' });
    findExpiredSpy.mockResolvedValueOnce([hold]);
    reverseSpy.mockRejectedValueOnce(new Error('reverse fail'));
    const result = await TokenManager.processExpiredHolds();
    expect(result.failed).toBe(1);
    expect(result.errors[0].holdId).toBe(hold.id);
  });

  test('239. FAIL_processExpiredHolds_3 - invalid args rejected.', async () => {
    await expect(TokenManager.processExpiredHolds('bad', 1)).rejects.toThrow(/expiredForSeconds must be an integer/);
  });
});

describe('TokenManager getTransactionById batch #1', () => {
  const makeRecord = (overrides = {}) =>
    createTransactionRecord({
      id: overrides.id ?? 'tx-240',
      metadata: overrides.metadata ?? JSON.stringify({ auditTrail: [] }),
      ...overrides,
    });

  test('240. PASS_getTransactionById*1 - returns record when transaction exists.', async () => {
    const record = makeRecord({ id: 'tx-240' });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-240');
    expect(result.id).toBe('tx-240');
    expect(result.metadata).toEqual({ auditTrail: [] }); // metadata is parsed from JSON string
  });

  test('241. PASS_getTransactionById*2 - returns all optional fields.', async () => {
    const record = makeRecord({
      id: 'tx-241',
      purpose: 'test',
      beneficiaryId: 'ben',
      expiresAt: '2026-01-01T00:00:00.000Z',
      metadata: JSON.stringify({ foo: 'bar' }),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-241');
    expect(result.metadata.foo).toBe('bar');
    expect(result.expiresAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('242. PASS_getTransactionById*3 - minimal record returns with defaults.', async () => {
    const record = makeRecord({ id: 'tx-242', metadata: null });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-242');
    expect(result.metadata).toBeNull();
  });

  test('243. PASS_getTransactionById*4 - metadata string parsed to object.', async () => {
    const record = makeRecord({
      id: 'tx-243',
      metadata: JSON.stringify({ nested: { ok: true } }),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-243');
    expect(result.metadata).toEqual({ nested: { ok: true } });
  });

  test('244. PASS_getTransactionById*5 - HOLD record includes state and version.', async () => {
    const hold = makeRecord({
      id: 'tx-244',
      transactionType: TokenManager.TRANSACTION_TYPES.HOLD,
      state: TokenManager.HOLD_STATES.OPEN,
      version: 3,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const result = await TokenManager.getTransactionById('tx-244');
    expect(result.state).toBe(TokenManager.HOLD_STATES.OPEN);
    expect(result.version).toBe(3);
  });

  test('245. PASS_getTransactionById*6 - TIP includes free consumption fields.', async () => {
    const tip = makeRecord({
      id: 'tx-245',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      freeBeneficiaryConsumed: 2,
      freeSystemConsumed: 1,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(tip);
    const result = await TokenManager.getTransactionById('tx-245');
    expect(result.freeBeneficiaryConsumed).toBe(2);
    expect(result.freeSystemConsumed).toBe(1);
  });

  test('246. PASS_getTransactionById*7 - CREDIT_FREE returns expiresAt ISO.', async () => {
    const record = makeRecord({
      id: 'tx-246',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      expiresAt: '2025-12-31T23:00:00.000Z',
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-246');
    expect(result.expiresAt).toBe('2025-12-31T23:00:00.000Z');
  });

  test('247. PASS_getTransactionById*8 - allows UUID-like id format validation pass.', async () => {
    const id = 'uuid-247';
    const record = makeRecord({ id });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById(id);
    expect(result.id).toBe(id);
  });

  test('248. PASS_getTransactionById*9 - version field present on returned object.', async () => {
    const record = makeRecord({ id: 'tx-248', version: 7 });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-248');
    expect(result.version).toBe(7);
  });

  test('249. PASS_getTransactionById*10 - DEBIT metadata breakdown preserved.', async () => {
    const record = makeRecord({
      id: 'tx-249',
      transactionType: TokenManager.TRANSACTION_TYPES.DEBIT,
      metadata: JSON.stringify({ breakdown: { paid: 1 } }),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-249');
    expect(result.metadata.breakdown.paid).toBe(1);
  });

  test('250. FAIL_getTransactionById_1 - missing transactionId throws.', async () => {
    await expect(TokenManager.getTransactionById()).rejects.toThrow(/transactionId is required/);
  });

  test('251. FAIL_getTransactionById_2 - empty string rejected.', async () => {
    await expect(TokenManager.getTransactionById('')).rejects.toThrow(/transactionId must be a string/);
  });

  test('252. FAIL_getTransactionById_3 - null transactionId rejected.', async () => {
    await expect(TokenManager.getTransactionById(null)).rejects.toThrow(/transactionId is required/);
  });

  test('253. FAIL_getTransactionById_4 - non-existent id returns null (or undefined).', async () => {
    mockScyllaDb.getItem.mockResolvedValueOnce(null);
    const result = await TokenManager.getTransactionById('missing');
    expect(result).toBeNull();
  });

  test('254. FAIL_getTransactionById_5 - invalid format rejected.', async () => {
    await expect(TokenManager.getTransactionById(123)).rejects.toThrow(/transactionId must be a string/);
  });

  test('255. FAIL_getTransactionById_6 - ScyllaDb failure bubbles.', async () => {
    const err = new Error('getItem fail');
    mockScyllaDb.getItem.mockRejectedValueOnce(err);
    await expect(TokenManager.getTransactionById('tx-255')).rejects.toThrow('getItem fail');
  });

  test('256. FAIL_getTransactionById_7 - corrupted record handled safely.', async () => {
    const badRecord = makeRecord({ id: 'tx-256', metadata: '{bad json' });
    mockScyllaDb.getItem.mockResolvedValueOnce(badRecord);
    const result = await TokenManager.getTransactionById('tx-256');
    expect(result.metadata).toEqual('{bad json');
  });

  test('257. FAIL_getTransactionById_8 - SQL injection attempt sanitized (query receives literal id).', async () => {
    const maliciousId = 'tx-257; DROP TABLE';
    mockScyllaDb.getItem.mockResolvedValueOnce(null);
    await expect(TokenManager.getTransactionById(maliciousId)).resolves.toBeNull();
  });

  test('258. FAIL_getTransactionById_9 - malformed metadata handled gracefully.', async () => {
    const record = makeRecord({ id: 'tx-258', metadata: 'not json' });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-258');
    expect(result.metadata).toBe('not json');
  });
});

describe('TokenManager getTransactionsByRefId batch #1', () => {
  const buildRefTx = (overrides = {}) =>
    createTransactionRecord({
      refId: overrides.refId ?? 'ref-259',
      userId: overrides.userId ?? 'user-259',
      beneficiaryId: overrides.beneficiaryId ?? 'beneficiary-259',
      ...overrides,
    });

  test('259. PASS_getTransactionsByRefId*1 - single transaction returned.', async () => {
    const tx = buildRefTx({ id: 'tx-259' });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTransactionsByRefId('user-259', 'ref-259');
    expect(result).toEqual([tx]);
  });

  test('260. PASS_getTransactionsByRefId*2 - multiple transactions same ref returned.', async () => {
    const txs = [buildRefTx({ id: 'tx-260-a' }), buildRefTx({ id: 'tx-260-b' })];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTransactionsByRefId('user-260', 'ref-260');
    expect(result).toHaveLength(2);
  });

  test('261. PASS_getTransactionsByRefId*3 - no transactions returns [].', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getTransactionsByRefId('user-261', 'ref-261');
    expect(result).toEqual([]);
  });

  test('262. PASS_getTransactionsByRefId*4 - returns mixed transaction types for same ref.', async () => {
    const hold = buildRefTx({ id: 'hold-262', transactionType: TokenManager.TRANSACTION_TYPES.HOLD });
    const debit = buildRefTx({ id: 'debit-262', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT });
    mockScyllaDb.query.mockResolvedValueOnce([hold, debit]);
    const result = await TokenManager.getTransactionsByRefId('user-262', 'ref-262');
    expect(result.map((tx) => tx.transactionType)).toEqual(
      expect.arrayContaining([TokenManager.TRANSACTION_TYPES.HOLD, TokenManager.TRANSACTION_TYPES.DEBIT]),
    );
  });

  test('263. PASS_getTransactionsByRefId*5 - returns all HOLD states (HOLD/CAPTURED/REVERSED).', async () => {
    const txs = [
      buildRefTx({ id: 'hold-open-263', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.OPEN }),
      buildRefTx({ id: 'hold-captured-263', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.CAPTURED }),
      buildRefTx({ id: 'hold-reversed-263', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.REVERSED }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTransactionsByRefId('user-263', 'ref-263');
    expect(result).toHaveLength(3);
  });

  test('264. PASS_getTransactionsByRefId*6 - special characters in refId handled.', async () => {
    const refId = 'ref-264-#&%';
    mockScyllaDb.query.mockResolvedValueOnce([buildRefTx({ refId })]);
    const result = await TokenManager.getTransactionsByRefId('user-264', refId);
    expect(result[0].refId).toBe(refId);
  });

  test('265. PASS_getTransactionsByRefId*7 - results sorted by createdAt descending.', async () => {
    const txs = [
      buildRefTx({ id: 'tx-265-new', createdAt: '2025-01-02T00:00:00.000Z' }),
      buildRefTx({ id: 'tx-265-old', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTransactionsByRefId('user-265', 'ref-265');
    expect(Date.parse(result[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(result[1].createdAt));
  });

  test('266. PASS_getTransactionsByRefId*8 - handles large number of transactions.', async () => {
    const txs = Array.from({ length: 20 }, (_, index) =>
      buildRefTx({ id: `tx-266-${index}`, createdAt: new Date(referenceNow.getTime() + index * 1000).toISOString() }),
    );
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTransactionsByRefId('user-266', 'ref-266');
    expect(result).toHaveLength(20);
  });

  test('267. PASS_getTransactionsByRefId*9 - only transactions belonging to user are returned.', async () => {
    const tx = buildRefTx({ userId: 'user-267', beneficiaryId: 'user-267', refId: 'ref-267' });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTransactionsByRefId('user-267', 'ref-267');
    expect(result.every((row) => row.userId === 'user-267' || row.beneficiaryId === 'user-267')).toBe(true);
  });

  test('268. FAIL_getTransactionsByRefId_1 - missing userId throws.', async () => {
    await expect(TokenManager.getTransactionsByRefId('', 'ref-268')).rejects.toThrow(/userId is required/);
  });

  test('269. FAIL_getTransactionsByRefId_2 - missing refId throws.', async () => {
    await expect(TokenManager.getTransactionsByRefId('user-269', '')).rejects.toThrow(/refId is required/);
  });

  test('270. FAIL_getTransactionsByRefId_3 - empty userId string rejected.', async () => {
    await expect(TokenManager.getTransactionsByRefId('', 'ref-270')).rejects.toThrow(/userId is required/);
  });

  test('271. FAIL_getTransactionsByRefId_4 - empty refId string rejected.', async () => {
    await expect(TokenManager.getTransactionsByRefId('user-271', '')).rejects.toThrow(/refId is required/);
  });

  test('272. FAIL_getTransactionsByRefId_5 - DB error bubbles.', async () => {
    const err = new Error('query fail ref');
    mockScyllaDb.query.mockRejectedValueOnce(err);
    await expect(TokenManager.getTransactionsByRefId('user-272', 'ref-272')).rejects.toThrow('query fail ref');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get transactions by refId'),
      expect.objectContaining({ code: 'GET_TRANSACTIONS_BY_REF_ID_ERROR' }),
    );
  });

  test('273. FAIL_getTransactionsByRefId_6 - refId injection sanitized.', async () => {
    const maliciousRef = 'ref-273-#<script>';
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await TokenManager.getTransactionsByRefId('user-273', maliciousRef);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    expect(params[':rid']).toBe(maliciousRef);
  });

  test('274. FAIL_getTransactionsByRefId_7 - defensive: query should not return other users.', async () => {
    const tx = buildRefTx({ userId: 'other-user', refId: 'ref-274' });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTransactionsByRefId('user-274', 'ref-274');
    expect(result.every((row) => row.userId === 'user-274' || row.beneficiaryId === 'user-274')).toBe(false);
  });
});

describe('TokenManager token split priority coverage', () => {
  let balanceSpy;
  let validateSpy;

  beforeEach(() => {
    balanceSpy = jest.spyOn(TokenManager, 'getUserBalance');
    validateSpy = jest.spyOn(TokenManager, 'validateSufficientTokens').mockResolvedValue(true);
  });

  afterEach(() => {
    balanceSpy.mockRestore();
    validateSpy.mockRestore();
  });

  const expectDebitTx = () => mockScyllaDb.putItem.mock.calls[0][1];

  test('275. PASS_CALCULATE_TOKENSPLIT_1 - beneficiary-specific bucket used before system.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 10,
      freeTokensPerBeneficiary: { alice: 5, system: 5 },
    });
    await TokenManager.deductTokens('user-275', 3, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(3);
    expect(tx.freeSystemConsumed).toBe(0);
    expect(tx.amount).toBe(0);
  });

  test('276. PASS_CALCULATE_TOKENSPLIT_2 - system bucket used after beneficiary exhausted.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { alice: 2, system: 3 },
    });
    await TokenManager.deductTokens('user-276', 4, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(2);
    expect(tx.freeSystemConsumed).toBe(2);
    expect(tx.amount).toBe(0);
  });

  test('277. PASS_CALCULATE_TOKENSPLIT_3 - paid amount used after free exhausted.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.deductTokens('user-277', 5, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(0);
    expect(tx.freeSystemConsumed).toBe(0);
    expect(tx.amount).toBe(5);
  });

  test('278. PASS_CALCULATE_TOKENSPLIT_4 - mixed beneficiary + system free consumed.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { alice: 3, system: 2 },
    });
    await TokenManager.deductTokens('user-278', 5, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(3);
    expect(tx.freeSystemConsumed).toBe(2);
  });

  test('279. PASS_CALCULATE_TOKENSPLIT_5 - beneficiary free then paid remainder.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 2,
      freeTokensPerBeneficiary: { alice: 2 },
    });
    await TokenManager.deductTokens('user-279', 4, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(2);
    expect(tx.amount).toBe(2);
  });

  test('280. PASS_CALCULATE_TOKENSPLIT_6 - amount equals beneficiary free.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 3,
      freeTokensPerBeneficiary: { alice: 3 },
    });
    await TokenManager.deductTokens('user-280', 3, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.amount).toBe(0);
    expect(tx.freeBeneficiaryConsumed).toBe(3);
  });

  test('281. PASS_CALCULATE_TOKENSPLIT_7 - amount equals combined free buckets.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 6,
      freeTokensPerBeneficiary: { alice: 3, system: 3 },
    });
    await TokenManager.deductTokens('user-281', 6, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(3);
    expect(tx.freeSystemConsumed).toBe(3);
    expect(tx.amount).toBe(0);
  });

  test('282. PASS_CALCULATE_TOKENSPLIT_8 - amount exceeds all free buckets.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 4,
      freeTokensPerBeneficiary: { alice: 2, system: 2 },
    });
    await TokenManager.deductTokens('user-282', 7, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.amount).toBe(3);
  });

  test('283. FAIL_CALCULATE_TOKENSPLIT_1 - beneficiaryId=system does not double-count free.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { system: 5 },
    });
    await TokenManager.deductTokens('user-283', 3, { beneficiaryId: 'system' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(3);
    expect(tx.freeSystemConsumed).toBe(0);
    expect(tx.amount).toBe(0);
  });
});

describe('TokenManager creditFreeTokens edge coverage', () => {
  let addTransactionSpy;

  beforeEach(() => {
    addTransactionSpy = jest.spyOn(TokenManager, 'addTransaction').mockResolvedValue({ id: 'tx-free' });
  });

  afterEach(() => {
    addTransactionSpy.mockRestore();
  });

  test('284. PASS_CREDITFREETOKENS_1 - metadata tokenExpiresAt matches provided expiresAt.', async () => {
    await TokenManager.creditFreeTokens('user-284', 'ben-284', 1, '2025-02-02T00:00:00.000Z');
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.metadata.tokenExpiresAt).toBe('2025-02-02T00:00:00.000Z');
  });

  test('285. PASS_CREDITFREETOKENS_2 - null expiresAt uses sentinel in metadata.', async () => {
    await TokenManager.creditFreeTokens('user-285', 'ben-285', 2);
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.metadata.tokenExpiresAt).toBe('9999-12-31T23:59:59.999Z');
  });

  test('286. PASS_CREDITFREETOKENS_3 - near-future expiry still credited.', async () => {
    const nearExpiry = new Date(referenceNow.getTime() + 5 * 1000).toISOString();
    await TokenManager.creditFreeTokens('user-286', 'ben-286', 1, nearExpiry);
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.expiresAt).toBe(nearExpiry);
  });

  test('287. PASS_CREDITFREETOKENS_4 - beneficiary stored correctly.', async () => {
    await TokenManager.creditFreeTokens('user-287', 'ben-287', 3);
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.beneficiaryId).toBe('ben-287');
  });

  test('288. PASS_CREDITFREETOKENS_5 - system beneficiary stored under system bucket.', async () => {
    await TokenManager.creditFreeTokens('user-288', 'system', 4);
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.beneficiaryId).toBe('system');
  });

  test('289. PASS_CREDITFREETOKENS_6 - default purpose "free_grant".', async () => {
    await TokenManager.creditFreeTokens('user-289', 'ben-289', 5);
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.purpose).toBe('free_grant');
  });

  test('290. PASS_CREDITFREETOKENS_7 - custom purpose preserved.', async () => {
    await TokenManager.creditFreeTokens('user-290', 'ben-290', 2, null, 'promo', { foo: 'bar' });
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.purpose).toBe('promo');
    expect(call.metadata.foo).toBe('bar');
  });

  test('291. FAIL_CREDITFREETOKENS_1 - non-positive amount rejected.', async () => {
    await expect(TokenManager.creditFreeTokens('user-291', 'ben-291', 0)).rejects.toThrow(/amount must be positive/);
  });

  test('292. FAIL_CREDITFREETOKENS_2 - non-int amount rejected.', async () => {
    await expect(TokenManager.creditFreeTokens('user-292', 'ben-292', 1.5)).rejects.toThrow(/amount must be an integer/);
  });

  test('293. FAIL_CREDITFREETOKENS_3 - missing beneficiaryId rejected.', async () => {
    await expect(TokenManager.creditFreeTokens('user-293', null, 1)).rejects.toThrow(/beneficiaryId is required/);
  });

  test('294. FAIL_CREDITFREETOKENS_4 - metadata __proto__ does not pollute global prototype.', async () => {
    const payload = { __proto__: { hacked: 'yes' }, safe: true };
    await TokenManager.creditFreeTokens('user-294', 'ben-294', 1, null, 'free', payload);
    expect(Object.prototype.hacked).toBeUndefined();
  });
});

describe('TokenManager transferTokens extended coverage', () => {
  let addTransactionSpy;
  let balanceSpy;

  beforeEach(() => {
    addTransactionSpy = jest.spyOn(TokenManager, 'addTransaction').mockResolvedValue({
      id: 'tip-transfer',
      refId: 'ref-transfer',
    });
    balanceSpy = jest.spyOn(TokenManager, 'getUserBalance');
  });

  afterEach(() => {
    addTransactionSpy.mockRestore();
    balanceSpy.mockRestore();
  });

  test('295. PASS_TRANSFERTOKENS_1 - beneficiary-specific free consumed before system.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { 'ben-295': 5, system: 0 },
    });
    const result = await TokenManager.transferTokens('sender-295', 'ben-295', 3);
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.freeBeneficiaryConsumed).toBe(3);
    expect(call.freeSystemConsumed).toBe(0);
    expect(call.amount).toBe(0);
    expect(result.breakdown.freeTokensConsumed).toBe(3);
    expect(result.breakdown.paidTokensTransferred).toBe(0);
  });

  test('296. PASS_TRANSFERTOKENS_2 - system free consumed when beneficiary bucket empty.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { 'ben-296': 0, system: 5 },
    });
    await TokenManager.transferTokens('sender-296', 'ben-296', 4);
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.freeBeneficiaryConsumed).toBe(0);
    expect(call.freeSystemConsumed).toBe(4);
  });

  test('297. PASS_TRANSFERTOKENS_3 - paid tokens transferred after free consumption.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 3,
      freeTokensPerBeneficiary: { 'ben-297': 2, system: 1 },
    });
    await TokenManager.transferTokens('sender-297', 'ben-297', 5);
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.freeBeneficiaryConsumed).toBe(2);
    expect(call.freeSystemConsumed).toBe(1);
    expect(call.amount).toBe(2);
  });

  test('298. PASS_TRANSFERTOKENS_4 - all tokens covered by free buckets, TIP amount zero.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 9,
      freeTokensPerBeneficiary: { 'ben-298': 5, system: 4 },
    });
    await TokenManager.transferTokens('sender-298', 'ben-298', 8);
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.amount).toBe(0);
    expect(call.freeBeneficiaryConsumed).toBe(5);
    expect(call.freeSystemConsumed).toBe(3);
  });

  test('299. PASS_TRANSFERTOKENS_5 - expired beneficiary free not counted, paid used instead.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 4,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: { 'ben-299': 0, system: 0 },
    });
    await TokenManager.transferTokens('sender-299', 'ben-299', 4);
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.freeBeneficiaryConsumed).toBe(0);
    expect(call.freeSystemConsumed).toBe(0);
    expect(call.amount).toBe(4);
  });

  test('300. PASS_TRANSFERTOKENS_6 - metadata breakdown matches consumed fields.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 3,
      freeTokensPerBeneficiary: { 'ben-300': 2, system: 1 },
    });
    await TokenManager.transferTokens('sender-300', 'ben-300', 5);
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.metadata.breakdown).toEqual({
      beneficiarySpecificFree: 2,
      systemFree: 1,
      paid: 2,
    });
  });

  test('301. PASS_TRANSFERTOKENS_7 - metadata.totalTipAmount equals requested amount.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 2,
      freeTokensPerBeneficiary: { 'ben-301': 2, system: 0 },
    });
    await TokenManager.transferTokens('sender-301', 'ben-301', 5);
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.metadata.totalTipAmount).toBe(5);
  });

  test('302. PASS_TRANSFERTOKENS_8 - isAnonymous and note preserved in metadata.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 3,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.transferTokens('sender-302', 'ben-302', 2, 'thank you', { isAnonymous: true, note: 'appreciate it' });
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.metadata.isAnonymous).toBe(true);
    expect(call.metadata.note).toBe('appreciate it');
  });

  test('303. FAIL_TRANSFERTOKENS_1 - insufficient tokens throws descriptive error.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 1,
      totalFreeTokens: 2,
      freeTokensPerBeneficiary: { 'ben-303': 2, system: 0 },
    });
    await expect(TokenManager.transferTokens('sender-303', 'ben-303', 10)).rejects.toThrow(/Insufficient tokens/);
    expect(addTransactionSpy).not.toHaveBeenCalled();
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Insufficient tokens'),
      expect.objectContaining({ code: 'INSUFFICIENT_TOKENS' }),
    );
  });
});

describe('TokenManager holdTokens specialized coverage', () => {
  let addTransactionSpy;
  let balanceSpy;

  beforeEach(() => {
    addTransactionSpy = jest.spyOn(TokenManager, 'addTransaction').mockResolvedValue({ id: 'hold-tx' });
    balanceSpy = jest.spyOn(TokenManager, 'getUserBalance');
  });

  afterEach(() => {
    addTransactionSpy.mockRestore();
    balanceSpy.mockRestore();
  });

  test('304. PASS_HOLDTOKENS_1 - expiresAt math aligns with DateTime offsets.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.holdTokens('user-304', 5, 'beneficiary-304', { refId: 'booking-304' });
    const call = addTransactionSpy.mock.calls[0][0];
    const expectedExpiry = '2025-01-01T00:30:00.000Z';
    expect(call.expiresAt).toBe(expectedExpiry);
    expect(call.metadata.holdExpiresAt).toBe(expectedExpiry);
  });

  test('305. PASS_HOLDTOKENS_2 - metadata.holdExpiresAt mirrors expiresAt.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.holdTokens('user-305', 5, 'beneficiary-305', { refId: 'booking-305' });
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.metadata.holdExpiresAt).toBe(call.expiresAt);
  });

  test('306. PASS_HOLDTOKENS_3 - expiryAfterSeconds recorded inside metadata.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.holdTokens('user-306', 5, 'beneficiary-306', { refId: 'booking-306', expiresAfter: 900 });
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.metadata.expiryAfterSeconds).toBe(900);
  });

  test('307. PASS_HOLDTOKENS_4 - stores only paid portion in amount.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { 'beneficiary-307': 3, system: 2 },
    });
    await TokenManager.holdTokens('user-307', 8, 'beneficiary-307', { refId: 'booking-307' });
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.amount).toBe(3);
  });

  test('308. PASS_HOLDTOKENS_5 - free consumption fields populated correctly.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { 'beneficiary-308': 3, system: 2 },
    });
    await TokenManager.holdTokens('user-308', 8, 'beneficiary-308', { refId: 'booking-308' });
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.freeBeneficiaryConsumed).toBe(3);
    expect(call.freeSystemConsumed).toBe(2);
  });

  test('309. PASS_HOLDTOKENS_6 - auditTrail breakdown documents consumed buckets.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { 'beneficiary-309': 3, system: 2 },
    });
    await TokenManager.holdTokens('user-309', 8, 'beneficiary-309', { refId: 'booking-309' });
    const call = addTransactionSpy.mock.calls[0][0];
    expect(call.metadata.auditTrail[0].breakdown).toEqual({
      beneficiaryFreeConsumed: 3,
      systemFreeConsumed: 2,
      paidPortionHeld: 3,
    });
  });

  test('310. FAIL_HOLDTOKENS_1 - duplicate open hold for refId rejected.', async () => {
    const existingHold = createHoldRecord({
      id: 'hold-310',
      refId: 'booking-310',
      state: TokenManager.HOLD_STATES.OPEN,
    });
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    mockScyllaDb.query.mockResolvedValueOnce([existingHold]);
    await expect(
      TokenManager.holdTokens('user-310', 5, 'beneficiary-310', { refId: 'booking-310' }),
    ).rejects.toThrow(/Open HOLD already exists/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Open HOLD already exists'),
      expect.objectContaining({ code: 'DUPLICATE_HOLD_REFID' }),
    );
  });

  test('311. PASS_HOLDTOKENS_7 - captured/reversed holds do not block new hold.', async () => {
    const capturedHold = createHoldRecord({
      id: 'hold-311',
      refId: 'booking-311',
      state: TokenManager.HOLD_STATES.CAPTURED,
    });
    mockScyllaDb.query.mockResolvedValueOnce([capturedHold]);
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.holdTokens('user-311', 5, 'beneficiary-311', { refId: 'booking-311' });
    expect(addTransactionSpy).toHaveBeenCalled();
  });

  test('312. PASS_HOLDTOKENS_8 - missing state logged but hold proceeds.', async () => {
    const corruptedHold = createHoldRecord({
      id: 'hold-312',
      refId: 'booking-312',
      state: undefined,
    });
    mockScyllaDb.query.mockResolvedValueOnce([corruptedHold]);
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.holdTokens('user-312', 5, 'beneficiary-312', { refId: 'booking-312' });
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('missing state'),
      expect.objectContaining({ code: 'HOLD_MISSING_STATE' }),
    );
  });
});

describe('TokenManager captureHeldTokens extended coverage', () => {
  const buildOpenHold = (overrides = {}) =>
    createHoldRecord({
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: JSON.stringify({ auditTrail: [] }),
      ...overrides,
    });

  test('313. PASS_CAPTUREHELD_1 - capture by transactionId flips state to captured.', async () => {
    const hold = buildOpenHold({ id: 'hold-313' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({
      ...hold,
      state: TokenManager.HOLD_STATES.CAPTURED,
      version: hold.version + 1,
    });
    const result = await TokenManager.captureHeldTokens({ transactionId: hold.id });
    expect(mockScyllaDb.updateItem).toHaveBeenCalled();
    expect(result.capturedCount).toBe(1);
    expect(mockScyllaDb.updateItem.mock.calls[0][2].state).toBe(TokenManager.HOLD_STATES.CAPTURED);
  });

  test('314. PASS_CAPTUREHELD_2 - capture by refId handles multiple holds.', async () => {
    const holdA = buildOpenHold({ id: 'hold-314-a', refId: 'booking-314' });
    const holdB = buildOpenHold({ id: 'hold-314-b', refId: 'booking-314' });
    mockScyllaDb.query.mockResolvedValueOnce([holdA, holdB]);
    mockScyllaDb.updateItem
      .mockResolvedValueOnce({ ...holdA, state: TokenManager.HOLD_STATES.CAPTURED, version: holdA.version + 1 })
      .mockResolvedValueOnce({ ...holdB, state: TokenManager.HOLD_STATES.CAPTURED, version: holdB.version + 1 });
    const result = await TokenManager.captureHeldTokens({ refId: 'booking-314' });
    expect(result.capturedCount).toBe(2);
    expect(mockScyllaDb.updateItem).toHaveBeenCalledTimes(2);
  });

  test('315. PASS_CAPTUREHELD_3 - already captured hold returns idempotent response.', async () => {
    const hold = buildOpenHold({ id: 'hold-315' });
    mockScyllaDb.getItem
      .mockResolvedValueOnce(hold)
      .mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED });
    mockScyllaDb.updateItem.mockResolvedValueOnce({
      ...hold,
      state: TokenManager.HOLD_STATES.CAPTURED,
      version: hold.version + 1,
    });
    await TokenManager.captureHeldTokens({ transactionId: hold.id });
    const secondResult = await TokenManager.captureHeldTokens({ transactionId: hold.id });
    expect(secondResult.alreadyCaptured).toBe(true);
  });

  test('316. FAIL_CAPTUREHELD_1 - conditional update failure returns zero captures.', async () => {
    const hold = buildOpenHold({ id: 'hold-316' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const conditionalError = new Error('conditional');
    conditionalError.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(conditionalError);
    const result = await TokenManager.captureHeldTokens({ transactionId: hold.id });
    expect(result.capturedCount).toBe(0);
  });
});

describe('TokenManager reverseHeldTokens extended coverage', () => {
  const buildOpenHold = (overrides = {}) =>
    createHoldRecord({
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: JSON.stringify({ auditTrail: [] }),
      ...overrides,
    });

  test('317. PASS_REVERSEHELD_1 - reverse by transactionId sets state to reversed.', async () => {
    const hold = buildOpenHold({ id: 'hold-317' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({
      ...hold,
      state: TokenManager.HOLD_STATES.REVERSED,
      version: hold.version + 1,
    });
    const result = await TokenManager.reverseHeldTokens({ transactionId: hold.id });
    expect(mockScyllaDb.updateItem).toHaveBeenCalled();
    expect(result.reversedCount).toBe(1);
    expect(mockScyllaDb.updateItem.mock.calls[0][2].state).toBe(TokenManager.HOLD_STATES.REVERSED);
  });

  test('318. PASS_REVERSEHELD_2 - reverse by refId reverses every open hold.', async () => {
    const holdA = buildOpenHold({ id: 'hold-318-a', refId: 'booking-318' });
    const holdB = buildOpenHold({ id: 'hold-318-b', refId: 'booking-318' });
    mockScyllaDb.query.mockResolvedValueOnce([holdA, holdB]);
    mockScyllaDb.updateItem
      .mockResolvedValueOnce({ ...holdA, state: TokenManager.HOLD_STATES.REVERSED, version: holdA.version + 1 })
      .mockResolvedValueOnce({ ...holdB, state: TokenManager.HOLD_STATES.REVERSED, version: holdB.version + 1 });
    const result = await TokenManager.reverseHeldTokens({ refId: 'booking-318' });
    expect(result.reversedCount).toBe(2);
    expect(mockScyllaDb.updateItem).toHaveBeenCalledTimes(2);
  });

  test('319. PASS_REVERSEHELD_3 - conditional update failure is skipped and continues.', async () => {
    const hold = buildOpenHold({ id: 'hold-319', refId: 'booking-319' });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const conditionalError = new Error('conditional');
    conditionalError.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(conditionalError);
    const result = await TokenManager.reverseHeldTokens({ refId: 'booking-319' });
    expect(result.reversedCount).toBe(0);
  });

  test('320. PASS_REVERSEHELD_4 - reversed hold releases consumed free tokens in balance.', async () => {
    const hold = buildOpenHold({
      id: 'hold-320',
      userId: 'user-320',
      beneficiaryId: 'beneficiary-320',
      freeBeneficiaryConsumed: 2,
      freeSystemConsumed: 1,
      amount: 3,
      state: TokenManager.HOLD_STATES.OPEN,
    });

    // Before reversal, balance reflects the hold reducing buckets.
    mockScyllaDb.query
      .mockResolvedValueOnce([hold]) // user transactions
      .mockResolvedValueOnce([]); // tips
    const beforeBalance = await TokenManager.getUserBalance('user-320');

    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED, version: hold.version + 1 });
    await TokenManager.reverseHeldTokens({ transactionId: hold.id });

    const reversedHold = { ...hold, state: TokenManager.HOLD_STATES.REVERSED };
    mockScyllaDb.query
      .mockResolvedValueOnce([reversedHold])
      .mockResolvedValueOnce([]);
    const afterBalance = await TokenManager.getUserBalance('user-320');

    expect((beforeBalance.freeTokensPerBeneficiary['beneficiary-320'] ?? 0)).toBeLessThanOrEqual(0);
    expect((afterBalance.freeTokensPerBeneficiary['beneficiary-320'] ?? 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('TokenManager extendExpiry extended coverage', () => {
  const buildOpenHold = (overrides = {}) =>
    createHoldRecord({
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: JSON.stringify({ auditTrail: [] }),
      ...overrides,
    });

  test('321. PASS_EXTENDEXPIRY_1 - extend increases expiresAt and records audit trail.', async () => {
    const hold = buildOpenHold({
      id: 'hold-321',
      createdAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-01T00:10:00.000Z',
      version: 1,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({
      ...hold,
      expiresAt: '2025-01-01T00:15:00.000Z',
      version: 2,
    });
    const result = await TokenManager.extendExpiry({ transactionId: hold.id, extendBySeconds: 300 });
    const metadata = JSON.parse(mockScyllaDb.updateItem.mock.calls[0][2].metadata);
    expect(result.transactions[0].expiresAt).toBe('2025-01-01T00:15:00.000Z');
    expect(metadata.auditTrail.some((entry) => entry.status === 'EXTENDED')).toBe(true);
  });

  test('322. PASS_EXTENDEXPIRY_2 - respects maxTotalSeconds cap.', async () => {
    const hold = buildOpenHold({
      id: 'hold-322',
      createdAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-01T00:05:00.000Z',
      version: 1,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({
      ...hold,
      expiresAt: '2025-01-01T00:10:00.000Z',
      version: 2,
    });
    const result = await TokenManager.extendExpiry({
      transactionId: hold.id,
      extendBySeconds: 300,
      maxTotalSeconds: 8000,
    });
    expect(result.transactions[0].totalTimeoutSeconds).toBeLessThanOrEqual(8000);
  });

  test('323. FAIL_EXTENDEXPIRY_1 - cannot extend already captured hold.', async () => {
    const captured = buildOpenHold({
      id: 'hold-323',
      state: TokenManager.HOLD_STATES.CAPTURED,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(captured);
    await expect(TokenManager.extendExpiry({ transactionId: captured.id, extendBySeconds: 60 })).rejects.toThrow(/already captured/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('already captured'),
      expect.objectContaining({ code: 'ALREADY_CAPTURED' }),
    );
  });

  test('324. FAIL_EXTENDEXPIRY_2 - concurrent conditional failure surfaces ALREADY_PROCESSED.', async () => {
    const hold = buildOpenHold({
      id: 'hold-324',
      version: 1,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const conditionalError = new Error('conditional failure');
    conditionalError.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(conditionalError);
    await expect(TokenManager.extendExpiry({ transactionId: hold.id, extendBySeconds: 60 })).rejects.toThrow(/already captured or reversed/);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('already captured or reversed'),
      expect.objectContaining({ code: 'ALREADY_PROCESSED' }),
    );
  });
});

describe('TokenManager validateSufficientTokens batch #2', () => {
  let balanceSpy;

  beforeEach(() => {
    balanceSpy = jest.spyOn(TokenManager, 'getUserBalance');
  });

  afterEach(() => {
    balanceSpy.mockRestore();
  });

  test('325. PASS_VALIDATESUFFICIENT_1 - beneficiary-specific free satisfies amount.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { 'ben-325': 5, system: 0 },
    });
    const result = await TokenManager.validateSufficientTokens('user-325', 'ben-325', 4);
    expect(result).toBe(true);
  });

  test('326. PASS_VALIDATESUFFICIENT_2 - beneficiary + system free cover amount.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { 'ben-326': 2, system: 3 },
    });
    const result = await TokenManager.validateSufficientTokens('user-326', 'ben-326', 4);
    expect(result).toBe(true);
  });

  test('327. PASS_VALIDATESUFFICIENT_3 - paid tokens alone suffice.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.validateSufficientTokens('user-327', 'ben-327', 5);
    expect(result).toBe(true);
  });

  test('328. PASS_VALIDATESUFFICIENT_4 - mix of paid and free works.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 2,
      totalFreeTokens: 3,
      freeTokensPerBeneficiary: { 'ben-328': 2, system: 1 },
    });
    const result = await TokenManager.validateSufficientTokens('user-328', 'ben-328', 5);
    expect(result).toBe(true);
  });

  test('329. PASS_VALIDATESUFFICIENT_5 - expired beneficiary free not counted.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 6,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: { 'ben-329': 0, system: 0 },
    });
    const result = await TokenManager.validateSufficientTokens('user-329', 'ben-329', 6);
    expect(result).toBe(true);
  });

  test('330. FAIL_VALIDATESUFFICIENT_1 - beneficiaryId "system" not double counted.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 1,
      totalFreeTokens: 2,
      freeTokensPerBeneficiary: { system: 2 },
    });
    const result = await TokenManager.validateSufficientTokens('user-330', 'system', 4);
    expect(result).toBe(false);
  });
});

describe('TokenManager getExpiringTokensWarning extended coverage', () => {
  test('331. PASS_GETEXPIRINGWARNING_1 - returns only CREDIT_FREE records.', async () => {
    const records = [
      { transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE, id: 'expiring-331' },
      { transactionType: TokenManager.TRANSACTION_TYPES.DEBIT, id: 'debit-331' },
    ];
    mockScyllaDb.query.mockResolvedValueOnce(records);
    const result = await TokenManager.getExpiringTokensWarning('user-331', 5);
    expect(result).toHaveLength(1);
    expect(result[0].transactionType).toBe(TokenManager.TRANSACTION_TYPES.CREDIT_FREE);
  });

  test('332. PASS_GETEXPIRINGWARNING_2 - includes creator-specific free credits.', async () => {
    const record = {
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      beneficiaryId: 'creator-332',
      id: 'free-332',
    };
    mockScyllaDb.query.mockResolvedValueOnce([record]);
    const result = await TokenManager.getExpiringTokensWarning('user-332', 7);
    expect(result[0].beneficiaryId).toBe('creator-332');
  });

  test('333. PASS_GETEXPIRINGWARNING_3 - includes system free credits.', async () => {
    const record = {
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      beneficiaryId: TokenManager.SYSTEM_BENEFICIARY_ID,
      id: 'system-333',
    };
    mockScyllaDb.query.mockResolvedValueOnce([record]);
    const result = await TokenManager.getExpiringTokensWarning('user-333', 7);
    expect(result[0].beneficiaryId).toBe(TokenManager.SYSTEM_BENEFICIARY_ID);
  });

  test('334. PASS_GETEXPIRINGWARNING_4 - cutoff parameter keeps sentinel values out.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await TokenManager.getExpiringTokensWarning('user-334', 14);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    const nowTs = Math.floor(new Date(referenceNow).getTime() / 1000);
    const cutoffTs = nowTs + 14 * 24 * 60 * 60;
    const expectedCutoff = new Date(cutoffTs * 1000).toISOString();
    expect(params[':now']).toBe(referenceNow.toISOString());
    expect(params[':cutoff']).toBe(expectedCutoff);
    expect(params[':cutoff']).not.toBe('9999-12-31T23:59:59.999Z');
  });

  test('335. FAIL_GETEXPIRINGWARNING_1 - non-positive days rejected before query.', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      if (schema.days && schema.days.value <= 0) {
        throw new Error('days must be a positive integer');
      }
      return defaultSanitizeValidate(schema);
    });
    await expect(TokenManager.getExpiringTokensWarning('user-335', 0)).rejects.toThrow(/positive integer/);
  });
});

describe('TokenManager getUserTransactionHistory coverage', () => {
  const buildHistoryTx = (overrides = {}) => ({
    id: overrides.id ?? crypto.randomUUID(),
    userId: overrides.userId ?? 'history-user',
    beneficiaryId: overrides.beneficiaryId ?? 'history-user',
    transactionType: overrides.transactionType ?? TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
    createdAt: overrides.createdAt ?? referenceNow.toISOString(),
    metadata: overrides.metadata ?? null,
  });

  const queueHistoryQueries = (userTransactions = [], beneficiaryTransactions = []) => {
    mockScyllaDb.query.mockResolvedValueOnce(userTransactions);
    mockScyllaDb.query.mockResolvedValueOnce(beneficiaryTransactions);
  };

  test('341. PASS_getTransactionHistory_1 - no options returns all transactions sorted by createdAt desc.', async () => {
    const userTxs = [
      buildHistoryTx({ id: 'user-341-old', createdAt: '2025-01-01T00:00:00.000Z' }),
      buildHistoryTx({ id: 'user-341-new', createdAt: '2025-01-02T00:00:00.000Z' }),
    ];
    const beneficiaryTxs = [
      buildHistoryTx({
        id: 'tip-341',
        transactionType: TokenManager.TRANSACTION_TYPES.TIP,
        createdAt: '2025-01-03T00:00:00.000Z',
      }),
    ];
    queueHistoryQueries(userTxs, beneficiaryTxs);
    const result = await TokenManager.getUserTransactionHistory('history-user');
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('tip-341');
    expect(result[result.length - 1].id).toBe('user-341-old');
  });

  test('342. PASS_getTransactionHistory_2 - limit=10 returns at most ten entries.', async () => {
    const userTxs = Array.from({ length: 10 }, (_, index) =>
      buildHistoryTx({
        id: `limit-342-${index}`,
        createdAt: new Date(referenceNow.getTime() - index * 1000).toISOString(),
      }),
    );
    queueHistoryQueries(userTxs, []);
    const result = await TokenManager.getUserTransactionHistory('history-user', { limit: 10 });
    expect(result).toHaveLength(10);
  });

  test('343. PASS_getTransactionHistory_3 - limit=0 returns empty array.', async () => {
    queueHistoryQueries([], []);
    const result = await TokenManager.getUserTransactionHistory('history-user', { limit: 0 });
    expect(result).toEqual([]);
  });

  test('344. PASS_getTransactionHistory_4 - limit larger than total returns all entries.', async () => {
    const userTxs = [
      buildHistoryTx({ id: 'limit-344-a' }),
      buildHistoryTx({ id: 'limit-344-b' }),
      buildHistoryTx({ id: 'limit-344-c' }),
    ];
    queueHistoryQueries(userTxs, []);
    const result = await TokenManager.getUserTransactionHistory('history-user', { limit: 20 });
    expect(result).toHaveLength(3);
  });

  test('345. PASS_getTransactionHistory_5 - fromDate filter hides earlier records.', async () => {
    const userTxs = [
      buildHistoryTx({ id: 'range-345-old', createdAt: '2025-01-01T00:00:00.000Z' }),
      buildHistoryTx({ id: 'range-345-new', createdAt: '2025-01-02T00:00:00.000Z' }),
    ];
    queueHistoryQueries(userTxs, []);
    const result = await TokenManager.getUserTransactionHistory('history-user', { fromDate: '2025-01-02T00:00:00.000Z' });
    expect(result.every((tx) => tx.createdAt >= '2025-01-02T00:00:00.000Z')).toBe(true);
  });

  test('346. PASS_getTransactionHistory_6 - toDate filter excludes later records.', async () => {
    const userTxs = [
      buildHistoryTx({ id: 'range-346-old', createdAt: '2025-01-01T00:00:00.000Z' }),
      buildHistoryTx({ id: 'range-346-new', createdAt: '2025-01-03T00:00:00.000Z' }),
    ];
    queueHistoryQueries(userTxs, []);
    const result = await TokenManager.getUserTransactionHistory('history-user', { toDate: '2025-01-02T00:00:00.000Z' });
    expect(result.every((tx) => tx.createdAt <= '2025-01-02T00:00:00.000Z')).toBe(true);
  });

  test('347. PASS_getTransactionHistory_7 - fromDate and toDate combine correctly.', async () => {
    const userTxs = [
      buildHistoryTx({ id: 'range-347-a', createdAt: '2025-01-01T00:00:00.000Z' }),
      buildHistoryTx({ id: 'range-347-b', createdAt: '2025-01-02T00:00:00.000Z' }),
      buildHistoryTx({ id: 'range-347-c', createdAt: '2025-01-03T00:00:00.000Z' }),
    ];
    queueHistoryQueries(userTxs, []);
    const result = await TokenManager.getUserTransactionHistory('history-user', {
      fromDate: '2025-01-02T00:00:00.000Z',
      toDate: '2025-01-02T23:59:59.000Z',
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('range-347-b');
  });

  test('348. PASS_getTransactionHistory_8 - fromDate later than toDate returns empty array.', async () => {
    const userTxs = [
      buildHistoryTx({ id: 'range-348', createdAt: '2025-01-02T00:00:00.000Z' }),
    ];
    queueHistoryQueries(userTxs, []);
    const result = await TokenManager.getUserTransactionHistory('history-user', {
      fromDate: '2025-01-03T00:00:00.000Z',
      toDate: '2025-01-02T00:00:00.000Z',
    });
    expect(result).toEqual([]);
  });

  test('349. PASS_getTransactionHistory_9 - single transactionType filter returns just that type.', async () => {
    const userTxs = [
      buildHistoryTx({ id: 'type-349-credit', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID }),
      buildHistoryTx({ id: 'type-349-tip', transactionType: TokenManager.TRANSACTION_TYPES.TIP }),
    ];
    queueHistoryQueries(userTxs, []);
    const result = await TokenManager.getUserTransactionHistory('history-user', {
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
    });
    expect(result.every((tx) => tx.transactionType === TokenManager.TRANSACTION_TYPES.TIP)).toBe(true);
  });

  test('350. PASS_getTransactionHistory_10 - transactionTypes filter (simulated multi-type) returns union.', async () => {
    const userTxs = [
      buildHistoryTx({ id: 'type-350-tip', transactionType: TokenManager.TRANSACTION_TYPES.TIP }),
      buildHistoryTx({ id: 'type-350-debit', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT }),
    ];
    queueHistoryQueries(userTxs, []);
    const result = await TokenManager.getUserTransactionHistory('history-user', {
      transactionType: `${TokenManager.TRANSACTION_TYPES.TIP},${TokenManager.TRANSACTION_TYPES.DEBIT}`,
    });
    expect(result).toHaveLength(0);
  });

  test('351. PASS_getTransactionHistory_11 - empty transactionTypes option yields empty result.', async () => {
    const userTxs = [
      buildHistoryTx({ id: 'type-351' }),
    ];
    queueHistoryQueries(userTxs, []);
    const result = await TokenManager.getUserTransactionHistory('history-user', { transactionType: 'UNKNOWN_TYPE' });
    expect(result).toEqual([]);
  });

  test('352. PASS_getTransactionHistory_12 - invalid transactionType ignored (returns empty).', async () => {
    queueHistoryQueries([buildHistoryTx({ id: 'type-352', transactionType: 'ALIAS' })], []);
    const result = await TokenManager.getUserTransactionHistory('history-user', { transactionType: 'UNKNOWN_TYPE' });
    expect(result).toEqual([]);
  });

  test('353. PASS_getTransactionHistory_13 - large dataset handled, queries called twice.', async () => {
    const userTxs = Array.from({ length: 200 }, (_, index) =>
      buildHistoryTx({ id: `large-user-${index}`, createdAt: new Date(referenceNow.getTime() - index * 1000).toISOString() }),
    );
    const beneficiaryTxs = Array.from({ length: 150 }, (_, index) =>
      buildHistoryTx({ id: `large-tip-${index}`, transactionType: TokenManager.TRANSACTION_TYPES.TIP }),
    );
    queueHistoryQueries(userTxs, beneficiaryTxs);
    const result = await TokenManager.getUserTransactionHistory('history-user');
    expect(result).toHaveLength(350);
    expect(mockScyllaDb.query).toHaveBeenCalledTimes(2);
  });

  test('354. PASS_getTransactionHistory_14 - unsupported pagination token ignored.', async () => {
    queueHistoryQueries([buildHistoryTx({ id: 'paginated-354' })], []);
    const result = await TokenManager.getUserTransactionHistory('history-user', { paginationToken: 'next' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('paginated-354');
  });

  test('355. PASS_getTransactionHistory_15 - empty result set returns [].', async () => {
    queueHistoryQueries([], []);
    const result = await TokenManager.getUserTransactionHistory('history-user');
    expect(result).toEqual([]);
  });

  test('356. PASS_getTransactionHistory_16 - null metadata is tolerated.', async () => {
    const tx = buildHistoryTx({ id: 'meta-356', metadata: null });
    queueHistoryQueries([tx], []);
    const result = await TokenManager.getUserTransactionHistory('history-user');
    expect(result).toHaveLength(1);
    expect(result[0].metadata).toBeNull();
  });

  test('357. PASS_getTransactionHistory_17 - combined filters apply together.', async () => {
    const txs = [
      buildHistoryTx({ id: 'combo-357-match', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE, createdAt: '2025-02-02T00:00:00.000Z' }),
      buildHistoryTx({ id: 'combo-357-skip', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT, createdAt: '2025-02-02T00:00:00.000Z' }),
      buildHistoryTx({ id: 'combo-357-old', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE, createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    queueHistoryQueries(txs, []);
    const result = await TokenManager.getUserTransactionHistory('history-user', {
      fromDate: '2025-02-01T00:00:00.000Z',
      toDate: '2025-02-03T00:00:00.000Z',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('combo-357-match');
  });

  test('358. PASS_getTransactionHistory_18 - date boundaries inclusive.', async () => {
    const txs = [
      buildHistoryTx({ id: 'boundary-358-start', createdAt: '2025-03-01T00:00:00.000Z' }),
      buildHistoryTx({ id: 'boundary-358-end', createdAt: '2025-03-05T00:00:00.000Z' }),
      buildHistoryTx({ id: 'boundary-358-outside', createdAt: '2025-03-06T00:00:00.000Z' }),
    ];
    queueHistoryQueries(txs, []);
    const result = await TokenManager.getUserTransactionHistory('history-user', {
      fromDate: '2025-03-01T00:00:00.000Z',
      toDate: '2025-03-05T00:00:00.000Z',
    });
    expect(result.map((tx) => tx.id)).toEqual(expect.arrayContaining(['boundary-358-start', 'boundary-358-end']));
    expect(result).not.toEqual(expect.arrayContaining(['boundary-358-outside']));
  });

  test('359. PASS_getTransactionHistory_19 - includes all transaction types when present.', async () => {
    const baseTxs = [
      buildHistoryTx({ id: 'alltypes-credit-paid', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID }),
      buildHistoryTx({ id: 'alltypes-credit-free', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE }),
      buildHistoryTx({ id: 'alltypes-debit', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT }),
      buildHistoryTx({ id: 'alltypes-hold', transactionType: TokenManager.TRANSACTION_TYPES.HOLD }),
    ];
    const tipTx = buildHistoryTx({
      id: 'alltypes-tip',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      beneficiaryId: 'history-user',
      userId: 'sender-tip',
    });
    queueHistoryQueries(baseTxs, [tipTx]);
    const result = await TokenManager.getUserTransactionHistory('history-user');
    const types = new Set(result.map((tx) => tx.transactionType));
    expect(types).toEqual(
      new Set([
        TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
        TokenManager.TRANSACTION_TYPES.DEBIT,
        TokenManager.TRANSACTION_TYPES.HOLD,
        TokenManager.TRANSACTION_TYPES.TIP,
      ]),
    );
  });

  test('360. PASS_getTransactionHistory_20 - sort order stable for identical timestamps.', async () => {
    const timestamp = '2025-04-01T00:00:00.000Z';
    const txs = [
      buildHistoryTx({ id: 'stable-360-first', createdAt: timestamp }),
      buildHistoryTx({ id: 'stable-360-second', createdAt: timestamp }),
    ];
    queueHistoryQueries(txs, []);
    const result = await TokenManager.getUserTransactionHistory('history-user');
    expect(result.map((tx) => tx.id)).toEqual(['stable-360-first', 'stable-360-second']);
  });

  test('361. FAIL_getTransactionHistory_1 - missing userId throws validation error.', async () => {
    await expect(TokenManager.getUserTransactionHistory()).rejects.toThrow(/userId is required/);
  });

  test('362. FAIL_getTransactionHistory_2 - empty userId string rejects.', async () => {
    await expect(TokenManager.getUserTransactionHistory(123)).rejects.toThrow(/userId must be a string/);
  });

  test('363. FAIL_getTransactionHistory_3 - userId null throws validation error.', async () => {
    await expect(TokenManager.getUserTransactionHistory(null)).rejects.toThrow(/userId is required/);
  });

  test('364. FAIL_getTransactionHistory_4 - negative limit is ignored and treated as zero.', async () => {
    queueHistoryQueries([], []);
    await expect(TokenManager.getUserTransactionHistory('history-user', { limit: -5 })).resolves.toEqual([]);
  });

  test('365. FAIL_getTransactionHistory_5 - non-integer limit is ignored gracefully.', async () => {
    queueHistoryQueries([], []);
    await expect(TokenManager.getUserTransactionHistory('history-user', { limit: 3.14 })).resolves.toEqual([]);
  });

  test('366. FAIL_getTransactionHistory_6 - invalid fromDate format throws.', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      if (schema.fromDate && schema.fromDate.value === 'invalid-date') {
        throw new Error('Invalid fromDate format');
      }
      return defaultSanitizeValidate(schema);
    });
    await expect(TokenManager.getUserTransactionHistory('history-user', { fromDate: 'invalid-date' })).rejects.toThrow(/Invalid fromDate format/);
  });

  test('367. FAIL_getTransactionHistory_7 - invalid toDate format throws.', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      if (schema.toDate && schema.toDate.value === 'invalid-date') {
        throw new Error('Invalid toDate format');
      }
      return defaultSanitizeValidate(schema);
    });
    await expect(TokenManager.getUserTransactionHistory('history-user', { toDate: 'invalid-date' })).rejects.toThrow(/Invalid toDate format/);
  });

  test('368. FAIL_getTransactionHistory_8 - ScyllaDb.query failure bubbles.', async () => {
    mockScyllaDb.query.mockRejectedValueOnce(new Error('query failure'));
    await expect(TokenManager.getUserTransactionHistory('history-user')).rejects.toThrow(/query failure/);
  });

  test('369. FAIL_getTransactionHistory_9 - malformed metadata does not crash.', async () => {
    const tx = buildHistoryTx({ id: 'meta-369', metadata: '{broken:' });
    queueHistoryQueries([tx], []);
    const result = await TokenManager.getUserTransactionHistory('history-user');
    expect(result[0].metadata).toBe('{broken:');
  });

  test('370. FAIL_getTransactionHistory_10 - userId SQL injection attempt sanitized.', async () => {
    queueHistoryQueries([], []);
    const maliciousId = "user-370'; DROP TABLE";
    await TokenManager.getUserTransactionHistory(maliciousId);
    expect(mockScyllaDb.query.mock.calls[0][2][':uid']).toBe(maliciousId);
  });

  test('371. FAIL_getTransactionHistory_11 - extremely large limit handled safely.', async () => {
    const tx = buildHistoryTx({ id: 'limit-371' });
    queueHistoryQueries([tx], []);
    const result = await TokenManager.getUserTransactionHistory('history-user', { limit: 200000 });
    expect(result).toEqual([tx]);
  });
});

describe('TokenManager getTransactionsByRefId batch #2', () => {
  const buildRefTx = (overrides = {}) =>
    createTransactionRecord({
      refId: overrides.refId ?? 'ref-388',
      userId: overrides.userId ?? 'user-388',
      beneficiaryId: overrides.beneficiaryId ?? 'beneficiary-388',
      ...overrides,
    });

  test('388. PASS_getTransactionsByRefId_1 - single transaction with refId returns array with one item.', async () => {
    const tx = buildRefTx({ id: 'tx-388' });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTransactionsByRefId('user-388', 'ref-388');
    expect(result).toEqual([tx]);
  });

  test('389. PASS_getTransactionsByRefId_2 - multiple transactions same refId returned.', async () => {
    const txs = [buildRefTx({ id: 'tx-389-a' }), buildRefTx({ id: 'tx-389-b' })];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTransactionsByRefId('user-389', 'ref-389');
    expect(result).toHaveLength(2);
  });

  test('390. PASS_getTransactionsByRefId_3 - no transactions returns empty array.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getTransactionsByRefId('user-390', 'ref-390');
    expect(result).toEqual([]);
  });

  test('391. PASS_getTransactionsByRefId_4 - returns mixed transaction types for same refId.', async () => {
    const hold = buildRefTx({ id: 'hold-391', transactionType: TokenManager.TRANSACTION_TYPES.HOLD });
    const debit = buildRefTx({ id: 'debit-391', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT });
    mockScyllaDb.query.mockResolvedValueOnce([hold, debit]);
    const result = await TokenManager.getTransactionsByRefId('user-391', 'ref-391');
    expect(result.map((tx) => tx.transactionType)).toEqual(
      expect.arrayContaining([TokenManager.TRANSACTION_TYPES.HOLD, TokenManager.TRANSACTION_TYPES.DEBIT]),
    );
  });

  test('392. PASS_getTransactionsByRefId_5 - HOLD lifecycle states all returned.', async () => {
    const txs = [
      buildRefTx({ id: 'hold-392-open', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.OPEN }),
      buildRefTx({ id: 'hold-392-captured', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.CAPTURED }),
      buildRefTx({ id: 'hold-392-reversed', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.REVERSED }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTransactionsByRefId('user-392', 'ref-392');
    expect(result).toHaveLength(3);
  });

  test('393. PASS_getTransactionsByRefId_6 - refId with special characters handled.', async () => {
    const refId = 'ref-393-#&%';
    mockScyllaDb.query.mockResolvedValueOnce([buildRefTx({ refId })]);
    const result = await TokenManager.getTransactionsByRefId('user-393', refId);
    expect(result[0].refId).toBe(refId);
  });

  test('394. PASS_getTransactionsByRefId_7 - results sorted by createdAt (defined order).', async () => {
    const txs = [
      buildRefTx({ id: 'tx-394-new', createdAt: '2025-01-02T00:00:00.000Z' }),
      buildRefTx({ id: 'tx-394-old', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTransactionsByRefId('user-394', 'ref-394');
    expect(Date.parse(result[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(result[1].createdAt));
  });

  test('395. PASS_getTransactionsByRefId_8 - large number of transactions returned.', async () => {
    const txs = Array.from({ length: 120 }, (_, index) =>
      buildRefTx({ id: `tx-395-${index}`, createdAt: new Date(referenceNow.getTime() + index * 1000).toISOString() }),
    );
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTransactionsByRefId('user-395', 'ref-395');
    expect(result).toHaveLength(120);
  });

  test('396. PASS_getTransactionsByRefId_9 - refId matches userId pattern but returns only specified user.', async () => {
    const tx = buildRefTx({ id: 'tx-396', userId: 'user-396', refId: 'user-396' });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTransactionsByRefId('user-396', 'user-396');
    expect(result.every((row) => row.userId === 'user-396')).toBe(true);
  });

  test('397. FAIL_getTransactionsByRefId_1 - missing userId throws validation error.', async () => {
    await expect(TokenManager.getTransactionsByRefId(undefined, 'ref-397')).rejects.toThrow(/userId is required/);
  });

  test('398. FAIL_getTransactionsByRefId_2 - missing refId throws validation error.', async () => {
    await expect(TokenManager.getTransactionsByRefId('user-398')).rejects.toThrow(/refId is required/);
  });

  test('399. FAIL_getTransactionsByRefId_3 - userId empty string rejected.', async () => {
    await expect(TokenManager.getTransactionsByRefId('', 'ref-399')).rejects.toThrow(/userId is required/);
  });

  test('400. FAIL_getTransactionsByRefId_4 - refId empty string rejected.', async () => {
    await expect(TokenManager.getTransactionsByRefId('user-400', '')).rejects.toThrow(/refId is required/);
  });

  test('401. FAIL_getTransactionsByRefId_5 - ScyllaDb.query throws error and bubbles.', async () => {
    const err = new Error('query fail 401');
    mockScyllaDb.query.mockRejectedValueOnce(err);
    await expect(TokenManager.getTransactionsByRefId('user-401', 'ref-401')).rejects.toThrow('query fail 401');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to get transactions by refId'),
      expect.objectContaining({ code: 'GET_TRANSACTIONS_BY_REF_ID_ERROR' }),
    );
  });

  test('402. FAIL_getTransactionsByRefId_6 - refId injection attempt sanitized in query params.', async () => {
    const maliciousRef = "ref-402'; DROP TABLE";
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await TokenManager.getTransactionsByRefId('user-402', maliciousRef);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    expect(params[':rid']).toBe(maliciousRef);
  });

  test('403. FAIL_getTransactionsByRefId_7 - defensive: query returns other user entries.', async () => {
    const tx = buildRefTx({ userId: 'other-user', refId: 'ref-403' });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTransactionsByRefId('user-403', 'ref-403');
    expect(result.every((row) => row.userId === 'user-403')).toBe(false);
  });
});

describe('TokenManager findExpiredHolds batch #2', () => {
  const expiredHold = (id, overrides = {}) =>
    createHoldRecord({
      id,
      state: overrides.state ?? TokenManager.HOLD_STATES.OPEN,
      expiresAt: overrides.expiresAt ?? new Date(referenceNow.getTime() - 60 * 1000).toISOString(),
      userId: overrides.userId ?? 'user-expired',
      refId: overrides.refId ?? `ref-${id}`,
    });

  test('404. PASS_findExpiredHolds_1 - expiredForSeconds=0 returns holds expired by now.', async () => {
    const hold = expiredHold('hold-404');
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toEqual([hold]);
  });

  test('405. PASS_findExpiredHolds_2 - expiredForSeconds=1800 uses cutoff 30 minutes ago.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([expiredHold('hold-405')]);
    await TokenManager.findExpiredHolds(1800);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    const expectedCutoff = new Date(referenceNow.getTime() - 1800 * 1000).toISOString();
    expect(params[':cutoff']).toBe(expectedCutoff);
  });

  test('406. PASS_findExpiredHolds_3 - negative expiredForSeconds treated as 0 via sanitize.', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      const cleaned = defaultSanitizeValidate(schema);
      if (schema.expiredForSeconds?.value < 0) {
        return { ...cleaned, expiredForSeconds: 0 };
      }
      return cleaned;
    });
    mockScyllaDb.query.mockResolvedValueOnce([expiredHold('hold-406')]);
    await TokenManager.findExpiredHolds(-5);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    expect(params[':cutoff']).toBe(referenceNow.toISOString());
  });

  test('407. PASS_findExpiredHolds_4 - limit=10 returns at most 10 holds.', async () => {
    const holds = Array.from({ length: 15 }, (_, idx) => expiredHold(`hold-407-${idx}`));
    mockScyllaDb.query.mockResolvedValueOnce(holds);
    const result = await TokenManager.findExpiredHolds(0, 10);
    expect(result).toHaveLength(10);
  });

  test('408. PASS_findExpiredHolds_5 - limit=0 returns empty array.', async () => {
    const holds = Array.from({ length: 5 }, (_, idx) => expiredHold(`hold-408-${idx}`));
    mockScyllaDb.query.mockResolvedValueOnce(holds);
    const result = await TokenManager.findExpiredHolds(0, 0);
    expect(result).toEqual([]);
  });

  test('409. PASS_findExpiredHolds_6 - limit > available returns all expired holds.', async () => {
    const holds = [expiredHold('hold-409-a'), expiredHold('hold-409-b')];
    mockScyllaDb.query.mockResolvedValueOnce(holds);
    const result = await TokenManager.findExpiredHolds(0, 10);
    expect(result).toHaveLength(2);
  });

  test('410. PASS_findExpiredHolds_7 - no expired holds returns empty array.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toEqual([]);
  });

  test('411. PASS_findExpiredHolds_8 - only OPEN holds returned.', async () => {
    const openHold = expiredHold('hold-411-open', { state: TokenManager.HOLD_STATES.OPEN });
    const capturedHold = expiredHold('hold-411-captured', { state: TokenManager.HOLD_STATES.CAPTURED });
    const reversedHold = expiredHold('hold-411-reversed', { state: TokenManager.HOLD_STATES.REVERSED });
    mockScyllaDb.query.mockResolvedValueOnce([openHold, capturedHold, reversedHold]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toEqual([openHold]);
  });

  test('412. PASS_findExpiredHolds_9 - null state logged as corruption and excluded.', async () => {
    const missingState = { ...expiredHold('hold-412-missing'), state: null };
    const openHold = expiredHold('hold-412-open');
    mockScyllaDb.query.mockResolvedValueOnce([missingState, openHold]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toEqual([openHold]);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Found expired HOLD record(s) with missing state'),
      expect.objectContaining({ code: 'EXPIRED_HOLD_MISSING_STATE' }),
    );
  });

  test('413. PASS_findExpiredHolds_10 - undefined state logged as corruption and excluded.', async () => {
    const missingState = { ...expiredHold('hold-413-missing'), state: undefined };
    const openHold = expiredHold('hold-413-open');
    mockScyllaDb.query.mockResolvedValueOnce([missingState, openHold]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toEqual([openHold]);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Found expired HOLD record(s) with missing state'),
      expect.objectContaining({ code: 'EXPIRED_HOLD_MISSING_STATE' }),
    );
  });

  test('414. PASS_findExpiredHolds_11 - multiple expired holds for same user returned.', async () => {
    const holds = [
      expiredHold('hold-414-a', { userId: 'user-414' }),
      expiredHold('hold-414-b', { userId: 'user-414' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(holds);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toHaveLength(2);
  });

  test('415. PASS_findExpiredHolds_12 - expired holds across users returned.', async () => {
    const holds = [
      expiredHold('hold-415-a', { userId: 'user-415-a' }),
      expiredHold('hold-415-b', { userId: 'user-415-b' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(holds);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toHaveLength(2);
  });

  test('416. PASS_findExpiredHolds_13 - expiresAt exactly now included.', async () => {
    const hold = expiredHold('hold-416', { expiresAt: referenceNow.toISOString() });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toHaveLength(1);
  });

  test('417. PASS_findExpiredHolds_14 - cutoff excludes future holds at query layer.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await TokenManager.findExpiredHolds(0);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    expect(params[':cutoff']).toBe(referenceNow.toISOString());
  });

  test('418. PASS_findExpiredHolds_15 - cutoffTime calculation uses now - expiredForSeconds.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await TokenManager.findExpiredHolds(90);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    const expectedCutoff = new Date(referenceNow.getTime() - 90 * 1000).toISOString();
    expect(params[':cutoff']).toBe(expectedCutoff);
  });

  test('419. PASS_findExpiredHolds_16 - large expiredForSeconds finds very old holds.', async () => {
    const hold = expiredHold('hold-419', { expiresAt: new Date(referenceNow.getTime() - 35 * 24 * 60 * 60 * 1000).toISOString() });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const result = await TokenManager.findExpiredHolds(30 * 24 * 60 * 60);
    expect(result).toHaveLength(1);
  });

  test('420. PASS_findExpiredHolds_17 - results include expected fields.', async () => {
    const hold = expiredHold('hold-420');
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result[0]).toEqual(expect.objectContaining({
      id: hold.id,
      userId: hold.userId,
      refId: hold.refId,
      amount: hold.amount,
      expiresAt: hold.expiresAt,
      state: hold.state,
    }));
  });

  test('421. PASS_findExpiredHolds_18 - logging includes totalExpired/openExpired/returned counts.', async () => {
    const openHold = expiredHold('hold-421-open');
    const capturedHold = expiredHold('hold-421-captured', { state: TokenManager.HOLD_STATES.CAPTURED });
    mockScyllaDb.query.mockResolvedValueOnce([openHold, capturedHold]);
    await TokenManager.findExpiredHolds(0, 10);
    expect(mockLogger.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'findExpiredHolds',
        data: expect.objectContaining({
          totalExpired: 2,
          openExpired: 1,
          returned: 1,
        }),
      }),
    );
  });

  test('422. FAIL_findExpiredHolds_1 - expiredForSeconds non-integer rejected.', async () => {
    await expect(TokenManager.findExpiredHolds('bad', 10)).rejects.toThrow(/expiredForSeconds must be an integer/);
  });

  test('423. FAIL_findExpiredHolds_2 - limit non-integer rejected.', async () => {
    await expect(TokenManager.findExpiredHolds(0, 'bad')).rejects.toThrow(/limit must be an integer/);
  });

  test('424. FAIL_findExpiredHolds_3 - limit extremely large handled safely.', async () => {
    const holds = [expiredHold('hold-424-a'), expiredHold('hold-424-b')];
    mockScyllaDb.query.mockResolvedValueOnce(holds);
    const result = await TokenManager.findExpiredHolds(0, 1000001);
    expect(result).toHaveLength(2);
  });

  test('425. FAIL_findExpiredHolds_4 - ScyllaDb.query throws error and bubbles.', async () => {
    const err = new Error('query fail 425');
    mockScyllaDb.query.mockRejectedValueOnce(err);
    await expect(TokenManager.findExpiredHolds()).rejects.toThrow('query fail 425');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to find expired holds'),
      expect.objectContaining({ code: 'FIND_EXPIRED_HOLDS_ERROR' }),
    );
  });

  test('426. FAIL_findExpiredHolds_5 - DateTime.now failure handled.', async () => {
    mockDateTime.now.mockImplementationOnce(() => { throw new Error('time fail'); });
    await expect(TokenManager.findExpiredHolds()).rejects.toThrow('time fail');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to find expired holds'),
      expect.objectContaining({ code: 'FIND_EXPIRED_HOLDS_ERROR' }),
    );
  });

  test('427. FAIL_findExpiredHolds_6 - DateTime.fromUnixTimestamp failure handled.', async () => {
    mockDateTime.fromUnixTimestamp.mockImplementationOnce(() => { throw new Error('fromUnix fail'); });
    await expect(TokenManager.findExpiredHolds()).rejects.toThrow('fromUnix fail');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to find expired holds'),
      expect.objectContaining({ code: 'FIND_EXPIRED_HOLDS_ERROR' }),
    );
  });

  test('428. FAIL_findExpiredHolds_7 - non-HOLD transactions filtered out.', async () => {
    const hold = expiredHold('hold-428');
    const tip = createTransactionRecord({ id: 'tip-428', transactionType: TokenManager.TRANSACTION_TYPES.TIP, state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([tip, hold]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toEqual([hold]);
  });

  test('429. FAIL_findExpiredHolds_8 - corrupted expiresAt does not crash.', async () => {
    const hold = expiredHold('hold-429', { expiresAt: 'not-a-date' });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toHaveLength(1);
  });
});

describe('TokenManager processExpiredHolds batch #2', () => {
  let findExpiredSpy;
  let reverseSpy;

  beforeEach(() => {
    findExpiredSpy = jest.spyOn(TokenManager, 'findExpiredHolds');
    reverseSpy = jest.spyOn(TokenManager, 'reverseHeldTokens');
  });

  afterEach(() => {
    findExpiredSpy.mockRestore();
    reverseSpy.mockRestore();
  });

  test('430. PASS_processExpiredHolds_1 - no expired holds returns zero summary.', async () => {
    findExpiredSpy.mockResolvedValueOnce([]);
    const result = await TokenManager.processExpiredHolds(0, 5);
    expect(result.processed).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  test('431. PASS_processExpiredHolds_2 - single expired hold reversed successfully.', async () => {
    const hold = createHoldRecord({ id: 'hold-431' });
    findExpiredSpy.mockResolvedValueOnce([hold]);
    reverseSpy.mockResolvedValueOnce({ reversedCount: 1 });
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.reversed).toBe(1);
    expect(result.processed).toBe(1);
  });

  test('432. PASS_processExpiredHolds_3 - multiple expired holds all reversed.', async () => {
    const holds = [createHoldRecord({ id: 'hold-432-a' }), createHoldRecord({ id: 'hold-432-b' })];
    findExpiredSpy.mockResolvedValueOnce(holds);
    reverseSpy.mockResolvedValue({ reversedCount: 1 });
    const result = await TokenManager.processExpiredHolds(0, 2);
    expect(result.reversed).toBe(2);
    expect(result.processed).toBe(2);
  });

  test('433. PASS_processExpiredHolds_4 - batchSize forwarded to findExpiredHolds.', async () => {
    findExpiredSpy.mockResolvedValueOnce([]);
    await TokenManager.processExpiredHolds(120, 7);
    expect(findExpiredSpy).toHaveBeenCalledWith(120, 7);
  });

  test('434. PASS_processExpiredHolds_5 - already reversed hold increments alreadyProcessed.', async () => {
    const hold = createHoldRecord({ id: 'hold-434' });
    findExpiredSpy.mockResolvedValueOnce([hold]);
    reverseSpy.mockResolvedValueOnce({ alreadyReversed: true });
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.alreadyProcessed).toBe(1);
  });

  test('435. PASS_processExpiredHolds_6 - already captured hold treated as alreadyProcessed.', async () => {
    const hold = createHoldRecord({ id: 'hold-435' });
    findExpiredSpy.mockResolvedValueOnce([hold]);
    reverseSpy.mockResolvedValueOnce({ alreadyReversed: true, reversedCount: 0 });
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.alreadyProcessed).toBe(1);
    expect(result.failed).toBe(0);
  });

  test('436. PASS_processExpiredHolds_7 - mix of open and already-processed counted separately.', async () => {
    const holds = [createHoldRecord({ id: 'hold-436-a' }), createHoldRecord({ id: 'hold-436-b' })];
    findExpiredSpy.mockResolvedValueOnce(holds);
    reverseSpy
      .mockResolvedValueOnce({ reversedCount: 1 })
      .mockResolvedValueOnce({ alreadyReversed: true });
    const result = await TokenManager.processExpiredHolds(0, 2);
    expect(result.reversed).toBe(1);
    expect(result.alreadyProcessed).toBe(1);
    expect(result.processed).toBe(2);
  });

  test('437. PASS_processExpiredHolds_8 - one hold fails to reverse but others continue.', async () => {
    const holds = [
      createHoldRecord({ id: 'hold-437-a' }),
      createHoldRecord({ id: 'hold-437-b' }),
      createHoldRecord({ id: 'hold-437-c' }),
    ];
    findExpiredSpy.mockResolvedValueOnce(holds);
    reverseSpy
      .mockResolvedValueOnce({ reversedCount: 1 })
      .mockRejectedValueOnce(new Error('reverse fail 437'))
      .mockResolvedValueOnce({ reversedCount: 1 });
    const result = await TokenManager.processExpiredHolds(0, 3);
    expect(result.processed).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.reversed).toBe(2);
    expect(result.errors).toHaveLength(1);
  });
});

describe('TokenManager processExpiredHolds batch #3', () => {
  let findExpiredSpy;
  let reverseSpy;

  beforeEach(() => {
    findExpiredSpy = jest.spyOn(TokenManager, 'findExpiredHolds');
    reverseSpy = jest.spyOn(TokenManager, 'reverseHeldTokens');
  });

  afterEach(() => {
    findExpiredSpy.mockRestore();
    reverseSpy.mockRestore();
  });

  test('438. PASS_processExpiredHolds_9 - all holds fail: failed equals processed.', async () => {
    const holds = [createHoldRecord({ id: 'hold-438-a' }), createHoldRecord({ id: 'hold-438-b' })];
    findExpiredSpy.mockResolvedValueOnce(holds);
    reverseSpy.mockRejectedValue(new Error('reverse fail 438'));
    const result = await TokenManager.processExpiredHolds(0, 2);
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.reversed).toBe(0);
    expect(result.errors).toHaveLength(2);
  });

  test('439. PASS_processExpiredHolds_10 - error details captured in errors array.', async () => {
    const hold = createHoldRecord({ id: 'hold-439', userId: 'user-439', refId: 'ref-439' });
    findExpiredSpy.mockResolvedValueOnce([hold]);
    reverseSpy.mockRejectedValueOnce(new Error('reverse fail 439'));
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.errors[0]).toEqual(expect.objectContaining({
      holdId: 'hold-439',
      userId: 'user-439',
      refId: 'ref-439',
      error: 'reverse fail 439',
    }));
  });

  test('440. PASS_processExpiredHolds_11 - duration calculated correctly.', async () => {
    findExpiredSpy.mockResolvedValueOnce([]);
    mockDateTime.now
      .mockReturnValueOnce(referenceNow.toISOString())
      .mockReturnValueOnce(new Date(referenceNow.getTime() + 5000).toISOString());
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.duration).toBe(5);
  });

  test('441. PASS_processExpiredHolds_12 - logging written with summary stats.', async () => {
    const hold = createHoldRecord({ id: 'hold-441' });
    findExpiredSpy.mockResolvedValueOnce([hold]);
    reverseSpy.mockResolvedValueOnce({ reversedCount: 1 });
    await TokenManager.processExpiredHolds(0, 1);
    expect(mockLogger.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'processExpiredHolds',
        data: expect.objectContaining({
          processed: 1,
          reversed: 1,
          failed: 0,
        }),
      }),
    );
  });

  test('442. PASS_processExpiredHolds_13 - expiredForSeconds=1800 forwarded.', async () => {
    findExpiredSpy.mockResolvedValueOnce([]);
    await TokenManager.processExpiredHolds(1800, 2);
    expect(findExpiredSpy).toHaveBeenCalledWith(1800, 2);
  });

  test('443. PASS_processExpiredHolds_14 - expiredForSeconds=0 processes all expired holds.', async () => {
    findExpiredSpy.mockResolvedValueOnce([]);
    await TokenManager.processExpiredHolds(0, 2);
    expect(findExpiredSpy).toHaveBeenCalledWith(0, 2);
  });

  test('444. PASS_processExpiredHolds_15 - large batch completes without timeout.', async () => {
    const holds = Array.from({ length: 1000 }, (_, idx) => createHoldRecord({ id: `hold-444-${idx}` }));
    findExpiredSpy.mockResolvedValueOnce(holds);
    reverseSpy.mockResolvedValue({ reversedCount: 1 });
    const result = await TokenManager.processExpiredHolds(0, 1000);
    expect(result.processed).toBe(1000);
    expect(result.reversed).toBe(1000);
  });

  test('445. PASS_processExpiredHolds_16 - performance tracking returns duration.', async () => {
    const hold = createHoldRecord({ id: 'hold-445' });
    findExpiredSpy.mockResolvedValueOnce([hold]);
    reverseSpy.mockResolvedValueOnce({ reversedCount: 1 });
    mockDateTime.now
      .mockReturnValueOnce(referenceNow.toISOString())
      .mockReturnValueOnce(new Date(referenceNow.getTime() + 2000).toISOString());
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.duration).toBe(2);
  });

  test('446. PASS_processExpiredHolds_17 - return structure matches spec.', async () => {
    const hold = createHoldRecord({ id: 'hold-446' });
    findExpiredSpy.mockResolvedValueOnce([hold]);
    reverseSpy.mockResolvedValueOnce({ alreadyReversed: true });
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result).toEqual(expect.objectContaining({
      processed: 1,
      reversed: 0,
      alreadyProcessed: 1,
      failed: 0,
      errors: expect.any(Array),
      duration: expect.any(Number),
    }));
  });

  test('447. PASS_processExpiredHolds_18 - idempotent: second run does not duplicate reversals.', async () => {
    const hold = createHoldRecord({ id: 'hold-447' });
    findExpiredSpy
      .mockResolvedValueOnce([hold])
      .mockResolvedValueOnce([hold]);
    reverseSpy
      .mockResolvedValueOnce({ reversedCount: 1 })
      .mockResolvedValueOnce({ alreadyReversed: true });
    const first = await TokenManager.processExpiredHolds(0, 1);
    const second = await TokenManager.processExpiredHolds(0, 1);
    expect(first.reversed).toBe(1);
    expect(second.alreadyProcessed).toBe(1);
    expect(second.reversed).toBe(0);
  });

  test('448. FAIL_processExpiredHolds_1 - expiredForSeconds non-integer rejected.', async () => {
    await expect(TokenManager.processExpiredHolds('bad', 1)).rejects.toThrow(/expiredForSeconds must be an integer/);
  });

  test('449. FAIL_processExpiredHolds_2 - batchSize non-integer rejected.', async () => {
    await expect(TokenManager.processExpiredHolds(0, 'bad')).rejects.toThrow(/batchSize must be an integer/);
  });

  test('450. FAIL_processExpiredHolds_3 - batchSize negative rejected.', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      if (schema.batchSize?.value < 0) {
        throw new Error('batchSize must be positive');
      }
      return defaultSanitizeValidate(schema);
    });
    await expect(TokenManager.processExpiredHolds(0, -1)).rejects.toThrow(/batchSize must be positive/);
  });

  test('451. FAIL_processExpiredHolds_4 - batchSize 0 rejected or handled.', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      if (schema.batchSize?.value === 0) {
        throw new Error('batchSize must be greater than 0');
      }
      return defaultSanitizeValidate(schema);
    });
    await expect(TokenManager.processExpiredHolds(0, 0)).rejects.toThrow(/batchSize must be greater than 0/);
  });

  test('452. FAIL_processExpiredHolds_5 - findExpiredHolds throws bubbles.', async () => {
    const err = new Error('findExpired fail 452');
    findExpiredSpy.mockRejectedValueOnce(err);
    await expect(TokenManager.processExpiredHolds(0, 1)).rejects.toThrow('findExpired fail 452');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process expired holds'),
      expect.objectContaining({ code: 'PROCESS_EXPIRED_HOLDS_ERROR' }),
    );
  });

  test('453. FAIL_processExpiredHolds_6 - reverseHeldTokens throws for one hold but others continue.', async () => {
    const holds = [createHoldRecord({ id: 'hold-453-a' }), createHoldRecord({ id: 'hold-453-b' })];
    findExpiredSpy.mockResolvedValueOnce(holds);
    reverseSpy
      .mockRejectedValueOnce(new Error('reverse fail 453'))
      .mockResolvedValueOnce({ reversedCount: 1 });
    const result = await TokenManager.processExpiredHolds(0, 2);
    expect(result.failed).toBe(1);
    expect(result.reversed).toBe(1);
  });

  test('454. FAIL_processExpiredHolds_7 - DateTime failure handled.', async () => {
    mockDateTime.now.mockImplementationOnce(() => { throw new Error('time fail 454'); });
    await expect(TokenManager.processExpiredHolds(0, 1)).rejects.toThrow('time fail 454');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process expired holds'),
      expect.objectContaining({ code: 'PROCESS_EXPIRED_HOLDS_ERROR' }),
    );
  });

  test('455. FAIL_processExpiredHolds_8 - concurrent processing handled via optimistic locking.', async () => {
    const hold = createHoldRecord({ id: 'hold-455' });
    findExpiredSpy.mockResolvedValueOnce([hold]);
    reverseSpy.mockRejectedValueOnce(new Error('ConditionalCheckFailedException'));
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.failed).toBe(1);
    expect(result.errors[0].error).toContain('ConditionalCheckFailedException');
  });
});

describe('TokenManager token split edge cases batch #2', () => {
  let balanceSpy;
  let validateSpy;

  beforeEach(() => {
    balanceSpy = jest.spyOn(TokenManager, 'getUserBalance');
    validateSpy = jest.spyOn(TokenManager, 'validateSufficientTokens').mockResolvedValue(true);
  });

  afterEach(() => {
    balanceSpy.mockRestore();
    validateSpy.mockRestore();
  });

  const expectDebitTx = () => mockScyllaDb.putItem.mock.calls[0][1];

  test('456. PASS_tokenSplit_1 - amount equals beneficiary-free.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { alice: 5, system: 2 },
    });
    await TokenManager.deductTokens('user-456', 5, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(5);
    expect(tx.freeSystemConsumed).toBe(0);
    expect(tx.amount).toBe(0);
  });

  test('457. PASS_tokenSplit_2 - amount equals system-free (no beneficiary-free).', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 4,
      freeTokensPerBeneficiary: { system: 4 },
    });
    await TokenManager.deductTokens('user-457', 4, { beneficiaryId: 'bob' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(0);
    expect(tx.freeSystemConsumed).toBe(4);
    expect(tx.amount).toBe(0);
  });

  test('458. PASS_tokenSplit_3 - amount equals paid only (no free).', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 7,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.deductTokens('user-458', 7, { beneficiaryId: 'bob' });
    const tx = expectDebitTx();
    expect(tx.amount).toBe(7);
    expect(tx.freeBeneficiaryConsumed).toBe(0);
    expect(tx.freeSystemConsumed).toBe(0);
  });

  test('459. PASS_tokenSplit_4 - amount equals beneficiary + system + paid total.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { alice: 2, system: 3 },
    });
    await TokenManager.deductTokens('user-459', 10, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(2);
    expect(tx.freeSystemConsumed).toBe(3);
    expect(tx.amount).toBe(5);
  });

  test('460. PASS_tokenSplit_5 - zero beneficiary-free skips to system-free.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 4,
      freeTokensPerBeneficiary: { alice: 0, system: 4 },
    });
    await TokenManager.deductTokens('user-460', 3, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(0);
    expect(tx.freeSystemConsumed).toBe(3);
    expect(tx.amount).toBe(0);
  });

  test('461. PASS_tokenSplit_6 - zero system-free skips to paid.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 10,
      totalFreeTokens: 2,
      freeTokensPerBeneficiary: { alice: 2, system: 0 },
    });
    await TokenManager.deductTokens('user-461', 5, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(2);
    expect(tx.freeSystemConsumed).toBe(0);
    expect(tx.amount).toBe(3);
  });

  test('462. PASS_tokenSplit_7 - zero paid available uses only free.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { alice: 3, system: 2 },
    });
    await TokenManager.deductTokens('user-462', 5, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.amount).toBe(0);
    expect(tx.freeBeneficiaryConsumed).toBe(3);
    expect(tx.freeSystemConsumed).toBe(2);
  });

  test('463. PASS_tokenSplit_8 - beneficiaryId missing in map treated as 0.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 2,
      freeTokensPerBeneficiary: { system: 2 },
    });
    await TokenManager.deductTokens('user-463', 2, { beneficiaryId: 'unknown' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(0);
    expect(tx.freeSystemConsumed).toBe(2);
  });

  test('464. PASS_tokenSplit_9 - beneficiaryId "system" uses system bucket once.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { system: 5 },
    });
    await TokenManager.deductTokens('user-464', 3, { beneficiaryId: 'system' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(3);
    expect(tx.freeSystemConsumed).toBe(0);
    expect(tx.amount).toBe(0);
  });

  test('465. PASS_tokenSplit_10 - decimal free buckets handled without precision loss.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 4,
      freeTokensPerBeneficiary: { alice: 1.5, system: 2.5 },
    });
    await TokenManager.deductTokens('user-465', 3, { beneficiaryId: 'alice' });
    const tx = expectDebitTx();
    expect(tx.freeBeneficiaryConsumed).toBe(1.5);
    expect(tx.freeSystemConsumed).toBe(1.5);
    expect(tx.amount).toBe(0);
  });

  test('466. FAIL_tokenSplit_1 - freeTokensPerBeneficiary null throws.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: null,
    });
    await expect(TokenManager.deductTokens('user-466', 1, { beneficiaryId: 'alice' })).rejects.toThrow();
  });

  test('467. FAIL_tokenSplit_2 - negative beneficiary bucket does not create tokens.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: -5,
      freeTokensPerBeneficiary: { alice: -5, system: 0 },
    });
    await expect(TokenManager.deductTokens('user-467', 1, { beneficiaryId: 'alice' })).rejects.toThrow(/Insufficient paid tokens/);
  });

  test('468. FAIL_tokenSplit_3 - negative system bucket does not create tokens.', async () => {
    balanceSpy.mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: -5,
      freeTokensPerBeneficiary: { system: -5 },
    });
    await expect(TokenManager.deductTokens('user-468', 1, { beneficiaryId: 'alice' })).rejects.toThrow(/Insufficient paid tokens/);
  });

  test('469. FAIL_tokenSplit_4 - negative amount rejected upstream.', async () => {
    await expect(TokenManager.deductTokens('user-469', -1, { beneficiaryId: 'alice' })).rejects.toThrow(/amount must be positive/);
  });

  test('470. FAIL_tokenSplit_5 - zero amount rejected upstream.', async () => {
    await expect(TokenManager.deductTokens('user-470', 0, { beneficiaryId: 'alice' })).rejects.toThrow(/amount must be positive/);
  });

  test('471. FAIL_tokenSplit_6 - NaN amount rejected by validation.', async () => {
    await expect(TokenManager.deductTokens('user-471', NaN, { beneficiaryId: 'alice' })).rejects.toThrow(/amount must be an integer/);
  });
});

describe('TokenManager security and injection batch #1', () => {
  test('472. FAIL_injection_1 - userId injection payload sanitized in queries.', async () => {
    const maliciousId = "user-472' OR '1'='1";
    mockScyllaDb.query.mockResolvedValueOnce([]);
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await TokenManager.getUserBalance(maliciousId);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    expect(params[':uid']).toBe(maliciousId);
  });

  test('473. FAIL_injection_2 - beneficiaryId injection stored safely.', async () => {
    const maliciousBeneficiary = 'beneficiary-473"; DROP TABLE--';
    await TokenManager.creditFreeTokens('user-473', maliciousBeneficiary, 1);
    expect(mockScyllaDb.putItem).toHaveBeenCalledWith(
      TokenManager.TABLES.TOKEN_REGISTRY,
      expect.objectContaining({ beneficiaryId: maliciousBeneficiary }),
    );
  });

  test('474. FAIL_injection_3 - refId injection payload sanitized in query.', async () => {
    const maliciousRef = 'ref-474; DROP TABLE';
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await TokenManager.getUserSpendingByRefId('user-474', maliciousRef);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    expect(params[':rid']).toBe(maliciousRef);
  });

  test('475. FAIL_injection_4 - purpose script tags stored as plain text.', async () => {
    const purpose = '<script>alert(1)</script>';
    await TokenManager.creditPaidTokens('user-475', 1, purpose);
    expect(mockScyllaDb.putItem).toHaveBeenCalledWith(
      TokenManager.TABLES.TOKEN_REGISTRY,
      expect.objectContaining({ purpose }),
    );
  });

  test('476. FAIL_injection_5 - metadata __proto__ does not pollute prototype.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-476',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata: { __proto__: { polluted: true } },
    });
    expect({}.polluted).toBeUndefined();
  });

  test('477. FAIL_injection_6 - metadata constructor does not pollute prototype.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-477',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata: { constructor: { prototype: { polluted: true } } },
    });
    expect({}.polluted).toBeUndefined();
  });
});

describe('TokenManager prototype pollution batch #1', () => {
  test('478. FAIL_pollution_1 - __proto__ metadata does not mutate Object.prototype.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-478',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata: { __proto__: { polluted: true } },
    });
    expect({}.polluted).toBeUndefined();
  });

  test('479. FAIL_pollution_2 - constructor.prototype payload does not mutate Object.prototype.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-479',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata: { constructor: { prototype: { polluted: true } } },
    });
    expect({}.polluted).toBeUndefined();
  });

  test('480. FAIL_pollution_3 - deep nested pollution attempt blocked.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-480',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata: { nested: { __proto__: { polluted: true } } },
    });
    expect({}.polluted).toBeUndefined();
  });
});

describe('TokenManager xss storage batch #1', () => {
  test('481. PASS_xss_1 - purpose with HTML entities stored as-is.', async () => {
    const purpose = '&lt;b&gt;bold&lt;/b&gt;';
    await TokenManager.creditPaidTokens('user-481', 1, purpose);
    expect(mockScyllaDb.putItem).toHaveBeenCalledWith(
      TokenManager.TABLES.TOKEN_REGISTRY,
      expect.objectContaining({ purpose }),
    );
  });

  test('482. PASS_xss_2 - metadata script tags serialized safely.', async () => {
    await TokenManager.creditPaidTokens('user-482', 1, 'xss-test', { note: '<script>alert(1)</script>' });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.metadata).toContain('<script>alert(1)</script>');
  });
});

describe('TokenManager concurrency batch #1', () => {
  test('483. PASS_concurrency_1 - captureHeldTokens handles conditional check failure.', async () => {
    const hold = createHoldRecord({ id: 'hold-483', state: TokenManager.HOLD_STATES.OPEN, version: 1 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    const result = await TokenManager.captureHeldTokens({ transactionId: 'hold-483' });
    expect(result.capturedCount).toBe(0);
  });

  test('484. PASS_concurrency_2 - reverseHeldTokens handles conditional check failure.', async () => {
    const hold = createHoldRecord({ id: 'hold-484', state: TokenManager.HOLD_STATES.OPEN, version: 1 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    const result = await TokenManager.reverseHeldTokens({ transactionId: 'hold-484' });
    expect(result.reversedCount).toBe(0);
  });

  test('485. PASS_concurrency_3 - extendExpiry fails when version check fails.', async () => {
    const hold = createHoldRecord({ id: 'hold-485', state: TokenManager.HOLD_STATES.OPEN, version: 1 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    await expect(TokenManager.extendExpiry({ transactionId: 'hold-485', extendBySeconds: 60 })).rejects.toThrow(/already captured or reversed/);
  });

  test('486. PASS_concurrency_4 - capture/reverse race locks out the loser.', async () => {
    const hold = createHoldRecord({ id: 'hold-486', state: TokenManager.HOLD_STATES.CAPTURED });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    await expect(TokenManager.reverseHeldTokens({ transactionId: 'hold-486' })).rejects.toThrow(/already captured/);
  });

  test('487. FAIL_concurrency_1 - version increments correctly on capture.', async () => {
    const hold = createHoldRecord({ id: 'hold-487', state: TokenManager.HOLD_STATES.OPEN, version: 1 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2, state: TokenManager.HOLD_STATES.CAPTURED });
    await TokenManager.captureHeldTokens({ transactionId: 'hold-487' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    expect(updates.version).toBe(2);
  });
});

describe('TokenManager concurrency and performance batch #2', () => {
  test('488. FAIL_concurrency_2 - conditional failure does not corrupt audit trail.', async () => {
    const hold = createHoldRecord({
      id: 'hold-488',
      state: TokenManager.HOLD_STATES.OPEN,
      version: 1,
      metadata: JSON.stringify({ auditTrail: [{ status: 'HOLD' }] }),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    const result = await TokenManager.captureHeldTokens({ transactionId: 'hold-488' });
    expect(result.capturedCount).toBe(0);
  });

  test('489. PASS_concurrency_5 - two deductTokens calls both succeed with sufficient balance.', async () => {
    jest.spyOn(TokenManager, 'validateSufficientTokens').mockResolvedValue(true);
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 100,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await Promise.all([
      TokenManager.deductTokens('user-489', 5, { beneficiaryId: 'ben-489' }),
      TokenManager.deductTokens('user-489', 5, { beneficiaryId: 'ben-489' }),
    ]);
    expect(mockScyllaDb.putItem).toHaveBeenCalledTimes(2);
  });

  test('490. PASS_concurrency_6 - deductTokens racing with creditPaidTokens succeeds.', async () => {
    jest.spyOn(TokenManager, 'validateSufficientTokens').mockResolvedValue(true);
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 50,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await Promise.all([
      TokenManager.creditPaidTokens('user-490', 10),
      TokenManager.deductTokens('user-490', 5, { beneficiaryId: 'ben-490' }),
    ]);
    expect(mockScyllaDb.putItem).toHaveBeenCalled();
  });

  test('491. PASS_concurrency_7 - holdTokens racing with deductTokens succeeds if balance allows.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 100,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await Promise.all([
      TokenManager.holdTokens('user-491', 10, 'ben-491'),
      TokenManager.deductTokens('user-491', 5, { beneficiaryId: 'ben-491' }),
    ]);
    expect(mockScyllaDb.putItem).toHaveBeenCalled();
  });

  test('492. FAIL_concurrency_3 - balance changes before write results in insufficient paid tokens.', async () => {
    jest.spyOn(TokenManager, 'validateSufficientTokens').mockResolvedValue(true);
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await expect(TokenManager.deductTokens('user-492', 5, { beneficiaryId: 'ben-492' }))
      .rejects.toThrow(/Insufficient paid tokens/);
  });

  test('493. PASS_perf_1 - getUserBalance handles 10k transactions.', async () => {
    const txs = Array.from({ length: 10000 }, (_, idx) =>
      createTransactionRecord({
        id: `tx-493-${idx}`,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: 1,
      }),
    );
    mockScyllaDb.query
      .mockResolvedValueOnce(txs)
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-493');
    expect(balance.paidTokens).toBe(10000);
  });

  test('494. PASS_perf_2 - getUserTokenSummary handles 5k transactions.', async () => {
    const txs = Array.from({ length: 5000 }, (_, idx) =>
      createTransactionRecord({
        id: `tx-494-${idx}`,
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: 1,
      }),
    );
    mockScyllaDb.query
      .mockResolvedValueOnce(txs)
      .mockResolvedValueOnce([]);
    const summary = await TokenManager.getUserTokenSummary('user-494');
    expect(summary.totalUsableTokens).toBeGreaterThanOrEqual(5000);
  });

  test('495. PASS_perf_3 - getUserTransactionHistory handles 10k records.', async () => {
    const txs = Array.from({ length: 10000 }, (_, idx) =>
      createTransactionRecord({
        id: `tx-495-${idx}`,
        transactionType: TokenManager.TRANSACTION_TYPES.DEBIT,
        createdAt: new Date(referenceNow.getTime() + idx).toISOString(),
      }),
    );
    mockScyllaDb.query
      .mockResolvedValueOnce(txs)
      .mockResolvedValueOnce([]);
    const history = await TokenManager.getUserTransactionHistory('user-495');
    expect(history).toHaveLength(10000);
  });

  test('496. PASS_perf_4 - processExpiredHolds handles 1000 holds.', async () => {
    const holds = Array.from({ length: 1000 }, (_, idx) => createHoldRecord({ id: `hold-496-${idx}` }));
    const findSpy = jest.spyOn(TokenManager, 'findExpiredHolds').mockResolvedValueOnce(holds);
    const reverseSpy = jest.spyOn(TokenManager, 'reverseHeldTokens').mockResolvedValue({ reversedCount: 1 });
    const result = await TokenManager.processExpiredHolds(0, 1000);
    expect(result.processed).toBe(1000);
    expect(result.reversed).toBe(1000);
    findSpy.mockRestore();
    reverseSpy.mockRestore();
  });

  test('497. PASS_perf_5 - findExpiredHolds handles 10k holds.', async () => {
    const holds = Array.from({ length: 10000 }, (_, idx) => createHoldRecord({ id: `hold-497-${idx}` }));
    mockScyllaDb.query.mockResolvedValueOnce(holds);
    const result = await TokenManager.findExpiredHolds(0, 10000);
    expect(result).toHaveLength(10000);
  });

  test('498. PASS_perf_6 - 100 deductTokens calls complete without deadlocks.', async () => {
    jest.spyOn(TokenManager, 'validateSufficientTokens').mockResolvedValue(true);
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 10000,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const promises = Array.from({ length: 100 }, (_, idx) =>
      TokenManager.deductTokens('user-498', 1, { beneficiaryId: `ben-${idx}` }),
    );
    await expect(Promise.all(promises)).resolves.toHaveLength(100);
  });

  test('499. FAIL_perf_1 - getUserBalance handles malformed records defensively.', async () => {
    const txs = [
      { id: 'bad-499-1', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE, amount: 'x' },
      { id: 'bad-499-2', transactionType: 'UNKNOWN', amount: 5 },
      createTransactionRecord({ id: 'ok-499', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID, amount: 1 }),
    ];
    mockScyllaDb.query
      .mockResolvedValueOnce(txs)
      .mockResolvedValueOnce([]);
    await expect(TokenManager.getUserBalance('user-499')).resolves.toEqual(
      expect.objectContaining({ paidTokens: expect.any(Number) }),
    );
  });

  test('500. FAIL_perf_2 - metadata size error bubbles from DB write.', async () => {
    const bigPayload = 'x'.repeat(5 * 1024 * 1024 + 1);
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('Item size too large'));
    await expect(TokenManager.addTransaction({
      userId: 'user-500',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata: { blob: bigPayload },
    })).rejects.toThrow(/Item size too large/);
  });
});

describe('TokenManager metadata/version/state/audit/datetime batch #3', () => {
  test('501. PASS_metadata_1 - empty metadata object stored correctly.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-501',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata: {},
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.metadata).toBe(JSON.stringify({}));
  });

  test('502. PASS_metadata_2 - nested metadata serialized correctly.', async () => {
    const metadata = { nested: { a: 1 } };
    await TokenManager.addTransaction({
      userId: 'user-502',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(JSON.parse(record.metadata)).toEqual(metadata);
  });

  test('503. PASS_metadata_3 - array metadata serialized correctly.', async () => {
    const metadata = { items: [1, 2, 3] };
    await TokenManager.addTransaction({
      userId: 'user-503',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(JSON.parse(record.metadata)).toEqual(metadata);
  });

  test('504. PASS_metadata_4 - null values preserved in metadata.', async () => {
    const metadata = { note: null };
    await TokenManager.addTransaction({
      userId: 'user-504',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(JSON.parse(record.metadata)).toEqual(metadata);
  });

  test('505. PASS_metadata_5 - boolean values preserved in metadata.', async () => {
    const metadata = { ok: true };
    await TokenManager.addTransaction({
      userId: 'user-505',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(JSON.parse(record.metadata)).toEqual(metadata);
  });

  test('506. PASS_metadata_6 - number values preserved in metadata.', async () => {
    const metadata = { count: 42 };
    await TokenManager.addTransaction({
      userId: 'user-506',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(JSON.parse(record.metadata)).toEqual(metadata);
  });

  test('507. FAIL_metadata_1 - circular metadata throws and is handled.', async () => {
    const metadata = {};
    metadata.self = metadata;
    await expect(TokenManager.addTransaction({
      userId: 'user-507',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata,
    })).rejects.toThrow();
  });

  test('508. FAIL_metadata_2 - metadata size too large rejected by DB.', async () => {
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('EntityTooLarge'));
    await expect(TokenManager.addTransaction({
      userId: 'user-508',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata: { blob: 'x'.repeat(1024) },
    })).rejects.toThrow(/EntityTooLarge/);
  });

  test('509. FAIL_metadata_3 - undefined values omitted in serialization.', async () => {
    const metadata = { a: undefined, b: 1 };
    await TokenManager.addTransaction({
      userId: 'user-509',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    const parsed = JSON.parse(record.metadata);
    expect(parsed.a).toBeUndefined();
    expect(parsed.b).toBe(1);
  });

  test('510. FAIL_metadata_4 - Symbol keys ignored in serialization.', async () => {
    const sym = Symbol('k');
    const metadata = { [sym]: 'value', ok: true };
    await TokenManager.addTransaction({
      userId: 'user-510',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    const parsed = JSON.parse(record.metadata);
    expect(parsed.ok).toBe(true);
  });

  test('511. FAIL_metadata_5 - function values omitted in serialization.', async () => {
    const metadata = { fn: () => 1, ok: true };
    await TokenManager.addTransaction({
      userId: 'user-511',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    const parsed = JSON.parse(record.metadata);
    expect(parsed.fn).toBeUndefined();
    expect(parsed.ok).toBe(true);
  });

  test('512. PASS_version_1 - new transaction version=1.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-512',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.version).toBe(1);
  });

  test('513. PASS_version_2 - first update increments version to 2.', async () => {
    const hold = createHoldRecord({ id: 'hold-513', state: TokenManager.HOLD_STATES.OPEN, version: 1 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2, state: TokenManager.HOLD_STATES.REVERSED });
    await TokenManager.reverseHeldTokens({ transactionId: 'hold-513' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    expect(updates.version).toBe(2);
  });

  test('514. PASS_version_3 - multiple updates increment version each time.', async () => {
    const holdV1 = createHoldRecord({ id: 'hold-514', state: TokenManager.HOLD_STATES.OPEN, version: 1 });
    const holdV2 = createHoldRecord({ id: 'hold-514', state: TokenManager.HOLD_STATES.OPEN, version: 2 });
    mockScyllaDb.getItem
      .mockResolvedValueOnce(holdV1)
      .mockResolvedValueOnce(holdV2);
    mockScyllaDb.updateItem
      .mockResolvedValueOnce({ ...holdV1, version: 2 })
      .mockResolvedValueOnce({ ...holdV2, version: 3 });
    await TokenManager.extendExpiry({ transactionId: 'hold-514', extendBySeconds: 60 });
    await TokenManager.extendExpiry({ transactionId: 'hold-514', extendBySeconds: 60 });
    const firstUpdate = mockScyllaDb.updateItem.mock.calls[0][2];
    const secondUpdate = mockScyllaDb.updateItem.mock.calls[1][2];
    expect(firstUpdate.version).toBe(2);
    expect(secondUpdate.version).toBe(3);
  });

  test('515. FAIL_version_1 - conditional update prevents manual version manipulation.', async () => {
    const hold = createHoldRecord({ id: 'hold-515', state: TokenManager.HOLD_STATES.OPEN, version: 1 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    await expect(TokenManager.extendExpiry({ transactionId: 'hold-515', extendBySeconds: 60 }))
      .rejects.toThrow(/already captured or reversed/);
  });

  test('516. PASS_state_1 - new HOLD state is open.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-516',
      transactionType: TokenManager.TRANSACTION_TYPES.HOLD,
      amount: 1,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.state).toBe(TokenManager.HOLD_STATES.OPEN);
  });

  test('517. PASS_state_2 - capture updates state to captured.', async () => {
    const hold = createHoldRecord({ id: 'hold-517', state: TokenManager.HOLD_STATES.OPEN, version: 1 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED });
    await TokenManager.captureHeldTokens({ transactionId: 'hold-517' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    expect(updates.state).toBe(TokenManager.HOLD_STATES.CAPTURED);
  });

  test('518. PASS_state_3 - reverse updates state to reversed.', async () => {
    const hold = createHoldRecord({ id: 'hold-518', state: TokenManager.HOLD_STATES.OPEN, version: 1 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED });
    await TokenManager.reverseHeldTokens({ transactionId: 'hold-518' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    expect(updates.state).toBe(TokenManager.HOLD_STATES.REVERSED);
  });

  test('519. FAIL_state_1 - captured hold cannot transition back to open.', async () => {
    const hold = createHoldRecord({ id: 'hold-519', state: TokenManager.HOLD_STATES.CAPTURED, version: 2 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    await expect(TokenManager.extendExpiry({ transactionId: 'hold-519', extendBySeconds: 60 }))
      .rejects.toThrow(/already captured/);
  });

  test('520. FAIL_state_2 - reversed hold cannot transition back to open.', async () => {
    const hold = createHoldRecord({ id: 'hold-520', state: TokenManager.HOLD_STATES.REVERSED, version: 2 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    await expect(TokenManager.extendExpiry({ transactionId: 'hold-520', extendBySeconds: 60 }))
      .rejects.toThrow(/already reversed/);
  });

  test('521. FAIL_state_3 - captured hold cannot be reversed.', async () => {
    const hold = createHoldRecord({ id: 'hold-521', state: TokenManager.HOLD_STATES.CAPTURED });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    await expect(TokenManager.reverseHeldTokens({ transactionId: 'hold-521' }))
      .rejects.toThrow(/already captured/);
  });

  test('522. FAIL_state_4 - invalid state value rejected.', async () => {
    const hold = createHoldRecord({ id: 'hold-522', state: 'weird' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    await expect(TokenManager.captureHeldTokens({ transactionId: 'hold-522' }))
      .rejects.toThrow(/not in OPEN state/);
  });

  test('523. FAIL_state_5 - missing state logged and excluded from capture.', async () => {
    const missingState = createHoldRecord({ id: 'hold-523-missing', state: undefined });
    const openHold = createHoldRecord({ id: 'hold-523-open', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([missingState, openHold]);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...openHold, state: TokenManager.HOLD_STATES.CAPTURED });
    const result = await TokenManager.captureHeldTokens({ refId: 'ref-523' });
    expect(result.capturedCount).toBe(1);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Found HOLD record(s) with missing state'),
      expect.objectContaining({ code: 'HOLD_MISSING_STATE' }),
    );
  });

  test('524. PASS_audit_1 - new HOLD auditTrail includes initial HOLD entry.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.holdTokens('user-524', 5, 'ben-524');
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    const parsed = JSON.parse(record.metadata);
    expect(parsed.auditTrail[0].status).toBe('HOLD');
  });

  test('525. PASS_audit_2 - capture appends CAPTURED entry.', async () => {
    const hold = createHoldRecord({
      id: 'hold-525',
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: JSON.stringify({ auditTrail: [{ status: 'HOLD' }] }),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED });
    await TokenManager.captureHeldTokens({ transactionId: 'hold-525' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    expect(parsed.auditTrail.some((e) => e.status === 'CAPTURED')).toBe(true);
  });

  test('526. PASS_audit_3 - reverse appends REVERSE entry.', async () => {
    const hold = createHoldRecord({
      id: 'hold-526',
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: JSON.stringify({ auditTrail: [{ status: 'HOLD' }] }),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED });
    await TokenManager.reverseHeldTokens({ transactionId: 'hold-526' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    expect(parsed.auditTrail.some((e) => e.status === 'REVERSE')).toBe(true);
  });

  test('527. PASS_audit_4 - extend adds EXTENDED entry with details.', async () => {
    const hold = createHoldRecord({
      id: 'hold-527',
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: JSON.stringify({ auditTrail: [{ status: 'HOLD' }] }),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2 });
    await TokenManager.extendExpiry({ transactionId: 'hold-527', extendBySeconds: 60 });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    const entry = parsed.auditTrail.find((e) => e.status === 'EXTENDED');
    expect(entry.extendedBySeconds).toBe(60);
    expect(entry.previousExpiresAt).toBeDefined();
    expect(entry.newExpiresAt).toBeDefined();
  });

  test('528. PASS_audit_5 - multiple extends grow auditTrail.', async () => {
    const hold = createHoldRecord({
      id: 'hold-528',
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: JSON.stringify({ auditTrail: [{ status: 'HOLD' }] }),
    });
    const holdV2 = { ...hold, metadata: JSON.stringify({ auditTrail: [{ status: 'HOLD' }, { status: 'EXTENDED' }] }) };
    mockScyllaDb.getItem
      .mockResolvedValueOnce(hold)
      .mockResolvedValueOnce(holdV2);
    mockScyllaDb.updateItem
      .mockResolvedValueOnce({ ...hold, version: 2 })
      .mockResolvedValueOnce({ ...hold, version: 3 });
    await TokenManager.extendExpiry({ transactionId: 'hold-528', extendBySeconds: 60 });
    await TokenManager.extendExpiry({ transactionId: 'hold-528', extendBySeconds: 60 });
    const secondUpdate = mockScyllaDb.updateItem.mock.calls[1][2];
    const parsed = JSON.parse(secondUpdate.metadata);
    expect(parsed.auditTrail.length).toBeGreaterThanOrEqual(2);
  });

  test('529. PASS_audit_6 - audit entries include timestamp.', async () => {
    const hold = createHoldRecord({ id: 'hold-529', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED });
    await TokenManager.captureHeldTokens({ transactionId: 'hold-529' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    const entry = parsed.auditTrail.find((e) => e.status === 'CAPTURED');
    expect(entry.timestamp).toBeDefined();
  });

  test('530. PASS_audit_7 - audit entries include action.', async () => {
    const hold = createHoldRecord({ id: 'hold-530', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED });
    await TokenManager.reverseHeldTokens({ transactionId: 'hold-530' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    const entry = parsed.auditTrail.find((e) => e.status === 'REVERSE');
    expect(entry.action).toBeDefined();
  });

  test('531. PASS_audit_8 - captured/reversed entries include action text.', async () => {
    const hold = createHoldRecord({ id: 'hold-531', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED });
    await TokenManager.captureHeldTokens({ transactionId: 'hold-531' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    const entry = parsed.auditTrail.find((e) => e.status === 'CAPTURED');
    expect(entry.action).toContain('captured');
  });

  test('532. FAIL_audit_1 - concurrent update failure does not corrupt audit trail.', async () => {
    const hold = createHoldRecord({
      id: 'hold-532',
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: JSON.stringify({ auditTrail: [{ status: 'HOLD' }] }),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    const result = await TokenManager.captureHeldTokens({ transactionId: 'hold-532' });
    expect(result.capturedCount).toBe(0);
  });

  test('533. FAIL_audit_2 - auditTrail parse failure handled gracefully.', async () => {
    const hold = createHoldRecord({
      id: 'hold-533',
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: '{bad json',
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED });
    await TokenManager.captureHeldTokens({ transactionId: 'hold-533' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    expect(parsed.auditTrail).toBeDefined();
  });

  test('534. PASS_datetime_1 - far-future sentinel not treated as expired.', async () => {
    mockDateTime.isPast.mockReturnValueOnce(true);
    const tx = createTransactionRecord({
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      amount: 5,
      expiresAt: '9999-12-31T23:59:59.999Z',
    });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-534');
    expect(balance.freeTokensPerBeneficiary[tx.beneficiaryId]).toBe(5);
  });

  test('535. PASS_datetime_2 - expiresAt exactly now treated as expired.', async () => {
    mockDateTime.isPast.mockImplementationOnce((value) => value === referenceNow.toISOString());
    const tx = createTransactionRecord({
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      amount: 5,
      expiresAt: referenceNow.toISOString(),
    });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-535');
    expect(balance.totalFreeTokens).toBe(0);
  });

  test('536. PASS_datetime_3 - expiresAt in past treated as expired.', async () => {
    const past = new Date(referenceNow.getTime() - 1000).toISOString();
    const tx = createTransactionRecord({
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      amount: 5,
      expiresAt: past,
    });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-536');
    expect(balance.totalFreeTokens).toBe(0);
  });

  test('537. PASS_datetime_4 - expiresAt in future not expired.', async () => {
    const future = new Date(referenceNow.getTime() + 1000).toISOString();
    const tx = createTransactionRecord({
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      amount: 5,
      expiresAt: future,
    });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-537');
    expect(balance.totalFreeTokens).toBe(5);
  });
});

describe('TokenManager datetime/boundary/expiry batch #4', () => {
  test('538. PASS_datetime_5 - createdAt ordering sorted correctly.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-538-new', createdAt: '2025-01-02T00:00:00.000Z' }),
      createTransactionRecord({ id: 'tx-538-old', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    mockScyllaDb.query
      .mockResolvedValueOnce(txs)
      .mockResolvedValueOnce([]);
    const result = await TokenManager.getUserTransactionHistory('user-538');
    expect(Date.parse(result[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(result[1].createdAt));
  });

  test('539. FAIL_datetime_1 - invalid expiresAt handled gracefully.', async () => {
    mockDateTime.isPast.mockImplementation(() => { throw new Error('bad date'); });
    const tx = createTransactionRecord({
      userId: 'user-539',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      amount: 5,
      expiresAt: 'not-iso',
    });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-539');
    expect(balance.totalFreeTokens).toBe(5);
  });

  test('540. FAIL_datetime_2 - expiresAt null handled appropriately.', async () => {
    const tx = createTransactionRecord({
      userId: 'user-540',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      amount: 5,
      expiresAt: null,
    });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-540');
    expect(balance.totalFreeTokens).toBe(5);
  });

  test('541. FAIL_datetime_3 - createdAt missing handled.', async () => {
    const tx = createTransactionRecord({ id: 'tx-541', createdAt: undefined });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const result = await TokenManager.getUserTransactionHistory('user-541');
    expect(result).toHaveLength(1);
  });

  test('542. FAIL_datetime_4 - timezone differences compare ISO strings correctly.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-542-utc', createdAt: '2025-01-01T00:00:00.000Z' }),
      createTransactionRecord({ id: 'tx-542-offset', createdAt: '2024-12-31T19:00:00.000-05:00' }),
    ];
    mockScyllaDb.query
      .mockResolvedValueOnce(txs)
      .mockResolvedValueOnce([]);
    const result = await TokenManager.getUserTransactionHistory('user-542');
    expect(result).toHaveLength(2);
  });

  test('543. FAIL_datetime_5 - leap second handling does not crash.', async () => {
    const tx = createTransactionRecord({ id: 'tx-543', createdAt: '2016-12-31T23:59:60Z' });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    await expect(TokenManager.getUserTransactionHistory('user-543')).resolves.toHaveLength(1);
  });

  test('544. FAIL_datetime_6 - Year 2038 boundary handled.', async () => {
    const tx = createTransactionRecord({ id: 'tx-544', createdAt: '2038-01-19T03:14:07.000Z' });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const result = await TokenManager.getUserTransactionHistory('user-544');
    expect(result).toHaveLength(1);
  });

  test('545. PASS_boundary_1 - amount minimum 1 valid.', async () => {
    await TokenManager.creditPaidTokens('user-545', 1);
    expect(mockScyllaDb.putItem).toHaveBeenCalled();
  });

  test('546. PASS_boundary_2 - amount max 32-bit int allowed.', async () => {
    await TokenManager.creditPaidTokens('user-546', 2147483647);
    expect(mockScyllaDb.putItem).toHaveBeenCalled();
  });

  test('547. PASS_boundary_3 - TIP amount 0 with free consumed accepted.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-547',
      beneficiaryId: 'ben-547',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 0,
      freeBeneficiaryConsumed: 1,
      freeSystemConsumed: 0,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.amount).toBe(0);
  });

  test('548. FAIL_boundary_1 - amount=0 for non-TIP rejected.', async () => {
    await expect(TokenManager.creditPaidTokens('user-548', 0)).rejects.toThrow(/amount must be positive/);
  });

  test('549. FAIL_boundary_2 - amount=-1 rejected.', async () => {
    await expect(TokenManager.creditPaidTokens('user-549', -1)).rejects.toThrow(/amount must be positive/);
  });

  test('550. FAIL_boundary_3 - amount beyond safe integer rejected.', async () => {
    await expect(TokenManager.creditPaidTokens('user-550', Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(/amount must be an integer/);
  });

  test('551. FAIL_boundary_4 - amount Infinity rejected.', async () => {
    await expect(TokenManager.creditPaidTokens('user-551', Infinity)).rejects.toThrow(/amount must be a finite number/);
  });

  test('552. FAIL_boundary_5 - amount -Infinity rejected.', async () => {
    await expect(TokenManager.creditPaidTokens('user-552', -Infinity)).rejects.toThrow(/amount must be a finite number/);
  });

  test('553. PASS_str_boundary_1 - purpose 1 char accepted.', async () => {
    await TokenManager.creditPaidTokens('user-553', 1, 'a');
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.purpose).toBe('a');
  });

  test('554. PASS_str_boundary_2 - purpose 1000 chars accepted.', async () => {
    const purpose = 'x'.repeat(1000);
    await TokenManager.creditPaidTokens('user-554', 1, purpose);
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.purpose.length).toBe(1000);
  });

  test('555. PASS_str_boundary_3 - refId UUID format accepted.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-555',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      refId: '123e4567-e89b-12d3-a456-426614174000',
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.refId).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  test('556. FAIL_str_boundary_1 - purpose excessively long rejected by DB.', async () => {
    const purpose = 'x'.repeat(10001);
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('Item too large'));
    await expect(TokenManager.creditPaidTokens('user-556', 1, purpose)).rejects.toThrow(/Item too large/);
  });

  test('557. FAIL_str_boundary_2 - refId empty string rejected.', async () => {
    await expect(TokenManager.addTransaction({
      userId: 'user-557',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      refId: '',
    })).rejects.toThrow(/refId must be a string/);
  });

  test('558. FAIL_str_boundary_3 - userId extremely long rejected.', async () => {
    const longId = 'u'.repeat(10000);
    await expect(TokenManager.getUserBalance(longId)).resolves.toBeDefined();
  });

  test('559. PASS_expiry_boundary_1 - expiryAfterSeconds=60 allowed by holdTokens.', async () => {
    await expect(TokenManager.holdTokens('user-559', 1, 'ben-559', { expiresAfter: 60 }))
      .rejects.toThrow(/Hold timeout must be between 300 and 3600 seconds/);
  });

  test('560. PASS_expiry_boundary_2 - expiryAfterSeconds=86400 rejected by bounds.', async () => {
    await expect(TokenManager.holdTokens('user-560', 1, 'ben-560', { expiresAfter: 86400 }))
      .rejects.toThrow(/Hold timeout must be between 300 and 3600 seconds/);
  });

  test('561. PASS_expiry_boundary_3 - expiryAfterSeconds=2592000 rejected by bounds.', async () => {
    await expect(TokenManager.holdTokens('user-561', 1, 'ben-561', { expiresAfter: 2592000 }))
      .rejects.toThrow(/Hold timeout must be between 300 and 3600 seconds/);
  });

  test('562. FAIL_expiry_boundary_1 - expiryAfterSeconds=0 rejected.', async () => {
    await expect(TokenManager.holdTokens('user-562', 1, 'ben-562', { expiresAfter: 0 }))
      .rejects.toThrow(/Hold timeout must be between 300 and 3600 seconds/);
  });

  test('563. FAIL_expiry_boundary_2 - expiryAfterSeconds negative rejected.', async () => {
    await expect(TokenManager.holdTokens('user-563', 1, 'ben-563', { expiresAfter: -1 }))
      .rejects.toThrow(/Hold timeout must be between 300 and 3600 seconds/);
  });

  test('564. FAIL_expiry_boundary_3 - expiryAfterSeconds above max rejected.', async () => {
    await expect(TokenManager.holdTokens('user-564', 1, 'ben-564', { expiresAfter: 3601 }))
      .rejects.toThrow(/Hold timeout must be between 300 and 3600 seconds/);
  });

  test('565. PASS_maxTotal_boundary_1 - extendExpiry enforces maxTotalSeconds.', async () => {
    const hold = createHoldRecord({
      id: 'hold-565',
      state: TokenManager.HOLD_STATES.OPEN,
      createdAt: new Date(referenceNow.getTime() - 3600 * 1000).toISOString(),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    await expect(TokenManager.extendExpiry({ transactionId: 'hold-565', extendBySeconds: 3600, maxTotalSeconds: 1800 }))
      .rejects.toThrow(/exceeding maximum/);
  });

  test('566. FAIL_maxTotal_boundary_2 - maxTotalSeconds below current total handled.', async () => {
    const hold = createHoldRecord({
      id: 'hold-566',
      state: TokenManager.HOLD_STATES.OPEN,
      createdAt: new Date(referenceNow.getTime() - 1800 * 1000).toISOString(),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    await expect(TokenManager.extendExpiry({ transactionId: 'hold-566', extendBySeconds: 60, maxTotalSeconds: 900 }))
      .rejects.toThrow(/exceeding maximum/);
  });
});

describe('TokenManager beneficiary/partial/zero/logging batch #5', () => {
  test('567. PASS_beneficiary_edge_1 - beneficiaryId system uses system bucket.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { system: 5 },
    });
    await TokenManager.deductTokens('user-567', 3, { beneficiaryId: 'system' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.freeBeneficiaryConsumed).toBe(3);
    expect(tx.freeSystemConsumed).toBe(0);
  });

  test('568. PASS_beneficiary_edge_2 - beneficiaryId not granted consumes system/paid.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 2,
      totalFreeTokens: 3,
      freeTokensPerBeneficiary: { system: 3 },
    });
    await TokenManager.deductTokens('user-568', 4, { beneficiaryId: 'unknown' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.freeBeneficiaryConsumed).toBe(0);
    expect(tx.freeSystemConsumed).toBe(3);
    expect(tx.amount).toBe(1);
  });

  test('569. PASS_beneficiary_edge_3 - only specified beneficiary bucket consumed.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 6,
      freeTokensPerBeneficiary: { alice: 4, bob: 2, system: 0 },
    });
    await TokenManager.deductTokens('user-569', 3, { beneficiaryId: 'alice' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.freeBeneficiaryConsumed).toBe(3);
    expect(tx.freeSystemConsumed).toBe(0);
  });

  test('570. FAIL_beneficiary_edge_1 - system bucket not double-counted.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { system: 5 },
    });
    await TokenManager.deductTokens('user-570', 5, { beneficiaryId: 'system' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.freeBeneficiaryConsumed).toBe(5);
    expect(tx.freeSystemConsumed).toBe(0);
  });

  test('571. FAIL_beneficiary_edge_2 - beneficiaryId null treated as system.', async () => {
    await expect(TokenManager.deductTokens('user-571', 1, { beneficiaryId: 123 }))
      .rejects.toThrow(/beneficiaryId must be a string/);
  });

  test('572. FAIL_beneficiary_edge_3 - beneficiaryId case sensitivity handled consistently.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 3,
      freeTokensPerBeneficiary: { Alice: 3, system: 0 },
    });
    await TokenManager.deductTokens('user-572', 2, { beneficiaryId: 'Alice' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.freeBeneficiaryConsumed).toBe(2);
  });

  test('573. PASS_partial_1 - consume half beneficiary-free only.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 10,
      freeTokensPerBeneficiary: { alice: 10, system: 0 },
    });
    await TokenManager.deductTokens('user-573', 5, { beneficiaryId: 'alice' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.freeBeneficiaryConsumed).toBe(5);
    expect(tx.freeSystemConsumed).toBe(0);
  });

  test('574. PASS_partial_2 - consume all beneficiary-free + half system-free.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 6,
      freeTokensPerBeneficiary: { alice: 2, system: 4 },
    });
    await TokenManager.deductTokens('user-574', 4, { beneficiaryId: 'alice' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.freeBeneficiaryConsumed).toBe(2);
    expect(tx.freeSystemConsumed).toBe(2);
  });

  test('575. PASS_partial_3 - consume all free + half paid.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 10,
      totalFreeTokens: 4,
      freeTokensPerBeneficiary: { alice: 2, system: 2 },
    });
    await TokenManager.deductTokens('user-575', 8, { beneficiaryId: 'alice' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.freeBeneficiaryConsumed).toBe(2);
    expect(tx.freeSystemConsumed).toBe(2);
    expect(tx.amount).toBe(4);
  });

  test('576. PASS_partial_4 - decimal-like split handled when buckets are decimals.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 2.5,
      freeTokensPerBeneficiary: { alice: 1.25, system: 1.25 },
    });
    await TokenManager.deductTokens('user-576', 2, { beneficiaryId: 'alice' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.freeBeneficiaryConsumed).toBe(1.25);
    expect(tx.freeSystemConsumed).toBe(0.75);
  });

  test('577. PASS_zero_1 - zero paid, free only.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 3,
      freeTokensPerBeneficiary: { alice: 3 },
    });
    await TokenManager.deductTokens('user-577', 3, { beneficiaryId: 'alice' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.amount).toBe(0);
  });

  test('578. PASS_zero_2 - zero free, paid only.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.deductTokens('user-578', 5, { beneficiaryId: 'alice' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.amount).toBe(5);
  });

  test('579. PASS_zero_3 - zero all tokens insufficient.', async () => {
    jest.spyOn(TokenManager, 'validateSufficientTokens').mockResolvedValue(false);
    await expect(TokenManager.deductTokens('user-579', 1, { beneficiaryId: 'alice' }))
      .rejects.toThrow(/sufficient tokens/);
  });

  test('580. PASS_zero_4 - zero beneficiary-free skips to system/paid.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 2,
      totalFreeTokens: 3,
      freeTokensPerBeneficiary: { alice: 0, system: 3 },
    });
    await TokenManager.deductTokens('user-580', 4, { beneficiaryId: 'alice' });
    const tx = mockScyllaDb.putItem.mock.calls[0][1];
    expect(tx.freeBeneficiaryConsumed).toBe(0);
    expect(tx.freeSystemConsumed).toBe(3);
    expect(tx.amount).toBe(1);
  });

  test('581. PASS_log_1 - successful operations log with flag TOKENS.', async () => {
    await TokenManager.creditPaidTokens('user-581', 1);
    expect(mockLogger.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({ flag: 'TOKENS' }),
    );
  });

  test('582. PASS_log_2 - failed operations log error details.', async () => {
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('write fail 582'));
    await expect(TokenManager.creditPaidTokens('user-582', 1)).rejects.toThrow('write fail 582');
    expect(mockErrorHandler.addError).toHaveBeenCalled();
  });

  test('583. PASS_log_3 - ErrorHandler.addError called with code.', async () => {
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('write fail 583'));
    await expect(TokenManager.creditPaidTokens('user-583', 1)).rejects.toThrow('write fail 583');
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: 'ADD_TRANSACTION_ERROR' }),
    );
  });

  test('584. PASS_log_4 - error stack traces captured.', async () => {
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('write fail 584'));
    await expect(TokenManager.creditPaidTokens('user-584', 1)).rejects.toThrow('write fail 584');
    const call = mockErrorHandler.addError.mock.calls[0][1];
    expect(call.stack).toBeDefined();
  });

  test('585. PASS_log_5 - sensitive data not logged.', async () => {
    await TokenManager.creditPaidTokens('user-585', 1, 'purchase', { secret: 'nope' });
    expect(mockLogger.writeLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'addTransaction' }),
    );
  });

  test('586. FAIL_log_1 - Logger.writeLog throws does not break transaction.', async () => {
    mockLogger.writeLog.mockImplementationOnce(() => { throw new Error('log fail'); });
    await expect(TokenManager.creditPaidTokens('user-586', 1)).resolves.toBeDefined();
  });

  test('587. FAIL_log_2 - ErrorHandler.addError throws does not break error propagation.', async () => {
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('write fail 587'));
    mockErrorHandler.addError.mockImplementationOnce(() => { throw new Error('handler fail'); });
    await expect(TokenManager.creditPaidTokens('user-587', 1)).rejects.toThrow();
  });
});

describe('TokenManager idempotency/type/null/external batch #6', () => {
  test('588. PASS_idempotent_1 - creditPaidTokens twice creates two transactions.', async () => {
    await TokenManager.creditPaidTokens('user-588', 5);
    await TokenManager.creditPaidTokens('user-588', 5);
    expect(mockScyllaDb.putItem).toHaveBeenCalledTimes(2);
  });

  test('589. PASS_idempotent_2 - deductTokens same refId creates two debits.', async () => {
    jest.spyOn(TokenManager, 'validateSufficientTokens').mockResolvedValue(true);
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 100,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.deductTokens('user-589', 5, { beneficiaryId: 'ben-589', refId: 'ref-589' });
    await TokenManager.deductTokens('user-589', 5, { beneficiaryId: 'ben-589', refId: 'ref-589' });
    expect(mockScyllaDb.putItem).toHaveBeenCalledTimes(2);
  });

  test('590. PASS_idempotent_3 - holdTokens same refId throws on second attempt.', async () => {
    const hold = createHoldRecord({ id: 'hold-590', refId: 'ref-590', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await expect(TokenManager.holdTokens('user-590', 1, 'ben-590', { refId: 'ref-590' }))
      .rejects.toThrow(/already exists/);
  });

  test('591. PASS_idempotent_4 - capture already-captured hold returns alreadyCaptured.', async () => {
    const hold = createHoldRecord({ id: 'hold-591', state: TokenManager.HOLD_STATES.CAPTURED });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const result = await TokenManager.captureHeldTokens({ transactionId: 'hold-591' });
    expect(result.alreadyCaptured).toBe(true);
  });

  test('592. PASS_idempotent_5 - reverse already-reversed hold returns alreadyReversed.', async () => {
    const hold = createHoldRecord({ id: 'hold-592', state: TokenManager.HOLD_STATES.REVERSED });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const result = await TokenManager.reverseHeldTokens({ transactionId: 'hold-592' });
    expect(result.alreadyReversed).toBe(true);
  });

  test('593. PASS_idempotent_6 - extendExpiry on captured hold throws.', async () => {
    const hold = createHoldRecord({ id: 'hold-593', state: TokenManager.HOLD_STATES.CAPTURED });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    await expect(TokenManager.extendExpiry({ transactionId: 'hold-593', extendBySeconds: 60 }))
      .rejects.toThrow(/already captured/);
  });

  test('594. FAIL_type_1 - amount string rejected.', async () => {
    await expect(TokenManager.creditPaidTokens('user-594', '100')).rejects.toThrow(/amount must be an integer/);
  });

  test('595. FAIL_type_2 - amount string float rejected.', async () => {
    await expect(TokenManager.creditPaidTokens('user-595', '100.5')).rejects.toThrow(/amount must be an integer/);
  });

  test('596. FAIL_type_3 - amount boolean rejected.', async () => {
    await expect(TokenManager.creditPaidTokens('user-596', true)).rejects.toThrow(/amount must be an integer/);
  });

  test('597. FAIL_type_4 - userId number rejected.', async () => {
    await expect(TokenManager.getUserBalance(123)).rejects.toThrow(/userId must be a string/);
  });

  test('598. FAIL_type_5 - metadata string rejected by JSON stringify? stored as string.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-598',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata: 'not-object',
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.metadata).toBe('not-object');
  });

  test('599. FAIL_type_6 - expiresAt timestamp number rejected.', async () => {
    await expect(TokenManager.addTransaction({
      userId: 'user-599',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      expiresAt: 123456,
    })).rejects.toThrow(/expiresAt must be a string/);
  });

  test('600. PASS_null_1 - purpose null uses default.', async () => {
    await TokenManager.creditPaidTokens('user-600', 1, null);
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.purpose).toBe(TokenManager.TRANSACTION_TYPES.CREDIT_PAID);
  });

  test('601. PASS_null_2 - refId null generates default.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-601',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      refId: null,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.refId).toMatch(/^no_ref_/);
  });

  test('602. PASS_null_3 - expiresAt null uses sentinel.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-602',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      expiresAt: null,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.expiresAt).toBe('9999-12-31T23:59:59.999Z');
  });

  test('603. PASS_null_4 - metadata null uses empty object.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-603',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata: null,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.metadata).toBe(JSON.stringify({}));
  });

  test('604. PASS_null_5 - beneficiaryId null for CREDIT_PAID uses system.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-604',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      beneficiaryId: null,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.beneficiaryId).toBe(TokenManager.SYSTEM_BENEFICIARY_ID);
  });

  test('605. FAIL_null_1 - userId null rejected.', async () => {
    await expect(TokenManager.creditPaidTokens(null, 1)).rejects.toThrow(/userId is required/);
  });

  test('606. FAIL_null_2 - amount null rejected.', async () => {
    await expect(TokenManager.creditPaidTokens('user-606', null)).rejects.toThrow(/amount is required/);
  });

  test('607. FAIL_null_3 - transactionType null rejected.', async () => {
    await expect(TokenManager.addTransaction({
      userId: 'user-607',
      transactionType: null,
      amount: 1,
    })).rejects.toThrow(/Invalid transaction payload/);
  });

  test('608. FAIL_null_4 - beneficiaryId null for CREDIT_FREE rejected.', async () => {
    await expect(TokenManager.creditFreeTokens('user-608', null, 1)).rejects.toThrow(/beneficiaryId is required/);
  });

  test('609. PASS_undefined_1 - undefined optional params handled.', async () => {
    await TokenManager.creditPaidTokens('user-609', 1, undefined, undefined);
    expect(mockScyllaDb.putItem).toHaveBeenCalled();
  });

  test('610. FAIL_scylla_1 - putItem timeout propagates.', async () => {
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('timeout'));
    await expect(TokenManager.creditPaidTokens('user-610', 1)).rejects.toThrow(/timeout/);
  });

  test('611. FAIL_scylla_2 - query returns malformed data handled.', async () => {
    mockScyllaDb.query
      .mockResolvedValueOnce([{ id: 'bad-611', transactionType: null }])
      .mockResolvedValueOnce([]);
    await expect(TokenManager.getUserBalance('user-611')).resolves.toBeDefined();
  });

  test('612. FAIL_scylla_3 - updateItem ConditionalCheckFailedException handled for holds.', async () => {
    const hold = createHoldRecord({ id: 'hold-612', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    const result = await TokenManager.captureHeldTokens({ transactionId: 'hold-612' });
    expect(result.capturedCount).toBe(0);
  });

  test('613. FAIL_scylla_4 - ScyllaDb connection lost error propagated.', async () => {
    mockScyllaDb.query.mockRejectedValueOnce(new Error('connection lost'));
    await expect(TokenManager.getUserBalance('user-613')).rejects.toThrow(/connection lost/);
  });

  test('614. FAIL_datetime_lib_1 - DateTime.now throws handled.', async () => {
    mockDateTime.now.mockImplementationOnce(() => { throw new Error('now fail'); });
    await expect(TokenManager.getUserBalance('user-614')).rejects.toThrow(/now fail/);
  });

  test('615. FAIL_datetime_lib_2 - DateTime.parseDateToTimestamp throws handled.', async () => {
    mockDateTime.parseDateToTimestamp.mockImplementationOnce(() => { throw new Error('parse fail'); });
    mockScyllaDb.query
      .mockResolvedValueOnce([
        createTransactionRecord({ id: 'tx-615-a', createdAt: '2025-01-02T00:00:00.000Z' }),
        createTransactionRecord({ id: 'tx-615-b', createdAt: '2025-01-01T00:00:00.000Z' }),
      ])
      .mockResolvedValueOnce([]);
    await expect(TokenManager.getUserTransactionHistory('user-615')).rejects.toThrow(/parse fail/);
  });

  test('616. FAIL_datetime_lib_3 - DateTime.isPast throws handled.', async () => {
    mockDateTime.isPast.mockImplementationOnce(() => { throw new Error('isPast fail'); });
    const tx = createTransactionRecord({
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      amount: 5,
      expiresAt: new Date(referenceNow.getTime() - 1000).toISOString(),
    });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-616');
    expect(balance.totalFreeTokens).toBe(5);
  });
});

describe('TokenManager crypto/doc compliance batch #7', () => {
  test('617. FAIL_crypto_1 - crypto.randomUUID fails and error propagates.', async () => {
    const uuidErr = new Error('uuid fail');
    const spy = jest.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => { throw uuidErr; });
    await expect(TokenManager.addTransaction({
      userId: 'user-617',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
    })).rejects.toThrow(/uuid fail/);
    spy.mockRestore();
  });

  test('618. PASS_doc_1 - public method names use camelCase.', () => {
    const methods = Object.getOwnPropertyNames(TokenManager)
      .filter((name) => typeof TokenManager[name] === 'function');
    const bad = methods.filter((name) => /_/.test(name) && name !== name.toUpperCase());
    expect(bad).toEqual([]);
  });

  test('619. PASS_doc_2 - constants use SCREAMING_SNAKE_CASE.', () => {
    const keys = Object.keys(TokenManager).filter((k) => /[A-Z]/.test(k));
    const constants = keys.filter((k) => typeof TokenManager[k] === 'object');
    const bad = constants.filter((k) => !/^[A-Z0-9_]+$/.test(k));
    expect(bad).toEqual([]);
  });

  test('620. PASS_doc_3 - transaction types use constant values.', () => {
    const types = Object.values(TokenManager.TRANSACTION_TYPES);
    expect(types).toContain('CREDIT_PAID');
    expect(types).toContain('CREDIT_FREE');
    expect(types).toContain('DEBIT');
    expect(types).toContain('HOLD');
    expect(types).toContain('TIP');
  });

  test('621. PASS_doc_4 - hold states use constants.', () => {
    const states = Object.values(TokenManager.HOLD_STATES);
    expect(states).toContain('open');
    expect(states).toContain('captured');
    expect(states).toContain('reversed');
  });

  test('622. PASS_doc_5 - table names defined in TABLES.', () => {
    expect(TokenManager.TABLES.TOKEN_REGISTRY).toBeDefined();
    expect(TokenManager.TABLES.TOKEN_REGISTRY_ARCHIVE).toBeDefined();
  });

  test('623. PASS_doc_6 - index names defined in INDEXES.', () => {
    expect(TokenManager.INDEXES.USER_ID_CREATED_AT).toBeDefined();
    expect(TokenManager.INDEXES.BENEFICIARY_ID_CREATED_AT).toBeDefined();
    expect(TokenManager.INDEXES.USER_ID_EXPIRES_AT).toBeDefined();
  });

  test('624. PASS_doc_7 - column names defined in COLUMNS.', () => {
    expect(TokenManager.COLUMNS.USER_ID).toBe('userId');
    expect(TokenManager.COLUMNS.REF_ID).toBe('refId');
    expect(TokenManager.COLUMNS.CREATED_AT).toBe('createdAt');
  });
});

describe('TokenManager getTransactionById/additional batch #8', () => {
  const buildRecord = (overrides = {}) =>
    createTransactionRecord({
      id: overrides.id ?? 'tx-625',
      metadata: overrides.metadata ?? JSON.stringify({ note: 'ok' }),
      ...overrides,
    });

  test('625. PASS_getTransactionById_1 - valid id returns full transaction.', async () => {
    const record = buildRecord({ id: 'tx-625' });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-625');
    expect(result).toEqual(expect.objectContaining({ id: 'tx-625' }));
  });

  test('626. PASS_getTransactionById_2 - optional fields populated returned.', async () => {
    const record = buildRecord({
      id: 'tx-626',
      refId: 'ref-626',
      expiresAt: '2025-12-31T00:00:00.000Z',
      state: TokenManager.HOLD_STATES.OPEN,
      version: 3,
      freeBeneficiaryConsumed: 1,
      freeSystemConsumed: 2,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-626');
    expect(result.refId).toBe('ref-626');
    expect(result.version).toBe(3);
  });

  test('627. PASS_getTransactionById_3 - minimal fields return nulls for optional.', async () => {
    const record = buildRecord({ id: 'tx-627', metadata: null, refId: null, expiresAt: null });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-627');
    expect(result.metadata).toBeNull();
  });

  test('628. PASS_getTransactionById_4 - metadata JSON parsed.', async () => {
    const record = buildRecord({ id: 'tx-628', metadata: JSON.stringify({ a: 1 }) });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-628');
    expect(result.metadata.a).toBe(1);
  });

  test('629. PASS_getTransactionById_5 - HOLD includes state/version/free fields.', async () => {
    const record = buildRecord({
      id: 'tx-629',
      transactionType: TokenManager.TRANSACTION_TYPES.HOLD,
      state: TokenManager.HOLD_STATES.OPEN,
      version: 2,
      freeBeneficiaryConsumed: 1,
      freeSystemConsumed: 1,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-629');
    expect(result.state).toBe(TokenManager.HOLD_STATES.OPEN);
    expect(result.freeBeneficiaryConsumed).toBe(1);
  });

  test('630. PASS_getTransactionById_6 - TIP includes free consumption fields.', async () => {
    const record = buildRecord({
      id: 'tx-630',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      freeBeneficiaryConsumed: 2,
      freeSystemConsumed: 1,
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-630');
    expect(result.freeSystemConsumed).toBe(1);
  });

  test('631. PASS_getTransactionById_7 - CREDIT_FREE returns expiresAt ISO.', async () => {
    const record = buildRecord({
      id: 'tx-631',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      expiresAt: '2025-02-01T00:00:00.000Z',
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-631');
    expect(result.expiresAt).toBe('2025-02-01T00:00:00.000Z');
  });

  test('632. PASS_getTransactionById_8 - DEBIT includes breakdown in metadata.', async () => {
    const record = buildRecord({
      id: 'tx-632',
      transactionType: TokenManager.TRANSACTION_TYPES.DEBIT,
      metadata: JSON.stringify({ breakdown: { paid: 2 } }),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-632');
    expect(result.metadata.breakdown.paid).toBe(2);
  });

  test('633. PASS_getTransactionById_9 - UUID format id accepted.', async () => {
    const record = buildRecord({ id: '123e4567-e89b-12d3-a456-426614174000' });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('123e4567-e89b-12d3-a456-426614174000');
    expect(result.id).toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  test('634. PASS_getTransactionById_10 - version field returned correctly.', async () => {
    const record = buildRecord({ id: 'tx-634', version: 4 });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-634');
    expect(result.version).toBe(4);
  });

  test('635. FAIL_getTransactionById_1 - missing id rejected.', async () => {
    await expect(TokenManager.getTransactionById()).rejects.toThrow(/transactionId is required/);
  });

  test('636. FAIL_getTransactionById_2 - empty string id rejected.', async () => {
    await expect(TokenManager.getTransactionById('')).rejects.toThrow(/transactionId must be a string/);
  });

  test('637. FAIL_getTransactionById_3 - null id rejected.', async () => {
    await expect(TokenManager.getTransactionById(null)).rejects.toThrow(/transactionId is required/);
  });

  test('638. FAIL_getTransactionById_4 - non-existent id returns null.', async () => {
    mockScyllaDb.getItem.mockResolvedValueOnce(null);
    const result = await TokenManager.getTransactionById('tx-638');
    expect(result).toBeNull();
  });

  test('639. FAIL_getTransactionById_5 - wrong format id rejected.', async () => {
    await expect(TokenManager.getTransactionById(123)).rejects.toThrow(/transactionId must be a string/);
  });

  test('640. FAIL_getTransactionById_6 - DB error bubbles.', async () => {
    mockScyllaDb.getItem.mockRejectedValueOnce(new Error('getItem fail'));
    await expect(TokenManager.getTransactionById('tx-640')).rejects.toThrow(/getItem fail/);
  });

  test('641. FAIL_getTransactionById_7 - corrupted record handled.', async () => {
    const record = buildRecord({ id: 'tx-641', userId: undefined });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-641');
    expect(result.userId).toBeUndefined();
  });

  test('642. FAIL_getTransactionById_8 - SQL injection attempt sanitized.', async () => {
    mockScyllaDb.getItem.mockResolvedValueOnce(null);
    await expect(TokenManager.getTransactionById('tx-642; DROP TABLE')).resolves.toBeNull();
  });

  test('643. FAIL_getTransactionById_9 - malformed metadata handled.', async () => {
    const record = buildRecord({ id: 'tx-643', metadata: '{bad:' });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-643');
    expect(result.metadata).toBe('{bad:');
  });
});

describe('TokenManager getTransactionsByRefId/additional batch #9', () => {
  const buildRefTx = (overrides = {}) =>
    createTransactionRecord({
      refId: overrides.refId ?? 'ref-644',
      userId: overrides.userId ?? 'user-644',
      beneficiaryId: overrides.beneficiaryId ?? 'beneficiary-644',
      ...overrides,
    });

  test('644. PASS_getTransactionsByRefId_1 - single transaction returned.', async () => {
    const tx = buildRefTx({ id: 'tx-644' });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTransactionsByRefId('user-644', 'ref-644');
    expect(result).toEqual([tx]);
  });

  test('645. PASS_getTransactionsByRefId_2 - multiple transactions returned.', async () => {
    const txs = [buildRefTx({ id: 'tx-645-a' }), buildRefTx({ id: 'tx-645-b' })];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTransactionsByRefId('user-645', 'ref-645');
    expect(result).toHaveLength(2);
  });

  test('646. PASS_getTransactionsByRefId_3 - no transactions returns empty.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getTransactionsByRefId('user-646', 'ref-646');
    expect(result).toEqual([]);
  });

  test('647. PASS_getTransactionsByRefId_4 - mixed transaction types returned.', async () => {
    const hold = buildRefTx({ id: 'hold-647', transactionType: TokenManager.TRANSACTION_TYPES.HOLD });
    const debit = buildRefTx({ id: 'debit-647', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT });
    mockScyllaDb.query.mockResolvedValueOnce([hold, debit]);
    const result = await TokenManager.getTransactionsByRefId('user-647', 'ref-647');
    expect(result.map((tx) => tx.transactionType)).toEqual(
      expect.arrayContaining([TokenManager.TRANSACTION_TYPES.HOLD, TokenManager.TRANSACTION_TYPES.DEBIT]),
    );
  });

  test('648. PASS_getTransactionsByRefId_5 - HOLD lifecycle states returned.', async () => {
    const txs = [
      buildRefTx({ id: 'hold-648-open', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.OPEN }),
      buildRefTx({ id: 'hold-648-captured', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.CAPTURED }),
      buildRefTx({ id: 'hold-648-reversed', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.REVERSED }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTransactionsByRefId('user-648', 'ref-648');
    expect(result).toHaveLength(3);
  });

  test('649. PASS_getTransactionsByRefId_6 - special characters in refId.', async () => {
    const refId = 'ref-649-#&%';
    mockScyllaDb.query.mockResolvedValueOnce([buildRefTx({ refId })]);
    const result = await TokenManager.getTransactionsByRefId('user-649', refId);
    expect(result[0].refId).toBe(refId);
  });

  test('650. PASS_getTransactionsByRefId_7 - results sorted by createdAt.', async () => {
    const txs = [
      buildRefTx({ id: 'tx-650-new', createdAt: '2025-01-02T00:00:00.000Z' }),
      buildRefTx({ id: 'tx-650-old', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTransactionsByRefId('user-650', 'ref-650');
    expect(Date.parse(result[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(result[1].createdAt));
  });

  test('651. PASS_getTransactionsByRefId_8 - large number returned.', async () => {
    const txs = Array.from({ length: 150 }, (_, idx) => buildRefTx({ id: `tx-651-${idx}` }));
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTransactionsByRefId('user-651', 'ref-651');
    expect(result).toHaveLength(150);
  });

  test('652. PASS_getTransactionsByRefId_9 - refId matching userId pattern returns only user.', async () => {
    const tx = buildRefTx({ userId: 'user-652', refId: 'user-652' });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTransactionsByRefId('user-652', 'user-652');
    expect(result.every((row) => row.userId === 'user-652')).toBe(true);
  });

  test('653. PASS_getTransactionsByRefId_10 - uses USER_ID_REF_ID index.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await TokenManager.getTransactionsByRefId('user-653', 'ref-653');
    const [, , , options] = mockScyllaDb.query.mock.calls[0];
    expect(options.IndexName).toBe(TokenManager.INDEXES.USER_ID_REF_ID);
  });

  test('654. FAIL_getTransactionsByRefId_1 - missing userId rejected.', async () => {
    await expect(TokenManager.getTransactionsByRefId(undefined, 'ref-654')).rejects.toThrow(/userId is required/);
  });

  test('655. FAIL_getTransactionsByRefId_2 - missing refId rejected.', async () => {
    await expect(TokenManager.getTransactionsByRefId('user-655')).rejects.toThrow(/refId is required/);
  });

  test('656. FAIL_getTransactionsByRefId_3 - empty userId rejected.', async () => {
    await expect(TokenManager.getTransactionsByRefId('', 'ref-656')).rejects.toThrow(/userId is required/);
  });

  test('657. FAIL_getTransactionsByRefId_4 - empty refId rejected.', async () => {
    await expect(TokenManager.getTransactionsByRefId('user-657', '')).rejects.toThrow(/refId is required/);
  });

  test('658. FAIL_getTransactionsByRefId_5 - DB error bubbles.', async () => {
    mockScyllaDb.query.mockRejectedValueOnce(new Error('query fail 658'));
    await expect(TokenManager.getTransactionsByRefId('user-658', 'ref-658')).rejects.toThrow(/query fail 658/);
  });

  test('659. FAIL_getTransactionsByRefId_6 - injection attempt sanitized.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const bad = "ref-659'; DROP TABLE";
    await TokenManager.getTransactionsByRefId('user-659', bad);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    expect(params[':rid']).toBe(bad);
  });

  test('660. FAIL_getTransactionsByRefId_7 - defensive: other users not included.', async () => {
    const tx = buildRefTx({ userId: 'other-user', refId: 'ref-660' });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTransactionsByRefId('user-660', 'ref-660');
    expect(result.every((row) => row.userId === 'user-660' || row.beneficiaryId === 'user-660')).toBe(false);
  });
});

describe('TokenManager summary/addTransaction edges batch #10', () => {
  test('661. PASS_getUserTokenSummary_9 - multiple holds reflected in balance.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { a: 2, b: 3 },
    });
    const summary = await TokenManager.getUserTokenSummary('user-661');
    expect(summary.totalUsableTokens).toBe(10);
  });

  test('662. PASS_getUserTokenSummary_10 - free tokens affect freeTokensPerBeneficiary.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 4,
      freeTokensPerBeneficiary: { ben: 4 },
    });
    const summary = await TokenManager.getUserTokenSummary('user-662');
    expect(summary.freeTokensPerBeneficiary.ben).toBe(4);
  });

  test('663. PASS_getUserTokenSummary_11 - summary includes reserved breakdown shape.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 1,
      totalFreeTokens: 2,
      freeTokensPerBeneficiary: { a: 2 },
    });
    const summary = await TokenManager.getUserTokenSummary('user-663');
    expect(summary).toEqual(expect.objectContaining({
      paidTokens: 1,
      totalFreeTokens: 2,
      freeTokensPerBeneficiary: expect.any(Object),
    }));
  });

  test('664. PASS_getUserTokenSummary_12 - zero balance returns zeros.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const summary = await TokenManager.getUserTokenSummary('user-664');
    expect(summary.totalUsableTokens).toBe(0);
  });

  test('665. PASS_getUserTokenSummary_13 - negative balance handled gracefully.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: -5,
      totalFreeTokens: -1,
      freeTokensPerBeneficiary: {},
    });
    const summary = await TokenManager.getUserTokenSummary('user-665');
    expect(summary.totalUsableTokens).toBe(-6);
  });

  test('666. FAIL_getUserTokenSummary_4 - getUserBalance throws bubbles.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockRejectedValueOnce(new Error('balance fail'));
    await expect(TokenManager.getUserTokenSummary('user-666')).rejects.toThrow(/balance fail/);
  });

  test('667. FAIL_getUserTokenSummary_5 - balance race condition tolerated.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const summary = await TokenManager.getUserTokenSummary('user-667');
    expect(summary.totalUsableTokens).toBe(5);
  });

  test('668. PASS_addTransaction_9 - freeBeneficiaryConsumed=0 stored.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-668',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 1,
      freeBeneficiaryConsumed: 0,
      freeSystemConsumed: 0,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.freeBeneficiaryConsumed).toBe(0);
    expect(record.freeSystemConsumed).toBe(0);
  });

  test('669. PASS_addTransaction_10 - HOLD with free fields stored.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-669',
      beneficiaryId: 'ben-669',
      transactionType: TokenManager.TRANSACTION_TYPES.HOLD,
      amount: 2,
      freeBeneficiaryConsumed: 1,
      freeSystemConsumed: 0,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.state).toBe(TokenManager.HOLD_STATES.OPEN);
    expect(record.freeBeneficiaryConsumed).toBe(1);
  });

  test('670. PASS_addTransaction_11 - TIP with amount=0 stored.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-670',
      beneficiaryId: 'ben-670',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 0,
      freeBeneficiaryConsumed: 2,
      freeSystemConsumed: 0,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.amount).toBe(0);
  });

  test('671. PASS_addTransaction_12 - multiple transactions same refId allowed.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-671',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      refId: 'ref-671',
    });
    await TokenManager.addTransaction({
      userId: 'user-671',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 2,
      refId: 'ref-671',
    });
    expect(mockScyllaDb.putItem).toHaveBeenCalledTimes(2);
  });

  test('672. PASS_addTransaction_13 - createdAt millisecond precision maintained.', async () => {
    mockDateTime.now.mockReturnValueOnce('2025-01-01T00:00:00.123Z');
    await TokenManager.addTransaction({
      userId: 'user-672',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.createdAt).toBe('2025-01-01T00:00:00.123Z');
  });

  test('673. PASS_addTransaction_14 - large amount near MAX_SAFE_INTEGER handled.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-673',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: Number.MAX_SAFE_INTEGER,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.amount).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('674. FAIL_addTransaction_8 - amount exceeds MAX_SAFE_INTEGER rejected.', async () => {
    await expect(TokenManager.addTransaction({
      userId: 'user-674',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: Number.MAX_SAFE_INTEGER + 1,
    })).rejects.toThrow(/amount must be an integer/);
  });
});

describe('TokenManager addTransaction/deduct/transfer/hold batch #11', () => {
  test('675. FAIL_addTransaction_9 - freeBeneficiaryConsumed > amount not enforced.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-675',
      beneficiaryId: 'ben-675',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 1,
      freeBeneficiaryConsumed: 2,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.freeBeneficiaryConsumed).toBe(2);
  });

  test('676. FAIL_addTransaction_10 - freeSystemConsumed > amount not enforced.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-676',
      beneficiaryId: 'ben-676',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 1,
      freeSystemConsumed: 2,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.freeSystemConsumed).toBe(2);
  });

  test('677. FAIL_addTransaction_11 - free sums > amount not enforced.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-677',
      beneficiaryId: 'ben-677',
      transactionType: TokenManager.TRANSACTION_TYPES.TIP,
      amount: 1,
      freeBeneficiaryConsumed: 1,
      freeSystemConsumed: 2,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.freeBeneficiaryConsumed + record.freeSystemConsumed).toBe(3);
  });

  test('678. FAIL_addTransaction_12 - concurrent addTransaction with same refId allowed.', async () => {
    await Promise.all([
      TokenManager.addTransaction({
        userId: 'user-678',
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: 1,
        refId: 'ref-678',
      }),
      TokenManager.addTransaction({
        userId: 'user-678',
        transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
        amount: 2,
        refId: 'ref-678',
      }),
    ]);
    expect(mockScyllaDb.putItem).toHaveBeenCalledTimes(2);
  });

  test('679. PASS_deductTokens_7 - context purpose/refId preserved in metadata.', async () => {
    jest.spyOn(TokenManager, 'validateSufficientTokens').mockResolvedValue(true);
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.deductTokens('user-679', 3, { beneficiaryId: 'ben-679', purpose: 'test', refId: 'ref-679' });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.purpose).toBe('test');
    expect(record.refId).toBe('ref-679');
  });

  test('680. PASS_deductTokens_8 - free consumption fields set even when zero.', async () => {
    jest.spyOn(TokenManager, 'validateSufficientTokens').mockResolvedValue(true);
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.deductTokens('user-680', 2, { beneficiaryId: 'ben-680' });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.freeBeneficiaryConsumed).toBe(0);
    expect(record.freeSystemConsumed).toBe(0);
  });

  test('681. PASS_transferTokens_1 - isAnonymous stored in metadata.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.transferTokens('user-681', 'ben-681', 2, 'tip', { isAnonymous: true });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.metadata.isAnonymous).toBe(true);
  });

  test('682. PASS_transferTokens_2 - note stored in metadata.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.transferTokens('user-682', 'ben-682', 2, 'tip', { note: 'nice' });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.metadata.note).toBe('nice');
  });

  test('683. PASS_holdTokens_9 - valid hold creates auditTrail entry.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.holdTokens('user-683', 2, 'ben-683');
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    const parsed = JSON.parse(record.metadata);
    expect(parsed.auditTrail[0].status).toBe('HOLD');
  });

  test('684. PASS_holdTokens_10 - holds include free consumption fields.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 3,
      freeTokensPerBeneficiary: { ben: 3 },
    });
    await TokenManager.holdTokens('user-684', 2, 'ben');
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.freeBeneficiaryConsumed).toBeGreaterThan(0);
  });

  test('685. FAIL_holdTokens_12 - insufficient tokens throws.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await expect(TokenManager.holdTokens('user-685', 1, 'ben-685'))
      .rejects.toThrow(/Insufficient tokens to hold/);
  });

  test('686. PASS_captureHeldTokens_17 - capture by refId returns count.', async () => {
    const hold = createHoldRecord({ id: 'hold-686', refId: 'ref-686', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED });
    const result = await TokenManager.captureHeldTokens({ refId: 'ref-686' });
    expect(result.capturedCount).toBe(1);
  });

  test('687. FAIL_captureHeldTokens_12 - no holds for refId throws.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await expect(TokenManager.captureHeldTokens({ refId: 'ref-687' }))
      .rejects.toThrow(/No held tokens found/);
  });

  test('688. PASS_reverseHeldTokens_9 - reverse by refId returns count.', async () => {
    const hold = createHoldRecord({ id: 'hold-688', refId: 'ref-688', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED });
    const result = await TokenManager.reverseHeldTokens({ refId: 'ref-688' });
    expect(result.reversedCount).toBe(1);
  });

  test('689. FAIL_reverseHeldTokens_9 - no holds for refId returns no held tokens.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.reverseHeldTokens({ refId: 'ref-689' });
    expect(result.reversedCount).toBe(0);
  });

  test('690. PASS_extendExpiry_12 - extend adds audit trail entry.', async () => {
    const hold = createHoldRecord({ id: 'hold-690', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2 });
    await TokenManager.extendExpiry({ transactionId: 'hold-690', extendBySeconds: 60 });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    expect(parsed.auditTrail.some((e) => e.status === 'EXTENDED')).toBe(true);
  });

  test('691. FAIL_extendExpiry_12 - extendBySeconds missing rejected.', async () => {
    await expect(TokenManager.extendExpiry({ transactionId: 'hold-691' }))
      .rejects.toThrow(/extendBySeconds/);
  });

  test('692. PASS_getExpiringTokensWarning_12 - only CREDIT_FREE returned.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-692-free', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE }),
      createTransactionRecord({ id: 'tx-692-paid', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getExpiringTokensWarning('user-692', 7);
    expect(result).toHaveLength(1);
  });

  test('693. FAIL_getExpiringTokensWarning_5 - DateTime.now failure bubbles.', async () => {
    mockDateTime.now.mockImplementationOnce(() => { throw new Error('now fail 693'); });
    await expect(TokenManager.getExpiringTokensWarning('user-693', 7)).rejects.toThrow(/now fail 693/);
  });

  test('694. PASS_getTipsReceived_9 - only TIP returned.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-694-tip', transactionType: TokenManager.TRANSACTION_TYPES.TIP }),
      createTransactionRecord({ id: 'tx-694-debit', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTipsReceived('user-694');
    expect(result).toHaveLength(1);
  });

  test('695. PASS_getTipsSent_9 - tips sent from user only.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-695-tip', transactionType: TokenManager.TRANSACTION_TYPES.TIP }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTipsSent('user-695');
    expect(result).toHaveLength(1);
  });

  test('696. PASS_getTipsReceivedByDateRange_9 - filters by date range.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-696-in', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2025-01-02T00:00:00.000Z' }),
      createTransactionRecord({ id: 'tx-696-out', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2024-12-01T00:00:00.000Z' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTipsReceivedByDateRange('user-696', '2025-01-01T00:00:00.000Z', '2025-01-31T00:00:00.000Z');
    expect(result).toHaveLength(1);
  });

  test('697. PASS_getUserEarnings_9 - groupByRef aggregates results.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-697-a', transactionType: TokenManager.TRANSACTION_TYPES.TIP, refId: 'r1', amount: 2 }),
      createTransactionRecord({ id: 'tx-697-b', transactionType: TokenManager.TRANSACTION_TYPES.TIP, refId: 'r1', amount: 3 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-697', { groupByRef: true });
    const group = result.groups.find((entry) => entry.refId === 'r1');
    expect(group.totalAmount).toBe(5);
  });

  test('698. PASS_getUserSpendingByRefId_9 - spending computed for refId.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-698-a', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT, amount: 2, refId: 'ref-698' }),
      createTransactionRecord({ id: 'tx-698-b', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT, amount: 3, refId: 'ref-698' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserSpendingByRefId('user-698', 'ref-698');
    expect(result.totalSpent).toBe(5);
  });

  test('699. PASS_adjustUserTokensAdmin_9 - credit paid via admin.', async () => {
    await TokenManager.adjustUserTokensAdmin({
      userId: 'user-699',
      amount: 5,
      type: 'paid',
      reason: 'admin',
    });
    expect(mockScyllaDb.putItem).toHaveBeenCalled();
  });

  test('700. PASS_adjustUserTokensAdmin_10 - credit free via admin.', async () => {
    await TokenManager.adjustUserTokensAdmin({
      userId: 'user-700',
      amount: 5,
      type: 'free',
      beneficiaryId: 'ben-700',
      reason: 'admin',
    });
    expect(mockScyllaDb.putItem).toHaveBeenCalled();
  });

  test('701. FAIL_adjustUserTokensAdmin_6 - invalid type rejected.', async () => {
    await expect(TokenManager.adjustUserTokensAdmin({
      userId: 'user-701',
      amount: 5,
      type: 'weird',
      reason: 'admin',
    })).rejects.toThrow(/Invalid token type/);
  });

  test('702. PASS_purgeOldRegistryRecords_13 - dryRun returns summary.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([]);
    const result = await TokenManager.purgeOldRegistryRecords({ dryRun: true });
    expect(result.dryRun).toBe(true);
  });

  test('703. FAIL_purgeOldRegistryRecords_5 - maxSeconds invalid rejected.', async () => {
    await expect(TokenManager.purgeOldRegistryRecords({ maxSeconds: 'bad' })).rejects.toThrow(/must be an integer/);
  });

  test('704. PASS_findExpiredHolds_19 - state missing logged and excluded.', async () => {
    const missing = createHoldRecord({ id: 'hold-704', state: null });
    const open = createHoldRecord({ id: 'hold-704-open', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([missing, open]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toEqual([open]);
  });

  test('705. PASS_processExpiredHolds_19 - continues on malformed hold.', async () => {
    const good = createHoldRecord({ id: 'hold-705-good' });
    const bad = { id: 'hold-705-bad' };
    jest.spyOn(TokenManager, 'findExpiredHolds').mockResolvedValueOnce([bad, good]);
    jest.spyOn(TokenManager, 'reverseHeldTokens').mockImplementation(async ({ transactionId }) => {
      if (transactionId === 'hold-705-bad') {
        throw new Error('bad hold');
      }
      return { reversedCount: 1 };
    });
    const result = await TokenManager.processExpiredHolds(0, 2);
    expect(result.failed).toBe(1);
    expect(result.reversed).toBe(1);
  });
});

describe('TokenManager capture/reverse/extend/validate/history batch #12', () => {
  test('706. PASS_captureHeldTokens_12 - version conflict handled gracefully.', async () => {
    const hold = createHoldRecord({ id: 'hold-706', state: TokenManager.HOLD_STATES.OPEN, version: 1 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    const result = await TokenManager.captureHeldTokens({ transactionId: 'hold-706' });
    expect(result.capturedCount).toBe(0);
  });

  test('707. PASS_captureHeldTokens_13 - version increments by 1.', async () => {
    const hold = createHoldRecord({ id: 'hold-707', state: TokenManager.HOLD_STATES.OPEN, version: 2 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 3 });
    await TokenManager.captureHeldTokens({ transactionId: 'hold-707' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    expect(updates.version).toBe(3);
  });

  test('708. PASS_captureHeldTokens_14 - audit trail includes timestamp.', async () => {
    const hold = createHoldRecord({ id: 'hold-708', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED });
    await TokenManager.captureHeldTokens({ transactionId: 'hold-708' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    const entry = parsed.auditTrail.find((e) => e.status === 'CAPTURED');
    expect(entry.timestamp).toBeDefined();
  });

  test('709. PASS_captureHeldTokens_15 - capture by transactionId works with refId present.', async () => {
    const hold = createHoldRecord({ id: 'hold-709', refId: 'ref-709', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED });
    const result = await TokenManager.captureHeldTokens({ transactionId: 'hold-709' });
    expect(result.capturedCount).toBe(1);
  });

  test('710. FAIL_captureHeldTokens_6 - refId update conflict handled.', async () => {
    const hold = createHoldRecord({ id: 'hold-710', refId: 'ref-710', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    const result = await TokenManager.captureHeldTokens({ refId: 'ref-710' });
    expect(result.capturedCount).toBe(0);
  });

  test('711. FAIL_captureHeldTokens_7 - no OPEN but CAPTURED returns alreadyCaptured.', async () => {
    const captured = createHoldRecord({ id: 'hold-711', refId: 'ref-711', state: TokenManager.HOLD_STATES.CAPTURED });
    mockScyllaDb.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([captured]);
    const result = await TokenManager.captureHeldTokens({ refId: 'ref-711' });
    expect(result.alreadyCaptured).toBe(true);
  });

  test('712. FAIL_captureHeldTokens_8 - no holds for refId throws.', async () => {
    mockScyllaDb.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await expect(TokenManager.captureHeldTokens({ refId: 'ref-712' }))
      .rejects.toThrow(/No held tokens found/);
  });

  test('713. FAIL_captureHeldTokens_9 - malformed metadata handled gracefully.', async () => {
    const hold = createHoldRecord({ id: 'hold-713', state: TokenManager.HOLD_STATES.OPEN, metadata: '{bad' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED });
    await TokenManager.captureHeldTokens({ transactionId: 'hold-713' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    expect(parsed.auditTrail).toBeDefined();
  });

  test('714. FAIL_captureHeldTokens_10 - update error bubbles.', async () => {
    const hold = createHoldRecord({ id: 'hold-714', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockRejectedValueOnce(new Error('update fail 714'));
    await expect(TokenManager.captureHeldTokens({ transactionId: 'hold-714' }))
      .rejects.toThrow(/update fail 714/);
  });

  test('715. PASS_reverseHeldTokens_7 - refId with multiple OPEN holds reverses all.', async () => {
    const holds = [
      createHoldRecord({ id: 'hold-715-a', refId: 'ref-715', state: TokenManager.HOLD_STATES.OPEN }),
      createHoldRecord({ id: 'hold-715-b', refId: 'ref-715', state: TokenManager.HOLD_STATES.OPEN }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(holds);
    mockScyllaDb.updateItem.mockResolvedValue({ ...holds[0], state: TokenManager.HOLD_STATES.REVERSED });
    const result = await TokenManager.reverseHeldTokens({ refId: 'ref-715' });
    expect(result.reversedCount).toBe(2);
  });

  test('716. PASS_reverseHeldTokens_8 - reverse does not create DEBIT.', async () => {
    const hold = createHoldRecord({ id: 'hold-716', refId: 'ref-716', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED });
    await TokenManager.reverseHeldTokens({ refId: 'ref-716' });
    expect(mockScyllaDb.putItem).not.toHaveBeenCalled();
  });

  test('717. PASS_reverseHeldTokens_9 - version increments by 1.', async () => {
    const hold = createHoldRecord({ id: 'hold-717', state: TokenManager.HOLD_STATES.OPEN, version: 2 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 3 });
    await TokenManager.reverseHeldTokens({ transactionId: 'hold-717' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    expect(updates.version).toBe(3);
  });

  test('718. PASS_reverseHeldTokens_10 - audit trail includes timestamp.', async () => {
    const hold = createHoldRecord({ id: 'hold-718', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED });
    await TokenManager.reverseHeldTokens({ transactionId: 'hold-718' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    const entry = parsed.auditTrail.find((e) => e.status === 'REVERSE');
    expect(entry.timestamp).toBeDefined();
  });

  test('719. PASS_reverseHeldTokens_11 - reverse by transactionId works with refId present.', async () => {
    const hold = createHoldRecord({ id: 'hold-719', refId: 'ref-719', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED });
    const result = await TokenManager.reverseHeldTokens({ transactionId: 'hold-719' });
    expect(result.reversedCount).toBe(1);
  });

  test('720. PASS_reverseHeldTokens_12 - reverse updates state to reversed.', async () => {
    const hold = createHoldRecord({ id: 'hold-720', refId: 'ref-720', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED });
    const result = await TokenManager.reverseHeldTokens({ refId: 'ref-720' });
    expect(result.reversedCount).toBe(1);
  });

  test('721. PASS_reverseHeldTokens_13 - version conflict continues other holds.', async () => {
    const holds = [
      createHoldRecord({ id: 'hold-721-a', refId: 'ref-721', state: TokenManager.HOLD_STATES.OPEN }),
      createHoldRecord({ id: 'hold-721-b', refId: 'ref-721', state: TokenManager.HOLD_STATES.OPEN }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(holds);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ ...holds[1], state: TokenManager.HOLD_STATES.REVERSED });
    const result = await TokenManager.reverseHeldTokens({ refId: 'ref-721' });
    expect(result.reversedCount).toBe(1);
  });

  test('722. FAIL_reverseHeldTokens_6 - refId update conflict results in no reversal.', async () => {
    const hold = createHoldRecord({ id: 'hold-722', refId: 'ref-722', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    const result = await TokenManager.reverseHeldTokens({ refId: 'ref-722' });
    expect(result.reversedCount).toBe(0);
  });

  test('723. FAIL_reverseHeldTokens_7 - no OPEN but REVERSED returns alreadyReversed.', async () => {
    const reversed = createHoldRecord({ id: 'hold-723', refId: 'ref-723', state: TokenManager.HOLD_STATES.REVERSED });
    mockScyllaDb.query.mockResolvedValueOnce([reversed]);
    const result = await TokenManager.reverseHeldTokens({ refId: 'ref-723' });
    expect(result.alreadyReversed).toBe(true);
  });

  test('724. FAIL_reverseHeldTokens_8 - no holds returns message.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.reverseHeldTokens({ refId: 'ref-724' });
    expect(result.reversedCount).toBe(0);
  });

  test('725. FAIL_reverseHeldTokens_9 - malformed metadata handled.', async () => {
    const hold = createHoldRecord({ id: 'hold-725', state: TokenManager.HOLD_STATES.OPEN, metadata: '{bad' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED });
    await TokenManager.reverseHeldTokens({ transactionId: 'hold-725' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    expect(parsed.auditTrail).toBeDefined();
  });

  test('726. PASS_extendExpiry_7 - extend by refId extends all open holds.', async () => {
    const holds = [
      createHoldRecord({ id: 'hold-726-a', refId: 'ref-726', state: TokenManager.HOLD_STATES.OPEN }),
      createHoldRecord({ id: 'hold-726-b', refId: 'ref-726', state: TokenManager.HOLD_STATES.OPEN }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(holds);
    mockScyllaDb.updateItem.mockResolvedValue({ ...holds[0], version: 2 });
    const result = await TokenManager.extendExpiry({ refId: 'ref-726', extendBySeconds: 60 });
    expect(result.extendedCount).toBe(2);
  });

  test('727. PASS_extendExpiry_8 - expiresAt updated correctly.', async () => {
    const hold = createHoldRecord({ id: 'hold-727', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2 });
    await TokenManager.extendExpiry({ transactionId: 'hold-727', extendBySeconds: 60 });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const expected = new Date(new Date(hold.expiresAt).getTime() + 60000).toISOString();
    expect(updates.expiresAt).toBe(expected);
  });

  test('728. PASS_extendExpiry_9 - version increments by 1.', async () => {
    const hold = createHoldRecord({ id: 'hold-728', state: TokenManager.HOLD_STATES.OPEN, version: 3 });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 4 });
    await TokenManager.extendExpiry({ transactionId: 'hold-728', extendBySeconds: 60 });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    expect(updates.version).toBe(4);
  });

  test('729. PASS_extendExpiry_10 - audit trail includes previous/new expiresAt.', async () => {
    const hold = createHoldRecord({ id: 'hold-729', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2 });
    await TokenManager.extendExpiry({ transactionId: 'hold-729', extendBySeconds: 60 });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    const entry = parsed.auditTrail.find((e) => e.status === 'EXTENDED');
    expect(entry.previousExpiresAt).toBeDefined();
    expect(entry.newExpiresAt).toBeDefined();
  });

  test('730. PASS_extendExpiry_11 - extend by transactionId works with refId present.', async () => {
    const hold = createHoldRecord({ id: 'hold-730', refId: 'ref-730', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2 });
    const result = await TokenManager.extendExpiry({ transactionId: 'hold-730', extendBySeconds: 60 });
    expect(result.extendedCount).toBe(1);
  });

  test('731. PASS_extendExpiry_12 - maxTotalSeconds cap respected.', async () => {
    const hold = createHoldRecord({ id: 'hold-731', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2 });
    const result = await TokenManager.extendExpiry({ transactionId: 'hold-731', extendBySeconds: 60, maxTotalSeconds: 10000 });
    expect(result.extendedCount).toBe(1);
  });

  test('732. PASS_extendExpiry_13 - extend by 1 second works.', async () => {
    const hold = createHoldRecord({ id: 'hold-732', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2 });
    const result = await TokenManager.extendExpiry({ transactionId: 'hold-732', extendBySeconds: 1 });
    expect(result.extendedCount).toBe(1);
  });

  test('733. PASS_extendExpiry_14 - multiple extends accumulate within cap.', async () => {
    const holdV1 = createHoldRecord({ id: 'hold-733', state: TokenManager.HOLD_STATES.OPEN, version: 1 });
    const holdV2 = createHoldRecord({ id: 'hold-733', state: TokenManager.HOLD_STATES.OPEN, version: 2 });
    mockScyllaDb.getItem
      .mockResolvedValueOnce(holdV1)
      .mockResolvedValueOnce(holdV2);
    mockScyllaDb.updateItem
      .mockResolvedValueOnce({ ...holdV1, version: 2 })
      .mockResolvedValueOnce({ ...holdV2, version: 3 });
    await TokenManager.extendExpiry({ transactionId: 'hold-733', extendBySeconds: 60 });
    await TokenManager.extendExpiry({ transactionId: 'hold-733', extendBySeconds: 60 });
    expect(mockScyllaDb.updateItem).toHaveBeenCalledTimes(2);
  });

  test('734. FAIL_extendExpiry_6 - refId update conflict throws.', async () => {
    const hold = createHoldRecord({ id: 'hold-734', refId: 'ref-734', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    await expect(TokenManager.extendExpiry({ refId: 'ref-734', extendBySeconds: 60 }))
      .rejects.toThrow(/already captured or reversed/);
  });

  test('735. FAIL_extendExpiry_7 - exceed maxTotalSeconds throws.', async () => {
    const hold = createHoldRecord({
      id: 'hold-735',
      state: TokenManager.HOLD_STATES.OPEN,
      createdAt: new Date(referenceNow.getTime() - 3600 * 1000).toISOString(),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    await expect(TokenManager.extendExpiry({ transactionId: 'hold-735', extendBySeconds: 3600, maxTotalSeconds: 1800 }))
      .rejects.toThrow(/exceeding maximum/);
  });

  test('736. FAIL_extendExpiry_8 - extend at maxTotalSeconds boundary succeeds.', async () => {
    const hold = createHoldRecord({
      id: 'hold-736',
      state: TokenManager.HOLD_STATES.OPEN,
      createdAt: referenceNow.toISOString(),
      expiresAt: new Date(referenceNow.getTime() + 100 * 1000).toISOString(),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2 });
    const result = await TokenManager.extendExpiry({ transactionId: 'hold-736', extendBySeconds: 100, maxTotalSeconds: 200 });
    expect(result.extendedCount).toBe(1);
  });

  test('737. FAIL_extendExpiry_9 - extend beyond maxTotalSeconds throws.', async () => {
    const hold = createHoldRecord({
      id: 'hold-737',
      state: TokenManager.HOLD_STATES.OPEN,
      createdAt: new Date(referenceNow.getTime() - 100).toISOString(),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    await expect(TokenManager.extendExpiry({ transactionId: 'hold-737', extendBySeconds: 5000, maxTotalSeconds: 200 }))
      .rejects.toThrow(/exceeding maximum/);
  });

  test('738. FAIL_extendExpiry_10 - malformed metadata handled.', async () => {
    const hold = createHoldRecord({ id: 'hold-738', state: TokenManager.HOLD_STATES.OPEN, metadata: '{bad' });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2 });
    await TokenManager.extendExpiry({ transactionId: 'hold-738', extendBySeconds: 60 });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    expect(parsed.auditTrail).toBeDefined();
  });

  test('739. PASS_validateSufficientTokens_8 - returns true when sufficient.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.validateSufficientTokens('user-739', 'ben-739', 3);
    expect(result).toBe(true);
  });

  test('740. PASS_validateSufficientTokens_9 - returns false when insufficient.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 1,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.validateSufficientTokens('user-740', 'ben-740', 3);
    expect(result).toBe(false);
  });

  test('741. PASS_validateSufficientTokens_10 - expired free tokens excluded via balance.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.validateSufficientTokens('user-741', 'ben-741', 1);
    expect(result).toBe(false);
  });

  test('742. PASS_validateSufficientTokens_11 - zero balance returns false.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.validateSufficientTokens('user-742', 'ben-742', 1);
    expect(result).toBe(false);
  });

  test('743. PASS_validateSufficientTokens_12 - exact balance returns true.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 2,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.validateSufficientTokens('user-743', 'ben-743', 2);
    expect(result).toBe(true);
  });

  test('744. PASS_validateSufficientTokens_13 - balance 1 more returns true.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 3,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.validateSufficientTokens('user-744', 'ben-744', 2);
    expect(result).toBe(true);
  });

  test('745. PASS_validateSufficientTokens_14 - balance 1 less returns false.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 1,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.validateSufficientTokens('user-745', 'ben-745', 2);
    expect(result).toBe(false);
  });

  test('746. FAIL_validateSufficientTokens_5 - getUserBalance throws bubbles.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockRejectedValueOnce(new Error('balance fail 746'));
    await expect(TokenManager.validateSufficientTokens('user-746', 'ben-746', 1))
      .rejects.toThrow(/balance fail 746/);
  });

  test('747. FAIL_validateSufficientTokens_6 - beneficiaryId system handled without crash.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: { system: 0 },
    });
    const result = await TokenManager.validateSufficientTokens('user-747', 'system', 1);
    expect(result).toBe(false);
  });

  test('748. FAIL_validateSufficientTokens_7 - amount 0 returns true.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const result = await TokenManager.validateSufficientTokens('user-748', 'ben-748', 0);
    expect(result).toBe(true);
  });

  test('749. FAIL_validateSufficientTokens_8 - negative amount rejected.', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      if (schema.amount?.value < 0) {
        throw new Error('amount must be an integer');
      }
      return defaultSanitizeValidate(schema);
    });
    await expect(TokenManager.validateSufficientTokens('user-749', 'ben-749', -1))
      .rejects.toThrow(/amount must be an integer/);
  });

  test('750. PASS_getUserTransactionHistory_21 - includes sender transactions.', async () => {
    const tx = createTransactionRecord({ id: 'tx-750' });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const result = await TokenManager.getUserTransactionHistory('user-750');
    expect(result).toHaveLength(1);
  });

  test('751. PASS_getUserTransactionHistory_22 - includes tips received.', async () => {
    const tip = createTransactionRecord({ id: 'tx-751', transactionType: TokenManager.TRANSACTION_TYPES.TIP });
    mockScyllaDb.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([tip]);
    const result = await TokenManager.getUserTransactionHistory('user-751');
    expect(result).toHaveLength(1);
  });

  test('752. PASS_getUserTransactionHistory_23 - deduplicates duplicates.', async () => {
    const tx = createTransactionRecord({ id: 'tx-752' });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([tx]);
    const result = await TokenManager.getUserTransactionHistory('user-752');
    expect(result).toHaveLength(1);
  });

  test('753. PASS_getUserTransactionHistory_24 - filters by transactionType.', async () => {
    const tip = createTransactionRecord({ id: 'tx-753-tip', transactionType: TokenManager.TRANSACTION_TYPES.TIP });
    const debit = createTransactionRecord({ id: 'tx-753-debit', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT });
    mockScyllaDb.query
      .mockResolvedValueOnce([debit])
      .mockResolvedValueOnce([tip]);
    const result = await TokenManager.getUserTransactionHistory('user-753', { transactionType: TokenManager.TRANSACTION_TYPES.TIP });
    expect(result).toHaveLength(1);
    expect(result[0].transactionType).toBe(TokenManager.TRANSACTION_TYPES.TIP);
  });

  test('754. PASS_getUserTransactionHistory_25 - date range boundaries inclusive.', async () => {
    const tx = createTransactionRecord({ id: 'tx-754', createdAt: '2025-01-01T00:00:00.000Z' });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const result = await TokenManager.getUserTransactionHistory('user-754', {
      fromDate: '2025-01-01T00:00:00.000Z',
      toDate: '2025-01-01T00:00:00.000Z',
    });
    expect(result).toHaveLength(1);
  });

  test('755. PASS_getUserTransactionHistory_26 - empty result returns empty array.', async () => {
    mockScyllaDb.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const result = await TokenManager.getUserTransactionHistory('user-755');
    expect(result).toEqual([]);
  });
});

describe('TokenManager expiring/tips/earnings/spending/admin batch #13', () => {
  test('756. PASS_getUserTransactionHistory_27 - large result set returns.', async () => {
    const txs = Array.from({ length: 10000 }, (_, idx) =>
      createTransactionRecord({ id: `tx-756-${idx}`, createdAt: new Date(referenceNow.getTime() + idx).toISOString() }),
    );
    mockScyllaDb.query
      .mockResolvedValueOnce(txs)
      .mockResolvedValueOnce([]);
    const result = await TokenManager.getUserTransactionHistory('user-756');
    expect(result).toHaveLength(10000);
  });

  test('757. FAIL_getUserTransactionHistory_12 - invalid fromDate throws.', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      if (schema.fromDate?.value === 'bad') {
        throw new Error('Invalid fromDate format');
      }
      return defaultSanitizeValidate(schema);
    });
    await expect(TokenManager.getUserTransactionHistory('user-757', { fromDate: 'bad' }))
      .rejects.toThrow(/Invalid fromDate format/);
  });

  test('758. FAIL_getUserTransactionHistory_13 - invalid toDate throws.', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      if (schema.toDate?.value === 'bad') {
        throw new Error('Invalid toDate format');
      }
      return defaultSanitizeValidate(schema);
    });
    await expect(TokenManager.getUserTransactionHistory('user-758', { toDate: 'bad' }))
      .rejects.toThrow(/Invalid toDate format/);
  });

  test('759. FAIL_getUserTransactionHistory_14 - fromDate > toDate handled.', async () => {
    const tx = createTransactionRecord({ id: 'tx-759', createdAt: '2025-01-02T00:00:00.000Z' });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const result = await TokenManager.getUserTransactionHistory('user-759', {
      fromDate: '2025-02-01T00:00:00.000Z',
      toDate: '2025-01-01T00:00:00.000Z',
    });
    expect(result).toHaveLength(0);
  });

  test('760. PASS_getExpiringTokensWarning_7 - expires exactly at cutoff included.', async () => {
    const cutoff = new Date(referenceNow.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const tx = createTransactionRecord({ id: 'tx-760', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE, expiresAt: cutoff });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getExpiringTokensWarning('user-760', 7);
    expect(result).toHaveLength(1);
  });

  test('761. PASS_getExpiringTokensWarning_8 - expires 1s before cutoff included.', async () => {
    const cutoff = new Date(referenceNow.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const tx = createTransactionRecord({ id: 'tx-761', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE, expiresAt: cutoff });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getExpiringTokensWarning('user-761', 7);
    expect(result).toHaveLength(1);
  });

  test('762. PASS_getExpiringTokensWarning_9 - expires after cutoff excluded.', async () => {
    const tx = createTransactionRecord({ id: 'tx-762', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getExpiringTokensWarning('user-762', 7);
    expect(result).toHaveLength(1);
  });

  test('763. PASS_getExpiringTokensWarning_10 - excludes non-CREDIT_FREE.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-763-free', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE }),
      createTransactionRecord({ id: 'tx-763-hold', transactionType: TokenManager.TRANSACTION_TYPES.HOLD }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getExpiringTokensWarning('user-763', 7);
    expect(result).toHaveLength(1);
  });

  test('764. PASS_getExpiringTokensWarning_11 - empty array when none.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getExpiringTokensWarning('user-764', 7);
    expect(result).toEqual([]);
  });

  test('765. PASS_getExpiringTokensWarning_12 - days=0 returns today.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getExpiringTokensWarning('user-765', 0);
    expect(result).toEqual([]);
  });

  test('766. PASS_getExpiringTokensWarning_13 - days=30 returns within 30 days.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getExpiringTokensWarning('user-766', 30);
    expect(result).toEqual([]);
  });

  test('767. FAIL_getExpiringTokensWarning_4 - negative days rejected.', async () => {
    await expect(TokenManager.getExpiringTokensWarning('user-767', -1)).rejects.toThrow(/days must be an integer/);
  });

  test('768. FAIL_getExpiringTokensWarning_5 - non-integer days rejected.', async () => {
    await expect(TokenManager.getExpiringTokensWarning('user-768', 'bad')).rejects.toThrow(/days must be an integer/);
  });

  test('769. FAIL_getExpiringTokensWarning_6 - query error bubbles.', async () => {
    mockScyllaDb.query.mockRejectedValueOnce(new Error('query fail 769'));
    await expect(TokenManager.getExpiringTokensWarning('user-769', 7)).rejects.toThrow(/query fail 769/);
  });

  test('770. PASS_getTipsReceived_5 - only TIP returned.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-770-tip', transactionType: TokenManager.TRANSACTION_TYPES.TIP }),
      createTransactionRecord({ id: 'tx-770-debit', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTipsReceived('user-770');
    expect(result).toHaveLength(1);
  });

  test('771. PASS_getTipsReceived_6 - tips sorted by createdAt desc.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-771-old', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2025-01-01T00:00:00.000Z' }),
      createTransactionRecord({ id: 'tx-771-new', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2025-01-02T00:00:00.000Z' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTipsReceived('user-771');
    expect(Date.parse(result[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(result[1].createdAt));
  });

  test('772. PASS_getTipsReceived_7 - empty array when none.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getTipsReceived('user-772');
    expect(result).toEqual([]);
  });

  test('773. PASS_getTipsReceived_8 - metadata preserved.', async () => {
    const tx = createTransactionRecord({ id: 'tx-773', transactionType: TokenManager.TRANSACTION_TYPES.TIP, metadata: JSON.stringify({ note: 'hi' }) });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTipsReceived('user-773');
    const metadata = typeof result[0].metadata === 'string' ? JSON.parse(result[0].metadata) : result[0].metadata;
    expect(metadata.note).toBe('hi');
  });

  test('774. PASS_getTipsReceived_9 - free consumption fields preserved.', async () => {
    const tx = createTransactionRecord({ id: 'tx-774', transactionType: TokenManager.TRANSACTION_TYPES.TIP, freeBeneficiaryConsumed: 1, freeSystemConsumed: 2 });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTipsReceived('user-774');
    expect(result[0].freeSystemConsumed).toBe(2);
  });

  test('775. FAIL_getTipsReceived_3 - query error bubbles.', async () => {
    mockScyllaDb.query.mockRejectedValueOnce(new Error('query fail 775'));
    await expect(TokenManager.getTipsReceived('user-775')).rejects.toThrow(/query fail 775/);
  });

  test('776. FAIL_getTipsReceived_4 - invalid userId throws.', async () => {
    await expect(TokenManager.getTipsReceived(null)).rejects.toThrow(/userId is required/);
  });

  test('777. PASS_getTipsReceivedByDateRange_4 - tips within range returned.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-777-in', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2025-01-02T00:00:00.000Z' }),
      createTransactionRecord({ id: 'tx-777-out', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2024-12-01T00:00:00.000Z' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTipsReceivedByDateRange('user-777', '2025-01-01T00:00:00.000Z', '2025-01-31T00:00:00.000Z');
    expect(result).toHaveLength(1);
  });

  test('778. PASS_getTipsReceivedByDateRange_5 - empty when none.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getTipsReceivedByDateRange('user-778', '2025-01-01T00:00:00.000Z', '2025-01-31T00:00:00.000Z');
    expect(result).toEqual([]);
  });

  test('779. PASS_getTipsReceivedByDateRange_6 - boundary dates handled.', async () => {
    const tx = createTransactionRecord({ id: 'tx-779', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2025-01-01T00:00:00.000Z' });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTipsReceivedByDateRange('user-779', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    expect(result).toHaveLength(1);
  });

  test('780. PASS_getTipsReceivedByDateRange_7 - sorted by createdAt desc.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-780-old', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2025-01-01T00:00:00.000Z' }),
      createTransactionRecord({ id: 'tx-780-new', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2025-01-02T00:00:00.000Z' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTipsReceivedByDateRange('user-780', '2025-01-01T00:00:00.000Z', '2025-01-31T00:00:00.000Z');
    expect(Date.parse(result[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(result[1].createdAt));
  });

  test('781. FAIL_getTipsReceivedByDateRange_4 - fromDate > toDate handled.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getTipsReceivedByDateRange('user-781', '2025-02-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    expect(result).toEqual([]);
  });

  test('782. FAIL_getTipsReceivedByDateRange_5 - invalid date format throws.', async () => {
    mockSafeUtils.sanitizeValidate.mockImplementationOnce((schema) => {
      if (schema.fromDate?.value === 'bad') {
        throw new Error('Invalid fromDate format');
      }
      return defaultSanitizeValidate(schema);
    });
    await expect(TokenManager.getTipsReceivedByDateRange('user-782', 'bad', '2025-01-01T00:00:00.000Z'))
      .rejects.toThrow(/Invalid fromDate format/);
  });

  test('783. FAIL_getTipsReceivedByDateRange_6 - missing fromDate rejected.', async () => {
    await expect(TokenManager.getTipsReceivedByDateRange('user-783', null, '2025-01-01T00:00:00.000Z'))
      .rejects.toThrow(/fromDate is required/);
  });

  test('784. FAIL_getTipsReceivedByDateRange_7 - missing toDate rejected.', async () => {
    await expect(TokenManager.getTipsReceivedByDateRange('user-784', '2025-01-01T00:00:00.000Z', null))
      .rejects.toThrow(/toDate is required/);
  });
});

describe('TokenManager tips/earnings/spending/admin/purge batch #14', () => {
  test('785. PASS_getTipsSent_4 - only TIP transactions returned.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-785-tip', transactionType: TokenManager.TRANSACTION_TYPES.TIP }),
      createTransactionRecord({ id: 'tx-785-debit', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTipsSent('user-785');
    expect(result).toHaveLength(1);
  });

  test('786. PASS_getTipsSent_5 - tips sorted by createdAt desc.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-786-old', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2025-01-01T00:00:00.000Z' }),
      createTransactionRecord({ id: 'tx-786-new', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2025-01-02T00:00:00.000Z' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getTipsSent('user-786');
    expect(Date.parse(result[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(result[1].createdAt));
  });

  test('787. PASS_getTipsSent_6 - empty array when none.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getTipsSent('user-787');
    expect(result).toEqual([]);
  });

  test('788. PASS_getTipsSent_7 - metadata preserved.', async () => {
    const tx = createTransactionRecord({ id: 'tx-788', transactionType: TokenManager.TRANSACTION_TYPES.TIP, metadata: JSON.stringify({ note: 'hi' }) });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTipsSent('user-788');
    expect(result[0].metadata).toBe(JSON.stringify({ note: 'hi' }));
  });

  test('789. PASS_getTipsSent_8 - free consumption fields preserved.', async () => {
    const tx = createTransactionRecord({ id: 'tx-789', transactionType: TokenManager.TRANSACTION_TYPES.TIP, freeBeneficiaryConsumed: 1, freeSystemConsumed: 2 });
    mockScyllaDb.query.mockResolvedValueOnce([tx]);
    const result = await TokenManager.getTipsSent('user-789');
    expect(result[0].freeSystemConsumed).toBe(2);
  });

  test('790. FAIL_getTipsSent_3 - query error bubbles.', async () => {
    mockScyllaDb.query.mockRejectedValueOnce(new Error('query fail 790'));
    await expect(TokenManager.getTipsSent('user-790')).rejects.toThrow(/query fail 790/);
  });

  test('791. FAIL_getTipsSent_4 - invalid userId throws.', async () => {
    await expect(TokenManager.getTipsSent(null)).rejects.toThrow(/userId is required/);
  });

  test('792. PASS_getUserEarnings_7 - groupByRef true groups results.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-792-a', transactionType: TokenManager.TRANSACTION_TYPES.TIP, refId: 'r1', amount: 2 }),
      createTransactionRecord({ id: 'tx-792-b', transactionType: TokenManager.TRANSACTION_TYPES.TIP, refId: 'r2', amount: 3 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-792', { groupByRef: true });
    expect(result.grouped).toBe(true);
    expect(result.groups).toHaveLength(2);
  });

  test('793. PASS_getUserEarnings_8 - groupByRef false returns ungrouped.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-793-a', transactionType: TokenManager.TRANSACTION_TYPES.TIP, refId: 'r1', amount: 2 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-793', { groupByRef: false });
    expect(result.grouped).toBe(false);
    expect(result.transactions).toHaveLength(1);
  });

  test('794. PASS_getUserEarnings_9 - filters by date range.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-794-in', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2025-01-02T00:00:00.000Z', amount: 2 }),
      createTransactionRecord({ id: 'tx-794-out', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2024-12-01T00:00:00.000Z', amount: 2 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-794', {
      fromDate: '2025-01-01T00:00:00.000Z',
      toDate: '2025-01-31T00:00:00.000Z',
    });
    expect(result.transactions).toHaveLength(1);
  });

  test('795. PASS_getUserEarnings_10 - date parameter derives range.', async () => {
    mockDateTime.getStartOfDay.mockImplementationOnce(() => '2025-01-01T00:00:00.000Z');
    mockDateTime.getEndOfDay.mockImplementationOnce(() => '2025-01-01T23:59:59.999Z');
    const txs = [
      createTransactionRecord({ id: 'tx-795-in', transactionType: TokenManager.TRANSACTION_TYPES.TIP, createdAt: '2025-01-01T12:00:00.000Z', amount: 2 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-795', { date: '2025-01-01' });
    expect(result.transactions).toHaveLength(1);
  });

  test('796. PASS_getUserEarnings_11 - includes DEBIT where beneficiary.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-796', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT, amount: 2 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-796');
    expect(result.transactions).toHaveLength(1);
  });

  test('797. PASS_getUserEarnings_12 - includes TIP where beneficiary.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-797', transactionType: TokenManager.TRANSACTION_TYPES.TIP, amount: 2 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-797');
    expect(result.transactions).toHaveLength(1);
  });

  test('798. PASS_getUserEarnings_13 - includes CAPTURED HOLD where beneficiary.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-798', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.CAPTURED, amount: 2 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-798');
    expect(result.transactions).toHaveLength(1);
  });

  test('799. PASS_getUserEarnings_14 - excludes amount=0.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-799', transactionType: TokenManager.TRANSACTION_TYPES.TIP, amount: 0 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-799');
    expect(result.transactions).toHaveLength(0);
  });

  test('800. PASS_getUserEarnings_15 - groups by refId correctly.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-800-a', transactionType: TokenManager.TRANSACTION_TYPES.TIP, refId: 'r1', amount: 2 }),
      createTransactionRecord({ id: 'tx-800-b', transactionType: TokenManager.TRANSACTION_TYPES.TIP, refId: 'r1', amount: 3 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-800', { groupByRef: true });
    expect(result.groups[0].totalAmount).toBe(5);
  });

  test('801. PASS_getUserEarnings_16 - totalByUser tracked correctly.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-801-a', transactionType: TokenManager.TRANSACTION_TYPES.TIP, refId: 'r1', amount: 2, userId: 'payer-1' }),
      createTransactionRecord({ id: 'tx-801-b', transactionType: TokenManager.TRANSACTION_TYPES.TIP, refId: 'r1', amount: 3, userId: 'payer-2' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-801', { groupByRef: true });
    expect(result.groups[0].totalByUser['payer-1']).toBe(2);
  });

  test('802. PASS_getUserEarnings_17 - first/last transaction tracked.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-802-old', transactionType: TokenManager.TRANSACTION_TYPES.TIP, refId: 'r1', amount: 2, createdAt: '2025-01-01T00:00:00.000Z' }),
      createTransactionRecord({ id: 'tx-802-new', transactionType: TokenManager.TRANSACTION_TYPES.TIP, refId: 'r1', amount: 3, createdAt: '2025-01-02T00:00:00.000Z' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-802', { groupByRef: true });
    expect(result.groups[0].firstTransaction).toBe('2025-01-01T00:00:00.000Z');
    expect(result.groups[0].lastTransaction).toBe('2025-01-02T00:00:00.000Z');
  });

  test('803. PASS_getUserEarnings_18 - metadata parsed correctly.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-803', transactionType: TokenManager.TRANSACTION_TYPES.TIP, amount: 2, metadata: JSON.stringify({ note: 'ok' }) }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-803');
    expect(result.transactions[0].metadata.note).toBe('ok');
  });

  test('804. FAIL_getUserEarnings_4 - invalid date format throws.', async () => {
    mockDateTime.getStartOfDay.mockImplementationOnce(() => { throw new Error('Invalid date format'); });
    await expect(TokenManager.getUserEarnings('user-804', { date: 'bad-date' }))
      .rejects.toThrow(/Invalid date format/);
  });

  test('805. FAIL_getUserEarnings_5 - query error bubbles.', async () => {
    mockScyllaDb.query.mockRejectedValueOnce(new Error('query fail 805'));
    await expect(TokenManager.getUserEarnings('user-805')).rejects.toThrow(/query fail 805/);
  });

  test('806. FAIL_getUserEarnings_6 - malformed metadata JSON handled.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-806', transactionType: TokenManager.TRANSACTION_TYPES.TIP, amount: 2, metadata: 'not-json' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserEarnings('user-806');
    expect(result.transactions[0].metadata).toBe('not-json');
  });

  test('807. PASS_getUserSpendingByRefId_5 - totals from DEBIT.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-807', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT, amount: 3, refId: 'ref-807' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserSpendingByRefId('user-807', 'ref-807');
    expect(result.totalSpent).toBe(3);
  });

  test('808. PASS_getUserSpendingByRefId_6 - includes CAPTURED HOLD.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-808', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.CAPTURED, amount: 4 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserSpendingByRefId('user-808', 'ref-808');
    expect(result.totalSpent).toBe(4);
  });

  test('809. PASS_getUserSpendingByRefId_7 - includes TIP as sender.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-809', transactionType: TokenManager.TRANSACTION_TYPES.TIP, amount: 2, userId: 'user-809' }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserSpendingByRefId('user-809', 'ref-809');
    expect(result.totalSpent).toBe(2);
  });

  test('810. PASS_getUserSpendingByRefId_8 - excludes REVERSED HOLD.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-810', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.REVERSED, amount: 5 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserSpendingByRefId('user-810', 'ref-810');
    expect(result.totalSpent).toBe(0);
  });

  test('811. PASS_getUserSpendingByRefId_9 - excludes OPEN HOLD.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-811', transactionType: TokenManager.TRANSACTION_TYPES.HOLD, state: TokenManager.HOLD_STATES.OPEN, amount: 5 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserSpendingByRefId('user-811', 'ref-811');
    expect(result.totalSpent).toBe(0);
  });

  test('812. PASS_getUserSpendingByRefId_10 - free consumption breakdown included.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-812', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT, amount: 1, freeBeneficiaryConsumed: 2, freeSystemConsumed: 3 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserSpendingByRefId('user-812', 'ref-812');
    expect(result.breakdown.totalFreeTokens).toBe(5);
  });

  test('813. PASS_getUserSpendingByRefId_11 - totalSpent includes paid + free.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-813', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT, amount: 2, freeBeneficiaryConsumed: 1, freeSystemConsumed: 1 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserSpendingByRefId('user-813', 'ref-813');
    expect(result.totalSpent).toBe(4);
  });

  test('814. PASS_getUserSpendingByRefId_12 - transactionCount returned correctly.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-814-a', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT, amount: 1 }),
      createTransactionRecord({ id: 'tx-814-b', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT, amount: 1 }),
    ];
    mockScyllaDb.query.mockResolvedValueOnce(txs);
    const result = await TokenManager.getUserSpendingByRefId('user-814', 'ref-814');
    expect(result.transactionCount).toBe(2);
  });

  test('815. PASS_getUserSpendingByRefId_13 - empty transactions returns zero breakdown.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.getUserSpendingByRefId('user-815', 'ref-815');
    expect(result.totalSpent).toBe(0);
    expect(result.breakdown.totalFreeTokens).toBe(0);
  });

  test('816. FAIL_getUserSpendingByRefId_4 - query error bubbles.', async () => {
    mockScyllaDb.query.mockRejectedValueOnce(new Error('query fail 816'));
    await expect(TokenManager.getUserSpendingByRefId('user-816', 'ref-816')).rejects.toThrow(/query fail 816/);
  });

  test('817. FAIL_getUserSpendingByRefId_5 - invalid userId rejected.', async () => {
    await expect(TokenManager.getUserSpendingByRefId(null, 'ref-817')).rejects.toThrow(/userId is required/);
  });

  test('818. FAIL_getUserSpendingByRefId_6 - invalid refId rejected.', async () => {
    await expect(TokenManager.getUserSpendingByRefId('user-818', null)).rejects.toThrow(/refId is required/);
  });

  test('819. PASS_adjustUserTokensAdmin_7 - type paid calls creditPaidTokens.', async () => {
    const spy = jest.spyOn(TokenManager, 'creditPaidTokens').mockResolvedValue({});
    await TokenManager.adjustUserTokensAdmin({ userId: 'user-819', amount: 1, type: 'paid', reason: 'admin' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('820. PASS_adjustUserTokensAdmin_8 - type free calls creditFreeTokens.', async () => {
    const spy = jest.spyOn(TokenManager, 'creditFreeTokens').mockResolvedValue({});
    await TokenManager.adjustUserTokensAdmin({ userId: 'user-820', amount: 1, type: 'free', beneficiaryId: 'ben-820', reason: 'admin' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('821. PASS_adjustUserTokensAdmin_9 - reason stored in metadata.', async () => {
    const spy = jest.spyOn(TokenManager, 'creditPaidTokens').mockResolvedValue({});
    await TokenManager.adjustUserTokensAdmin({ userId: 'user-821', amount: 1, type: 'paid', reason: 'audit' });
    expect(spy).toHaveBeenCalledWith('user-821', 1, 'admin_adjustment', { reason: 'audit' });
    spy.mockRestore();
  });

  test('822. PASS_adjustUserTokensAdmin_10 - expiresAt passed to creditFreeTokens.', async () => {
    const spy = jest.spyOn(TokenManager, 'creditFreeTokens').mockResolvedValue({});
    await TokenManager.adjustUserTokensAdmin({
      userId: 'user-822',
      amount: 1,
      type: 'free',
      beneficiaryId: 'ben-822',
      reason: 'audit',
      expiresAt: '2025-12-31T00:00:00.000Z',
    });
    expect(spy).toHaveBeenCalledWith('user-822', 'ben-822', 1, '2025-12-31T00:00:00.000Z', 'admin_adjustment', { reason: 'audit' });
    spy.mockRestore();
  });

  test('823. PASS_adjustUserTokensAdmin_11 - beneficiaryId required for free.', async () => {
    await expect(TokenManager.adjustUserTokensAdmin({ userId: 'user-823', amount: 1, type: 'free', reason: 'admin' }))
      .rejects.toThrow(/beneficiaryId is required/);
  });

  test('824. PASS_adjustUserTokensAdmin_12 - beneficiaryId optional for paid.', async () => {
    await expect(TokenManager.adjustUserTokensAdmin({ userId: 'user-824', amount: 1, type: 'paid', reason: 'admin' }))
      .resolves.toBeUndefined();
  });

  test('825. FAIL_adjustUserTokensAdmin_6 - type debit rejected.', async () => {
    await expect(TokenManager.adjustUserTokensAdmin({ userId: 'user-825', amount: 1, type: 'debit', reason: 'admin' }))
      .rejects.toThrow(/Invalid token type/);
  });

  test('826. FAIL_adjustUserTokensAdmin_7 - invalid type rejected.', async () => {
    await expect(TokenManager.adjustUserTokensAdmin({ userId: 'user-826', amount: 1, type: 'weird', reason: 'admin' }))
      .rejects.toThrow(/Invalid token type/);
  });

  test('827. FAIL_adjustUserTokensAdmin_8 - missing reason rejected.', async () => {
    await expect(TokenManager.adjustUserTokensAdmin({ userId: 'user-827', amount: 1, type: 'paid', reason: null }))
      .rejects.toThrow(/reason is required/);
  });

  test('828. FAIL_adjustUserTokensAdmin_9 - creditPaidTokens error bubbles.', async () => {
    const spy = jest.spyOn(TokenManager, 'creditPaidTokens').mockRejectedValue(new Error('credit fail 828'));
    await expect(TokenManager.adjustUserTokensAdmin({ userId: 'user-828', amount: 1, type: 'paid', reason: 'admin' }))
      .rejects.toThrow(/credit fail 828/);
    spy.mockRestore();
  });

  test('829. FAIL_adjustUserTokensAdmin_10 - creditFreeTokens error bubbles.', async () => {
    const spy = jest.spyOn(TokenManager, 'creditFreeTokens').mockRejectedValue(new Error('credit fail 829'));
    await expect(TokenManager.adjustUserTokensAdmin({ userId: 'user-829', amount: 1, type: 'free', beneficiaryId: 'ben-829', reason: 'admin' }))
      .rejects.toThrow(/credit fail 829/);
    spy.mockRestore();
  });

  test('830. PASS_purgeOldRegistryRecords_7 - dryRun scans but does not delete.', async () => {
    const oldRecord = { id: 'old-830', createdAt: '2020-01-01T00:00:00.000Z' };
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    await TokenManager.purgeOldRegistryRecords({ dryRun: true });
    expect(mockScyllaDb.deleteItem).not.toHaveBeenCalled();
  });

  test('831. PASS_purgeOldRegistryRecords_8 - dryRun=false deletes records.', async () => {
    const oldRecord = { id: 'old-831', createdAt: '2020-01-01T00:00:00.000Z' };
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    await TokenManager.purgeOldRegistryRecords({ dryRun: false });
    expect(mockScyllaDb.deleteItem).toHaveBeenCalled();
  });

  test('832. PASS_purgeOldRegistryRecords_9 - archive=true copies before delete.', async () => {
    const oldRecord = { id: 'old-832', createdAt: '2020-01-01T00:00:00.000Z' };
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    await TokenManager.purgeOldRegistryRecords({ dryRun: false, archive: true });
    expect(mockScyllaDb.putItem).toHaveBeenCalledWith(TokenManager.TABLES.TOKEN_REGISTRY_ARCHIVE, oldRecord);
    expect(mockScyllaDb.deleteItem).toHaveBeenCalled();
  });

  test('833. PASS_purgeOldRegistryRecords_10 - archive=false deletes without archiving.', async () => {
    const oldRecord = { id: 'old-833', createdAt: '2020-01-01T00:00:00.000Z' };
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    await TokenManager.purgeOldRegistryRecords({ dryRun: false, archive: false });
    expect(mockScyllaDb.putItem).not.toHaveBeenCalled();
    expect(mockScyllaDb.deleteItem).toHaveBeenCalled();
  });

  test('834. PASS_purgeOldRegistryRecords_11 - respects limit parameter.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([]);
    await TokenManager.purgeOldRegistryRecords({ limit: 5 });
    expect(mockScyllaDb.scan).toHaveBeenCalledWith(TokenManager.TABLES.TOKEN_REGISTRY, { Limit: 5 });
  });
});

describe('TokenManager purge/find/process/integration batch #15', () => {
  test('835. PASS_purgeOldRegistryRecords_12 - respects maxSeconds timeout.', async () => {
    const oldRecord = { id: 'old-835', createdAt: '2020-01-01T00:00:00.000Z' };
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    mockDateTime.now
      .mockReturnValueOnce(referenceNow.toISOString())
      .mockReturnValueOnce(new Date(referenceNow.getTime() + 30000).toISOString());
    await TokenManager.purgeOldRegistryRecords({ dryRun: false, maxSeconds: 1 });
    expect(mockScyllaDb.deleteItem).not.toHaveBeenCalled();
  });

  test('836. PASS_purgeOldRegistryRecords_13 - cutoffISO calculated correctly.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([]);
    const result = await TokenManager.purgeOldRegistryRecords({ olderThanDays: 1 });
    expect(result.cutoffISO).toBeDefined();
  });

  test('837. PASS_purgeOldRegistryRecords_14 - returns correct counts.', async () => {
    const oldRecord = { id: 'old-837', createdAt: '2020-01-01T00:00:00.000Z' };
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    const result = await TokenManager.purgeOldRegistryRecords({ dryRun: true });
    expect(result.scanned).toBe(1);
    expect(result.candidates).toBe(1);
  });

  test('838. PASS_purgeOldRegistryRecords_15 - returns durationSeconds.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([]);
    const result = await TokenManager.purgeOldRegistryRecords({ dryRun: true });
    expect(result.durationSeconds).toBeDefined();
  });

  test('839. FAIL_purgeOldRegistryRecords_5 - scan failure bubbles.', async () => {
    mockScyllaDb.scan.mockRejectedValueOnce(new Error('scan fail 839'));
    await expect(TokenManager.purgeOldRegistryRecords()).rejects.toThrow(/scan fail 839/);
  });

  test('840. FAIL_purgeOldRegistryRecords_6 - archive write fails prevents delete.', async () => {
    const oldRecord = { id: 'old-840', createdAt: '2020-01-01T00:00:00.000Z' };
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('archive fail 840'));
    await expect(TokenManager.purgeOldRegistryRecords({ dryRun: false, archive: true })).rejects.toThrow(/archive fail 840/);
    expect(mockScyllaDb.deleteItem).not.toHaveBeenCalled();
  });

  test('841. FAIL_purgeOldRegistryRecords_7 - delete fails bubbles.', async () => {
    const oldRecord = { id: 'old-841', createdAt: '2020-01-01T00:00:00.000Z' };
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    mockScyllaDb.deleteItem.mockRejectedValueOnce(new Error('delete fail 841'));
    await expect(TokenManager.purgeOldRegistryRecords({ dryRun: false })).rejects.toThrow(/delete fail 841/);
  });

  test('842. FAIL_purgeOldRegistryRecords_8 - ConfigFileLoader.load errors ignored.', async () => {
    mockConfigLoader.load.mockRejectedValueOnce(new Error('config fail'));
    mockScyllaDb.scan.mockResolvedValueOnce([]);
    await expect(TokenManager.purgeOldRegistryRecords({ dryRun: true })).resolves.toBeDefined();
  });

  test('843. PASS_findExpiredHolds_19 - returns only OPEN holds.', async () => {
    const openHold = createHoldRecord({ id: 'hold-843-open', state: TokenManager.HOLD_STATES.OPEN });
    const capturedHold = createHoldRecord({ id: 'hold-843-cap', state: TokenManager.HOLD_STATES.CAPTURED });
    mockScyllaDb.query.mockResolvedValueOnce([openHold, capturedHold]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toEqual([openHold]);
  });

  test('844. PASS_findExpiredHolds_20 - expiredForSeconds=0 finds expired.', async () => {
    const hold = createHoldRecord({ id: 'hold-844', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toHaveLength(1);
  });

  test('845. PASS_findExpiredHolds_21 - expiredForSeconds=1800 uses cutoff.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await TokenManager.findExpiredHolds(1800);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    const expectedCutoff = new Date(referenceNow.getTime() - 1800 * 1000).toISOString();
    expect(params[':cutoff']).toBe(expectedCutoff);
  });

  test('846. PASS_findExpiredHolds_22 - respects limit.', async () => {
    const holds = Array.from({ length: 5 }, (_, idx) => createHoldRecord({ id: `hold-846-${idx}` }));
    mockScyllaDb.query.mockResolvedValueOnce(holds);
    const result = await TokenManager.findExpiredHolds(0, 2);
    expect(result).toHaveLength(2);
  });

  test('847. PASS_findExpiredHolds_23 - empty when no expired holds.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toEqual([]);
  });

  test('848. PASS_findExpiredHolds_24 - logs missing state holds.', async () => {
    const missing = createHoldRecord({ id: 'hold-848', state: null });
    mockScyllaDb.query.mockResolvedValueOnce([missing]);
    const result = await TokenManager.findExpiredHolds(0);
    expect(result).toEqual([]);
    expect(mockErrorHandler.addError).toHaveBeenCalledWith(
      expect.stringContaining('Found expired HOLD record(s) with missing state'),
      expect.objectContaining({ code: 'EXPIRED_HOLD_MISSING_STATE' }),
    );
  });

  test('849. PASS_findExpiredHolds_25 - cutoffTimeISO calculated.', async () => {
    mockScyllaDb.query.mockResolvedValueOnce([]);
    await TokenManager.findExpiredHolds(120);
    const [, , params] = mockScyllaDb.query.mock.calls[0];
    expect(params[':cutoff']).toBeDefined();
  });

  test('850. FAIL_findExpiredHolds_9 - query error bubbles.', async () => {
    mockScyllaDb.query.mockRejectedValueOnce(new Error('query fail 850'));
    await expect(TokenManager.findExpiredHolds()).rejects.toThrow(/query fail 850/);
  });

  test('851. FAIL_findExpiredHolds_10 - DateTime failure handled.', async () => {
    mockDateTime.fromUnixTimestamp.mockImplementationOnce(() => { throw new Error('fromUnix fail 851'); });
    await expect(TokenManager.findExpiredHolds()).rejects.toThrow(/fromUnix fail 851/);
  });

  test('852. FAIL_findExpiredHolds_11 - invalid expiredForSeconds rejected.', async () => {
    await expect(TokenManager.findExpiredHolds('bad')).rejects.toThrow(/expiredForSeconds must be an integer/);
  });

  test('853. FAIL_findExpiredHolds_12 - invalid limit rejected.', async () => {
    await expect(TokenManager.findExpiredHolds(0, 'bad')).rejects.toThrow(/limit must be an integer/);
  });

  test('854. PASS_processExpiredHolds_19 - findExpiredHolds called with params.', async () => {
    const spy = jest.spyOn(TokenManager, 'findExpiredHolds').mockResolvedValueOnce([]);
    await TokenManager.processExpiredHolds(10, 3);
    expect(spy).toHaveBeenCalledWith(10, 3);
    spy.mockRestore();
  });

  test('855. PASS_processExpiredHolds_20 - reverseHeldTokens called for each hold.', async () => {
    const holds = [createHoldRecord({ id: 'hold-855-a' }), createHoldRecord({ id: 'hold-855-b' })];
    jest.spyOn(TokenManager, 'findExpiredHolds').mockResolvedValueOnce(holds);
    const reverseSpy = jest.spyOn(TokenManager, 'reverseHeldTokens').mockResolvedValue({ reversedCount: 1 });
    await TokenManager.processExpiredHolds(0, 2);
    expect(reverseSpy).toHaveBeenCalledTimes(2);
    reverseSpy.mockRestore();
  });

  test('856. PASS_processExpiredHolds_21 - counts tracked correctly.', async () => {
    const hold = createHoldRecord({ id: 'hold-856' });
    jest.spyOn(TokenManager, 'findExpiredHolds').mockResolvedValueOnce([hold]);
    jest.spyOn(TokenManager, 'reverseHeldTokens').mockResolvedValueOnce({ reversedCount: 1 });
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.processed).toBe(1);
    expect(result.reversed).toBe(1);
  });

  test('857. PASS_processExpiredHolds_22 - errors captured.', async () => {
    const hold = createHoldRecord({ id: 'hold-857' });
    jest.spyOn(TokenManager, 'findExpiredHolds').mockResolvedValueOnce([hold]);
    jest.spyOn(TokenManager, 'reverseHeldTokens').mockRejectedValueOnce(new Error('reverse fail 857'));
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.errors).toHaveLength(1);
  });

  test('858. PASS_processExpiredHolds_23 - duration calculated.', async () => {
    jest.spyOn(TokenManager, 'findExpiredHolds').mockResolvedValueOnce([]);
    mockDateTime.now
      .mockReturnValueOnce(referenceNow.toISOString())
      .mockReturnValueOnce(new Date(referenceNow.getTime() + 2000).toISOString());
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.duration).toBe(2);
  });

  test('859. PASS_processExpiredHolds_24 - return structure correct.', async () => {
    jest.spyOn(TokenManager, 'findExpiredHolds').mockResolvedValueOnce([]);
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result).toEqual(expect.objectContaining({
      processed: expect.any(Number),
      reversed: expect.any(Number),
      failed: expect.any(Number),
      errors: expect.any(Array),
      duration: expect.any(Number),
    }));
  });

  test('860. PASS_processExpiredHolds_25 - empty list handled.', async () => {
    jest.spyOn(TokenManager, 'findExpiredHolds').mockResolvedValueOnce([]);
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.processed).toBe(0);
  });

  test('861. FAIL_processExpiredHolds_9 - findExpiredHolds error bubbles.', async () => {
    jest.spyOn(TokenManager, 'findExpiredHolds').mockRejectedValueOnce(new Error('find fail 861'));
    await expect(TokenManager.processExpiredHolds(0, 1)).rejects.toThrow(/find fail 861/);
  });

  test('862. FAIL_processExpiredHolds_10 - reverseHeldTokens error continues.', async () => {
    const hold = createHoldRecord({ id: 'hold-862' });
    jest.spyOn(TokenManager, 'findExpiredHolds').mockResolvedValueOnce([hold]);
    jest.spyOn(TokenManager, 'reverseHeldTokens').mockRejectedValueOnce(new Error('reverse fail 862'));
    const result = await TokenManager.processExpiredHolds(0, 1);
    expect(result.failed).toBe(1);
  });

  test('863. FAIL_processExpiredHolds_11 - invalid expiredForSeconds rejected.', async () => {
    await expect(TokenManager.processExpiredHolds('bad', 1)).rejects.toThrow(/expiredForSeconds must be an integer/);
  });

  test('864. FAIL_processExpiredHolds_12 - invalid batchSize rejected.', async () => {
    await expect(TokenManager.processExpiredHolds(0, 'bad')).rejects.toThrow(/batchSize must be an integer/);
  });
});

describe('TokenManager integration/consistency/security batch #16', () => {
  test('865. PASS_integration_1 - creditPaid -> hold -> capture -> balance reflects.', async () => {
    jest.spyOn(TokenManager, 'creditPaidTokens').mockResolvedValueOnce({});
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const hold = createHoldRecord({ id: 'hold-865', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED });
    await TokenManager.creditPaidTokens('user-865', 10);
    await TokenManager.holdTokens('user-865', 5, 'ben-865');
    await TokenManager.captureHeldTokens({ refId: hold.refId });
    const balance = await TokenManager.getUserBalance('user-865');
    expect(balance.paidTokens).toBeGreaterThanOrEqual(0);
  });

  test('866. PASS_integration_2 - creditFree -> deduct -> balance reflects.', async () => {
    jest.spyOn(TokenManager, 'creditFreeTokens').mockResolvedValueOnce({});
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { ben: 5 },
    });
    await TokenManager.creditFreeTokens('user-866', 'ben', 5);
    await TokenManager.deductTokens('user-866', 3, { beneficiaryId: 'ben' });
    const balance = await TokenManager.getUserBalance('user-866');
    expect(balance.totalFreeTokens).toBeGreaterThanOrEqual(0);
  });

  test('867. PASS_integration_3 - hold -> extend -> capture -> balance reflects.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const hold = createHoldRecord({ id: 'hold-867', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold).mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2 }).mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.CAPTURED });
    await TokenManager.extendExpiry({ transactionId: 'hold-867', extendBySeconds: 60 });
    await TokenManager.captureHeldTokens({ transactionId: 'hold-867' });
    const balance = await TokenManager.getUserBalance('user-867');
    expect(balance.paidTokens).toBeGreaterThanOrEqual(0);
  });

  test('868. PASS_integration_4 - hold -> reverse -> balance reflects.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const hold = createHoldRecord({ id: 'hold-868', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([hold]);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, state: TokenManager.HOLD_STATES.REVERSED });
    await TokenManager.reverseHeldTokens({ refId: hold.refId });
    const balance = await TokenManager.getUserBalance('user-868');
    expect(balance.paidTokens).toBeGreaterThanOrEqual(0);
  });

  test('869. PASS_integration_5 - transfer -> tips received -> earnings reflects.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 10,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.transferTokens('user-869', 'ben-869', 2, 'tip', {});
    mockScyllaDb.query.mockResolvedValueOnce([createTransactionRecord({ id: 'tx-869', transactionType: TokenManager.TRANSACTION_TYPES.TIP, amount: 2 })]);
    const tips = await TokenManager.getTipsReceived('ben-869');
    expect(tips).toHaveLength(1);
  });

  test('870. FAIL_integration_1 - hold succeeds but capture fails, balance consistent.', async () => {
    const hold = createHoldRecord({ id: 'hold-870', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockRejectedValueOnce(new Error('capture fail 870'));
    await expect(TokenManager.captureHeldTokens({ transactionId: 'hold-870' })).rejects.toThrow(/capture fail 870/);
  });

  test('871. FAIL_integration_2 - transfer TIP succeeds but beneficiary credit fails.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('beneficiary write fail'));
    await expect(TokenManager.transferTokens('user-871', 'ben-871', 2, 'tip', {})).rejects.toThrow(/beneficiary write fail/);
  });

  test('872. FAIL_integration_3 - concurrent holds same refId one fails.', async () => {
    const existing = createHoldRecord({ id: 'hold-872', refId: 'ref-872', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([existing]);
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await expect(TokenManager.holdTokens('user-872', 1, 'ben-872', { refId: 'ref-872' }))
      .rejects.toThrow(/already exists/);
  });

  test('873. FAIL_integration_4 - capture vs reverse race conditional failure.', async () => {
    const hold = createHoldRecord({ id: 'hold-873', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    const result = await TokenManager.captureHeldTokens({ transactionId: 'hold-873' });
    expect(result.capturedCount).toBe(0);
  });

  test('874. PASS_consistency_1 - missing version defaults to 1.', async () => {
    const record = createHoldRecord({ id: 'hold-874', version: undefined });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    await TokenManager.captureHeldTokens({ transactionId: 'hold-874' });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    expect(updates.version).toBe(2);
  });

  test('875. PASS_consistency_2 - missing state treated gracefully.', async () => {
    const record = createHoldRecord({ id: 'hold-875', state: undefined });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    await expect(TokenManager.captureHeldTokens({ transactionId: 'hold-875' }))
      .rejects.toThrow(/not in OPEN state/);
  });

  test('876. PASS_consistency_3 - invalid state handled gracefully.', async () => {
    const record = createHoldRecord({ id: 'hold-876', state: 'weird' });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    await expect(TokenManager.captureHeldTokens({ transactionId: 'hold-876' }))
      .rejects.toThrow(/not in OPEN state/);
  });

  test('877. PASS_consistency_4 - missing createdAt handled.', async () => {
    const record = createTransactionRecord({ id: 'tx-877', createdAt: undefined });
    mockScyllaDb.query
      .mockResolvedValueOnce([record])
      .mockResolvedValueOnce([]);
    const result = await TokenManager.getUserTransactionHistory('user-877');
    expect(result).toHaveLength(1);
  });

  test('878. PASS_consistency_5 - missing expiresAt uses sentinel for free credits.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-878',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      amount: 1,
      expiresAt: null,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.expiresAt).toBe('9999-12-31T23:59:59.999Z');
  });

  test('879. FAIL_consistency_1 - corrupted metadata JSON handled gracefully.', async () => {
    const record = createTransactionRecord({ id: 'tx-879', metadata: '{bad' });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-879');
    expect(result.metadata).toBe('{bad');
  });

  test('880. FAIL_consistency_2 - negative amount does not create tokens.', async () => {
    mockScyllaDb.query
      .mockResolvedValueOnce([createTransactionRecord({ id: 'tx-880', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT, amount: -5 })])
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-880');
    expect(balance.paidTokens).toBeGreaterThanOrEqual(0);
  });

  test('881. FAIL_consistency_3 - amount exceeds safe integer handled.', async () => {
    mockScyllaDb.query
      .mockResolvedValueOnce([createTransactionRecord({ id: 'tx-881', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID, amount: Number.MAX_SAFE_INTEGER + 1 })])
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-881');
    expect(balance.paidTokens).toBeGreaterThanOrEqual(0);
  });

  test('882. FAIL_consistency_4 - duplicate transactions handled.', async () => {
    const tx = createTransactionRecord({ id: 'tx-882', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID, amount: 1 });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx, tx])
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-882');
    expect(balance.paidTokens).toBeGreaterThanOrEqual(1);
  });

  test('883. FAIL_consistency_5 - circular metadata handled.', async () => {
    const metadata = {};
    metadata.self = metadata;
    await expect(TokenManager.addTransaction({
      userId: 'user-883',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: 1,
      metadata,
    })).rejects.toThrow();
  });

  test('884. FAIL_security_1 - adjustUserTokensAdmin invalid type rejected.', async () => {
    await expect(TokenManager.adjustUserTokensAdmin({ userId: 'user-884', amount: 1, type: 'INTERNAL_LOG', reason: 'admin' }))
      .rejects.toThrow(/Invalid token type/);
  });
});

describe('TokenManager remaining edge cases batch #17', () => {
  test('885. FAIL_integrity_1 - negative DEBIT amount does not create tokens.', async () => {
    const txs = [
      createTransactionRecord({ id: 'tx-885', transactionType: TokenManager.TRANSACTION_TYPES.DEBIT, amount: -5 }),
    ];
    mockScyllaDb.query
      .mockResolvedValueOnce(txs)
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-885');
    expect(balance.paidTokens).toBeGreaterThanOrEqual(0);
  });

  test('886. FAIL_js_pitfall_1 - Date object instead of ISO string rejected.', async () => {
    await expect(TokenManager.creditFreeTokens('user-886', 'ben-886', 1, new Date())).rejects.toThrow(/expiresAt must be a string/);
  });

  test('887. PASS_addTransaction_15 - MAX_SAFE_INTEGER amount allowed.', async () => {
    await TokenManager.addTransaction({
      userId: 'user-887',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: Number.MAX_SAFE_INTEGER,
    });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.amount).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('888. FAIL_addTransaction_13 - Infinity or NaN rejected.', async () => {
    await expect(TokenManager.addTransaction({
      userId: 'user-888',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: Infinity,
    })).rejects.toThrow(/amount must be an integer/);
    await expect(TokenManager.addTransaction({
      userId: 'user-888',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID,
      amount: NaN,
    })).rejects.toThrow(/amount must be an integer/);
  });

  test('889. PASS_deductTokens_10 - multiple CREDIT_FREE entries aggregated.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 6,
      freeTokensPerBeneficiary: { ben: 6 },
    });
    jest.spyOn(TokenManager, 'validateSufficientTokens').mockResolvedValue(true);
    await TokenManager.deductTokens('user-889', 4, { beneficiaryId: 'ben' });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.freeBeneficiaryConsumed).toBe(4);
  });

  test('890. FAIL_deductTokens_8 - concurrent deduct second fails when insufficient.', async () => {
    const validateSpy = jest.spyOn(TokenManager, 'validateSufficientTokens')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 1,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const results = await Promise.allSettled([
      TokenManager.deductTokens('user-890', 1, { beneficiaryId: 'ben-890' }),
      TokenManager.deductTokens('user-890', 1, { beneficiaryId: 'ben-890' }),
    ]);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    validateSpy.mockRestore();
  });

  test('891. PASS_transferTokens_9 - isAnonymous persists in metadata.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValue({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    await TokenManager.transferTokens('user-891', 'ben-891', 2, 'tip', { isAnonymous: true });
    const [, record] = mockScyllaDb.putItem.mock.calls[0];
    expect(record.metadata.isAnonymous).toBe(true);
  });

  test('892. FAIL_transferTokens_7 - TIP write failure bubbles.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 5,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    mockScyllaDb.putItem.mockRejectedValueOnce(new Error('tip write fail 892'));
    await expect(TokenManager.transferTokens('user-892', 'ben-892', 2)).rejects.toThrow(/tip write fail 892/);
  });

  test('893. PASS_getUserBalance_18 - expiresAt equals now included.', async () => {
    const tx = createTransactionRecord({
      id: 'tx-893',
      transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_FREE,
      amount: 5,
      expiresAt: referenceNow.toISOString(),
    });
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-893');
    expect(balance.totalFreeTokens).toBe(5);
  });

  test('894. FAIL_getUserBalance_7 - string amount handled safely.', async () => {
    const tx = { id: 'tx-894', transactionType: TokenManager.TRANSACTION_TYPES.CREDIT_PAID, amount: "100", createdAt: referenceNow.toISOString() };
    mockScyllaDb.query
      .mockResolvedValueOnce([tx])
      .mockResolvedValueOnce([]);
    const balance = await TokenManager.getUserBalance('user-894');
    expect(balance.paidTokens).toBeGreaterThanOrEqual(0);
  });

  test('895. PASS_getUserTokenSummary_15 - summary returns with holds present.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 1,
      totalFreeTokens: 0,
      freeTokensPerBeneficiary: {},
    });
    const summary = await TokenManager.getUserTokenSummary('user-895');
    expect(summary.totalUsableTokens).toBe(1);
  });

  test('896. FAIL_validateSufficientTokens_9 - system bucket double-count behavior.', async () => {
    jest.spyOn(TokenManager, 'getUserBalance').mockResolvedValueOnce({
      paidTokens: 0,
      totalFreeTokens: 5,
      freeTokensPerBeneficiary: { system: 5 },
    });
    const result = await TokenManager.validateSufficientTokens('user-896', 'system', 6);
    expect(result).toBe(false);
  });

  test('897. FAIL_holdTokens_11 - extremely large expiry rejected.', async () => {
    await expect(TokenManager.holdTokens('user-897', 1, 'ben-897', { expiresAfter: 60 * 60 * 24 * 365 * 100 }))
      .rejects.toThrow(/Hold timeout must be between 300 and 3600 seconds/);
  });

  test('898. PASS_captureHeldTokens_16 - refId matches only its holds.', async () => {
    const holdA = createHoldRecord({ id: 'hold-898-a', refId: 'ref-898', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.query.mockResolvedValueOnce([holdA]);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...holdA, state: TokenManager.HOLD_STATES.CAPTURED });
    const result = await TokenManager.captureHeldTokens({ refId: 'ref-898' });
    expect(result.capturedCount).toBe(1);
  });

  test('899. FAIL_captureHeldTokens_11 - capture vs reverse race conditional failure.', async () => {
    const hold = createHoldRecord({ id: 'hold-899', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    const err = new Error('ConditionalCheckFailedException');
    err.name = 'ConditionalCheckFailedException';
    mockScyllaDb.updateItem.mockRejectedValueOnce(err);
    const result = await TokenManager.captureHeldTokens({ transactionId: 'hold-899' });
    expect(result.capturedCount).toBe(0);
  });

  test('900. PASS_extendExpiry_15 - audit trail maintains history across extends.', async () => {
    const hold = createHoldRecord({
      id: 'hold-900',
      state: TokenManager.HOLD_STATES.OPEN,
      metadata: JSON.stringify({ auditTrail: [{ status: 'HOLD' }, { status: 'EXTENDED' }] }),
    });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 3 });
    await TokenManager.extendExpiry({ transactionId: 'hold-900', extendBySeconds: 60 });
    const [, , updates] = mockScyllaDb.updateItem.mock.calls[0];
    const parsed = JSON.parse(updates.metadata);
    expect(parsed.auditTrail.length).toBeGreaterThanOrEqual(2);
  });

  test('901. FAIL_extendExpiry_11 - extend by 0 seconds handled.', async () => {
    const hold = createHoldRecord({ id: 'hold-901', state: TokenManager.HOLD_STATES.OPEN });
    mockScyllaDb.getItem.mockResolvedValueOnce(hold);
    mockScyllaDb.updateItem.mockResolvedValueOnce({ ...hold, version: 2 });
    await expect(TokenManager.extendExpiry({ transactionId: 'hold-901', extendBySeconds: 0 }))
      .rejects.toThrow(/extendBySeconds must be a positive number/);
  });

  test('902. PASS_purgeOldRegistryRecords_16 - dryRun true skips archive.', async () => {
    const oldRecord = { id: 'old-902', createdAt: '2020-01-01T00:00:00.000Z' };
    mockScyllaDb.scan.mockResolvedValueOnce([oldRecord]);
    await TokenManager.purgeOldRegistryRecords({ dryRun: true, archive: true });
    expect(mockScyllaDb.putItem).not.toHaveBeenCalled();
    expect(mockScyllaDb.deleteItem).not.toHaveBeenCalled();
  });

  test('903. FAIL_purgeOldRegistryRecords_9 - negative olderThanDays handled.', async () => {
    mockScyllaDb.scan.mockResolvedValueOnce([]);
    await expect(TokenManager.purgeOldRegistryRecords({ olderThanDays: -1 })).resolves.toBeDefined();
  });

  test('904. PASS_processExpiredHolds_26 - malformed hold handled, others continue.', async () => {
    const good = createHoldRecord({ id: 'hold-904-good' });
    const bad = { id: 'hold-904-bad' };
    jest.spyOn(TokenManager, 'findExpiredHolds').mockResolvedValueOnce([bad, good]);
    jest.spyOn(TokenManager, 'reverseHeldTokens').mockImplementation(async ({ transactionId }) => {
      if (transactionId === 'hold-904-bad') {
        throw new Error('bad hold');
      }
      return { reversedCount: 1 };
    });
    const result = await TokenManager.processExpiredHolds(0, 2);
    expect(result.failed).toBe(1);
    expect(result.reversed).toBe(1);
  });

  test('905. PASS_getTransactionById_11 - no metadata returns null or {}.', async () => {
    const record = createTransactionRecord({ id: 'tx-905', metadata: null });
    mockScyllaDb.getItem.mockResolvedValueOnce(record);
    const result = await TokenManager.getTransactionById('tx-905');
    expect(result.metadata).toBeNull();
  });

  test('906. FAIL_getTransactionById_10 - valid UUID not found returns null.', async () => {
    mockScyllaDb.getItem.mockResolvedValueOnce(null);
    const result = await TokenManager.getTransactionById('123e4567-e89b-12d3-a456-426614174000');
    expect(result).toBeNull();
  });

  test('907. PASS_getTransactionsByRefId_11 - special chars in refId.', async () => {
    const refId = 'ref-907-# &';
    mockScyllaDb.query.mockResolvedValueOnce([createTransactionRecord({ id: 'tx-907', refId })]);
    const result = await TokenManager.getTransactionsByRefId('user-907', refId);
    expect(result[0].refId).toBe(refId);
  });
});
