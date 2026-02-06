const dotenv = require('dotenv');
dotenv.config();

const { Pool } = require('pg');

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
                user: process.env.POSTGRES_USER,
                host: process.env.PGHOST || "localhost",
                database: process.env.POSTGRES_DB,
                password: process.env.POSTGRES_PASSWORD,
                port: parseInt(process.env.PGPORT, 10) || 5432,
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

        if (this.connections[name]) {
            return this.connections[name];
        }

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
                    name: options.statementName,
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
                        result: undefined,
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
        const setClause = keys.map((k, i) => `${DB._quoteIdent(k)}=$${i + 1}`).join(", ");
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
}

const db = new DB({
    defaultQueryTimeoutMs: 15000,
    queryLogger: null,
});

module.exports = db;

