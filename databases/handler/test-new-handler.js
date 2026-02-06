"use strict";

/**
 * Test script for new PostgreSQL handler
 * Usage: node test-new-handler.js
 */

require("dotenv").config();
const path = require("path");

// Go up one level to get postgres adapter
const PG = require(path.join(__dirname, "../postgres/db"));
const DbPostgreSQLHandler = require("./db/DbPostgreSQL");
const StructuredLogger = require("./utils/StructuredLogger");

(async () => {
    try {
        console.log("=== Testing New PostgreSQL Handler ===\n");
        
        // Create logger
        const logger = new StructuredLogger({ serviceName: "test-app" });
        
        // Connect to PostgreSQL
        console.log("1. Connecting to PostgreSQL...");
        const pg = new PG();
        await pg.ensureConnected("default");
        console.log("   ✓ Connected!\n");
        
        // Create handler
        console.log("2. Creating PostgreSQL handler...");
        const handler = new DbPostgreSQLHandler(pg, logger.log.bind(logger));
        console.log("   ✓ Handler created!\n");
        
        // Check if table exists
        console.log("3. Checking if 'test_users' table exists...");
        const exists = await handler.tableExists("test_users");
        console.log(`   ✓ Table exists: ${exists}\n`);
        
        // Create table spec
        const tableSpec = {
            columns: {
                id: { 
                    type: "uuid", 
                    primary: true, 
                    notNull: true,
                    default: "gen_random_uuid()"
                },
                email: { 
                    type: "string", 
                    notNull: true 
                },
                name: {
                    type: "string",
                    notNull: false
                },
                created_at: { 
                    type: "timestamptz", 
                    default: "NOW()",
                    notNull: true
                }
            }
        };
        
        // Create table (dry run first)
        console.log("4. Creating table (dry run)...");
        const dryRunResult = await handler.createTable("test_users", tableSpec, 1.0, true);
        console.log("   ✓ Dry run SQL:");
        console.log("   " + dryRunResult.sql.split("\n").join("\n   ") + "\n");
        
        // Actually create it
        console.log("5. Creating table (actual)...");
        await handler.createTable("test_users", tableSpec, 1.0, false);
        console.log("   ✓ Table created!\n");
        
        // Verify it exists now
        console.log("6. Verifying table exists...");
        const existsNow = await handler.tableExists("test_users");
        console.log(`   ✓ Table exists: ${existsNow}\n`);
        
        // Add a column
        console.log("7. Adding column 'updated_at'...");
        const columnSpec = {
            type: "timestamptz",
            default: "NOW()",
            notNull: true
        };
        await handler.addColumn("test_users", "updated_at", columnSpec, false);
        console.log("   ✓ Column added!\n");
        
        // Verify column exists
        console.log("8. Verifying column exists...");
        const colExists = await handler.columnExists("test_users", "updated_at");
        console.log(`   ✓ Column exists: ${colExists}\n`);
        
        // Create an index
        console.log("9. Creating index on 'email'...");
        const indexSpec = {
            columns: ["email"],
            unique: true
        };
        await handler.createIndex("test_users", "test_users_email_unique_idx", indexSpec, false);
        console.log("   ✓ Index created!\n");
        
        // Verify index exists
        console.log("10. Verifying index exists...");
        const idxExists = await handler.indexExists("test_users_email_unique_idx");
        console.log(`    ✓ Index exists: ${idxExists}\n`);
        
        console.log("=== All Tests Passed! ===\n");
        
        // Clean up
        console.log("Cleaning up...");
        await pg.closeAll();
        console.log("✓ Done!");
        
    } catch (error) {
        console.error("\n❌ Error:", error.message);
        if (error.stack) {
            console.error("\nStack trace:");
            console.error(error.stack);
        }
        process.exit(1);
    }
})();

