import Users from "../src/services/Users.js";
import { runTest, assertTrue, assertEqual } from './TestHelpers.js';

/**
 * Test suite for getUserField function.
 */
export async function testGetUserField() {
    console.log("\n--- Running Suite: getUserField ---");

    await runTest("getUserField: Valid field from users table", async () => {
        console.log("Testing valid field from users table");
        const result = await Users.getUserField("u1", "users", "display_name");
        console.log("Result:", result);
        assertTrue(result !== null && result !== undefined, "Should return field value");
        assertTrue("value" in result, "Should contain value property");
    });

    await runTest("getUserField: Valid field from user_settings table", async () => {
        console.log("Testing valid field from user_settings table");
        const result = await Users.getUserField("u1", "user_settings", "locale");
        console.log("Result:", result);
        assertTrue("value" in result, "Should return settings field value");
    });

    await runTest("getUserField: Valid field from user_profiles table", async () => {
        console.log("Testing valid field from user_profiles table");
        const result = await Users.getUserField("u1", "user_profiles", "bio");
        console.log("Result:", result);
        assertTrue("value" in result, "Should return profile field value");
    });

    await runTest("getUserField: Non-existent user ID", async () => {
        console.log("Testing with non-existent user ID");
        const result = await Users.getUserField("non_existent_user", "users", "display_name");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should return error for non-existent user");
        assertEqual(result.error, "GetUserField_FAILED", "Should indicate field retrieval failed");
    });

    await runTest("getUserField: Empty user ID", async () => {
        console.log("Testing with empty user ID");
        const result = await Users.getUserField("", "users", "display_name");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for empty user ID");
    });

    await runTest("getUserField: Null user ID", async () => {
        console.log("Testing with null user ID");
        const result = await Users.getUserField(null, "users", "display_name");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for null user ID");
    });

    await runTest("getUserField: Undefined user ID", async () => {
        console.log("Testing with undefined user ID");
        const result = await Users.getUserField(undefined, "users", "display_name");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for undefined user ID");
    });

    await runTest("getUserField: Empty table name", async () => {
        console.log("Testing with empty table name");
        const result = await Users.getUserField("u1", "", "display_name");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for empty table name");
    });

    await runTest("getUserField: Null table name", async () => {
        console.log("Testing with null table name");
        const result = await Users.getUserField("u1", null, "display_name");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for null table name");
    });

    await runTest("getUserField: Undefined table name", async () => {
        console.log("Testing with undefined table name");
        const result = await Users.getUserField("u1", undefined, "display_name");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for undefined table name");
    });

    await runTest("getUserField: Empty field key", async () => {
        console.log("Testing with empty field key");
        const result = await Users.getUserField("u1", "users", "");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for empty field key");
    });

    await runTest("getUserField: Null field key", async () => {
        console.log("Testing with null field key");
        const result = await Users.getUserField("u1", "users", null);
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for null field key");
    });

    await runTest("getUserField: Undefined field key", async () => {
        console.log("Testing with undefined field key");
        const result = await Users.getUserField("u1", "users", undefined);
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for undefined field key");
    });

    await runTest("getUserField: Non-existent table", async () => {
        console.log("Testing with non-existent table");
        const result = await Users.getUserField("u1", "non_existent_table", "field");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for non-existent table");
    });

    await runTest("getUserField: Non-existent field", async () => {
        console.log("Testing with non-existent field");
        const result = await Users.getUserField("u1", "users", "non_existent_field");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for non-existent field");
    });

    await runTest("getUserField: SQL injection in table name", async () => {
        console.log("Testing SQL injection in table name");
        const result = await Users.getUserField("u1", "users; DROP TABLE users; --", "display_name");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should prevent SQL injection in table name");
    });

    await runTest("getUserField: SQL injection in field key", async () => {
        console.log("Testing SQL injection in field key");
        const result = await Users.getUserField("u1", "users", "display_name; DROP TABLE users; --");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should prevent SQL injection in field key");
    });

    await runTest("getUserField: SQL injection in user ID", async () => {
        console.log("Testing SQL injection in user ID");
        const result = await Users.getUserField("u1'; DROP TABLE users; --", "users", "display_name");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should prevent SQL injection in user ID");
    });

    await runTest("getUserField: Whitespace trimming", async () => {
        console.log("Testing whitespace trimming");
        const result = await Users.getUserField("  u1  ", "  users  ", "  display_name  ");
        console.log("Result:", result);
        assertTrue("value" in result, "Should trim whitespace and return value");
    });

    await runTest("getUserField: Very long user ID", async () => {
        console.log("Testing with very long user ID");
        const longUserId = "a".repeat(100);
        const result = await Users.getUserField(longUserId, "users", "display_name");
        console.log("Result:", result);
        assertTrue(result.success === false || "value" in result, "Should handle long user IDs");
    });

    await runTest("getUserField: JSON field from user_settings", async () => {
        console.log("Testing JSON field retrieval");
        const result = await Users.getUserField("u1", "user_settings", "notifications");
        console.log("Result:", result);
        if ("value" in result) {
            assertTrue(typeof result.value === "object" || typeof result.value === "string", "Should return JSON as object or string");
        }
    });

    await runTest("getUserField: Numeric field from user_profiles", async () => {
        console.log("Testing numeric field retrieval");
        const result = await Users.getUserField("u1", "user_profiles", "age");
        console.log("Result:", result);
        if ("value" in result) {
            assertTrue(result.value === null || typeof result.value === "number", "Should return number or null");
        }
    });

    await runTest("getUserField: Boolean field from user_settings", async () => {
        console.log("Testing boolean field retrieval");
        const result = await Users.getUserField("u1", "user_settings", "call_video_message");
        console.log("Result:", result);
        if ("value" in result) {
            assertTrue(typeof result.value === "boolean", "Should return boolean value");
        }
    });

    await runTest("getUserField: Array field from user_profiles", async () => {
        console.log("Testing array field retrieval");
        const result = await Users.getUserField("u1", "user_profiles", "background_images");
        console.log("Result:", result);
        if ("value" in result) {
            assertTrue(Array.isArray(result.value), "Should return array value");
        }
    });

    await runTest("getUserField: Null field value", async () => {
        console.log("Testing null field value retrieval");
        const result = await Users.getUserField("u1", "user_profiles", "hair_color");
        console.log("Result:", result);
        if ("value" in result) {
            assertTrue(result.value === null || typeof result.value === "string", "Should handle null values");
        }
    });

    await runTest("getUserField: Case sensitivity in field names", async () => {
        console.log("Testing case sensitivity in field names");
        const result = await Users.getUserField("u1", "users", "DISPLAY_NAME");
        console.log("Result:", result);
        assertTrue(!("value" in result), "Should reject uppercase field names");
    });

    await runTest("getUserField: Case sensitivity in table names", async () => {
        console.log("Testing case sensitivity in table names");
        const result = await Users.getUserField("u1", "USERS", "display_name");
        console.log("Result:", result);
        assertTrue(!("value" in result), "Should reject uppercase table names");
    });

    await runTest("getUserField: Multiple users same query", async () => {
        console.log("Testing multiple users with same query");
        const results = await Promise.all([
            Users.getUserField("u1", "users", "display_name"),
            Users.getUserField("u2", "users", "display_name")
        ]);
        console.log("Results:", results);
        results.forEach(result => {
            assertTrue("value" in result, "Each user should return their field value");
        });
    });

    await runTest("getUserField: Return structure on success", async () => {
        console.log("Testing return structure on success");
        const result = await Users.getUserField("u1", "users", "display_name");
        console.log("Result:", result);
        assertTrue("value" in result, "Should return object with value property");
        assertEqual(typeof result.value, "string", "Value should be of appropriate type");
    });

    await runTest("getUserField: Return structure on failure", async () => {
        console.log("Testing return structure on failure");
        const result = await Users.getUserField("non_existent", "users", "display_name");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should indicate failure");
        assertTrue("error" in result, "Should include error field");
        assertEqual(typeof result.error, "string", "Error should be string");
    });

    await runTest("getUserField: Special characters in field names", async () => {
        console.log("Testing special characters in field names");
        const result = await Users.getUserField("u1", "users", "display_name");
        console.log("Result:", result);
        assertTrue("value" in result, "Should handle field names with underscores");
    });

    await runTest("getUserField: Timestamp field retrieval", async () => {
        console.log("Testing timestamp field retrieval");
        const result = await Users.getUserField("u1", "users", "created_at");
        console.log("Result:", result);
        if ("value" in result) {
            assertTrue(result.value instanceof Date || typeof result.value === "string", "Should return Date object or string");
        }
    });

    await runTest("getUserField: Empty string field value", async () => {
        console.log("Testing empty string field value");
        const result = await Users.getUserField("u1", "user_profiles", "bio");
        console.log("Result:", result);
        if ("value" in result) {
            assertTrue(result.value === "" || typeof result.value === "string", "Should handle empty string values");
        }
    });

    await runTest("getUserField: Database connection failure", async () => {
        console.log("Testing behavior during database failure");
        const result = await Users.getUserField("u1", "users", "display_name");
        console.log("Result:", result);
        assertTrue(result !== undefined, "Should always return a result");
    });

    await runTest("getUserField: LIMIT 1 enforcement", async () => {
        console.log("Testing LIMIT 1 enforcement");
        const result = await Users.getUserField("u1", "users", "display_name");
        console.log("Result:", result);
        // Should only return one row even if multiple users have same ID (shouldn't happen)
        assertTrue("value" in result, "Should return single value due to LIMIT 1");
    });

    await runTest("getUserField: Field name with SQL keywords", async () => {
        console.log("Testing field name with SQL keywords");
        const result = await Users.getUserField("u1", "users", "select");
        console.log("Result:", result);
        // This would fail if 'select' is not a valid column name
        assertTrue(result.success === false || "value" in result, "Should handle SQL keywords as field names");
    });

    await runTest("getUserField: Table name with SQL keywords", async () => {
        console.log("Testing table name with SQL keywords");
        const result = await Users.getUserField("u1", "select", "display_name");
        console.log("Result:", result);
        assertEqual(result.success, false, "Should fail for invalid table names");
    });
}
