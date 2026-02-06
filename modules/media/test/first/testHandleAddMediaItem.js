const MediaHandler = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js');
const {runTest, assertEqual, assertTrue, assertThrows} = require('../../src/utils/TestUtils.js');

/**
 * Test suite for handleAddMediaItem function.
 */
async function testHandleAddMediaItem() {
    console.log('\n--- Running Suite: handleAddMediaItem ---');

    const db = new DB({});

    await runTest('handleAddMediaItem: Basic creation with required fields only', async () => {
        const handler = new MediaHandler({db});

        const payload = {
            owner_user_id: 'user123',
            media_type: 'audio',
            actorUserId: 'actor123',
        };

        const result = await handler.handleAddMediaItem({payload, actorUserId: 'actor123'});
        assertEqual(typeof result.media_id, 'string', 'Should return a media ID');

        const mediaRecord = await handler.getById({media_id: result.media_id});

        assertTrue(mediaRecord !== null, 'Media record should exist');
        assertEqual(mediaRecord.owner_user_id, 'user123', 'Owner user ID should match');
        assertEqual(mediaRecord.media_type, 'audio', 'Media type should match');
        assertEqual(mediaRecord.status, 'draft', 'Default status should be draft');
    });

    await runTest('handleAddMediaItem: Creation with tags and co-performers', async () => {
        const handler = new MediaHandler({db});

        const payload = {
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            tags: ['tag1', 'tag2'],
            coperformers: ['perf1', 'perf2'],
        };

        const result = await handler.handleAddMediaItem({payload, actorUserId: 'actor123'});
        const tags = await db.getAll('default', 'SELECT tag FROM media_tags WHERE media_id = $1', [
            result.media_id,
        ]);

        const coperformers = await db.getAll(
            'default',
            'SELECT performer_id FROM media_coperformers WHERE media_id = $1',
            [result.media_id],
        );

        assertEqual(tags.length, 2, 'Should create 2 tags');
        assertEqual(coperformers.length, 2, 'Should create 2 co-performers');
    });

    await runTest('handleAddMediaItem: Creation with asset and poster attachment', async () => {
        const handler = new MediaHandler({db});

        const payload = {
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            asset_url: 'https://example.com/video.mp4',
            poster_url: 'https://example.com/poster.jpg',
            file_extension: 'mp4',
            duration_seconds: 3600,
        };

        const result = await handler.handleAddMediaItem({payload, actorUserId: 'actor123'});
        const mediaRecord = await handler.getById({media_id: result.media_id});

        assertEqual(
            mediaRecord.asset_url,
            'https://example.com/video.mp4',
            'Asset URL should be set',
        );

        assertEqual(
            mediaRecord.poster_url,
            'https://example.com/poster.jpg',
            'Poster URL should be set',
        );

        assertEqual(mediaRecord.file_extension, 'mp4', 'File extension should be set');

        assertEqual(mediaRecord.duration_seconds, 3600, 'Duration should be set');
    });

    await runTest('handleAddMediaItem: All supported media types', async () => {
        const handler = new MediaHandler({db});

        const mediaTypes = ['audio', 'video', 'image', 'gallery', 'file'];

        for (const mediaType of mediaTypes) {
            const payload = {
                owner_user_id: `user-${mediaType}`,
                media_type: mediaType,
                actorUserId: 'actor123',
            };

            const result = await handler.handleAddMediaItem({payload, actorUserId: 'actor123'});
            const mediaRecord = await handler.getById({media_id: result.media_id});

            assertEqual(
                mediaRecord.media_type,
                mediaType,
                `Should successfully create ${mediaType} media type`,
            );
        }
    });

    await db.closeAll();
}

module.exports = { testHandleAddMediaItem };
