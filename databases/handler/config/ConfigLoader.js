"use strict";

const Ajv = require("ajv");
const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * ConfigLoader - Validates and loads configuration from environment variables
 * Addresses audit issues: unscoped env parsing, lack of input validation
 */
class ConfigLoader {
    constructor() {
        this.schema = {
            type: "object",
            properties: {
                // PostgreSQL
                PGUSER: { type: "string" },
                PGHOST: { type: "string" },
                PGDATABASE: { type: "string" },
                PGPASSWORD: { type: "string" },
                PGPORT: { type: ["string", "number"] },
                PG_SCHEMA: { type: "string", pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$" },
                
                // MySQL
                DB_HOST: { type: "string" },
                DB_USER: { type: "string" },
                DB_PASS: { type: "string" },
                DB_NAME: { type: "string" },
                DB_PORT: { type: ["string", "number"] },
                
                // Scylla
                SCYLLA_ENDPOINT: { type: "string" },
                SCYLLA_REGION: { type: "string" },
                SCYLLA_ACCESS_KEY_ID: { type: "string" },
                SCYLLA_SECRET_ACCESS_KEY: { type: "string" },
                
                // General
                NODE_ENV: { type: "string", enum: ["development", "staging", "production", "test"] },
                DB_IS_DOCKER: { type: ["string", "number", "boolean"] },
            },
        };
        
        this.validate = ajv.compile(this.schema);
    }

    /**
     * Load and validate environment configuration
     * @param {object} env - Environment object (defaults to process.env)
     * @returns {object} Validated configuration
     * @throws {Error} If validation fails
     */
    load(env = process.env) {
        const config = {};
        
        // Extract only defined environment variables
        for (const key of Object.keys(this.schema.properties)) {
            if (env[key] !== undefined) {
                config[key] = env[key];
            }
        }
        
        // Validate configuration
        const valid = this.validate(config);
        if (!valid) {
            const errors = this.validate.errors.map(e => `${e.instancePath} ${e.message}`).join(", ");
            throw new Error(`Configuration validation failed: ${errors}`);
        }
        
        return this.normalize(config);
    }

    /**
     * Normalize configuration values to correct types
     * @param {object} config - Raw configuration
     * @returns {object} Normalized configuration
     */
    normalize(config) {
        const normalized = { ...config };
        
        // Convert port numbers
        if (normalized.PGPORT) {
            normalized.PGPORT = parseInt(normalized.PGPORT, 10);
        }
        if (normalized.DB_PORT) {
            normalized.DB_PORT = parseInt(normalized.DB_PORT, 10);
        }
        
        // Convert boolean flags
        if (normalized.DB_IS_DOCKER !== undefined) {
            normalized.DB_IS_DOCKER = this.parseBoolean(normalized.DB_IS_DOCKER);
        }
        
        // Set defaults
        normalized.NODE_ENV = normalized.NODE_ENV || "development";
        normalized.PGPORT = normalized.PGPORT || 5432;
        normalized.DB_PORT = normalized.DB_PORT || 3306;
        normalized.PG_SCHEMA = normalized.PG_SCHEMA || "public";
        
        return normalized;
    }

    /**
     * Safely parse boolean from various input types
     * @param {*} value - Value to parse
     * @returns {boolean}
     */
    parseBoolean(value) {
        if (typeof value === "boolean") return value;
        if (typeof value === "number") return value !== 0;
        if (typeof value === "string") {
            const lower = value.toLowerCase().trim();
            return lower === "true" || lower === "1" || lower === "yes";
        }
        return false;
    }

    /**
     * Get table version from environment
     * @param {string} engine - "scylla", "postgres", or "mysql"
     * @param {string} tableName - Table name
     * @param {object} env - Environment object
     * @returns {number} Version number (defaults to 1.0)
     */
    static getTableVersion(engine, tableName, env = process.env) {
        const engKey = engine === "postgres" ? "PG" : engine === "mysql" ? "MYSQL" : "SCYLLA";
        const tblKey = String(tableName).replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
        const envKey = `${engKey}_${tblKey}_VERSION`;
        const raw = env[envKey];
        
        if (raw === undefined) return 1.0;
        
        const v = parseFloat(raw);
        if (!Number.isFinite(v) || v < 0) {
            throw new Error(`Invalid version for ${envKey}: ${raw}`);
        }
        
        return v;
    }

    /**
     * Validate identifier (table/column name)
     * @param {string} identifier - Identifier to validate
     * @throws {Error} If identifier is invalid
     */
    static validateIdentifier(identifier) {
        if (typeof identifier !== "string") {
            throw new Error(`Identifier must be a string: ${typeof identifier}`);
        }
        
        if (identifier.length === 0) {
            throw new Error("Identifier cannot be empty");
        }
        
        if (identifier.length > 63) {
            throw new Error(`Identifier too long (max 63 chars): ${identifier}`);
        }
        
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
            throw new Error(`Invalid identifier format: ${identifier}`);
        }
    }
}

module.exports = ConfigLoader;










