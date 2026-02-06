#!/usr/bin/env node
"use strict";

/**
 * Demo Script for Database Schema Handler
 * Shows: Edit config → Run handler → Verify in databases
 */

require("dotenv").config();
const DatabaseSchemaHandler = require("./DatabaseSchemaHandler");
const ScyllaDb = require("../scylla/db");
const PG = require("../postgres/db");
const MySQLDB = require("../mysql/db");
const fs = require("fs");
const path = require("path");

(async () => {
    console.log("=".repeat(60));
    console.log("  Database Schema Handler - Demo");
    console.log("=".repeat(60));
    console.log();
    
    try {
        // 1. Load schema
        console.log("📄 Step 1: Loading schema...");
        // Try schema.v2.3.json first (for demo), then fallback to v2.2, then v2.1
        let schemaPath = path.join(__dirname, "schema.v2.3.json");
        if (!fs.existsSync(schemaPath)) {
            schemaPath = path.join(__dirname, "schema.v2.2.json");
        }
        if (!fs.existsSync(schemaPath)) {
            schemaPath = path.join(__dirname, "schema.v2.1.json");
        }
        if (!fs.existsSync(schemaPath)) {
            throw new Error(`Schema file not found: ${schemaPath}`);
        }
        const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
        console.log("   ✓ Schema loaded");
        console.log(`   - PostgreSQL tables: ${Object.keys(schema.postgres?.tables || {}).length}`);
        console.log(`   - MySQL tables: ${Object.keys(schema.mysql?.tables || {}).length}`);
        console.log(`   - Scylla tables: ${Object.keys(schema.scylla?.tables || {}).length}`);
        console.log();
        
        // 2. Initialize clients
        console.log("🔌 Step 2: Connecting to databases...");
        const clients = {};
        
        // PostgreSQL
        if (process.env.PGUSER || process.env.POSTGRES_USER) {
            try {
                clients.pg = new PG();
                await clients.pg.ensureConnected("default");
                console.log("   ✓ PostgreSQL connected");
            } catch (err) {
                console.log("   ⚠ PostgreSQL connection failed:", err.message);
                clients.pg = null;
            }
        } else {
            console.log("   ⚠ PostgreSQL not configured (PGUSER not set)");
            clients.pg = null;
        }
        
        // MySQL
        if (process.env.DB_USER || process.env.MYSQL_USER) {
            try {
                clients.mysql = new MySQLDB();
                await clients.mysql.ensureConnected("default");
                console.log("   ✓ MySQL connected");
            } catch (err) {
                console.log("   ⚠ MySQL connection failed:", err.message);
                clients.mysql = null;
            }
        } else {
            console.log("   ⚠ MySQL not configured (DB_USER not set)");
            clients.mysql = null;
        }
        
        // Scylla
        if (process.env.SCYLLA_ENDPOINT || process.env.AWS_ENDPOINT_URL) {
            try {
                clients.scylla = new ScyllaDb();
                console.log("   ✓ Scylla client initialized");
            } catch (err) {
                console.log("   ⚠ Scylla connection failed:", err.message);
                clients.scylla = null;
            }
        } else {
            console.log("   ⚠ Scylla not configured (SCYLLA_ENDPOINT not set)");
            clients.scylla = null;
        }
        
        if (!clients.pg && !clients.mysql && !clients.scylla) {
            throw new Error("No database clients available. Please configure at least one database.");
        }
        console.log();
        
        // 3. Create handler
        console.log("⚙️  Step 3: Creating DatabaseSchemaHandler...");
        const handler = new DatabaseSchemaHandler({
            scylla: clients.scylla,
            pg: clients.pg,
            mysql: clients.mysql,
            logger: (msg, meta) => {
                if (msg.includes("[APPLY]") || msg.includes("[WARN]") || msg.includes("[ERROR]")) {
                    console.log(`   ${msg}`, meta ? JSON.stringify(meta, null, 2) : "");
                }
            }
        });
        console.log("   ✓ Handler created");
        console.log();
        
        // 4. Plan changes
        console.log("📋 Step 4: Planning schema changes...");
        const targets = [];
        if (clients.pg) targets.push("postgres");
        if (clients.mysql) targets.push("mysql");
        if (clients.scylla) targets.push("scylla");
        
        const plan = await handler.planSchemaChanges(schema, {
            targets: targets
        });
        
        console.log("\n   Changes detected:");
        console.log(`   PostgreSQL: ${plan.addsToApply.postgres.length} items to add`);
        console.log(`   MySQL: ${plan.addsToApply.mysql.length} items to add`);
        console.log(`   Scylla: ${plan.addsToApply.scylla.length} items to add`);
        
        if (plan.removalsToReport.postgres.length > 0 || 
            plan.removalsToReport.mysql.length > 0 || 
            plan.removalsToReport.scylla.length > 0) {
            console.log("\n   Items to remove (manual action required):");
            console.log(`   PostgreSQL: ${plan.removalsToReport.postgres.length} items`);
            console.log(`   MySQL: ${plan.removalsToReport.mysql.length} items`);
            console.log(`   Scylla: ${plan.removalsToReport.scylla.length} items`);
        }
        
        if (plan.futureItems.postgres.length > 0 || 
            plan.futureItems.mysql.length > 0 || 
            plan.futureItems.scylla.length > 0) {
            console.log("\n   Future items (not yet active):");
            console.log(`   PostgreSQL: ${plan.futureItems.postgres.length} items`);
            console.log(`   MySQL: ${plan.futureItems.mysql.length} items`);
            console.log(`   Scylla: ${plan.futureItems.scylla.length} items`);
        }
        console.log();
        
        // 5. Apply changes
        const totalChanges = plan.addsToApply.postgres.length + 
                            plan.addsToApply.mysql.length + 
                            plan.addsToApply.scylla.length;
        
        if (totalChanges > 0) {
            console.log("🚀 Step 5: Applying schema changes...");
            await handler.applySchema(plan.addsToApply, false);
            console.log("   ✓ Changes applied");
            console.log();
        } else {
            console.log("✅ Step 5: No changes to apply (schema is up to date)");
            console.log();
        }
        
        // 6. Validate
        console.log("✔️  Step 6: Validating final state...");
        await handler.finalValidate(schema, {
            targets: targets
        });
        console.log("   ✓ Validation complete");
        console.log();
        
        // 7. Summary
        console.log("=".repeat(60));
        console.log("  Demo Complete!");
        console.log("=".repeat(60));
        console.log();
        console.log("Next steps to verify in databases:");
        console.log();
        
        if (clients.pg) {
            console.log("📊 PostgreSQL:");
            console.log("   psql -U app_admin -d app_db");
            console.log("   \\dt                    # List tables");
            console.log("   \\d users               # Describe table");
            console.log("   \\di                     # List indexes");
        }
        
        if (clients.mysql) {
            console.log();
            console.log("📊 MySQL:");
            console.log("   mysql -u root -p app_db");
            console.log("   SHOW TABLES;");
            console.log("   DESCRIBE users;");
            console.log("   SHOW INDEXES FROM users;");
        }
        
        if (clients.scylla) {
            console.log();
            console.log("📊 Scylla (DynamoDB API):");
            console.log("   aws dynamodb list-tables --endpoint-url http://localhost:8000");
            console.log("   aws dynamodb describe-table --table-name Users --endpoint-url http://localhost:8000");
        }
        
        console.log();
        
    } catch (error) {
        console.error();
        console.error("❌ Error:", error.message);
        if (error.stack) {
            console.error(error.stack);
        }
        process.exit(1);
    }
})();

