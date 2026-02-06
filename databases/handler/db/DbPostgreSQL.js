"use strict";

const ErrorWrapper = require("../utils/ErrorWrapper");
const DbCommonHandler = require("./DbCommonHandler");

/**
 * DbPostgreSQLHandler - Internal PostgreSQL operations handler
 * Used by DatabaseSchemaHandler for modular PostgreSQL-specific operations
 * Includes integrated type mapping, caching, transactions, and other utilities
 */
class DbPostgreSQLHandler {
    constructor(client, logger = null) {
        this.client = client;
        this.log = logger || ((msg, meta) => console.log(msg, meta ?? ""));
        this._initTypeMapper();
        this._initCache();
    }
    
    // ==================== Type Mapping Methods (Integrated from TypeMapper) ====================
    
    /**
     * Initialize type mapper
     * @private
     */
    _initTypeMapper() {
        this.postgresTypes = new Set([
            "text", "varchar", "char", "uuid", "json", "jsonb",
            "boolean", "bool",
            "smallint", "integer", "int", "bigint", "serial", "bigserial",
            "real", "double precision", "numeric", "decimal",
            "date", "time", "timestamp", "timestamptz", "interval",
            "bytea", "bit", "varbit",
        ]);
        this.commonMappings = {
            string: "text", number: "integer", integer: "integer", int: "integer",
            bigint: "bigint", float: "double precision", double: "double precision",
            decimal: "numeric", boolean: "boolean", bool: "boolean",
            json: "jsonb", datetime: "timestamptz", timestamp: "timestamptz",
            timestamptz: "timestamptz", date: "date", uuid: "uuid",
            binary: "bytea", blob: "bytea"
        };
    }
    
    /**
     * Map type to PostgreSQL type
     * @param {string} type - Generic type
     * @param {object} spec - Column specification
     * @param {object} context - Context for logging
     * @returns {string} PostgreSQL type
     */
    mapToPostgres(type, spec = {}, context = {}) {
        if (spec.postgres?.type) {
            return this.validatePostgresType(spec.postgres.type, context);
        }
        
        const normalized = String(type || "").toLowerCase().trim();
        
        if (this.postgresTypes.has(normalized)) {
            return normalized;
        }
        
        // Handle parameterized types
        const paramMatch = normalized.match(/^([a-z\s]+)\(.*\)$/);
        if (paramMatch) {
            const baseType = paramMatch[1].trim();
            if (this.postgresTypes.has(baseType)) {
                return normalized;
            }
        }
        
        // Try common mappings
        if (this.commonMappings[normalized]) {
            return this.commonMappings[normalized];
        }
        
        // Log warning
        if (context.logger || this.log) {
            (context.logger || this.log)("[WARN] Unknown type for PostgreSQL, defaulting to text", {
                type, table: context.table, column: context.column
            });
        }
        
        return "text";
    }
    
    /**
     * Validate PostgreSQL type
     * @param {string} type - Type to validate
     * @param {object} context - Context
     * @returns {string} Validated type
     */
    validatePostgresType(type, context = {}) {
        const normalized = String(type).toLowerCase().trim();
        const baseType = normalized.split("(")[0].trim();
        if (!this.postgresTypes.has(baseType)) {
            throw new Error(
                `Invalid PostgreSQL type "${type}" for ${context.table || "unknown"}.${context.column || "unknown"}`
            );
        }
        return normalized;
    }
    
    // ==================== Caching Methods (Integrated from ExistenceCache) ====================
    
    /**
     * Initialize cache
     * @private
     */
    _initCache() {
        this.cache = new Map();
        this.cacheMaxAge = 60000;
        this.cacheMaxSize = 1000;
    }
    
    /**
     * Get from cache
     * @private
     */
    _cacheGet(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.cacheMaxAge) {
            this.cache.delete(key);
            return null;
        }
        return entry.value;
    }
    
    /**
     * Set cache value
     * @private
     */
    _cacheSet(key, value) {
        if (this.cache.size >= this.cacheMaxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, { value, timestamp: Date.now() });
    }
    
    /**
     * Clear cache
     * @private
     */
    _cacheClear() {
        this.cache.clear();
    }

    /**
     * Get schema name
     * @returns {string} Schema name
     */
    getSchema() {
        return this.client?.getSchema ? this.client.getSchema() : "public";
    }

    /**
     * Check if table exists
     * @param {string} tableName - Table name
     * @returns {Promise<boolean>}
     */
    async tableExists(tableName) {
        const schema = this.getSchema();
        const row = await ErrorWrapper.wrapQuery(
            () => this.client.getRow(
                "default",
                `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2`,
                [schema, tableName]
            ),
            { engine: "postgres", operation: "tableExists", table: tableName }
        );
        return !!row;
    }

    /**
     * Check if column exists
     * @param {string} tableName - Table name
     * @param {string} columnName - Column name
     * @returns {Promise<boolean>}
     */
    async columnExists(tableName, columnName) {
        const schema = this.getSchema();
        const row = await ErrorWrapper.wrapQuery(
            () => this.client.getRow(
                "default",
                `SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3`,
                [schema, tableName, columnName]
            ),
            { engine: "postgres", operation: "columnExists", table: tableName, column: columnName }
        );
        return !!row;
    }

    /**
     * Check if index exists
     * @param {string} indexName - Index name
     * @returns {Promise<boolean>}
     */
    async indexExists(indexName) {
        const schema = this.getSchema();
        const row = await ErrorWrapper.wrapQuery(
            () => this.client.getRow(
                "default",
                `SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname=$2`,
                [schema, indexName]
            ),
            { engine: "postgres", operation: "indexExists", index: indexName }
        );
        return !!row;
    }

    /**
     * Map type to PostgreSQL type
     * @param {string} colName - Column name
     * @param {object} colSpec - Column specification
     * @returns {string} PostgreSQL type
     */
    mapType(colName, colSpec = {}) {
        return this.mapToPostgres(colSpec.type || "text", colSpec, {
            table: colSpec._tableName,
            column: colName,
            logger: this.log,
        });
    }

    /**
     * Build column definition SQL
     * @param {string} colName - Column name
     * @param {object} colSpec - Column specification
     * @returns {string} Column definition SQL
     */
    buildColumnDefSql(colName, colSpec = {}) {
        const quotedName = DbCommonHandler.quoteIdentifierPg(colName);
        const type = this.mapType(colName, colSpec);
        
        let sql = `${quotedName} ${type}`;
        
        if (colSpec.notNull) {
            sql += " NOT NULL";
        }
        
        if (colSpec.default !== undefined) {
            // Validate default expression
            const defaultValue = colSpec.default;
            if (typeof defaultValue === "string") {
                // Check if it's a function/expression
                if (/^[A-Za-z_]+\(/.test(defaultValue)) {
                    // Function like NOW(), CURRENT_TIMESTAMP, etc.
                    sql += ` DEFAULT ${defaultValue}`;
                } else {
                    // String literal - quote it
                    sql += ` DEFAULT '${defaultValue.replace(/'/g, "''")}'`;
                }
            } else {
                sql += ` DEFAULT ${defaultValue}`;
            }
        }
        
        return sql;
    }

    /**
     * Get primary key columns
     * @param {object} spec - Table specification
     * @returns {Array<string>} Primary key column names (quoted)
     */
    getPrimaryKeyList(spec = {}) {
        return Object.entries(spec.columns || {})
            .filter(([, s]) => !!s.primary)
            .map(([n]) => DbCommonHandler.quoteIdentifierPg(n));
    }

    /**
     * Build CREATE TABLE SQL
     * @param {string} tableName - Table name
     * @param {object} spec - Table specification
     * @param {number} tableVer - Table version
     * @returns {string} CREATE TABLE SQL
     */
    buildCreateTableSql(tableName, spec, tableVer) {
        const schema = this.getSchema();
        const quotedSchema = DbCommonHandler.quoteIdentifierPg(schema);
        const quotedTable = DbCommonHandler.quoteIdentifierPg(tableName);
        
        const colDefs = [];
        
        for (const [col, cSpec] of Object.entries(spec.columns || {})) {
            const lifecycle = LifecycleChecker.check(cSpec, tableVer, {
                engine: "postgres",
                table: tableName,
                column: col,
            });
            
            if (!lifecycle.active) continue;
            
            // Add table name to spec for logging
            cSpec._tableName = tableName;
            colDefs.push(this.buildColumnDefSql(col, cSpec));
        }
        
        const pkCols = this.getPrimaryKeyList(spec);
        if (pkCols.length) {
            colDefs.push(`PRIMARY KEY (${pkCols.join(", ")})`);
        }
        
        return `CREATE TABLE IF NOT EXISTS ${quotedSchema}.${quotedTable} (\n  ${colDefs.join(",\n  ")}\n)`;
    }

    /**
     * Build CREATE INDEX SQL
     * @param {string} tableName - Table name
     * @param {string} indexName - Index name
     * @param {object} idxSpec - Index specification
     * @returns {string} CREATE INDEX SQL
     */
    buildCreateIndexSql(tableName, indexName, idxSpec) {
        const schema = this.getSchema();
        const quotedSchema = DbCommonHandler.quoteIdentifierPg(schema);
        const quotedTable = DbCommonHandler.quoteIdentifierPg(tableName);
        const quotedIndex = DbCommonHandler.quoteIdentifierPg(indexName);
        
        const unique = idxSpec?.unique ? "UNIQUE " : "";
        
        // Check for PostgreSQL-specific expression
        if (idxSpec?.postgres?.expression) {
            const expr = idxSpec.postgres.expression;
            
            // Validate expression to prevent SQL injection
            this.validateIndexExpression(expr);
            
            return `CREATE ${unique}INDEX IF NOT EXISTS ${quotedIndex} ON ${quotedSchema}.${quotedTable} (${expr})`;
        }
        
        const cols = (idxSpec?.columns || [])
            .map(c => DbCommonHandler.quoteIdentifierPg(c))
            .join(", ");
        
        return `CREATE ${unique}INDEX IF NOT EXISTS ${quotedIndex} ON ${quotedSchema}.${quotedTable} (${cols})`;
    }

    /**
     * Validate index expression to prevent SQL injection
     * @param {string} expression - Index expression
     * @throws {Error} If expression is invalid
     */
    validateIndexExpression(expression) {
        if (!expression || typeof expression !== "string") {
            throw new Error("Index expression must be a non-empty string");
        }
        
        // Whitelist common safe expressions
        const safePatterns = [
            /^[a-zA-Z_][a-zA-Z0-9_]*$/, // Simple column name
            /^[a-zA-Z_][a-zA-Z0-9_]*\s+(ASC|DESC)$/i, // Column with order
            /^LOWER\([a-zA-Z_][a-zA-Z0-9_]*\)$/, // LOWER(column)
            /^UPPER\([a-zA-Z_][a-zA-Z0-9_]*\)$/, // UPPER(column)
            /^\([a-zA-Z_][a-zA-Z0-9_]*\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*\)$/, // (col1, col2)
        ];
        
        const isSafe = safePatterns.some(pattern => pattern.test(expression.trim()));
        
        if (!isSafe) {
            throw new Error(
                `Potentially unsafe index expression: "${expression}". ` +
                `Use simple column names, LOWER(), UPPER(), or column lists.`
            );
        }
    }

    /**
     * Create table
     * @param {string} tableName - Table name
     * @param {object} spec - Table specification
     * @param {number} tableVer - Table version
     * @param {boolean} dryRun - Dry run flag
     * @returns {Promise<object>} Result
     */
    async createTable(tableName, spec, tableVer, dryRun = false) {
        const sql = this.buildCreateTableSql(tableName, spec, tableVer);
        
        this.log("[APPLY][PG] CREATE TABLE", { table: tableName, sql });

        if (!dryRun) {
            await ErrorWrapper.wrapQuery(
                () => this.client.query("default", sql, []),
                { engine: "postgres", operation: "createTable", table: tableName }
            );
        }
        
        return { dryRun, sql };
    }

    /**
     * Add column to table
     * @param {string} tableName - Table name
     * @param {string} columnName - Column name
     * @param {object} colSpec - Column specification
     * @param {boolean} dryRun - Dry run flag
     * @returns {Promise<object>} Result
     */
    async addColumn(tableName, columnName, colSpec, dryRun = false) {
        const schema = this.getSchema();
        const quotedSchema = DbCommonHandler.quoteIdentifierPg(schema);
        const quotedTable = DbCommonHandler.quoteIdentifierPg(tableName);
        
        colSpec._tableName = tableName;
        const columnDef = this.buildColumnDefSql(columnName, colSpec);
        
        const sql = `ALTER TABLE ${quotedSchema}.${quotedTable} ADD COLUMN ${columnDef}`;
        
        this.log("[APPLY][PG] ADD COLUMN", { table: tableName, column: columnName, sql });

        if (!dryRun) {
            await ErrorWrapper.wrapQuery(
                () => this.client.query("default", sql, []),
                { engine: "postgres", operation: "addColumn", table: tableName, column: columnName }
            );
        }
        
        return { dryRun, sql };
    }

    /**
     * Create index
     * @param {string} tableName - Table name
     * @param {string} indexName - Index name
     * @param {object} idxSpec - Index specification
     * @param {boolean} dryRun - Dry run flag
     * @returns {Promise<object>} Result
     */
    async createIndex(tableName, indexName, idxSpec, dryRun = false) {
        const sql = this.buildCreateIndexSql(tableName, indexName, idxSpec);
        
        this.log("[APPLY][PG] CREATE INDEX", { table: tableName, index: indexName, sql });

        if (!dryRun) {
            await ErrorWrapper.wrapQuery(
                () => this.client.query("default", sql, []),
                { engine: "postgres", operation: "createIndex", table: tableName, index: indexName }
            );
        }
        
        return { dryRun, sql };
    }
}

module.exports = DbPostgreSQLHandler;



