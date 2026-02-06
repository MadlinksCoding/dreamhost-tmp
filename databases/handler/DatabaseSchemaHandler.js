"use strict";

// Import internal handler classes
const DbCommonHandler = require("./db/DbCommonHandler");
const DbScyllaHandler = require("./db/DbScylla");
const DbPostgreSQLHandler = require("./db/DbPostgreSQL");
const DbMySQLHandler = require("./db/DbMySQL");

/**
 * DatabaseSchemaHandler (per-table versions | FULL validation + verbose logging)
 *
 * Main class that orchestrates schema changes across all database engines.
 * Uses 4 internal handler classes for modular organization:
 * - DbCommonHandler: Shared utilities
 * - DbScyllaHandler: Scylla-specific operations
 * - DbPostgreSQLHandler: PostgreSQL-specific operations
 * - DbMySQLHandler: MySQL-specific operations
 *
 * - tableType values: "scylla", "postgres", "mysql" (no "relational")
 * - Reads versions per-table per-engine from a single .env:
 *    PG_<TABLE>_VERSION, MYSQL_<TABLE>_VERSION, SCYLLA_<TABLE>_VERSION  (e.g., PG_USERS_VERSION=2.2)
 * - Non-destructive: only CREATE TABLE, ADD COLUMN, CREATE INDEX (report drops).
 * - Scylla (Alternator): CREATE TABLE + GSIs only at creation; attributes are schemaless on write.
 * - Provides:
 *    planSchemaChanges()  -> { addsToApply, removalsToReport, futureItems, meta }
 *    applySchema()        -> executes additive changes
 *    finalValidate()      -> validates DBs match ACTIVE items for the current versions
 * - Console logs:
 *    - Versions detected from env per table
 *    - Expected results per engine
 *    - Adds applied
 *    - Items that SHOULD be removed manually
 *    - Errors with context
 */

class DatabaseSchemaHandler {
    constructor({ scylla = null, pg = null, mysql = null, logger = null } = {}) {
        this.ScyllaDb = scylla;
        this.pg = pg;
        this.mysql = mysql;
        this.log = typeof logger === "function" ? logger : (msg, meta) => console.log(msg, meta ?? "");
        
        // Initialize internal handler classes
        this.scyllaHandler = scylla ? new DbScyllaHandler(scylla, this.log) : null;
        this.postgresHandler = pg ? new DbPostgreSQLHandler(pg, this.log) : null;
        this.mysqlHandler = mysql ? new DbMySQLHandler(mysql, this.log) : null;
        this.commonHandler = DbCommonHandler;
    }

    /* =============================== PUBLIC =============================== */

    async planSchemaChanges(schemaJson, opts = {}) {
        if (!schemaJson || typeof schemaJson !== "object") throw new Error("planSchemaChanges: schemaJson must be an object");

        const targets = this.#resolveTargets(opts.targets);

        const addsToApply = { scylla: [], postgres: [], mysql: [] };
        const removalsToReport = { scylla: [], postgres: [], mysql: [] };
        const futureItems = { scylla: [], postgres: [], mysql: [] };
        const versionsMeta = { scylla: {}, postgres: {}, mysql: {} };

        /* ---- Scylla ---- */
        if (targets.has("scylla") && this.ScyllaDb) {
            const tables = schemaJson?.scylla?.tables || {};
            for (const [logicalName, spec] of Object.entries(tables)) {
                const tableName = spec.TableName || logicalName;
                const tableVer = this.#readTableVersion("scylla", tableName);
                versionsMeta.scylla[tableName] = tableVer;

                const life = this.#lifecycle(spec, tableVer);
                if (life.removeNow) {
                    removalsToReport.scylla.push({ type: "table", table: tableName, reason: `removed_in=${spec.removed_in}` });
                    continue;
                }

                if (life.future) {
                    futureItems.scylla.push({ type: "table", table: tableName, reason: `since=${spec.since}` });
                    continue;
                }

                const exists = await this.#scyllaTableExists(tableName);
                const gsisActive = this.#filterActiveGsi(spec.GlobalSecondaryIndexes, tableVer, futureItems.scylla, removalsToReport.scylla, tableName);

                if (!exists) {
                    console.log({ type: "table", table: tableName, withGSIs: gsisActive.map(g => g.IndexName) });
                    addsToApply.scylla.push({ type: "table", table: tableName, withGSIs: gsisActive.map(g => g.IndexName) });
                } else {
                    const missingGsiNames = [];
                    for (const g of gsisActive) {
                        const gsiName = g.IndexName;
                        const present = await this.#scyllaIndexExists(tableName, gsiName);

                        if (!present) {
                            missingGsiNames.push(gsiName);
                            addsToApply.scylla.push({ type: "gsi", table: tableName, index: gsiName });
                        }
                    }
                }
            }
        }

        /* ---- Postgres ---- */
        if (targets.has("postgres") && this.pg) {
            const tables = schemaJson?.postgres?.tables || {};
            for (const [tableName, spec] of Object.entries(tables)) {
                const tableVer = this.#readTableVersion("postgres", tableName);
                versionsMeta.postgres[tableName] = tableVer;
                const tLife = this.#lifecycle(spec, tableVer);

                if (tLife.removeNow) {
                    removalsToReport.postgres.push({ type: "table", table: tableName, reason: `removed_in=${spec.removed_in}` });
                    continue;
                }

                if (tLife.future) {
                    futureItems.postgres.push({ type: "table", table: tableName, reason: `since=${spec.since}` });
                    continue;
                }

                const exists = await this.#pgTableExists(tableName);
                if (!exists) {
                    addsToApply.postgres.push({ type: "table", table: tableName });
                }

                // Columns
                for (const [col, cSpec] of Object.entries(spec.columns || {})) {
                    const life = this.#lifecycle(cSpec, tableVer);
                    if (life.removeNow) {
                        removalsToReport.postgres.push({ type: "column", table: tableName, column: col, reason: `removed_in=${cSpec.removed_in}` });
                        continue;
                    }

                    if (life.future) {
                        futureItems.postgres.push({ type: "column", table: tableName, column: col, reason: `since=${cSpec.since}` });
                        continue;
                    }

                    if (exists) {
                        const has = await this.#pgColumnExists(tableName, col);
                        if (!has) {
                            addsToApply.postgres.push({ type: "column", table: tableName, column: col });
                        }
                    }
                }
                ////////////
                // Indexes
                for (const idx of spec.indexes || []) {
                    const name = idx.name || `${tableName}_${(idx.columns || []).join("_")}_idx`;
                    const life = this.#lifecycle(idx, tableVer);

                    if (life.removeNow) {
                        removalsToReport.postgres.push({ type: "index", table: tableName, index: name, reason: `removed_in=${idx.removed_in}` });
                        continue;
                    }

                    if (life.future) {
                        futureItems.postgres.push({ type: "index", table: tableName, index: name, reason: `since=${idx.since}` });
                        continue;
                    }

                    const existsIdx = await this.#pgIndexExists(name);
                    if (!existsIdx) {
                        addsToApply.postgres.push({ type: "index", table: tableName, index: name });
                    }
                }
            }
        }

        /* ---- MySQL ---- */
        if (targets.has("mysql") && this.mysql) {
            const tables = schemaJson.mysql?.tables || {};
            for (const [tableName, spec] of Object.entries(tables)) {
                const tableVer = this.#readTableVersion("mysql", tableName);

                versionsMeta.mysql[tableName] = tableVer;

                const tLife = this.#lifecycle(spec, tableVer);

                if (tLife.removeNow) {
                    removalsToReport.mysql.push({ type: "table", table: tableName, reason: `removed_in=${spec.removed_in}` });
                    continue;
                }

                if (tLife.future) {
                    futureItems.mysql.push({ type: "table", table: tableName, reason: `since=${spec.since}` });
                    continue;
                }

                const exists = await this.#myTableExists(tableName);
                if (!exists) addsToApply.mysql.push({ type: "table", table: tableName });

                for (const [col, cSpec] of Object.entries(spec.columns || {})) {
                    const life = this.#lifecycle(cSpec, tableVer);

                    if (life.removeNow) {
                        removalsToReport.mysql.push({ type: "column", table: tableName, column: col, reason: `removed_in=${cSpec.removed_in}` });
                        continue;
                    }

                    if (life.future) {
                        futureItems.mysql.push({ type: "column", table: tableName, column: col, reason: `since=${cSpec.since}` });
                        continue;
                    }

                    if (exists) {
                        const has = await this.#myColumnExists(tableName, col);
                        if (!has) addsToApply.mysql.push({ type: "column", table: tableName, column: col });
                    }
                }

                for (const idx of spec.indexes || []) {
                    const name = idx.name || `${tableName}_${(idx.columns || []).join("_")}_idx`;
                    const life = this.#lifecycle(idx, tableVer);

                    if (life.removeNow) {
                        removalsToReport.mysql.push({ type: "index", table: tableName, index: name, reason: `removed_in=${idx.removed_in}` });
                        continue;
                    }

                    if (life.future) {
                        futureItems.mysql.push({ type: "index", table: tableName, index: name, reason: `since=${idx.since}` });
                        continue;
                    }

                    const existsIdx = await this.#myIndexExists(tableName, name);
                    if (!existsIdx) addsToApply.mysql.push({ type: "index", table: tableName, index: name });
                }
            }
        }

        const meta = { versions: versionsMeta, targets: Array.from(targets) };

        this.#logPlanSummary(meta, addsToApply, removalsToReport, futureItems);

        return { addsToApply, removalsToReport, futureItems, meta };
    }

    async applySchema(schemaJson, opts = {}) {
        const dryRun = !!opts.dryRun;
        const { addsToApply, removalsToReport, futureItems, meta } = await this.planSchemaChanges(schemaJson, opts);
        let addsApplied = 0;

        // Scylla
        if (meta.targets.includes("scylla") && this.ScyllaDb) {
            // 1) CREATE TABLES
            for (const i of addsToApply.scylla.filter(x => x.type === "table")) {
                const spec = this.#lookupScyllaSpec(schemaJson, i.table);
                const tableVer = this.#readTableVersion("scylla", i.table);
                const payload = this.#scyllaBuildCreateTablePayload(i.table, spec, tableVer);

                this.log("[APPLY][Scylla] CREATE TABLE", { table: i.table, payload });

                if (!dryRun) {
                    await this.ScyllaDb.rawRequest("CreateTable", payload);
                }
                addsApplied++;
            }

            // 2) CREATE MISSING GSIs ON EXISTING TABLES
            for (const i of addsToApply.scylla.filter(x => x.type === "gsi")) {
                const spec = this.#lookupScyllaSpec(schemaJson, i.table);
                const tableVer = this.#readTableVersion("scylla", i.table);

                // Build the GSI "Create" descriptor
                const gsiCreate = this.#scyllaBuildCreateGsiSpec(i.table, spec, i.index, tableVer);

                // Describe table to learn existing AttributeDefinitions
                const describe = await this.ScyllaDb.rawRequest("DescribeTable", { TableName: i.table });
                const existingAttrDefs = describe?.Table?.AttributeDefinitions || [];

                // Compute only the missing AttributeDefinitions required by this GSI
                const missingAttrDefs = this.#scyllaBuildMissingAttrDefsForGsi(i.table, spec, i.index, existingAttrDefs);

                const payload = {
                    TableName: i.table,
                    // IMPORTANT: Top-level AttributeDefinitions for any new attributes used by the GSI keys
                    ...(missingAttrDefs.length ? { AttributeDefinitions: missingAttrDefs } : {}),
                    GlobalSecondaryIndexUpdates: [{ Create: gsiCreate }],
                };

                this.log("[APPLY][Scylla] CREATE GSI", {
                    table: i.table, index: i.index, payloadNoDefs: { ...payload, AttributeDefinitions: undefined },
                    addedAttributeDefinitions: missingAttrDefs
                });

                if (!dryRun) {
                    await this.ScyllaDb.rawRequest("UpdateTable", payload);
                }
                addsApplied++;
            }
        }

        // Postgres
        if (meta.targets.includes("postgres") && this.pg) {
            for (const i of addsToApply.postgres.filter(x => x.type === "table")) {
                const spec = schemaJson.postgres?.tables?.[i.table] || {};
                const tableVer = this.#readTableVersion("postgres", i.table);
                const sql = this.#pgCreateTableSql(i.table, spec, tableVer);

                this.log("[APPLY][PG] CREATE TABLE", { table: i.table, sql });

                if (!dryRun) {
                    await this.pg.query("default", sql, []);
                }

                addsApplied++;
            }

            for (const i of addsToApply.postgres.filter(x => x.type === "column")) {
                const cSpec = schemaJson.postgres?.tables?.[i.table]?.columns?.[i.column] || {};
                const schema = this.#pgGetSchema();
                const sql = `ALTER TABLE "${schema}"."${i.table}" ADD COLUMN ${this.#pgColumnDefSql(i.column, cSpec)}`;

                this.log("[APPLY][PG] ADD COLUMN", { table: i.table, column: i.column, sql });

                if (!dryRun) {
                    await this.pg.query("default", sql, []);
                }

                addsApplied++;
            }

            for (const i of addsToApply.postgres.filter(x => x.type === "index")) {
                const tableSpec = schemaJson.postgres?.tables?.[i.table] || {};
                const idx = (tableSpec.indexes || []).find(x => (x.name || `${i.table}_${(x.columns || []).join("_")}_idx`) === i.index);
                const sql = this.#pgCreateIndexSql(i.table, i.index, idx);

                this.log("[APPLY][PG] CREATE INDEX", { table: i.table, index: i.index, sql });

                if (!dryRun) {
                    await this.pg.query("default", sql, []);
                }

                addsApplied++;
            }
        }

        // MySQL
        if (meta.targets.includes("mysql") && this.mysql) {
            for (const i of addsToApply.mysql.filter(x => x.type === "table")) {
                const spec = schemaJson.mysql?.tables?.[i.table] || {};
                const tableVer = this.#readTableVersion("mysql", i.table);
                const sql = this.#myCreateTableSql(i.table, spec, tableVer);

                this.log("[APPLY][MySQL] CREATE TABLE", { table: i.table, sql });

                if (!dryRun) {
                    await this.mysql.query(sql);
                }

                addsApplied++;
            }

            for (const i of addsToApply.mysql.filter(x => x.type === "column")) {
                const cSpec = schemaJson.mysql?.tables?.[i.table]?.columns?.[i.column] || {};
                const sql = `ALTER TABLE \`${i.table}\` ADD COLUMN ${this.#myColumnDefSql(i.column, cSpec)}`;

                this.log("[APPLY][MySQL] ADD COLUMN", { table: i.table, column: i.column, sql });

                if (!dryRun) {
                    await this.mysql.query(sql);
                }

                addsApplied++;
            }

            for (const i of addsToApply.mysql.filter(x => x.type === "index")) {
                const tableSpec = schemaJson.mysql?.tables?.[i.table] || {};
                const idx = (tableSpec.indexes || []).find(x => (x.name || `${i.table}_${(x.columns || []).join("_")}_idx`) === i.index);
                const sql = this.#myCreateIndexSql(i.table, i.index, idx);

                this.log("[APPLY][MySQL] CREATE INDEX", { table: i.table, index: i.index, sql });

                if (!dryRun) {
                    await this.mysql.query(sql);
                }

                addsApplied++;
            }
        }

        this.#logApplySummary(addsApplied, removalsToReport, futureItems);

        return { addsApplied, report: { removalsToReport, futureItems, versions: meta.versions } };
    }

    /**
   * Final validation: verifies ACTIVE items exist and INACTIVE (removed_in) are reported.
   * Throws on critical mismatches. Returns a structured report.
   */
    async finalValidate(schemaJson, opts = {}) {
        const { meta } = await this.planSchemaChanges(schemaJson, opts);
        const targets = new Set(meta.targets);

        const result = { scylla: [], postgres: [], mysql: [], errors: [] };

        // Scylla: check tables & GSIs for ACTIVE items
        if (targets.has("scylla") && this.ScyllaDb) {
            const tables = schemaJson.scylla?.tables || {};
            for (const [logical, spec] of Object.entries(tables)) {
                const tableName = spec.TableName || logical;
                const tableVer = this.#readTableVersion("scylla", tableName);
                const tLife = this.#lifecycle(spec, tableVer);

                if (!tLife.active) continue;

                const desc = await this.#safe(() => this.ScyllaDb.rawRequest("DescribeTable", { TableName: tableName }));
                const exists = !!desc?.Table?.TableStatus;

                result.scylla.push({ table: tableName, ok: exists, check: "table" });
                if (!exists) result.errors.push(`[VALIDATE][Scylla] Missing table: ${tableName}`);

                // GSIs
                const gsis = this.#filterActiveGsi(spec.GlobalSecondaryIndexes, tableVer, [], [], tableName);
                const gsiNames = (desc?.Table?.GlobalSecondaryIndexes || []).map(g => g.IndexName);

                for (const g of gsis) {
                    const ok = gsiNames.includes(g.IndexName);
                    result.scylla.push({ table: tableName, index: g.IndexName, ok, check: "gsi" });
                    if (!ok) result.errors.push(`[VALIDATE][Scylla] Missing GSI "${g.IndexName}" on ${tableName}`);
                }
            }
        }

        // Postgres: tables, columns, indexes
        if (targets.has("postgres") && this.pg) {
            const tables = schemaJson.postgres?.tables || {};
            for (const [tableName, spec] of Object.entries(tables)) {
                const tableVer = this.#readTableVersion("postgres", tableName);
                const tLife = this.#lifecycle(spec, tableVer);

                if (!tLife.active) continue;

                const tExists = await this.#pgTableExists(tableName);
                result.postgres.push({ table: tableName, ok: tExists, check: "table" });

                if (!tExists) result.errors.push(`[VALIDATE][PG] Missing table: ${tableName}`);

                for (const [col, cSpec] of Object.entries(spec.columns || {})) {
                    if (!this.#lifecycle(cSpec, tableVer).active) continue;
                    const cExists = tExists ? await this.#pgColumnExists(tableName, col) : false;

                    result.postgres.push({ table: tableName, column: col, ok: cExists, check: "column" });
                    if (!cExists) result.errors.push(`[VALIDATE][PG] Missing column ${tableName}.${col}`);
                }

                for (const idx of spec.indexes || []) {
                    if (!this.#lifecycle(idx, tableVer).active) continue;

                    const name = idx.name || `${tableName}_${(idx.columns || []).join("_")}_idx`;
                    const iExists = tExists ? await this.#pgIndexExists(name) : false;

                    result.postgres.push({ table: tableName, index: name, ok: iExists, check: "index" });
                    if (!iExists) result.errors.push(`[VALIDATE][PG] Missing index ${name} on ${tableName}`);
                }
            }
        }

        // MySQL: tables, columns, indexes
        if (targets.has("mysql") && this.mysql) {
            const tables = schemaJson.mysql?.tables || {};
            for (const [tableName, spec] of Object.entries(tables)) {
                const tableVer = this.#readTableVersion("mysql", tableName);
                const tLife = this.#lifecycle(spec, tableVer);

                if (!tLife.active) continue;

                const tRow = await this.#myTableExists(tableName);
                result.mysql.push({ table: tableName, ok: tRow, check: "table" });

                if (!tRow) result.errors.push(`[VALIDATE][MySQL] Missing table: ${tableName}`);

                for (const [col, cSpec] of Object.entries(spec.columns || {})) {
                    if (!this.#lifecycle(cSpec, tableVer).active) continue;
                    const cExists = tRow ? await this.#myColumnExists(tableName, col) : false;

                    result.mysql.push({ table: tableName, column: col, ok: cExists, check: "column" });
                    if (!cExists) result.errors.push(`[VALIDATE][MySQL] Missing column ${tableName}.${col}`);
                }

                for (const idx of spec.indexes || []) {
                    if (!this.#lifecycle(idx, tableVer).active) continue;

                    const name = idx.name || `${tableName}_${(idx.columns || []).join("_")}_idx`;
                    const iExists = tRow ? await this.#myIndexExists(tableName, name) : false;

                    result.mysql.push({ table: tableName, index: name, ok: iExists, check: "index" });
                    if (!iExists) result.errors.push(`[VALIDATE][MySQL] Missing index ${name} on ${tableName}`);
                }
            }
        }

        this.#logValidationSummary(result);
        if (result.errors.length) {
            const err = new Error("Final validation failed");
            err.details = result.errors;
            throw err;
        }
        return result;
    }

    /* =============================== INTERNAL =============================== */
    #resolveTargets(req) {
        const s = new Set(Array.isArray(req) && req.length ? req : ["scylla", "postgres", "mysql"]);
        return s;
    }

    #readTableVersion(engine, tableName) {
        const engKey = engine === "postgres" ? "PG" : engine === "mysql" ? "MYSQL" : "SCYLLA";
        const tblKey = String(tableName).replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
        const envKey = `${engKey}_${tblKey}_VERSION`;
        const raw = process.env[envKey];
        const v = parseFloat(raw);
        const out = Number.isFinite(v) ? v : 1.0;
        this.log("[ENV][VERSION]", { envKey, value: raw ?? "(unset -> 1.0)", parsed: out });
        return out;
    }

    #lifecycle(obj, tableVer) {
        const numOrU = (v) => (v === undefined ? undefined : parseFloat(String(v)));
        const since = numOrU(obj?.since);
        const removed = numOrU(obj?.removed_in);
        const future = typeof since === "number" && tableVer < since;
        const removeNow = typeof removed === "number" && tableVer >= removed;
        const active = !future && !removeNow;
        return { since, removed, future, removeNow, active };
    }

    #filterActiveGsi(gsis, tableVer, futureArr, removalArr, tableName) {
        const arr = Array.isArray(gsis) ? gsis : [];
        const active = [];
        for (const g of arr) {
            const life = this.#lifecycle(g, tableVer);
            if (life.removeNow) {
                removalArr.push({ type: "scylla-gsi", table: tableName, index: g.IndexName, reason: `removed_in=${g.removed_in}` });
                continue;
            }
            if (life.future) {
                futureArr.push({ type: "scylla-gsi", table: tableName, index: g.IndexName, reason: `since=${g.since}` });
                continue;
            }
            active.push(g);
        }
        return active;
    }

    /* ---- Logging helpers ---- */
    #logPlanSummary(meta, adds, removals, future) {
        this.log("=== PLAN SUMMARY ===");
        this.log("Targets:", meta.targets);
        this.log("Versions:", meta.versions);
        this.log("Adds to apply:", adds);
        this.log("Should manually remove (report only):", removals);
        this.log("Future (not active yet):", future);
    }

    #logApplySummary(addsApplied, removals, future) {
        this.log("=== APPLY SUMMARY ===");
        this.log("Adds applied:", addsApplied);
        this.log("NOTICE: Items you SHOULD manually remove:", removals);
        this.log("Future (will be active in higher table version):", future);
    }

    #logValidationSummary(result) {
        this.log("=== FINAL VALIDATION ===");
        this.log("Checks (Scylla):", result.scylla);
        this.log("Checks (Postgres):", result.postgres);
        this.log("Checks (MySQL):", result.mysql);
        if (result.errors.length) this.log("ERRORS:", result.errors);
        else this.log("Validation: OK (all active items present)");
    }

    async #safe(fn) {
        try { return await fn(); } catch (e) { this.log("[ERROR]", { error: e?.message }); return null; }
    }

    /* =============================== SCYLLA =============================== */
    async #scyllaTableExists(tableName) {
        try {
            const resp = await this.ScyllaDb.rawRequest("DescribeTable", { TableName: tableName });
            return !!resp?.Table?.TableStatus;
        } catch (_) { return false; }
    }


    async #scyllaIndexExists(tableName, indexName) {
        try {
            const resp = await this.ScyllaDb.rawRequest("DescribeTable", { TableName: tableName });
            const gsis = resp?.Table?.GlobalSecondaryIndexes || [];
            return gsis.some(g => g.IndexName === indexName);
        } catch (_) {
            return false;
        }
    }

    #lookupScyllaSpec(schemaJson, tableName) {
        const tables = schemaJson.scylla?.tables || {};
        for (const [logical, spec] of Object.entries(tables)) {
            const tn = spec.TableName || logical;
            if (tn === tableName) return spec;
        }
        return null;
    }

    #scyllaBuildCreateTablePayload(tableName, spec, tableVer) {
        const attributeTypes = spec.AttributeTypes || {};
        const addAttr = (set, name, fallback = "S") => {
            if (!name) return;
            if (!set.has(name)) set.add(name);
            if (!attributeTypes[name]) attributeTypes[name] = fallback;
        };

        const keyAttrs = new Set();
        addAttr(keyAttrs, spec.PK, "S");
        if (spec.SK) addAttr(keyAttrs, spec.SK, "S");

        const gsis = this.#filterActiveGsi(spec.GlobalSecondaryIndexes, tableVer, [], [], tableName);
        for (const g of gsis) {
            if (Array.isArray(g.KeySchema)) for (const ks of g.KeySchema) addAttr(keyAttrs, ks.AttributeName, "S");
        }

        const AttributeDefinitions = [...keyAttrs].map((name) => ({
            AttributeName: name, AttributeType: attributeTypes[name] || "S",
        }));

        const KeySchema = [{ AttributeName: spec.PK, KeyType: "HASH" }];
        if (spec.SK) KeySchema.push({ AttributeName: spec.SK, KeyType: "RANGE" });

        const payload = { TableName: tableName, AttributeDefinitions, KeySchema };

        if (spec.BillingMode === "PROVISIONED") {
            if (!spec.ProvisionedThroughput) throw new Error(`Scylla: "${tableName}" PROVISIONED requires ProvisionedThroughput`);
            payload.ProvisionedThroughput = spec.ProvisionedThroughput;
        } else payload.BillingMode = "PAY_PER_REQUEST";

        if (gsis.length) {
            for (const g of gsis) {
                if (!g.IndexName) throw new Error(`Scylla: GSI missing IndexName on table "${tableName}"`);
                if (!Array.isArray(g.KeySchema) || !g.KeySchema.length) throw new Error(`Scylla: GSI "${g.IndexName}" missing KeySchema`);
                if (!g.Projection || !g.Projection.ProjectionType) throw new Error(`Scylla: GSI "${g.IndexName}" missing Projection`);
            }
            payload.GlobalSecondaryIndexes = gsis;
        }

        return payload;
    }

    // Build the "Create" block for GlobalSecondaryIndexUpdates
    #scyllaBuildCreateGsiSpec(tableName, spec, gsiName) {
        const g = (spec.GlobalSecondaryIndexes || []).find(x => x.IndexName === gsiName);
        if (!g) throw new Error(`GSI spec not found for ${tableName}.${gsiName}`);

        return {
            IndexName: g.IndexName,
            KeySchema: g.KeySchema,                 // [{ AttributeName, KeyType: 'HASH'|'RANGE' }]
            Projection: g.Projection,               // { ProjectionType, NonKeyAttributes? }
            ...(g.ProvisionedThroughput ? { ProvisionedThroughput: g.ProvisionedThroughput } : {})
        };
    }
    // Convert a variety of schema type strings to Dynamo/Alternator 'S' | 'N' | 'B'
    #scyllaMapToDynamoScalar(typeStr) {
        if (!typeStr) return undefined;
        const t = String(typeStr).toLowerCase();

        // Strings
        if (["s", "string", "text", "varchar", "uuid", "timeuuid", "ascii"].includes(t)) return "S";

        // Numbers
        if (["n", "number", "int", "int32", "int64", "bigint", "smallint", "tinyint", "counter", "float", "double", "decimal"].includes(t)) return "N";

        // Binary
        if (["b", "blob", "bytes", "binary", "varbinary"].includes(t)) return "B";

        return undefined;
    }

    // Try hard to find the attribute's type from your table spec or global config.
    // If still unknown, default to 'S' and log a warning (so your run doesn't fail).
    #scyllaResolveAttrType(spec, attrName, tableName, gsiName) {
        // 1) Table-level AttributeDefinitions array
        if (Array.isArray(spec.AttributeDefinitions)) {
            const hit = spec.AttributeDefinitions.find(d => d.AttributeName === attrName)?.AttributeType;
            if (hit) return hit;
        }

        // 2) Sometimes schemas keep a map/object of attributes with types
        //    e.g., spec.Attributes = { email: { AttributeType: 'S' } } or { email: { Type: 'text' } }
        const attrObj = spec.Attributes && spec.Attributes[attrName];
        if (attrObj) {
            const fromAttrType = this.#scyllaMapToDynamoScalar(attrObj.AttributeType || attrObj.Type);
            if (fromAttrType) return fromAttrType;
        }

        // 3) Or columns/fields section, e.g., Columns: { email: { Type: 'text' } }
        const colObj = spec.Columns && spec.Columns[attrName];
        if (colObj) {
            const fromCol = this.#scyllaMapToDynamoScalar(colObj.AttributeType || colObj.Type);
            if (fromCol) return fromCol;
        }

        // 4) Per-table overrides
        if (spec.AttributeTypeOverrides && spec.AttributeTypeOverrides[attrName]) {
            const fromOverride = this.#scyllaMapToDynamoScalar(spec.AttributeTypeOverrides[attrName]);
            if (fromOverride) return fromOverride;
        }

        // 5) Global overrides (optional; wire in schemaJson if you have it on this)
        const globalOverrides = this.schemaJson?.scylla?.attributeTypeOverrides;
        if (globalOverrides && globalOverrides[attrName]) {
            const fromGlobal = this.#scyllaMapToDynamoScalar(globalOverrides[attrName]);
            if (fromGlobal) return fromGlobal;
        }

        // 6) Light heuristic (common & safe): default 'S' for names that look like strings
        const likelyString = /email|name|id|key|token|ref|uuid|city|country/i.test(attrName);
        const likelyNumber = /(count|size|amount|age|num|qty|version|ts|time|at|_n$|_num$)/i.test(attrName);
        const guessed = this.#scyllaMapToDynamoScalar(likelyNumber ? "number" : (likelyString ? "string" : "string"));
        this.log("[APPLY][Scylla][WARN] Attribute type inferred", {
            table: tableName, gsi: gsiName, attribute: attrName, inferredType: guessed
        });
        return guessed; // defaults to 'S' in practice
    }

    // Compute AttributeDefinitions missing for this GSI's key attrs (vs table's current defs)
    #scyllaBuildMissingAttrDefsForGsi(tableName, spec, gsiName, existingAttrDefs) {
        const g = (spec.GlobalSecondaryIndexes || []).find(x => x.IndexName === gsiName);
        if (!g) throw new Error(`GSI spec not found for ${tableName}.${gsiName}`);

        const existing = new Map((existingAttrDefs || []).map(d => [d.AttributeName, d.AttributeType]));
        const neededAttrNames = Array.from(new Set((g.KeySchema || []).map(k => k.AttributeName)));

        const missing = [];
        for (const name of neededAttrNames) {
            if (existing.has(name)) continue;

            const t = this.#scyllaResolveAttrType(spec, name, tableName, gsiName);
            // Add only if not already defined on the table
            missing.push({ AttributeName: name, AttributeType: t });
        }
        return missing;
    }
    /* =============================== POSTGRES =============================== */
    #pgGetSchema() {
        // Get schema from pg instance if available, otherwise default to "public"
        return this.pg?.getSchema ? this.pg.getSchema() : "public";
    }

    async #pgTableExists(tableName) {
        const schema = this.#pgGetSchema();
        const row = await this.pg.getRow("default",
            `SELECT 1 FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2`, [schema, tableName]);
        return !!row;
    }

    async #pgColumnExists(tableName, columnName) {
        const schema = this.#pgGetSchema();
        const row = await this.pg.getRow("default",
            `SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3`,
            [schema, tableName, columnName]);
        return !!row;
    }

    async #pgIndexExists(indexName) {
        const schema = this.#pgGetSchema();
        const row = await this.pg.getRow("default",
            `SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname=$2`, [schema, indexName]);
        return !!row;
    }

    #pgMapType(colName, colSpec = {}) {
        const override = colSpec.postgres?.type;
        if (override) return override;
        const t = String(colSpec.type || "").toLowerCase();
        const native = /(char|text|uuid|jsonb?|bool|int|bigint|serial|bigserial|timestamptz|timestamp|numeric|decimal|double|real|date)/.test(t);
        if (native) return t;
        if (t.startsWith("varchar")) return t;
        if (t === "string") return "text";
        if (t === "boolean" || t === "bool") return "boolean";
        if (t === "number" || t === "int") return "integer";
        if (t === "float" || t === "double") return "double precision";
        if (t === "json") return "jsonb";
        if (t === "datetime" || t === "timestamp") return "timestamptz";
        return "text";
    }

    #pgColumnDefSql(colName, colSpec = {}) {
        let sql = `"${colName}" ${this.#pgMapType(colName, colSpec)}`;
        sql += colSpec.notNull ? " NOT NULL" : "";
        sql += colSpec.default ? ` DEFAULT ${colSpec.default}` : "";
        return sql;
    }

    #pgPrimaryKeyList(spec = {}) {
        return Object.entries(spec.columns || {}).filter(([, s]) => !!s.primary).map(([n]) => `"${n}"`);
    }

    #pgCreateTableSql(tableName, spec, tableVer) {
        const schema = this.#pgGetSchema();
        const colDefs = [];
        for (const [col, cSpec] of Object.entries(spec.columns || {})) {
            if (!this.#lifecycle(cSpec, tableVer).active) continue;
            colDefs.push(this.#pgColumnDefSql(col, cSpec));
        }
        const pkCols = this.#pgPrimaryKeyList(spec);
        if (pkCols.length) colDefs.push(`PRIMARY KEY (${pkCols.join(", ")})`);
        return `CREATE TABLE "${schema}"."${tableName}" (\n  ${colDefs.join(",\n  ")}\n)`;
    }

    #pgCreateIndexSql(tableName, name, idxSpec) {
        const schema = this.#pgGetSchema();
        const unique = idxSpec?.unique ? "UNIQUE " : "";
        if (idxSpec?.postgres?.expression) {
            return `CREATE ${unique}INDEX "${name}" ON "${schema}"."${tableName}" (${idxSpec.postgres.expression})`;
        }
        const cols = (idxSpec?.columns || []).map(c => `"${c}"`).join(", ");
        return `CREATE ${unique}INDEX "${name}" ON "${schema}"."${tableName}" (${cols})`;
    }


    /* =============================== MYSQL =============================== */
    async #myTableExists(tableName) {
        const row = await this.mysql.getRow(
            "SELECT 1 AS x FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1", [tableName]);
        return !!row;
    }

    async #myColumnExists(tableName, columnName) {
        const row = await this.mysql.getRow(
            "SELECT 1 AS x FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1",
            [tableName, columnName]);
        return !!row;
    }

    async #myIndexExists(tableName, indexName) {
        const row = await this.mysql.getRow(
            "SELECT 1 AS x FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1",
            [tableName, indexName]);
        return !!row;
    }

    #myMapType(colName, colSpec = {}) {
        const override = colSpec.mysql?.type;
        if (override) return override;
        const t = String(colSpec.type || "").toLowerCase();
        const native = /(char|text|json|bool|tinyint|int|bigint|float|double|decimal|datetime|timestamp|date|time|year|binary|blob)/.test(t);
        if (native) return t;
        if (t.startsWith("varchar")) return t;
        if (t === "string") return "text";
        if (t === "boolean" || t === "bool") return "tinyint(1)";
        if (t === "number" || t === "int") return "int";
        if (t === "bigint") return "bigint";
        if (t === "float") return "float";
        if (t === "double") return "double";
        if (t.startsWith("decimal") || t.startsWith("numeric")) return t.replace("numeric", "decimal");
        if (t === "json") return "json";
        if (t === "datetime" || t === "timestamptz" || t === "timestamp") return "datetime";
        if (t === "date") return "date";
        if (t === "uuid") return "char(36)";
        return "text";
    }

    #sqlValue(v) {
        if (v === null) return "NULL";
        if (typeof v === "number") return String(v);
        if (typeof v === "boolean") return v ? "1" : "0";
        if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
        return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
    }

    #myColumnDefSql(colName, colSpec = {}) {
        let sql = `\`${colName}\` ${this.#myMapType(colName, colSpec)}`;
        sql += colSpec.notNull ? " NOT NULL" : "";
        sql += colSpec.autoIncrement ? " AUTO_INCREMENT" : "";
        if (colSpec.default !== undefined) {
            const isFunc = typeof colSpec.default === "string" && /^[A-Za-z_]+\(/.test(colSpec.default);
            sql += ` DEFAULT ${isFunc ? colSpec.default : this.#sqlValue(colSpec.default)}`;
        }
        return sql;
    }

    #myPrimaryKeyList(spec = {}) {
        return Object.entries(spec.columns || {}).filter(([, c]) => !!c.primary).map(([n]) => `\`${n}\``);
    }

    #myCreateTableSql(tableName, spec, tableVer) {
        const colDefs = [];
        for (const [col, cSpec] of Object.entries(spec.columns || {})) {
            if (!this.#lifecycle(cSpec, tableVer).active) continue;
            colDefs.push(this.#myColumnDefSql(col, cSpec));
        }
        const pkCols = this.#myPrimaryKeyList(spec);
        if (pkCols.length) colDefs.push(`PRIMARY KEY (${pkCols.join(", ")})`);
        const engine = spec.mysql?.engine || "InnoDB";
        const charset = spec.mysql?.charset || "utf8mb4";
        return `CREATE TABLE \`${tableName}\` (\n  ${colDefs.join(",\n  ")}\n) ENGINE=${engine} DEFAULT CHARSET=${charset}`;
    }

    #myCreateIndexSql(tableName, name, idxSpec) {
        const unique = idxSpec?.unique ? "UNIQUE " : "";
        const cols = (idxSpec?.columns || []).map(c => `\`${c}\``).join(", ");
        return `CREATE ${unique}INDEX \`${name}\` ON \`${tableName}\` (${cols})`;
    }
}

module.exports = DatabaseSchemaHandler;
