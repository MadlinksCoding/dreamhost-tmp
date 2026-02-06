import Users from '../src/services/Users.js';
import { runTest, assertTrue, assertNull } from './TestHelpers.js';

/**
 * Test suite for getCriticalUserData function.
 */
export async function testGetCriticalUserData() {
    console.log("\n--- Running Suite: getCriticalUserData ---");

    await runTest("getCriticalUserData: Valid UID", async () => {
        console.log("Testing with valid UID 'u1'");
        const cud = await Users.getCriticalUserData("u1");
        console.log("Result:", cud);
        assertTrue(cud && cud.success === true && cud.data && "username" in cud.data, "Should contain username");

        if (cud && cud.data) {
            assertTrue("displayName" in cud.data, "Should contain displayName");
            assertTrue("avatar" in cud.data, "Should contain avatar");
            assertTrue("online" in cud.data, "Should contain online status");
            assertTrue("status" in cud.data, "Should contain status");
        }
    });

    await runTest("getCriticalUserData: Empty UID", async () => {
        console.log("Testing with empty UID");
        const cud = await Users.getCriticalUserData("");
        console.log("Result:", cud);
        assertNull(cud.data, "Empty UID should return null");
    });

    await runTest("getCriticalUserData: Non-existent UID", async () => {
        console.log("Testing with non-existent UID 'non_existent_user'");
        const cud = await Users.getCriticalUserData("non_existent_user");
        console.log("Result:", cud);
        assertTrue(cud && cud.success === false && cud.data === null, "Non-existent UID should return null data");
    });
}
