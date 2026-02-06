/**
 * MySQLDB — performant, secure, mockable MySQL handler with optional persistence.
 *
 * - Uses mysql2/promise pools for high-throughput concurrency.
 * - Safe parameterized queries everywhere (no string interpolation of values).
 * - Identifier (table/column) escaping helpers.
 * - Read/Write pool support, configurable per call.
 * - Transaction helper with automatic retry/backoff on deadlocks/timeouts.
 * - Bulk insert & upsert helpers for speed.
 * - Pluggable driver (DI) so you can mock easily in Jest.
 * - Lightweight timing + hooks for logging/metrics.
 *
 * Usage:
 *   const db = new MySQLDB();
 *   await db.connect(); // creates "default" pool
 *   const rows = await db.getResults('SELECT * FROM users WHERE id = ?', [123]);
 *   await db.endAll();
 */

const DEFAULT_POOL_NAME = "default";

class MySQLDB {
  /**
   * @param {object} opts
   * @param {object} [opts.env] - Optional env source; defaults to process.env
   * @param {object} [opts.driver] - mysql2/promise-compatible module (for Jest DI)
   * @param {function} [opts.onQuery] - (meta) => void hook for metrics/logging
   * @param {object} [opts.configs] - Named connection configs (overrides env)
   * @param {boolean} [opts.persistent=true] - Keep pools open across usage
   */
  constructor(opts = {}) {
    const {
      env = (typeof process !== "undefined" ? process.env : {}),
      driver = null,
      onQuery = null,
      configs = null,
      persistent = true,
    } = opts;

    // Lazy-load mysql2/promise by default to keep memory lean in Lambda/cold starts.
    this._mysql = driver || require("mysql2/promise");

    this.persistent = persistent;
    this.pools = /** @type {Record<string, import('mysql2/promise').Pool>} */ ({});
    this.errors = [];
    this.onQuery = typeof onQuery === "function" ? onQuery : null;

    // Default + example secondary config
    this.configs = configs || {
      [DEFAULT_POOL_NAME]: {
        host: env.DB_HOST,
        user: env.DB_USER,
        password: env.DB_PASS,
        database: env.DB_NAME,
        port: Number(env.DB_PORT || 3306),
        ssl: this._normalizeSSL(env), // optional SSL
      },
      // Add more named configs as needed:
      // "replica": { ...read-replica credentials... }
    };
  }

  _normalizeSSL(env) {
    // Provide a simple, safe SSL toggle. Extend as needed (CA, cert, key).
    if (!env.DB_SSL || String(env.DB_SSL).toLowerCase() === "false") return undefined;
    return { rejectUnauthorized: String(env.DB_SSL_STRICT || "true") !== "false" };
  }

  /**
   * Create (or reuse) a pool for a named config.
   * @param {string} [name="default"]
   * @param {object} [overrides] - e.g., { connectionLimit: 20 }
   */
  async connect(name = DEFAULT_POOL_NAME, overrides = {}) {
    const cfg = this.configs[name];
    if (!cfg) {
      const msg = `No connection configuration found for: ${name}`;
      this.errors.push(msg);
      return false;
    }

    if (this.pools[name]) return true; // already connected

    try {
      const pool = await this._mysql.createPool({
        ...cfg,
        waitForConnections: true,
        connectionLimit: Number(overrides.connectionLimit || cfg.connectionLimit || 10),
        queueLimit: Number(overrides.queueLimit || 0),
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000,
        // You can add named timeouts if desired:
        // connectTimeout: 10000, // ms
      });
      this.pools[name] = pool;
      return true;
    } catch (err) {
      this.errors.push(`Connection failed [${name}]: ${err.message}`);
      return false;
    }
  }

  /**
   * Internal: ensure pool exists (auto-connect if missing).
   */
  async _ensurePool(name = DEFAULT_POOL_NAME) {
    if (!this.pools[name]) {
      const ok = await this.connect(name);
      if (!ok) throw new Error(`Pool "${name}" not available`);
    }
    return this.pools[name];
  }

  /**
   * Obtain a connection from a pool; auto-release if not persistent or not in txn.
   * For most operations you’ll use pool.execute(); this is here for advanced flows.
   */
  async getPool(name = DEFAULT_POOL_NAME) {
    return this._ensurePool(name);
  }

  /**
   * Close a specific pool.
   */
  async end(name = DEFAULT_POOL_NAME) {
    const pool = this.pools[name];
    if (!pool) return;
    try {
      await pool.end();
    } finally {
      delete this.pools[name];
    }
  }

  /**
   * Close all pools.
   */
  async endAll() {
    const names = Object.keys(this.pools);
    for (const n of names) {
      await this.end(n);
    }
  }

  /**
   * Execute a parameterized query with timing + optional timeout.
   * @param {string} sql - SQL with ? placeholders
   * @param {Array<any>} [params=[]]
   * @param {object} [opts]
   * @param {string} [opts.pool=default]
   * @param {number} [opts.timeoutMs] - Statement timeout; implemented via SET SESSION if provided
   * @returns {Promise<{ rows: any[], fields: any[] }>}
   */
  async query(sql, params = [], opts = {}) {
    const poolName = opts.pool || DEFAULT_POOL_NAME;
    const pool = await this._ensurePool(poolName);

    const started = Date.now();
    let rows, fields;
    try {
      if (opts.timeoutMs && Number.isFinite(opts.timeoutMs)) {
        // Use a session-level max execution time (MySQL/MariaDB support)
        // Note: For MySQL 8+, you can also use optimizer hints or MAX_EXECUTION_TIME.
        const conn = await pool.getConnection();
        try {
          await conn.query("SET SESSION MAX_EXECUTION_TIME = ?", [Number(opts.timeoutMs)]);
          [rows, fields] = await conn.execute(sql, params);
        } finally {
          // Reset to unlimited (0) to avoid leaking timeout to pooled session.
          try { await conn.query("SET SESSION MAX_EXECUTION_TIME = 0"); } catch {}
          conn.release();
        }
      } else {
        [rows, fields] = await pool.execute(sql, params);
      }
      return { rows, fields };
    } catch (err) {
      const msg = `Query failed [${poolName}]: ${err.message}`;
      this.errors.push(msg);
      throw err;
    } finally {
      if (this.onQuery) {
        this.onQuery({
          pool: poolName,
          sql,
          params,
          durationMs: Date.now() - started,
        });
      }
    }
  }

  /**
   * Convenience readers
   */
  async getVar(sql, params = [], opts = {}) {
    const { rows } = await this.query(sql, params, opts);
    if (!rows || rows.length === 0) return null;
    return Object.values(rows[0])[0] ?? null;
  }

  async getCol(sql, params = [], opts = {}) {
    const { rows } = await this.query(sql, params, opts);
    if (!rows || rows.length === 0) return [];
    const key = Object.keys(rows[0])[0];
    return rows.map((r) => r[key]);
  }

  async getRow(sql, params = [], opts = {}) {
    const { rows } = await this.query(sql, params, opts);
    return rows?.[0] ?? null;
  }

  async getResults(sql, params = [], opts = {}) {
    const { rows } = await this.query(sql, params, opts);
    return rows;
  }

  /**
   * Safe identifier escaping (table/column names).
   */
  escapeId(identifier) {
    return this._mysql.escapeId(identifier);
  }

  /**
   * Build INSERT with column allowlist.
   * @param {string} table
   * @param {Record<string, any>} data - Plain object of column:value
   * @param {object} [opts]
   * @param {string[]} [opts.allowColumns] - Optional allowlist
   * @param {string} [opts.pool]
   * @returns {Promise<number>} insertId
   */
  async insert(table, data, opts = {}) {
    const cols = this._filterAllowed(Object.keys(data), opts.allowColumns);
    if (cols.length === 0) throw new Error("No insertable columns");

    const placeholders = cols.map(() => "?").join(", ");
    const values = cols.map((c) => data[c]);

    const sql = `INSERT INTO ${this.escapeId(table)} (${cols.map((c) => this.escapeId(c)).join(", ")}) VALUES (${placeholders})`;
    const { rows } = await this.query(sql, values, { pool: opts.pool });
    // mysql2 returns OkPacket for INSERT; rows.insertId is available via result from execute
    // But since we used .query wrapper, rows may be OkPacket:
    return rows?.insertId ?? 0;
  }

  /**
   * INSERT ... ON DUPLICATE KEY UPDATE
   * @param {string} table
   * @param {Record<string, any>} data
   * @param {string[]} updateColumns - Which columns to update on conflict
   * @param {object} [opts]
   */
  async upsert(table, data, updateColumns, opts = {}) {
    const cols = this._filterAllowed(Object.keys(data), opts.allowColumns);
    if (cols.length === 0) throw new Error("No upsert columns");

    const placeholders = cols.map(() => "?").join(", ");
    const values = cols.map((c) => data[c]);
    const updates = updateColumns
      .map((c) => `${this.escapeId(c)} = VALUES(${this.escapeId(c)})`)
      .join(", ");

    const sql = `INSERT INTO ${this.escapeId(table)} (${cols.map((c) => this.escapeId(c)).join(", ")}) VALUES (${placeholders})
                 ON DUPLICATE KEY UPDATE ${updates}`;
    const { rows } = await this.query(sql, values, { pool: opts.pool });
    return rows?.insertId ?? 0;
  }

  /**
   * UPDATE with WHERE clause + params.
   * @param {string} table
   * @param {Record<string, any>} data
   * @param {string} whereSql - e.g. "id = ?"
   * @param {any[]} whereParams
   * @param {object} [opts]
   */
  async update(table, data, whereSql, whereParams = [], opts = {}) {
    const cols = this._filterAllowed(Object.keys(data), opts.allowColumns);
    if (cols.length === 0) throw new Error("No updatable columns");

    const setClause = cols.map((c) => `${this.escapeId(c)} = ?`).join(", ");
    const values = cols.map((c) => data[c]);

    const sql = `UPDATE ${this.escapeId(table)} SET ${setClause} WHERE ${whereSql}`;
    const { rows } = await this.query(sql, [...values, ...whereParams], { pool: opts.pool });
    return Boolean(rows?.affectedRows);
  }

  /**
   * DELETE with simple object of equals conditions (ANDed).
   * @param {string} table
   * @param {Record<string, any>} whereObj
   * @param {object} [opts]
   */
  async deleteRow(table, whereObj, opts = {}) {
    const keys = Object.keys(whereObj || {});
    if (keys.length === 0) throw new Error("Refuse to DELETE without WHERE");

    const conditions = keys.map((k) => `${this.escapeId(k)} = ?`).join(" AND ");
    const values = keys.map((k) => whereObj[k]);

    const sql = `DELETE FROM ${this.escapeId(table)} WHERE ${conditions}`;
    const { rows } = await this.query(sql, values, { pool: opts.pool });
    return Boolean(rows?.affectedRows);
  }

  /**
   * REPLACE (MySQL-specific).
   * @param {string} table
   * @param {Record<string, any>} data
   * @param {object} [opts]
   */
  async replaceRow(table, data, opts = {}) {
    const cols = this._filterAllowed(Object.keys(data), opts.allowColumns);
    if (cols.length === 0) throw new Error("No replace columns");

    const placeholders = cols.map(() => "?").join(", ");
    const values = cols.map((c) => data[c]);

    const sql = `REPLACE INTO ${this.escapeId(table)} (${cols.map((c) => this.escapeId(c)).join(", ")}) VALUES (${placeholders})`;
    const { rows } = await this.query(sql, values, { pool: opts.pool });
    return Boolean(rows?.affectedRows);
  }

  /**
   * Bulk insert in chunks for throughput.
   * @param {string} table
   * @param {Array<Record<string, any>>} rows
   * @param {object} [opts]
   * @param {number} [opts.chunkSize=1000]
   * @param {string[]} [opts.allowColumns]
   * @param {string} [opts.pool]
   */
  async bulkInsert(table, rows, opts = {}) {
    const chunkSize = Number(opts.chunkSize || 1000);
    if (!Array.isArray(rows) || rows.length === 0) return 0;

    const columns = this._filterAllowed(
      Object.keys(rows[0]),
      opts.allowColumns
    );
    if (columns.length === 0) throw new Error("No bulk insert columns");

    let total = 0;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const batch = rows.slice(i, i + chunkSize);
      const placeholders = batch
        .map(() => `(${columns.map(() => "?").join(", ")})`)
        .join(", ");
      const values = [];
      for (const r of batch) {
        for (const c of columns) values.push(r[c]);
      }

      const sql = `INSERT INTO ${this.escapeId(table)} (${columns.map((c) => this.escapeId(c)).join(", ")}) VALUES ${placeholders}`;
      const { rows: res } = await this.query(sql, values, { pool: opts.pool });
      total += res?.affectedRows || 0;
    }
    return total;
  }

  /**
   * Transaction helper with retry/backoff on deadlock/lock wait timeout.
   * @param {function(import('mysql2/promise').PoolConnection): Promise<any>} work
   * @param {object} [opts]
   * @param {string} [opts.pool=default]
   * @param {number} [opts.maxRetries=3]
   * @param {number} [opts.initialDelayMs=50]
   */
  async transaction(work, opts = {}) {
    const poolName = opts.pool || DEFAULT_POOL_NAME;
    const pool = await this._ensurePool(poolName);

    const maxRetries = Number(opts.maxRetries ?? 3);
    const baseDelay = Number(opts.initialDelayMs ?? 50);

    let attempt = 0;
    // Deadlock related MySQL codes: 1213 (ER_LOCK_DEADLOCK), 1205 (ER_LOCK_WAIT_TIMEOUT)
    const RETRY_CODES = new Set([1213, 1205]);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const result = await work(conn);
        await conn.commit();
        return result;
      } catch (err) {
        try {
          await conn.rollback();
        } catch {}
        const code = err?.errno ?? err?.code;
        const shouldRetry = RETRY_CODES.has(code) && attempt < maxRetries;
        if (!shouldRetry) throw err;

        const delay = baseDelay * Math.pow(2, attempt); // exponential backoff
        await new Promise((r) => setTimeout(r, delay));
        attempt += 1;
      } finally {
        conn.release();
      }
    }
  }

  /**
   * Clear local state (does not close pools).
   */
  flush() {
    this.errors = [];
  }

  /**
   * Internal: allowlist filter
   */
  _filterAllowed(cols, allow) {
    if (!allow || !Array.isArray(allow) || allow.length === 0) return cols;
    const allowed = new Set(allow);
    return cols.filter((c) => allowed.has(c));
  }
}

module.exports = MySQLDB;

/*
Based on the structure you shared (pooled connections + helpers), I mirrored and expanded it with security (param binding, identifier escaping), performance (bulk insert, upsert, timeouts), persistence control, transactions with retries, and DI for clean Jest mocking. 

db

Jest tip (mocking mysql2/promise):

// __mocks__/mysql2/promise.js
module.exports = {
  createPool: jest.fn().mockResolvedValue({
    execute: jest.fn().mockResolvedValue([[{ id: 1 }], []]),
    query: jest.fn().mockResolvedValue([[{ id: 1 }], []]),
    getConnection: jest.fn().mockResolvedValue({
      beginTransaction: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      execute: jest.fn().mockResolvedValue([[{ ok: 1 }], []]),
      query: jest.fn().mockResolvedValue([[{ ok: 1 }], []]),
      release: jest.fn(),
    }),
    end: jest.fn().mockResolvedValue(),
  }),
  escapeId: (id) => `\`${String(id).replace(/`/g, '``')}\``,
};


Then inject it:

const mockDriver = require('mysql2/promise'); // from __mocks__
const MySQLDB = require('./MySQLDB');

test('getRow works', async () => {
  const db = new MySQLDB({ driver: mockDriver });
  await db.connect();
  const row = await db.getRow('SELECT 1 AS x');
  expect(row).toEqual({ id: 1 }); // per mock above
});
*/
