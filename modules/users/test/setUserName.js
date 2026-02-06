import Users from '../src/services/Users.js';
import { runTest, assertTrue, assertEqual } from './TestHelpers.js';

/**
 * Test suite for setUsername function.
 */
export async function testSetUsername() {
    console.log("\n--- Running Suite: setUsername ---");

    await runTest("setUsername: Valid username change", async () => {
        console.log("Testing with valid username change");
        const result = await Users.setUsername("u1", "new_username");
        console.log("Result:", result);
        assertTrue(result.success, "Should successfully set username");
        assertTrue("previous" in result, "Should include previous username in response");
    });

    await runTest("setUsername: Invalid username format - too short", async () => {
        console.log("Testing with username that is too short");
        const result = await Users.setUsername("u1", "ab");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for short username");
        assertEqual(result.error, "INVALID_USERNAME_FORMAT", "Should return format error");
    });

    await runTest("setUsername: Invalid username format - too long", async () => {
        console.log("Testing with username that is too long");
        const longUsername = "a".repeat(31);
        const result = await Users.setUsername("u1", longUsername);
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for long username");
        assertEqual(result.error, "INVALID_USERNAME_FORMAT", "Should return format error");
    });

    await runTest("setUsername: Invalid username format - special characters", async () => {
        console.log("Testing with username containing invalid characters");
        const result = await Users.setUsername("u1", "user@name!");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for invalid characters");
        assertEqual(result.error, "INVALID_USERNAME_FORMAT", "Should return format error");
    });

    await runTest("setUsername: Empty username", async () => {
        console.log("Testing with empty username");
        const result = await Users.setUsername("u1", "");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for empty username");
    });

    await runTest("setUsername: Null username", async () => {
        console.log("Testing with null username");
        const result = await Users.setUsername("u1", null);
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for null username");
    });

    await runTest("setUsername: Undefined username", async () => {
        console.log("Testing with undefined username");
        const result = await Users.setUsername("u1", undefined);
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for undefined username");
    });

    await runTest("setUsername: Empty user ID", async () => {
        console.log("Testing with empty user ID");
        const result = await Users.setUsername("", "valid_username");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for empty user ID");
    });

    await runTest("setUsername: Null user ID", async () => {
        console.log("Testing with null user ID");
        const result = await Users.setUsername(null, "valid_username");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for null user ID");
    });

    await runTest("setUsername: Undefined user ID", async () => {
        console.log("Testing with undefined user ID");
        const result = await Users.setUsername(undefined, "valid_username");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for undefined user ID");
    });

    await runTest("setUsername: Non-existent user ID", async () => {
        console.log("Testing with non-existent user ID");
        const result = await Users.setUsername("non_existent_user", "valid_username");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should attempt update even for non-existent user");
    });

    await runTest("setUsername: Username with valid special characters", async () => {
        console.log("Testing with username containing valid special characters");
        const result = await Users.setUsername("u1", "user.name-123");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should allow dots, dashes, and numbers");
    });

    await runTest("setUsername: Username normalization", async () => {
        console.log("Testing username normalization");
        const result = await Users.setUsername("u1", "  MixedCase.User  ");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should normalize username");
    });

    await runTest("setUsername: Same username as current", async () => {
        console.log("Testing setting same username as current");
        const result = await Users.setUsername("u1", "user1");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should allow setting same username");
    });

    await runTest("setUsername: Very long user ID", async () => {
        console.log("Testing with very long user ID");
        const longUserId = "a".repeat(100);
        const result = await Users.setUsername(longUserId, "valid_username");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should handle long user IDs");
    });

    await runTest("setUsername: Whitespace-only username", async () => {
        console.log("Testing with whitespace-only username");
        const result = await Users.setUsername("u1", "     ");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for whitespace-only username");
    });

    await runTest("setUsername: Minimum length username", async () => {
        console.log("Testing with minimum length username");
        const result = await Users.setUsername("u1", "abc");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should allow 3-character username");
    });

    await runTest("setUsername: Maximum length username", async () => {
        console.log("Testing with maximum length username");
        const maxUsername = "a".repeat(30);
        const result = await Users.setUsername("u1", maxUsername);
        console.log("Result:", result);
        assertEqual(result.success, true, "Should allow 30-character username");
    });

    await runTest("setUsername: Username with mixed valid characters", async () => {
        console.log("Testing with mixed valid characters");
        const result = await Users.setUsername("u1", "User_123.Name-Test");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should allow mixed valid characters");
    });

    await runTest("setUsername: Case sensitivity handling", async () => {
        console.log("Testing case sensitivity handling");
        const result1 = await Users.setUsername("u1", "TestCase");
        const result2 = await Users.setUsername("u2", "testcase");
        console.log("Results:", { result1, result2 });
        assertEqual(result1.success, true, "First username should be set");
        assertEqual(result2.success, false, "Second username should not be set despite since they usernames are case insensitive");
    });
}
