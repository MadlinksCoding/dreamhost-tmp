const MediaService = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js');
const {runTest, assertEqual} = require('../../src/utils/TestUtils.js');

async function testSetVisibility() {
    console.log('\n--- Running Suite: setVisibility ---');

    const db = new DB({});
    const log = {info: (...args) => {}, debug: (...args) => {}, error: (...args) => {}};
    const indexer = {upsert: async (id) => {}};
    
    const service = new MediaService({db, log, indexer});

    await runTest('setVisibility: Update visibility to public', async () => {
        // Step 1: Create a media item with private visibility
        const addResult = await service.addRow({
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            title: 'Test Video',
            visibility: 'private'
        });

        // Step 2: Prepare payload to change visibility to public
        const payload = {
            media_id: addResult.media_id,
            expectedVersion: 1,
            visibility: 'public',
            actorUserId: 'actor123',
        };

        // Step 3: Run the method
        const result = await service.setVisibility(payload);
        assertEqual(result.media_id, addResult.media_id, 'Should return correct media ID');
        assertEqual(result.version, 2, 'Version should be incremented');
        
        const mediaRecord = await service.getById({media_id: addResult.media_id});
        assertEqual(mediaRecord.visibility, 'public', 'Visibility should be public');
        assertEqual(mediaRecord.version, 2, 'DB version should be 2');
    });

    await db.closeAll();
}

module.exports = testSetVisibility;
