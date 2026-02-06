// tests/testit.js
"use strict";

require("dotenv").config();

/**
 * Unified test driver with:
 *  - PLAN (shows versions, adds, should-manually-remove, future)
 *  - APPLY (executes additive changes)
 *  - VALIDATE (final validation pass; throws on mismatch)
 *
 * Usage:
 *   node test.js plan ./schema.v2.1.json
 *   node test.js apply ./schema.v2.2.json
 *   node test.js validate ./schema.v2.2.json
 *   node test.js insert ./seed-data.json
 */

const fs = require("fs");
const path = require("path");

const DatabaseSchemaHandler = require("./DatabaseSchemaHandler.js");

const PG = require("../postgres/db.js");
const MySQL = require("../mysql/db.js");
const ScyllaDb = require("../scylla/db");

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function insertData(seedData, { pg, mysql, scylla }) {
    console.log("\n--- INSERTING DATA ---\n");

    // PostgreSQL
    if (seedData.postgres && pg) {
        console.log("[POSTGRES] Inserting data...");
        for (const [tableName, rows] of Object.entries(seedData.postgres)) {
            if (!Array.isArray(rows) || rows.length === 0) continue;
            
            for (const row of rows) {
                const columns = Object.keys(row).join(", ");
                const placeholders = Object.keys(row).map((_, i) => `$${i + 1}`).join(", ");
                const values = Object.values(row);
                
                const sql = `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
                
                try {
                    await pg.query("default", sql, values);
                    console.log(`   ✓ Inserted into ${tableName}: ${row.email || row.title || row.id || 'row'}`);
                } catch (err) {
                    console.error(`   ✗ Failed to insert into ${tableName}:`, err.message);
                }
            }
        }
        console.log();
    }

    // MySQL
    if (seedData.mysql && mysql) {
        console.log("[MYSQL] Inserting data...");
        for (const [tableName, rows] of Object.entries(seedData.mysql)) {
            if (!Array.isArray(rows) || rows.length === 0) continue;
            
            for (const row of rows) {
                const columns = Object.keys(row).join(", ");
                const placeholders = Object.keys(row).map(() => "?").join(", ");
                const values = Object.values(row);
                
                const sql = `INSERT IGNORE INTO ${tableName} (${columns}) VALUES (${placeholders})`;
                
                try {
                    await mysql.query(sql, values);
                    console.log(`   ✓ Inserted into ${tableName}: ${row.email || row.title || row.id || 'row'}`);
                } catch (err) {
                    console.error(`   ✗ Failed to insert into ${tableName}:`, err.message);
                }
            }
        }
        console.log();
    }

    // Scylla (DynamoDB API)
    if (seedData.scylla && scylla && typeof scylla.rawRequest === "function") {
        console.log("[SCYLLA] Inserting data...");
        for (const [tableName, items] of Object.entries(seedData.scylla)) {
            if (!Array.isArray(items) || items.length === 0) continue;
            
            for (const item of items) {
                try {
                    // Convert item to DynamoDB format
                    const dynamoItem = {};
                    for (const [key, value] of Object.entries(item)) {
                        if (typeof value === "string") {
                            dynamoItem[key] = { S: value };
                        } else if (typeof value === "number") {
                            dynamoItem[key] = { N: String(value) };
                        } else if (typeof value === "boolean") {
                            dynamoItem[key] = { BOOL: value };
                        }
                    }
                    
                    await scylla.rawRequest("PutItem", {
                        TableName: tableName,
                        Item: dynamoItem
                    });
                    
                    const pk = item.pk || item.id || "item";
                    console.log(`   ✓ Inserted into ${tableName}: ${pk}`);
                } catch (err) {
                    console.error(`   ✗ Failed to insert into ${tableName}:`, err.message);
                }
            }
        }
        console.log();
    } else if (seedData.scylla) {
        console.log("[SCYLLA] Skipped (ScyllaDB not configured or rawRequest not available)");
        console.log();
    }

    console.log("--- DATA INSERTION COMPLETE ---");
}

async function boot() {
    console.log("(INIT): Booting Attaching Adapters")

    const pg = new PG({});
    await pg.ensureConnected("default");

    const mysql = new MySQL();
    await mysql.connect();

    if (typeof ScyllaDb.configure === "function") {
        ScyllaDb.configure({
            endpoint: process.env.SCYLLA_ALTERNATOR_ENDPOINT,
            region: process.env.SCYLLA_ACCESS_REGION,
            key: process.env.SCYLLA_ACCESS_KEY,
            secret: process.env.SCYLLA_ACCESS_PASSWORD
        });
    }

    const handler = new DatabaseSchemaHandler({
        scylla: ScyllaDb,
        pg,
        mysql,
        logger: (msg, meta) => console.log(msg, meta || "")
    });

    return { handler, pg, mysql };
}

async function main() {
    const mode = process.argv[2] || "plan";
    const schemaPath = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve(__dirname, "../schema.v2.2.json");

    if (!fs.existsSync(schemaPath)) {
        console.error("[FATAL] Schema file not found:", schemaPath);
        process.exit(2);
    }

    const schema = readJson(schemaPath);
    const { handler, pg, mysql } = await boot();

    try {
        if (mode === "plan") {
            console.log("[MODE] PLAN");

            const plan = await handler.planSchemaChanges(schema, { targets: ["scylla", "postgres", "mysql"] });

            console.log("\n--- PLAN (addsToApply) ---");
            console.dir(plan.addsToApply, { depth: null });

            console.log("\n--- REPORT (should manually remove) ---");
            console.dir(plan.removalsToReport, { depth: null });

            console.log("\n--- FUTURE (not active yet) ---");
            console.dir(plan.futureItems, { depth: null });
        } else if (mode === "apply") {
            console.log("[MODE] APPLY");

            const res = await handler.applySchema(schema, { targets: ["scylla", "postgres", "mysql"], dryRun: false });

            console.log("\n--- APPLY RESULT ---");
            console.dir(res, { depth: null });
        } else if (mode === "validate") {
            console.log("[MODE] VALIDATE");

            const report = await handler.finalValidate(schema, { targets: ["scylla", "postgres", "mysql"] });

            console.log("\n--- VALIDATION REPORT ---");
            console.dir(report, { depth: null });
        } else if (mode === "insert" || mode === "seed") {
            console.log("[MODE] INSERT/SEED DATA");

            // If 3rd arg exists, use it as data file, otherwise use default
            const dataPath = process.argv[3] 
                ? path.resolve(process.argv[3]) 
                : path.resolve(__dirname, "seed-data.json");
            
            if (!fs.existsSync(dataPath)) {
                console.error("[FATAL] Data file not found:", dataPath);
                console.error("       Create seed-data.json or provide path as argument");
                console.error("       Usage: node test.js insert [data-file.json]");
                process.exit(2);
            }

            console.log("Loading data from:", dataPath);
            const seedData = readJson(dataPath);
            await insertData(seedData, { pg, mysql, scylla: ScyllaDb });
        } else {
            console.error("Usage: node test.js [plan|apply|validate|insert] [schema.json|seed-data.json]");
            process.exit(2);
        }
    } catch (e) {
        console.error("[ERROR]", e?.message);
         console.error("[ERROR FULL]");
    console.error(e);
    console.error(e?.stack);
    // process.exit(1);

        if (e?.details) console.error("[DETAILS]", e.details);
        process.exit(1);
    } finally {
        await pg.closeAll().catch(() => { });
        await mysql.endAll().catch(() => { });
    }
}

main().catch((e) => {
    console.error("[FATAL]", e?.stack || e);
    process.exit(1);
});
