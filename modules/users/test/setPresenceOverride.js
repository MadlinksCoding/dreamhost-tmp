import Users from '../src/services/Users.js';
import { runTest, assertTrue } from './TestHelpers.js';

/**
 * Test suite for setPresenceOverride function.
 */
export async function testSetPresenceOverride() {
    console.log("\n--- Running Suite: setPresenceOverride ---");

    await runTest("setPresenceOverride: Valid parameters", async () => {
        console.log("Testing with valid UID and mode");
        const result = await Users.setPresenceOverride("u1", "away");
        console.log("Result:", result);
        assertTrue(result.success !== null, "Should return true showing that the presence has been overridden");
    });

    await runTest("setPresenceOverride: Invalid mode", async () => {
        console.log("Testing with invalid presence mode");
        const result = await Users.setPresenceOverride("u1", "invalid_mode");
        console.log("Result:", result);
        assertTrue(result.success === false, "Invalid mode should return error");
    });
}
