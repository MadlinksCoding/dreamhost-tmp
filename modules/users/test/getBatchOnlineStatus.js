import Users from '../src/services/Users.js';
import { runTest, assertEqual, assertTrue } from './TestHelpers.js';

// TODO: this is a Redis-Only Function Will Fail!!

/**
 * Test suite for getBatchOnlineStatus function.
 */
export async function testGetBatchOnlineStatus() {
    console.log("\n--- Running Suite: getBatchOnlineStatus ---");

    await runTest("getBatchOnlineStatus: Multiple UIDs", async () => {
        console.log("Testing with multiple UIDs");
        const result = await Users.getBatchOnlineStatus(["u1", "u2", "u3"]);
        console.log("Result:", result);
        assertTrue(Array.isArray(result), "Should return an array");
        assertEqual(result.length, 3, "Should return status for all 3 UIDs");
    });

    await runTest("getBatchOnlineStatus: Empty array", async () => {
        console.log("Testing with empty array");
        const result = await Users.getBatchOnlineStatus([]);
        console.log("Result:", result);
        assertTrue(Array.isArray(result), "Should return an array");
        assertEqual(result.length, 0, "Empty input should return empty array");
    });
}
