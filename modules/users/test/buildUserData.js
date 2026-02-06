import Users from "../src/services/Users.js";
import { runTest, assertTrue, assertNull } from './TestHelpers.js';

/**
 * Test suite for buildUserData function.
 */
export async function testBuildUserData() {
    console.log("\n--- Running Suite: buildUserData ---");

    await runTest("buildUserData: Valid UID", async () => {
        console.log("Testing with valid UID");
        const result = await Users.buildUserData("u1");
        console.log("Result:", result);
        assertTrue(result !== null, "Should return user data object");

        if (result) {
            assertTrue("displayName" in result, "Should contain displayName");
            assertTrue("userName" in result, "Should contain userName");
            assertTrue("publicUid" in result, "Should contain publicUid");
            assertTrue("initials" in result, "Should contain initials");
        }
    });

    await runTest("buildUserData: Invalid UID", async () => {
        console.log("Testing with invalid UID");
        const result = await Users.buildUserData("invalid_uid");
        console.log("Result:", result);
        assertNull(result, "Invalid UID should return null");
    });
}
