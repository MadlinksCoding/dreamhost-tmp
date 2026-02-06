const MediaService = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js');
const {runTest, assertEqual, assertTrue} = require('../../src/utils/TestUtils.js');

async function testHandleUpdateMediaItem() {
    console.log('\n--- Running Suite: handleUpdateMediaItem ---');

    const db = new DB({});
    const log = {info: (...args) => {}, debug: (...args) => {}, error: (...args) => {}};
    const indexer = {upsert: async (id) => {}};
    
    const service = new MediaService({db, log, indexer});

    await runTest('handleUpdateMediaItem: Update multiple fields', async () => {
        // Step 1: Create a media item first
        const addResult = await service.addRow({
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            title: 'Initial Title'
        });

        // Step 2: Prepare payload for update
        const payload = {
            media_id: addResult.media_id,
            expectedVersion: 1,
            actorUserId: 'actor123',
            title: 'Updated Title',
            tags: ['updated-tag1', 'updated-tag2'],
            asset_url: 'https://example.com/updated.mp4',
            placeholder_lock: true
        };

        // Step 3: Run the method
        const result = await service.handleUpdateMediaItem(payload);
        assertEqual(result.media_id, addResult.media_id, 'Should return correct media ID');
        
        const mediaRecord = await service.getById({media_id: addResult.media_id});
        assertEqual(mediaRecord.title, 'Updated Title', 'Title should be updated');
        assertEqual(mediaRecord.asset_url, 'https://example.com/updated.mp4', 'Asset URL should be updated');
        assertEqual(mediaRecord.placeholder_lock, true, 'Placeholder lock should be updated');
        
        const tags = await db.getAll('default', 'SELECT tag FROM media_tags WHERE media_id = $1', [addResult.media_id]);
        assertEqual(tags.length, 2, 'Should have 2 updated tags');
    });
}

module.exports =  testHandleUpdateMediaItem ;
