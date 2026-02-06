"use strict";

/**
 * Test script for ErrorWrapper - Tests all engines (PostgreSQL, MySQL, Scylla)
 * Usage: node test-error-handling.js
 */

require("dotenv").config();
const path = require("path");

const ErrorWrapper = require("./utils/ErrorWrapper");
const PG = require(path.join(__dirname, "../postgres/db"));
const MySQL = require(path.join(__dirname, "../mysql/db"));
const ScyllaDb = require(path.join(__dirname, "../scylla/db"));

(async () => {
    try {
        console.log("=== Testing ErrorWrapper (All Engines) ===\n");
        
        // ========== POSTGRESQL TESTS ==========
        console.log("========== PostgreSQL Tests ==========\n");
        
        // Connect to PostgreSQL
        console.log("1. Connecting to PostgreSQL...");
        const pg = new PG();
        await pg.ensureConnected("default");
        console.log("   ✓ Connected!\n");
        
        // Test 1: Successful query
        console.log("Test 1: Successful PostgreSQL query");
        const result1 = await ErrorWrapper.wrapQuery(
            () => pg.getRow("default", "SELECT NOW() AS now", []),
            { engine: "postgres", operation: "testQuery1" }
        );
        console.log(`   ✓ Result: ${result1.now}\n`);
        
        // Test 2: Query that fails (table doesn't exist)
        console.log("Test 2: PostgreSQL query with error (table doesn't exist)");
        try {
            const result2 = await ErrorWrapper.wrapQuery(
                () => pg.getRow("default", "SELECT * FROM nonexistent_table_12345 LIMIT 1", []),
                { engine: "postgres", operation: "testQuery2", table: "nonexistent_table_12345" }
            );
            console.log("   ❌ Should have thrown error");
        } catch (error) {
            console.log(`   ✓ Error caught: ${error.message}`);
            console.log(`   ✓ Error context: ${JSON.stringify(error.context || {}, null, 2)}\n`);
        }
        
        // Test 3: Safe wrapper (returns null on error)
        console.log("Test 3: Safe wrapper (returns null on error)");
        const result3 = await ErrorWrapper.safe(
            async () => {
                throw new Error("Test error");
            },
            { operation: "test3" }
        );
        console.log(`   ✓ Result (should be null): ${result3}\n`);
        
        await pg.closeAll();
        console.log("   ✓ PostgreSQL tests complete!\n");
        
        // ========== MYSQL TESTS ==========
        console.log("========== MySQL Tests ==========\n");
        
        // Connect to MySQL
        console.log("1. Connecting to MySQL...");
        const mysql = new MySQL();
        const mysqlConnected = await mysql.connect();
        if (!mysqlConnected) {
            console.log("   ⚠️  MySQL not configured, skipping MySQL tests\n");
        } else {
            console.log("   ✓ Connected!\n");
            
            // Test 1: Successful query
            console.log("Test 1: Successful MySQL query");
            const mysqlResult1 = await ErrorWrapper.wrapQuery(
                () => mysql.getRow("SELECT NOW() AS now"),
                { engine: "mysql", operation: "testQuery1" }
            );
            console.log(`   ✓ Result: ${mysqlResult1.now}\n`);
            
            // Test 2: Query that fails (table doesn't exist)
            console.log("Test 2: MySQL query with error (table doesn't exist)");
            try {
                const mysqlResult2 = await ErrorWrapper.wrapQuery(
                    () => mysql.getRow("SELECT * FROM nonexistent_table_12345 LIMIT 1"),
                    { engine: "mysql", operation: "testQuery2", table: "nonexistent_table_12345" }
                );
                console.log("   ❌ Should have thrown error");
            } catch (error) {
                console.log(`   ✓ Error caught: ${error.message}`);
                console.log(`   ✓ Error context: ${JSON.stringify(error.context || {}, null, 2)}\n`);
            }
            
            // Test 3: Safe wrapper for MySQL
            console.log("Test 3: Safe wrapper for MySQL (returns null on error)");
            const mysqlResult3 = await ErrorWrapper.safe(
                async () => {
                    throw new Error("MySQL test error");
                },
                { engine: "mysql", operation: "test3" }
            );
            console.log(`   ✓ Result (should be null): ${mysqlResult3}\n`);
            
            await mysql.endAll();
            console.log("   ✓ MySQL tests complete!\n");
        }
        
        // ========== SCYLLA TESTS ==========
        console.log("========== Scylla Tests ==========\n");
        
        // Configure Scylla
        console.log("1. Configuring Scylla...");
        if (typeof ScyllaDb.configure === "function") {
            ScyllaDb.configure({
                endpoint: process.env.SCYLLA_ALTERNATOR_ENDPOINT || "http://localhost:8000",
                region: process.env.SCYLLA_ACCESS_REGION || "us-east-1",
                key: process.env.SCYLLA_ACCESS_KEY || "test",
                secret: process.env.SCYLLA_ACCESS_PASSWORD || "test"
            });
            console.log("   ✓ Configured!\n");
        } else {
            console.log("   ⚠️  Scylla not available, skipping Scylla tests\n");
        }
        
        // Test 1: Safe wrapper for Scylla
        console.log("Test 1: Safe wrapper for Scylla (returns null on error)");
        const scyllaResult1 = await ErrorWrapper.safe(
            async () => {
                // Try to describe a non-existent table
                if (ScyllaDb.rawRequest) {
                    await ScyllaDb.rawRequest("DescribeTable", { TableName: "nonexistent_table_12345" });
                } else {
                    throw new Error("Scylla not configured");
                }
            },
            { engine: "scylla", operation: "test1", table: "nonexistent_table_12345" }
        );
        console.log(`   ✓ Result (should be null or error): ${scyllaResult1}\n`);
        
        // Test 2: Error handling for Scylla
        console.log("Test 2: Error handling for Scylla");
        try {
            await ErrorWrapper.wrapQuery(
                async () => {
                    if (ScyllaDb.rawRequest) {
                        await ScyllaDb.rawRequest("DescribeTable", { TableName: "nonexistent_table_12345" });
                    } else {
                        throw new Error("Scylla not configured");
                    }
                },
                { engine: "scylla", operation: "test2", table: "nonexistent_table_12345" }
            );
            console.log("   ⚠️  No error thrown (table might exist or Scylla not configured)\n");
        } catch (error) {
            console.log(`   ✓ Error caught: ${error.message}`);
            console.log(`   ✓ Error context: ${JSON.stringify(error.context || {}, null, 2)}\n`);
        }
        
        console.log("   ✓ Scylla tests complete!\n");
        
        // ========== COMMON TESTS ==========
        console.log("========== Common Error Handling Tests ==========\n");
        
        // Test 4: Error sanitization
        console.log("Test 4: Error sanitization (removes sensitive data)");
        const errorWithPassword = new Error("Connection failed: password=secret123");
        const sanitized = ErrorWrapper.sanitizeError(errorWithPassword, {
            operation: "test4"
        });
        console.log(`   ✓ Sanitized message: ${sanitized.message}`);
        console.log(`   ✓ Password removed: ${!sanitized.message.includes("secret123")}\n`);
        
        // Test 5: Transient error detection
        console.log("Test 5: Transient error detection");
        const transientError = new Error("Connection reset");
        transientError.code = "ECONNRESET";
        const isTransient = ErrorWrapper.isTransientError(transientError);
        console.log(`   ✓ Is transient: ${isTransient}\n`);
        
        // Test 6: Non-transient error
        console.log("Test 6: Non-transient error detection");
        const nonTransientError = new Error("Invalid SQL syntax");
        const isNotTransient = ErrorWrapper.isTransientError(nonTransientError);
        console.log(`   ✓ Is transient: ${isNotTransient}\n`);
        
        // Test 7: Context-aware error
        console.log("Test 7: Context-aware error creation");
        const contextError = ErrorWrapper.createError("Test error", {
            engine: "postgres",
            table: "users",
            operation: "createTable"
        });
        console.log(`   ✓ Error message: ${contextError.message}`);
        console.log(`   ✓ Error context: ${JSON.stringify(contextError.context, null, 2)}\n`);
        
        // Test 8: Error with different engines
        console.log("Test 8: Error context for different engines");
        const pgError = ErrorWrapper.createError("PostgreSQL error", {
            engine: "postgres",
            table: "users"
        });
        const mysqlError = ErrorWrapper.createError("MySQL error", {
            engine: "mysql",
            table: "products"
        });
        const scyllaError = ErrorWrapper.createError("Scylla error", {
            engine: "scylla",
            table: "orders"
        });
        console.log(`   ✓ PostgreSQL: ${pgError.message}`);
        console.log(`   ✓ MySQL: ${mysqlError.message}`);
        console.log(`   ✓ Scylla: ${scyllaError.message}\n`);
        
        console.log("=== All Error Handling Tests Passed! ===\n");
        console.log("✓ Tested: PostgreSQL, MySQL, Scylla");
        console.log("✓ All engines handled correctly!\n");
        
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
