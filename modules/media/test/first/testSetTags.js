const MediaService = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js');
const {runTest, assertEqual} = require('../../src/utils/TestUtils.js');

async function testSetTags() {
    console.log('\n--- Running Suite: setTags ---');

    const db = new DB({});
    const log = {info: (...args) => {}, debug: (...args) => {}, error: (...args) => {}};
    const indexer = {upsert: async (id) => {}};
    
    const service = new MediaService({db, log, indexer});

    await runTest('setTags: Replace tags atomically', async () => {
        // Step 1: Create a media item with initial tags
        const addResult = await service.addRow({
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            title: 'Test Video',
            tags: ['old-tag1', 'old-tag2']
        });

        // Step 2: Prepare payload to replace tags
        const payload = {
            media_id: addResult.media_id,
            expectedVersion: 1,
            tags: ['action', 'drama', 'thriller'],
            actorUserId: 'actor123',
        };

        // Step 3: Run the method
        const result = await service.setTags(payload);
        assertEqual(result.media_id, addResult.media_id, 'Should return correct media ID');
        assertEqual(result.version, 2, 'Version should be incremented');
        
        const mediaRecord = await service.getById({media_id: addResult.media_id});
        assertEqual(mediaRecord.version, 2, 'DB version should be 2');
        
        // Verify tags were replaced
        const tags = await db.getAll('default', 'SELECT tag FROM media_tags WHERE media_id = $1 ORDER BY tag', [addResult.media_id]);
        assertEqual(tags.length, 3, 'Should have 3 new tags');
        assertEqual(tags[0].tag, 'action', 'First tag should be action');
        assertEqual(tags[1].tag, 'drama', 'Second tag should be drama');
        assertEqual(tags[2].tag, 'thriller', 'Third tag should be thriller');
    });

    await db.closeAll();
}

module.exports = testSetTags;
