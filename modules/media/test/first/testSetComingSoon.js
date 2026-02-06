const MediaService = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js');
const {runTest, assertEqual} = require('../../src/utils/TestUtils.js');

async function testSetComingSoon() {
    console.log('\n--- Running Suite: setComingSoon ---');

    const db = new DB({});
    const log = {info: (...args) => {}, debug: (...args) => {}, error: (...args) => {}};
    const indexer = {upsert: async (id) => {}};
    
    const service = new MediaService({db, log, indexer});

    await runTest('setComingSoon: Set coming soon flag to true', async () => {
        // Step 1: Create a media item first
        const addResult = await service.addRow({
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            title: 'Test Video',
            coming_soon: false
        });

        // Step 2: Prepare payload to set coming_soon to true
        const payload = {
            media_id: addResult.media_id,
            expectedVersion: 1,
            coming_soon: true,
            actorUserId: 'actor123',
        };

        // Step 3: Run the method
        const result = await service.setComingSoon(payload);
        assertEqual(result.media_id, addResult.media_id, 'Should return correct media ID');
        assertEqual(result.version, 2, 'Version should be incremented');
        
        const mediaRecord = await service.getById({media_id: addResult.media_id});
        assertEqual(mediaRecord.coming_soon, true, 'Coming soon should be true');
        assertEqual(mediaRecord.version, 2, 'DB version should be 2');
    });

    await db.closeAll();
}

module.exports = testSetComingSoon;
