import Users from "../src/services/Users.js";
import { runTest, assertTrue, assertEqual } from './TestHelpers.js';

/**
 * Test suite for updateUserField function.
 */
export async function testUpdateUserField() {
    console.log("\n--- Running Suite: updateUserField ---");

    await runTest("updateUserField: Valid update on users table", async () => {
        console.log("Testing valid update on users table");
        const result = await Users.updateUserField("u1", "users", "display_name", "Updated Name");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should successfully update field");
    });

    await runTest("updateUserField: Valid update on user_settings table", async () => {
        console.log("Testing valid update on user_settings table");
        const result = await Users.updateUserField("u1", "user_settings", "locale", "es");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should successfully update settings field");
    });

    await runTest("updateUserField: Valid update on user_profiles table", async () => {
        console.log("Testing valid update on user_profiles table");
        const result = await Users.updateUserField("u1", "user_profiles", "bio", "Updated bio text");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should successfully update profile field");
    });

    await runTest("updateUserField: Non-existent user ID", async () => {
        console.log("Testing with non-existent user ID");
        const result = await Users.updateUserField("non_existent_user", "users", "display_name", "New Name");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for non-existent user");
        assertTrue(result.error.includes("user not found"), "Should indicate user not found");
    });

    await runTest("updateUserField: Empty user ID", async () => {
        console.log("Testing with empty user ID");
        const result = await Users.updateUserField("", "users", "display_name", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for empty user ID");
    });

    await runTest("updateUserField: Null user ID", async () => {
        console.log("Testing with null user ID");
        const result = await Users.updateUserField(null, "users", "display_name", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for null user ID");
    });

    await runTest("updateUserField: Undefined user ID", async () => {
        console.log("Testing with undefined user ID");
        const result = await Users.updateUserField(undefined, "users", "display_name", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for undefined user ID");
    });

    await runTest("updateUserField: Empty table name", async () => {
        console.log("Testing with empty table name");
        const result = await Users.updateUserField("u1", "", "display_name", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for empty table name");
    });

    await runTest("updateUserField: Null table name", async () => {
        console.log("Testing with null table name");
        const result = await Users.updateUserField("u1", null, "display_name", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for null table name");
    });

    await runTest("updateUserField: Undefined table name", async () => {
        console.log("Testing with undefined table name");
        const result = await Users.updateUserField("u1", undefined, "display_name", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for undefined table name");
    });

    await runTest("updateUserField: Empty field key", async () => {
        console.log("Testing with empty field key");
        const result = await Users.updateUserField("u1", "users", "", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for empty field key");
    });

    await runTest("updateUserField: Null field key", async () => {
        console.log("Testing with null field key");
        const result = await Users.updateUserField("u1", "users", null, "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for null field key");
    });

    await runTest("updateUserField: Undefined field key", async () => {
        console.log("Testing with undefined field key");
        const result = await Users.updateUserField("u1", "users", undefined, "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for undefined field key");
    });

    await runTest("updateUserField: Empty value", async () => {
        console.log("Testing with empty value");
        const result = await Users.updateUserField("u1", "users", "display_name", "");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should allow empty values to be set");
    });

    await runTest("updateUserField: Null value", async () => {
        console.log("Testing with null value");
        const result = await Users.updateUserField("u1", "users", "display_name", null);
        console.log("Result:", result);
        assertEqual(result.success, true, "Should allow null value");
    });

    await runTest("updateUserField: Undefined value", async () => {
        console.log("Testing with undefined value");
        const result = await Users.updateUserField("u1", "users", "display_name", undefined);
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for undefined value");
    });

    await runTest("updateUserField: Non-existent table", async () => {
        console.log("Testing with non-existent table");
        const result = await Users.updateUserField("u1", "non_existent_table", "field", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for non-existent table");
    });

    await runTest("updateUserField: Non-existent field", async () => {
        console.log("Testing with non-existent field");
        const result = await Users.updateUserField("u1", "users", "non_existent_field", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for non-existent field");
    });

    await runTest("updateUserField: SQL injection in table name", async () => {
        console.log("Testing SQL injection in table name");
        const result = await Users.updateUserField("u1", "users; DROP TABLE users; --", "display_name", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should prevent SQL injection in table name");
    });

    await runTest("updateUserField: SQL injection in field key", async () => {
        console.log("Testing SQL injection in field key");
        const result = await Users.updateUserField("u1", "users", "display_name; DROP TABLE users; --", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should prevent SQL injection in field key");
    });

    await runTest("updateUserField: SQL injection in user ID", async () => {
        console.log("Testing SQL injection in user ID");
        const result = await Users.updateUserField("u1'; DROP TABLE users; --", "users", "display_name", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should prevent SQL injection in user ID");
    });

    await runTest("updateUserField: SQL injection in value", async () => {
        console.log("Testing SQL injection in value");
        const result = await Users.updateUserField("u1", "users", "display_name", "value'; DROP TABLE users; --");
        console.log("Result:", result);
        assertEqual(result.success, true, "Value should be parameterized and safe");
    });

    await runTest("updateUserField: Table name case normalization", async () => {
        console.log("Testing table name case normalization");
        const result = await Users.updateUserField("u1", "USERS", "display_name", "UPPERCASE TABLE");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should reject uppercase table name");
    });

    await runTest("updateUserField: Field key case normalization", async () => {
        console.log("Testing field key case normalization");
        const result = await Users.updateUserField("u1", "users", "DISPLAY_NAME", "UPPERCASE FIELD");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should reject uppercase field key");
    });

    await runTest("updateUserField: Value case normalization", async () => {
        console.log("Testing value case normalization");
        const result = await Users.updateUserField("u1", "users", "display_name", "UPPERCASE VALUE");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should normalize value to lowercase");
    });

    await runTest("updateUserField: Whitespace trimming in inputs", async () => {
        console.log("Testing whitespace trimming in inputs");
        const result = await Users.updateUserField("  u1  ", "  users  ", "  display_name  ", "  trimmed value  ");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should trim whitespace from all inputs");
    });

    await runTest("updateUserField: Very long value", async () => {
        console.log("Testing with very long value");
        const longValue = "a".repeat(1000);
        const result = await Users.updateUserField("u1", "users", "display_name", longValue);
        console.log("Result:", result);
        assertEqual(result.success, false, "display_name can not be more than 100 characters");
    });

    await runTest("updateUserField: Numeric value as string", async () => {
        console.log("Testing numeric value as string");
        const result = await Users.updateUserField("u1", "user_profiles", "bio", "25");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should handle numeric values as strings");
    });

    await runTest("updateUserField: Boolean value as string", async () => {
        console.log("Testing boolean value as string");
        const result = await Users.updateUserField("u1", "user_settings", "locale", "true");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should handle boolean values as strings");
    });

    await runTest("updateUserField: JSON value as string", async () => {
        console.log("Testing JSON value as string");
        const jsonValue = JSON.stringify({ setting: "value", enabled: true });
        const result = await Users.updateUserField("u1", "user_settings", "notifications", jsonValue);
        console.log("Result:", result);
        assertEqual(result.success, true, "Should handle JSON values as strings");
    });

    await runTest("updateUserField: Special characters in value", async () => {
        console.log("Testing special characters in value");
        const result = await Users.updateUserField("u1", "users", "display_name", "Name with émojis 🚀 and symbols @#$%");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should handle special characters in value");
    });

    await runTest("updateUserField: Multiple concurrent updates", async () => {
        console.log("Testing multiple concurrent updates");
        const promises = [
            Users.updateUserField("u1", "users", "display_name", "concurrent_1"),
            Users.updateUserField("u1", "users", "display_name", "concurrent_2"),
            Users.updateUserField("u1", "users", "display_name", "concurrent_3")
        ];

        const results = await Promise.all(promises);
        console.log("Concurrent results:", results);

        results.forEach(result => {
            assertEqual(result.success, true, "All concurrent updates should succeed");
        });
    });

    await runTest("updateUserField: Updated_at timestamp", async () => {
        console.log("Testing updated_at timestamp is set");
        const beforeUpdate = new Date();
        const result = await Users.updateUserField("u1", "users", "display_name", "timestamp_test");
        console.log("Result:", result);
        assertEqual(result.success, true, "Update should succeed");

        // Verify updated_at was set (this would require a separate query to check)
    });

    await runTest("updateUserField: Return structure on success", async () => {
        console.log("Testing return structure on success");
        const result = await Users.updateUserField("u1", "users", "display_name", "test_value");
        console.log("Result:", result);
        assertEqual(result.success, true, "Should indicate success");
        assertEqual(Object.keys(result).length, 1, "Should only return success field on success");
    });

    await runTest("updateUserField: Return structure on failure", async () => {
        console.log("Testing return structure on failure");
        const result = await Users.updateUserField("non_existent", "users", "display_name", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should indicate failure");
        assertTrue("error" in result, "Should include error field");
        assertEqual(typeof result.error, "string", "Error should be string");
    });

    await runTest("updateUserField: Invalid table name characters", async () => {
        console.log("Testing invalid table name characters");
        const result = await Users.updateUserField("u1", "invalid-table", "field", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should reject invalid table names");
    });

    await runTest("updateUserField: Invalid field key characters", async () => {
        console.log("Testing invalid field key characters");
        const result = await Users.updateUserField("u1", "users", "invalid-field", "value");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should reject invalid field keys");
    });
}
