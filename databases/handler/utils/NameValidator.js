"use strict";

/**
 * NameValidator - Validates and converts table/column names to PascalCase
 * Addresses audit issue: lack of case validation (case usage)
 */
class NameValidator {
    /**
     * Validate a database identifier
     * @param {string} name - Name to validate
     * @param {string} type - Type of identifier ("table", "column", "index")
     * @throws {Error} If name is invalid
     */
    static validate(name, type = "identifier") {
        if (typeof name !== "string") {
            throw new Error(`${type} name must be a string: ${typeof name}`);
        }
        
        if (name.length === 0) {
            throw new Error(`${type} name cannot be empty`);
        }
        
        if (name.length > 63) {
            throw new Error(`${type} name too long (max 63 chars): ${name}`);
        }
        
        // Check for invalid characters
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            throw new Error(
                `Invalid ${type} name "${name}". Must start with letter or underscore, ` +
                `contain only letters, numbers, and underscores.`
            );
        }
        
        // Check for SQL reserved words (common ones)
        const reserved = new Set([
            "select", "insert", "update", "delete", "drop", "create", "alter",
            "table", "index", "database", "schema", "user", "role", "grant",
            "revoke", "commit", "rollback", "transaction", "join", "union",
            "where", "order", "group", "having", "limit", "offset", "values",
        ]);
        
        if (reserved.has(name.toLowerCase())) {
            throw new Error(`${type} name "${name}" is a SQL reserved word`);
        }
    }

    /**
     * Convert name to PascalCase
     * @param {string} name - Name to convert
     * @returns {string} PascalCase name
     */
    static toPascalCase(name) {
        if (typeof name !== "string") {
            throw new Error(`Cannot convert non-string to PascalCase: ${typeof name}`);
        }
        
        // Handle empty string
        if (name.length === 0) return name;
        
        // If already PascalCase, return as-is
        if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) {
            return name;
        }
        
        // Convert snake_case or camelCase to PascalCase
        return name
            .split(/[_-]/)
            .map(word => {
                if (word.length === 0) return "";
                return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
            })
            .join("");
    }

    /**
     * Convert name to snake_case
     * @param {string} name - Name to convert
     * @returns {string} snake_case name
     */
    static toSnakeCase(name) {
        if (typeof name !== "string") {
            throw new Error(`Cannot convert non-string to snake_case: ${typeof name}`);
        }
        
        // Handle empty string
        if (name.length === 0) return name;
        
        // If already snake_case, return as-is
        if (/^[a-z][a-z0-9_]*$/.test(name)) {
            return name;
        }
        
        // Convert PascalCase or camelCase to snake_case
        return name
            .replace(/([A-Z])/g, "_$1")
            .toLowerCase()
            .replace(/^_/, "");
    }

    /**
     * Validate and auto-convert to PascalCase
     * @param {string} name - Name to process
     * @param {string} type - Type of identifier
     * @param {boolean} autoConvert - Whether to auto-convert (default: true)
     * @returns {string} Validated (and possibly converted) name
     */
    static validateAndConvert(name, type = "identifier", autoConvert = true) {
        // First validate basic format
        this.validate(name, type);
        
        // If auto-convert is enabled, convert to PascalCase
        if (autoConvert) {
            return this.toPascalCase(name);
        }
        
        return name;
    }

    /**
     * Check if name is in PascalCase
     * @param {string} name - Name to check
     * @returns {boolean}
     */
    static isPascalCase(name) {
        return typeof name === "string" && /^[A-Z][a-zA-Z0-9]*$/.test(name);
    }

    /**
     * Check if name is in snake_case
     * @param {string} name - Name to check
     * @returns {boolean}
     */
    static isSnakeCase(name) {
        return typeof name === "string" && /^[a-z][a-z0-9_]*$/.test(name);
    }

    /**
     * Normalize table/column names in a schema object
     * @param {object} schema - Schema object to normalize
     * @param {boolean} autoConvert - Whether to auto-convert names
     * @returns {object} Normalized schema
     */
    static normalizeSchema(schema, autoConvert = true) {
        if (!schema || typeof schema !== "object") {
            throw new Error("Schema must be an object");
        }
        
        const normalized = {};
        
        for (const [engine, engineSchema] of Object.entries(schema)) {
            if (!engineSchema?.tables) continue;
            
            normalized[engine] = { tables: {} };
            
            for (const [tableName, tableSpec] of Object.entries(engineSchema.tables)) {
                const validTableName = autoConvert 
                    ? this.toPascalCase(tableName)
                    : tableName;
                
                this.validate(validTableName, "table");
                
                normalized[engine].tables[validTableName] = {
                    ...tableSpec,
                    columns: this.normalizeColumns(tableSpec.columns || {}, autoConvert),
                };
            }
        }
        
        return normalized;
    }

    /**
     * Normalize column names in a columns object
     * @param {object} columns - Columns object
     * @param {boolean} autoConvert - Whether to auto-convert names
     * @returns {object} Normalized columns
     */
    static normalizeColumns(columns, autoConvert = true) {
        const normalized = {};
        
        for (const [colName, colSpec] of Object.entries(columns)) {
            const validColName = autoConvert 
                ? this.toPascalCase(colName)
                : colName;
            
            this.validate(validColName, "column");
            normalized[validColName] = colSpec;
        }
        
        return normalized;
    }
}

module.exports = NameValidator;










