"use strict";

/**
 * Test script for RetryWrapper
 * Usage: node test-retry.js
 */

const RetryWrapper = require("./utils/RetryWrapper");

(async () => {
    try {
        console.log("=== Testing RetryWrapper ===\n");
        
        // Test 1: Successful operation (no retry needed)
        console.log("Test 1: Successful operation (should succeed immediately)");
        const wrapper1 = new RetryWrapper({ maxRetries: 3, initialDelay: 100 });
        
        const result1 = await wrapper1.execute(
            async () => {
                console.log("   Attempting operation...");
                return "Success!";
            },
            { operation: "test1" }
        );
        console.log(`   ✓ Result: ${result1}\n`);
        
        // Test 2: Transient error (should retry)
        console.log("Test 2: Transient error (should retry 2 times then succeed)");
        let attemptCount = 0;
        const wrapper2 = new RetryWrapper({ 
            maxRetries: 3, 
            initialDelay: 200,
            logger: (msg, ctx) => console.log(`   [RETRY] ${msg}`)
        });
        
        const result2 = await wrapper2.execute(
            async () => {
                attemptCount++;
                console.log(`   Attempt ${attemptCount}...`);
                if (attemptCount < 3) {
                    // Simulate transient error
                    const error = new Error("ECONNRESET");
                    error.code = "ECONNRESET";
                    throw error;
                }
                return "Success after retries!";
            },
            { operation: "test2" }
        );
        console.log(`   ✓ Result: ${result2}\n`);
        
        // Test 3: Non-transient error (should fail immediately)
        console.log("Test 3: Non-transient error (should fail without retry)");
        const wrapper3 = new RetryWrapper({ maxRetries: 3, initialDelay: 100 });
        
        try {
            await wrapper3.execute(
                async () => {
                    throw new Error("Invalid input");
                },
                { operation: "test3" }
            );
            console.log("   ❌ Should have thrown error");
        } catch (error) {
            console.log(`   ✓ Correctly failed: ${error.message}\n`);
        }
        
        // Test 4: Max retries exceeded
        console.log("Test 4: Max retries exceeded (should fail after 3 retries)");
        let retryCount = 0;
        const wrapper4 = new RetryWrapper({ 
            maxRetries: 3, 
            initialDelay: 100,
            logger: (msg) => console.log(`   ${msg}`)
        });
        
        try {
            await wrapper4.execute(
                async () => {
                    retryCount++;
                    const error = new Error("ECONNRESET");
                    error.code = "ECONNRESET";
                    throw error;
                },
                { operation: "test4" }
            );
            console.log("   ❌ Should have thrown error");
        } catch (error) {
            console.log(`   ✓ Correctly failed after ${retryCount} attempts: ${error.message}\n`);
        }
        
        // Test 5: Static helper
        console.log("Test 5: Using static retry helper");
        const result5 = await RetryWrapper.retry(
            async () => {
                return "Static helper works!";
            },
            { maxRetries: 2, initialDelay: 50 },
            { operation: "test5" }
        );
        console.log(`   ✓ Result: ${result5}\n`);
        
        console.log("=== All Retry Tests Passed! ===\n");
        
    } catch (error) {
        console.error("\n❌ Error:", error.message);
        if (error.stack) {
            console.error("\nStack trace:");
            console.error(error.stack);
        }
        process.exit(1);
    }
})();










