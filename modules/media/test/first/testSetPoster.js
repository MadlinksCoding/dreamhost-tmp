const MediaService = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js');
const {runTest, assertEqual} = require('../../src/utils/TestUtils.js');

async function testSetPoster() {
    console.log('\n--- Running Suite: setPoster ---');

    const db = new DB({});
    const log = {info: (...args) => {}, debug: (...args) => {}, error: (...args) => {}};
    const indexer = {upsert: async (id) => {}};
    
    const service = new MediaService({db, log, indexer});

    await runTest('setPoster: Update poster URL', async () => {
        // Step 1: Create a media item first
        const addResult = await service.addRow({
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            title: 'Test Video',
            poster_url: 'https://example.com/old-poster.jpg'
        });

        // Step 2: Prepare payload to update poster
        const payload = {
            media_id: addResult.media_id,
            expectedVersion: 1,
            poster_url: 'https://example.com/new-poster.jpg',
            actorUserId: 'actor123',
        };

        // Step 3: Run the method
        const result = await service.setPoster(payload);
        assertEqual(result.media_id, addResult.media_id, 'Should return correct media ID');
        assertEqual(result.version, 2, 'Version should be incremented');
        
        const mediaRecord = await service.getById({media_id: addResult.media_id});
        assertEqual(mediaRecord.poster_url, 'https://example.com/new-poster.jpg', 'Poster URL should be updated');
        assertEqual(mediaRecord.version, 2, 'DB version should be 2');
    });

    await db.closeAll();
}

module.exports = testSetPoster;
