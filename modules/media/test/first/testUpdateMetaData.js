const MediaService = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js');
const {runTest, assertEqual} = require('../../src/utils/TestUtils.js');

async function testUpdateMetadata() {
    console.log('\n--- Running Suite: updateMetadata ---');

    const db = new DB({});
    const log = {info: (...args) => {}, debug: (...args) => {}, error: (...args) => {}};
    const indexer = {upsert: async (id) => {}};
    
    const service = new MediaService({db, log, indexer});

    await runTest('updateMetadata: Update multiple metadata fields', async () => {
        // Step 1: Create a media item with initial metadata
        const addResult = await service.addRow({
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            title: 'Original Title',
            description: 'Original Description',
            visibility: 'public',
            featured: false,
            coming_soon: false
        });

        // Step 2: Prepare payload to update metadata
        const payload = {
            media_id: addResult.media_id,
            expectedVersion: 1,
            title: 'Updated Title',
            description: 'Updated Description',
            visibility: 'private',
            featured: true,
            coming_soon: true,
            actorUserId: 'actor123',
        };

        // Step 3: Run the method
        const result = await service.updateMetadata(payload);
        assertEqual(result.media_id, addResult.media_id, 'Should return correct media ID');
        assertEqual(result.version, 2, 'Version should be incremented');
        
        const mediaRecord = await service.getById({media_id: addResult.media_id});
        assertEqual(mediaRecord.title, 'Updated Title', 'Title should be updated');
        assertEqual(mediaRecord.description, 'Updated Description', 'Description should be updated');
        assertEqual(mediaRecord.visibility, 'private', 'Visibility should be updated');
        assertEqual(mediaRecord.featured, true, 'Featured should be updated');
        assertEqual(mediaRecord.coming_soon, true, 'Coming soon should be updated');
        assertEqual(mediaRecord.version, 2, 'DB version should be 2');
    });

    await db.closeAll();
}

module.exports = testUpdateMetadata;
