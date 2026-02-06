import Users from '../src/services/Users.js';
import { runTest, assertEqual, assertTrue } from './TestHelpers.js';

/**
 * Test suite for username functions.
 */
export async function testUsernameFunctions() {
    console.log("\n--- Running Suite: Username Functions ---");

    // TODO: re-enable this when the Redis client is implemented
    //
    // await runTest("isUsernameTaken: Available username", async () => {
    //     console.log("Testing with available username");
    //     const result = await Users.isUsernameTaken("new_username_123");
    //     console.log("Result:", result);
    //     assertEqual(typeof result, "boolean", "Should return boolean");
    // });

    // TODO: re-enable this when the Redis client is implemented
    //
    // await runTest("setUsername: Valid username", async () => {
    //     console.log("Testing setting valid username");
    //     const result = await Users.setUsername("u1", "new_username");
    //     console.log("Result:", result);
    //     assertTrue(result.success === true, "Should successfully set username");
    // });

    // TODO: re-enable this when the Redis client is implemented
    //
    // await runTest("setUsername: Invalid format", async () => {
    //     console.log("Testing setting invalid username format");
    //     const result = await Users.setUsername("u1", "ab");
    //     console.log("Result:", result);
    //     assertTrue(result.success === false, "Invalid format should fail");
    // });
}
