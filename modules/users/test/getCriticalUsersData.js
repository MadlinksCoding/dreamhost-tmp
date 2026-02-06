import Users from '../src/services/Users.js';
import { runTest, assertTrue, assertEqual } from './TestHelpers.js';

/**
 * Test suite for getCriticalUsersData function (updated implementation).
 */
export async function testGetCriticalUsersData() {
    console.log("\n--- Running Suite: getCriticalUsersData ---");

    await runTest("getCriticalUsersData: Single valid user ID", async () => {
        console.log("Testing with single valid user ID");
            const result = await Users.getCriticalUsersData(["u1"]);
            console.log("Result:", result);
            assertTrue(Array.isArray(result.data), "Should return an array");
            assertEqual(result.data.length, 1, "Should return one result");
            assertEqual(result.data[0].uid, "u1", "Should preserve user ID in result");
            assertTrue("username" in result.data[0], "Should contain username");
            assertTrue("displayName" in result.data[0], "Should contain displayName");
            assertTrue("avatar" in result.data[0], "Should contain avatar");
            assertTrue("online" in result.data[0], "Should contain online status");
            assertTrue("status" in result.data[0], "Should contain status");
    });

    await runTest("getCriticalUsersData: Multiple valid user IDs", async () => {
        console.log("Testing with multiple valid user IDs");
        const userIds = ["u1", "u2", "u3"];
            const result = await Users.getCriticalUsersData(userIds);
            console.log("Result:", result);
            assertEqual(result.data.length, 3, "Should return three results");
            assertEqual(result.data[0].uid, "u1", "First result should be u1");
            assertEqual(result.data[1].uid, "u2", "Second result should be u2");
            assertEqual(result.data[2].uid, "u3", "Third result should be u3");
    });

    await runTest("getCriticalUsersData: Order preservation", async () => {
        console.log("Testing input order preservation");
        const userIds = ["u3", "u1", "u2"];
            const result = await Users.getCriticalUsersData(userIds);
            console.log("Result:", result);
            assertEqual(result.data[0].uid, "u3", "Should preserve input order - first");
            assertEqual(result.data[1].uid, "u1", "Should preserve input order - second");
            assertEqual(result.data[2].uid, "u2", "Should preserve input order - third");
    });

    await runTest("getCriticalUsersData: All users miss Redis (current implementation)", async () => {
        console.log("Testing with all users missing from Redis");
        const userIds = ["u1", "u2", "u3"];
            const result = await Users.getCriticalUsersData(userIds);
            console.log("Result:", result);
            assertEqual(result.data.length, 3, "Should return three results");
            // All users should go through getCriticalUserData individually
            result.data.forEach(user => {
                assertTrue("username" in user, "Each user should have username");
                assertTrue("displayName" in user, "Each user should have displayName");
                assertTrue("avatar" in user, "Each user should have avatar");
                assertTrue("online" in user, "Each user should have online status");
                assertTrue("status" in user, "Each user should have status");
            });
    });

    await runTest("getCriticalUsersData: Mixed valid and non-existent users", async () => {
        console.log("Testing with mixed valid and non-existent users");
        const userIds = ["u1", "non_existent_user", "u2"];
            const result = await Users.getCriticalUsersData(userIds);
            console.log("Result:", result);
            assertEqual(result.data.length, 3, "Should return three results");
            assertEqual(result.data[0].uid, "u1", "First should be valid user");
            assertEqual(result.data[1].uid, "non_existent_user", "Second should be non-existent user");
            assertEqual(result.data[2].uid, "u2", "Third should be valid user");
            // Non-existent user should have default values from getCriticalUserData
            assertEqual(result.data[1].username, "", "Non-existent user should have empty username");
            assertEqual(result.data[1].online, false, "Non-existent user should be offline");
            assertEqual(result.data[1].status, "offline", "Non-existent user should have offline status");
    });

    await runTest("getCriticalUsersData: Empty array", async () => {
        console.log("Testing with empty array");
            const result = await Users.getCriticalUsersData([]);
            console.log("Result:", result);
            assertTrue(Array.isArray(result.data), "Should return an array");
            assertEqual(result.data.length, 0, "Empty input should return empty array");
    });

    await runTest("getCriticalUsersData: Null input", async () => {
        console.log("Testing with null input");
            const result = await Users.getCriticalUsersData(null);
            console.log("Result:", result);
            assertTrue(Array.isArray(result.data), "Should return an array");
            assertEqual(result.data.length, 0, "Null input should return empty array");
    });

    await runTest("getCriticalUsersData: Undefined input", async () => {
        console.log("Testing with undefined input");
            const result = await Users.getCriticalUsersData(undefined);
            console.log("Result:", result);
            assertTrue(Array.isArray(result.data), "Should return an array");
            assertEqual(result.data.length, 0, "Undefined input should return empty array");
    });

    await runTest("getCriticalUsersData: Single empty string user ID", async () => {
        console.log("Testing with single empty string user ID");
            const result = await Users.getCriticalUsersData([""]);
            console.log("Result:", result);
            assertEqual(result.data.length, 0, "Should return an empty result");
    });

    await runTest("getCriticalUsersData: Mixed valid and empty user IDs", async () => {
        console.log("Testing with mixed valid and empty user IDs");
        const userIds = ["u1", "", "u2"];
            const result = await Users.getCriticalUsersData(userIds);
            console.log("Result:", result);
            assertEqual(result.data.length, 2, "Should return two results");
            assertEqual(result.data[0].uid, "u1", "First should be valid user");
            assertEqual(result.data[1].uid, "u2", "Third should be valid user");
    });

    await runTest("getCriticalUsersData: Maximum allowed user IDs (200)", async () => {
        console.log("Testing with maximum allowed user IDs");
        const maxUserIds = Array.from({ length: 200 }, (_, i) => `u${i}`);
            const result = await Users.getCriticalUsersData(maxUserIds);
            console.log("Result length:", result.data.length);
            assertEqual(result.data.length, 200, "Should return 200 results");
    });


    await runTest("getCriticalUsersData: Exceeding maximum user IDs (201)", async () => {
        console.log("Testing with exceeding maximum user IDs");
        const tooManyUserIds = Array.from({ length: 201 }, (_, i) => `u${i}`);
            const result = await Users.getCriticalUsersData(tooManyUserIds);
            console.log("Result:", result);
            assertTrue(Array.isArray(result.data), "Should return an array despite validation error");
            assertEqual(result.data.length, 0, "Should return empty array on validation error");
    });

    await runTest("getCriticalUsersData: Duplicate user IDs", async () => {
        console.log("Testing with duplicate user IDs");
        const userIds = ["u1", "u2", "u1", "u3"];
            const result = await Users.getCriticalUsersData(userIds);
            console.log("Result:", result);
            assertEqual(result.data.length, 4, "Should return four results (preserving duplicates)");
            assertEqual(result.data[0].uid, "u1", "First should be u1");
            assertEqual(result.data[1].uid, "u2", "Second should be u2");
            assertEqual(result.data[2].uid, "u1", "Third should be u1 (duplicate)");
            assertEqual(result.data[3].uid, "u3", "Fourth should be u3");
    });

    await runTest("getCriticalUsersData: All non-existent users", async () => {
        console.log("Testing with all non-existent users");
        const userIds = ["non_exist_1", "non_exist_2", "non_exist_3"];
        const result = await Users.getCriticalUsersData(userIds);
        console.log("Result:", result);
        assertEqual(result.data.length, 3, "Should return three results");
        result.data.forEach(user => {
            assertEqual(user.username, "", "All non-existent users should have empty username");
            assertEqual(user.displayName, "", "All non-existent users should have empty displayName");
            assertEqual(user.avatar, "", "All non-existent users should have empty avatar");
            assertEqual(user.online, false, "All non-existent users should be offline");
            assertEqual(user.status, "offline", "All non-existent users should have offline status");
        });
    });


    await runTest("getCriticalUsersData: Error handling in getCriticalUserData", async () => {
        console.log("Testing error handling when getCriticalUserData fails");
        const userIds = ["error_user"];
        const result = await Users.getCriticalUsersData(userIds);
        console.log("Result:", result);
        assertEqual(result.data.length, 1, "Should return one result even on individual failure");
        // Should fall back to default values when getCriticalUserData fails
        assertEqual(result.data[0].username, "", "Should have empty username on individual failure");
        assertEqual(result.data[0].online, false, "Should be offline on individual failure");
    });

    await runTest("getCriticalUsersData: Result structure consistency", async () => {
        console.log("Testing result structure consistency");
        const userIds = ["u1", "non_existent", "u2"];
        const result = await Users.getCriticalUsersData(userIds);
        console.log("Result:", result);

        result.data.forEach(user => {
            const expectedKeys = ["uid", "username", "displayName", "avatar", "online", "status"];
            const actualKeys = Object.keys(user);
            expectedKeys.forEach(key => {
                assertTrue(actualKeys.includes(key), `Each user should have ${key} property`);
            });
        });
    });

    await runTest("getCriticalUsersData: Parameter name change consistency", async () => {
        console.log("Testing parameter name change from uids to userIds");
        const result1 = await Users.getCriticalUsersData(["u1"]);
        const result2 = await Users.getCriticalUsersData(["u2"]);
        console.log("Results:", { result1, result2 });
        assertTrue(Array.isArray(result1.data), "Should work with new parameter name");
        assertTrue(Array.isArray(result2.data), "Should work with new parameter name");
    });

    await runTest("getCriticalUsersData: Empty string in array", async () => {
        console.log("Testing with array containing only empty strings");
        const result = await Users.getCriticalUsersData(["", ""]);
        console.log("Result:", result);
        assertEqual(result.data.length, 0, "Should return an empty result array");
    });
}
