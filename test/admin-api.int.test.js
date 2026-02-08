/**
 * Integration tests for Admin API – real-world scenarios.
 * Requires NODE_ENV=test and ScyllaDB running (e.g. docker compose up -d).
 * Run scripts/seed-admin-data.js first for full coverage (filtering, pagination, drilldown).
 */

process.env.NODE_ENV = 'test';

const app = require('../admin-server');
const ScyllaDb = require('../modules/tokenRegistry/src/utils/ScyllaDb');

let server;
let baseUrl;
const useExternalApi = Boolean(process.env.ADMIN_API_URL);

beforeAll((done) => {
  if (useExternalApi) {
    baseUrl = process.env.ADMIN_API_URL.replace(/\/$/, '');
    done();
  } else {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  }
});

afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    await ScyllaDb.close();
  }
});

async function get(path) {
  return fetch(`${baseUrl}${path}`);
}

async function getJson(path) {
  const res = await get(path);
  const body = await res.json();
  return { res, body };
}

// --- Token Registry: shape & basics ---

describe('Token Registry – response shape & basics', () => {
  test('GET /token-registry returns items, nextToken, total with correct item shape', async () => {
    const { res, body } = await getJson('/token-registry');
    expect(res.status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.nextToken === null || typeof body.nextToken === 'string').toBe(true);
    body.items.forEach((item) => {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('created');
      expect(item).toHaveProperty('state');
      expect(item).toHaveProperty('type');
      expect(item).toHaveProperty('amount');
      expect(item).toHaveProperty('payeeId');
      expect(item).toHaveProperty('beneficiaryId');
      expect(item).toHaveProperty('purpose');
      expect(item.metadata).toHaveProperty('rawPayload');
      expect(typeof item.amount).toBe('number');
    });
  });

  test('GET /token-registry – metadata.rawPayload has full-table fields for View modal', async () => {
    const { res, body } = await getJson('/token-registry?limit=5');
    expect(res.status).toBe(200);
    if (body.items.length > 0) {
      const raw = body.items[0].metadata.rawPayload;
      expect(raw).toHaveProperty('id');
      expect(raw).toHaveProperty('userId');
      expect(raw).toHaveProperty('beneficiaryId');
      expect(raw).toHaveProperty('amount');
      expect(raw).toHaveProperty('createdAt');
      expect(raw).toHaveProperty('state');
      expect(raw).toHaveProperty('transactionType');
    }
  });

  test('GET /token-registry/count returns total (same filters as list)', async () => {
    const { res, body } = await getJson('/token-registry/count');
    expect(res.status).toBe(200);
    expect(typeof body.total).toBe('number');
  });

  test('Empty filter result returns items [], total 0, nextToken null', async () => {
    const { res, body } = await getJson('/token-registry?payee=nonexistent_user_xyz_999');
    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.nextToken).toBeNull();
  });
});

// --- Token Registry: filtering consistency (list vs count) ---

describe('Token Registry – filtering consistency (list vs count)', () => {
  test('state=held: list only held items; count total equals list total', async () => {
    const [listRes, countRes] = await Promise.all([
      getJson('/token-registry?state=held'),
      getJson('/token-registry/count?state=held'),
    ]);
    expect(listRes.res.status).toBe(200);
    expect(countRes.res.status).toBe(200);
    listRes.body.items.forEach((item) => expect(item.state).toBe('held'));
    expect(countRes.body.total).toBe(listRes.body.total);
    expect(listRes.body.items.length).toBeLessThanOrEqual(listRes.body.total);
  });

  test('type=transfer: list only transfer items; count total equals list total', async () => {
    const [listRes, countRes] = await Promise.all([
      getJson('/token-registry?type=transfer'),
      getJson('/token-registry/count?type=transfer'),
    ]);
    expect(listRes.res.status).toBe(200);
    expect(countRes.res.status).toBe(200);
    listRes.body.items.forEach((item) => expect(item.type).toBe('transfer'));
    expect(countRes.body.total).toBe(listRes.body.total);
  });

  test('payee filter: list only payeeId match; count matches list total', async () => {
    const payee = 'user_1001';
    const [listRes, countRes] = await Promise.all([
      getJson(`/token-registry?payee=${payee}`),
      getJson(`/token-registry/count?payee=${payee}`),
    ]);
    expect(listRes.res.status).toBe(200);
    expect(countRes.res.status).toBe(200);
    listRes.body.items.forEach((item) => expect(item.payeeId).toBe(payee));
    expect(countRes.body.total).toBe(listRes.body.total);
  });

  test('beneficiary filter: list only beneficiaryId match; count matches list total', async () => {
    const beneficiary = 'user_2001';
    const [listRes, countRes] = await Promise.all([
      getJson(`/token-registry?beneficiary=${beneficiary}`),
      getJson(`/token-registry/count?beneficiary=${beneficiary}`),
    ]);
    expect(listRes.res.status).toBe(200);
    expect(countRes.res.status).toBe(200);
    listRes.body.items.forEach((item) => expect(item.beneficiaryId).toBe(beneficiary));
    expect(countRes.body.total).toBe(listRes.body.total);
  });
});

// --- Token Registry: date range ---

describe('Token Registry – date range filtering', () => {
  test('from and to (ISO 8601): list and count use same range; items in range', async () => {
    const from = '2020-01-01T00:00:00Z';
    const to = '2030-12-31T23:59:59Z';
    const [listRes, countRes] = await Promise.all([
      getJson(`/token-registry?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=50`),
      getJson(`/token-registry/count?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    ]);
    expect(listRes.res.status).toBe(200);
    expect(countRes.res.status).toBe(200);
    expect(countRes.body.total).toBe(listRes.body.total);
    const fromTs = new Date(from).getTime();
    const toTs = new Date(to).getTime();
    listRes.body.items.forEach((item) => {
      const createdTs = new Date(item.created).getTime();
      expect(createdTs).toBeGreaterThanOrEqual(fromTs);
      expect(createdTs).toBeLessThanOrEqual(toTs);
    });
  });

  test('invalid from returns 400', async () => {
    const res = await get('/token-registry?from=not-a-date');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.message).toMatch(/from|ISO|date/i);
  });

  test('invalid to returns 400', async () => {
    const res = await get('/token-registry?to=invalid');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.message).toMatch(/to|ISO|date/i);
  });
});

// --- Token Registry: pagination ---

describe('Token Registry – pagination (nextToken)', () => {
  test('limit respected; nextToken null when no more data', async () => {
    const { res, body } = await getJson('/token-registry?limit=5');
    expect(res.status).toBe(200);
    expect(body.items.length).toBeLessThanOrEqual(5);
    if (body.total <= 5) {
      expect(body.nextToken).toBeNull();
    } else {
      expect(typeof body.nextToken).toBe('string');
    }
  });

  test('second page with nextToken returns disjoint ids; combined count ≤ total', async () => {
    const { body: page1 } = await getJson('/token-registry?limit=3');
    if (page1.total <= 3 || !page1.nextToken) {
      return; // not enough data for two pages
    }
    const { res: res2, body: page2 } = await getJson(`/token-registry?limit=3&nextToken=${encodeURIComponent(page1.nextToken)}`);
    expect(res2.status).toBe(200);
    const ids1 = new Set(page1.items.map((i) => i.id));
    page2.items.forEach((item) => {
      expect(ids1.has(item.id)).toBe(false);
    });
    expect(page1.items.length + page2.items.length).toBeLessThanOrEqual(page1.total);
  });

  test('invalid limit (0) returns 400', async () => {
    const res = await get('/token-registry?limit=0');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.message).toMatch(/limit/i);
  });

  test('invalid limit (1001) returns 400', async () => {
    const res = await get('/token-registry?limit=1001');
    expect(res.status).toBe(400);
  });
});

// --- Token Registry: get by id & 404 ---

describe('Token Registry – get by id', () => {
  test('GET /token-registry/:id returns same shape as list item when found', async () => {
    const { body: listBody } = await getJson('/token-registry?limit=1');
    if (listBody.items.length === 0) return;
    const id = listBody.items[0].id;
    const { res, body } = await getJson(`/token-registry/${encodeURIComponent(id)}`);
    expect(res.status).toBe(200);
    expect(body.id).toBe(id);
    expect(body).toHaveProperty('created');
    expect(body).toHaveProperty('state');
    expect(body).toHaveProperty('type');
    expect(body).toHaveProperty('amount');
    expect(body).toHaveProperty('payeeId');
    expect(body).toHaveProperty('beneficiaryId');
    expect(body.metadata).toHaveProperty('rawPayload');
  });

  test('GET /token-registry/:id returns 404 for non-existent id', async () => {
    const res = await get('/token-registry/nonexistent-id-99999');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.status).toBe(404);
  });
});

// --- User Tokens: shape & consistency ---

describe('User Tokens – response shape & list/count consistency', () => {
  test('GET /user-tokens returns items, nextToken, total with correct item shape', async () => {
    const { res, body } = await getJson('/user-tokens');
    expect(res.status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.nextToken === null || typeof body.nextToken === 'string').toBe(true);
    body.items.forEach((item) => {
      expect(item).toHaveProperty('userId');
      expect(item).toHaveProperty('paidBalance');
      expect(item).toHaveProperty('freeSystemBalance');
      expect(item).toHaveProperty('freeCreatorBalance');
      expect(item).toHaveProperty('expiry');
      expect(typeof item.paidBalance).toBe('number');
      expect(typeof item.freeSystemBalance).toBe('number');
      expect(typeof item.freeCreatorBalance).toBe('number');
    });
  });

  test('GET /user-tokens/count total equals list total (no filter)', async () => {
    const listRes = await getJson('/user-tokens');
    const countRes = await getJson('/user-tokens/count');
    expect(listRes.res.status).toBe(200);
    expect(countRes.res.status).toBe(200);
    expect(typeof listRes.body.total).toBe('number');
    expect(typeof countRes.body.total).toBe('number');
    expect(countRes.body.total).toBe(listRes.body.total);
  });

  test('userId filter: list and count return same total (0 or 1)', async () => {
    const userId = 'user_1001';
    const [listRes, countRes] = await Promise.all([
      getJson(`/user-tokens?userId=${userId}`),
      getJson(`/user-tokens/count?userId=${userId}`),
    ]);
    expect(listRes.res.status).toBe(200);
    expect(countRes.res.status).toBe(200);
    expect(countRes.body.total).toBe(listRes.body.total);
    listRes.body.items.forEach((item) => expect(item.userId).toBe(userId));
  });

  test('invalid limit (0) returns 400', async () => {
    const res = await get('/user-tokens?limit=0');
    expect(res.status).toBe(400);
  });
});

// --- User Tokens: pagination ---

describe('User Tokens – pagination', () => {
  test('limit respected; nextToken null when no more users', async () => {
    const { res, body } = await getJson('/user-tokens?limit=5');
    expect(res.status).toBe(200);
    expect(body.items.length).toBeLessThanOrEqual(5);
    if (body.total <= 5) expect(body.nextToken).toBeNull();
    else expect(typeof body.nextToken).toBe('string');
  });

  test('second page with nextToken has disjoint userIds', async () => {
    const { body: page1 } = await getJson('/user-tokens?limit=2');
    if (page1.total <= 2 || !page1.nextToken) return;
    const { res: res2, body: page2 } = await getJson(`/user-tokens?limit=2&nextToken=${encodeURIComponent(page1.nextToken)}`);
    expect(res2.status).toBe(200);
    const userIds1 = new Set(page1.items.map((i) => i.userId));
    page2.items.forEach((item) => {
      expect(userIds1.has(item.userId)).toBe(false);
    });
  });
});

// --- Creator Free Tokens ---

describe('Creator Free Tokens – raw grants', () => {
  test('GET /user-tokens/creator-free-tokens returns array; each grant has creatorId, balance, expiry', async () => {
    const { res, body } = await getJson('/user-tokens/creator-free-tokens');
    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    body.forEach((grant) => {
      expect(grant).toHaveProperty('creatorId');
      expect(grant).toHaveProperty('balance');
      expect(grant).toHaveProperty('expiry');
      expect(typeof grant.balance).toBe('number');
    });
  });

  test('creatorId filter returns only that creator', async () => {
    const { body: all } = await getJson('/user-tokens/creator-free-tokens');
    const creators = [...new Set(all.map((g) => g.creatorId))];
    if (creators.length === 0) return;
    const creatorId = creators[0];
    const { res, body } = await getJson(`/user-tokens/creator-free-tokens?creatorId=${encodeURIComponent(creatorId)}`);
    expect(res.status).toBe(200);
    body.forEach((g) => expect(g.creatorId).toBe(creatorId));
  });
});

// --- Drilldown (User Tokens → Token Registry) ---

describe('Drilldown – payee and beneficiary', () => {
  test('Drilldown as payee: list and count with payee=userId only return rows where payeeId=userId', async () => {
    const userId = 'user_1001';
    const [listRes, countRes] = await Promise.all([
      getJson(`/token-registry?payee=${userId}&limit=100`),
      getJson(`/token-registry/count?payee=${userId}`),
    ]);
    expect(listRes.res.status).toBe(200);
    expect(countRes.res.status).toBe(200);
    listRes.body.items.forEach((item) => expect(item.payeeId).toBe(userId));
    expect(countRes.body.total).toBe(listRes.body.total);
  });

  test('Drilldown as beneficiary: list and count with beneficiary=userId only return rows where beneficiaryId=userId', async () => {
    const userId = 'user_2001';
    const [listRes, countRes] = await Promise.all([
      getJson(`/token-registry?beneficiary=${userId}&limit=100`),
      getJson(`/token-registry/count?beneficiary=${userId}`),
    ]);
    expect(listRes.res.status).toBe(200);
    expect(countRes.res.status).toBe(200);
    listRes.body.items.forEach((item) => expect(item.beneficiaryId).toBe(userId));
    expect(countRes.body.total).toBe(listRes.body.total);
  });
});
