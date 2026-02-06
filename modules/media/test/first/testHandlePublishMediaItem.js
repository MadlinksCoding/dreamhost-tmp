const MediaService = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js'); // Connects to your DB
const {runTest, assertEqual, assertTrue} = require('../../src/utils/TestUtils.js');

async function handlePublishMediaItemTest() {
    console.log('\n--- Running Suite: handlePublishMediaItem ---');

    // Real or mock DB instance
    const db = new DB({});

    // Simple logger
    const log = {info: (...args) => console.log('LOG:', ...args)};
    const indexer = {upsert: async (id) => console.log('Indexer upsert:', id)};
    const clock = {now: () => new Date()};
    const uuid = {v4: () => 'test-uuid-' + Date.now()};

    // Create MediaService instance
    const service = new MediaService({db, log, indexer});

    await runTest('handlePublishMediaItem: Publish existing media', async () => {
        // Step 1: Create a media item first
        const addResult = await service.addRow({
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            title: 'Test Video',
            asset_url: 'https://example.com/video.mp4',
            poster_url: 'https://example.com/poster.jpg',
            duration_seconds: 60,
            pending_conversion: false
        });

        // Step 2: Prepare payload for publishing using the new ID
        const payload = {
            media_id: addResult.media_id,
            expectedVersion: 1, 
            actorUserId: 'actor123',
        };

        // Step 3: Run the method
        const result = await service.handlePublishMediaItem(payload);
        assertEqual(result.media_id, addResult.media_id, 'Should return correct media ID');
        
        const mediaRecord = await service.getById({media_id: addResult.media_id});
        assertEqual(mediaRecord.status, 'published', 'Status should be published');
    });
}




module.exports = handlePublishMediaItemTest;
