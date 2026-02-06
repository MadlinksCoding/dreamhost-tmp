'use strict';

const dotenv = require('dotenv');
dotenv.config();

const pkg = require('pg');
const {Pool} = pkg;

/**
 * Lightweight Postgres helper with:
 * - Named connections (read/write, tenants, etc.)
 * - Safe identifier validation (table/column)
 * - Parameterized values
 * - Transactions via withTransaction()
 * - Dependency injection (poolFactory) for Jest/mocks/pg-mem
 * - Optional query logger & timeouts
 */
class DB {
    /**
     * @param {Object} [opts]
     * @param {function(Object): any} [opts.poolFactory] - Factory returning a Pool-like instance.
     * @param {Object} [opts.defaultConfig] - Default PG config.
     * @param {function({name,text,params,durationMs,result,error}):void} [opts.queryLogger] - Optional logger.
     * @param {number} [opts.defaultQueryTimeoutMs] - Per-query timeout (ms).
     */
    constructor(opts = {}) {
        this.poolFactory =
            typeof opts.poolFactory === 'function' ? opts.poolFactory : (cfg) => new Pool(cfg);

        this.queryLogger = typeof opts.queryLogger === 'function' ? opts.queryLogger : null;
        this.defaultQueryTimeoutMs = Number.isFinite(opts.defaultQueryTimeoutMs)
            ? opts.defaultQueryTimeoutMs
            : 0;

        // You can still override everything via registerConnection().
        this.defaultConfig = Object.assign(
            {
                user: process.env.POSTGRES_USER,
                host: process.env.PGHOST || 'localhost',
                database: process.env.POSTGRES_DB,
                password: process.env.POSTGRES_PASSWORD,
                port: parseInt(process.env.PGPORT, 10) || 5432,
                ssl:
                    process.env.PGSSL === 'require'
                        ? {rejectUnauthorized: process.env.PGSSL_NO_VERIFY !== '1'}
                        : undefined,
                max: parseInt(process.env.PG_MAX_CLIENTS || '10', 10),
                idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
                connectionTimeoutMillis: parseInt(process.env.PG_CONN_TIMEOUT_MS || '0', 10),
            },
            opts.defaultConfig || {},
        );

        /** @type {Record<string, import('pg').Pool>} */
        this.connections = {};

        /** @type {Array<{ts:number,msg:string,stack?:string}>} */
        this.errors = [];
    }

    // ----------- Utilities (security) -----------
    static _isValidIdentifier(id) {
        // Accepts standard SQL identifiers: letters, digits, underscore; must not start with digit.
        return typeof id === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(id);
    }

    static _quoteIdent(id) {
        // Double-quote and escape embedded quotes per SQL rules if ever needed.
        // We still validate first to block malicious names entirely.
        // console.log("Quoting identifier:", id);
        if (!DB._isValidIdentifier(id)) {
            throw new Error(`Invalid SQL identifier: ${id}`);
        }
        return `"${id.replace(/"/g, '""')}"`;
    }

    static _validateIdentifiers(...ids) {
        // console.log("Validating identifiers inside validateIdentifiers:", ids);
        for (const id of ids) {
            if (!DB._isValidIdentifier(id)) throw new Error(`Invalid SQL identifier: ${id}`);
        }
    }

    // ----------- Connections -----------
    /**
     * Create/register a named connection with a specific config.
     */
    registerConnection(name, config = {}) {
        if (!DB._isValidIdentifier(name)) {
            throw new Error(`Invalid connection name: ${name}`);
        }
        if (this.connections[name]) return this.connections[name];
        const pool = this.poolFactory({...this.defaultConfig, ...config});
        this.connections[name] = pool;
        return pool;
    }

    /**
     * Ensure a connection exists; auto-registers from defaultConfig if missing.
     */
    async ensureConnected(name = 'default') {
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

    // ----------- Core Query -----------
    /**
     * Run a parameterized query.
     * @param {string} name - connection name
     * @param {string} text - SQL
     * @param {Array<any>} params - param values
     * @param {Object} [options]
     * @param {number} [options.timeoutMs] - per-query timeout
     * @param {string} [options.statementName] - pg prepared statement name
     * @returns {Promise<import('pg').QueryResult>}
     */
    async query(name = 'default', text = '', params = [], options = {}) {
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
                // Optionally: cancel query if using a persistent client
            }
        }
    }

    async getRow(name = 'default', text = '', params = [], options = {}) {
        const r = await this.query(name, text, params, options);
        return r.rows[0] || null;
    }

    async getAll(name = 'default', text = '', params = [], options = {}) {
        const r = await this.query(name, text, params, options);
        return r.rows;
    }

    // ----------- Safe DML helpers -----------
    /**
     * INSERT ... RETURNING
     * @param {string} name
     * @param {string} table
     * @param {Object} data - { col: value, ... }
     */
    async insert(name = 'default', table = '', data = {}) {
        await this.ensureConnected(name);
        if (!table || typeof data !== 'object' || !Object.keys(data).length) {
            throw new Error('Invalid table or data for insert.');
        }
        DB._validateIdentifiers(table);

        const columns = Object.keys(data);

        if (columns.length === 0) {
            throw new Error('No columns for insert.');
        }
        columns.forEach((c) => DB._validateIdentifiers(c));

        const values = Object.values(data);
        const placeholders = columns.map((_, i) => `$${i + 1}`);
        const columnList = columns.map(DB._quoteIdent).join(', ');

        const sql = `INSERT INTO ${DB._quoteIdent(table)} (${columnList}) VALUES (${placeholders.join(', ')}) RETURNING *`;

        const response = await this.query(name, sql, values);
        return response.rows[0] || null;
    }

    /**
     * UPDATE ... RETURNING
     * @param {string} name
     * @param {string} table
     * @param {Object} data - columns to set
     * @param {string} where - WHERE clause with placeholders for params
     * @param {Array<any>} params - values for WHERE placeholders
     */
    async update(name = 'default', table = '', data = {}, where = '', params = []) {
        await this.ensureConnected(name);
        if (!table || typeof data !== 'object' || !Object.keys(data).length || !where) {
            throw new Error('Invalid table, data, or where clause for update.');
        }

        DB._validateIdentifiers(table);
        const keys = Object.keys(data);
        keys.forEach(DB._validateIdentifiers);

        const values = Object.values(data);
        const setClause = keys.map((k, i) => `${DB._quoteIdent(k)}=$${i + 1}`).join(', ');

        const sql = `UPDATE ${DB._quoteIdent(table)} SET ${setClause} WHERE ${where} RETURNING *`;

        const result = await this.query(name, sql, [...values, ...params]);
        return result.rows;
    }

    /**
     * DELETE ... RETURNING
     * @param {string} name
     * @param {string} table
     * @param {string} where
     * @param {Array<any>} params
     */
    async delete(name = 'default', table = '', where = '', params = []) {
        await this.ensureConnected(name);
        if (!table || !where) {
            throw new Error('Invalid table or where clause for delete.');
        }

        DB._validateIdentifiers(table);
        const sql = `DELETE FROM ${DB._quoteIdent(table)} WHERE ${where} RETURNING *`;

        const result = await this.query(name, sql, params);
        return result.rows;
    }

    // ----------- Transactions -----------
    /**
     * Run a function inside a transaction. Rolls back on error.
     * @template T
     * @param {string} name
     * @param {(client:{query:Function})=>Promise<T>} work
     * @returns {Promise<T>}
     */
    async withTransaction(name = 'default', work) {
        await this.ensureConnected(name);
        const pool = this.connections[name];
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const result = await work({
                query: (text, params = [], options = {}) =>
                    client.query({
                        text,
                        values: params,
                        name: options.statementName,
                    }),
            });

            await client.query('COMMIT');

            return result;
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (_) {
                // ignore rollback errors
            }
            this._recordError(err);
            throw err;
        } finally {
            client.release();
        }
    }

    getErrors() {
        // Return a shallow copy to avoid external mutation
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
                // INFO: ignore close errors
            }
        }
        this.connections = {};
    }
}

module.exports = DB;
