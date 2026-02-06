export let testCounter = 1;
export let passedTestCounter = 0;
export let failedTestCounter = 0;

/**
 * Simple test runner function.
 * @param {string} title - Name of the test.
 * @param {Function} testFunction - The async test logic.
 */
export async function runTest(title, testFunction) {
    console.log(`\n--- TEST ${testCounter++}: ${title} ---`);
    try {
        await testFunction();
        passedTestCounter++;
        console.log(`[TEST PASSED] ${title}`);
    } catch (error) {
        failedTestCounter++;
        console.error(`[TEST FAILED] ${title}`, error.message);
    }
}

/**
 * Simple deep equality assertion.
 */
export function assertDeepEqual(actual, expected, message) {
    const actualStr = JSON.stringify(actual);
    const expectedStr = JSON.stringify(expected);
    if (actualStr !== expectedStr) {
        console.error(`[ASSERT FAILED] ${message}`);
        console.log("  Expected:", expectedStr);
        console.log("  Actual:  ", actualStr);
        throw new Error(`Assertion failed: ${message}`);
    }
    console.log(`[ASSERT PASSED] ${message}`);
}

/**
 * Simple equality assertion.
 */
export function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        console.error(`[ASSERT FAILED] ${message}`);
        console.log("  Expected:", expected);
        console.log("  Actual:  ", actual);
        throw new Error(`Assertion failed: ${message}`);
    }
    console.log(`[ASSERT PASSED] ${message}`);
}

/**
 * Simple null assertion.
 */
export function assertNull(actual, message) {
    if (actual !== null) {
        console.error(`[ASSERT FAILED] ${message}`);
        console.log("  Expected: null");
        console.log("  Actual:  ", actual);
        throw new Error(`Assertion failed: ${message}`);
    }
    console.log(`[ASSERT PASSED] ${message}`);
}

/**
 * Simple truthy assertion.
 */
export function assertTrue(actual, message) {
     if (!actual) {
        console.error(`[ASSERT FAILED] ${message}`);
        console.log("  Expected: (truthy)");
        console.log("  Actual:  ", actual);
        throw new Error(`Assertion failed: ${message}`);
    }
    console.log(`[ASSERT PASSED] ${message}`);
}

/**
 * Helper to test for expected errors.
 * @param {Function} asyncFn - An async function to execute.
 * @param {string} expectedErrorMsg - The exact error message expected.
 * @param {string} message - The assertion message.
 */
export async function assertThrows(asyncFn, expectedErrorMsg, message) {
    let error;
    try {
        await asyncFn();
    } catch (e) {
        error = e;
    }

    if (!error) {
        console.error(`[ASSERT FAILED] ${message} - Expected an error but none was thrown.`);
        throw new Error(`Assertion failed: ${message}`);
    }
    if (error.message !== expectedErrorMsg) {
        console.error(`[ASSERT FAILED] ${message} - Incorrect error message.`);
        console.log("  Expected:", expectedErrorMsg);
        console.log("  Actual:  ", error.message);
        throw new Error(`Assertion failed: ${message}`);
    }
    console.log(`[ASSERT PASSED] ${message} (Caught expected error: ${error.message})`);
}

