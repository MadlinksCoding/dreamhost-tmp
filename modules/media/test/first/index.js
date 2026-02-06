const {counters} = require('../../src/utils/TestUtils.js');
const {testApplyBlurControls} = require('./testApplyBlurControls.js');
const {testAttachPrimaryAsset} = require('./testAttachPrimaryAsset.js');
const {testAddRow} = require('./testDbInserting.js');
const {testHandleAddMediaItem} = require('./testHandleAddMediaItem.js');
const handlePublishMediaItemTest = require('./testHandlePublishMediaItem.js');
const testHandleScheduleMediaItem = require('./testHandleScheduleMediaItem.js');
const testHandleUpdateMediaItem = require('./testHandleUpdateMediaItem.js');
const testSetComingSoon = require('./testSetComingSoon.js');
const testSetFeatured = require('./testSetFeatured.js');
const testSetPoster = require('./testSetPoster.js');
const testSetTags= require('./testSetTags.js');
const testSetVisibility = require('./testSetVisibility.js');
const testUpdateMetadata= require('./testUpdateMetaData.js');
const testAddNote= require('./testAddNote.js');

const COLORS = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

async function runAllTests() {
    console.log('========= STARTING MEDIA_CLASS TEST RUN =========');

    // await testAddRow();
    // await testApplyBlurControls();
    // await testAttachPrimaryAsset();
    // await testHandleAddMediaItem();
    // await testAddNote();
    // await handlePublishMediaItemTest();
    await testHandleScheduleMediaItem();
    // await testHandleUpdateMediaItem();
    // await testSetComingSoon();
    // await testSetFeatured();
    // await testSetPoster();
    // await testSetTags();
    // await testSetVisibility();
    // await testUpdateMetadata();

    console.log('\n========= TEST RUN COMPLETE =========');

    console.log(`${COLORS.bright}${COLORS.blue}TOTAL TESTS:${COLORS.reset}  ${counters.testCounter - 1}`);
    console.log(`${COLORS.bright}${COLORS.green}PASSED TESTS:${COLORS.reset} ${counters.passedTestCounter}`);
    console.log(`${COLORS.bright}${COLORS.red}FAILED TESTS:${COLORS.reset}  ${counters.failedTestCounter}`);

    if (counters.failedTestCounter === 0 ) {
        console.log(`\n${COLORS.bright}${COLORS.green}✓ ALL TESTS PASSED${COLORS.reset}`);
    } else {
        console.log(
            `\n${COLORS.bright}${COLORS.red}✗ ${counters.failedTestCounter} TEST(S) FAILED${COLORS.reset}`,
        );
    }
}

runAllTests()
    .catch((err) => {
        console.error('A CRITICAL ERROR HALTED THE TEST RUNNER:', err);
    })
    .finally();
