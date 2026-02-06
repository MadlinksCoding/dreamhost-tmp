import { db } from '../src/utils/index.js';
import { testCounter, passedTestCounter, failedTestCounter } from './TestHelpers.js';
import { testBuildUserData } from './buildUserData.js';
import { testHelperFunctions } from './helperFunctions.js';
import { testSetPresenceOverride } from './setPresenceOverride.js';
import { testGetCriticalUserData } from './getCriticalUserData.js';
import { testGetCriticalUsersData } from './getCriticalUsersData.js';
import { testBuildUserProfile } from './buildUserProfile.js';
import { testBuildUserSettings } from './buildUserSettings.js';
import { testSetUsername } from './setUserName.js';
import { testUpdateUserField } from './updateUserField.js';
import { testGetUserField } from './getUserField.js';
import { seedTestUsers, cleanupTestUsers } from './setup.js';
// import {testGetBatchOnlineStatus} from './getBatchOnlineStatus.js';

const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

/**
 * Main function to run all test suites.
 */
async function runAllTests() {
    console.log("========= STARTING USER_CLASS TEST RUN =========");
    let testErrorCount = 0;
    try {
        await seedTestUsers();
    } catch (err) {
        testErrorCount++;
        console.error("[SEED ERROR]", err);
    }
    const testSuites = [
        testHelperFunctions,
        testBuildUserData,
        testBuildUserProfile,
        testGetCriticalUserData,
        testBuildUserSettings,
        testGetCriticalUsersData,
        testSetPresenceOverride,
        testSetUsername,
        testUpdateUserField,
        testGetUserField
    ];
    for (const suite of testSuites) {
        try {
            await suite();
        } catch (err) {
            testErrorCount++;
            console.error(`[SUITE ERROR] ${suite.name}:`, err);
        }
    }
    console.log("\n========= TEST RUN COMPLETE =========");
    try {
        await cleanupTestUsers();
    } catch (err) {
        testErrorCount++;
        console.error("[CLEANUP ERROR]", err);
    }
    console.log(`${COLORS.bright}${COLORS.blue}TOTAL TESTS:${COLORS.reset}  ${testCounter - 1}`);
    console.log(`${COLORS.bright}${COLORS.green}PASSED TESTS:${COLORS.reset} ${passedTestCounter}`);
    console.log(`${COLORS.bright}${COLORS.red}FAILED TESTS:${COLORS.reset}  ${failedTestCounter}`);
    if (failedTestCounter === 0 && testErrorCount === 0) {
        console.log(`\n${COLORS.bright}${COLORS.green}✓ ALL TESTS PASSED${COLORS.reset}`);
    } else {
        console.log(`\n${COLORS.bright}${COLORS.red}✗ ${failedTestCounter + testErrorCount} TEST(S) FAILED${COLORS.reset}`);
    }
}

runAllTests().catch(err => {
    console.error("A CRITICAL ERROR HALTED THE TEST RUNNER:", err);
}).finally(() => {
    db.closeAll();
    process.exit(0);
});
