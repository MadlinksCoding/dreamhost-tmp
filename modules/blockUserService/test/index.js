import { setupTestEnvironment, cleanupTestEnvironment } from "./setup.js";
import { passedTestCounter, failedTestCounter, testCounter } from "./TestHelpers.js";
import { testBlockService } from "./blockServiceTests.js";

const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

async function runAllTests() {
    console.log("========= STARTING BLOCK_SERVICE TEST RUN =========");
    
    try {
        await setupTestEnvironment();
        
        // === RUN TEST FILES HERE ===
        await testBlockService();
        
        
    } catch (error) {
        console.error("A CRITICAL ERROR HALTED THE TEST RUNNER:", error);
    } finally {
        await cleanupTestEnvironment();
        
        console.log("\n========= TEST RUN COMPLETE =========");
        
        console.log(`${COLORS.bright}${COLORS.blue}TOTAL TESTS:${COLORS.reset}  ${testCounter - 1}`);
        console.log(`${COLORS.bright}${COLORS.green}PASSED TESTS:${COLORS.reset} ${passedTestCounter}`);
        console.log(`${COLORS.bright}${COLORS.red}FAILED TESTS:${COLORS.reset}  ${failedTestCounter}`);
        
        if (failedTestCounter === 0) {
            console.log(`\n${COLORS.bright}${COLORS.green}✓ ALL TESTS PASSED${COLORS.reset}`);
            process.exit(0);
        } else {
            console.log(`\n${COLORS.bright}${COLORS.red}✗ ${failedTestCounter} TEST(S) FAILED${COLORS.reset}`);
            process.exit(1);
        }
    }
}

runAllTests();
