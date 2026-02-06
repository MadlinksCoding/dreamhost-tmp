"use strict";

const ConfigLoader = require("../config/ConfigLoader");

/**
 * DbCommonHandler - Shared utilities for all database engines
 * Used by DatabaseSchemaHandler and engine-specific handlers
 */
class DbCommonHandler {
    /**
     * Validate SQL identifier
     * @param {string} identifier - Identifier to validate
     * @param {string} type - Type of identifier (table, column, index)
     * @throws {Error} If identifier is invalid
     */
    static validateIdentifier(identifier, type = "identifier") {
        ConfigLoader.validateIdentifier(identifier);
    }

    /**
     * Quote SQL identifier for PostgreSQL
     * @param {string} identifier - Identifier to quote
     * @returns {string} Quoted identifier
     */
    static quoteIdentifierPg(identifier) {
        this.validateIdentifier(identifier);
        return `"${identifier.replace(/"/g, '""')}"`;
    }

    /**
     * Quote SQL identifier for MySQL
     * @param {string} identifier - Identifier to quote
     * @returns {string} Quoted identifier
     */
    static quoteIdentifierMysql(identifier) {
        this.validateIdentifier(identifier);
        return `\`${identifier.replace(/`/g, "``")}\``;
    }

    /**
     * Check lifecycle status of an item
     * @param {object} obj - Object with since/removed_in properties
     * @param {number} tableVer - Current table version
     * @returns {object} Lifecycle status
     */
    static checkLifecycle(obj, tableVer) {
        const numOrU = (v) => (v === undefined ? undefined : parseFloat(String(v)));
        const since = numOrU(obj?.since);
        const removed = numOrU(obj?.removed_in);
        
        // Validate version numbers
        if (since !== undefined && (!Number.isFinite(since) || since < 0)) {
            throw new Error(`Invalid 'since' version: ${since}`);
        }
        if (removed !== undefined && (!Number.isFinite(removed) || removed < 0)) {
            throw new Error(`Invalid 'removed_in' version: ${removed}`);
        }
        
        const future = typeof since === "number" && tableVer < since;
        const removeNow = typeof removed === "number" && tableVer >= removed;
        const active = !future && !removeNow;
        
        return { since, removed, future, removeNow, active };
    }

    /**
     * Normalize table name (handle logical vs physical names)
     * @param {object} spec - Table specification
     * @param {string} logicalName - Logical table name
     * @returns {string} Physical table name
     */
    static normalizeTableName(spec, logicalName) {
        return spec?.TableName || logicalName;
    }

    /**
     * Validate table specification
     * @param {object} spec - Table specification
     * @param {string} tableName - Table name
     * @throws {Error} If specification is invalid
     */
    static validateTableSpec(spec, tableName) {
        if (!spec || typeof spec !== "object") {
            throw new Error(`Invalid table specification for "${tableName}"`);
        }
    }

    /**
     * Validate column specification
     * @param {object} spec - Column specification
     * @param {string} columnName - Column name
     * @param {string} tableName - Table name
     * @throws {Error} If specification is invalid
     */
    static validateColumnSpec(spec, columnName, tableName) {
        if (!spec || typeof spec !== "object") {
            throw new Error(`Invalid column specification for "${tableName}.${columnName}"`);
        }
        
        if (!spec.type) {
            throw new Error(`Column "${tableName}.${columnName}" missing type`);
        }
    }

    /**
     * Validate index specification
     * @param {object} spec - Index specification
     * @param {string} indexName - Index name
     * @param {string} tableName - Table name
     * @throws {Error} If specification is invalid
     */
    static validateIndexSpec(spec, indexName, tableName) {
        if (!spec || typeof spec !== "object") {
            throw new Error(`Invalid index specification for "${tableName}.${indexName}"`);
        }
        
        if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
            throw new Error(`Index "${tableName}.${indexName}" must have columns array`);
        }
    }

    /**
     * Generate default index name
     * @param {string} tableName - Table name
     * @param {Array<string>} columns - Column names
     * @param {string} suffix - Optional suffix
     * @returns {string} Index name
     */
    static generateIndexName(tableName, columns, suffix = "idx") {
        const colPart = Array.isArray(columns) ? columns.join("_") : String(columns);
        return `${tableName}_${colPart}_${suffix}`;
    }

    /**
     * Merge default configuration with overrides
     * @param {object} defaults - Default configuration
     * @param {object} overrides - Configuration overrides
     * @returns {object} Merged configuration
     */
    static mergeConfig(defaults, overrides) {
        return { ...defaults, ...overrides };
    }

    /**
     * Deep clone an object
     * @param {*} obj - Object to clone
     * @returns {*} Cloned object
     */
    static deepClone(obj) {
        if (obj === null || typeof obj !== "object") return obj;
        if (Array.isArray(obj)) return obj.map(item => this.deepClone(item));
        
        const cloned = {};
        for (const [key, value] of Object.entries(obj)) {
            cloned[key] = this.deepClone(value);
        }
        return cloned;
    }

    /**
     * Check if value is a plain object
     * @param {*} value - Value to check
     * @returns {boolean}
     */
    static isPlainObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    /**
     * Safe JSON stringify with error handling
     * @param {*} value - Value to stringify
     * @param {number} maxLength - Maximum length
     * @returns {string}
     */
    static safeStringify(value, maxLength = 1000) {
        try {
            const str = JSON.stringify(value);
            if (str.length > maxLength) {
                return str.substring(0, maxLength) + "... (truncated)";
            }
            return str;
        } catch (error) {
            return `[Unstringifiable: ${typeof value}]`;
        }
    }

    /**
     * Filter active items from array based on lifecycle
     * @param {Array} items - Items to filter
     * @param {number} tableVer - Table version
     * @param {Function} getLifecycle - Function to get lifecycle from item
     * @returns {Array} Active items
     */
    static filterActiveItems(items, tableVer, getLifecycle = (item) => item) {
        if (!Array.isArray(items)) return [];
        
        return items.filter(item => {
            const lifecycleObj = getLifecycle(item);
            const lifecycle = this.checkLifecycle(lifecycleObj, tableVer);
            return lifecycle.active;
        });
    }

    /**
     * Partition items by lifecycle status
     * @param {Array} items - Items to partition
     * @param {number} tableVer - Table version
     * @returns {object} Partitioned items (active, future, removed)
     */
    static partitionByLifecycle(items, tableVer) {
        const active = [];
        const future = [];
        const removed = [];
        
        for (const item of items || []) {
            const lifecycle = this.checkLifecycle(item, tableVer);
            if (lifecycle.active) active.push(item);
            else if (lifecycle.future) future.push(item);
            else if (lifecycle.removeNow) removed.push(item);
        }
        
        return { active, future, removed };
    }

    /**
     * Validate version compatibility
     * @param {number} schemaVersion - Schema version
     * @param {number} envVersion - Environment version
     * @param {string} tableName - Table name
     * @returns {object} Compatibility result
     */
    static validateVersionCompatibility(schemaVersion, envVersion, tableName) {
        if (!Number.isFinite(schemaVersion)) {
            return {
                compatible: false,
                warning: `Schema version for ${tableName} is not a valid number`,
            };
        }
        
        if (!Number.isFinite(envVersion)) {
            return {
                compatible: false,
                warning: `Environment version for ${tableName} is not a valid number`,
            };
        }
        
        if (schemaVersion > envVersion) {
            return {
                compatible: false,
                warning: `Schema version (${schemaVersion}) is higher than environment version (${envVersion}) for ${tableName}`,
            };
        }
        
        return { compatible: true };
    }
    // ==================== Lifecycle Management Methods ====================
    // (Integrated from LifecycleChecker)
    
    /**
     * Check lifecycle status of an item
     * @param {object} obj - Object with since/removed_in properties
     * @param {number} version - Current version
     * @param {object} context - Context for logging/errors
     * @returns {object} Lifecycle status
     */
    static checkLifecycle(obj, version, context = {}) {
        if (!obj) {
            return { since: undefined, removed: undefined, future: false, removeNow: false, active: true };
        }
        
        const since = this.parseLifecycleVersion(obj.since, "since", context);
        const removed = this.parseLifecycleVersion(obj.removed_in, "removed_in", context);
        
        // Validate that removed_in is greater than since
        if (since !== undefined && removed !== undefined && removed <= since) {
            throw new Error(
                `Invalid lifecycle: removed_in (${removed}) must be greater than since (${since}) ` +
                `for ${this.formatLifecycleContext(context)}`
            );
        }
        
        const future = since !== undefined && version < since;
        const removeNow = removed !== undefined && version >= removed;
        const active = !future && !removeNow;
        
        return { since, removed, future, removeNow, active };
    }
    
    /**
     * Parse version from value
     * @param {*} value - Value to parse
     * @param {string} field - Field name (for error messages)
     * @param {object} context - Context for error messages
     * @returns {number|undefined} Parsed version
     */
    static parseLifecycleVersion(value, field, context = {}) {
        if (value === undefined || value === null) {
            return undefined;
        }
        
        const parsed = parseFloat(String(value));
        
        if (!Number.isFinite(parsed)) {
            throw new Error(
                `Invalid ${field} version "${value}" for ${this.formatLifecycleContext(context)}`
            );
        }
        
        if (parsed < 0) {
            throw new Error(
                `${field} version must be non-negative (got ${parsed}) for ${this.formatLifecycleContext(context)}`
            );
        }
        
        return parsed;
    }
    
    /**
     * Format context for error messages
     * @param {object} context - Context object
     * @returns {string} Formatted context
     */
    static formatLifecycleContext(context) {
        const parts = [];
        if (context.engine) parts.push(context.engine);
        if (context.table) parts.push(`table:${context.table}`);
        if (context.column) parts.push(`column:${context.column}`);
        if (context.index) parts.push(`index:${context.index}`);
        if (context.gsi) parts.push(`gsi:${context.gsi}`);
        return parts.length ? parts.join(" ") : "unknown item";
    }
    
    /**
     * Filter array to only active items
     * @param {Array} items - Items to filter
     * @param {number} version - Current version
     * @param {Function} extractLifecycle - Function to extract lifecycle object from item
     * @param {object} context - Context for logging
     * @returns {Array} Active items
     */
    static filterActiveItems(items, version, extractLifecycle = (item) => item, context = {}) {
        if (!Array.isArray(items)) return [];
        
        return items.filter((item, index) => {
            const lifecycleObj = extractLifecycle(item);
            const itemContext = { ...context, index };
            const lifecycle = this.checkLifecycle(lifecycleObj, version, itemContext);
            return lifecycle.active;
        });
    }
    
    /**
     * Partition items by lifecycle status
     * @param {Array} items - Items to partition
     * @param {number} version - Current version
     * @param {Function} extractLifecycle - Function to extract lifecycle object
     * @param {object} context - Context for logging
     * @returns {object} Partitioned items
     */
    static partitionItemsByLifecycle(items, version, extractLifecycle = (item) => item, context = {}) {
        const active = [];
        const future = [];
        const removed = [];
        
        for (let i = 0; i < (items || []).length; i++) {
            const item = items[i];
            const lifecycleObj = extractLifecycle(item);
            const itemContext = { ...context, index: i };
            const lifecycle = this.checkLifecycle(lifecycleObj, version, itemContext);
            
            if (lifecycle.active) active.push(item);
            else if (lifecycle.future) future.push(item);
            else if (lifecycle.removeNow) removed.push(item);
        }
        
        return { active, future, removed };
    }
    
    /**
     * Get lifecycle summary for logging
     * @param {object} lifecycle - Lifecycle status
     * @returns {string} Summary string
     */
    static getLifecycleSummary(lifecycle) {
        if (lifecycle.active) return "active";
        if (lifecycle.future) return `future (since ${lifecycle.since})`;
        if (lifecycle.removeNow) return `removed (removed_in ${lifecycle.removed})`;
        return "unknown";
    }
}

module.exports = DbCommonHandler;



