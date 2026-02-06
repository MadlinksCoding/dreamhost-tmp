const MediaService = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js');
const {runTest, assertEqual} = require('../../src/utils/TestUtils.js');

async function testSetFeatured() {
    console.log('\n--- Running Suite: setFeatured ---');

    const db = new DB({});
    const log = {info: (...args) => {}, debug: (...args) => {}, error: (...args) => {}};
    const indexer = {upsert: async (id) => {}};
    
    const service = new MediaService({db, log, indexer});

    await runTest('setFeatured: Set featured flag to true', async () => {
        // Step 1: Create a media item first
        const addResult = await service.addRow({
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            title: 'Test Video',
            featured: false
        });

        // Step 2: Prepare payload to set featured to true
        const payload = {
            media_id: addResult.media_id,
            expectedVersion: 1,
            featured: true,
            actorUserId: 'actor123',
        };

        // Step 3: Run the method
        const result = await service.setFeatured(payload);
        assertEqual(result.media_id, addResult.media_id, 'Should return correct media ID');
        assertEqual(result.version, 2, 'Version should be incremented');
        
        const mediaRecord = await service.getById({media_id: addResult.media_id});
        assertEqual(mediaRecord.featured, true, 'Featured should be true');
        assertEqual(mediaRecord.version, 2, 'DB version should be 2');
    });

    await db.closeAll();
}

module.exports = testSetFeatured;
