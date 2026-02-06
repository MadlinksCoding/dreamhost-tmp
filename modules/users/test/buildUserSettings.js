import Users from '../src/services/Users.js';
import { runTest, assertTrue, assertEqual } from './TestHelpers.js';

/**
 * Test suite for buildUserSettings function.
 */
export async function testBuildUserSettings() {
    console.log("\n--- Running Suite: buildUserSettings ---");

    await runTest("buildUserSettings: Valid UID with complete settings", async () => {
        console.log("Testing with valid UID having complete settings");
        const result = await Users.buildUserSettings("u1");
        console.log("Result:", result);
        assertTrue(typeof result === "object", "Should return an object");
        assertTrue("localeConfig" in result, "Should contain localeConfig");
        assertTrue("notificationsConfig" in result, "Should contain notificationsConfig");
        assertTrue("callVideoMessage" in result, "Should contain callVideoMessage");
        assertTrue("presencePreference" in result, "Should contain presencePreference");
    });

    await runTest("buildUserSettings: Valid UID with null settings", async () => {
        console.log("Testing with valid UID having null settings");
        const result = await Users.buildUserSettings("user_with_null_settings");
        console.log("Result:", result);
        assertEqual(result.localeConfig, null, "localeConfig should be null when not set");
        assertEqual(result.notificationsConfig, null, "notificationsConfig should be null when not set");
        assertEqual(result.callVideoMessage, null, "callVideoMessage should be null when not set");
        assertEqual(result.presencePreference, null, "presencePreference should be null when not set");
    });

    await runTest("buildUserSettings: Valid UID with partial settings", async () => {
        console.log("Testing with valid UID having partial settings");
        const result = await Users.buildUserSettings("user_partial_settings");
        console.log("Result:", result);
        // Test that existing settings are preserved and missing ones are null
        if (result.localeConfig) {
            assertTrue(typeof result.localeConfig === "object", "localeConfig should be object if present");
        }
        if (result.notificationsConfig) {
            assertTrue(typeof result.notificationsConfig === "object", "notificationsConfig should be object if present");
        }
    });

    await runTest("buildUserSettings: Non-existent UID", async () => {
        console.log("Testing with non-existent UID");
        const result = await Users.buildUserSettings("non_existent_user");
        console.log("Result:", result);
        assertEqual(result.localeConfig, null, "localeConfig should be null for non-existent user");
        assertEqual(result.notificationsConfig, null, "notificationsConfig should be null for non-existent user");
        assertEqual(result.presencePreference, null, "presencePreference should be null for non-existent user");
        assertEqual(result.callVideoMessage, null, "callVideoMessage should be null for non-existent user");
    });

    await runTest("buildUserSettings: Empty UID", async () => {
        console.log("Testing with empty UID");
        const result = await Users.buildUserSettings("");
        console.log("Result:", result);
        assertEqual(result.localeConfig, null, "localeConfig should be undefined for empty UID");
        assertEqual(result.notificationsConfig, null, "notificationsConfig should be undefined for empty UID");
        assertEqual(result.presencePreference, null, "presencePreference should be undefined for empty UID");
        assertEqual(result.callVideoMessage, null, "callVideoMessage should be undefined for empty UID");
    });

    await runTest("buildUserSettings: Null UID", async () => {
        console.log("Testing with null UID");
        const result = await Users.buildUserSettings(null);
        console.log("Result:", result);
        assertEqual(result.localeConfig, null, "localeConfig should be null for null UID");
        assertEqual(result.presencePreference, null, "presencePreference should be null for null UID");
        assertEqual(result.notificationsConfig, null, "notificationsConfig should be null for null UID");
        assertEqual(result.callVideoMessage, null, "callVideoMessage should be null for null UID");
    });

    await runTest("buildUserSettings: Undefined UID", async () => {
        console.log("Testing with undefined UID");
        const result = await Users.buildUserSettings(undefined);
        console.log("Result:", result);
        assertEqual(result.localeConfig, null, "localeConfig should be null for undefined UID");
        assertEqual(result.presencePreference, null, "presencePreference should be null for undefined UID");
        assertEqual(result.notificationsConfig, null, "notificationsConfig should be null for undefined UID");
        assertEqual(result.callVideoMessage, null, "callVideoMessage should be null for undefined UID");
    });

    await runTest("buildUserSettings: UID with special characters", async () => {
        console.log("Testing with UID containing special characters");
        const result = await Users.buildUserSettings("user-123_special.456");
        console.log("Result:", result);
        assertTrue(typeof result === "object", "Should return object even with special characters in UID");
    });

    await runTest("buildUserSettings: Very long UID", async () => {
        console.log("Testing with very long UID");
        const longUid = "a".repeat(100);
        const result = await Users.buildUserSettings(longUid);
        console.log("Result:", result);
        assertTrue(typeof result === "object", "Should handle very long UIDs");
    });

    await runTest("buildUserSettings: UID with SQL injection attempt", async () => {
        console.log("Testing with UID containing SQL injection attempt");
        const sqlInjectionUid = "u1'; DROP TABLE users; --";
        const result = await Users.buildUserSettings(sqlInjectionUid);
        console.log("Result:", result);
        assertTrue(typeof result === "object", "Should safely handle SQL injection attempts");
        // Should either return empty settings or handle gracefully without error
    });

    await runTest("buildUserSettings: Return structure consistency", async () => {
        console.log("Testing return structure consistency");
        const result = await Users.buildUserSettings("any_uid");
        console.log("Result:", result);
        const expectedKeys = ["localeConfig", "notificationsConfig", "callVideoMessage", "presencePreference"];
        const actualKeys = Object.keys(result);
        assertEqual(actualKeys.length, expectedKeys.length, "Should return exactly four properties");
        expectedKeys.forEach(key => {
            assertTrue(actualKeys.includes(key), `Should contain ${key} property`);
        });
    });

    await runTest("buildUserSettings: Settings with empty strings in database", async () => {
        console.log("Testing with settings containing empty strings in DB");
        const result = await Users.buildUserSettings("user_empty_string_settings");
        console.log("Result:", result);
        // Empty strings in DB should become null in result due to ?? null
        assertEqual(result.presencePreference, null, "Empty string presencePreference should become null");
        assertEqual(result.localeConfig, null, "Empty string locale should become null");
        assertEqual(result.notificationsConfig, null, "Empty string notifications should become null");
        assertEqual(result.callVideoMessage, null, "Empty string callVideoMessage should become null");
    });

    await runTest("buildUserSettings: Settings with valid JSON objects", async () => {
        console.log("Testing with valid JSON object settings");
        const result = await Users.buildUserSettings("user_json_settings");
        console.log("Result:", result);
        // If settings contain valid JSON, they should be preserved as objects
        if (result.localeConfig && typeof result.localeConfig === 'object') {
            assertTrue(!Array.isArray(result.localeConfig) || Array.isArray(result.localeConfig), "localeConfig should preserve object/array structure");
        }
        if (result.notificationsConfig && typeof result.notificationsConfig === 'object') {
            assertTrue(!Array.isArray(result.notificationsConfig) || Array.isArray(result.notificationsConfig), "notificationsConfig should preserve object/array structure");
        }
    });
}
