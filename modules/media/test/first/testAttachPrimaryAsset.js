const MediaHandler = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js');
const {runTest, assertEqual, assertTrue, assertThrows} = require('../../src/utils/TestUtils.js');

/**
 * Test suite for attachPrimaryAsset function.
 */
async function testAttachPrimaryAsset() {
    console.log('\n--- Running Suite: attachPrimaryAsset ---');

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

    await runTest('attachPrimaryAsset: Successful attachment with all asset fields', async () => {
        const media = await createTestMedia();
        const handler = new MediaHandler({db});

        const payload = {
            media_id: media.media_id,
            expectedVersion: 1,
            actorUserId: 'actor123',
            asset_url: 'https://example.com/video.mp4',
            file_extension: 'mp4',
            file_name: 'test_video.mp4',
            file_size_bytes: 1024000,
            duration_seconds: 3600,
            video_width: 1920,
            video_height: 1080,
            pending_conversion: false,
        };

        const result = await handler.attachPrimaryAsset(payload);

        assertEqual(result.media_id, media.media_id, 'Should return correct media ID');
        assertEqual(result.version, 2, 'Should increment version');

        const mediaRecord = await handler.getById({ media_id: media.media_id });

        assertEqual(
            mediaRecord.asset_url,
            'https://example.com/video.mp4',
            'Asset URL should be updated',
        );

        assertEqual(mediaRecord.file_extension, 'mp4', 'File extension should be updated');
        assertEqual(mediaRecord.file_name, 'test_video.mp4', 'File name should be updated');
        assertEqual(mediaRecord.file_size_bytes, '1024000', 'File size should be updated');
        assertEqual(mediaRecord.duration_seconds, 3600, 'Duration should be updated');
        assertEqual(mediaRecord.video_width, 1920, 'Video width should be updated');
        assertEqual(mediaRecord.video_height, 1080, 'Video height should be updated');
        assertEqual(mediaRecord.pending_conversion, false, 'Pending conversion should be updated');
        assertEqual(mediaRecord.version, 2, 'Version should be incremented');
    });

    await runTest('attachPrimaryAsset: Partial update of asset fields', async () => {
        const media = await createTestMedia({
            asset_url: 'https://example.com/old.mp4',
            file_extension: 'mp4',
        });
        const handler = new MediaHandler({db});

        const payload = {
            media_id: media.media_id,
            expectedVersion: 1,
            actorUserId: 'actor123',
            asset_url: 'https://example.com/new.mp4', // Only update this field
            duration_seconds: 1800, // Only update this field
        };

        await handler.attachPrimaryAsset(payload);

        const mediaRecord = await handler.getById({ media_id: media.media_id });

        assertEqual(
            mediaRecord.asset_url,
            'https://example.com/new.mp4',
            'Asset URL should be updated',
        );
        assertEqual(mediaRecord.file_extension, 'mp4', 'File extension should remain unchanged');
        assertEqual(mediaRecord.duration_seconds, 1800, 'Duration should be updated');
    });

    await runTest('attachPrimaryAsset: Non-existent media ID', async () => {
        const handler = new MediaHandler({db});

        const payload = {
            media_id: 'non-existent-id',
            expectedVersion: 1,
            actorUserId: 'actor123',
            asset_url: 'https://example.com/video.mp4',
        };

        await assertThrows(
            () => handler.attachPrimaryAsset(payload),
            'Media not found',
            'Should throw NotFoundError for non-existent media',
        );
    });

    await runTest('attachPrimaryAsset: Missing expectedVersion', async () => {
        const media = await createTestMedia();
        const handler = new MediaHandler({db});

        const payload = {
            media_id: media.media_id,
            // missing expectedVersion
            actorUserId: 'actor123',
            asset_url: 'https://example.com/video.mp4',
        };

        await assertThrows(
            () => handler.attachPrimaryAsset(payload),
            'expectedVersion required',
            'Should throw ConflictError for missing expectedVersion',
        );
    });

    await runTest('attachPrimaryAsset: Version mismatch', async () => {
        const media = await createTestMedia();
        const handler = new MediaHandler({db});

        const payload = {
            media_id: media.media_id,
            expectedVersion: 999, // Wrong version
            actorUserId: 'actor123',
            asset_url: 'https://example.com/video.mp4',
        };

        await assertThrows(
            () => handler.attachPrimaryAsset(payload),
            'Version mismatch',
            'Should throw ConflictError for version mismatch',
        );
    });

    await runTest('attachPrimaryAsset: Invalid HTTPS URL validation', async () => {
        const media = await createTestMedia();
        const handler = new MediaHandler({db});

        const payload = {
            media_id: media.media_id,
            expectedVersion: 1,
            actorUserId: 'actor123',
            asset_url: 'http://insecure.com/video.mp4', // Should be HTTPS
        };

        await assertThrows(
            () => handler.attachPrimaryAsset(payload),
            'asset_url must be https URL',
            'Should throw ValidationError for non-HTTPS URL',
        );
    });

    await runTest('attachPrimaryAsset: Boolean field coercion for pending_conversion', async () => {
        const media = await createTestMedia();
        const handler = new MediaHandler({db});

        const payload = {
            media_id: media.media_id,
            expectedVersion: 1,
            actorUserId: 'actor123',
            pending_conversion: 'true', // String boolean
        };

        await handler.attachPrimaryAsset(payload);

        const mediaRecord = await handler.getById({ media_id: media.media_id })

        assertEqual(
            mediaRecord.pending_conversion,
            true,
            "String 'true' should be coerced to boolean true",
        );
    });

    await runTest('attachPrimaryAsset: Audit log creation', async () => {
        const media = await createTestMedia();
        const handler = new MediaHandler({db});

        const payload = {
            media_id: media.media_id,
            expectedVersion: 1,
            actorUserId: 'actor123',
            asset_url: 'https://example.com/video.mp4',
        };

        await handler.attachPrimaryAsset(payload);

        const result = await handler.getAuditByMediaId({media_id: media.media_id});
        const auditRecords = result.audits;

        assertTrue(auditRecords.length > 0, 'Should have at least one audit record');

        const auditRecord = auditRecords[0];
        assertEqual(auditRecord.actor_user_id, 'actor123', 'Actor user ID should match');
        assertEqual(auditRecord.action, 'attach_primary_asset', 'Action should be correct');
    });

    await db.closeAll();
}

module.exports = { testAttachPrimaryAsset };
