const MediaHandler = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js');
const {runTest, assertEqual, assertTrue, assertThrows} = require('../../src/utils/TestUtils.js');

/**
 * Test suite for applyBlurControls function.
 */
async function testApplyBlurControls() {
    console.log('\n--- Running Suite: applyBlurControls ---');

    const db = new DB({});

    async function createTestMedia(mediaData = {}) {
        const handler = new MediaHandler({db});
        const payload = {
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            ...mediaData,
        };
        return await handler.addRow(payload);
    }

    await runTest('applyBlurControls: Successful update of all blur fields', async () => {
        const media = await createTestMedia();
        const handler = new MediaHandler({db});

        const payload = {
            media_id: media.media_id,
            expectedVersion: 1,
            actorUserId: 'actor123',
            placeholder_lock: true,
            blurred_lock: false,
            blurred_value_px: 15,
            trailer_blurred_lock: true,
            trailer_blurred_value_px: 20,
        };

        const result = await handler.applyBlurControls(payload);

        assertEqual(result.media_id, media.media_id, 'Should return correct media ID');
        assertEqual(result.version, 2, 'Should increment version');

        const mediaRecord = await handler.getById({media_id: media.media_id});

        assertEqual(mediaRecord.placeholder_lock, true, 'Placeholder lock should be updated');
        assertEqual(mediaRecord.blurred_lock, false, 'Blurred lock should be updated');
        assertEqual(mediaRecord.blurred_value_px, 15, 'Blurred value should be updated');
        assertEqual(
            mediaRecord.trailer_blurred_lock,
            true,
            'Trailer blurred lock should be updated',
        );
        assertEqual(
            mediaRecord.trailer_blurred_value_px,
            20,
            'Trailer blurred value should be updated',
        );
        assertEqual(mediaRecord.version, 2, 'Version should be incremented');
    });

    await runTest('applyBlurControls: Partial update of blur fields', async () => {
        const media = await createTestMedia({
            placeholder_lock: true,
            blurred_value_px: 10,
        });

        const handler = new MediaHandler({db});

        const payload = {
            media_id: media.media_id,
            expectedVersion: 1,
            actorUserId: 'actor123',
            blurred_lock: true, // Only update this field
            blurred_value_px: 25, // Only update this field
        };

        await handler.applyBlurControls(payload);

        const mediaRecord = await handler.getById({media_id: media.media_id});

        assertEqual(mediaRecord.placeholder_lock, true, 'Placeholder lock should remain unchanged');
        assertEqual(mediaRecord.blurred_lock, true, 'Blurred lock should be updated');
        assertEqual(mediaRecord.blurred_value_px, 25, 'Blurred value should be updated');
    });

    await runTest('applyBlurControls: Non-existent media ID', async () => {
        const handler = new MediaHandler({db});

        const payload = {
            media_id: 'non-existent-id',
            expectedVersion: 1,
            actorUserId: 'actor123',
            blurred_lock: true,
        };

        await assertThrows(
            () => handler.applyBlurControls(payload),
            'Media not found',
            'Should throw NotFoundError for non-existent media',
        );
    });

    await runTest('applyBlurControls: Missing expectedVersion', async () => {
        const media = await createTestMedia();
        const handler = new MediaHandler({db});

        const payload = {
            media_id: media.media_id,
            // missing expectedVersion
            actorUserId: 'actor123',
            blurred_lock: true,
        };

        await assertThrows(
            () => handler.applyBlurControls(payload),
            'expectedVersion required',
            'Should throw ConflictError for missing expectedVersion',
        );
    });

    await runTest('applyBlurControls: Version mismatch', async () => {
        const media = await createTestMedia();
        const handler = new MediaHandler({db});

        const payload = {
            media_id: media.media_id,
            expectedVersion: 999, // Wrong version
            actorUserId: 'actor123',
            blurred_lock: true,
        };

        await assertThrows(
            () => handler.applyBlurControls(payload),
            'Version mismatch',
            'Should throw ConflictError for version mismatch',
        );
    });

    await runTest('applyBlurControls: Audit log creation', async () => {
        const media = await createTestMedia();
        const handler = new MediaHandler({db});

        const payload = {
            media_id: media.media_id,
            expectedVersion: 1,
            actorUserId: 'actor123',
            blurred_lock: true,
        };

        await handler.applyBlurControls(payload);

        const results = await handler.getAuditByMediaId({ media_id: media.media_id });
        const audits = results.audits;

        assertTrue(audits.length > 0, 'Should have at least one audit record');

        const audit = audits[0];
        assertEqual(audit.actor_user_id, 'actor123', 'Actor user ID should match');
        assertEqual(audit.action, 'apply_blur_controls', 'Action should be correct');
    });

    await db.closeAll();
}

module.exports = { testApplyBlurControls };
