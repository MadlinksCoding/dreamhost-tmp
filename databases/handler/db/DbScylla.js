"use strict";

const ErrorWrapper = require("../utils/ErrorWrapper");
const DbCommonHandler = require("./DbCommonHandler");

/**
 * DbScyllaHandler - Internal Scylla/DynamoDB operations handler
 * Used by DatabaseSchemaHandler for modular Scylla-specific operations
 * Includes integrated type mapping, caching, and other utilities
 */
class DbScyllaHandler {
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
        this.scyllaTypes = new Set(["S", "N", "B"]);
        this.commonMappings = {
            string: "S", number: "N", integer: "N", int: "N", bigint: "N",
            float: "N", double: "N", decimal: "N", boolean: "N", bool: "N",
            json: "S", datetime: "N", timestamp: "N", timestamptz: "N",
            date: "S", uuid: "S", binary: "B", blob: "B"
        };
    }
    
    /**
     * Map type to Scylla/DynamoDB type
     * @param {string} type - Generic type
     * @param {object} spec - Attribute specification
     * @param {object} context - Context for logging
     * @returns {string} Scylla type (S, N, or B)
     */
    mapToScylla(type, spec = {}, context = {}) {
        const normalized = String(type || "").toLowerCase().trim();
        
        // Check if already valid
        if (this.scyllaTypes.has(normalized.toUpperCase())) {
            return normalized.toUpperCase();
        }
        
        // Try common mappings
        if (this.commonMappings[normalized]) {
            return this.commonMappings[normalized];
        }
        
        // Heuristic
        if (/(string|text|char|uuid|id|name|email|key|token)/i.test(normalized)) return "S";
        if (/(number|int|float|double|decimal|count|size|amount|age)/i.test(normalized)) return "N";
        if (/(binary|blob|bytes)/i.test(normalized)) return "B";
        
        // Log warning
        if (context.logger || this.log) {
            (context.logger || this.log)("[WARN] Unknown type for Scylla, defaulting to S", {
                type, table: context.table, attribute: context.attribute
            });
        }
        
        return "S";
    }
    
    // ==================== Caching Methods (Integrated from ExistenceCache) ====================
    
    /**
     * Initialize cache
     * @private
     */
    _initCache() {
        this.cache = new Map();
        this.cacheMaxAge = 60000; // 60 seconds
        this.cacheMaxSize = 1000;
    }
    
    /**
     * Get from cache
     * @param {string} key - Cache key
     * @returns {*} Cached value or null
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
     * @param {string} key - Cache key
     * @param {*} value - Value to cache
     * @private
     */
    _cacheSet(key, value) {
        // Evict old entries if cache is full
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
        try {
            const resp = await this.client.rawRequest("DescribeTable", { TableName: tableName });
            return !!resp?.Table?.TableStatus;
        } catch (error) {
            return false;
        }
    }

    /**
     * Check if GSI exists
     * @param {string} tableName - Table name
     * @param {string} indexName - Index name
     * @returns {Promise<boolean>}
     */
    async indexExists(tableName, indexName) {
        try {
            const resp = await this.client.rawRequest("DescribeTable", { TableName: tableName });
            const gsis = resp?.Table?.GlobalSecondaryIndexes || [];
            return gsis.some(g => g.IndexName === indexName);
        } catch (error) {
            return false;
        }
    }

    /**
     * Get table description
     * @param {string} tableName - Table name
     * @returns {Promise<object|null>}
     */
    async describeTable(tableName) {
        return await ErrorWrapper.safe(
            async () => {
                const resp = await this.client.rawRequest("DescribeTable", { TableName: tableName });
                return resp?.Table || null;
            },
            { engine: "scylla", operation: "describeTable", table: tableName }
        );
    }

    /**
     * Build CREATE TABLE payload
     * @param {string} tableName - Table name
     * @param {object} spec - Table specification
     * @param {number} tableVer - Table version
     * @returns {object} DynamoDB CreateTable payload
     */
    buildCreateTablePayload(tableName, spec, tableVer) {
        if (!spec) throw new Error(`No spec for table: ${tableName}`);

        const attributeTypes = spec.AttributeTypes || {};
        const keyAttrs = new Set();
        
        const addAttr = (name, fallback = "S") => {
            if (!name) return;
            keyAttrs.add(name);
            if (!attributeTypes[name]) {
                attributeTypes[name] = fallback;
            }
        };

        // Add primary key attributes
        addAttr(spec.PK, "S");
        if (spec.SK) addAttr(spec.SK, "S");

        // Filter and add GSI attributes
        const gsis = this.filterActiveGsis(spec.GlobalSecondaryIndexes, tableVer, tableName);
        for (const g of gsis) {
            if (Array.isArray(g.KeySchema)) {
                for (const ks of g.KeySchema) {
                    addAttr(ks.AttributeName, "S");
                }
            }
        }

        // Build AttributeDefinitions
        const AttributeDefinitions = Array.from(keyAttrs).map(name => ({
            AttributeName: name,
            AttributeType: attributeTypes[name] || "S",
        }));

        // Build KeySchema
        const KeySchema = [{ AttributeName: spec.PK, KeyType: "HASH" }];
        if (spec.SK) {
            KeySchema.push({ AttributeName: spec.SK, KeyType: "RANGE" });
        }

        const payload = { TableName: tableName, AttributeDefinitions, KeySchema };

        // Billing mode
        if (spec.BillingMode === "PROVISIONED") {
            if (!spec.ProvisionedThroughput) {
                throw new Error(`Scylla: "${tableName}" PROVISIONED requires ProvisionedThroughput`);
            }
            payload.ProvisionedThroughput = spec.ProvisionedThroughput;
        } else {
            payload.BillingMode = "PAY_PER_REQUEST";
        }

        // Add GSIs
        if (gsis.length) {
            // Validate GSIs
            for (const g of gsis) {
                if (!g.IndexName) {
                    throw new Error(`Scylla: GSI missing IndexName on table "${tableName}"`);
                }
                if (!Array.isArray(g.KeySchema) || !g.KeySchema.length) {
                    throw new Error(`Scylla: GSI "${g.IndexName}" missing KeySchema`);
                }
                if (!g.Projection || !g.Projection.ProjectionType) {
                    throw new Error(`Scylla: GSI "${g.IndexName}" missing Projection`);
                }
            }
            payload.GlobalSecondaryIndexes = gsis;
        }

        return payload;
    }

    /**
     * Build GSI create specification
     * @param {object} spec - Table specification
     * @param {string} gsiName - GSI name
     * @param {string} tableName - Table name
     * @returns {object} GSI create spec
     */
    buildCreateGsiSpec(spec, gsiName, tableName) {
        const g = (spec.GlobalSecondaryIndexes || []).find(x => x.IndexName === gsiName);
        if (!g) {
            throw new Error(`GSI spec not found for ${tableName}.${gsiName}`);
        }

        return {
            IndexName: g.IndexName,
            KeySchema: g.KeySchema,
            Projection: g.Projection,
            ...(g.ProvisionedThroughput ? { ProvisionedThroughput: g.ProvisionedThroughput } : {}),
        };
    }

    /**
     * Build missing attribute definitions for GSI
     * @param {object} spec - Table specification
     * @param {string} gsiName - GSI name
     * @param {Array} existingAttrDefs - Existing attribute definitions
     * @param {string} tableName - Table name
     * @returns {Array} Missing attribute definitions
     */
    buildMissingAttrDefsForGsi(spec, gsiName, existingAttrDefs, tableName) {
        const g = (spec.GlobalSecondaryIndexes || []).find(x => x.IndexName === gsiName);
        if (!g) {
            throw new Error(`GSI spec not found for ${tableName}.${gsiName}`);
        }

        const existing = new Map((existingAttrDefs || []).map(d => [d.AttributeName, d.AttributeType]));
        const neededAttrNames = Array.from(new Set((g.KeySchema || []).map(k => k.AttributeName)));

        const missing = [];
        for (const name of neededAttrNames) {
            if (existing.has(name)) continue;

            const attrType = this.resolveAttrType(spec, name, tableName, gsiName);
            missing.push({ AttributeName: name, AttributeType: attrType });
        }
        
        return missing;
    }

    /**
     * Resolve attribute type
     * @param {object} spec - Table specification
     * @param {string} attrName - Attribute name
     * @param {string} tableName - Table name
     * @param {string} gsiName - GSI name
     * @returns {string} Attribute type (S, N, or B)
     */
    resolveAttrType(spec, attrName, tableName, gsiName) {
        // 1) Table-level AttributeDefinitions array
        if (Array.isArray(spec.AttributeDefinitions)) {
            const hit = spec.AttributeDefinitions.find(d => d.AttributeName === attrName);
            if (hit?.AttributeType) return hit.AttributeType;
        }

        // 2) Attributes map
        const attrObj = spec.Attributes?.[attrName];
        if (attrObj) {
            const mapped = this.mapToScylla(attrObj.AttributeType || attrObj.Type, attrObj, {
                table: tableName,
                attribute: attrName,
                logger: this.log,
            });
            if (mapped) return mapped;
        }

        // 3) Columns/fields section
        const colObj = spec.Columns?.[attrName];
        if (colObj) {
            const mapped = this.mapToScylla(colObj.AttributeType || colObj.Type, colObj, {
                table: tableName,
                attribute: attrName,
                logger: this.log,
            });
            if (mapped) return mapped;
        }

        // 4) Per-table overrides
        if (spec.AttributeTypeOverrides?.[attrName]) {
            const mapped = this.mapToScylla(spec.AttributeTypeOverrides[attrName], {}, {
                table: tableName,
                attribute: attrName,
                logger: this.log,
            });
            if (mapped) return mapped;
        }

        // 5) Infer from name
        const inferred = this.mapToScylla(
            this.typeMapper.inferTypeFromName(attrName),
            {},
            { table: tableName, attribute: attrName, logger: this.log }
        );
        
        this.log("[WARN] Attribute type inferred for Scylla", {
            table: tableName,
            gsi: gsiName,
            attribute: attrName,
            inferredType: inferred,
        });

        return inferred;
    }

    /**
     * Filter active GSIs based on lifecycle
     * @param {Array} gsis - GSIs array
     * @param {number} tableVer - Table version
     * @param {string} tableName - Table name
     * @returns {Array} Active GSIs
     */
    filterActiveGsis(gsis, tableVer, tableName) {
        if (!Array.isArray(gsis)) return [];

        const active = [];
        for (const g of gsis) {
            const lifecycle = DbCommonHandler.checkLifecycle(g, tableVer, {
                engine: "scylla",
                table: tableName,
                gsi: g.IndexName,
            });
            
            if (lifecycle.active) {
                active.push(g);
            }
        }
        
        return active;
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
        const payload = this.buildCreateTablePayload(tableName, spec, tableVer);
        
        this.log("[APPLY][Scylla] CREATE TABLE", { table: tableName, payload });

        if (!dryRun) {
            return await ErrorWrapper.wrapQuery(
                () => this.client.rawRequest("CreateTable", payload),
                { engine: "scylla", operation: "createTable", table: tableName }
            );
        }
        
        return { dryRun: true, payload };
    }

    /**
     * Create GSI on existing table
     * @param {string} tableName - Table name
     * @param {string} gsiName - GSI name
     * @param {object} spec - Table specification
     * @param {boolean} dryRun - Dry run flag
     * @returns {Promise<object>} Result
     */
    async createGsi(tableName, gsiName, spec, dryRun = false) {
        const gsiCreate = this.buildCreateGsiSpec(spec, gsiName, tableName);

        // Get existing attribute definitions
        const describe = await this.client.rawRequest("DescribeTable", { TableName: tableName });
        const existingAttrDefs = describe?.Table?.AttributeDefinitions || [];

        // Compute missing attribute definitions
        const missingAttrDefs = this.buildMissingAttrDefsForGsi(spec, gsiName, existingAttrDefs, tableName);

        const payload = {
            TableName: tableName,
            ...(missingAttrDefs.length ? { AttributeDefinitions: missingAttrDefs } : {}),
            GlobalSecondaryIndexUpdates: [{ Create: gsiCreate }],
        };

        this.log("[APPLY][Scylla] CREATE GSI", {
            table: tableName,
            index: gsiName,
            payload,
        });

        if (!dryRun) {
            return await ErrorWrapper.wrapQuery(
                () => this.client.rawRequest("UpdateTable", payload),
                { engine: "scylla", operation: "createGsi", table: tableName, index: gsiName }
            );
        }
        
        return { dryRun: true, payload };
    }

    /**
     * Lookup table spec from schema JSON
     * @param {object} schemaJson - Complete schema JSON
     * @param {string} tableName - Table name
     * @returns {object|null} Table spec
     */
    static lookupTableSpec(schemaJson, tableName) {
        const tables = schemaJson?.scylla?.tables || {};
        for (const [logical, spec] of Object.entries(tables)) {
            const tn = spec.TableName || logical;
            if (tn === tableName) return spec;
        }
        return null;
    }
}

module.exports = DbScyllaHandler;



