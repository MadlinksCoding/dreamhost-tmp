import { runTest, assertTrue, assertEqual, assertNull } from './utils.js';
import Moderation from '../src/core/moderation.js';

async function createTestModerationReturningId({
    timestamp = undefined,
    userId = "lookup-user",
    type = "text",
    priority = "normal"
} = {}) {
    const data = {
        userId,
        contentId: 'record_test_content',
        type,
        contentType: "post",
        mediaType: null,
        priority,
        isSystemGenerated: false,
        isPreApproved: false,
    };
    const moderationId = await Moderation.createModerationEntry(data, timestamp);
    return { moderationId, submittedAt: timestamp ?? Date.now(), userId, type, priority };
}

export async function testGetModerationRecordById() {
    await runTest("Returns valid record for matching id/user", async () => {
        const { moderationId, userId } = await createTestModerationReturningId({ userId: "lookup-a" });
        const record = await Moderation.getModerationRecordById(moderationId, userId);
        assertTrue(!!record, "Should return record");
        assertEqual(record.userId, userId, "UserId matches");
        assertEqual(record.moderationId, moderationId, "ModerationId matches");
        assertEqual(record.status, "pending", "Status is pending");
    });

    await runTest("Returns null for mismatched user", async () => {
        const { moderationId } = await createTestModerationReturningId({ userId: "lookup-b" });
        const record = await Moderation.getModerationRecordById(moderationId, "wrong-user");
        assertNull(record, "Should return null when user mismatched");
    });

    await runTest("Returns null for nonexistent id", async () => {
        const record = await Moderation.getModerationRecordById("fake-id", "userX");
        assertNull(record, "Should return null when moderation id does not exist");
    });
}
