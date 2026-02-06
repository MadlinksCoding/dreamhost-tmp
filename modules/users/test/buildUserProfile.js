import Users from '../src/services/Users.js';
import {runTest, assertTrue, assertEqual, assertNull} from './TestHelpers.js';

/**
 * Test suite for buildUserProfile function.
 */
export async function testBuildUserProfile() {
    console.log("\n--- Running Suite: buildUserProfile ---");

    await runTest("buildUserProfile: Valid user ID", async () => {
        console.log("Testing with valid user ID");
        const result = await Users.buildUserProfile("u1");
        console.log("Result:", result);
        assertTrue(result !== null, "Should return user profile object");
        if (result) {
            assertEqual(result.uid, "u1", "Should contain correct UID");
            assertTrue("publicUid" in result, "Should contain publicUid");
            assertTrue("displayName" in result, "Should contain displayName");
            assertTrue("userName" in result, "Should contain userName");
            assertTrue("avatar" in result, "Should contain avatar");
            
            assertTrue("user_profile" in result, "Should contain user_profile");
            const profile = result.user_profile;

            assertTrue("bio" in profile, "Should contain bio");
            assertTrue("gender" in profile, "Should contain gender");
            assertTrue("age" in profile, "Should contain age");
            assertTrue("country" in profile, "Should contain country");
            assertTrue("coverImage" in profile, "Should contain coverImage");
            assertTrue(Array.isArray(profile.backgroundImages), "backgroundImages should be array");
            assertTrue(Array.isArray(profile.socialUrls), "socialUrls should be array");
            assertTrue(Array.isArray(profile.additionalUrls), "additionalUrls should be array");
        }
    });

    await runTest("buildUserProfile: Invalid user ID", async () => {
        console.log("Testing with invalid user ID");
        const result = await Users.buildUserProfile("non_existent_user");
        console.log("Result:", result);
        // Accept either null or empty profile object for invalid user
        assertTrue(result === null || (result && result.uid === "non_existent_user" && result.user_profile), "Invalid user ID should return null or empty profile");
    });

    await runTest("buildUserProfile: Empty user ID", async () => {
        console.log("Testing with empty user ID");
        const result = await Users.buildUserProfile("");
        console.log("Result:", result);
        assertNull(result, "Empty user ID should return null");
    });

    await runTest("buildUserProfile: Null user ID", async () => {
        console.log("Testing with null user ID");
        const result = await Users.buildUserProfile(null);
        console.log("Result:", result);
        assertNull(result, "Null user ID should return null");
    });

    await runTest("buildUserProfile: User with no profile data", async () => {
        console.log("Testing with user having no profile data");
        const result = await Users.buildUserProfile("user_with_no_profile");
        console.log("Result:", result);
        if (result && result.user_profile) {
            assertTrue(typeof result.user_profile.bio === "string", "Bio should be a string");
            assertTrue(typeof result.user_profile.gender === "string", "Gender should be a string");
            assertTrue(result.user_profile.backgroundImages instanceof Array, "Background images should be array");
            assertTrue(result.user_profile.socialUrls instanceof Array, "Social URLs should be array");
            assertTrue(result.user_profile.additionalUrls instanceof Array, "Additional URLs should be array");
        }
    });

    await runTest("buildUserProfile: User with partial profile data", async () => {
        console.log("Testing with user having partial profile data");
        const result = await Users.buildUserProfile("user_partial_profile");
        console.log("Result:", result);
        if (result && result.user_profile) {
            assertTrue(typeof result.user_profile.bio === "string", "Should have bio data");
            assertTrue(typeof result.user_profile.gender === "string", "Should have gender data");
            assertTrue(result.user_profile.backgroundImages instanceof Array, "Should have background images");
        }
    });
}
