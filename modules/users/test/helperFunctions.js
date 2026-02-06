import Users from '../src/services/Users.js';
import {runTest, assertEqual} from './TestHelpers.js';

/**
 * Test suite for helper functions.
 */
export async function testHelperFunctions() {
    console.log("\n--- Running Suite: Helper Functions ---");

    await runTest("initialsFromDisplayName: Standard two-word name", async () => {
        const initials = Users.initialsFromDisplayName("Test User");
        assertEqual(initials, "TU", "Should return 'TU'");
    });

    await runTest("initialsFromDisplayName: Single word name", async () => {
        const initials = Users.initialsFromDisplayName("Test");
        assertEqual(initials, "T", "Should return 'T'");
    });

    await runTest("initialsFromDisplayName: Three word name", async () => {
        const initials = Users.initialsFromDisplayName("Test Middle User");
        assertEqual(initials, "TM", "Should return first two initials 'TM'");
    });

    await runTest("initialsFromDisplayName: Name with extra spacing", async () => {
        const initials = Users.initialsFromDisplayName("  Test   User  ");
        assertEqual(initials, "TU", "Should trim whitespace and return 'TU'");
    });

    await runTest("initialsFromDisplayName: Empty or null name", async () => {
        assertEqual(Users.initialsFromDisplayName(""), "", "Empty string should return ''");
        assertEqual(Users.initialsFromDisplayName(null), "", "Null should return ''");
        assertEqual(Users.initialsFromDisplayName(undefined), "", "Undefined should return ''");
    });

    await runTest("isUsernameFormatValid: Valid names", async () => {
        assertEqual(Users.isUsernameFormatValid("valid_user.123"), true, "valid_user.123 is valid");
        assertEqual(Users.isUsernameFormatValid("abc"), true, "abc is valid (min length)");
    });

    await runTest("isUsernameFormatValid: Invalid names", async () => {
        assertEqual(Users.isUsernameFormatValid("a"), false, "Too short");
        assertEqual(Users.isUsernameFormatValid("user!"), false, "Invalid char '!'");
        assertEqual(Users.isUsernameFormatValid("user with space"), false, "Invalid char ' '");
        assertEqual(Users.isUsernameFormatValid("a".repeat(31)), false, "Too long");
    });
}
