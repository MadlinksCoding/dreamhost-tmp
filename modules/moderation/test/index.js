import Scylla from '../src/services/scylla.js';
import Moderation from '../src/core/moderation.js';
import { testCounter, passedTestCounter, failedTestCounter } from './utils.js';
import { testGetModerationItemsByStatus } from './getModerationItemsByStatus.js';
import { testApplyModerationAction } from './applyModerationAction.js';
import { testEscalateModerationItem } from './escalateModerationItem.js';
import { testGetModerationItemsByType } from './getModerationItemsByType.js';
import { testGetModerationItemsByPriority } from './getModerationItemsByPriority.js';
import { testGetUserModerationItems } from './getUserModerationItems.js';
import { testGetModerationRecordById } from './getModerationRecordById.js';
import { testAddNote } from './addNotes.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';


const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

// Get the directory of the current file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function ensureTableExists() {
    try {
        // Try to describe the table to check if it exists
        await Scylla.describeTable(Moderation.TABLE);
        console.log(`${COLORS.cyan}✓ Table '${Moderation.TABLE}' already exists${COLORS.reset}`);
    } catch (error) {
        // If table doesn't exist, create it
        if (error.message && error.message.includes('ResourceNotFoundException')) {
            console.log(`${COLORS.yellow}Table '${Moderation.TABLE}' not found. Creating it...${COLORS.reset}`);
            try {
                await Moderation.createModerationSchema();
                console.log(`${COLORS.green}✓ Table '${Moderation.TABLE}' created successfully${COLORS.reset}`);
                // Wait a moment for the table to be ready
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (createError) {
                console.error(`${COLORS.red}✗ Failed to create table: ${createError.message}${COLORS.reset}`);
                throw createError;
            }
        } else {
            throw error;
        }
    }
}

async function runAllTests() {
    console.log("========= STARTING MODERATION_CLASS TEST RUN =========");

    // Resolve path relative to test directory
    const schemaPath = join(__dirname, '../src/core/db_schema.json');
    await Scylla.loadTableConfigs(schemaPath);

    // Ensure the table exists before running tests
    await ensureTableExists();

    await testGetModerationItemsByStatus();
    await testApplyModerationAction();
    await testEscalateModerationItem();
    await testGetModerationItemsByType();
    await testGetModerationItemsByPriority();
    await testGetUserModerationItems();
    await testGetModerationRecordById();
    await testAddNote();

    console.log("\n========= TEST RUN COMPLETE =========");

    console.log(`${COLORS.bright}${COLORS.blue}TOTAL TESTS:${COLORS.reset}  ${testCounter - 1}`);
    console.log(`${COLORS.bright}${COLORS.green}PASSED TESTS:${COLORS.reset} ${passedTestCounter}`);
    console.log(`${COLORS.bright}${COLORS.red}FAILED TESTS:${COLORS.reset}  ${failedTestCounter}`);

    if (failedTestCounter === 0) {
        console.log(`\n${COLORS.bright}${COLORS.green}✓ ALL TESTS PASSED${COLORS.reset}`);
    } else {
        console.log(`\n${COLORS.bright}${COLORS.red}✗ ${failedTestCounter} TEST(S) FAILED${COLORS.reset}`);
    }

}

runAllTests().catch(err => {
    console.error("A CRITICAL ERROR HALTED THE TEST RUNNER:", err);
});
