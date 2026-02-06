"use strict";

const { Pool } = require("pg");

/**
 * Get PostgreSQL schema name from environment variable with validation
 * @returns {string} Schema name (defaults to "public")
 */
function pgSchema() {
    const raw = process.env.PG_SCHEMA;
    const s = raw && String(raw).trim() ? String(raw).trim() : "public";
    // super basic hardening: only allow letters/numbers/underscore
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
        throw new Error(`Invalid PG_SCHEMA: ${s}`);
    }
    return s;
}

class DB {
    constructor(opts = {}) {
        this.poolFactory =
            typeof opts.poolFactory === "function"
                ? opts.poolFactory
                : (cfg) => new Pool(cfg);

        this.queryLogger = typeof opts.queryLogger === "function" ? opts.queryLogger : null;

        this.defaultQueryTimeoutMs =
            Number.isFinite(opts.defaultQueryTimeoutMs) ? opts.defaultQueryTimeoutMs : 0;

        this.defaultConfig = Object.assign(
            {
                user: process.env.PGUSER || process.env.POSTGRES_USER,
                host: process.env.PGHOST || "localhost",
                database: process.env.PGDATABASE || process.env.POSTGRES_DB,
                password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
                port: parseInt(process.env.PGPORT || process.env.POSTGRES_PORT, 10) || 5432,
                ssl:
                    process.env.PGSSL === "require"
                        ? { rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== "1" }
                        : undefined,
                max: parseInt(process.env.PG_MAX_CLIENTS || "10", 10),
                idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || "30000", 10),
                connectionTimeoutMillis: parseInt(
                    process.env.PG_CONN_TIMEOUT_MS || "0",
                    10
                ),
            },
            opts.defaultConfig || {}
        );

        this.connections = {};
        this.errors = [];
        this.schema = pgSchema(); // Store schema name
    }

    static _isValidIdentifier(id) {
        return typeof id === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(id);
    }

    static _quoteIdent(id) {
        if (!DB._isValidIdentifier(id)) {
            throw new Error(`Invalid SQL identifier: ${id}`);
        }
        return `"${id.replace(/"/g, '""')}"`;
    }

    static _validateIdentifiers(...ids) {
        for (const id of ids) {
            if (!DB._isValidIdentifier(id)) throw new Error(`Invalid SQL identifier: ${id}`);
        }
    }

    registerConnection(name, config = {}) {
        if (!DB._isValidIdentifier(name)) {
            throw new Error(`Invalid connection name: ${name}`);
        }
        if (this.connections[name]) return this.connections[name];
        const pool = this.poolFactory({ ...this.defaultConfig, ...config });
        this.connections[name] = pool;
        return pool;
    }

    async ensureConnected(name = "default") {
        if (!this.connections[name]) {
            this.registerConnection(name);
        }
        const pool = this.connections[name];
        try {
            const client = await pool.connect();
            // Set search_path to the configured schema
            const schema = this.schema;
            await client.query(`SET search_path = ${DB._quoteIdent(schema)}, public`);
            client.release();
        } catch (err) {
            this._recordError(err);
            throw err;
        }
    }

    async query(name = "default", text = "", params = [], options = {}) {
        await this.ensureConnected(name);
        const pool = this.connections[name];
        const start = Date.now();
        const timeoutMs =
            Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
                ? options.timeoutMs
                : this.defaultQueryTimeoutMs;

        let timeoutHandle = null;
        let timeoutPromise = null;
        let timedOut = false;

        if (timeoutMs > 0) {
            timeoutPromise = new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    timedOut = true;
                    reject(new Error(`Query timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            });
        }

        const run = async () => {
            try {
                const result = await pool.query({
                    text,
                    values: params,
                    name: options.statementName, // optional prepared statement name
                });
                return result;
            } catch (err) {
                this._recordError(err);
                throw err;
            } finally {
                const durationMs = Date.now() - start;
                if (this.queryLogger) {
                    this.queryLogger({
                        name,
                        text,
                        params,
                        durationMs,
                        result: undefined, // omit heavy rows by default
                        error: undefined,
                    });
                }
            }
        };

        try {
            if (timeoutPromise) {
                return await Promise.race([run(), timeoutPromise]);
            }
            return await run();
        } catch (err) {
            if (this.queryLogger) {
                const durationMs = Date.now() - start;
                this.queryLogger({
                    name,
                    text,
                    params,
                    durationMs,
                    result: undefined,
                    error: err,
                });
            }
            throw err;
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (timedOut) {
            }
        }
    }

    async getRow(name = "default", text = "", params = [], options = {}) {
        const r = await this.query(name, text, params, options);
        return r.rows[0] || null;
    }

    async getAll(name = "default", text = "", params = [], options = {}) {
        const r = await this.query(name, text, params, options);
        return r.rows;
    }

    async insert(name = "default", table = "", data = {}) {
        await this.ensureConnected(name);
        if (!table || typeof data !== "object" || !Object.keys(data).length) {
            throw new Error("Invalid table or data for insert.");
        }

        DB._validateIdentifiers(table);

        const cols = Object.keys(data);
        if (cols.length === 0) throw new Error("No columns for insert.");

        cols.forEach(value => DB._validateIdentifiers(value));

        const values = Object.values(data);
        const placeholders = cols.map((_, i) => `$${i + 1}`);
        const colList = cols.map(value => DB._quoteIdent(value)).join(", ");

        const sql = `
             INSERT INTO ${DB._quoteIdent(table)} (${colList}) 
             VALUES (${placeholders.join(", ")}) 
             RETURNING *
        `;

        const res = await this.query(name, sql, values);
        return res.rows[0] || null;
    }

    async update(name = "default", table = "", data = {}, where = "", params = []) {
        await this.ensureConnected(name);
        if (!table || typeof data !== "object" || !Object.keys(data).length || !where) {
            throw new Error("Invalid table, data, or where clause for update.");
        }

        DB._validateIdentifiers(table);
        const keys = Object.keys(data);
        keys.forEach(k => DB._validateIdentifiers(k));

        const values = Object.values(data);
        // Build SET clause: $1, $2, ... for the data columns
        const setClause = keys.map((k, i) => `${DB._quoteIdent(k)}=$${i + 1}`).join(", ");

        // Adjust WHERE placeholders to continue after the data values
        const whereClause = where.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n) + values.length}`);

        const sql = `UPDATE ${DB._quoteIdent(table)} SET ${setClause} WHERE ${whereClause} RETURNING *`;
        const res = await this.query(name, sql, [...values, ...params]);
        return res.rows;
    }

    async delete(name = "default", table = "", where = "", params = []) {
        await this.ensureConnected(name);

        if (!table || !where) {
            throw new Error("Invalid table or where clause for delete.");
        }

        DB._validateIdentifiers(table);

        const sql = `DELETE FROM ${DB._quoteIdent(table)} WHERE ${where} RETURNING *`;

        const res = await this.query(name, sql, params);
        return res.rows;
    }

    async withTransaction(name = "default", work) {
        await this.ensureConnected(name);
        const pool = this.connections[name];
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            // Set search_path for transaction
            const schema = this.schema;
            await client.query(`SET search_path = ${DB._quoteIdent(schema)}, public`);
            const result = await work({
                query: (text, params = [], options = {}) =>
                    client.query({
                        text,
                        values: params,
                        name: options.statementName,
                    }),
            });
            await client.query("COMMIT");
            return result;
        } catch (err) {
            try {
                await client.query("ROLLBACK");
            } catch (_) {
            }
            this._recordError(err);
            throw err;
        } finally {
            client.release();
        }
    }

    getErrors() {
        return this.errors.slice();
    }

    _recordError(err) {
        this.errors.push({
            ts: Date.now(),
            msg: err?.message || String(err),
            stack: err?.stack,
        });
        // Optional: cap memory
        if (this.errors.length > 200) this.errors.splice(0, this.errors.length - 200);
    }

    async closeAll() {
        for (const name of Object.keys(this.connections)) {
            try {
                await this.connections[name].end();
            } catch (_) {
            }
        }
        this.connections = {};
    }

    /**
     * Get the current schema name
     * @returns {string} Schema name
     */
    getSchema() {
        return this.schema;
    }
}

// Export pgSchema helper function
DB.pgSchema = pgSchema;

module.exports = DB;

/* -------------------------- Example usage script --------------------------
require("dotenv").config();
const DB = require("./db");

(async () => {
  const db = new DB({
    queryLogger: ({ name, text, durationMs, error }) => {
      // Minimal logger; avoid logging full params for PII
      console.log(`[${name}] ${text.split("\n").join(" ")} (${durationMs}ms) ${error ? "ERR" : "OK"}`);
    },
    defaultQueryTimeoutMs: 15000,
  });

  // Optional: custom connection name "main"
  db.registerConnection("main", {
    host: process.env.PGHOST || "127.0.0.1",
    database: process.env.POSTGRES_DB || "postgres",
  });

  try {
    const now = await db.getRow("main", "SELECT NOW() AS now");
    console.log("NOW:", now);

    const inserted = await db.insert("main", "users", { name: "Jane", email: "jane@example.com" });
    console.log("Inserted:", inserted);

    const updated = await db.update(
      "main",
      "users",
      { email: "jane.new@example.com" },
      "id=$1",
      [inserted.id]
    );
    console.log("Updated:", updated);

    const deleted = await db.delete("main", "users", "id=$1", [inserted.id]);
    console.log("Deleted:", deleted);

    // Transaction example
    const result = await db.withTransaction("main", async ({ query }) => {
      const a = await query("INSERT INTO accounts(name, balance) VALUES($1,$2) RETURNING *", ["A", 100]);
      const b = await query("INSERT INTO accounts(name, balance) VALUES($1,$2) RETURNING *", ["B", 100]);
      await query("UPDATE accounts SET balance=balance-50 WHERE id=$1", [a.rows[0].id]);
      await query("UPDATE accounts SET balance=balance+50 WHERE id=$1", [b.rows[0].id]);
      return { a: a.rows[0], b: b.rows[0] };
    });
    console.log("Tx:", result);
  } catch (e) {
    console.error("Error:", e);
    console.error("Collected errors:", db.getErrors());
  } finally {
    await db.closeAll();
  }
})();
-------------------------------------------------------------------------- */


/*
Jest mocking — easy now (inject a fake Pool)
// db.mock.test.js
"use strict";

const DB = require("./db");

// A minimal Pool-like fake
class FakePool {
  constructor() { this._connected = false; }
  async connect() { this._connected = true; return { release() {} }; }
  async query({ text, values }) {
    // Simulate behavior based on SQL text for unit tests
    if (/^select now\(\)/i.test(text)) {
      return { rows: [{ now: "2025-10-16T12:00:00.000Z" }] };
    }
    if (/^insert into "users"/i.test(text)) {
      return { rows: [{ id: 123, name: values[0], email: values[1] }] };
    }
    if (/^update "users"/i.test(text)) {
      return { rows: [{ id: values[2], email: values[0] }] };
    }
    if (/^delete from "users"/i.test(text)) {
      return { rows: [{ id: values[0] }] };
    }
    return { rows: [] };
  }
  async end() {}
}

test("DB works with injected FakePool", async () => {
  const db = new DB({
    poolFactory: () => new FakePool(),
    defaultQueryTimeoutMs: 1000,
  });

  // Register a connection name used in tests
  db.registerConnection("test");

  const t = await db.getRow("test", "SELECT NOW()");
  expect(t).toBeTruthy();

  const ins = await db.insert("test", "users", { name: "Jane", email: "jane@x.com" });
  expect(ins.id).toBe(123);
  expect(ins.name).toBe("Jane");

  const upd = await db.update("test", "users", { email: "new@x.com" }, "id=$1", [123]);
  expect(upd[0].email).toBe("new@x.com");

  const del = await db.delete("test", "users", "id=$1", [123]);
  expect(del[0].id).toBe(123);

  await db.closeAll();
});

Why your original was “hard with Jest”

It constructs a real new Pool() internally, so tests must talk to a real DB or you need to monkey-patch pg. With the new constructor’s poolFactory, you skip that and inject a fake (or plug in pg-mem) → easy unit tests, no sockets.

Security notes (what was fixed / added)

Identifier injection: INSERT/UPDATE/DELETE built SQL with ${table} and ${key}. Now we strictly validate and quote identifiers. Keep your app’s allowlist of table/column names if you want even stricter control.

Values already used placeholders ($1, $2) — good.

Optional SSL enforcement via env (PGSSL=require).

Timeouts to prevent hung tests/queries.

Transactions for atomic operations.

How to extend cleanly

Read replica / writer: call registerConnection("reader", {...}) and registerConnection("writer", {...}); choose which to hit per query.

Per-tenant pools: register per tenant key; LRU close old ones if needed.

Query interceptors: you already have queryLogger; you can add a lightweight “beforeQuery/afterQuery” pair if you need redaction, tracing headers, or OpenTelemetry.

Typed helpers: add upsert(), bulkInsert(), or table mappers that generate column allowlists automatically from a schema object.
*/
