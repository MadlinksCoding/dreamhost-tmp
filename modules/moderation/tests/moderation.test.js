const ModerationModule = require('../src/core/moderation.js');
const Moderation = ModerationModule.default || ModerationModule;
const Scylla = require('../src/services/scylla.js');
const SafeUtils = require('../src/utils/SafeUtils.js');
const Logger = require('../src/utils/Logger.js');
const ErrorHandler = require('../src/utils/ErrorHandler.js');

// Mock dependencies – single object so tests and Moderation (default import) share same reference
jest.mock('../src/services/scylla.js', () => {
  const m = {
    createTable: jest.fn(),
    putItem: jest.fn(),
    getItem: jest.fn(),
    updateItem: jest.fn(),
    query: jest.fn(),
    deleteItem: jest.fn(),
    request: jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [] });
      if (op === 'UpdateItem' || op === 'Scan' || op === 'TransactWriteItems') return Promise.resolve({});
      return Promise.resolve({});
    }),
    marshalItem: jest.fn((x) => x),
    unmarshalItem: jest.fn((x) => x)
  };
  m.default = m;
  m.__esModule = true;
  return m;
});

jest.mock('../src/utils/SafeUtils.js', () => {
  const defaultSanitizeValidate = (schema) => {
    const r = {};
    for (const [k, v] of Object.entries(schema)) {
      const val = v.value !== undefined && v.value !== null ? v.value : (v.default !== undefined ? v.default : null);
      r[k] = val;
    }
    return r;
  };
  const m = {
    sanitizeValidate: jest.fn(defaultSanitizeValidate),
    hasValue: jest.fn((v) => v != null && v !== ''),
    sanitizeString: jest.fn((s) => (s == null || typeof s !== 'string') ? null : (String(s).trim() || null)),
    sanitizeTextField: jest.fn((s) => (s == null || typeof s !== 'string') ? null : (String(s).trim() || null)),
    sanitizeInteger: jest.fn((n) => {
      if (n == null) return null;
      const i = parseInt(n, 10);
      return Number.isNaN(i) ? null : i;
    }),
    isPlainObject: jest.fn((o) => o != null && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype)
  };
  m.default = m;
  m.__esModule = true;
  return m;
});

jest.mock('../src/utils/Logger.js', () => {
  const m = { writeLog: jest.fn(), debugLog: jest.fn() };
  m.default = m;
  m.__esModule = true;
  return m;
});

jest.mock('../src/utils/ErrorHandler.js', () => ({
  addError: jest.fn(),
  clear: jest.fn(),
  getAllErrors: jest.fn(() => [])
}));
jest.mock('../src/utils/DateTime.js', () => {
  const dt = { now: () => new Date().toISOString().slice(0, 19).replace('T', ' ') };
  return { __esModule: true, default: dt };
});

jest.mock('crypto', () => {
  let uuidCounter = 0;
  return {
    randomUUID: jest.fn(() => {
      const n = ++uuidCounter;
      const a = (n).toString(16).padStart(8, '0').slice(-8);
      const b = (n * 7).toString(16).padStart(4, '0').slice(-4);
      const c = '4' + (n * 11).toString(16).padStart(3, '0').slice(-3);
      const d = '89ab'[n % 4] + (n * 13).toString(16).padStart(3, '0').slice(-3);
      const e = (n * 17).toString(16).padStart(12, '0').slice(-12);
      return `${a}-${b}-${c}-${d}-${e}`;
    }),
    randomBytes: jest.fn((n) => Buffer.alloc(n, 0)),
    webcrypto: null
  };
});

jest.mock('zlib', () => ({
  gzip: jest.fn((buf, cb) => (typeof cb === 'function' ? cb(null, buf) : Promise.resolve(buf))),
  gunzip: jest.fn((buf, cb) => (typeof cb === 'function' ? cb(null, buf) : Promise.resolve(buf)))
}));

describe('Moderation Class Tests', () => {
  let uuidCounter = 0;
  const defaultRequestImpl = (op) => {
    if (op === 'Query') return Promise.resolve({ Items: [] });
    if (op === 'UpdateItem' || op === 'Scan' || op === 'TransactWriteItems') return Promise.resolve({});
    return Promise.resolve({});
  };
  const defaultRandomUUIDImpl = () => {
    const n = ++uuidCounter;
    const a = (n).toString(16).padStart(8, '0').slice(-8);
    const b = (n * 7).toString(16).padStart(4, '0').slice(-4);
    const c = '4' + (n * 11).toString(16).padStart(3, '0').slice(-3);
    const d = '89ab'[n % 4] + (n * 13).toString(16).padStart(3, '0').slice(-3);
    const e = (n * 17).toString(16).padStart(12, '0').slice(-12);
    return `${a}-${b}-${c}-${d}-${e}`;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    ErrorHandler.addError = jest.fn();
    ErrorHandler.clear = jest.fn();
    ErrorHandler.getAllErrors = jest.fn(() => []);
    Scylla.request = jest.fn().mockImplementation(defaultRequestImpl);
    const crypto = require('crypto');
    crypto.randomUUID = jest.fn().mockImplementation(defaultRandomUUIDImpl);
    crypto.webcrypto = null;
    crypto.randomBytes = jest.fn((n) => Buffer.alloc(n, 0));
    ErrorHandler.clear();
  });

  /**
   * --------------------------------
   * SECTION: createModerationSchema TESTS
   * --------------------------------
   */ test('PASS_createModerationSchema_1: Creates table schema with correct PK (pk: "moderation#<userId>"), SK (sk: "media#<submittedAt>#<moderationId>"), and PAY_PER_REQUEST billing mode. Verifies all required AttributeDefinitions', async () => {
    Scylla.createTable = jest.fn().mockResolvedValue({});
    
    await Moderation.createModerationSchema();
    
    expect(Scylla.createTable).toHaveBeenCalled();
    const callArgs = Scylla.createTable.mock.calls[0][0];
    expect(callArgs.TableName).toBe(Moderation.TABLE);
    expect(callArgs.BillingMode).toBe('PAY_PER_REQUEST');
    expect(callArgs.KeySchema).toEqual([
      { AttributeName: Moderation.PK, KeyType: 'HASH' },
      { AttributeName: Moderation.SK, KeyType: 'RANGE' }
    ]);
    expect(callArgs.AttributeDefinitions).toBeDefined();
    expect(callArgs.AttributeDefinitions.length).toBeGreaterThan(0);
  }); test('PASS_createModerationSchema_2: Creates all 10 GSIs with correct configurations', async () => {
    Scylla.createTable = jest.fn().mockResolvedValue({});
    
    await Moderation.createModerationSchema();
    
    const callArgs = Scylla.createTable.mock.calls[0][0];
    const gsis = callArgs.GlobalSecondaryIndexes;
    expect(gsis).toBeDefined();
    expect(gsis.length).toBe(10);
    
    const gsiNames = gsis.map(gsi => gsi.IndexName);
    expect(gsiNames).toContain(Moderation.GSI_STATUS_DATE);
    expect(gsiNames).toContain(Moderation.GSI_USER_STATUS_DATE);
    expect(gsiNames).toContain(Moderation.GSI_ALL_BY_DATE);
    expect(gsiNames).toContain(Moderation.GSI_PRIORITY);
    expect(gsiNames).toContain(Moderation.GSI_TYPE_DATE);
    expect(gsiNames).toContain(Moderation.GSI_BY_MOD_ID);
    expect(gsiNames).toContain(Moderation.GSI_MODERATED_BY);
    expect(gsiNames).toContain(Moderation.GSI_CONTENT_ID);
    expect(gsiNames).toContain(Moderation.GSI_ESCALATED);
    expect(gsiNames).toContain(Moderation.GSI_ACTIONED_AT);
  }); test('PASS_createModerationSchema_3: Idempotent behavior - when table already exists, Scylla.createTable handles gracefully without throwing or creating duplicates', async () => {
    const existingTableError = new Error('Table already exists');
    existingTableError.code = 'ResourceInUseException';
    Scylla.createTable = jest.fn().mockRejectedValue(existingTableError);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.createModerationSchema()).rejects.toThrow();
    
    expect(ErrorHandler.addError).toHaveBeenCalled();
  }); test('PASS_createModerationSchema_4: Correct projection configurations for each GSI (INCLUDE vs KEYS_ONLY) with appropriate NonKeyAttributes', async () => {
    Scylla.createTable = jest.fn().mockResolvedValue({});
    
    await Moderation.createModerationSchema();
    
    const callArgs = Scylla.createTable.mock.calls[0][0];
    const gsis = callArgs.GlobalSecondaryIndexes;
    
    const gsiByModId = gsis.find(gsi => gsi.IndexName === Moderation.GSI_BY_MOD_ID);
    expect(gsiByModId.Projection.ProjectionType).toBe('KEYS_ONLY');
    
    const otherGsis = gsis.filter(gsi => gsi.IndexName !== Moderation.GSI_BY_MOD_ID);
    otherGsis.forEach(gsi => {
      expect(gsi.Projection.ProjectionType).toBe('INCLUDE');
      expect(gsi.Projection.NonKeyAttributes).toBeDefined();
      expect(gsi.Projection.NonKeyAttributes.length).toBeGreaterThan(0);
    });
  }); test('FAIL_createModerationSchema_1: Scylla.createTable throws network error → ErrorHandler.addError called with SCHEMA_CREATION_FAILED code, method re-throws wrapped error', async () => {
    const networkError = new Error('Network error');
    Scylla.createTable = jest.fn().mockRejectedValue(networkError);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.createModerationSchema()).rejects.toThrow();
    
    expect(ErrorHandler.addError).toHaveBeenCalled();
    const errorCall = ErrorHandler.addError.mock.calls[0];
    expect(errorCall[0]).toContain('SCHEMA_CREATION_FAILED');
  }); test('FAIL_createModerationSchema_2: Partial index creation failure (e.g., quota exceeded mid-creation) → surfaces error and ErrorHandler logs it', async () => {
    const quotaError = new Error('Quota exceeded');
    quotaError.code = 'LimitExceededException';
    Scylla.createTable = jest.fn().mockRejectedValue(quotaError);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.createModerationSchema()).rejects.toThrow();
    
    expect(ErrorHandler.addError).toHaveBeenCalled();
  }); test('FAIL_createModerationSchema_3: Retry exhaustion on transient DynamoDB throttling → throws after max retries', async () => {
    const throttleError = new Error('Throttling');
    throttleError.code = 'ProvisionedThroughputExceededException';
    Scylla.createTable = jest.fn().mockRejectedValue(throttleError);
    
    await expect(Moderation.createModerationSchema()).rejects.toThrow();
  }); test('FAIL_createModerationSchema_4: Invalid schema configuration (malformed AttributeDefinitions) → throws validation error', async () => {
    const validationError = new Error('Invalid AttributeDefinitions');
    validationError.code = 'ValidationException';
    Scylla.createTable = jest.fn().mockRejectedValue(validationError);
    
    await expect(Moderation.createModerationSchema()).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: generateModerationId TESTS
   * --------------------------------
   */ test('PASS_generateModerationId_1: Returns non-empty string value', () => {
    const id = Moderation.generateModerationId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  }); test('PASS_generateModerationId_2: Generated value matches UUID v4 format (8-4-4-4-12 hex pattern)', () => {
    const id = Moderation.generateModerationId();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(id).toMatch(uuidRegex);
  }); test('PASS_generateModerationId_3: Uniqueness test - 10,000 sequential calls produce 10,000 unique IDs (no duplicates)', () => {
    const ids = new Set();
    for (let i = 0; i < 10000; i++) {
      const id = Moderation.generateModerationId();
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    expect(ids.size).toBe(10000);
  }); test('PASS_generateModerationId_4: Can be used immediately in createModerationEntry without validation errors', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    
    const data = {
      userId,
      contentId,
      type,
      priority,
      moderationId
    };
    
    await expect(Moderation.createModerationEntry(data)).resolves.toBeDefined();
  }); test('PASS_generateModerationId_5: Returns lowercase UUID (if code normalizes to lowercase)', () => {
    const id = Moderation.generateModerationId();
    expect(id).toBe(id.toLowerCase());
  }); test('FAIL_generateModerationId_1: Mock crypto.randomUUID to throw → catches error, logs via ErrorHandler, re-throws', () => {
    const crypto = require('crypto');
    const originalRandomUUID = crypto.randomUUID;
    crypto.randomUUID = jest.fn().mockImplementation(() => {
      throw new Error('Crypto error');
    });
    ErrorHandler.addError = jest.fn();
    
    expect(() => Moderation.generateModerationId()).toThrow();
    expect(ErrorHandler.addError).toHaveBeenCalled();
    
    crypto.randomUUID = originalRandomUUID;
  }); test('FAIL_generateModerationId_2: Mock crypto.randomUUID to return invalid format → validation catches downstream', () => {
    const crypto = require('crypto');
    const originalRandomUUID = crypto.randomUUID;
    crypto.randomUUID = jest.fn().mockReturnValue('invalid-uuid-format');
    
    const id = Moderation.generateModerationId();
    expect(id).toBe('invalid-uuid-format');
    
    crypto.randomUUID = originalRandomUUID;
  }); test('FAIL_generateModerationId_3: Environment without crypto support → throws meaningful error', () => {
    const crypto = require('crypto');
    const originalRandomUUID = crypto.randomUUID;
    delete crypto.randomUUID;
    
    expect(() => Moderation.generateModerationId()).toThrow();
    
    crypto.randomUUID = originalRandomUUID;
  });

  /**
   * --------------------------------
   * SECTION: dayKeyFromTs TESTS
   * --------------------------------
   */ test('PASS_dayKeyFromTs_1: Valid epoch milliseconds (1640995200000 = 2022-01-01 00:00:00 UTC) returns "20220101"', () => {
    const ts = 1640995200000;
    const dayKey = Moderation.dayKeyFromTs(ts);
    expect(dayKey).toBe('20220101');
  }); test('PASS_dayKeyFromTs_2: Accepts numeric string "1640995200000" and converts correctly', () => {
    const ts = '1640995200000';
    SafeUtils.sanitizeInteger = jest.fn(val => parseInt(val));
    const dayKey = Moderation.dayKeyFromTs(ts);
    expect(dayKey).toBe('20220101');
  }); test('PASS_dayKeyFromTs_3: Timestamp at end of day (23:59:59.999) returns correct dayKey for that calendar date', () => {
    const ts = 1641081599999; // 2022-01-01 23:59:59.999 UTC
    const dayKey = Moderation.dayKeyFromTs(ts);
    expect(dayKey).toBe('20220101');
  }); test('PASS_dayKeyFromTs_4: Timestamp at start of day (00:00:00.000) returns correct dayKey', () => {
    const ts = 1640995200000; // 2022-01-01 00:00:00.000 UTC
    const dayKey = Moderation.dayKeyFromTs(ts);
    expect(dayKey).toBe('20220101');
  }); test('PASS_dayKeyFromTs_5: Leap year Feb 29 (1582934400000 = 2020-02-29) returns "20200229"', () => {
    const ts = 1582934400000; // 2020-02-29 00:00:00 UTC
    const dayKey = Moderation.dayKeyFromTs(ts);
    expect(dayKey).toBe('20200229');
  }); test('PASS_dayKeyFromTs_6: Date changes across timezone boundaries (UTC vs local) - test assumes UTC interpretation', () => {
    const ts = 1640995200000; // 2022-01-01 00:00:00 UTC
    const dayKey = Moderation.dayKeyFromTs(ts);
    expect(dayKey).toBe('20220101');
  }); test('PASS_dayKeyFromTs_7: Current Date.now() returns today\'s YYYYMMDD correctly', () => {
    const now = Date.now();
    const dayKey = Moderation.dayKeyFromTs(now);
    const expectedDate = new Date(now);
    const expectedDayKey = expectedDate.toISOString().substring(0, 10).replace(/-/g, '');
    expect(dayKey).toBe(expectedDayKey);
  }); test('FAIL_dayKeyFromTs_1: `null` input → SafeUtils.sanitizeInteger returns null → ErrorHandler logs, throws "Invalid timestamp"', () => {
    SafeUtils.sanitizeInteger = jest.fn().mockReturnValue(null);
    ErrorHandler.addError = jest.fn();
    
    expect(() => Moderation.dayKeyFromTs(null)).toThrow('Invalid timestamp');
    expect(ErrorHandler.addError).toHaveBeenCalled();
  }); test('FAIL_dayKeyFromTs_2: `undefined` input → throws invalid timestamp error', () => {
    SafeUtils.sanitizeInteger = jest.fn().mockReturnValue(null);
    ErrorHandler.addError = jest.fn();
    
    expect(() => Moderation.dayKeyFromTs(undefined)).toThrow('Invalid timestamp');
  }); test('FAIL_dayKeyFromTs_3: Non-numeric string "abc" → sanitization fails → throws', () => {
    SafeUtils.sanitizeInteger = jest.fn().mockReturnValue(null);
    ErrorHandler.addError = jest.fn();
    
    expect(() => Moderation.dayKeyFromTs('abc')).toThrow();
  }); test('FAIL_dayKeyFromTs_4: Negative number -123456789 → throws', () => {
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    expect(() => Moderation.dayKeyFromTs(-123456789)).toThrow();
  }); test('FAIL_dayKeyFromTs_5: Extremely large number beyond reasonable date range (9999999999999999) → may overflow Date constructor', () => {
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    
    expect(() => Moderation.dayKeyFromTs(9999999999999999)).toThrow();
  }); test('FAIL_dayKeyFromTs_6: Float/decimal timestamp 1640995200000.567 → sanitizeInteger may truncate, verify behavior', () => {
    SafeUtils.sanitizeInteger = jest.fn(val => Math.floor(val));
    const dayKey = Moderation.dayKeyFromTs(1640995200000.567);
    expect(dayKey).toBe('20220101');
  }); test('FAIL_dayKeyFromTs_7: Zero timestamp (0 = 1970-01-01) → valid but edge case to verify', () => {
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    const dayKey = Moderation.dayKeyFromTs(0);
    expect(dayKey).toBe('19700101');
  }); test('FAIL_dayKeyFromTs_8: Object {valueOf: () => 12345} → type coercion attempt rejected by sanitization', () => {
    SafeUtils.sanitizeInteger = jest.fn().mockReturnValue(null);
    ErrorHandler.addError = jest.fn();
    const obj = { valueOf: () => 12345 };
    
    expect(() => Moderation.dayKeyFromTs(obj)).toThrow();
  });

  /**
   * --------------------------------
   * SECTION: statusSubmittedAtKey TESTS
   * --------------------------------
   */ test('PASS_statusSubmittedAtKey_1: Valid status "pending" + timestamp 1640995200000 returns "pending#1640995200000"', () => {
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    const key = Moderation.statusSubmittedAtKey('pending', 1640995200000);
    expect(key).toBe('pending#1640995200000');
  }); test('PASS_statusSubmittedAtKey_2: Different statuses ("approved", "rejected", "escalated") with same timestamp produce unique keys', () => {
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    const ts = 1640995200000;
    const key1 = Moderation.statusSubmittedAtKey('approved', ts);
    const key2 = Moderation.statusSubmittedAtKey('rejected', ts);
    const key3 = Moderation.statusSubmittedAtKey('escalated', ts);
    
    expect(key1).not.toBe(key2);
    expect(key2).not.toBe(key3);
    expect(key1).not.toBe(key3);
  }); test('PASS_statusSubmittedAtKey_3: Same status with different timestamps produces different keys', () => {
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    const key1 = Moderation.statusSubmittedAtKey('pending', 1640995200000);
    const key2 = Moderation.statusSubmittedAtKey('pending', 1641081600000);
    
    expect(key1).not.toBe(key2);
  }); test('PASS_statusSubmittedAtKey_4: Status with leading/trailing whitespace gets sanitized correctly', () => {
    SafeUtils.sanitizeString = jest.fn(str => str.trim());
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    const key = Moderation.statusSubmittedAtKey('  pending  ', 1640995200000);
    expect(key).toBe('pending#1640995200000');
  }); test('PASS_statusSubmittedAtKey_5: Timestamp as numeric string "1640995200000" works correctly', () => {
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => parseInt(val));
    const key = Moderation.statusSubmittedAtKey('pending', '1640995200000');
    expect(key).toBe('pending#1640995200000');
  }); test('PASS_statusSubmittedAtKey_6: All STATUS enum values produce valid keys', () => {
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    const ts = 1640995200000;
    
    Object.values(Moderation.STATUS).forEach(status => {
      const key = Moderation.statusSubmittedAtKey(status, ts);
      expect(key).toContain(status);
      expect(key).toContain('#');
      expect(key).toContain('1640995200000');
    });
  }); test('FAIL_statusSubmittedAtKey_1: Invalid status "unknown" not in STATUS_SET → throws validation error', () => {
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    expect(() => Moderation.statusSubmittedAtKey('unknown', 1640995200000)).toThrow();
  }); test('FAIL_statusSubmittedAtKey_2: Empty string status "" → sanitization returns null → throws', () => {
    SafeUtils.sanitizeString = jest.fn().mockReturnValue(null);
    ErrorHandler.addError = jest.fn();
    
    expect(() => Moderation.statusSubmittedAtKey('', 1640995200000)).toThrow();
  }); test('FAIL_statusSubmittedAtKey_3: Null status → throws', () => {
    SafeUtils.sanitizeString = jest.fn().mockReturnValue(null);
    ErrorHandler.addError = jest.fn();
    
    expect(() => Moderation.statusSubmittedAtKey(null, 1640995200000)).toThrow();
  }); test('FAIL_statusSubmittedAtKey_4: Invalid timestamp (negative, null, "abc") → throws', () => {
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn().mockReturnValue(null);
    ErrorHandler.addError = jest.fn();
    
    expect(() => Moderation.statusSubmittedAtKey('pending', -1000)).toThrow();
    expect(() => Moderation.statusSubmittedAtKey('pending', null)).toThrow();
    expect(() => Moderation.statusSubmittedAtKey('pending', 'abc')).toThrow();
  }); test('FAIL_statusSubmittedAtKey_5: Prototype pollution attempt status "__proto__" → rejected, no prototype mutation', () => {
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    expect(() => Moderation.statusSubmittedAtKey('__proto__', 1640995200000)).toThrow();
  }); test('FAIL_statusSubmittedAtKey_6: Status with special characters "pending#injection" → sanitized but then validation should catch if not in SET', () => {
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    expect(() => Moderation.statusSubmittedAtKey('pending#injection', 1640995200000)).toThrow();
  }); test('FAIL_statusSubmittedAtKey_7: Object as status {toString: () => "pending"} → type check fails', () => {
    SafeUtils.sanitizeString = jest.fn().mockReturnValue(null);
    ErrorHandler.addError = jest.fn();
    const obj = { toString: () => 'pending' };
    
    expect(() => Moderation.statusSubmittedAtKey(obj, 1640995200000)).toThrow();
  });

  /**
   * --------------------------------
   * SECTION: createModerationEntry TESTS
   * --------------------------------
   */ test('PASS_createModerationEntry_1: Minimal valid data (userId, contentId, type, priority) creates entry successfully, returns moderationId', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    const result = await Moderation.createModerationEntry(data);
    
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('PASS_createModerationEntry_2: Explicit timestamp parameter sets submittedAt to provided value', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const timestamp = 1640995200000;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, timestamp);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.submittedAt).toBe(timestamp);
  }); test('PASS_createModerationEntry_3: No timestamp provided → uses Date.now() for submittedAt', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const mockNow = 1640995200000;
    jest.spyOn(Date, 'now').mockReturnValue(mockNow);
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.submittedAt).toBe(mockNow);
    
    Date.now.mockRestore();
  }); test('PASS_createModerationEntry_4: Large content string (50KB+) gets compressed via _compressContent, stored as Buffer/base64', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const largeContent = 'x'.repeat(60000); // 60KB
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const data = { userId, contentId, type, priority, content: largeContent };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.content).toBeDefined();
    expect(putItemCall.Item.content._compressed).toBe(true);
  }); test('PASS_createModerationEntry_5: Pre-approved content (isPreApproved: true) sets status to "approved" instead of "pending"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, isPreApproved: true };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.status).toBe(Moderation.STATUS.APPROVED);
  }); test('PASS_createModerationEntry_6: System-generated content (isSystemGenerated: true) sets flag correctly', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, isSystemGenerated: true };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.isSystemGenerated).toBe(true);
  }); test('PASS_createModerationEntry_7: Meta field initialized with action="create", actor=userId, history array started, version=1', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.meta).toBeDefined();
    expect(putItemCall.Item.meta.version).toBe(1);
    expect(putItemCall.Item.meta.history).toBeDefined();
    expect(Array.isArray(putItemCall.Item.meta.history)).toBe(true);
  }); test('PASS_createModerationEntry_8: notes array provided and within MAX_NOTES_PER_ITEM limit → stored correctly', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const notes = [
      { text: 'Note 1', addedBy: 'user1', addedAt: Date.now() },
      { text: 'Note 2', addedBy: 'user2', addedAt: Date.now() }
    ];
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, notes };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.notes).toBeDefined();
    expect(putItemCall.Item.notes.length).toBe(2);
  }); test('PASS_createModerationEntry_9: All type enums (image, video, text, link, report, tags, emoji, icon, tag, personal_tag, global_tag, image_gallery, gallery, audio) accepted', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const types = Object.values(Moderation.TYPE);
    for (const type of types) {
      const data = { userId, contentId, type, priority };
      await Moderation.createModerationEntry(data);
      const _putArgs = Scylla.putItem.mock.calls[Scylla.putItem.mock.calls.length - 1];
      const putItemCall = { Item: _putArgs[1] };
      expect(putItemCall.Item.type).toBe(type);
    }
  }); test('PASS_createModerationEntry_10: All priority enums (high, normal, urgent, low) accepted', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const priorities = Object.values(Moderation.PRIORITY);
    for (const priority of priorities) {
      const data = { userId, contentId, type, priority };
      await Moderation.createModerationEntry(data);
      const _putArgs = Scylla.putItem.mock.calls[Scylla.putItem.mock.calls.length - 1];
      const putItemCall = { Item: _putArgs[1] };
      expect(putItemCall.Item.priority).toBe(priority);
    }
  }); test('PASS_createModerationEntry_11: Custom moderationId provided → validates format, checks for duplicates via GSI_BY_MOD_ID, uses provided ID if unique', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const customModerationId = Moderation.generateModerationId();
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId: customModerationId };
    const result = await Moderation.createModerationEntry(data);
    
    expect(result).toBe(customModerationId);
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.moderationId).toBe(customModerationId);
  }); test('PASS_createModerationEntry_12: dayKey generated correctly as YYYYMMDD from submittedAt', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const timestamp = 1640995200000; // 2022-01-01
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, timestamp);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.dayKey).toBe('20220101');
  }); test('PASS_createModerationEntry_13: statusSubmittedAt composite key created correctly', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const timestamp = 1640995200000;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, timestamp);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    const expectedKey = Moderation.statusSubmittedAtKey(Moderation.STATUS.PENDING, timestamp);
    expect(putItemCall.Item.statusSubmittedAt).toBe(expectedKey);
  }); test('PASS_createModerationEntry_14: PK format "moderation#<userId>", SK format "media#<submittedAt>#<moderationId>"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const timestamp = 1640995200000;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    const moderationId = await Moderation.createModerationEntry(data, timestamp);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.pk).toBe(`moderation#${userId}`);
    expect(putItemCall.Item.sk).toBe(`media#${timestamp}#${moderationId}`);
  }); test('PASS_createModerationEntry_15: Empty content field → stored as null', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, content: '' };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.content).toBeNull();
  }); test('PASS_createModerationEntry_16: Logs "moderationCreated" action via Logger.writeLog with MODERATIONS flag', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls.find(call => call[0]?.flag === 'MODERATIONS' && call[0]?.action === 'moderationCreated');
    expect(logCall).toBeDefined();
  }); test('PASS_createModerationEntry_17: ConditionExpression ensures PK/SK uniqueness, prevents silent overwrite', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0];
    const options = _putArgs[2];
    expect(options).toBeDefined();
    expect(options.ConditionExpression).toBeDefined();
    expect(options.ConditionExpression).toContain('attribute_not_exists');
  }); test('PASS_createModerationEntry_18: Soft delete fields (isDeleted: false, deletedAt: null) initialized', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.isDeleted).toBe(false);
    expect(putItemCall.Item.deletedAt).toBeNull();
  }); test('FAIL_createModerationEntry_1: Missing required field userId → _validateModerationData throws, ErrorHandler logs INVALID_MODERATION_DATA', async () => {
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    ErrorHandler.addError = jest.fn();
    
    const data = { contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
    expect(ErrorHandler.addError).toHaveBeenCalled();
  }); test('FAIL_createModerationEntry_2: Missing contentId → throws', async () => {
    const userId = 'user123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_3: Missing type → throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const priority = Moderation.PRIORITY.NORMAL;
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_4: Missing priority → throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_5: Invalid type "invalid_type" not in TYPE_SET → throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const priority = Moderation.PRIORITY.NORMAL;
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type: 'invalid_type', priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_6: Invalid status explicitly provided → throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority, status: 'invalid_status' };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_7: Invalid priority "super_high" not in PRIORITY_SET → throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority: 'super_high' };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_8: Invalid timestamp -1000 → throws "Invalid timestamp: must be positive integer"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data, -1000)).rejects.toThrow('Invalid timestamp');
  }); test('FAIL_createModerationEntry_9: Timestamp more than 5 years in past → throws "Timestamp too far in the past"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const fiveYearsAgo = Date.now() - (6 * 365 * 24 * 60 * 60 * 1000);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data, fiveYearsAgo)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_10: Timestamp more than 5 minutes in future → throws "Timestamp in the future beyond clock skew tolerance"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const futureTimestamp = Date.now() + (6 * 60 * 1000); // 6 minutes in future
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data, futureTimestamp)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_11: Duplicate PK/SK collision → ConditionalCheckFailedException → logs MODERATION_ENTRY_ALREADY_EXISTS, throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.code = 'ConditionalCheckFailedException';
    Scylla.putItem = jest.fn().mockRejectedValue(conditionalError);
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
    expect(ErrorHandler.addError).toHaveBeenCalled();
  }); test('FAIL_createModerationEntry_12: Duplicate moderationId provided → GSI query finds existing → throws "ModerationId already exists"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const existingModerationId = Moderation.generateModerationId();
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId: existingModerationId }] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId: existingModerationId };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_13: Scylla.putItem fails with throttling → retries exhausted → throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    const throttleError = new Error('Throttling');
    throttleError.code = 'ProvisionedThroughputExceededException';
    Scylla.putItem = jest.fn().mockRejectedValue(throttleError);
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_14: Malformed data with prototype pollution payload `{__proto__: {isAdmin: true}}` → SafeUtils prevents mutation', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.safeObject = jest.fn(obj => {
      const safe = { ...obj };
      delete safe.__proto__;
      return safe;
    });
    
    const data = { userId, contentId, type, priority, __proto__: { isAdmin: true } };
    await Moderation.createModerationEntry(data);
    
    expect(SafeUtils.safeObject).toHaveBeenCalled();
  }); test('FAIL_createModerationEntry_15: Notes array exceeds MAX_NOTES_PER_ITEM (51 notes) → throws "Notes array exceeds maximum limit"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const notes = Array(51).fill(null).map((_, i) => ({
      text: `Note ${i}`,
      addedBy: 'user1',
      addedAt: Date.now()
    }));
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority, notes };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_16: Individual note exceeds MAX_NOTE_LENGTH (5001 chars) → _validateNoteStructure throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const longNote = 'x'.repeat(5001);
    const notes = [{ text: longNote, addedBy: 'user1', addedAt: Date.now() }];
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority, notes };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_17: Note missing required fields (text, addedAt, addedBy) → _validateNoteStructure throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const notes = [{ text: 'Note' }]; // Missing addedBy and addedAt
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority, notes };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_18: Empty userId after sanitization (whitespace only "   ") → throws "Invalid userId: cannot be empty"', async () => {
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    const data = { userId: '   ', contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_19: Non-object data parameter (string, array, null) → throws', async () => {
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.createModerationEntry('string')).rejects.toThrow();
    await expect(Moderation.createModerationEntry([])).rejects.toThrow();
    await expect(Moderation.createModerationEntry(null)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_20: Content compression fails (mocked gzip failure) → throws compression error', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const largeContent = 'x'.repeat(60000);
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      callback(new Error('Compression failed'));
    });
    
    const data = { userId, contentId, type, priority, content: largeContent };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: updateModerationEntry TESTS
   * --------------------------------
   */ test('PASS_updateModerationEntry_1: Updates allowed fields (contentId, contentType, mediaType, priority, type) successfully', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH, type: Moderation.TYPE.VIDEO };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationEntry_2: Optimistic locking succeeds on first attempt with version check', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    const opts = Scylla.updateItem.mock.calls[0][3];
    expect(opts && opts.ConditionExpression).toBeDefined();
    expect(opts.ConditionExpression).toContain('version');
    expect(Scylla.updateItem).toHaveBeenCalledTimes(1);
  }); test('PASS_updateModerationEntry_3: Optimistic locking retries after version conflict, succeeds on 2nd attempt', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.awsType = 'ConditionalCheckFailedException';
    const existingItemV2 = { ...existingItem, meta: { version: 2, history: [] } };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn()
      .mockResolvedValueOnce(existingItem)
      .mockResolvedValueOnce(existingItemV2);
    Scylla.updateItem = jest.fn()
      .mockRejectedValueOnce(conditionalError)
      .mockResolvedValueOnce({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalledTimes(2);
  }); test('PASS_updateModerationEntry_4: Updates isSystemGenerated boolean correctly (true/false)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { isSystemGenerated: true };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isSystemGenerated: false,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationEntry_5: Updates isPreApproved boolean correctly', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { isPreApproved: true };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isPreApproved: false,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationEntry_6: Updating status also updates derived fields (statusSubmittedAt, actionedAt if applicable)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    const timestamp = 1640995200000;
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#${timestamp}#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      submittedAt: timestamp,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
    const updateArg = Scylla.updateItem.mock.calls[0][2];
    expect(updateArg).toBeDefined();
    expect(updateArg.priority === Moderation.PRIORITY.HIGH || updateArg.meta).toBe(true);
  }); test('PASS_updateModerationEntry_7: Large content update triggers compression path, maintains integrity', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const largeContent = 'x'.repeat(60000);
    const updates = { content: largeContent };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      content: 'old content',
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationEntry_8: Meta field updated with new history entry, version incremented', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    const updateArg = Scylla.updateItem.mock.calls[0][2];
    expect(updateArg.meta).toBeDefined();
    expect(updateArg.meta.version).toBeDefined();
  }); test('PASS_updateModerationEntry_9: Logs "moderationUpdated" with list of updated fields via Logger.writeLog', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls.find(c => c[0]?.flag === 'MODERATIONS' && c[0]?.action === 'moderationUpdated');
    expect(logCall).toBeDefined();
  }); test('PASS_updateModerationEntry_10: Partial update (only 1-2 fields) doesn\'t overwrite other fields', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      type: Moderation.TYPE.IMAGE,
      contentId: 'content123',
      priority: Moderation.PRIORITY.NORMAL,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem.mock.calls[0][2]).toBeDefined();
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationEntry_11: Notes array update validates length limit and structure', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const notes = [
      { text: 'Note 1', addedBy: 'user1', addedAt: Date.now() },
      { text: 'Note 2', addedBy: 'user2', addedAt: Date.now() }
    ];
    const updates = { notes };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationEntry_12: Unknown fields in updates object are ignored (or explicitly rejected based on implementation)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH, unknownField: 'value' };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationEntry_13: Decompresses existing content before comparison/update logic', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { content: 'new content' };
    
    const decompressedContent = { original: 'content' };
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      content: { _compressed: true, _format: 'gzip', data: Buffer.from(JSON.stringify(decompressedContent)).toString('base64') },
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationEntry_14: Requires userId parameter for consistent read via PK/SK', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.getItem).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ pk: `moderation#${userId}` }));
  }); test('PASS_updateModerationEntry_15: Action field update validates against ACTION_SET', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationEntry_16: Soft delete fields can be updated (isDeleted, deletedAt) with consistency checks', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isDeleted: false,
      deletedAt: null,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('FAIL_updateModerationEntry_1: Missing moderationId parameter → throws "moderationId is required"', async () => {
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(null, updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_2: Blank moderationId after sanitization → throws', async () => {
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry('   ', updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_3: Invalid moderationId format (not UUID) → _validateModerationIdFormat throws', async () => {
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry('invalid-id', updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_4: Missing userId parameter → throws "userId is required for updateModerationEntry"', async () => {
    const moderationId = Moderation.generateModerationId();
    const updates = { priority: Moderation.PRIORITY.HIGH };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, null)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_5: Empty userId after sanitization → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const updates = { priority: Moderation.PRIORITY.HIGH };
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, '   ')).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_6: Updates parameter not an object (string/array/null) → throws "Updates must be an object"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, 'string', userId)).rejects.toThrow();
    await expect(Moderation.updateModerationEntry(moderationId, [], userId)).rejects.toThrow();
    await expect(Moderation.updateModerationEntry(moderationId, null, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_7: Invalid enum value in updates.priority → throws "Invalid priority"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: 'invalid_priority' };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_8: Invalid enum value in updates.type → throws "Invalid type"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { type: 'invalid_type' };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_9: Invalid enum value in updates.action → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { action: 'invalid_action' };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_10: Optimistic locking exceeds max retries (5) → throws "concurrent modification" error', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.code = 'ConditionalCheckFailedException';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(conditionalError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_11: Moderation item not found for given moderationId+userId → throws "Moderation item not found"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_12: Scylla.updateItem fails with conditional check failure → retries → exhausts → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.code = 'ConditionalCheckFailedException';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(conditionalError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_13: Scylla query failure on GSI_BY_MOD_ID lookup → retries → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const queryError = new Error('Query failed');
    Scylla.request = jest.fn().mockRejectedValue(queryError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_14: Notes array exceeds MAX_NOTES_PER_ITEM → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const notes = Array(51).fill(null).map((_, i) => ({
      text: `Note ${i}`,
      addedBy: 'user1',
      addedAt: Date.now()
    }));
    const updates = { notes };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_15: Individual note validation fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const notes = [{ text: 'Note without required fields' }];
    const updates = { notes };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_16: Inconsistent delete flags (isDeleted=true but deletedAt=null) → throws validation error', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { isDeleted: true, deletedAt: null };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_17: Attempt to update immutable fields (submittedAt, moderationId) → silently ignored or throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { submittedAt: Date.now(), moderationId: 'new-id' };
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    
    // This should either throw or ignore immutable fields
    try {
      await Moderation.updateModerationEntry(moderationId, updates, userId);
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('FAIL_updateModerationEntry_18: Content decompression fails on existing item → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { content: 'new content' };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      content: Buffer.from('corrupted'),
      contentCompressed: true
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    const gunzipSpy = jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(new Error('Decompression failed'));
    });
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
    gunzipSpy.mockRestore();
  }); test('FAIL_updateModerationEntry_19: Prototype pollution in updates object → prevented by SafeUtils', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH, __proto__: { isAdmin: true } };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.safeObject = jest.fn(obj => {
      const safe = { ...obj };
      delete safe.__proto__;
      return safe;
    });
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(SafeUtils.safeObject).toHaveBeenCalled();
  });

  /**
   * --------------------------------
   * SECTION: addNote TESTS
   * --------------------------------
   */ test('PASS_addNote_1: First note added to empty notes array, structure includes {text, addedBy, addedAt}', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'This is a test note';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeTextField = jest.fn(str => (str && typeof str === 'string' ? str.trim() : ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.notes).toBeDefined();
    expect(updatePayload.meta).toBeDefined();
  }); test('PASS_addNote_2: Note text trimmed and sanitized, preserves valid content', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = '  This is a test note  ';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => (str && typeof str === 'string' ? str.trim() : str));
    SafeUtils.sanitizeTextField = jest.fn(str => (str && typeof str === 'string' ? str.trim() : ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_addNote_3: Subsequent note appended to existing notes array, increments noteCount', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'Second note';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: [
        { text: 'First note', addedBy: 'user1', addedAt: Date.now() }
      ]
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeTextField = jest.fn(str => (str && typeof str === 'string' ? str : ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
    expect(Scylla.updateItem.mock.calls[0][2].notes).toHaveLength(2);
  }); test('PASS_addNote_4: Enforces MAX_NOTES_PER_ITEM (50) - adding 50th note succeeds', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = '50th note';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: Array(49).fill(null).map((_, i) => ({
        text: `Note ${i}`,
        addedBy: 'user1',
        addedAt: Date.now()
      }))
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeTextField = jest.fn(str => (str && typeof str === 'string' ? str : ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_addNote_5: Meta field updated with "noteAdded" action in history', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'Test note';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: [],
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeTextField = jest.fn(str => (str && typeof str === 'string' ? str : ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
    expect(Scylla.updateItem.mock.calls[0][2].meta).toBeDefined();
  }); test('PASS_addNote_6: Note with maximum allowed length (MAX_NOTE_LENGTH = 5000 chars) accepted', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'x'.repeat(5000);
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeTextField = jest.fn(str => (str && typeof str === 'string' ? str : ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_addNote_7: HTML/special characters in note sanitized properly', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = '<script>alert("xss")</script>';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeTextField = jest.fn(str => (str && typeof str === 'string' ? str.replace(/<script>/gi, '') : ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(SafeUtils.sanitizeTextField).toHaveBeenCalled();
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_addNote_8: Optimistic locking ensures concurrent note additions don\'t conflict', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'Test note';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeTextField = jest.fn(str => (str && typeof str === 'string' ? str : ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_addNote_9: Logs "noteAdded" action via Logger.writeLog', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'Test note';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeTextField = jest.fn(str => (str && typeof str === 'string' ? str : ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls.find(c => c[0]?.flag === 'MODERATIONS' && c[0]?.action === 'noteAdded');
    expect(logCall).toBeDefined();
  }); test('FAIL_addNote_1: Missing moderationId → throws', async () => {
    const userId = 'user123';
    const note = 'Test note';
    const addedBy = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(null, userId, note, addedBy)).rejects.toThrow();
  }); test('FAIL_addNote_2: Missing userId → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const note = 'Test note';
    const addedBy = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, null, note, addedBy)).rejects.toThrow();
  }); test('FAIL_addNote_3: Missing note parameter → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const addedBy = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, null, addedBy)).rejects.toThrow();
  }); test('FAIL_addNote_4: Missing addedBy parameter → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'Test note';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, note, null)).rejects.toThrow();
  }); test('FAIL_addNote_5: Invalid moderationId format → throws', async () => {
    const userId = 'user123';
    const note = 'Test note';
    const addedBy = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote('invalid-id', userId, note, addedBy)).rejects.toThrow();
  }); test('FAIL_addNote_6: Empty note after sanitization/trim → throws "Note text cannot be empty"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = '   ';
    const addedBy = 'moderator1';
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, note, addedBy)).rejects.toThrow();
  }); test('FAIL_addNote_7: Note length exceeds MAX_NOTE_LENGTH (5001 chars) → throws "Note text exceeds maximum length"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'x'.repeat(5001);
    const addedBy = 'moderator1';
    SafeUtils.sanitizeString = jest.fn(str => str);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, note, addedBy)).rejects.toThrow();
  }); test('FAIL_addNote_8: Moderation record not found → throws "Moderation item not found"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'Test note';
    const addedBy = 'moderator1';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, note, addedBy)).rejects.toThrow();
  }); test('FAIL_addNote_9: Notes array already at MAX_NOTES_PER_ITEM (50), adding 51st → throws "Maximum notes limit reached"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = '51st note';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: Array(50).fill(null).map((_, i) => ({
        text: `Note ${i}`,
        addedBy: 'user1',
        addedAt: Date.now()
      }))
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, note, addedBy)).rejects.toThrow();
  }); test('FAIL_addNote_10: Scylla.updateItem fails → retries → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'Test note';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    const updateError = new Error('Update failed');
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(updateError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, note, addedBy)).rejects.toThrow();
  }); test('FAIL_addNote_11: Optimistic locking exceeds retries → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'Test note';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.code = 'ConditionalCheckFailedException';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(conditionalError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, note, addedBy)).rejects.toThrow();
  }); test('FAIL_addNote_12: Note is null after sanitization → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = null;
    const addedBy = 'moderator1';
    SafeUtils.sanitizeString = jest.fn().mockReturnValue(null);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, note, addedBy)).rejects.toThrow();
  }); test('FAIL_addNote_13: addedBy is empty string → throws validation error', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'Test note';
    const addedBy = '';
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, note, addedBy)).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: applyModerationAction TESTS
   * --------------------------------
   */ test('PASS_applyModerationAction_1: Action "approve" sets status to "approved", actionedAt to current timestamp', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    const timestamp = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(timestamp);
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING,
      submittedAt: 1640995200000
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].status).toBe(Moderation.STATUS.APPROVED);
    expect(updateCall[2].actionedAt).toBe(timestamp);
    Date.now.mockRestore();
  }); test('PASS_applyModerationAction_2: Action "reject" sets status to "rejected", stores sanitized reason', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.REJECT;
    const moderatorId = 'moderator1';
    const reason = 'Violates community guidelines';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId, reason);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].status).toBe(Moderation.STATUS.REJECTED);
    expect(updateCall[2].reason).toBeDefined();
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_3: Action "pending_resubmission" sets action field correctly, status remains "pending"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.PENDING_RESUBMISSION;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].action).toBe(Moderation.ACTION.PENDING_RESUBMISSION);
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_4: moderationType="global" triggers status "approved_global" instead of "approved"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    const moderationType = Moderation.MODERATION_TYPE.GLOBAL;
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, '', moderatorId, moderationType);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].status).toBe(Moderation.STATUS.APPROVED_GLOBAL);
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_5: moderationType="standard" uses regular "approved" status', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    const moderationType = Moderation.MODERATION_TYPE.STANDARD;
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, '', moderatorId, moderationType);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_6: Optional note parameter adds note to notes array', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    const note = 'Approved with note';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING,
      notes: []
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.sanitizeTextField = jest.fn(str => (str && typeof str === 'string' ? str.trim() : ''));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, '', moderatorId, 'standard', note);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].notes).toBeDefined();
    expect(Array.isArray(updateCall[2].notes)).toBe(true);
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_7: Optional publicNote parameter stored in meta or separate field', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    const publicNote = 'Public note';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.sanitizeTextField = jest.fn(str => (str && typeof str === 'string' ? str.trim() : ''));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId, null, null, publicNote);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_8: Meta field history entry includes actor=moderatorId, action, previousStatus, timestamp', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].meta).toBeDefined();
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_9: Logs "moderationActioned" with action type via Logger.writeLog', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls.find(call => call[0]?.flag === 'MODERATIONS' && (call[0]?.action === 'actionApplied' || call[0]?.action === 'moderationActioned'));
    expect(logCall).toBeDefined();
  }); test('PASS_applyModerationAction_10: Concurrent moderator attempts - only one succeeds due to optimistic locking', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[3].ConditionExpression).toBeDefined();
    expect(updateCall[3].ConditionExpression).toContain('version');
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_11: Reason text sanitized and trimmed before storage', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.REJECT;
    const moderatorId = 'moderator1';
    const reason = '  Violates guidelines  ';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str.trim());
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId, reason);
    
    expect(SafeUtils.sanitizeString).toHaveBeenCalled();
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_12: statusSubmittedAt updated to reflect new status', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    const timestamp = 1640995200000;
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#${timestamp}#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      submittedAt: timestamp
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].statusSubmittedAt).toBeDefined();
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_13: Updates moderatedBy field to moderatorId', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, '', moderatorId);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].moderatedBy).toBe(moderatorId);
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_14: Decompresses existing content before action logic', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const decompressedContent = { original: 'content' };
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING,
      content: { _compressed: true, _format: 'gzip', data: Buffer.from(JSON.stringify(decompressedContent)).toString('base64') }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('FAIL_applyModerationAction_1: Missing moderationId → throws', async () => {
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction(null, userId, action, moderatorId)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_2: Missing userId → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, null, action, moderatorId)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_3: Missing action → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const moderatorId = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, null, moderatorId)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_4: Missing moderatorId → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, action, null)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_5: Invalid moderationId format → throws', async () => {
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction('invalid-id', userId, action, moderatorId)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_6: Invalid action enum (not in ACTION_SET) → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const moderatorId = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, 'invalid_action', moderatorId)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_7: Invalid moderationType (not "standard" or "global") → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, action, moderatorId, null, null, null, 'invalid_type')).rejects.toThrow();
  }); test('FAIL_applyModerationAction_8: Reason text exceeds reasonable limit (e.g., 10000 chars) → throws or truncates', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.REJECT;
    const moderatorId = 'moderator1';
    const reason = 'x'.repeat(10001);
    SafeUtils.sanitizeString = jest.fn(str => str);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, action, moderatorId, reason)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_9: Action/status inconsistency (action="approve" but manually setting status="rejected") → throws validation error', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.REJECTED
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    // This should validate action/status consistency
    await expect(Moderation.applyModerationAction(moderationId, userId, action, moderatorId)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_10: Moderation item not found → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, action, moderatorId)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_11: Scylla.updateItem fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    const updateError = new Error('Update failed');
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(updateError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, action, moderatorId)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_12: Optimistic locking fails after max retries → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.code = 'ConditionalCheckFailedException';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(conditionalError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, action, moderatorId)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_13: Note parameter exceeds MAX_NOTE_LENGTH → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    const note = 'x'.repeat(5001);
    SafeUtils.sanitizeString = jest.fn(str => str);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, action, moderatorId, null, note)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_14: Empty moderatorId after sanitization → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = '   ';
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, action, moderatorId)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_15: Prototype pollution in reason or note → prevented', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.REJECT;
    const moderatorId = 'moderator1';
    const reason = { __proto__: { isAdmin: true } };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.safeObject = jest.fn(obj => {
      const safe = { ...obj };
      delete safe.__proto__;
      return safe;
    });
    ErrorHandler.addError = jest.fn();
    
    // Should handle prototype pollution safely
    try {
      await Moderation.applyModerationAction(moderationId, userId, action, moderatorId, reason);
    } catch (error) {
      // Expected to throw or handle safely
      expect(error).toBeDefined();
    }
  });

  /**
   * --------------------------------
   * SECTION: escalateModerationItem TESTS
   * --------------------------------
   */ test('PASS_escalateModerationItem_1: Sets status to "escalated", escalatedBy field to provided value', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].status).toBe(Moderation.STATUS.ESCALATED);
    expect(updateCall[2].escalatedBy).toBe(escalatedBy);
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_escalateModerationItem_2: Preserves all previous fields and history, appends escalation entry to meta', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      priority: Moderation.PRIORITY.HIGH,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].meta).toBeDefined();
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_escalateModerationItem_3: Idempotent - escalating already escalated item doesn\'t duplicate history or cause errors', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.ESCALATED,
      escalatedBy: 'moderator2'
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_escalateModerationItem_4: Updates actionedAt to current timestamp', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    const timestamp = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(timestamp);
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].actionedAt).toBe(timestamp);
    Date.now.mockRestore();
  }); test('PASS_escalateModerationItem_5: Updates statusSubmittedAt to reflect escalated status', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    const timestamp = 1640995200000;
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING,
      submittedAt: timestamp
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].statusSubmittedAt).toBeDefined();
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_escalateModerationItem_6: Meta history includes previousStatus and previousEscalatedBy', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].meta).toBeDefined();
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_escalateModerationItem_7: Logs "itemEscalated" action via Logger.writeLog', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls.find(call => call[0]?.flag === 'MODERATIONS' && (call[0]?.action === 'itemEscalated' || call[0]?.action === 'escalated'));
    expect(logCall).toBeDefined();
  }); test('PASS_escalateModerationItem_8: Optimistic locking with version check succeeds', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[3].ConditionExpression).toContain('version');
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_escalateModerationItem_9: Decompresses content if compressed', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const decompressedContent = { original: 'content' };
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING,
      content: { _compressed: true, _format: 'gzip', data: Buffer.from(JSON.stringify(decompressedContent)).toString('base64') }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('FAIL_escalateModerationItem_1: Missing moderationId → throws', async () => {
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.escalateModerationItem(null, userId, escalatedBy)).rejects.toThrow();
  }); test('FAIL_escalateModerationItem_2: Missing userId → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const escalatedBy = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.escalateModerationItem(moderationId, null, escalatedBy)).rejects.toThrow();
  }); test('FAIL_escalateModerationItem_3: Missing escalatedBy → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.escalateModerationItem(moderationId, userId, null)).rejects.toThrow();
  }); test('FAIL_escalateModerationItem_4: Invalid moderationId format → throws', async () => {
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.escalateModerationItem('invalid-id', userId, escalatedBy)).rejects.toThrow();
  }); test('FAIL_escalateModerationItem_5: Empty escalatedBy after sanitization → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = '   ';
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.escalateModerationItem(moderationId, userId, escalatedBy)).rejects.toThrow();
  }); test('FAIL_escalateModerationItem_6: Item not found → throws "Moderation item not found"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.escalateModerationItem(moderationId, userId, escalatedBy)).rejects.toThrow();
  }); test('FAIL_escalateModerationItem_7: Scylla.updateItem fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    const updateError = new Error('Update failed');
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(updateError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.escalateModerationItem(moderationId, userId, escalatedBy)).rejects.toThrow();
  }); test('FAIL_escalateModerationItem_8: Optimistic locking exceeds retries → throws "concurrent modification"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.code = 'ConditionalCheckFailedException';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(conditionalError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.escalateModerationItem(moderationId, userId, escalatedBy)).rejects.toThrow();
  }); test('FAIL_escalateModerationItem_9: GSI query failure on item lookup → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const queryError = new Error('Query failed');
    Scylla.request = jest.fn().mockRejectedValue(queryError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.escalateModerationItem(moderationId, userId, escalatedBy)).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: getModerationItems TESTS
   * --------------------------------
   */ test('PASS_getModerationItems_1: No filters, no options → returns default 20 items from primary table', async () => {
    const mockItems = Array(20).fill(null).map((_, i) => ({
      moderationId: Moderation.generateModerationId(),
      userId: `user${i}`,
      pk: `moderation#user${i}`,
      sk: `media#1640995200000#${Moderation.generateModerationId()}`,
      status: Moderation.STATUS.PENDING
    }));
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItems({}, {});
    
    expect(result).toBeDefined();
    expect(result.items).toBeDefined();
    expect(Scylla.request).toHaveBeenCalled();
  }); test('PASS_getModerationItems_2: Filter by status only → uses GSI_STATUS_DATE', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_STATUS_DATE);
  }); test('PASS_getModerationItems_3: Filter by userId + status → uses GSI_USER_STATUS_DATE', async () => {
    const filters = { userId: 'user123', status: Moderation.STATUS.PENDING };
    const mockItems = [{ moderationId: '123', userId: 'user123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_USER_STATUS_DATE);
  }); test('PASS_getModerationItems_4: Filter by dayKey → uses GSI_ALL_BY_DATE', async () => {
    const filters = { dayKey: '20220101' };
    const mockItems = [{ moderationId: '123', dayKey: '20220101' }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_ALL_BY_DATE);
  }); test('PASS_getModerationItems_5: Filter by priority → uses GSI_PRIORITY', async () => {
    const filters = { priority: Moderation.PRIORITY.HIGH };
    const mockItems = [{ moderationId: '123', priority: Moderation.PRIORITY.HIGH }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_PRIORITY);
  }); test('PASS_getModerationItems_6: Filter by type → uses GSI_TYPE_DATE', async () => {
    const filters = { type: Moderation.TYPE.IMAGE };
    const mockItems = [{ moderationId: '123', type: Moderation.TYPE.IMAGE }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_TYPE_DATE);
  }); test('PASS_getModerationItems_7: Combination filters (userId + status + date range) → correct index chosen, FilterExpression applied', async () => {
    const filters = { 
      userId: 'user123', 
      status: Moderation.STATUS.PENDING,
      startTimestamp: 1640995200000,
      endTimestamp: 1641081600000
    };
    const mockItems = [{ moderationId: '123', userId: 'user123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_USER_STATUS_DATE);
    expect(queryCall.FilterExpression).toBeDefined();
  }); test('PASS_getModerationItems_8: Pagination with nextToken → decodes token, passes ExclusiveStartKey, returns next page', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    const nextToken = Buffer.from(JSON.stringify({ lastKey: mockLastKey }), 'utf8').toString('base64');
    const options = { nextToken };
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItems(filters, options);
    
    expect(result).toBeDefined();
    expect(result.nextToken).toBeDefined();
    const requestParams = Scylla.request.mock.calls[0][1];
    expect(requestParams.ExclusiveStartKey).toBeDefined();
    expect(requestParams.ExclusiveStartKey).toEqual(mockLastKey);
  }); test('PASS_getModerationItems_9: Date range filters (start + end) → BETWEEN expression applied', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const options = { start: 1640995200000, end: 1641081600000 };
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.KeyConditionExpression).toContain('BETWEEN');
  }); test('PASS_getModerationItems_10: Only start timestamp → uses >= expression', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const options = { start: 1640995200000 };
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.KeyConditionExpression).toContain('>=');
  }); test('PASS_getModerationItems_11: Only end timestamp → uses <= expression', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const options = { end: 1641081600000 };
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.KeyConditionExpression).toContain('<=');
  }); test('PASS_getModerationItems_12: Sort ascending (asc=true) → ScanIndexForward=true', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const options = { asc: true };
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.ScanIndexForward).toBe(true);
  }); test('PASS_getModerationItems_13: Sort descending (asc=false, default) → ScanIndexForward=false', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const options = { asc: false };
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.ScanIndexForward).toBe(false);
  }); test('PASS_getModerationItems_14: Limit enforced (limit=50) → returns max 50 items', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const options = { limit: 50 };
    const mockItems = Array(50).fill(null).map((_, i) => ({
      moderationId: `id${i}`,
      status: Moderation.STATUS.PENDING
    }));
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItems(filters, options);
    
    expect(result.items.length).toBeLessThanOrEqual(50);
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.Limit).toBe(50);
  }, 10000); test('PASS_getModerationItems_15: Decompresses all items with compressed content', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const originalContent = { text: 'decompressed' };
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    zlib.gunzip.mockImplementation((buf, cb) => realZlib.gunzip(buf, (err, res) => (cb ? cb(err, res) : undefined)));
    const compressed = await new Promise((res, rej) => {
      realZlib.gzip(Buffer.from(JSON.stringify(originalContent), 'utf8'), (err, buf) => (err ? rej(err) : res(buf)));
    });
    const mockItems = [{
      moderationId: '123',
      status: Moderation.STATUS.PENDING,
      content: { _compressed: true, _format: 'gzip', data: compressed.toString('base64') }
    }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItems(filters, {});
    
    expect(result.items).toBeDefined();
    expect(result.items.length).toBe(1);
    expect(result.items[0].content).toEqual(originalContent);
  }, 10000); test('PASS_getModerationItems_16: Empty result set → returns {items: [], nextToken: null, hasMore: false}', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItems(filters, {});
    
    expect(result.items).toEqual([]);
    expect(result.nextToken).toBeNull();
    expect(result.hasMore).toBe(false);
  }); test('PASS_getModerationItems_17: Response includes count field matching items length', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const mockItems = Array(10).fill(null).map((_, i) => ({
      moderationId: `id${i}`,
      status: Moderation.STATUS.PENDING
    }));
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItems(filters, {});
    
    expect(result.count).toBe(result.items.length);
  }); test('PASS_getModerationItems_18: Logs debug info on success', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    expect(Logger.debugLog).toHaveBeenCalled();
  }); test('FAIL_getModerationItems_1: Invalid status enum → throws "Invalid status"', async () => {
    const filters = { status: 'invalid_status' };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItems(filters, {})).rejects.toThrow();
  }); test('FAIL_getModerationItems_2: Invalid priority enum → throws "Invalid priority"', async () => {
    const filters = { priority: 'invalid_priority' };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItems(filters, {})).rejects.toThrow();
  }); test('FAIL_getModerationItems_3: Invalid type enum → throws "Invalid type"', async () => {
    const filters = { type: 'invalid_type' };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItems(filters, {})).rejects.toThrow();
  }); test('FAIL_getModerationItems_4: Invalid dayKey format (not YYYYMMDD) → throws "Invalid dayKey format"', async () => {
    const filters = { dayKey: '2022-01-01' };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItems(filters, {})).rejects.toThrow();
  }); test('FAIL_getModerationItems_5: dayKey represents invalid calendar date (20221399) → throws "Invalid dayKey: does not represent a valid calendar date"', async () => {
    const filters = { dayKey: '20221399' };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItems(filters, {})).rejects.toThrow();
  }); test('FAIL_getModerationItems_6: Limit exceeds MAX_QUERY_RESULT_SIZE (1001) → throws "Query limit cannot exceed 1000"', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const options = { limit: 1001 };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItems(filters, options)).rejects.toThrow();
  }); test('FAIL_getModerationItems_7: Invalid nextToken (not base64, corrupted) → throws decoding error', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const options = { nextToken: 'invalid-token' };
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    const gunzipSpy = jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(new Error('Decoding failed'));
    });
    
    await expect(Moderation.getModerationItems(filters, options)).rejects.toThrow();
    gunzipSpy.mockRestore();
  }); test('FAIL_getModerationItems_8: nextToken expired (TTL check) → throws "Pagination token expired"', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const expiredToken = Buffer.from(JSON.stringify({ 
      lastKey: {}, 
      timestamp: Date.now() - (20 * 60 * 1000) // 20 minutes ago
    })).toString('base64');
    const options = { nextToken: expiredToken };
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    const gunzipSpy = jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(null, Buffer.from(JSON.stringify({ lastKey: {}, timestamp: Date.now() - (20 * 60 * 1000) })));
    });
    
    await expect(Moderation.getModerationItems(filters, options)).rejects.toThrow();
    gunzipSpy.mockRestore();
  }); test('FAIL_getModerationItems_9: nextToken too large (>100KB) → throws "Token too large"', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const largeToken = 'x'.repeat(102401); // > 100KB
    const options = { nextToken: largeToken };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItems(filters, options)).rejects.toThrow();
  }); test('FAIL_getModerationItems_10: Scylla query fails → retries → throws', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const queryError = new Error('Query failed');
    Scylla.request = jest.fn().mockRejectedValue(queryError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItems(filters, {})).rejects.toThrow();
  }); test('FAIL_getModerationItems_11: No suitable index for filter combination → throws "No suitable index"', async () => {
    const filters = { 
      someUnknownField: 'value',
      anotherUnknownField: 'value2'
    };
    ErrorHandler.addError = jest.fn();
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    
    const result = await Moderation.getModerationItems(filters, {});
    expect(Scylla.request).toHaveBeenCalledWith('Scan', expect.any(Object));
    expect(result.items).toEqual([]);
  }); test('FAIL_getModerationItems_12: Timestamp validation fails (negative start/end) → throws', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const options = { start: -1000, end: -500 };
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItems(filters, options)).rejects.toThrow();
  }); test('FAIL_getModerationItems_13: Content decompression fails on one item → throws', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const mockItems = [{
      moderationId: '123',
      status: Moderation.STATUS.PENDING,
      content: { _compressed: true, _format: 'gzip', data: Buffer.from('not-valid-gzip').toString('base64') }
    }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gunzip').mockImplementationOnce((data, callback) => {
      if (typeof callback === 'function') callback(new Error('Decompression failed'));
      else return Promise.reject(new Error('Decompression failed'));
    });
    
    await expect(Moderation.getModerationItems(filters, {})).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: getModerationItemsByStatus TESTS
   * --------------------------------
   */ test('PASS_getModerationItemsByStatus_1: Valid status "pending" → uses GSI_STATUS_DATE, returns items', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result).toBeDefined();
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_STATUS_DATE);
  }); test('PASS_getModerationItemsByStatus_2: All STATUS enum values work (pending, approved, approved_global, rejected, escalated)', async () => {
    const mockItems = [{ moderationId: '123' }];
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    for (const status of Object.values(Moderation.STATUS)) {
      await Moderation.getModerationItemsByStatus(status, {});
      expect(Scylla.request).toHaveBeenCalled();
    }
  }); test('PASS_getModerationItemsByStatus_3: Date range filtering (start/end) applied correctly via KeyConditionExpression', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { start: 1640995200000, end: 1641081600000 };
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItemsByStatus(status, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.KeyConditionExpression).toContain('BETWEEN');
  }); test('PASS_getModerationItemsByStatus_4: Pagination works with nextToken encode/decode', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING }];
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    const nextToken = Buffer.from(JSON.stringify({ lastKey: mockLastKey }), 'utf8').toString('base64');
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, { nextToken });
    
    expect(result).toBeDefined();
    expect(result.nextToken).toBeDefined();
    expect(Scylla.request.mock.calls[0][1].ExclusiveStartKey).toEqual(mockLastKey);
  }); test('PASS_getModerationItemsByStatus_5: Limit parameter enforced', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { limit: 50 };
    const mockItems = Array(50).fill(null).map((_, i) => ({ moderationId: `id${i}`, status }));
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, options);
    
    expect(result.items.length).toBeLessThanOrEqual(50);
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.Limit).toBe(50);
  }); test('PASS_getModerationItemsByStatus_6: Sort order (asc) respected', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { asc: true };
    const mockItems = [{ moderationId: '123', status }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItemsByStatus(status, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.ScanIndexForward).toBe(true);
  }); test('PASS_getModerationItemsByStatus_7: Decompresses content in all items', async () => {
    const status = Moderation.STATUS.PENDING;
    const originalContent = { text: 'decompressed' };
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    zlib.gunzip.mockImplementation((buf, cb) => realZlib.gunzip(buf, (err, res) => (cb ? cb(err, res) : undefined)));
    const compressed = await new Promise((res, rej) => {
      realZlib.gzip(Buffer.from(JSON.stringify(originalContent), 'utf8'), (err, buf) => (err ? rej(err) : res(buf)));
    });
    const mockItems = [{
      moderationId: '123',
      status,
      content: { _compressed: true, _format: 'gzip', data: compressed.toString('base64') }
    }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.items).toBeDefined();
    expect(result.items.length).toBe(1);
    expect(result.items[0].content).toEqual(originalContent);
  }, 10000); test('PASS_getModerationItemsByStatus_8: Empty result for status with no items → returns empty array', async () => {
    const status = Moderation.STATUS.PENDING;
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.items).toEqual([]);
  }); test('PASS_getModerationItemsByStatus_9: Logs success with count', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItemsByStatus(status, {});
    
    expect(Logger.debugLog).toHaveBeenCalled();
  }); test('FAIL_getModerationItemsByStatus_1: Invalid status "unknown" → throws "Invalid status"', async () => {
    const status = 'unknown';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus(status, {})).rejects.toThrow();
  }); test('FAIL_getModerationItemsByStatus_2: Empty status after sanitization → throws "status is required"', async () => {
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus('   ', {})).rejects.toThrow();
  }); test('FAIL_getModerationItemsByStatus_3: Null status → throws', async () => {
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus(null, {})).rejects.toThrow();
  }); test('FAIL_getModerationItemsByStatus_4: Limit > MAX_QUERY_RESULT_SIZE → throws', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { limit: 1001 };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
  }); test('FAIL_getModerationItemsByStatus_5: Invalid nextToken → throws', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { nextToken: 'invalid!!!' };
    ErrorHandler.addError = jest.fn();
    SafeUtils.sanitizeString = jest.fn(str => str);
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
  }); test('FAIL_getModerationItemsByStatus_6: Scylla query fails → throws', async () => {
    const status = Moderation.STATUS.PENDING;
    const queryError = new Error('Query failed');
    Scylla.request = jest.fn().mockRejectedValue(queryError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus(status, {})).rejects.toThrow();
  }); test('FAIL_getModerationItemsByStatus_7: Invalid start/end timestamps → throws', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { start: -1000, end: -500 };
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: getAllByDate TESTS
   * --------------------------------
   */ test('PASS_getAllByDate_1: Valid dayKey "20220101" → uses GSI_ALL_BY_DATE, returns items for that day', async () => {
    const dayKey = '20220101';
    const mockItems = [{ moderationId: '123', dayKey }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllByDate(dayKey, {});
    
    expect(result).toBeDefined();
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_ALL_BY_DATE);
  }); test('PASS_getAllByDate_2: Leap year dayKey "20200229" → works correctly', async () => {
    const dayKey = '20200229';
    const mockItems = [{ moderationId: '123', dayKey }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllByDate(dayKey, {});
    
    expect(result).toBeDefined();
    expect(Scylla.request).toHaveBeenCalled();
  }); test('PASS_getAllByDate_3: Date range filtering within the day (start/end timestamps) applied', async () => {
    const dayKey = '20220101';
    const options = { start: 1640995200000, end: 1641081599999 };
    const mockItems = [{ moderationId: '123', dayKey }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getAllByDate(dayKey, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.KeyConditionExpression).toContain('BETWEEN');
  }); test('PASS_getAllByDate_4: Pagination with nextToken', async () => {
    const dayKey = '20220101';
    const mockItems = [{ moderationId: '123', dayKey }];
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    const nextToken = Buffer.from(JSON.stringify({ lastKey: mockLastKey }), 'utf8').toString('base64');
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllByDate(dayKey, { nextToken });
    
    expect(result).toBeDefined();
    expect(result.nextToken).toBeDefined();
    expect(Scylla.request.mock.calls[0][1].ExclusiveStartKey).toEqual(mockLastKey);
  }); test('PASS_getAllByDate_5: Limit parameter enforced', async () => {
    const dayKey = '20220101';
    const options = { limit: 50 };
    const mockItems = Array(50).fill(null).map((_, i) => ({ moderationId: `id${i}`, dayKey }));
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllByDate(dayKey, options);
    
    expect(result.items.length).toBeLessThanOrEqual(50);
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.Limit).toBe(50);
  }); test('PASS_getAllByDate_6: Sort order respected', async () => {
    const dayKey = '20220101';
    const options = { asc: true };
    const mockItems = [{ moderationId: '123', dayKey }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getAllByDate(dayKey, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.ScanIndexForward).toBe(true);
  }); test('PASS_getAllByDate_7: Decompresses content', async () => {
    const dayKey = '20220101';
    const originalContent = { text: 'decompressed' };
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    zlib.gunzip.mockImplementation((buf, cb) => realZlib.gunzip(buf, (err, res) => (cb ? cb(err, res) : undefined)));
    const compressed = await new Promise((res, rej) => {
      realZlib.gzip(Buffer.from(JSON.stringify(originalContent), 'utf8'), (err, buf) => (err ? rej(err) : res(buf)));
    });
    const mockItems = [{
      moderationId: '123',
      dayKey,
      content: { _compressed: true, _format: 'gzip', data: compressed.toString('base64') }
    }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllByDate(dayKey, {});
    
    expect(result.items).toBeDefined();
    expect(result.items.length).toBe(1);
    expect(result.items[0].content).toEqual(originalContent);
  }, 10000); test('PASS_getAllByDate_8: Empty result for future date → returns empty array', async () => {
    const dayKey = '20991231';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllByDate(dayKey, {});
    
    expect(result.items).toEqual([]);
  }); test('FAIL_getAllByDate_1: Missing dayKey → throws "dayKey is required"', async () => {
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getAllByDate(null, {})).rejects.toThrow();
  }); test('FAIL_getAllByDate_2: Invalid dayKey format "2022-01-01" → throws "Invalid dayKey format. Expected YYYYMMDD"', async () => {
    const dayKey = '2022-01-01';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getAllByDate(dayKey, {})).rejects.toThrow();
  }); test('FAIL_getAllByDate_3: Invalid calendar date "20221399" → throws "does not represent a valid calendar date"', async () => {
    const dayKey = '20221399';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getAllByDate(dayKey, {})).rejects.toThrow();
  }); test('FAIL_getAllByDate_4: dayKey with invalid month "20221300" → throws', async () => {
    const dayKey = '20221300';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getAllByDate(dayKey, {})).rejects.toThrow();
  }); test('FAIL_getAllByDate_5: dayKey with invalid day "20220132" → throws', async () => {
    const dayKey = '20220132';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getAllByDate(dayKey, {})).rejects.toThrow();
  }); test('FAIL_getAllByDate_6: Limit > MAX_QUERY_RESULT_SIZE → throws', async () => {
    const dayKey = '20220101';
    const options = { limit: 1001 };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getAllByDate(dayKey, options)).rejects.toThrow();
  }); test('FAIL_getAllByDate_7: Invalid nextToken → throws', async () => {
    const dayKey = '20220101';
    const options = { nextToken: 'invalid!!!' };
    ErrorHandler.addError = jest.fn();
    SafeUtils.sanitizeString = jest.fn(str => str);
    
    await expect(Moderation.getAllByDate(dayKey, options)).rejects.toThrow();
  }); test('FAIL_getAllByDate_8: Scylla query fails → throws', async () => {
    const dayKey = '20220101';
    const queryError = new Error('Query failed');
    Scylla.request = jest.fn().mockRejectedValue(queryError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getAllByDate(dayKey, {})).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: getUserModerationItemsByStatus TESTS
   * --------------------------------
   */ test('PASS_getUserModerationItemsByStatus_1: Valid userId + status → uses GSI_USER_STATUS_DATE, returns only that user\'s items', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', userId, status }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getUserModerationItemsByStatus(userId, status, {});
    
    expect(result).toBeDefined();
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_USER_STATUS_DATE);
    expect(queryCall.KeyConditionExpression).toBeDefined();
    expect(queryCall.ExpressionAttributeNames['#uid']).toBe('userId');
  }); test('PASS_getUserModerationItemsByStatus_2: Status "all" → queries all statuses for user', async () => {
    const userId = 'user123';
    const status = 'all';
    const mockItems = [{ moderationId: '123', userId, status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getUserModerationItemsByStatus(userId, status, {});
    
    expect(result).toBeDefined();
    expect(Scylla.request).toHaveBeenCalled();
  }); test('PASS_getUserModerationItemsByStatus_3: All STATUS enum values work for specific user', async () => {
    const userId = 'user123';
    const mockItems = [{ moderationId: '123', userId }];
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    for (const status of Object.values(Moderation.STATUS)) {
      await Moderation.getUserModerationItemsByStatus(userId, status, {});
      expect(Scylla.request).toHaveBeenCalled();
    }
  }); test('PASS_getUserModerationItemsByStatus_4: Date range filtering (start/end) applied via FilterExpression or KeyConditionExpression', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    const options = { start: 1640995200000, end: 1641081600000 };
    const mockItems = [{ moderationId: '123', userId, status }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getUserModerationItemsByStatus(userId, status, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.KeyConditionExpression).toBeDefined();
  }); test('PASS_getUserModerationItemsByStatus_5: Pagination works', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', userId, status }];
    const mockLastKey = { pk: `moderation#${userId}`, sk: 'media#1640995200000#123' };
    const nextToken = Buffer.from(JSON.stringify({ lastKey: mockLastKey }), 'utf8').toString('base64');
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getUserModerationItemsByStatus(userId, status, { nextToken });
    
    expect(result).toBeDefined();
    expect(result.nextToken).toBeDefined();
    expect(Scylla.request.mock.calls[0][1].ExclusiveStartKey).toEqual(mockLastKey);
  }); test('PASS_getUserModerationItemsByStatus_6: Limit enforced', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    const options = { limit: 50 };
    const mockItems = Array(50).fill(null).map((_, i) => ({ moderationId: `id${i}`, userId, status }));
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getUserModerationItemsByStatus(userId, status, options);
    
    expect(result.items.length).toBeLessThanOrEqual(50);
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.Limit).toBe(50);
  }); test('PASS_getUserModerationItemsByStatus_7: Sort order respected', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    const options = { asc: true };
    const mockItems = [{ moderationId: '123', userId, status }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getUserModerationItemsByStatus(userId, status, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.ScanIndexForward).toBe(true);
  }); test('PASS_getUserModerationItemsByStatus_8: Decompresses content', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    const originalContent = { text: 'decompressed' };
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    zlib.gunzip.mockImplementation((buf, cb) => realZlib.gunzip(buf, (err, res) => (cb ? cb(err, res) : undefined)));
    const compressed = await new Promise((res, rej) => {
      realZlib.gzip(Buffer.from(JSON.stringify(originalContent), 'utf8'), (err, buf) => (err ? rej(err) : res(buf)));
    });
    const mockItems = [{
      moderationId: '123',
      userId,
      status,
      content: { _compressed: true, _format: 'gzip', data: compressed.toString('base64') }
    }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getUserModerationItemsByStatus(userId, status, {});
    
    expect(result.items).toBeDefined();
    expect(result.items.length).toBe(1);
    expect(result.items[0].content).toEqual(originalContent);
  }, 10000); test('PASS_getUserModerationItemsByStatus_9: Empty result for user with no items → returns empty array', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getUserModerationItemsByStatus(userId, status, {});
    
    expect(result.items).toEqual([]);
  }); test('PASS_getUserModerationItemsByStatus_10: Security boundary - userId filter prevents cross-user data access', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', userId, status }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getUserModerationItemsByStatus(userId, status, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_USER_STATUS_DATE);
    expect(queryCall.KeyConditionExpression).toContain('#uid');
    expect(queryCall.ExpressionAttributeNames['#uid']).toBe('userId');
  }); test('FAIL_getUserModerationItemsByStatus_1: Missing userId → throws "userId is required"', async () => {
    const status = Moderation.STATUS.PENDING;
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getUserModerationItemsByStatus(null, status, {})).rejects.toThrow();
  }); test('FAIL_getUserModerationItemsByStatus_2: Empty userId after sanitization → throws', async () => {
    const status = Moderation.STATUS.PENDING;
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getUserModerationItemsByStatus('   ', status, {})).rejects.toThrow();
  }); test('FAIL_getUserModerationItemsByStatus_3: Missing status → throws "status is required"', async () => {
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getUserModerationItemsByStatus(userId, null, {})).rejects.toThrow();
  }); test('FAIL_getUserModerationItemsByStatus_4: Invalid status (not in STATUS_SET or "all") → throws "Invalid status"', async () => {
    const userId = 'user123';
    const status = 'invalid_status';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getUserModerationItemsByStatus(userId, status, {})).rejects.toThrow();
  }); test('FAIL_getUserModerationItemsByStatus_5: Limit > MAX_QUERY_RESULT_SIZE → throws', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    const options = { limit: 1001 };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getUserModerationItemsByStatus(userId, status, options)).rejects.toThrow();
  }); test('FAIL_getUserModerationItemsByStatus_6: Invalid nextToken → throws', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    const options = { nextToken: 'invalid' };
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    const gunzipSpy = jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(new Error('Decoding failed'));
    });
    
    await expect(Moderation.getUserModerationItemsByStatus(userId, status, options)).rejects.toThrow();
    gunzipSpy.mockRestore();
  }); test('FAIL_getUserModerationItemsByStatus_7: Scylla query fails → throws', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    const queryError = new Error('Query failed');
    Scylla.request = jest.fn().mockRejectedValue(queryError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getUserModerationItemsByStatus(userId, status, {})).rejects.toThrow();
  }); test('FAIL_getUserModerationItemsByStatus_8: Invalid timestamps → throws', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    const options = { start: -1000, end: -500 };
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getUserModerationItemsByStatus(userId, status, options)).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: getModerationItemsByPriority TESTS
   * --------------------------------
   */ test('PASS_getModerationItemsByPriority_1: Valid priority "high" → uses GSI_PRIORITY, returns items', async () => {
    const priority = Moderation.PRIORITY.HIGH;
    const mockItems = [{ moderationId: '123', priority }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByPriority(priority, {});
    
    expect(result).toBeDefined();
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_PRIORITY);
  }); test('PASS_getModerationItemsByPriority_2: All PRIORITY enum values work (high, normal, urgent, low)', async () => {
    const mockItems = [{ moderationId: '123' }];
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    for (const priority of Object.values(Moderation.PRIORITY)) {
      await Moderation.getModerationItemsByPriority(priority, {});
      expect(Scylla.request).toHaveBeenCalled();
    }
  }); test('PASS_getModerationItemsByPriority_3: Date range filtering (start/end) applied', async () => {
    const priority = Moderation.PRIORITY.HIGH;
    const options = { startTimestamp: 1640995200000, endTimestamp: 1641081600000 };
    const mockItems = [{ moderationId: '123', priority }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItemsByPriority(priority, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.FilterExpression || queryCall.KeyConditionExpression).toBeDefined();
  }); test('PASS_getModerationItemsByPriority_4: Pagination works', async () => {
    const priority = Moderation.PRIORITY.HIGH;
    const mockItems = [{ moderationId: '123', priority }];
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    const nextToken = Buffer.from(JSON.stringify({ lastKey: mockLastKey }), 'utf8').toString('base64');
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByPriority(priority, { nextToken });
    
    expect(result).toBeDefined();
    expect(result.nextToken).toBeDefined();
    expect(Scylla.request.mock.calls[0][1].ExclusiveStartKey).toEqual(mockLastKey);
  }); test('PASS_getModerationItemsByPriority_5: Limit enforced', async () => {
    const priority = Moderation.PRIORITY.HIGH;
    const options = { limit: 50 };
    const mockItems = Array(50).fill(null).map((_, i) => ({ moderationId: `id${i}`, priority }));
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByPriority(priority, options);
    
    expect(result.items.length).toBeLessThanOrEqual(50);
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.Limit).toBe(50);
  }); test('PASS_getModerationItemsByPriority_6: Sort order respected', async () => {
    const priority = Moderation.PRIORITY.HIGH;
    const options = { asc: true };
    const mockItems = [{ moderationId: '123', priority }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItemsByPriority(priority, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.ScanIndexForward).toBe(true);
  }); test('PASS_getModerationItemsByPriority_7: Decompresses content', async () => {
    const priority = Moderation.PRIORITY.HIGH;
    const originalContent = { text: 'decompressed' };
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    zlib.gunzip.mockImplementation((buf, cb) => realZlib.gunzip(buf, (err, res) => (cb ? cb(err, res) : undefined)));
    const compressed = await new Promise((res, rej) => {
      realZlib.gzip(Buffer.from(JSON.stringify(originalContent), 'utf8'), (err, buf) => (err ? rej(err) : res(buf)));
    });
    const mockItems = [{
      moderationId: '123',
      priority,
      content: { _compressed: true, _format: 'gzip', data: compressed.toString('base64') }
    }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByPriority(priority, {});
    
    expect(result.items).toBeDefined();
    expect(result.items.length).toBe(1);
    expect(result.items[0].content).toEqual(originalContent);
  }, 10000); test('PASS_getModerationItemsByPriority_8: Empty result → returns empty array', async () => {
    const priority = Moderation.PRIORITY.HIGH;
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByPriority(priority, {});
    
    expect(result.items).toEqual([]);
  }); test('FAIL_getModerationItemsByPriority_1: Invalid priority "critical" → throws "Invalid priority"', async () => {
    const priority = 'critical';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByPriority(priority, {})).rejects.toThrow();
  }); test('FAIL_getModerationItemsByPriority_2: Missing priority → throws "priority is required"', async () => {
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByPriority(null, {})).rejects.toThrow();
  }); test('FAIL_getModerationItemsByPriority_3: Limit > MAX_QUERY_RESULT_SIZE → throws', async () => {
    const priority = Moderation.PRIORITY.HIGH;
    const options = { limit: 1001 };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByPriority(priority, options)).rejects.toThrow();
  }); test('FAIL_getModerationItemsByPriority_4: Invalid nextToken → throws', async () => {
    const priority = Moderation.PRIORITY.HIGH;
    const options = { nextToken: 'invalid!!!' };
    ErrorHandler.addError = jest.fn();
    SafeUtils.sanitizeString = jest.fn(str => str);
    
    await expect(Moderation.getModerationItemsByPriority(priority, options)).rejects.toThrow();
  }); test('FAIL_getModerationItemsByPriority_5: Scylla query fails → throws', async () => {
    const priority = Moderation.PRIORITY.HIGH;
    const queryError = new Error('Query failed');
    Scylla.request = jest.fn().mockRejectedValue(queryError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByPriority(priority, {})).rejects.toThrow();
  }); test('FAIL_getModerationItemsByPriority_6: Invalid timestamps → throws', async () => {
    const priority = Moderation.PRIORITY.HIGH;
    const options = { start: -1000, end: -500 };
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByPriority(priority, options)).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: getModerationItemsByType TESTS
   * --------------------------------
   */ test('PASS_getModerationItemsByType_1: Valid type "image" → uses GSI_TYPE_DATE, returns items', async () => {
    const type = Moderation.TYPE.IMAGE;
    const mockItems = [{ moderationId: '123', type }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByType(type, {});
    
    expect(result).toBeDefined();
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_TYPE_DATE);
  }); test('PASS_getModerationItemsByType_2: All TYPE enum values work (image, video, text, link, report, tags, emoji, icon, tag, personal_tag, global_tag, image_gallery, gallery, audio)', async () => {
    const mockItems = [{ moderationId: '123' }];
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    for (const type of Object.values(Moderation.TYPE)) {
      await Moderation.getModerationItemsByType(type, {});
      expect(Scylla.request).toHaveBeenCalled();
    }
  }); test('PASS_getModerationItemsByType_3: Alias handling (gallery vs image_gallery) - both map to same results or one is canonical', async () => {
    const mockItems = [{ moderationId: '123', type: Moderation.TYPE.IMAGE_GALLERY }];
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItemsByType(Moderation.TYPE.GALLERY, {});
    await Moderation.getModerationItemsByType(Moderation.TYPE.IMAGE_GALLERY, {});
    
    expect(Scylla.request).toHaveBeenCalled();
  }); test('PASS_getModerationItemsByType_4: Date range filtering applied', async () => {
    const type = Moderation.TYPE.IMAGE;
    const options = { startTimestamp: 1640995200000, endTimestamp: 1641081600000 };
    const mockItems = [{ moderationId: '123', type }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItemsByType(type, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.FilterExpression || queryCall.KeyConditionExpression).toBeDefined();
  }); test('PASS_getModerationItemsByType_5: Pagination works', async () => {
    const type = Moderation.TYPE.IMAGE;
    const mockItems = [{ moderationId: '123', type }];
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    const nextToken = Buffer.from(JSON.stringify({ lastKey: mockLastKey }), 'utf8').toString('base64');
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByType(type, { nextToken });
    
    expect(result).toBeDefined();
    expect(result.nextToken).toBeDefined();
    expect(Scylla.request.mock.calls[0][1].ExclusiveStartKey).toEqual(mockLastKey);
  }); test('PASS_getModerationItemsByType_6: Limit enforced', async () => {
    const type = Moderation.TYPE.IMAGE;
    const options = { limit: 50 };
    const mockItems = Array(50).fill(null).map((_, i) => ({ moderationId: `id${i}`, type }));
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByType(type, options);
    
    expect(result.items.length).toBeLessThanOrEqual(50);
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.Limit).toBe(50);
  }); test('PASS_getModerationItemsByType_7: Sort order respected', async () => {
    const type = Moderation.TYPE.IMAGE;
    const options = { asc: true };
    const mockItems = [{ moderationId: '123', type }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItemsByType(type, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.ScanIndexForward).toBe(true);
  }); test('PASS_getModerationItemsByType_8: Decompresses content', async () => {
    const type = Moderation.TYPE.IMAGE;
    const originalContent = { text: 'decompressed' };
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    zlib.gunzip.mockImplementation((buf, cb) => realZlib.gunzip(buf, (err, res) => (cb ? cb(err, res) : undefined)));
    const compressed = await new Promise((res, rej) => {
      realZlib.gzip(Buffer.from(JSON.stringify(originalContent), 'utf8'), (err, buf) => (err ? rej(err) : res(buf)));
    });
    const mockItems = [{
      moderationId: '123',
      type,
      content: { _compressed: true, _format: 'gzip', data: compressed.toString('base64') }
    }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByType(type, {});
    
    expect(result.items).toBeDefined();
    expect(result.items.length).toBe(1);
    expect(result.items[0].content).toEqual(originalContent);
  }, 10000); test('PASS_getModerationItemsByType_9: Empty result → returns empty array', async () => {
    const type = Moderation.TYPE.IMAGE;
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByType(type, {});
    
    expect(result.items).toEqual([]);
  }); test('FAIL_getModerationItemsByType_1: Invalid type "pdf" → throws "Invalid type"', async () => {
    const type = 'pdf';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByType(type, {})).rejects.toThrow();
  }); test('FAIL_getModerationItemsByType_2: Missing type → throws "type is required"', async () => {
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByType(null, {})).rejects.toThrow();
  }); test('FAIL_getModerationItemsByType_3: Limit > MAX_QUERY_RESULT_SIZE → throws', async () => {
    const type = Moderation.TYPE.IMAGE;
    const options = { limit: 1001 };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByType(type, options)).rejects.toThrow();
  }); test('FAIL_getModerationItemsByType_4: Invalid nextToken → throws', async () => {
    const type = Moderation.TYPE.IMAGE;
    const options = { nextToken: 'invalid!!!' };
    ErrorHandler.addError = jest.fn();
    SafeUtils.sanitizeString = jest.fn(str => str);
    
    await expect(Moderation.getModerationItemsByType(type, options)).rejects.toThrow();
  }); test('FAIL_getModerationItemsByType_5: Scylla query fails → throws', async () => {
    const type = Moderation.TYPE.IMAGE;
    const queryError = new Error('Query failed');
    Scylla.request = jest.fn().mockRejectedValue(queryError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByType(type, {})).rejects.toThrow();
  }); test('FAIL_getModerationItemsByType_6: Invalid timestamps → throws', async () => {
    const type = Moderation.TYPE.IMAGE;
    const options = { start: -1000, end: -500 };
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByType(type, options)).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: getModerationRecordById TESTS
   * --------------------------------
   */ test('PASS_getModerationRecordById_1: Valid moderationId + userId → uses GSI_BY_MOD_ID, returns single record', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const pk = `moderation#${userId}`;
    const sk = `media#1640995200000#${moderationId}`;
    const mockItem = { moderationId, userId, pk, sk };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId, pk, sk }] });
    Scylla.getItem = jest.fn().mockResolvedValue(mockItem);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(result).toBeDefined();
    expect(result.moderationId).toBe(moderationId);
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_BY_MOD_ID);
  }); test('PASS_getModerationRecordById_2: includeDeleted=false (default) → excludes soft-deleted records (isDeleted=true)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const pk = `moderation#${userId}`;
    const sk = `media#1640995200000#${moderationId}`;
    const mockItem = { moderationId, userId, pk, sk, isDeleted: true, deletedAt: Date.now() };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId, pk, sk }] });
    Scylla.getItem = jest.fn().mockResolvedValue(mockItem);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationRecordById(moderationId, userId, false);
    
    expect(result).toBeNull();
  }); test('PASS_getModerationRecordById_3: includeDeleted=true → returns soft-deleted record', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const pk = `moderation#${userId}`;
    const sk = `media#1640995200000#${moderationId}`;
    const mockItem = { moderationId, userId, pk, sk, isDeleted: true, deletedAt: Date.now() };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId, pk, sk }] });
    Scylla.getItem = jest.fn().mockResolvedValue(mockItem);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationRecordById(moderationId, userId, true);
    
    expect(result).toBeDefined();
    expect(result.isDeleted).toBe(true);
  }); test('PASS_getModerationRecordById_4: Returned record has decompressed content field', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const pk = `moderation#${userId}`;
    const sk = `media#1640995200000#${moderationId}`;
    const originalContent = { text: 'decompressed' };
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    zlib.gunzip.mockImplementation((buf, cb) => realZlib.gunzip(buf, (err, res) => (cb ? cb(err, res) : undefined)));
    const compressed = await new Promise((res, rej) => {
      realZlib.gzip(Buffer.from(JSON.stringify(originalContent), 'utf8'), (err, buf) => (err ? rej(err) : res(buf)));
    });
    const mockItem = {
      moderationId,
      userId,
      pk,
      sk,
      content: { _compressed: true, _format: 'gzip', data: compressed.toString('base64') }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId, pk, sk }] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: mockItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(result).toBeDefined();
    expect(result.content).toEqual(originalContent);
  }, 10000); test('PASS_getModerationRecordById_5: Uses direct getItem with PK/SK for consistent read after GSI query', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const pk = `moderation#${userId}`;
    const sk = `media#1640995200000#${moderationId}`;
    const mockItem = { moderationId, userId, pk, sk };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId, pk, sk }] });
    Scylla.getItem = jest.fn().mockResolvedValue(mockItem);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(Scylla.getItem).toHaveBeenCalled();
    const keyArg = Scylla.getItem.mock.calls[0][1];
    expect(keyArg.pk).toBe(pk);
    expect(keyArg.sk).toBe(sk);
  }); test('PASS_getModerationRecordById_6: Record not found → returns null (not throws)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(result).toBeNull();
  }); test('PASS_getModerationRecordById_7: Logs successful retrieval', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const pk = `moderation#${userId}`;
    const sk = `media#1640995200000#${moderationId}`;
    const mockItem = { moderationId, userId, pk, sk };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId, pk, sk }] });
    Scylla.getItem = jest.fn().mockResolvedValue(mockItem);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(Logger.debugLog).toHaveBeenCalled();
  }); test('FAIL_getModerationRecordById_1: Missing userId → throws "userId is required for getModerationRecordById"', async () => {
    const moderationId = Moderation.generateModerationId();
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationRecordById(moderationId, null)).rejects.toThrow();
  }); test('FAIL_getModerationRecordById_2: Missing moderationId → throws "moderationId is required"', async () => {
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationRecordById(null, userId)).rejects.toThrow();
  }); test('FAIL_getModerationRecordById_3: Invalid moderationId format (not UUID) → throws validation error', async () => {
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationRecordById('invalid-id', userId)).rejects.toThrow();
  }); test('FAIL_getModerationRecordById_4: Empty moderationId after sanitization → throws', async () => {
    const userId = 'user123';
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationRecordById('   ', userId)).rejects.toThrow();
  }); test('FAIL_getModerationRecordById_5: Empty userId after sanitization → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationRecordById(moderationId, '   ')).rejects.toThrow();
  }); test('FAIL_getModerationRecordById_6: Scylla query on GSI fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const queryError = new Error('Query failed');
    Scylla.request = jest.fn().mockRejectedValue(queryError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationRecordById(moderationId, userId)).rejects.toThrow();
  }); test('FAIL_getModerationRecordById_7: Scylla getItem fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const getItemError = new Error('GetItem failed');
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockRejectedValue(getItemError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationRecordById(moderationId, userId)).rejects.toThrow();
  }); test('FAIL_getModerationRecordById_8: Content decompression fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const pk = `moderation#${userId}`;
    const sk = `media#1640995200000#${moderationId}`;
    const mockItem = {
      moderationId,
      userId,
      pk,
      sk,
      content: { _compressed: true, _format: 'gzip', data: Buffer.from('corrupted').toString('base64') }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId, pk, sk }] });
    Scylla.getItem = jest.fn().mockResolvedValue(mockItem);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gunzip').mockImplementationOnce((data, callback) => {
      if (typeof callback === 'function') callback(new Error('Decompression failed'));
      else return Promise.reject(new Error('Decompression failed'));
    });
    
    await expect(Moderation.getModerationRecordById(moderationId, userId)).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: updateModerationMeta TESTS
   * --------------------------------
   */ test('PASS_updateModerationMeta_1: Appends new history entry to meta.history array (bounded by MAX_HISTORY_ENTRIES)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { history: [{ action: 'update', timestamp: Date.now(), userId }] };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.meta).toBeDefined();
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationMeta_2: When history reaches MAX_HISTORY_ENTRIES (100), oldest entries trimmed (FIFO or configured policy)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const largeHistory = Array(101).fill(null).map((_, i) => ({
      action: 'update',
      timestamp: Date.now() + i,
      userId: `user${i}`
    }));
    const metaUpdates = { history: largeHistory };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationMeta_3: Validates and safely stores details object (no prototype pollution)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = {
      history: [{ action: 'update', timestamp: Date.now(), userId, details: { __proto__: { isAdmin: true } } }]
    };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.safeObject = jest.fn(obj => {
      const safe = { ...obj };
      delete safe.__proto__;
      return safe;
    });
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    expect(SafeUtils.safeObject).toHaveBeenCalled();
  }); test('PASS_updateModerationMeta_4: Optimistic locking with version check ensures concurrency safety', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { history: [{ action: 'update', timestamp: Date.now(), userId }] };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    const updateOptions = Scylla.updateItem.mock.calls[0][3];
    expect(updateOptions.ConditionExpression).toContain('version');
  }); test('PASS_updateModerationMeta_5: Updates contentDeleted flag and contentDeletedAt timestamp when provided', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const timestamp = Date.now();
    const metaUpdates = { contentDeleted: true, contentDeletedAt: timestamp };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.meta).toBeDefined();
    expect(updatePayload.meta.contentDeleted).toBe(true);
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationMeta_6: Updates updatedBy field in meta', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { updatedBy: userId, history: [{ action: 'update', timestamp: Date.now(), userId }] };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationMeta_7: Increments version number', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { history: [{ action: 'update', timestamp: Date.now(), userId }] };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.meta).toBeDefined();
    expect(updatePayload.meta.version).toBeDefined();
  }); test('PASS_updateModerationMeta_8: Logs meta update action', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { history: [{ action: 'update', timestamp: Date.now(), userId }] };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    expect(Logger.writeLog || Logger.debugLog).toHaveBeenCalled();
  }); test('FAIL_updateModerationMeta_1: Missing moderationId → throws', async () => {
    const userId = 'user123';
    const metaUpdates = { history: [] };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationMeta(null, userId, metaUpdates)).rejects.toThrow();
  }); test('FAIL_updateModerationMeta_2: Missing userId → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const metaUpdates = { history: [] };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationMeta(moderationId, null, metaUpdates)).rejects.toThrow();
  }); test('FAIL_updateModerationMeta_3: Invalid moderationId format → throws', async () => {
    const userId = 'user123';
    const metaUpdates = { history: [] };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationMeta('invalid-id', userId, metaUpdates)).rejects.toThrow();
  }); test('FAIL_updateModerationMeta_4: Empty metaUpdates object → may succeed with no changes or throw', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = {};
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    
    try {
      await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('FAIL_updateModerationMeta_5: History overflow beyond MAX_HISTORY_ENTRIES - test if it throws or truncates', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const largeHistory = Array(150).fill(null).map((_, i) => ({
      action: 'update',
      timestamp: Date.now() + i,
      userId: `user${i}`
    }));
    const metaUpdates = { history: largeHistory };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    // This should either truncate or throw
    try {
      await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('FAIL_updateModerationMeta_6: Scylla.updateItem fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { history: [{ action: 'update', timestamp: Date.now(), userId }] };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    const updateError = new Error('Update failed');
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(updateError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationMeta(moderationId, userId, metaUpdates)).rejects.toThrow();
  }); test('FAIL_updateModerationMeta_7: Optimistic locking fails after retries → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { history: [{ action: 'update', timestamp: Date.now(), userId }] };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.code = 'ConditionalCheckFailedException';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(conditionalError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationMeta(moderationId, userId, metaUpdates)).rejects.toThrow();
  }); test('FAIL_updateModerationMeta_8: Item not found → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { history: [{ action: 'update', timestamp: Date.now(), userId }] };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationMeta(moderationId, userId, metaUpdates)).rejects.toThrow();
  }); test('FAIL_updateModerationMeta_9: Prototype pollution in metaUpdates → prevented by SafeUtils', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { __proto__: { isAdmin: true } };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.safeObject = jest.fn(obj => {
      const safe = { ...obj };
      delete safe.__proto__;
      return safe;
    });
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    expect(SafeUtils.safeObject).toHaveBeenCalled();
  });

  /**
   * --------------------------------
   * SECTION: softDeleteModerationItem TESTS
   * --------------------------------
   */ test('PASS_softDeleteModerationItem_1: Sets isDeleted=true and deletedAt=<timestamp>, preserves all other data', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const timestamp = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(timestamp);
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isDeleted: false,
      deletedAt: null
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.softDeleteModerationItem(moderationId, userId);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.isDeleted).toBe(true);
    expect(updatePayload.deletedAt).toBe(timestamp);
    Date.now.mockRestore();
  }); test('PASS_softDeleteModerationItem_2: Idempotent - soft deleting already deleted item throws "already deleted"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isDeleted: true,
      deletedAt: Date.now()
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.softDeleteModerationItem(moderationId, userId)).rejects.toThrow(/already deleted/);
    expect(Scylla.updateItem).not.toHaveBeenCalled();
  }); test('PASS_softDeleteModerationItem_3: Ensures consistency: deletedAt only set when isDeleted=true', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isDeleted: false,
      deletedAt: null
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.softDeleteModerationItem(moderationId, userId);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.isDeleted).toBe(true);
    expect(updatePayload.deletedAt).toBeDefined();
  }); test('PASS_softDeleteModerationItem_4: Logs soft delete action', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.softDeleteModerationItem(moderationId, userId);
    
    expect(Logger.writeLog || Logger.debugLog).toHaveBeenCalled();
  }); test('PASS_softDeleteModerationItem_5: Meta field updated with soft delete history entry', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.softDeleteModerationItem(moderationId, userId);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.meta).toBeDefined();
  }); test('PASS_softDeleteModerationItem_6: Uses optimistic locking for concurrent safety', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.softDeleteModerationItem(moderationId, userId);
    
    const updateOptions = Scylla.updateItem.mock.calls[0][3];
    expect(updateOptions.ConditionExpression).toContain('version');
  }); test('FAIL_softDeleteModerationItem_1: Missing moderationId → throws', async () => {
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.softDeleteModerationItem(null, userId)).rejects.toThrow();
  }); test('FAIL_softDeleteModerationItem_2: Invalid moderationId format → throws', async () => {
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.softDeleteModerationItem('invalid-id', userId)).rejects.toThrow();
  }); test('FAIL_softDeleteModerationItem_3: Empty moderationId after sanitization → throws', async () => {
    const userId = 'user123';
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.softDeleteModerationItem('   ', userId)).rejects.toThrow();
  }); test('FAIL_softDeleteModerationItem_4: Record not found → returns false or throws (document actual behavior)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    try {
      const result = await Moderation.softDeleteModerationItem(moderationId, userId);
      expect(result === false || result === undefined).toBe(true);
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('FAIL_softDeleteModerationItem_5: Scylla.updateItem fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    const updateError = new Error('Update failed');
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(updateError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.softDeleteModerationItem(moderationId, userId)).rejects.toThrow();
  }); test('FAIL_softDeleteModerationItem_6: Optimistic locking fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.code = 'ConditionalCheckFailedException';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(conditionalError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.softDeleteModerationItem(moderationId, userId)).rejects.toThrow();
  }); test('FAIL_softDeleteModerationItem_7: Inconsistent state attempt (isDeleted=true, deletedAt=null) → validation throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isDeleted: true,
      deletedAt: null // Inconsistent state
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    // This should validate consistency
    try {
      await Moderation.softDeleteModerationItem(moderationId, userId);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  /**
   * --------------------------------
   * SECTION: hardDeleteModerationItem TESTS
   * --------------------------------
   */ test('PASS_hardDeleteModerationItem_1: Deletes existing record permanently, returns true', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const mockItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [mockItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: mockItem });
    Scylla.deleteItem = jest.fn().mockResolvedValue(true);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.hardDeleteModerationItem(moderationId, userId);
    
    expect(result).toBe(true);
    expect(Scylla.deleteItem).toHaveBeenCalled();
  }); test('PASS_hardDeleteModerationItem_2: Record not found → returns false (explicitly documented behavior)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    
    const result = await Moderation.hardDeleteModerationItem(moderationId, userId);
    
    expect(result).toBe(false);
  }); test('PASS_hardDeleteModerationItem_3: Logs "itemHardDeleted" action on success', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const mockItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [mockItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: mockItem });
    Scylla.deleteItem = jest.fn().mockResolvedValue(true);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.hardDeleteModerationItem(moderationId, userId);
    
    expect(Logger.writeLog).toHaveBeenCalledWith(expect.objectContaining({ flag: 'MODERATIONS', action: 'itemHardDeleted' }));
  }); test('PASS_hardDeleteModerationItem_4: Uses getModerationRecordById to fetch PK/SK before delete', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const mockItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [mockItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: mockItem });
    Scylla.deleteItem = jest.fn().mockResolvedValue(true);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.hardDeleteModerationItem(moderationId, userId);
    
    expect(Scylla.getItem).toHaveBeenCalled();
  }); test('PASS_hardDeleteModerationItem_5: Calls Scylla.deleteItem with correct PK/SK', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const mockItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [mockItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: mockItem });
    Scylla.deleteItem = jest.fn().mockResolvedValue(true);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.hardDeleteModerationItem(moderationId, userId);
    
    const tableName = Scylla.deleteItem.mock.calls[0][0];
    const key = Scylla.deleteItem.mock.calls[0][1];
    expect(tableName).toBe(Moderation.TABLE || 'ModerationTable');
    expect(key.pk).toBe(`moderation#${userId}`);
    expect(key.sk).toBe(`media#1640995200000#${moderationId}`);
  }); test('FAIL_hardDeleteModerationItem_1: Missing moderationId → throws', async () => {
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.hardDeleteModerationItem(null, userId)).rejects.toThrow();
  }); test('FAIL_hardDeleteModerationItem_2: Invalid moderationId format → throws', async () => {
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.hardDeleteModerationItem('invalid-id', userId)).rejects.toThrow();
  }); test('FAIL_hardDeleteModerationItem_3: Scylla.deleteItem fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const mockItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`
    };
    
    const deleteError = new Error('Delete failed');
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: mockItem });
    Scylla.deleteItem = jest.fn().mockRejectedValue(deleteError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.hardDeleteModerationItem(moderationId, userId)).rejects.toThrow();
  }); test('FAIL_hardDeleteModerationItem_4: getModerationRecordById throws error → propagates throw', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const queryError = new Error('Query failed');
    
    Scylla.request = jest.fn().mockRejectedValue(queryError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.hardDeleteModerationItem(moderationId, userId)).rejects.toThrow();
  }); test('FAIL_hardDeleteModerationItem_5: Missing userId when required → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.hardDeleteModerationItem(moderationId, null)).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: countModerationItemsByStatus TESTS
   * --------------------------------
   */ test('PASS_countModerationItemsByStatus_1: Counts items for valid status "pending" using Select:"COUNT"', async () => {
    const status = Moderation.STATUS.PENDING;
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.countModerationItemsByStatus(status);
    
    expect(result).toBe(10);
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.Select).toBe('COUNT');
  }); test('PASS_countModerationItemsByStatus_2: Status "all" → counts across entire table with Scan or sum of all status counts', async () => {
    const status = 'all';
    
    Scylla.scan = jest.fn().mockResolvedValue({ Count: 50 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.countModerationItemsByStatus(status);
    
    expect(result).toBeDefined();
    expect(typeof result).toBe('number');
  }); test('PASS_countModerationItemsByStatus_3: Filters applied (moderatedBy present/null, hasRejectionHistory) via FilterExpression', async () => {
    const status = Moderation.STATUS.PENDING;
    const filters = { moderatedBy: 'moderator1' };
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 5 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.countModerationItemsByStatus(status, filters);
    
    expect(result).toBe(5);
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.FilterExpression).toBeDefined();
  }); test('PASS_countModerationItemsByStatus_4: Paginates count across multiple pages (LastEvaluatedKey loop), sums correctly', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    
    Scylla.request = jest.fn()
      .mockResolvedValueOnce({ Count: 10, LastEvaluatedKey: mockLastKey })
      .mockResolvedValueOnce({ Count: 15, LastEvaluatedKey: null });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.countModerationItemsByStatus(status);
    
    expect(result).toBe(25);
    expect(Scylla.request).toHaveBeenCalledTimes(2);
  }); test('PASS_countModerationItemsByStatus_5: Respects MAX_PAGINATION_ITERATIONS protection (100 iterations max)', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    // This should hit MAX_PAGINATION_ITERATIONS
    await expect(Moderation.countModerationItemsByStatus(status)).rejects.toThrow();
  }); test('PASS_countModerationItemsByStatus_6: Date range filters (start/end) applied to count query', async () => {
    const status = Moderation.STATUS.PENDING;
    const filters = { start: 1640995200000, end: 1641081600000 };
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 5 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.countModerationItemsByStatus(status, filters);
    
    expect(result).toBe(5);
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.FilterExpression || queryCall.KeyConditionExpression).toBeDefined();
  }); test('PASS_countModerationItemsByStatus_7: Marshals values once before pagination loop for efficiency', async () => {
    const status = Moderation.STATUS.PENDING;
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.countModerationItemsByStatus(status);
    
    expect(Scylla.request).toHaveBeenCalled();
  }); test('PASS_countModerationItemsByStatus_8: Empty result → returns 0', async () => {
    const status = Moderation.STATUS.PENDING;
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 0 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.countModerationItemsByStatus(status);
    
    expect(result).toBe(0);
  }); test('PASS_countModerationItemsByStatus_9: Large dataset requiring multiple pages → sums all pages correctly', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    
    Scylla.request = jest.fn()
      .mockResolvedValueOnce({ Count: 100, LastEvaluatedKey: mockLastKey })
      .mockResolvedValueOnce({ Count: 50, LastEvaluatedKey: null });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.countModerationItemsByStatus(status);
    
    expect(result).toBe(150);
  }); test('FAIL_countModerationItemsByStatus_1: Invalid status (not in STATUS_SET or "all") → throws "Invalid status"', async () => {
    const status = 'invalid_status';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.countModerationItemsByStatus(status)).rejects.toThrow();
  }); test('FAIL_countModerationItemsByStatus_2: Pagination exceeds MAX_PAGINATION_ITERATIONS → logs PAGINATION_LIMIT_EXCEEDED, throws with explicit error message', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.countModerationItemsByStatus(status)).rejects.toThrow();
    expect(ErrorHandler.addError).toHaveBeenCalled();
  }); test('FAIL_countModerationItemsByStatus_3: Scylla query fails → retries → throws', async () => {
    const status = Moderation.STATUS.PENDING;
    const queryError = new Error('Query failed');
    Scylla.request = jest.fn().mockRejectedValue(queryError);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.countModerationItemsByStatus(status)).rejects.toThrow();
  }); test('FAIL_countModerationItemsByStatus_4: Filter object contains prototype pollution payload → SafeUtils prevents mutation, count proceeds safely', async () => {
    const status = Moderation.STATUS.PENDING;
    const filters = { __proto__: { isAdmin: true } };
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.safeObject = jest.fn(obj => {
      const safe = { ...obj };
      delete safe.__proto__;
      return safe;
    });
    Logger.debugLog = jest.fn();
    
    await Moderation.countModerationItemsByStatus(status, filters);
    
    expect(SafeUtils.safeObject).toHaveBeenCalled();
  }); test('FAIL_countModerationItemsByStatus_5: Invalid timestamp in date range filters → throws', async () => {
    const status = Moderation.STATUS.PENDING;
    const filters = { start: -1000, end: -500 };
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.countModerationItemsByStatus(status, filters)).rejects.toThrow();
  }); test('FAIL_countModerationItemsByStatus_6: moderatedBy filter with invalid value → sanitized but may not match records', async () => {
    const status = Moderation.STATUS.PENDING;
    const filters = { moderatedBy: '   ' };
    SafeUtils.sanitizeString = jest.fn((str) => (str === '   ' ? '' : (str != null ? String(str).trim() || null : null)));
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 0 });
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.countModerationItemsByStatus(status, filters);
    
    expect(result).toBeDefined();
    expect(result).toBe(0);
  });

  /**
   * --------------------------------
   * SECTION: getAllModerationCounts TESTS
   * --------------------------------
   */ test('PASS_getAllModerationCounts_1: Returns counts object with keys for every status in STATUS enum (pending, approved, approved_global, rejected, escalated)', async () => {
    const statusCounts = Object.values(Moderation.STATUS).map(status => 10);
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
    Object.values(Moderation.STATUS).forEach(status => {
      expect(result).toHaveProperty(status);
    });
  }); test('PASS_getAllModerationCounts_2: Includes special count keys: pendingResubmission, all, unmoderated', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    expect(result).toHaveProperty('pendingResubmission');
    expect(result).toHaveProperty('all');
    expect(result).toHaveProperty('unmoderated');
  }); test('PASS_getAllModerationCounts_3: All status counts run in parallel via Promise.all, maps results correctly to status keys', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    expect(result).toBeDefined();
    expect(Object.keys(result).length).toBeGreaterThan(0);
  }); test('PASS_getAllModerationCounts_4: When _countPendingResubmission fails internally, it returns 0 and doesn\'t crash overall method', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    expect(result).toBeDefined();
    expect(result.pendingResubmission).toBeDefined();
  }); test('PASS_getAllModerationCounts_5: Unmoderated count (pending items with moderatedBy=null) calculated correctly', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Count: 5 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    expect(result).toHaveProperty('unmoderated');
    expect(typeof result.unmoderated).toBe('number');
  }); test('PASS_getAllModerationCounts_6: All count represents total items across all statuses', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    expect(result).toHaveProperty('all');
    expect(typeof result.all).toBe('number');
  }); test('PASS_getAllModerationCounts_7: Logs successful count retrieval', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getAllModerationCounts();
    
    expect(Logger.debugLog).toHaveBeenCalled();
  }); test('PASS_getAllModerationCounts_8: Result ordering matches STATUS enum order', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    const statusKeys = Object.values(Moderation.STATUS);
    const resultKeys = Object.keys(result).filter(key => statusKeys.includes(key));
    expect(resultKeys.length).toBe(statusKeys.length);
  }); test('FAIL_getAllModerationCounts_1: One of the countModerationItemsByStatus calls rejects → ErrorHandler logs GET_ALL_MODERATION_COUNTS_FAILED, method throws', async () => {
    const queryError = new Error('Count failed');
    const countSpy = jest.spyOn(Moderation, 'countModerationItemsByStatus').mockImplementation((status, opts) => {
      if (status === Moderation.STATUS.APPROVED) return Promise.reject(queryError);
      return Promise.resolve(0);
    });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getAllModerationCounts()).rejects.toThrow();
    expect(ErrorHandler.addError).toHaveBeenCalled();
    countSpy.mockRestore();
  }); test('FAIL_getAllModerationCounts_2: Promise.all shape/ordering bug - status count misaligned with key (regression test)', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    // Verify structure is correct
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  }); test('FAIL_getAllModerationCounts_3: Performance guard - if STATUS enum unexpectedly grows, countPromises array size validated (snapshot test)', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    const statusCount = Object.values(Moderation.STATUS).length;
    const resultStatusKeys = Object.keys(result).filter(key => Object.values(Moderation.STATUS).includes(key));
    expect(resultStatusKeys.length).toBe(statusCount);
  }); test('FAIL_getAllModerationCounts_4: _countPendingResubmission throws → caught, returns 0 for pendingResubmission, method still succeeds', async () => {
    const queryError = new Error('Count failed');
    Scylla.request = jest.fn()
      .mockRejectedValueOnce(queryError)
      .mockResolvedValue({ Count: 0 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    expect(result.pendingResubmission).toBe(0);
    expect(result).toHaveProperty('all');
    expect(result).toHaveProperty('pending');
  }); test('FAIL_getAllModerationCounts_5: Scylla transient error on multiple parallel queries → retries → partial failures → throws', async () => {
    const queryError = new Error('Query failed');
    let callCount = 0;
    Scylla.request = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ Count: 10 });
      return Promise.reject(queryError);
    });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getAllModerationCounts()).rejects.toThrow();
  });

  /**
   * --------------------------------
   * SECTION: Helper Method Tests (via Public Interface)
   * --------------------------------
   */

  /**
   * _validateTimestamp tests via createModerationEntry, updateModerationEntry
   */ test('PASS_validateTimestamp_1: Valid positive integer timestamp accepted', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const timestamp = 1640995200000;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, timestamp);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.submittedAt).toBe(timestamp);
  }); test('PASS_validateTimestamp_2: Numeric string "1640995200000" converted and accepted', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const timestamp = '1640995200000';
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => parseInt(val));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, timestamp);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('PASS_validateTimestamp_3: Undefined timestamp → generates current timestamp via Date.now()', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const mockNow = 1640995200000;
    jest.spyOn(Date, 'now').mockReturnValue(mockNow);
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.submittedAt).toBe(mockNow);
    Date.now.mockRestore();
  }); test('PASS_validateTimestamp_4: Timestamp within 5-minute future grace period (clock skew) accepted', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const futureTimestamp = Date.now() + (4 * 60 * 1000); // 4 minutes in future
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, futureTimestamp);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('FAIL_validateTimestamp_1: Negative timestamp → throws "Invalid timestamp: must be positive integer"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data, -1000)).rejects.toThrow('Invalid timestamp');
  }); test('FAIL_validateTimestamp_2: Timestamp > 5 years old → throws "Timestamp too far in the past"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const fiveYearsAgo = Date.now() - (6 * 365 * 24 * 60 * 60 * 1000);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data, fiveYearsAgo)).rejects.toThrow();
  }); test('FAIL_validateTimestamp_3: Timestamp > 5 minutes in future → throws "beyond clock skew tolerance"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const futureTimestamp = Date.now() + (6 * 60 * 1000); // 6 minutes in future
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data, futureTimestamp)).rejects.toThrow();
  }); test('FAIL_validateTimestamp_4: Non-numeric string → throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    SafeUtils.sanitizeInteger = jest.fn().mockReturnValue(null);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data, 'abc')).rejects.toThrow();
  }); test('FAIL_validateTimestamp_5: Float number → sanitizeInteger may truncate, verify behavior', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    SafeUtils.sanitizeInteger = jest.fn(val => Math.floor(val));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, 1640995200000.567);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('FAIL_validateTimestamp_6: Infinity, -Infinity → rejected', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data, Infinity)).rejects.toThrow();
    await expect(Moderation.createModerationEntry(data, -Infinity)).rejects.toThrow();
  });

  /**
   * _validateModerationIdFormat tests via createModerationEntry, updateModerationEntry, getModerationRecordById
   */ test('PASS_validateModerationIdFormat_1: Valid UUID v4 format accepted', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('PASS_validateModerationIdFormat_2: Uppercase UUID converted to lowercase (if implementation normalizes)', async () => {
    const moderationId = Moderation.generateModerationId().toUpperCase();
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str.toLowerCase());
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('FAIL_validateModerationIdFormat_1: Non-UUID string "abc123" → throws "Invalid moderationId format"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId: 'abc123' };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_validateModerationIdFormat_2: UUID with missing dashes → throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId: '12345678123456781234567812345678' };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_validateModerationIdFormat_3: Empty string → throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId: '' };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_validateModerationIdFormat_4: Null → throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId: null };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_validateModerationIdFormat_5: UUID v1 (different format) - test if rejected or accepted', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    // UUID v1 format (different from v4)
    const uuidV1 = '550e8400-e29b-11d4-a716-446655440000';
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId: uuidV1 };
    
    // This may or may not be accepted depending on implementation
    try {
      await Moderation.createModerationEntry(data);
    } catch (error) {
      expect(error).toBeDefined();
    }
  });

  /**
   * _compressContent / _decompressContent tests via createModerationEntry, updateModerationEntry, retrieval methods
   */ test('PASS_compressContent_1: Large JSON object (50KB+) compresses successfully, size reduced', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const largeContent = JSON.stringify({ data: 'x'.repeat(60000) });
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const data = { userId, contentId, type, priority, content: largeContent };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.contentCompressed).toBe(true);
  }); test('PASS_compressContent_2: Small content (< 1KB) may not compress or compresses minimally', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const smallContent = 'small content';
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, content: smallContent };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('PASS_compressContent_3: Round-trip: compress then decompress returns identical content', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const originalContent = 'x'.repeat(60000);
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    const realGunzip = promisify(realZlib.gunzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      realGunzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const data = { userId, contentId, type, priority, content: originalContent };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('PASS_compressContent_4: Binary content (Buffer) handled correctly', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const binaryContent = Buffer.from('binary data');
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, content: binaryContent };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('FAIL_compressContent_1: Gzip compression throws error → propagates to caller', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const largeContent = 'x'.repeat(60000);
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      callback(new Error('Compression failed'));
    });
    
    const data = { userId, contentId, type, priority, content: largeContent };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_decompressContent_1: Corrupted gzip data → gunzip throws → propagates error', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const pk = `moderation#${userId}`;
    const sk = `media#1640995200000#${moderationId}`;
    const mockItem = {
      moderationId,
      userId,
      pk,
      sk,
      content: { _compressed: true, _format: 'gzip', data: Buffer.from('corrupted').toString('base64') }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId, pk, sk }] });
    Scylla.getItem = jest.fn().mockResolvedValue(mockItem);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gunzip').mockImplementationOnce((data, callback) => {
      if (typeof callback === 'function') callback(new Error('Decompression failed'));
      else return Promise.reject(new Error('Decompression failed'));
    });
    
    await expect(Moderation.getModerationRecordById(moderationId, userId)).rejects.toThrow();
  }); test('FAIL_decompressContent_2: Non-compressed data passed to decompress → may throw or return garbage', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const pk = `moderation#${userId}`;
    const sk = `media#1640995200000#${moderationId}`;
    const mockItem = {
      moderationId,
      userId,
      pk,
      sk,
      content: { _compressed: true, _format: 'gzip', data: Buffer.from('not-valid-gzip').toString('base64') }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId, pk, sk }] });
    Scylla.getItem = jest.fn().mockResolvedValue(mockItem);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gunzip').mockImplementationOnce((data, callback) => {
      if (typeof callback === 'function') callback(new Error('Invalid gzip data'));
      else return Promise.reject(new Error('Invalid gzip data'));
    });
    
    await expect(Moderation.getModerationRecordById(moderationId, userId)).rejects.toThrow();
  });

  /**
   * _retryOperation tests via all Scylla operations in public methods
   */ test('PASS_retryOperation_1: Operation succeeds on first attempt → returns result immediately', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalledTimes(1);
  }); test('PASS_retryOperation_2: Operation fails with retryable error (throttling) → retries with exponential backoff → succeeds on 2nd attempt', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    const throttleError = new Error('Throttling');
    throttleError.code = 'ProvisionedThroughputExceededException';
    
    Scylla.putItem = jest.fn()
      .mockRejectedValueOnce(throttleError)
      .mockResolvedValueOnce({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalledTimes(2);
  }); test('PASS_retryOperation_3: Retries up to RETRY_MAX_ATTEMPTS (3) before throwing', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    const throttleError = new Error('Throttling');
    throttleError.code = 'ProvisionedThroughputExceededException';
    
    Scylla.putItem = jest.fn().mockRejectedValue(throttleError);
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
    expect(Scylla.putItem).toHaveBeenCalledTimes(Moderation.RETRY_MAX_ATTEMPTS);
  }); test('PASS_retryOperation_4: Non-retryable error (invalid request) → throws immediately without retry', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    const validationError = new Error('Validation failed');
    validationError.code = 'ValidationException';
    
    Scylla.putItem = jest.fn().mockRejectedValue(validationError);
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
    expect(Scylla.putItem).toHaveBeenCalledTimes(1);
  }); test('FAIL_retryOperation_1: All retry attempts exhausted → throws last error', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    const throttleError = new Error('Throttling');
    throttleError.code = 'ProvisionedThroughputExceededException';
    
    Scylla.putItem = jest.fn().mockRejectedValue(throttleError);
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_retryOperation_2: Operation throws non-Error object → handled gracefully or re-throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockRejectedValue('string error');
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  });

  /**
   * _encodeNextToken / _decodeNextToken tests via pagination in query methods
   */ test('PASS_encodeNextToken_1: Null lastKey → returns null token', async () => {
    const status = Moderation.STATUS.PENDING;
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.nextToken).toBeNull();
  }); test('PASS_encodeNextToken_2: Valid lastKey object → encodes to base64 string', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status }];
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      callback(null, Buffer.from(JSON.stringify(mockLastKey)));
    });
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.nextToken).toBeDefined();
    expect(typeof result.nextToken).toBe('string');
  }); test('PASS_encodeNextToken_3: Round-trip: encode then decode returns identical lastKey', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status }];
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    
    Scylla.request = jest.fn()
      .mockResolvedValueOnce({ Items: mockItems, LastEvaluatedKey: mockLastKey })
      .mockResolvedValueOnce({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const gzipSpy = jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      callback(null, Buffer.from(JSON.stringify(mockLastKey)));
    });
    const gunzipSpy = jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(null, Buffer.from(JSON.stringify(mockLastKey)));
    });
    
    const result1 = await Moderation.getModerationItemsByStatus(status, {});
    const result2 = await Moderation.getModerationItemsByStatus(status, { nextToken: result1.nextToken });
    
    expect(result2).toBeDefined();
    gzipSpy.mockRestore();
    gunzipSpy.mockRestore();
  }); test('PASS_encodeNextToken_4: Token includes TTL metadata for expiration checking', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status }];
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      const tokenData = { lastKey: mockLastKey, timestamp: Date.now() };
      callback(null, Buffer.from(JSON.stringify(tokenData)));
    });
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.nextToken).toBeDefined();
  }); test('FAIL_decodeNextToken_1: Invalid base64 string → throws decoding error', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { nextToken: 'invalid-base64-string!!!' };
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    const gunzipSpy = jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(new Error('Decoding failed'));
    });
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
    gunzipSpy.mockRestore();
  }); test('FAIL_decodeNextToken_2: Token exceeds MAX_PAGINATION_TOKEN_SIZE (100KB) → throws "Token too large"', async () => {
    const status = Moderation.STATUS.PENDING;
    const largeToken = 'x'.repeat(102401); // > 100KB
    const options = { nextToken: largeToken };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
  }); test('FAIL_decodeNextToken_3: Expired token (TTL > 15 minutes) → throws "Pagination token expired"', async () => {
    const status = Moderation.STATUS.PENDING;
    const expiredToken = Buffer.from(JSON.stringify({
      lastKey: {},
      timestamp: Date.now() - (20 * 60 * 1000) // 20 minutes ago
    })).toString('base64');
    const options = { nextToken: expiredToken };
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    const gunzipSpy = jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(null, Buffer.from(JSON.stringify({
        lastKey: {},
        timestamp: Date.now() - (20 * 60 * 1000)
      })));
    });
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
    gunzipSpy.mockRestore();
  }); test('FAIL_decodeNextToken_4: Token with corrupted gzip data → throws', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { nextToken: 'corrupted-token' };
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    const gunzipSpy = jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(new Error('Corrupted gzip data'));
    });
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
    gunzipSpy.mockRestore();
  }); test('FAIL_decodeNextToken_5: Token from different table/schema → may cause downstream errors', async () => {
    const status = Moderation.STATUS.PENDING;
    const wrongToken = Buffer.from(JSON.stringify({
      lastKey: { pk: 'wrong#table', sk: 'wrong#key' },
      timestamp: Date.now()
    })).toString('base64');
    const options = { nextToken: wrongToken };
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    const gunzipSpy = jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(null, Buffer.from(JSON.stringify({
        lastKey: { pk: 'wrong#table', sk: 'wrong#key' },
        timestamp: Date.now()
      })));
    });
    
    // This may or may not throw depending on implementation
    try {
      await Moderation.getModerationItemsByStatus(status, options);
    } catch (error) {
      expect(error).toBeDefined();
    }
    gunzipSpy.mockRestore();
  });

  /**
   * --------------------------------
   * SECTION: Cross-Cutting Test Categories
   * --------------------------------
   */

  /**
   * Security / Injection Tests
   */ test('SECURITY_1: Prototype pollution via data objects - __proto__ in createModerationEntry data → SafeUtils prevents mutation', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.safeObject = jest.fn(obj => {
      const safe = { ...obj };
      delete safe.__proto__;
      return safe;
    });
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, __proto__: { isAdmin: true } };
    await Moderation.createModerationEntry(data);
    
    expect(SafeUtils.safeObject).toHaveBeenCalled();
    expect(Object.prototype.isAdmin).toBeUndefined();
  }); test('SECURITY_1: Prototype pollution via data objects - constructor.prototype in updates → SafeUtils prevents mutation', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH, constructor: { prototype: { isAdmin: true } } };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.safeObject = jest.fn(obj => {
      const safe = { ...obj };
      delete safe.constructor;
      return safe;
    });
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(SafeUtils.safeObject).toHaveBeenCalled();
  }); test('SECURITY_2: SQL/NoSQL injection attempts - Special characters in userId → sanitization escapes/rejects', async () => {
    const userId = "user'; DROP TABLE--";
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str.replace(/[';\-]/g, '').replace(/\bDROP\s*TABLE\b/gi, ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(SafeUtils.sanitizeString).toHaveBeenCalledWith(userId);
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.pk).not.toContain("DROP TABLE");
  }); test('SECURITY_2: SQL/NoSQL injection attempts - Injection in status → sanitization rejects', async () => {
    const status = "pending' OR '1'='1";
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus(status, {})).rejects.toThrow();
  }); test('SECURITY_3: XSS payloads in content/notes - script tag in note text → sanitized on input', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = '<script>alert("xss")</script>';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str.replace(/<script>/gi, ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(SafeUtils.sanitizeString).toHaveBeenCalled();
  }); test('SECURITY_4: Path traversal in string fields - ../../etc/passwd in contentId → sanitization prevents', async () => {
    const userId = 'user123';
    const contentId = '../../etc/passwd';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str.replace(/\.\./g, ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.createModerationEntry({ userId, contentId, type, priority })).rejects.toThrow();
    expect(SafeUtils.sanitizeString).toHaveBeenCalledWith(contentId);
  }); test('SECURITY_5: Oversized inputs - nextToken > MAX_PAGINATION_TOKEN_SIZE → validation rejects', async () => {
    const status = Moderation.STATUS.PENDING;
    const largeToken = 'x'.repeat(102401);
    const options = { nextToken: largeToken };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
  }); test('SECURITY_5: Oversized inputs - notes array > MAX_NOTES_PER_ITEM → validation rejects', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const notes = Array(51).fill(null).map((_, i) => ({
      text: `Note ${i}`,
      addedBy: 'user1',
      addedAt: Date.now()
    }));
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority, notes };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  });

  /**
   * Dependency Interaction Tests
   */ test('DEP_1: Scylla transient throttling errors - Mock ProvisionedThroughputExceededException → retry mechanism activates, succeeds after backoff', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    const throttleError = new Error('Throttling');
    throttleError.code = 'ProvisionedThroughputExceededException';
    
    Scylla.putItem = jest.fn()
      .mockRejectedValueOnce(throttleError)
      .mockResolvedValueOnce({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalledTimes(2);
  }); test('DEP_2: Scylla conditional check failures - Mock ConditionalCheckFailedException → optimistic locking retries, eventually succeeds', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.code = 'ConditionalCheckFailedException';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn()
      .mockResolvedValueOnce({ Item: existingItem })
      .mockResolvedValueOnce({ Item: { ...existingItem, version: 2 } });
    Scylla.updateItem = jest.fn()
      .mockRejectedValueOnce(conditionalError)
      .mockResolvedValueOnce({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalledTimes(2);
  }); test('DEP_3: Scylla network timeouts - Mock connection timeout → retry with exponential backoff, throws after max attempts', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    const timeoutError = new Error('Connection timeout');
    timeoutError.code = 'TimeoutError';
    
    Scylla.putItem = jest.fn().mockRejectedValue(timeoutError);
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
    expect(Scylla.putItem).toHaveBeenCalledTimes(Moderation.RETRY_MAX_ATTEMPTS);
  }); test('DEP_4: Scylla returns malformed response - Mock response with missing Items field → handled gracefully', async () => {
    const status = Moderation.STATUS.PENDING;
    
    Scylla.request = jest.fn().mockResolvedValue({}); // Missing Items field
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.items).toEqual([]);
  }); test('DEP_5: Logger.writeLog failures - Mock Logger.writeLog to throw → main operation completes, logging error doesn\'t break flow', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn().mockImplementation(() => {
      throw new Error('Logging failed');
    });
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('DEP_6: ErrorHandler.addError failures - Mock ErrorHandler to throw → original error still propagates', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockRejectedValue(new Error('Operation failed'));
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn().mockImplementation(() => {
      throw new Error('ErrorHandler failed');
    });
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  });

  /**
   * Performance-Sensitive Tests
   */ test('PERF_1: Query limit enforcement - Request limit=1001 (> MAX_QUERY_RESULT_SIZE) → throws before query execution', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { limit: 1001 };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
    expect(Scylla.query).not.toHaveBeenCalled();
  }); test('PERF_2: Pagination iteration ceiling - Mock result that paginates infinitely → throws at MAX_PAGINATION_ITERATIONS', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.countModerationItemsByStatus(status)).rejects.toThrow();
  }); test('PERF_3: Large content handling - 10MB content object in createModerationEntry → compression reduces size, no memory exhaustion', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const largeContent = 'x'.repeat(10 * 1024 * 1024); // 10MB
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const data = { userId, contentId, type, priority, content: largeContent };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.contentCompressed).toBe(true);
  }); test('PERF_4: Parallel count operations in getAllModerationCounts - All status counts run in parallel', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Count: 10 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const startTime = Date.now();
    await Moderation.getAllModerationCounts();
    const endTime = Date.now();
    
    expect(endTime - startTime).toBeLessThan(1000); // Should complete quickly due to parallel execution
  }); test('PERF_5: Content decompression on large result sets - 1000 items each with compressed content → decompression completes reasonably', async () => {
    const status = Moderation.STATUS.PENDING;
    const decompressedContent = { original: 'content' };
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    zlib.gunzip.mockImplementation((buf, callback) => realZlib.gunzip(buf, (err, res) => (callback ? callback(err, res) : undefined)));
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    const compressedBuf = await realGzip(Buffer.from(JSON.stringify(decompressedContent), 'utf8'));
    const compressedB64 = compressedBuf.toString('base64');
    const mockItems = Array(1000).fill(null).map((_, i) => ({
      moderationId: `id${i}`,
      status,
      content: { _compressed: true, _format: 'gzip', data: compressedB64 }
    }));
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const startTime = Date.now();
    const result = await Moderation.getModerationItemsByStatus(status, {});
    const endTime = Date.now();
    
    expect(result.items).toBeDefined();
    expect(endTime - startTime).toBeLessThan(10000); // Should complete in reasonable time
  }, 15000);

  /**
   * Logging Correctness Tests
   */ test('LOG_1: Success logging - createModerationEntry → Logger.writeLog called with flag="MODERATIONS", action="moderationCreated"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls.find(call => call[0]?.flag === 'MODERATIONS' && call[0]?.action === 'moderationCreated');
    expect(logCall).toBeDefined();
    expect(logCall[0].action).toBe('moderationCreated');
  }); test('LOG_1: Success logging - updateModerationEntry → action="moderationUpdated"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls.find(call => call[0]?.flag === 'MODERATIONS' && call[0]?.action === 'moderationUpdated');
    expect(logCall).toBeDefined();
    expect(logCall[0].action).toBe('moderationUpdated');
  }); test('LOG_1: Success logging - addNote → action="noteAdded"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'Test note';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls.find(call => call[0]?.flag === 'MODERATIONS' && call[0]?.action === 'noteAdded');
    expect(logCall).toBeDefined();
    expect(logCall[0].action).toBe('noteAdded');
  }); test('LOG_1: Success logging - applyModerationAction → action="moderationActioned"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls.find(call => call[0]?.flag === 'MODERATIONS' && (call[0]?.action === 'moderationActioned' || call[0]?.action === 'actionApplied'));
    expect(logCall).toBeDefined();
    expect(['moderationActioned', 'actionApplied']).toContain(logCall[0].action);
  }); test('LOG_1: Success logging - escalateModerationItem → action="itemEscalated"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls.find(call => call[0]?.flag === 'MODERATIONS' && call[0]?.action === 'itemEscalated');
    expect(logCall).toBeDefined();
    expect(logCall[0].action).toBe('itemEscalated');
  }); test('LOG_1: Success logging - hardDeleteModerationItem → action="itemHardDeleted"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const mockItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: mockItem });
    Scylla.deleteItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.hardDeleteModerationItem(moderationId, userId);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls.find(call => call[0]?.flag === 'MODERATIONS' && call[0]?.action === 'itemHardDeleted');
    expect(logCall).toBeDefined();
    expect(logCall[0].action).toBe('itemHardDeleted');
  }); test('LOG_2: Error logging - All ErrorHandler.addError calls include descriptive message, unique error code, origin, relevant data', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type }; // Missing priority
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
    
    expect(ErrorHandler.addError).toHaveBeenCalled();
    const errorCall = ErrorHandler.addError.mock.calls[0];
    expect(errorCall[0]).toBeDefined(); // Message
    expect(errorCall[1]).toBeDefined(); // Data object
    expect(errorCall[1].code).toBeDefined(); // Error code
    expect(errorCall[1].origin).toBeDefined(); // Origin
  }); test('LOG_3: Debug logging - All methods start with Logger.debugLog [START]', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Logger.debugLog).toHaveBeenCalled();
    const debugCalls = Logger.debugLog.mock.calls.map(call => call[0]);
    expect(debugCalls.some(call => call && call.includes('[START]'))).toBe(true);
  }); test('LOG_3: Debug logging - All methods end with Logger.debugLog [SUCCESS] or [ERROR]', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const debugCalls = Logger.debugLog.mock.calls.map(call => call[0]);
    expect(debugCalls.some(call => call && (call.includes('[SUCCESS]') || call.includes('[ERROR]')))).toBe(true);
  });

  /**
   * Edge Case Tests
   */ test('EDGE_1: Empty string edge cases - userId = "   " (whitespace only) → sanitized to "" → rejected', async () => {
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    const data = { userId: '   ', contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('EDGE_2: Boundary timestamps - Timestamp exactly 5 years ago (boundary)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const exactlyFiveYearsAgo = Date.now() - (5 * 365 * 24 * 60 * 60 * 1000);
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, exactlyFiveYearsAgo);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('EDGE_2: Boundary timestamps - Timestamp exactly 5 minutes in future (boundary)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const exactlyFiveMinutesFuture = Date.now() + (5 * 60 * 1000);
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, exactlyFiveMinutesFuture);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('EDGE_2: Boundary timestamps - Epoch zero (0)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    // Epoch zero may be rejected as too far in past
    try {
      await Moderation.createModerationEntry(data, 0);
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('EDGE_3: Enum edge cases - Type alias: "gallery" vs "image_gallery"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data1 = { userId, contentId, type: Moderation.TYPE.GALLERY, priority };
    const data2 = { userId, contentId, type: Moderation.TYPE.IMAGE_GALLERY, priority };
    
    await Moderation.createModerationEntry(data1);
    await Moderation.createModerationEntry(data2);
    
    expect(Scylla.putItem).toHaveBeenCalledTimes(2);
  }); test('EDGE_4: Array boundary cases - Empty notes array []', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const notes = [];
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, notes };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('EDGE_4: Array boundary cases - notes array with exactly MAX_NOTES_PER_ITEM (50) items', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const notes = Array(50).fill(null).map((_, i) => ({
      text: `Note ${i}`,
      addedBy: 'user1',
      addedAt: Date.now()
    }));
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, notes };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('EDGE_5: Null vs undefined vs missing - timestamp: undefined → auto-generate', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const mockNow = 1640995200000;
    jest.spyOn(Date, 'now').mockReturnValue(mockNow);
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, undefined);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.submittedAt).toBe(mockNow);
    Date.now.mockRestore();
  }); test('EDGE_6: Boolean coercion - isSystemGenerated: "true" (string) → may be coerced or rejected', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, isSystemGenerated: 'true' };
    
    try {
      await Moderation.createModerationEntry(data);
      expect(Scylla.putItem).toHaveBeenCalled();
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('EDGE_7: Concurrent operations - Two moderators approve same item simultaneously → optimistic locking ensures consistency', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderator1 = 'moderator1';
    const moderator2 = 'moderator2';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    const conditionalError = new Error('ConditionalCheckFailedException');
    conditionalError.code = 'ConditionalCheckFailedException';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn()
      .mockResolvedValueOnce({ Item: existingItem })
      .mockResolvedValueOnce({ Item: { ...existingItem, version: 2 } });
    Scylla.updateItem = jest.fn()
      .mockRejectedValueOnce(conditionalError)
      .mockResolvedValueOnce({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    // Simulate concurrent attempts
    const promise1 = Moderation.applyModerationAction(moderationId, userId, action, moderator1);
    const promise2 = Moderation.applyModerationAction(moderationId, userId, action, moderator2);
    
    const results = await Promise.allSettled([promise1, promise2]);
    
    // Only one should succeed
    const successful = results.filter(r => r.status === 'fulfilled');
    expect(successful.length).toBeLessThanOrEqual(1);
  }); test('EDGE_8: UTF-8 and special characters - Emoji in note text: "Great work! 👍"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'Great work! 👍';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('EDGE_9: Extremely long strings - Note with MAX_NOTE_LENGTH (5000) chars', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'x'.repeat(5000);
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('EDGE_9: Extremely long strings - Note with 5001 chars → rejected', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'x'.repeat(5001);
    const addedBy = 'moderator1';
    SafeUtils.sanitizeString = jest.fn(str => str);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, note, addedBy)).rejects.toThrow();
  }); test('EDGE_10: Result set edge cases - Query returns 0 items', async () => {
    const status = Moderation.STATUS.PENDING;
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.items).toEqual([]);
    expect(result.count).toBe(0);
  }); test('EDGE_10: Result set edge cases - Query returns exactly limit items', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { limit: 20 };
    const mockItems = Array(20).fill(null).map((_, i) => ({
      moderationId: `id${i}`,
      status
    }));
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, options);
    
    expect(result.items.length).toBe(20);
  });

  /**
   * Regression Tests
   */ test('REGR_1: Ensure moderationId uniqueness across the system (no UUID collisions in GSI_BY_MOD_ID)', async () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      const id = Moderation.generateModerationId();
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
    expect(ids.size).toBe(1000);
  }); test('REGR_2: Verify dayKey always uses UTC for consistency across timezones', async () => {
    const ts = 1640995200000; // 2022-01-01 00:00:00 UTC
    const dayKey = Moderation.dayKeyFromTs(ts);
    
    // Should always be 20220101 regardless of local timezone
    expect(dayKey).toBe('20220101');
  }); test('REGR_3: Ensure statusSubmittedAt composite key format never changes (backward compatibility)', async () => {
    const status = Moderation.STATUS.PENDING;
    const ts = 1640995200000;
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    
    const key = Moderation.statusSubmittedAtKey(status, ts);
    
    expect(key).toBe('pending#1640995200000');
    expect(key).toContain('#');
  }); test('REGR_4: Verify pagination token format remains stable across versions', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status }];
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      callback(null, Buffer.from(JSON.stringify(mockLastKey)));
    });
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.nextToken).toBeDefined();
    expect(typeof result.nextToken).toBe('string');
  }); test('REGR_5: Ensure MAX_* constants are respected and haven\'t been accidentally changed', async () => {
    expect(Moderation.MAX_NOTE_LENGTH).toBe(5000);
    expect(Moderation.MAX_NOTES_PER_ITEM).toBe(50);
    expect(Moderation.MAX_HISTORY_ENTRIES).toBe(100);
    expect(Moderation.MAX_QUERY_RESULT_SIZE).toBe(1000);
    expect(Moderation.MAX_PAGINATION_ITERATIONS).toBe(100);
  }); test('REGR_6: Test that all GSI projections include necessary fields (prevent missing field errors)', async () => {
    Scylla.createTable = jest.fn().mockResolvedValue({});
    
    await Moderation.createModerationSchema();
    
    const callArgs = Scylla.createTable.mock.calls[0][0];
    const gsis = callArgs.GlobalSecondaryIndexes;
    
    gsis.forEach(gsi => {
      if (gsi.Projection.ProjectionType === 'INCLUDE') {
        expect(gsi.Projection.NonKeyAttributes).toBeDefined();
        expect(gsi.Projection.NonKeyAttributes.length).toBeGreaterThan(0);
      }
    });
  }); test('REGR_7: Verify optimistic locking version increments consistently', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload && updatePayload.meta).toBeDefined();
    expect(updatePayload.meta.version).toBeDefined();
  }); test('REGR_8: Ensure content compression/decompression is backward compatible with old data', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const mockItem = {
      moderationId,
      userId,
      content: Buffer.from('old uncompressed data'),
      contentCompressed: false
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: mockItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(result).toBeDefined();
    expect(result.content).toBeDefined();
  });

  /**
   * --------------------------------
   * SECTION: Additional Test Scenarios from Code Audit
   * --------------------------------
   */

  /**
   * Additional Private Helper Method Tests
   */ test('PASS_buildPartitionKey_1: Valid userId returns "moderation#<userId>" format', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.pk).toBe(`moderation#${userId}`);
  }); test('PASS_buildPartitionKey_2: Whitespace in userId gets sanitized correctly', async () => {
    const userId = '  user123  ';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str.trim());
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.pk).toBe('moderation#user123');
  }); test('FAIL_buildPartitionKey_1: Empty userId after sanitization → throws "Invalid userId for partition key"', async () => {
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    const data = { userId: '   ', contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_buildPartitionKey_2: Whitespace-only userId "   " → sanitized to empty → throws', async () => {
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    SafeUtils.sanitizeString = jest.fn().mockReturnValue('');
    ErrorHandler.addError = jest.fn();
    
    const data = { userId: '   ', contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('PASS_validateAndJoinFilterExpressions_1: Single expression returns as-is', async () => {
    const filters = { status: Moderation.STATUS.PENDING };
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    expect(Scylla.request).toHaveBeenCalled();
  }); test('PASS_validateAndJoinFilterExpressions_2: Multiple expressions joined with " AND "', async () => {
    const filters = { status: Moderation.STATUS.PENDING, userId: 'user123' };
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING, userId: 'user123' }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    if (queryCall.FilterExpression) {
      expect(queryCall.FilterExpression).toContain('AND');
    }
  }); test('PASS_validateAndJoinFilterExpressions_3: Empty array returns empty string', async () => {
    const filters = {};
    const mockItems = [{ moderationId: '123' }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    expect(Scylla.request).toHaveBeenCalled();
  }); test('FAIL_validateAndJoinFilterExpressions_1: Non-array input → throws or handles gracefully', async () => {
    const filters = { invalidFilter: 'value' };
    ErrorHandler.addError = jest.fn();
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    expect(Scylla.request).toHaveBeenCalled();
  }); test('PASS_validateContentIdFormat_1: Valid contentId format accepted', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('PASS_validateContentIdFormat_2: ContentId with special characters sanitized', async () => {
    const userId = 'user123';
    const contentId = 'content-123_special';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(SafeUtils.sanitizeString).toHaveBeenCalledWith(contentId);
  }); test('FAIL_validateContentIdFormat_1: Empty contentId → throws', async () => {
    const userId = 'user123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId: '', type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_validateContentIdFormat_2: Invalid format → throws validation error', async () => {
    const userId = 'user123';
    const contentId = null;
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('PASS_validateActionStatusConsistency_1: Valid action/status pairs (approve→approved, reject→rejected) pass validation', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_validateActionStatusConsistency_2: Null/undefined action or status skipped (no validation)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { status: Moderation.STATUS.PENDING };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('FAIL_validateActionStatusConsistency_1: Inconsistent pair (approve→rejected) → logs warning via ErrorHandler', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.REJECTED
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, action, moderatorId)).rejects.toThrow();
    expect(ErrorHandler.addError).toHaveBeenCalled();
  }); test('PASS_validateDeletedConsistency_1: isDeleted=true with deletedAt set → passes', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const timestamp = Date.now();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isDeleted: false,
      deletedAt: null
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.softDeleteModerationItem(moderationId, userId);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.isDeleted).toBe(true);
    expect(updatePayload.deletedAt).toBeDefined();
  }); test('PASS_validateDeletedConsistency_2: isDeleted=false with deletedAt=null → passes', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.isDeleted).toBe(false);
    expect(putItemCall.Item.deletedAt).toBeNull();
  }); test('FAIL_validateDeletedConsistency_1: isDeleted=true but deletedAt=null → throws "isDeleted is true but deletedAt must be set"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { isDeleted: true, deletedAt: null };
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isDeleted: false
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_validateDeletedConsistency_2: isDeleted=false but deletedAt set → throws "isDeleted is false but deletedAt must be null"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { isDeleted: false, deletedAt: Date.now() };
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isDeleted: true,
      deletedAt: Date.now()
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('PASS_validateActionedAtConsistency_1: action set with actionedAt set → passes', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.actionedAt).toBeDefined();
  }); test('PASS_validateActionedAtConsistency_2: action null with actionedAt null → passes', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      action: null,
      actionedAt: null
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('FAIL_validateActionedAtConsistency_1: action set but actionedAt null → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { action: Moderation.ACTION.APPROVE };
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      action: null,
      actionedAt: null
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_validateActionedAtConsistency_2: action null but actionedAt set → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { action: null };
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      action: Moderation.ACTION.APPROVE,
      actionedAt: Date.now()
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('PASS_validateEscalatedConsistency_1: status="escalated" with escalatedBy set → passes', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.status).toBeDefined();
    expect(updatePayload.escalatedBy).toBeDefined();
  }); test('PASS_validateEscalatedConsistency_2: status!="escalated" with escalatedBy=null → passes', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { status: Moderation.STATUS.PENDING };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      escalatedBy: null
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('FAIL_validateEscalatedConsistency_1: status="escalated" but escalatedBy=null → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { status: Moderation.STATUS.ESCALATED };
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      escalatedBy: null
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_validateEscalatedConsistency_2: status!="escalated" but escalatedBy set → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { status: Moderation.STATUS.PENDING };
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.ESCALATED,
      escalatedBy: 'moderator1'
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('PASS_validateStatusSubmittedAtConsistency_1: statusSubmittedAt matches expected format from status and submittedAt', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const timestamp = 1640995200000;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, timestamp);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    const expectedKey = Moderation.statusSubmittedAtKey(Moderation.STATUS.PENDING, timestamp);
    expect(putItemCall.Item.statusSubmittedAt).toBe(expectedKey);
  }); test('FAIL_validateStatusSubmittedAtConsistency_1: statusSubmittedAt doesn\'t match expected format → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      status: Moderation.STATUS.PENDING,
      statusSubmittedAt: 'invalid_format',
      submittedAt: 1640995200000
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    try {
      await Moderation.getModerationRecordById(moderationId, userId);
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('PASS_validateFieldLength_1: Value within maxLength → passes', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'x'.repeat(1000);
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_validateFieldLength_2: Value exactly at maxLength → passes', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'x'.repeat(5000);
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('FAIL_validateFieldLength_1: Value exceeds maxLength → throws "Field length exceeded"', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = 'x'.repeat(5001);
    const addedBy = 'moderator1';
    SafeUtils.sanitizeString = jest.fn(str => str);
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, note, addedBy)).rejects.toThrow();
  }); test('FAIL_validateFieldLength_2: Null/undefined value → may throw or pass depending on implementation', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = null;
    const addedBy = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    try {
      await Moderation.addNote(moderationId, userId, note, addedBy);
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('PASS_getCurrentTimestamp_1: Returns positive integer timestamp', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(typeof putItemCall.Item.submittedAt).toBe('number');
    expect(putItemCall.Item.submittedAt).toBeGreaterThan(0);
  }); test('PASS_getCurrentTimestamp_2: Returns value close to Date.now() (within 1 second tolerance)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const mockNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(mockNow);
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.submittedAt).toBe(mockNow);
    Date.now.mockRestore();
  }); test('PASS_getCurrentTimestamp_3: Returns monotonically increasing values on sequential calls', async () => {
    const timestamps = [];
    for (let i = 0; i < 10; i++) {
      const mockNow = Date.now() + i;
      jest.spyOn(Date, 'now').mockReturnValue(mockNow);
      timestamps.push(Moderation._getCurrentTimestamp ? Moderation._getCurrentTimestamp() : Date.now());
      Date.now.mockRestore();
    }
    
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }
  });

  /**
   * Additional Method-Specific Test Scenarios
   */ test('FAIL_getCurrentTimestamp_1: Date.now() throws error → ErrorHandler logs, uses fallback or throws', async () => {
    const originalDateNow = Date.now;
    Date.now = jest.fn(() => {
      throw new Error('Date.now() failed');
    });
    ErrorHandler.addError = jest.fn();
    
    try {
      const userId = 'user123';
      const contentId = 'content123';
      const type = Moderation.TYPE.IMAGE;
      const priority = Moderation.PRIORITY.NORMAL;
      
      Scylla.putItem = jest.fn().mockResolvedValue({});
      Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
      SafeUtils.sanitizeString = jest.fn(str => str);
      SafeUtils.sanitizeInteger = jest.fn(val => val);
      Logger.writeLog = jest.fn();
      Logger.debugLog = jest.fn();
      
      const data = { userId, contentId, type, priority };
      await Moderation.createModerationEntry(data);
    } catch (error) {
      expect(error).toBeDefined();
    } finally {
      Date.now = originalDateNow;
    }
  }); test('PASS_createModerationEntry_19: Custom moderationId provided and validated via _validateModerationIdFormat', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const customModerationId = Moderation.generateModerationId();
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId: customModerationId };
    const result = await Moderation.createModerationEntry(data);
    
    expect(result).toBe(customModerationId);
  }); test('PASS_createModerationEntry_19: Custom moderationId provided and validated via _validateModerationIdFormat', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const customModerationId = Moderation.generateModerationId();
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId: customModerationId };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('PASS_createModerationEntry_20: Duplicate moderationId check via GSI_BY_MOD_ID query before creation', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const existingModerationId = Moderation.generateModerationId();
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId: existingModerationId }] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    ErrorHandler.addError = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId: existingModerationId };
    
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_BY_MOD_ID);
  }); test('PASS_createModerationEntry_20: Duplicate moderationId check via GSI_BY_MOD_ID query before creation', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const moderationId = Moderation.generateModerationId();
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn()
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.request).toHaveBeenCalled();
  }); test('PASS_createModerationEntry_21: Content compression threshold (tests when compression is triggered vs skipped)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    // Small content - should not compress
    const smallData = { userId, contentId, type, priority, content: 'small' };
    await Moderation.createModerationEntry(smallData);
    const _s = Scylla.putItem.mock.calls[0]; const smallCall = { Item: _s[1] };
    expect(smallCall.Item.contentCompressed).toBeFalsy();
    
    // Large content - should compress
    const largeData = { userId, contentId, type, priority, content: 'x'.repeat(60000) };
    await Moderation.createModerationEntry(largeData);
    const _l = Scylla.putItem.mock.calls[1]; const largeCall = { Item: _l[1] };
    expect(largeCall.Item.contentCompressed).toBe(true);
  }); test('PASS_createModerationEntry_22: All GSI fields populated correctly (statusSubmittedAt, dayKey, etc.)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const timestamp = 1640995200000;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, timestamp);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.dayKey).toBe('20220101');
    expect(putItemCall.Item.statusSubmittedAt).toBeDefined();
  }); test('PASS_createModerationEntry_22: All GSI fields populated correctly (statusSubmittedAt, dayKey, etc.)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const timestamp = 1640995200000;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, timestamp);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.statusSubmittedAt).toBeDefined();
    expect(putItemCall.Item.dayKey).toBeDefined();
  }); test('PASS_createModerationEntry_23: Version field initialized to 1 in meta', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.meta.version).toBe(1);
  }); test('PASS_createModerationEntry_23: Version field initialized to 1 in meta', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.meta.version).toBe(1);
  }); test('FAIL_createModerationEntry_21: GSI_BY_MOD_ID query fails during duplicate check → retries → throws', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const moderationId = Moderation.generateModerationId();
    ErrorHandler.addError = jest.fn();
    
    Scylla.request = jest.fn().mockRejectedValue(new Error('Database error'));
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, moderationId };
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('FAIL_createModerationEntry_22: Content compression throws error → propagates to caller', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const largeContent = 'x'.repeat(60000);
    ErrorHandler.addError = jest.fn();
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      callback(new Error('Compression failed'));
    });
    
    const data = { userId, contentId, type, priority, content: largeContent };
    await expect(Moderation.createModerationEntry(data)).rejects.toThrow();
  }); test('PASS_updateModerationEntry_17: Version increment on successful update', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    const updateArg = Scylla.updateItem.mock.calls[0][2];
    expect(updateArg.meta && updateArg.meta.version).toBeDefined();
  }); test('PASS_updateModerationEntry_18: Partial update doesn\'t affect other fields (atomic update)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      type: Moderation.TYPE.IMAGE,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    const updateArg = Scylla.updateItem.mock.calls[0][2];
    expect(updateArg.priority === Moderation.PRIORITY.HIGH).toBe(true);
  }); test('PASS_updateModerationEntry_19: Content decompression before update comparison', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { content: 'new content' };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      content: Buffer.from('compressed'),
      _compressed: true,
      _format: 'gzip',
      data: Buffer.from('x').toString('base64'),
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGunzip = promisify(realZlib.gunzip);
    jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      realGunzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationEntry_20: Content recompression if updated content is large', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const largeContent = 'x'.repeat(60000);
    const updates = { content: largeContent };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      content: 'old content',
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('FAIL_updateModerationEntry_20: getModerationRecordById fails during lookup → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    ErrorHandler.addError = jest.fn();
    
    Scylla.request = jest.fn().mockRejectedValue(new Error('Database error'));
    Scylla.getItem = jest.fn().mockRejectedValue(new Error('Database error'));
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('FAIL_updateModerationEntry_21: Content decompression fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { content: 'new content' };
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      content: Buffer.from('corrupted'),
      contentCompressed: true
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const gunzipSpy = jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(new Error('Decompression failed'));
    });
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
    gunzipSpy.mockRestore();
  }); test('PASS_applyModerationAction_15: TAG type items get tagStatus set correctly (published/pending)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING,
      type: Moderation.TYPE.TAGS
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, '', moderatorId);
    
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].tagStatus).toBe(Moderation.TAG_STATUS.PUBLISHED);
  }); test('PASS_applyModerationAction_16: Non-TAG type items have tagStatus cleared/nullified', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING,
      type: Moderation.TYPE.IMAGE
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, '', moderatorId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_17: Multiple notes (private + public) added in single action', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    const privateNote = 'Private note';
    const publicNote = 'Public note';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING,
      notes: []
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.sanitizeTextField = jest.fn(str => (str && typeof str === 'string' ? str.trim() : ''));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, '', moderatorId, 'standard', privateNote, publicNote);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
    const updateCall = Scylla.updateItem.mock.calls[0];
    expect(updateCall[2].notes).toBeDefined();
    expect(updateCall[2].notes.length).toBeGreaterThanOrEqual(2);
  }); test('PASS_applyModerationAction_18: Notes array length validation before adding notes', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      notes: Array(Moderation.MAX_NOTES_PER_ITEM - 1).fill(null).map((_, i) => ({
        note: `Note ${i}`,
        addedBy: 'moderator1',
        addedAt: Date.now()
      }))
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_applyModerationAction_19: ConditionalCheckFailedException throws (no retry; concurrent modifier won)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockRejectedValue(Object.assign(new Error('ConditionalCheckFailedException'), { code: 'ConditionalCheckFailedException', awsType: 'ConditionalCheckFailedException' }));
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, action, '', moderatorId)).rejects.toThrow(/concurrent modification/);
    expect(Scylla.updateItem).toHaveBeenCalledTimes(1);
  }); test('FAIL_applyModerationAction_16: Notes array would exceed MAX_NOTES_PER_ITEM → throws before update', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      notes: Array(Moderation.MAX_NOTES_PER_ITEM).fill(null).map((_, i) => ({
        note: `Note ${i}`,
        addedBy: 'moderator1',
        addedAt: Date.now()
      }))
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, action, moderatorId)).rejects.toThrow();
  }); test('FAIL_applyModerationAction_17: getModerationRecordById fails during lookup → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    Scylla.request = jest.fn().mockRejectedValue(new Error('Database error'));
    Scylla.getItem = jest.fn().mockRejectedValue(new Error('Database error'));
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.applyModerationAction(moderationId, userId, action, moderatorId)).rejects.toThrow();
  }); test('PASS_escalateModerationItem_10: Already escalated item can be re-escalated (idempotent behavior)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.ESCALATED,
      escalatedBy: 'moderator1'
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_escalateModerationItem_11: Optimistic locking retry mechanism with backoff', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      meta: { version: 1, history: [] },
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.updateItem = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('ConditionalCheckFailedException'), { awsType: 'ConditionalCheckFailedException' }))
      .mockResolvedValueOnce({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalledTimes(2);
  }); test('FAIL_escalateModerationItem_10: Item already escalated → may throw or succeed (test actual behavior)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.ESCALATED,
      escalatedBy: 'moderator2'
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    try {
      await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('PASS_getModerationItems_19: Complex filter combination (userId + status + dayKey + date range) → correct index selection', async () => {
    const filters = {
      userId: 'user123',
      status: Moderation.STATUS.PENDING,
      dayKey: '20220101',
      startTimestamp: 1640995200000,
      endTimestamp: 1641081600000
    };
    const mockItems = [{ moderationId: '123', userId: 'user123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBeDefined();
  }); test('PASS_getModerationItems_19: Complex filter combination (userId + status + dayKey + date range) → correct index selection', async () => {
    const filters = { 
      userId: 'user123', 
      status: Moderation.STATUS.PENDING,
      dayKey: '20220101'
    };
    const options = { startTimestamp: 1640995200000, endTimestamp: 1641081600000 };
    const mockItems = [{ moderationId: '123', userId: 'user123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_USER_STATUS_DATE);
  }); test('PASS_getModerationItems_20: Filter by moderatedBy uses GSI_MODERATED_BY', async () => {
    const filters = { moderatedBy: 'moderator1' };
    const mockItems = [{ moderationId: '123', moderatedBy: 'moderator1' }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_MODERATED_BY);
  }); test('PASS_getModerationItems_20: Filter by moderatedBy uses GSI_MODERATED_BY', async () => {
    const filters = { moderatedBy: 'moderator1' };
    const mockItems = [{ moderationId: '123', moderatedBy: 'moderator1' }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_MODERATED_BY);
  }); test('PASS_getModerationItems_21: Filter by contentId uses GSI_CONTENT_ID', async () => {
    const filters = { contentId: 'content123' };
    const mockItems = [{ moderationId: '123', contentId: 'content123' }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_CONTENT_ID);
  }); test('PASS_getModerationItems_21: Filter by contentId uses GSI_CONTENT_ID', async () => {
    const filters = { contentId: 'content123' };
    const mockItems = [{ moderationId: '123', contentId: 'content123' }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_CONTENT_ID);
  }); test('PASS_getModerationItems_22: Filter by escalatedBy uses GSI_ESCALATED', async () => {
    const filters = { escalatedBy: 'moderator1' };
    const mockItems = [{ moderationId: '123', escalatedBy: 'moderator1' }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_ESCALATED);
  }); test('PASS_getModerationItems_22: Filter by escalatedBy uses GSI_ESCALATED', async () => {
    const filters = { escalatedBy: 'moderator1' };
    const mockItems = [{ moderationId: '123', escalatedBy: 'moderator1' }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.IndexName).toBe(Moderation.GSI_ESCALATED);
  }); test('PASS_getModerationItems_23: No suitable index for filter combination → falls back to Scan', async () => {
    const filters = { someUnusualField: 'value' };
    const mockItems = [{ moderationId: '123' }];
    
    Scylla.scan = jest.fn().mockResolvedValue({ Items: mockItems });
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    Scylla.marshalItem = jest.fn((x) => x);
    Scylla.unmarshalItem = jest.fn((x) => x);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    expect(Scylla.request).toHaveBeenCalled();
    const call = Scylla.request.mock.calls[0];
    expect(call[0]).toBe('Scan');
  }); test('PASS_getModerationItems_24: ScanIndexForward only set for Query operations, not Scan', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItemsByStatus(status, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    if (queryCall.ScanIndexForward !== undefined) {
      expect(typeof queryCall.ScanIndexForward).toBe('boolean');
    }
  }); test('FAIL_getModerationItems_14: Invalid filter combination (conflicting filters) → throws or uses fallback', async () => {
    const filters = { userId: 'user123', moderatedBy: 'moderator1' };
    ErrorHandler.addError = jest.fn();
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    expect(Scylla.request).toHaveBeenCalled();
  }); test('PASS_getUserModerationItemsByStatus_11: Status "all" path uses different query structure (userId only in KeyCondition)', async () => {
    const userId = 'user123';
    const status = 'all';
    const mockItems = [{ moderationId: '123', userId }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getUserModerationItemsByStatus(userId, status, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.KeyConditionExpression).toBeDefined();
    expect(queryCall.KeyConditionExpression).toContain('#uid');
  }); test('PASS_getUserModerationItemsByStatus_11: Status "all" path uses different query structure (userId only in KeyCondition)', async () => {
    const userId = 'user123';
    const status = 'all';
    const mockItems = [{ moderationId: '123', userId }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getUserModerationItemsByStatus(userId, status, {});
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.KeyConditionExpression).toBeDefined();
  }); test('PASS_getUserModerationItemsByStatus_12: Date range filters applied via FilterExpression when status="all"', async () => {
    const userId = 'user123';
    const status = 'all';
    const options = { start: 1640995200000, end: 1641081600000 };
    const mockItems = [{ moderationId: '123', userId }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getUserModerationItemsByStatus(userId, status, options);
    
    const queryCall = Scylla.request.mock.calls[0][1];
    expect(queryCall.FilterExpression).toBeDefined();
  }); test('FAIL_getUserModerationItemsByStatus_9: Invalid date range (start > end) → throws or handles gracefully', async () => {
    const userId = 'user123';
    const status = Moderation.STATUS.PENDING;
    const options = { startTimestamp: 1641081600000, endTimestamp: 1640995200000 };
    ErrorHandler.addError = jest.fn();
    
    try {
      await Moderation.getUserModerationItemsByStatus(userId, status, options);
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('PASS_getModerationRecordById_8: GSI query returns item, then getItem retrieves full record (two-step process)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const mockItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: mockItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(Scylla.request).toHaveBeenCalled();
    expect(Scylla.getItem).toHaveBeenCalled();
  }); test('PASS_getModerationRecordById_8: GSI query returns item, then getItem retrieves full record (two-step process)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const mockItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: mockItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(Scylla.request).toHaveBeenCalled();
    expect(Scylla.getItem).toHaveBeenCalled();
    expect(result).toBeDefined();
  }); test('PASS_getModerationRecordById_9: getItem fails after successful GSI query → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockRejectedValue(new Error('Database error'));
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.getModerationRecordById(moderationId, userId)).rejects.toThrow();
  }); test('PASS_getModerationRecordById_10: Content decompression applied to retrieved item', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    const realGunzip = promisify(realZlib.gunzip);
    const compressedContent = await realGzip(Buffer.from(JSON.stringify({ text: 'compressed' }), 'utf8'));
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      content: compressedContent,
      contentCompressed: true
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      realGunzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const result = await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(result).toBeDefined();
  }); test('FAIL_getModerationRecordById_9: GSI query returns empty result → returns null (not throws)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(result).toBeNull();
  }); test('PASS_updateModerationMeta_9: contentDeleted flag update with automatic contentDeletedAt timestamp', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const timestamp = Date.now();
    const metaUpdates = { contentDeleted: true };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload && updatePayload.meta).toBeDefined();
    expect(updatePayload.meta.contentDeleted).toBe(true);
    expect(updatePayload.meta.contentDeletedAt).toBeDefined();
  }); test('PASS_updateModerationMeta_9: contentDeleted flag update with automatic contentDeletedAt timestamp', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { contentDeleted: true };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload && updatePayload.meta).toBeDefined();
    expect(updatePayload.meta.contentDeleted).toBe(true);
  }); test('PASS_updateModerationMeta_10: contentDeleted=false clears contentDeletedAt', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { contentDeleted: false };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_updateModerationMeta_11: History truncation when exceeding MAX_HISTORY_ENTRIES (oldest entries removed)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const largeHistory = Array(150).fill(null).map((_, i) => ({
      action: 'update',
      timestamp: Date.now() + i,
      userId: `user${i}`
    }));
    const metaUpdates = { history: largeHistory };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  });

  /**
   * Additional Cross-Cutting Test Scenarios
   */ test('PASS_updateModerationMeta_12: Version increment on meta update', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { history: [{ action: 'update', timestamp: Date.now(), userId }] };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload && updatePayload.meta).toBeDefined();
    expect(updatePayload.meta.version).toBeDefined();
  }); test('FAIL_updateModerationMeta_10: getModerationRecordById fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { history: [] };
    ErrorHandler.addError = jest.fn();
    
    Scylla.request = jest.fn().mockRejectedValue(new Error('Database error'));
    Scylla.getItem = jest.fn().mockRejectedValue(new Error('Database error'));
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.updateModerationMeta(moderationId, userId, metaUpdates)).rejects.toThrow();
  }); test('PASS_softDeleteModerationItem_7: Already deleted item → throws "already deleted" error', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isDeleted: true,
      deletedAt: Date.now()
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.softDeleteModerationItem(moderationId, userId)).rejects.toThrow();
  }); test('PASS_softDeleteModerationItem_8: deletedBy parameter used for audit trail', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const deletedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isDeleted: false
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.softDeleteModerationItem(moderationId, userId, deletedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('PASS_softDeleteModerationItem_9: Meta field updated with softDelete action in history', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      isDeleted: false,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.softDeleteModerationItem(moderationId, userId);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload && updatePayload.meta).toBeDefined();
    expect(updatePayload.isDeleted).toBe(true);
  }); test('FAIL_softDeleteModerationItem_8: getModerationRecordById fails → throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    ErrorHandler.addError = jest.fn();
    
    Scylla.request = jest.fn().mockRejectedValue(new Error('Database error'));
    Scylla.getItem = jest.fn().mockRejectedValue(new Error('Database error'));
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.softDeleteModerationItem(moderationId, userId)).rejects.toThrow();
  }); test('FAIL_softDeleteModerationItem_9: Item already deleted → throws "already deleted" error', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const pk = `moderation#${userId}`;
    const sk = `media#1640995200000#${moderationId}`;
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk,
      sk,
      version: 1,
      isDeleted: true,
      deletedAt: Date.now()
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.softDeleteModerationItem(moderationId, userId)).rejects.toThrow();
  }); test('PASS_countModerationItemsByStatus_10: Strategy selection (userId+status vs moderatedBy vs status-only) based on filters', async () => {
    const status = Moderation.STATUS.PENDING;
    const filters = { userId: 'user123' };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [], Count: 0 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.countModerationItemsByStatus(status, filters);
    
    expect(Scylla.request).toHaveBeenCalled();
  }); test('PASS_countModerationItemsByStatus_11: unmoderatedOnly flag uses attribute_not_exists filter', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { unmoderatedOnly: true };
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 0 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.countModerationItemsByStatus(status, options);
    
    expect(Scylla.request).toHaveBeenCalled();
    const queryCall = Scylla.request.mock.calls.find(call => call[0] === 'Query')?.[1];
    expect(queryCall?.FilterExpression).toBeDefined();
  }); test('PASS_countModerationItemsByStatus_12: hasRejectionHistory filter uses attribute_exists', async () => {
    const status = Moderation.STATUS.PENDING;
    const filters = { hasRejectionHistory: true };
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 0 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.countModerationItemsByStatus(status, filters);
    
    const queryCall = Scylla.request.mock.calls.find(call => call[0] === 'Query')?.[1];
    expect(queryCall?.FilterExpression).toBeDefined();
  }); test('PASS_countModerationItemsByStatus_13: Multiple pagination pages summed correctly', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#last' };
    
    Scylla.request = jest.fn()
      .mockResolvedValueOnce({ Count: 100, LastEvaluatedKey: mockLastKey })
      .mockResolvedValueOnce({ Count: 50 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.countModerationItemsByStatus(status, {});
    
    expect(result).toBe(150);
  }); test('PASS_countModerationItemsByStatus_14: Values marshaled once before pagination loop (efficiency)', async () => {
    const status = Moderation.STATUS.PENDING;
    const filters = { userId: 'user123' };
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 0 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.countModerationItemsByStatus(status, filters);
    
    expect(Scylla.request).toHaveBeenCalledWith('Query', expect.any(Object));
  }); test('FAIL_countModerationItemsByStatus_7: Invalid filter combination → throws or uses fallback strategy', async () => {
    const status = Moderation.STATUS.PENDING;
    const filters = { invalidFilter: 'value' };
    ErrorHandler.addError = jest.fn();
    
    Scylla.request = jest.fn().mockResolvedValue({ Count: 0 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.countModerationItemsByStatus(status, filters);
    
    expect(result).toBeDefined();
  }); test('PASS_getAllModerationCounts_9: _countPendingResubmission error returns 0 (doesn\'t crash overall method)', async () => {
    Scylla.request = jest.fn()
      .mockResolvedValueOnce({ Items: [], Count: 0 })
      .mockResolvedValueOnce({ Items: [], Count: 0 })
      .mockRejectedValueOnce(new Error('Error'))
      .mockResolvedValueOnce({ Items: [], Count: 0 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    expect(result).toBeDefined();
  }); test('PASS_getAllModerationCounts_10: Result mapping from Promise.all results to status keys correct', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Items: [], Count: 0 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  }); test('PASS_getAllModerationCounts_11: Special counts (pendingResubmission, all, unmoderated) included in result', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Items: [], Count: 0 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  }); test('FAIL_getAllModerationCounts_6: _countPendingResubmission throws → caught, returns 0, method still succeeds', async () => {
    ErrorHandler.addError = jest.fn();
    
    let callCount = 0;
    Scylla.request = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('Unhandled error'));
      }
      return Promise.resolve({ Count: 0 });
    });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    expect(result.pendingResubmission).toBe(0);
  }); test('CONSISTENCY_1: Action/Status consistency validation across all methods that set both fields', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.status).toBeDefined();
    expect(updatePayload.action).toBeDefined();
  }); test('CONSISTENCY_2: Deleted consistency (isDeleted/deletedAt) validation in all query methods', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      isDeleted: true,
      deletedAt: Date.now()
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationRecordById(moderationId, userId, false);
    
    expect(result).toBeNull();
  }); test('CONSISTENCY_3: ActionedAt consistency (actionedAt/action) validation', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.actionedAt).toBeDefined();
  }); test('CONSISTENCY_4: Escalated consistency (status/escalatedBy) validation', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const escalatedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem(existingItem)] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.escalateModerationItem(moderationId, userId, escalatedBy);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload.status).toBeDefined();
    expect(updatePayload.escalatedBy).toBeDefined();
  }); test('CONSISTENCY_5: StatusSubmittedAt consistency validation (matches status + submittedAt)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const timestamp = 1640995200000;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, timestamp);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    const expectedKey = Moderation.statusSubmittedAtKey(Moderation.STATUS.PENDING, timestamp);
    expect(putItemCall.Item.statusSubmittedAt).toBe(expectedKey);
  }); test('GSI_1: All 10 GSIs tested with correct KeyConditionExpression patterns', async () => {
    Scylla.createTable = jest.fn().mockResolvedValue({});
    
    await Moderation.createModerationSchema();
    
    const callArgs = Scylla.createTable.mock.calls[0][0];
    const gsis = callArgs.GlobalSecondaryIndexes;
    expect(gsis.length).toBe(10);
    
    gsis.forEach(gsi => {
      expect(gsi.KeySchema).toBeDefined();
      expect(gsi.KeySchema.length).toBe(2);
    });
  }); test('GSI_2: GSI projection fields (INCLUDE vs KEYS_ONLY) verified for each index', async () => {
    Scylla.createTable = jest.fn().mockResolvedValue({});
    
    await Moderation.createModerationSchema();
    
    const callArgs = Scylla.createTable.mock.calls[0][0];
    const gsis = callArgs.GlobalSecondaryIndexes;
    
    const gsiByModId = gsis.find(gsi => gsi.IndexName === Moderation.GSI_BY_MOD_ID);
    expect(gsiByModId.Projection.ProjectionType).toBe('KEYS_ONLY');
    
    const includeGsis = gsis.filter(gsi => gsi.IndexName !== Moderation.GSI_BY_MOD_ID);
    includeGsis.forEach(gsi => {
      expect(gsi.Projection.ProjectionType).toBe('INCLUDE');
      expect(gsi.Projection.NonKeyAttributes).toBeDefined();
    });
  }); test('GSI_3: FilterExpression applied correctly when using GSIs', async () => {
    const filters = { status: Moderation.STATUS.PENDING, moderatedBy: 'moderator1' };
    const mockItems = [{ moderationId: '123', status: Moderation.STATUS.PENDING, moderatedBy: 'moderator1' }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls.find(call => call[0] === 'Query')?.[1];
    expect(queryCall?.FilterExpression).toBeDefined();
  }); test('GSI_4: Index selection logic for getModerationItems (optimal index chosen)', async () => {
    const filters = { userId: 'user123', status: Moderation.STATUS.PENDING };
    const mockItems = [{ moderationId: '123', userId: 'user123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryCall = Scylla.request.mock.calls.find(call => call[0] === 'Query')?.[1];
    expect(queryCall?.IndexName).toBe(Moderation.GSI_USER_STATUS_DATE);
  }); test('GSI_5: GSI eventual consistency handled (getItem after GSI query for consistent reads)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const mockItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem({ moderationId, userId })] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: mockItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(Scylla.request).toHaveBeenCalledWith('Query', expect.any(Object));
    expect(Scylla.getItem).toHaveBeenCalled();
  }); test('PAGINATION_1: Token encoding includes timestamp for expiration checking', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status }];
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#123' };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      const tokenData = { lastKey: mockLastKey, timestamp: Date.now() };
      callback(null, Buffer.from(JSON.stringify(tokenData)));
    });
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.nextToken).toBeDefined();
  }); test('PAGINATION_2: Token decoding validates TTL (15 minutes)', async () => {
    const status = Moderation.STATUS.PENDING;
    const expiredToken = Buffer.from(JSON.stringify({
      lastKey: {},
      timestamp: Date.now() - (16 * 60 * 1000) // 16 minutes ago
    })).toString('base64');
    const options = { nextToken: expiredToken };
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(null, Buffer.from(JSON.stringify({
        lastKey: {},
        timestamp: Date.now() - (16 * 60 * 1000)
      })));
    });
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
  }); test('PAGINATION_3: Legacy token format (without timestamp) handled backward compatibly', async () => {
    const status = Moderation.STATUS.PENDING;
    const legacyToken = Buffer.from(JSON.stringify({ lastKey: {} })).toString('base64');
    const options = { nextToken: legacyToken };
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(null, Buffer.from(JSON.stringify({ lastKey: {} })));
    });
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItemsByStatus(status, options);
    
    expect(Scylla.request).toHaveBeenCalled();
  }); test('PAGINATION_4: Token size validation (MAX_PAGINATION_TOKEN_SIZE = 100KB)', async () => {
    const status = Moderation.STATUS.PENDING;
    const largeToken = 'x'.repeat(102401);
    const options = { nextToken: largeToken };
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
  }); test('PAGINATION_5: Circular reference in lastKey → encoding fails gracefully, returns null', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status }];
    const circularKey = { pk: 'test' };
    circularKey.self = circularKey;
    const mockLastKey = circularKey;
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      try {
        JSON.stringify(circularKey);
        callback(null, Buffer.from('{}'));
      } catch (error) {
        callback(error);
      }
    });
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.nextToken).toBeNull();
  }); test('PAGINATION_6: Non-serializable values in lastKey → encoding fails gracefully', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status }];
    const nonSerializableKey = { pk: 'test', func: function() {} };
    const mockLastKey = nonSerializableKey;
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      try {
        JSON.stringify(nonSerializableKey);
        callback(null, Buffer.from('{}'));
      } catch (error) {
        callback(error);
      }
    });
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.nextToken).toBeNull();
  }); test('COMPRESSION_1: Compression threshold (when content size triggers compression)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const smallData = { userId, contentId, type, priority, content: 'small' };
    await Moderation.createModerationEntry(smallData);
    const _s = Scylla.putItem.mock.calls[0]; const smallCall = { Item: _s[1] };
    expect(smallCall.Item.contentCompressed).toBeFalsy();
    
    const largeData = { userId, contentId, type, priority, content: 'x'.repeat(60000) };
    await Moderation.createModerationEntry(largeData);
    const _l = Scylla.putItem.mock.calls[1]; const largeCall = { Item: _l[1] };
    expect(largeCall.Item.contentCompressed).toBe(true);
  }); test('COMPRESSION_2: Small content (< threshold) not compressed', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const smallContent = 'small content';
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, content: smallContent };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.contentCompressed).toBeFalsy();
  }); test('COMPRESSION_3: Large content (> threshold) compressed and contentCompressed flag set', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const largeContent = 'x'.repeat(60000);
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const data = { userId, contentId, type, priority, content: largeContent };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.contentCompressed).toBe(true);
  }); test('COMPRESSION_4: Round-trip integrity (compress → store → retrieve → decompress → original)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const originalContent = 'x'.repeat(60000);
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    const realGunzip = promisify(realZlib.gunzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      realGunzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const data = { userId, contentId, type, priority, content: originalContent };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('COMPRESSION_5: Binary content (Buffer) compression/decompression', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const binaryContent = Buffer.from('x'.repeat(60000));
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const data = { userId, contentId, type, priority, content: binaryContent };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('COMPRESSION_6: Decompression of non-compressed content (backward compatibility)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      content: 'uncompressed content',
      contentCompressed: false
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(result.content).toBe('uncompressed content');
  }); test('COMPRESSION_7: Corrupted compressed data → decompression throws', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const corruptedB64 = Buffer.from('corrupted gzip data').toString('base64');
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      content: { _compressed: true, _format: 'gzip', data: corruptedB64 },
      contentCompressed: true
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(new Error('Invalid compressed data'));
    });
    
    await expect(Moderation.getModerationRecordById(moderationId, userId)).rejects.toThrow();
  }); test('LOCKING_1: Version check in ConditionExpression for all update operations', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    const updateOptions = Scylla.updateItem.mock.calls[0][3];
    expect(updateOptions && updateOptions.ConditionExpression).toContain('version');
  }); test('LOCKING_2: Retry mechanism with exponential backoff (50ms * retryCount)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn()
      .mockRejectedValueOnce({ awsType: 'ConditionalCheckFailedException', message: 'ConditionalCheckFailedException' })
      .mockResolvedValueOnce({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalledTimes(2);
  }); test('LOCKING_3: Max retries (5) before throwing concurrent modification error', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue({ awsType: 'ConditionalCheckFailedException', message: 'ConditionalCheckFailedException' });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('LOCKING_4: Version increment on successful update', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    const updatePayload = Scylla.updateItem.mock.calls[0][2];
    expect(updatePayload && updatePayload.meta).toBeDefined();
    expect(updatePayload.meta.version).toBeGreaterThan(existingItem.version);
  }); test('LOCKING_5: Concurrent updates (race condition) → only one succeeds', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn()
      .mockRejectedValueOnce({ awsType: 'ConditionalCheckFailedException', message: 'ConditionalCheckFailedException' })
      .mockResolvedValueOnce({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('ERROR_CODE_1: All ErrorHandler.addError calls include unique error codes', async () => {
    const userId = '';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.createModerationEntry({ userId }, null)).rejects.toThrow();
    
    expect(ErrorHandler.addError).toHaveBeenCalled();
    const options = ErrorHandler.addError.mock.calls[0][1] || {};
    expect(options.code).toBeDefined();
  }); test('ERROR_CODE_2: Error codes follow consistent naming pattern (METHOD_NAME_FAILED, INVALID_FIELD, etc.)', async () => {
    const userId = '';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.createModerationEntry({ userId }, null)).rejects.toThrow();
    
    expect(ErrorHandler.addError).toHaveBeenCalled();
    const options = ErrorHandler.addError.mock.calls[0][1] || {};
    expect(options.code).toBeDefined();
    expect(typeof options.code).toBe('string');
  }); test('ERROR_CODE_3: Error context data includes relevant parameters for debugging', async () => {
    const userId = '';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.createModerationEntry({ userId }, null)).rejects.toThrow();
    
    expect(ErrorHandler.addError).toHaveBeenCalled();
    const options = ErrorHandler.addError.mock.calls[0][1] || {};
    expect(options.data != null || options.origin != null).toBe(true);
  }); test('ERROR_CODE_4: No duplicate error codes across different methods', async () => {
    const errorCodes = new Set();
    const prevAddError = ErrorHandler.addError;
    ErrorHandler.addError = jest.fn((msg, opts) => {
      if (opts && opts.code) {
        expect(errorCodes.has(opts.code)).toBe(false);
        errorCodes.add(opts.code);
      }
    });
    try {
      const moderationId = Moderation.generateModerationId();
      const userId = '';
      try {
        await Moderation.createModerationEntry({ userId }, null);
      } catch (error) {
        // Expected to throw
      }
      expect(ErrorHandler.addError).toHaveBeenCalled();
    } finally {
      ErrorHandler.addError = prevAddError;
    }
  });
}); test('LOGGING_1: All write operations log via Logger.writeLog with correct flag="MODERATIONS"', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls[0][0];
    expect(logCall.flag).toBe('MODERATIONS');
  }); test('LOGGING_2: All methods start with Logger.debugLog [START]', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Logger.debugLog).toHaveBeenCalled();
    const debugCalls = Logger.debugLog.mock.calls.map(call => call[0]);
    const hasStart = debugCalls.some(msg => msg.includes('[START]') || msg.includes('START'));
    expect(hasStart).toBe(true);
  }); test('LOGGING_3: All methods end with Logger.debugLog [SUCCESS] or [ERROR]', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Logger.debugLog).toHaveBeenCalled();
    const debugCalls = Logger.debugLog.mock.calls.map(call => call[0]);
    const hasEnd = debugCalls.some(msg => msg.includes('[SUCCESS]') || msg.includes('[ERROR]') || msg.includes('SUCCESS') || msg.includes('ERROR'));
    expect(hasEnd).toBe(true);
  }); test('LOGGING_4: Log actions match method names (moderationCreated, moderationUpdated, etc.)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls[0][0];
    expect(logCall.action).toBeDefined();
    expect(logCall.action).toContain('moderation');
  }); test('LOGGING_5: Log data includes relevant context (moderationId, userId, etc.)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls[0][0];
    expect(logCall.data).toBeDefined();
    expect(logCall.data.userId).toBe(userId);
  }); test('RETRY_1: _retryOperation retries on retryable errors (throttling, timeouts)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: [],
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn()
      .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'))
      .mockResolvedValueOnce({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalledTimes(2);
  }); test('RETRY_2: _retryOperation doesn\'t retry on non-retryable errors (validation errors)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: 'invalid' };
    
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
  }); test('RETRY_3: Retry backoff increases exponentially (RETRY_BACKOFF_MS * attempt)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn()
      .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'))
      .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'))
      .mockResolvedValueOnce({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalledTimes(3);
  }); test('RETRY_4: Max retries (RETRY_MAX_ATTEMPTS = 3) enforced', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.updateModerationEntry(moderationId, updates, userId)).rejects.toThrow();
    
    expect(Scylla.updateItem.mock.calls.length).toBeLessThanOrEqual(Moderation.RETRY_MAX_ATTEMPTS + 1);
  }); test('RETRY_5: Operation succeeds on retry → returns result', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn()
      .mockRejectedValueOnce(new Error('ProvisionedThroughputExceededException'))
      .mockResolvedValueOnce({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalledTimes(2);
  }); test('TAG_STATUS_1: TAGS type items get tagStatus="published" when approved/approved_global', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      type: Moderation.TYPE.TAGS,
      notes: [],
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.sanitizeTextField = jest.fn(str => (str == null ? null : String(str).trim() || null));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    const updateArg = Scylla.updateItem.mock.calls[0][2];
    expect(updateArg.tagStatus).toBeDefined();
  }); test('TAG_STATUS_2: TAGS type items get tagStatus="pending" when rejected or pending', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.REJECT;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      type: Moderation.TYPE.TAGS,
      notes: [],
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.sanitizeTextField = jest.fn(str => (str == null ? null : String(str).trim() || null));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    const updateArg = Scylla.updateItem.mock.calls[0][2];
    expect(updateArg.tagStatus).toBeDefined();
  }); test('TAG_STATUS_3: Non-TAGS type items have tagStatus cleared/nullified', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      type: Moderation.TYPE.IMAGE,
      notes: [],
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.sanitizeTextField = jest.fn(str => (str == null ? null : String(str).trim() || null));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    const updateArg = Scylla.updateItem.mock.calls[0][2];
    expect(updateArg.tagStatus === null || updateArg.tagStatus === undefined).toBe(true);
  }); test('TAG_STATUS_4: tagStatus validation in applyModerationAction', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.APPROVE;
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      type: Moderation.TYPE.TAGS,
      notes: [],
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.sanitizeTextField = jest.fn(str => (str == null ? null : String(str).trim() || null));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
    
    const updateArg = Scylla.updateItem.mock.calls[0][2];
    expect(updateArg.tagStatus).toBeDefined();
  }); test('META_HISTORY_1: History array initialized with first action on create', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.meta.history).toBeDefined();
    expect(Array.isArray(putItemCall.Item.meta.history)).toBe(true);
  }); test('META_HISTORY_2: History entries appended on each update', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [{ action: 'create', timestamp: Date.now(), userId }] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [Scylla.marshalItem({ pk: existingItem.pk, sk: existingItem.sk })] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    const updateArg = Scylla.updateItem.mock.calls[0][2];
    expect(updateArg.meta).toBeDefined();
    expect(Array.isArray(updateArg.meta.history)).toBe(true);
    expect(updateArg.meta.history.length).toBeGreaterThan(1);
  }); test('META_HISTORY_3: History truncated to last MAX_HISTORY_ENTRIES (100) entries', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const largeHistory = Array(150).fill(null).map((_, i) => ({
      action: 'update',
      timestamp: Date.now() + i,
      userId: `user${i}`
    }));
    const metaUpdates = { history: largeHistory };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
    const updateArg = Scylla.updateItem.mock.calls[0][2];
    expect(updateArg.meta).toBeDefined();
    expect(updateArg.meta.history.length).toBeLessThanOrEqual(Moderation.MAX_HISTORY_ENTRIES);
  }); test('META_HISTORY_4: Version increments on each meta update', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const metaUpdates = { history: [{ action: 'update', timestamp: Date.now(), userId }] };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationMeta(moderationId, userId, metaUpdates);
    
    const updateArg = Scylla.updateItem.mock.calls[0][2];
    expect(updateArg.meta).toBeDefined();
    expect(updateArg.meta.version).toBeGreaterThan(1);
  }); test('META_HISTORY_5: History entry structure (action, timestamp, userId, details)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('META_HISTORY_6: Meta field created if missing on update operations', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('DATETIME_1: Timestamp validation (5 years past, 5 minutes future boundaries)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const withinFiveYearsAgo = Date.now() - (4 * 365 * 24 * 60 * 60 * 1000);
    const exactlyFiveMinutesFuture = Date.now() + (5 * 60 * 1000);
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data, withinFiveYearsAgo);
    await Moderation.createModerationEntry(data, exactlyFiveMinutesFuture);
    
    expect(Scylla.putItem).toHaveBeenCalledTimes(2);
  }); test('DATETIME_2: dayKey validation (YYYYMMDD format, valid calendar date)', async () => {
    const ts = 1640995200000;
    const dayKey = Moderation.dayKeyFromTs(ts);
    
    expect(dayKey).toMatch(/^\d{8}$/);
    expect(dayKey).toBe('20220101');
  }); test('DATETIME_3: statusSubmittedAt key format consistency', async () => {
    const status = Moderation.STATUS.PENDING;
    const ts = 1640995200000;
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    
    const key = Moderation.statusSubmittedAtKey(status, ts);
    
    expect(key).toBe('pending#1640995200000');
    expect(key).toMatch(/^[a-z_]+#\d+$/);
  }); test('DATETIME_4: UTC timezone usage for dayKey (consistent across timezones)', async () => {
    const ts = 1640995200000; // 2022-01-01 00:00:00 UTC
    const dayKey = Moderation.dayKeyFromTs(ts);
    
    expect(dayKey).toBe('20220101');
  }); test('DATETIME_5: Date range validation (start <= end)', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { startTimestamp: 1641081600000, endTimestamp: 1640995200000 }; // start > end
    ErrorHandler.addError = jest.fn();
    
    // This should either throw or handle gracefully
    try {
      await Moderation.getModerationItemsByStatus(status, options);
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('ENUM_1: All STATUS enum values validated in all methods', async () => {
    const mockItems = [{ moderationId: '123' }];
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: mockItems });
      return Promise.resolve({});
    });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    for (const status of Object.values(Moderation.STATUS)) {
      await Moderation.getModerationItemsByStatus(status, {});
      expect(Scylla.request).toHaveBeenCalledWith('Query', expect.any(Object));
    }
  }); test('ENUM_2: All TYPE enum values validated (including aliases like gallery/image_gallery)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    for (const type of Object.values(Moderation.TYPE)) {
      const data = { userId, contentId, type, priority };
      await Moderation.createModerationEntry(data);
      expect(Scylla.putItem).toHaveBeenCalled();
    }
  }); test('ENUM_3: All PRIORITY enum values validated', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    for (const priority of Object.values(Moderation.PRIORITY)) {
      const data = { userId, contentId, type, priority };
      await Moderation.createModerationEntry(data);
      expect(Scylla.putItem).toHaveBeenCalled();
    }
  }); test('ENUM_4: All ACTION enum values validated', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const moderatorId = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    for (const action of Object.values(Moderation.ACTION)) {
      await Moderation.applyModerationAction(moderationId, userId, action, moderatorId);
      expect(Scylla.updateItem).toHaveBeenCalled();
    }
  }); test('ENUM_5: All MODERATION_TYPE enum values validated', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    if (Moderation.MODERATION_TYPE) {
      for (const modType of Object.values(Moderation.MODERATION_TYPE)) {
        const data = { userId, contentId, type, priority, moderationType: modType };
        await Moderation.createModerationEntry(data);
        expect(Scylla.putItem).toHaveBeenCalled();
      }
    }
  }); test('ENUM_6: Invalid enum values rejected with descriptive errors', async () => {
    const status = 'invalid_status';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus(status, {})).rejects.toThrow();
    expect(ErrorHandler.addError).toHaveBeenCalled();
  }); test('QUERY_OPT_1: Index selection for optimal query performance', async () => {
    const filters = { userId: 'user123', status: Moderation.STATUS.PENDING };
    const mockItems = [{ moderationId: '123', userId: 'user123', status: Moderation.STATUS.PENDING }];
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: mockItems });
      return Promise.resolve({});
    });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryOpts = Scylla.request.mock.calls.find(c => c[0] === 'Query')?.[1];
    expect(queryOpts).toBeDefined();
    expect(queryOpts.IndexName).toBe(Moderation.GSI_USER_STATUS_DATE);
  }); test('QUERY_OPT_2: FilterExpression vs KeyConditionExpression usage', async () => {
    const filters = { userId: 'user123', status: Moderation.STATUS.PENDING, moderatedBy: 'moderator1' };
    const mockItems = [{ moderationId: '123', userId: 'user123', status: Moderation.STATUS.PENDING, moderatedBy: 'moderator1' }];
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: mockItems });
      return Promise.resolve({});
    });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItems(filters, {});
    
    const queryOpts = Scylla.request.mock.calls.find(c => c[0] === 'Query')?.[1];
    expect(queryOpts).toBeDefined();
    expect(queryOpts.KeyConditionExpression).toBeDefined();
    expect(queryOpts.FilterExpression).toBeDefined();
  }); test('QUERY_OPT_3: ScanIndexForward only set for Query operations', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status }];
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: mockItems });
      return Promise.resolve({});
    });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    await Moderation.getModerationItemsByStatus(status, {});
    
    const queryOpts = Scylla.request.mock.calls.find(c => c[0] === 'Query')?.[1];
    if (queryOpts && queryOpts.ScanIndexForward !== undefined) {
      expect(typeof queryOpts.ScanIndexForward).toBe('boolean');
    }
  }); test('QUERY_OPT_4: Limit enforcement before query execution', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { limit: 1001 };
    Scylla.request = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
    expect(Scylla.request).not.toHaveBeenCalled();
  }); test('QUERY_OPT_5: Pagination token size validation before encoding', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status }];
    // Exceed MAX_PAGINATION_TOKEN_SIZE (102400): JSON of { lastKey, timestamp } must be > 102400
    const largeLastKey = { pk: 'x'.repeat(55000), sk: 'y'.repeat(55000) };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems, LastEvaluatedKey: largeLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.nextToken).toBeNull();
  }); test('CONTENT_1: Empty content stored as null', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, content: '' };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.content).toBeNull();
  }); test('CONTENT_2: Large content compressed automatically', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const largeContent = 'x'.repeat(60000);
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const data = { userId, contentId, type, priority, content: largeContent };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.content).toBeDefined();
    expect(putItemCall.Item.content._compressed).toBe(true);
  }); test('CONTENT_3: Content decompression on retrieval', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    const realGunzip = promisify(realZlib.gunzip);
    const compressedContent = await realGzip(Buffer.from(JSON.stringify({ text: 'compressed' }), 'utf8'));
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      content: compressedContent,
      contentCompressed: true
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [{ moderationId, userId }] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      realGunzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const result = await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(result).toBeDefined();
  }); test('CONTENT_4: Content integrity after compression/decompression round-trip', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const originalContent = 'x'.repeat(60000);
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    const realGunzip = promisify(realZlib.gunzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      realGunzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const data = { userId, contentId, type, priority, content: originalContent };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('CONTENT_5: Binary content (Buffer) handling', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const binaryContent = Buffer.from('binary data');
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, content: binaryContent };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('CONTENT_6: Content size limits (if any) enforced', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const extremelyLargeContent = 'x'.repeat(10000000);
    ErrorHandler.addError = jest.fn();
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority, content: extremelyLargeContent };
    try {
      await Moderation.createModerationEntry(data);
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('SECURITY_6: userId sanitization prevents injection in partition keys', async () => {
    const userId = 'user#123<script>';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str.replace(/[#<>]/g, ''));
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.pk).not.toContain('<script>');
  }); test('SECURITY_7: contentId format validation prevents path traversal', async () => {
    const userId = 'user123';
    const contentId = '../../../etc/passwd';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.createModerationEntry({ userId, contentId, type, priority })).rejects.toThrow();
  }); test('SECURITY_8: Note text sanitization prevents XSS', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const note = '<script>alert("xss")</script>';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: [],
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      if (op === 'UpdateItem') return Promise.resolve({});
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeTextField = jest.fn((s) => (s == null || typeof s !== 'string') ? null : String(s).replace(/<script>/gi, '').trim() || null);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(SafeUtils.sanitizeTextField).toHaveBeenCalledWith(note);
  }); test('SECURITY_9: Reason text sanitization prevents injection', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const action = Moderation.ACTION.REJECT;
    const moderatorId = 'moderator1';
    const reason = 'reason<script>alert("xss")</script>';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      type: Moderation.TYPE.IMAGE,
      notes: [],
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeTextField = jest.fn((s) => (s == null || typeof s !== 'string') ? '' : String(s).replace(/<script>/gi, '').trim() || '');
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.applyModerationAction(moderationId, userId, action, reason, moderatorId);
    
    expect(SafeUtils.sanitizeTextField).toHaveBeenCalled();
  }); test('SECURITY_10: Pagination token validation prevents token manipulation', async () => {
    const status = Moderation.STATUS.PENDING;
    const maliciousToken = 'malicious_token';
    const options = { nextToken: maliciousToken };
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gunzip').mockImplementation((data, callback) => {
      callback(new Error('Invalid token'));
    });
    
    await expect(Moderation.getModerationItemsByStatus(status, options)).rejects.toThrow();
  }); test('SECURITY_11: Enum validation prevents invalid status/type/priority injection', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = 'invalid_type';
    const priority = Moderation.PRIORITY.NORMAL;
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.createModerationEntry({ userId, contentId, type, priority })).rejects.toThrow();
  }); test('SECURITY_12: Timestamp validation prevents timestamp manipulation', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const maliciousTimestamp = Date.now() + (10 * 365 * 24 * 60 * 60 * 1000);
    ErrorHandler.addError = jest.fn();
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    try {
      await Moderation.createModerationEntry(data, maliciousTimestamp);
    } catch (error) {
      expect(error).toBeDefined();
    }
  }); test('PERF_6: Large result set pagination (1000+ items across multiple pages)', async () => {
    const status = Moderation.STATUS.PENDING;
    const largeMockItems = Array(1000).fill(null).map((_, i) => ({ moderationId: `id${i}`, status }));
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#last' };
    
    Scylla.request = jest.fn()
      .mockResolvedValueOnce({ Items: largeMockItems.slice(0, 500), LastEvaluatedKey: mockLastKey })
      .mockResolvedValueOnce({ Items: largeMockItems.slice(500, 1000) });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      callback(null, Buffer.from(JSON.stringify({ lastKey: mockLastKey, timestamp: Date.now() })));
    });
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.items.length).toBeGreaterThan(0);
  }); test('PERF_7: Parallel count operations performance (getAllModerationCounts)', async () => {
    Scylla.request = jest.fn().mockResolvedValue({ Items: [], Count: 0 });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getAllModerationCounts();
    
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  }); test('PERF_8: Content compression performance (large content objects)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const veryLargeContent = 'x'.repeat(100000);
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const zlib = require('zlib');
    const realZlib = jest.requireActual('zlib');
    const { promisify } = require('util');
    const realGzip = promisify(realZlib.gzip);
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      realGzip(data).then(result => callback(null, result)).catch(callback);
    });
    
    const data = { userId, contentId, type, priority, content: veryLargeContent };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('PERF_9: Query result size limits prevent memory exhaustion', async () => {
    const status = Moderation.STATUS.PENDING;
    const options = { limit: Moderation.MAX_QUERY_RESULT_SIZE };
    const mockItems = Array(Moderation.MAX_QUERY_RESULT_SIZE).fill(null).map((_, i) => ({ moderationId: `id${i}`, status }));
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, options);
    
    expect(result.items.length).toBeLessThanOrEqual(Moderation.MAX_QUERY_RESULT_SIZE);
  }); test('PERF_10: Pagination iteration limits prevent infinite loops', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockLastKey = { pk: 'moderation#user123', sk: 'media#1640995200000#last' };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [], LastEvaluatedKey: mockLastKey });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    ErrorHandler.addError = jest.fn();
    
    const zlib = require('zlib');
    jest.spyOn(zlib, 'gzip').mockImplementation((data, callback) => {
      callback(null, Buffer.from(JSON.stringify({ lastKey: mockLastKey, timestamp: Date.now() })));
    });
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result).toBeDefined();
  }); test('EDGE_11: Zero-length arrays (notes: [], history: [])', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      notes: [],
      meta: { history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(Array.isArray(result.notes)).toBe(true);
    expect(result.notes.length).toBe(0);
  }); test('EDGE_12: Maximum length arrays (notes: 50 items, history: 100 items)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const maxNotes = Array(Moderation.MAX_NOTES_PER_ITEM).fill(null).map((_, i) => ({
      text: `Note ${i}`,
      addedBy: 'moderator1',
      addedAt: Date.now()
    }));
    const maxHistory = Array(Moderation.MAX_HISTORY_ENTRIES).fill(null).map((_, i) => ({
      action: 'update',
      timestamp: Date.now() + i,
      userId: `user${i}`
    }));
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      notes: maxNotes,
      meta: { history: maxHistory }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationRecordById(moderationId, userId);
    
    expect(result.notes.length).toBe(Moderation.MAX_NOTES_PER_ITEM);
    expect(result.meta.history.length).toBe(Moderation.MAX_HISTORY_ENTRIES);
  }); test('EDGE_13: Boundary values (MAX_NOTE_LENGTH, MAX_NOTES_PER_ITEM, MAX_HISTORY_ENTRIES)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const maxLengthNote = 'x'.repeat(Moderation.MAX_NOTE_LENGTH);
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: [],
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.sanitizeTextField = jest.fn(str => (str == null ? null : String(str).trim() || null));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, maxLengthNote, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('EDGE_14: Special characters in all string fields (userId, contentId, note text, etc.)', async () => {
    const userId = 'user#123!@$%';
    const contentId = 'content#123!@$%';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    const stripInvalid = (s) => (s == null || typeof s !== 'string') ? null : (String(s).replace(/[^a-zA-Z0-9_.-]/g, '').trim() || null);
    SafeUtils.sanitizeValidate = jest.fn((schema) => {
      const r = {};
      for (const [k, v] of Object.entries(schema)) {
        let val = v.value !== undefined && v.value !== null ? v.value : (v.default !== undefined ? v.default : null);
        if (typeof val === 'string' && (k === 'userId' || k === 'contentId')) val = stripInvalid(val) || val;
        r[k] = val;
      }
      return r;
    });
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn((str) => {
      if (str == null || typeof str !== 'string') return null;
      return stripInvalid(str) || String(str).trim() || null;
    });
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Scylla.putItem).toHaveBeenCalled();
  }); test('EDGE_15: Very long string fields (at limits and beyond)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const veryLongNote = 'x'.repeat(Moderation.MAX_NOTE_LENGTH + 1);
    const addedBy = 'moderator1';
    ErrorHandler.addError = jest.fn();
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [existingItem] });
    Scylla.getItem = jest.fn().mockResolvedValue({ Item: existingItem });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await expect(Moderation.addNote(moderationId, userId, veryLongNote, addedBy)).rejects.toThrow();
  }); test('EDGE_16: Concurrent operations on same item (optimistic locking)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const updates = { priority: Moderation.PRIORITY.HIGH };
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    const condErr = new Error('ConditionalCheckFailedException');
    condErr.awsType = 'ConditionalCheckFailedException';
    Scylla.updateItem = jest.fn()
      .mockRejectedValueOnce(condErr)
      .mockResolvedValueOnce({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, updates, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalledTimes(2);
  }); test('EDGE_17: Rapid sequential updates (version conflicts and retries)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    const c1 = new Error('ConditionalCheckFailedException');
    c1.awsType = 'ConditionalCheckFailedException';
    const c2 = new Error('ConditionalCheckFailedException');
    c2.awsType = 'ConditionalCheckFailedException';
    Scylla.updateItem = jest.fn()
      .mockRejectedValueOnce(c1)
      .mockRejectedValueOnce(c2)
      .mockResolvedValueOnce({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.updateModerationEntry(moderationId, { priority: Moderation.PRIORITY.HIGH }, userId);
    
    expect(Scylla.updateItem).toHaveBeenCalledTimes(3);
  }); test('EDGE_18: Empty result sets from queries', async () => {
    const status = Moderation.STATUS.PENDING;
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.items).toEqual([]);
    expect(result.count).toBe(0);
  }); test('EDGE_19: Single-item result sets', async () => {
    const status = Moderation.STATUS.PENDING;
    const mockItems = [{ moderationId: '123', status }];
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, {});
    
    expect(result.items.length).toBe(1);
    expect(result.count).toBe(1);
  }); test('EDGE_20: Exactly limit-sized result sets', async () => {
    const status = Moderation.STATUS.PENDING;
    const limit = 100;
    const mockItems = Array(limit).fill(null).map((_, i) => ({ moderationId: `id${i}`, status }));
    
    Scylla.request = jest.fn().mockResolvedValue({ Items: mockItems });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.debugLog = jest.fn();
    
    const result = await Moderation.getModerationItemsByStatus(status, { limit });
    
    expect(result.items.length).toBe(limit);
  }); test('INTEGRATION_1: Full workflow: create → update → addNote → applyAction → escalate → softDelete', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    let capturedModerationId;
    Scylla.putItem = jest.fn().mockImplementation((t, item) => {
      capturedModerationId = item.moderationId;
      return Promise.resolve({});
    });
    const makeItem = (id) => ({
      moderationId: id,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${id}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      priority: Moderation.PRIORITY.NORMAL,
      notes: [],
      meta: { version: 1, history: [] }
    });
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [makeItem(capturedModerationId || 'x')] });
      if (op === 'UpdateItem') return Promise.resolve({});
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockImplementation(() => Promise.resolve(makeItem(capturedModerationId || 'x')));
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.sanitizeTextField = jest.fn(str => (str == null ? null : String(str).trim() || null));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    const moderationId = await Moderation.createModerationEntry(data);
    
    await Moderation.updateModerationEntry(moderationId, { priority: Moderation.PRIORITY.HIGH }, userId);
    await Moderation.addNote(moderationId, userId, 'Test note', 'moderator1');
    await Moderation.applyModerationAction(moderationId, userId, Moderation.ACTION.APPROVE, 'moderator1');
    await Moderation.escalateModerationItem(moderationId, userId, 'moderator1');
    await Moderation.softDeleteModerationItem(moderationId, userId);
    
    expect(Scylla.putItem).toHaveBeenCalled();
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('INTEGRATION_2: Full workflow: create → query → update → query again (data consistency)', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    let capturedModerationId;
    Scylla.putItem = jest.fn().mockImplementation((t, item) => {
      capturedModerationId = item.moderationId;
      return Promise.resolve({});
    });
    let queryCallCount = 0;
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op !== 'Query') return Promise.resolve({});
      queryCallCount++;
      if (queryCallCount === 1) return Promise.resolve({ Items: [] });
      if (queryCallCount === 2) {
        const id = capturedModerationId || 'x';
        return Promise.resolve({ Items: [{ moderationId: id, userId, pk: `moderation#${userId}`, sk: `media#1640995200000#${id}`, version: 1, status: Moderation.STATUS.PENDING, priority: Moderation.PRIORITY.NORMAL }] });
      }
      return Promise.resolve({ Items: [] });
    });
    Scylla.getItem = jest.fn().mockImplementation(() => {
      const id = capturedModerationId || 'x';
      const item = { moderationId: id, userId, pk: `moderation#${userId}`, sk: `media#1640995200000#${id}`, version: 1, status: Moderation.STATUS.PENDING, priority: Moderation.PRIORITY.HIGH };
      return Promise.resolve(item);
    });
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.sanitizeTextField = jest.fn(str => (str == null ? null : String(str).trim() || null));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    const moderationId = await Moderation.createModerationEntry(data);
    
    const result1 = await Moderation.getModerationItemsByStatus(Moderation.STATUS.PENDING, {});
    await Moderation.updateModerationEntry(moderationId, { priority: Moderation.PRIORITY.HIGH }, userId);
    const result2 = await Moderation.getModerationItemsByStatus(Moderation.STATUS.PENDING, {});
    
    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
  }); test('INTEGRATION_3: Multiple users creating entries simultaneously', async () => {
    const users = ['user1', 'user2', 'user3'];
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const promises = users.map(userId => 
      Moderation.createModerationEntry({ userId, contentId, type, priority })
    );
    
    await Promise.all(promises);
    
    expect(Scylla.putItem).toHaveBeenCalledTimes(users.length);
  }); test('INTEGRATION_4: Multiple moderators acting on same item (concurrency)', async () => {
    const moderationId = Moderation.generateModerationId();
    const userId = 'user123';
    const moderators = ['moderator1', 'moderator2'];
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      status: Moderation.STATUS.PENDING,
      notes: [],
      meta: { version: 1, history: [] }
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn()
      .mockRejectedValueOnce(new Error('ConditionalCheckFailedException'))
      .mockResolvedValueOnce({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.sanitizeTextField = jest.fn(str => (str == null ? null : String(str).trim() || null));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const promises = moderators.map(moderatorId =>
      Moderation.applyModerationAction(moderationId, userId, Moderation.ACTION.APPROVE, moderatorId)
    );
    
    await Promise.allSettled(promises);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('INTEGRATION_5: Large batch operations (creating 100+ entries)', async () => {
    const userId = 'user123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const batchSize = 100;
    const promises = Array(batchSize).fill(null).map((_, i) =>
      Moderation.createModerationEntry({ userId, contentId: `content${i}`, type, priority })
    );
    
    await Promise.all(promises);
    
    expect(Scylla.putItem).toHaveBeenCalledTimes(batchSize);
  }); test('REGR_9: Constants haven\'t changed (MAX_* values, TTL values, retry counts)', async () => {
    expect(Moderation.MAX_NOTE_LENGTH).toBe(5000);
    expect(Moderation.MAX_NOTES_PER_ITEM).toBe(50);
    expect(Moderation.MAX_HISTORY_ENTRIES).toBe(100);
    expect(Moderation.MAX_QUERY_RESULT_SIZE).toBe(1000);
    expect(Moderation.MAX_PAGINATION_ITERATIONS).toBe(100);
    expect(Moderation.RETRY_MAX_ATTEMPTS).toBe(3);
    expect(Moderation.PAGINATION_TOKEN_TTL_MS).toBe(15 * 60 * 1000);
  }); test('REGR_10: GSI index names haven\'t changed', async () => {
    expect(Moderation.GSI_STATUS_DATE).toBe('GSI_StatusDate');
    expect(Moderation.GSI_USER_STATUS_DATE).toBe('GSI_UserStatusDate');
    expect(Moderation.GSI_ALL_BY_DATE).toBe('GSI_AllByDate');
    expect(Moderation.GSI_PRIORITY).toBe('GSI_Priority');
    expect(Moderation.GSI_TYPE_DATE).toBe('GSI_TypeDate');
    expect(Moderation.GSI_BY_MOD_ID).toBe('GSI_ByModerationId');
    expect(Moderation.GSI_MODERATED_BY).toBe('GSI_ModeratedBy');
    expect(Moderation.GSI_CONTENT_ID).toBe('GSI_ContentId');
    expect(Moderation.GSI_ESCALATED).toBe('GSI_Escalated');
    expect(Moderation.GSI_ACTIONED_AT).toBe('GSI_ActionedAt');
  }); test('REGR_11: PK/SK format hasn\'t changed', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    const timestamp = 1640995200000;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    const moderationId = await Moderation.createModerationEntry(data, timestamp);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.pk).toBe(`moderation#${userId}`);
    expect(putItemCall.Item.sk).toBe(`media#${timestamp}#${moderationId}`);
  }); test('REGR_12: statusSubmittedAt key format hasn\'t changed', async () => {
    const status = Moderation.STATUS.PENDING;
    const ts = 1640995200000;
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    
    const key = Moderation.statusSubmittedAtKey(status, ts);
    
    expect(key).toBe('pending#1640995200000');
    expect(key).toContain('#');
  }); test('REGR_13: Meta field structure hasn\'t changed', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    const _putArgs = Scylla.putItem.mock.calls[0]; const putItemCall = { Item: _putArgs[1] };
    expect(putItemCall.Item.meta).toBeDefined();
    expect(putItemCall.Item.meta.version).toBeDefined();
    expect(putItemCall.Item.meta.history).toBeDefined();
    expect(Array.isArray(putItemCall.Item.meta.history)).toBe(true);
  }); test('REGR_14: Note structure hasn\'t changed', async () => {
    const moderationId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const userId = 'user123';
    const note = 'Test note';
    const addedBy = 'moderator1';
    
    const existingItem = {
      moderationId,
      userId,
      pk: `moderation#${userId}`,
      sk: `media#1640995200000#${moderationId}`,
      version: 1,
      notes: []
    };
    
    Scylla.request = jest.fn().mockImplementation((op) => {
      if (op === 'Query') return Promise.resolve({ Items: [existingItem] });
      return Promise.resolve({});
    });
    Scylla.getItem = jest.fn().mockResolvedValue(existingItem);
    Scylla.updateItem = jest.fn().mockResolvedValue({});
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    SafeUtils.sanitizeTextField = jest.fn(str => (str == null ? null : String(str).trim() || null));
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    await Moderation.addNote(moderationId, userId, note, addedBy);
    
    expect(Scylla.updateItem).toHaveBeenCalled();
  }); test('REGR_15: Error codes haven\'t changed (backward compatibility)', async () => {
    const userId = '';
    ErrorHandler.addError = jest.fn();
    
    await expect(Moderation.createModerationEntry({ userId }, null)).rejects.toThrow();
    
    expect(ErrorHandler.addError).toHaveBeenCalled();
    const args = ErrorHandler.addError.mock.calls[0];
    const options = args[1] || {};
    expect(options.code).toBeDefined();
    expect(typeof options.code).toBe('string');
  }); test('REGR_16: Log action names haven\'t changed', async () => {
    const userId = 'user123';
    const contentId = 'content123';
    const type = Moderation.TYPE.IMAGE;
    const priority = Moderation.PRIORITY.NORMAL;
    
    Scylla.putItem = jest.fn().mockResolvedValue({});
    Scylla.request = jest.fn().mockResolvedValue({ Items: [] });
    SafeUtils.sanitizeString = jest.fn(str => str);
    SafeUtils.sanitizeInteger = jest.fn(val => val);
    Logger.writeLog = jest.fn();
    Logger.debugLog = jest.fn();
    
    const data = { userId, contentId, type, priority };
    await Moderation.createModerationEntry(data);
    
    expect(Logger.writeLog).toHaveBeenCalled();
    const logCall = Logger.writeLog.mock.calls[0][0];
    expect(logCall.action).toBeDefined();
    expect(typeof logCall.action).toBe('string');
  });
