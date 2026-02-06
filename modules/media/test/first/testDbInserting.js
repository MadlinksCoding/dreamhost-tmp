const MediaHandler = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js');
const {runTest, assertEqual, assertTrue, assertThrows} = require('../../src/utils/TestUtils.js');

/**
 * Test suite for addRow function.
 */
async function testAddRow() {
    console.log('\n--- Running Suite: addRow ---');

    const db = new DB({});

    await runTest('addRow: Basic successful creation', async () => {
        const handler = new MediaHandler({db});

        const payload = {
            owner_user_id: 'user123',
            media_type: 'audio',
            actorUserId: 'actor123',
        };
        try {
            const result = await handler.addRow(payload);
            assertEqual(typeof result.media_id, 'string', 'Should return a media ID');

            const mediaRecord = await db.getRow('default', 'SELECT * FROM media WHERE media_id = $1', [
                result.media_id,
            ]);
            assertTrue(mediaRecord !== null, 'Media record should exist in database');
            assertEqual(mediaRecord.owner_user_id, 'user123', 'Owner user ID should match');
            assertEqual(mediaRecord.media_type, 'audio', 'Media type should match');
            assertEqual(mediaRecord.status, 'draft', 'Default status should be draft');
        } catch (err) {
            console.error('Full error stack:', err && err.stack ? err.stack : err);
            throw err;
        }
    });

    await runTest('addRow: Missing owner_user_id', async () => {
        const handler = new MediaHandler({db});

        const payload = {
            media_type: 'audio',
            actorUserId: 'actor123',
        };

        await assertThrows(
            () => handler.addRow(payload),
            'owner_user_id and media_type required',
            'Should throw ValidationError for missing owner_user_id',
        );
    });

    await runTest('addRow: Missing media_type', async () => {
        const handler = new MediaHandler({db});

        const payload = {
            owner_user_id: 'user123',
            actorUserId: 'actor123',
        };

        await assertThrows(
            () => handler.addRow(payload),
            'owner_user_id and media_type required',
            'Should throw ValidationError for missing media_type',
        );
    });

    await runTest('addRow: Invalid media_type', async () => {
        const handler = new MediaHandler({db});

        const payload = {
            owner_user_id: 'user123',
            media_type: 'invalid_type',
            actorUserId: 'actor123',
        };

        await assertThrows(
            () => handler.addRow(payload),
            'media_type invalid enum value',
            'Should throw ValidationError for invalid media_type',
        );
    });

    await runTest('addRow: Tag and co-performer creation', async () => {
        const handler = new MediaHandler({db});

        const payload = {
            owner_user_id: 'user123',
            media_type: 'audio',
            actorUserId: 'actor123',
            tags: ['tag1', 'tag2'],
            coperformers: ['perf1', 'perf2'],
        };

        const result = await handler.addRow(payload);

        const tags = await db.getAll(
            'default',
            'SELECT tag FROM media_tags WHERE media_id = $1 ORDER BY tag',
            [result.media_id],
        );
        const coperformers = await db.getAll(
            'default',
            'SELECT performer_id FROM media_coperformers WHERE media_id = $1 ORDER BY performer_id',
            [result.media_id],
        );

        assertEqual(tags.length, 2, 'Should have 2 tags');
        assertEqual(coperformers.length, 2, 'Should have 2 coperformers');
    });

    await runTest('addRow: Invalid HTTPS URL validation', async () => {
        const handler = new MediaHandler({db});

        const payload = {
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            asset_url: 'http://insecure.com/video.mp4',
        };

        await assertThrows(
            () => handler.addRow(payload),
            'asset_url must be https URL',
            'Should throw ValidationError for non-HTTPS URL',
        );
    });

    await runTest('addRow: Audit log creation', async () => {
        const handler = new MediaHandler({db});

        const payload = {
            owner_user_id: 'user123',
            media_type: 'audio',
            actorUserId: 'actor123',
        };

        const result = await handler.addRow(payload);

        const auditRecord = await db.getRow(
            'default',
            "SELECT * FROM media_audit WHERE media_id = $1 AND action = 'add'",
            [result.media_id],
        );

        assertTrue(auditRecord !== null, 'Audit record should exist');
        assertEqual(auditRecord.actor_user_id, 'actor123', 'Actor user ID should match');
    });

    await db.closeAll();
}

module.exports = { testAddRow };
