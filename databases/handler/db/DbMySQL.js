"use strict";

const ErrorWrapper = require("../utils/ErrorWrapper");
const DbCommonHandler = require("./DbCommonHandler");

/**
 * DbMySQLHandler - Internal MySQL operations handler
 * Used by DatabaseSchemaHandler for modular MySQL-specific operations
 * Includes integrated type mapping, caching, transactions, and other utilities
 */
class DbMySQLHandler {
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
        this.mysqlTypes = new Set([
            "char", "varchar", "text", "tinytext", "mediumtext", "longtext",
            "json",
            "tinyint", "smallint", "mediumint", "int", "bigint",
            "float", "double", "decimal", "numeric",
            "date", "time", "datetime", "timestamp", "year",
            "binary", "varbinary", "blob", "tinyblob", "mediumblob", "longblob",
        ]);
        this.commonMappings = {
            string: "text", number: "int", integer: "int", int: "int",
            bigint: "bigint", float: "float", double: "double",
            decimal: "decimal", boolean: "tinyint(1)", bool: "tinyint(1)",
            json: "json", datetime: "datetime", timestamp: "datetime",
            timestamptz: "datetime", date: "date", uuid: "char(36)",
            binary: "blob", blob: "blob"
        };
    }
    
    /**
     * Map type to MySQL type
     * @param {string} type - Generic type
     * @param {object} spec - Column specification
     * @param {object} context - Context for logging
     * @returns {string} MySQL type
     */
    mapToMySQL(type, spec = {}, context = {}) {
        if (spec.mysql?.type) {
            return this.validateMySQLType(spec.mysql.type, context);
        }
        
        const normalized = String(type || "").toLowerCase().trim();
        
        if (this.mysqlTypes.has(normalized)) {
            return normalized;
        }
        
        // Handle parameterized types
        const paramMatch = normalized.match(/^([a-z]+)\(.*\)$/);
        if (paramMatch) {
            const baseType = paramMatch[1];
            if (this.mysqlTypes.has(baseType)) {
                return normalized;
            }
        }
        
        // Try common mappings
        if (this.commonMappings[normalized]) {
            return this.commonMappings[normalized];
        }
        
        // Log warning
        if (context.logger || this.log) {
            (context.logger || this.log)("[WARN] Unknown type for MySQL, defaulting to text", {
                type, table: context.table, column: context.column
            });
        }
        
        return "text";
    }
    
    /**
     * Validate MySQL type
     * @param {string} type - Type to validate
     * @param {object} context - Context
     * @returns {string} Validated type
     */
    validateMySQLType(type, context = {}) {
        const normalized = String(type).toLowerCase().trim();
        const baseType = normalized.split("(")[0].trim();
        if (!this.mysqlTypes.has(baseType)) {
            throw new Error(
                `Invalid MySQL type "${type}" for ${context.table || "unknown"}.${context.column || "unknown"}`
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
     * Check if table exists
     * @param {string} tableName - Table name
     * @returns {Promise<boolean>}
     */
    async tableExists(tableName) {
        const row = await ErrorWrapper.wrapQuery(
            () => this.client.getRow(
                "SELECT 1 AS x FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1",
                [tableName]
            ),
            { engine: "mysql", operation: "tableExists", table: tableName }
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
        const row = await ErrorWrapper.wrapQuery(
            () => this.client.getRow(
                "SELECT 1 AS x FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1",
                [tableName, columnName]
            ),
            { engine: "mysql", operation: "columnExists", table: tableName, column: columnName }
        );
        return !!row;
    }

    /**
     * Check if index exists
     * @param {string} tableName - Table name
     * @param {string} indexName - Index name
     * @returns {Promise<boolean>}
     */
    async indexExists(tableName, indexName) {
        const row = await ErrorWrapper.wrapQuery(
            () => this.client.getRow(
                "SELECT 1 AS x FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1",
                [tableName, indexName]
            ),
            { engine: "mysql", operation: "indexExists", table: tableName, index: indexName }
        );
        return !!row;
    }

    /**
     * Map type to MySQL type
     * @param {string} colName - Column name
     * @param {object} colSpec - Column specification
     * @returns {string} MySQL type
     */
    mapType(colName, colSpec = {}) {
        return this.mapToMySQL(colSpec.type || "text", colSpec, {
            table: colSpec._tableName,
            column: colName,
            logger: this.log,
        });
    }

    /**
     * Format SQL value
     * @param {*} value - Value to format
     * @returns {string} Formatted SQL value
     */
    formatSqlValue(value) {
        if (value === null) return "NULL";
        if (typeof value === "number") return String(value);
        if (typeof value === "boolean") return value ? "1" : "0";
        if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
        return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
    }

    /**
     * Build column definition SQL
     * @param {string} colName - Column name
     * @param {object} colSpec - Column specification
     * @returns {string} Column definition SQL
     */
    buildColumnDefSql(colName, colSpec = {}) {
        const quotedName = DbCommonHandler.quoteIdentifierMysql(colName);
        const type = this.mapType(colName, colSpec);
        
        let sql = `${quotedName} ${type}`;
        
        if (colSpec.notNull) {
            sql += " NOT NULL";
        }
        
        if (colSpec.autoIncrement) {
            // Validate AUTO_INCREMENT usage
            if (!colSpec.primary && !colSpec.unique) {
                this.log("[WARN] AUTO_INCREMENT without PRIMARY KEY or UNIQUE", {
                    table: colSpec._tableName,
                    column: colName,
                });
            }
            sql += " AUTO_INCREMENT";
        }
        
        if (colSpec.default !== undefined) {
            const defaultValue = colSpec.default;
            
            // Check if it's a function/expression
            const isFunc = typeof defaultValue === "string" && /^[A-Za-z_]+\(/.test(defaultValue);
            
            if (isFunc) {
                sql += ` DEFAULT ${defaultValue}`;
            } else {
                sql += ` DEFAULT ${this.formatSqlValue(defaultValue)}`;
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
            .filter(([, c]) => !!c.primary)
            .map(([n]) => DbCommonHandler.quoteIdentifierMysql(n));
    }

    /**
     * Build CREATE TABLE SQL
     * @param {string} tableName - Table name
     * @param {object} spec - Table specification
     * @param {number} tableVer - Table version
     * @returns {string} CREATE TABLE SQL
     */
    buildCreateTableSql(tableName, spec, tableVer) {
        const quotedTable = DbCommonHandler.quoteIdentifierMysql(tableName);
        
        const colDefs = [];
        
        for (const [col, cSpec] of Object.entries(spec.columns || {})) {
            const lifecycle = LifecycleChecker.check(cSpec, tableVer, {
                engine: "mysql",
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
        
        const engine = spec.mysql?.engine || "InnoDB";
        const charset = spec.mysql?.charset || "utf8mb4";
        
        return `CREATE TABLE IF NOT EXISTS ${quotedTable} (\n  ${colDefs.join(",\n  ")}\n) ENGINE=${engine} DEFAULT CHARSET=${charset}`;
    }

    /**
     * Build CREATE INDEX SQL
     * @param {string} tableName - Table name
     * @param {string} indexName - Index name
     * @param {object} idxSpec - Index specification
     * @returns {string} CREATE INDEX SQL
     */
    buildCreateIndexSql(tableName, indexName, idxSpec) {
        const quotedTable = DbCommonHandler.quoteIdentifierMysql(tableName);
        const quotedIndex = DbCommonHandler.quoteIdentifierMysql(indexName);
        
        const unique = idxSpec?.unique ? "UNIQUE " : "";
        const cols = (idxSpec?.columns || [])
            .map(c => DbCommonHandler.quoteIdentifierMysql(c))
            .join(", ");
        
        return `CREATE ${unique}INDEX ${quotedIndex} ON ${quotedTable} (${cols})`;
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
        
        this.log("[APPLY][MySQL] CREATE TABLE", { table: tableName, sql });

        if (!dryRun) {
            await ErrorWrapper.wrapQuery(
                () => this.client.query(sql),
                { engine: "mysql", operation: "createTable", table: tableName }
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
        const quotedTable = DbCommonHandler.quoteIdentifierMysql(tableName);
        
        colSpec._tableName = tableName;
        const columnDef = this.buildColumnDefSql(columnName, colSpec);
        
        const sql = `ALTER TABLE ${quotedTable} ADD COLUMN ${columnDef}`;
        
        this.log("[APPLY][MySQL] ADD COLUMN", { table: tableName, column: columnName, sql });

        if (!dryRun) {
            await ErrorWrapper.wrapQuery(
                () => this.client.query(sql),
                { engine: "mysql", operation: "addColumn", table: tableName, column: columnName }
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
        
        this.log("[APPLY][MySQL] CREATE INDEX", { table: tableName, index: indexName, sql });

        if (!dryRun) {
            await ErrorWrapper.wrapQuery(
                () => this.client.query(sql),
                { engine: "mysql", operation: "createIndex", table: tableName, index: indexName }
            );
        }
        
        return { dryRun, sql };
    }
}

module.exports = DbMySQLHandler;



