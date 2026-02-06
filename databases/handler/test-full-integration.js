"use strict";

/**
 * Full integration test with all new components
 * Usage: node test-full-integration.js
 */

require("dotenv").config();
const path = require("path");

const PG = require(path.join(__dirname, "../postgres/db"));
const DbPostgreSQLHandler = require("./db/DbPostgreSQL");
const StructuredLogger = require("./utils/StructuredLogger");
const ErrorWrapper = require("./utils/ErrorWrapper");
const RetryWrapper = require("./utils/RetryWrapper");
const LifecycleChecker = require("./db/LifecycleChecker");
const TypeMapper = require("./db/TypeMapper");

(async () => {
    try {
        console.log("=== Full Integration Test ===\n");
        
        // 1. Setup logger
        console.log("1. Setting up structured logger...");
        const logger = new StructuredLogger({ 
            serviceName: "integration-test",
            environment: "test"
        });
        logger.info("Integration test started");
        console.log("   ✓ Logger ready!\n");
        
        // 2. Connect with retry
        console.log("2. Connecting to PostgreSQL (with retry)...");
        const retry = new RetryWrapper({ 
            maxRetries: 3,
            initialDelay: 200,
            logger: (msg) => console.log(`   ${msg}`)
        });
        
        const pg = await retry.execute(
            async () => {
                const client = new PG();
                await client.ensureConnected("default");
                return client;
            },
            { operation: "connect" }
        );
        console.log("   ✓ Connected!\n");
        
        // 3. Create handler
        console.log("3. Creating PostgreSQL handler...");
        const handler = new DbPostgreSQLHandler(pg, logger.log.bind(logger));
        console.log("   ✓ Handler created!\n");
        
        // 4. Test type mapper
        console.log("4. Testing TypeMapper...");
        const typeMapper = new TypeMapper();
        const pgType = typeMapper.mapToPostgres("string", {}, {
            table: "test_table",
            column: "test_col",
            logger: logger.log.bind(logger)
        });
        console.log(`   ✓ PostgreSQL type for 'string': ${pgType}`);
        
        const mysqlType = typeMapper.mapToMySQL("string", {}, {
            table: "test_table",
            column: "test_col",
            logger: logger.log.bind(logger)
        });
        console.log(`   ✓ MySQL type for 'string': ${mysqlType}`);
        
        const scyllaType = typeMapper.mapToScylla("string", {}, {
            table: "test_table",
            attribute: "test_attr",
            logger: logger.log.bind(logger)
        });
        console.log(`   ✓ Scylla type for 'string': ${scyllaType}\n`);
        
        // 5. Test lifecycle checker
        console.log("5. Testing LifecycleChecker...");
        const item1 = { since: 1.0 }; // Active at version 2.0
        const lifecycle1 = LifecycleChecker.check(item1, 2.0, {
            engine: "postgres",
            table: "test_table",
            column: "test_col"
        });
        console.log(`   ✓ Lifecycle for item with since=1.0 at version 2.0: ${JSON.stringify(lifecycle1)}`);
        
        const item2 = { removed_in: 3.0 }; // Active at version 2.0
        const lifecycle2 = LifecycleChecker.check(item2, 2.0, {
            engine: "postgres",
            table: "test_table",
            column: "test_col"
        });
        console.log(`   ✓ Lifecycle for item with removed_in=3.0 at version 2.0: ${JSON.stringify(lifecycle2)}\n`);
        
        // 6. Create table with error handling
        console.log("6. Creating table with error handling...");
        const tableSpec = {
            columns: {
                id: { 
                    type: "uuid", 
                    primary: true, 
                    notNull: true,
                    default: "gen_random_uuid()"
                },
                name: { 
                    type: "string", 
                    notNull: true 
                },
                email: {
                    type: "string",
                    notNull: true
                },
                created_at: { 
                    type: "timestamptz", 
                    default: "NOW()",
                    notNull: true
                }
            }
        };
        
        await ErrorWrapper.wrapQuery(
            () => handler.createTable("integration_test_users", tableSpec, 1.0, false),
            { engine: "postgres", operation: "createTable", table: "integration_test_users" }
        );
        console.log("   ✓ Table created!\n");
        
        // 7. Verify table exists
        console.log("7. Verifying table exists...");
        const exists = await handler.tableExists("integration_test_users");
        console.log(`   ✓ Table exists: ${exists}\n`);
        
        // 8. Add column with lifecycle
        console.log("8. Adding column with lifecycle check...");
        const columnSpec = {
            type: "timestamptz",
            default: "NOW()",
            notNull: true,
            since: 1.0 // Active at version 1.0
        };
        
        const colLifecycle = LifecycleChecker.check(columnSpec, 1.0, {
            engine: "postgres",
            table: "integration_test_users",
            column: "updated_at"
        });
        
        if (colLifecycle.active) {
            await ErrorWrapper.wrapQuery(
                () => handler.addColumn("integration_test_users", "updated_at", columnSpec, false),
                { engine: "postgres", operation: "addColumn", table: "integration_test_users", column: "updated_at" }
            );
            console.log("   ✓ Column added!\n");
        }
        
        // 9. Create index
        console.log("9. Creating index...");
        const indexSpec = {
            columns: ["email"],
            unique: true
        };
        await ErrorWrapper.wrapQuery(
            () => handler.createIndex("integration_test_users", "integration_test_users_email_idx", indexSpec, false),
            { engine: "postgres", operation: "createIndex", table: "integration_test_users", index: "integration_test_users_email_idx" }
        );
        console.log("   ✓ Index created!\n");
        
        // 10. Log metrics
        console.log("10. Logging test completion...");
        logger.info("Integration test completed successfully", {
            table: "integration_test_users",
            operations: ["createTable", "addColumn", "createIndex"]
        });
        logger.audit("integration_test", {
            action: "create_table",
            table: "integration_test_users",
            success: true
        });
        console.log("   ✓ Logged!\n");
        
        console.log("=== All Integration Tests Passed! ===\n");
        
        // Clean up
        console.log("Cleaning up...");
        await pg.closeAll();
        console.log("✓ Done!");
        
    } catch (error) {
        console.error("\n❌ Error:", error.message);
        if (error.context) {
            console.error("Context:", JSON.stringify(error.context, null, 2));
        }
        if (error.stack) {
            console.error("\nStack trace:");
            console.error(error.stack);
        }
        process.exit(1);
    }
})();

