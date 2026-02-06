import { runTest, assertTrue, assertEqual, assertThrows } from './utils.js';
import Moderation from '../src/core/moderation.js';

const TEST_USER_ID = "test-user-esc-1";

export async function createTestModerationReturningId({
    timestamp = undefined,
    userId = TEST_USER_ID,
    priority = "normal",
    type = "image",
} = {}) {
    const data = {
        userId,
        contentId: 'escalate_test_content',
        type,
        contentType: "post",
        mediaType: type === 'image' ? 'jpg' : type === 'video' ? 'mp4' : null,
        priority,
        isSystemGenerated: false,
        isPreApproved: false,
    };
    const moderationId = await Moderation.createModerationEntry(data, timestamp);
    return { moderationId, submittedAt: timestamp ?? Date.now(), userId, priority, type };
}

export async function testEscalateModerationItem() {
    await runTest("Escalates main record and returns updated fields", async () => {
        const fixedTs = Date.now();
        const { moderationId, userId } = await createTestModerationReturningId({ timestamp: fixedTs });

        const updated = await Moderation.escalateModerationItem(moderationId, userId, "senior-mod-1");

        assertTrue(updated, "Should return an updated record");
        assertEqual(updated.status, "escalated", "Main record status should be 'escalated'");
        assertEqual(updated.escalatedBy, "senior-mod-1", "escalatedBy should be set");
        assertTrue(!!updated.actionedAt, "actionedAt should be populated");
        assertEqual(updated.moderationId, moderationId, "moderationId should match the one escalated");
        assertEqual(updated.userId, userId, "userId should match");
    });

    await runTest("Moves index from pending → escalated and removes old pending row", async () => {
        const ts = Date.now();
        const { moderationId, userId } = await createTestModerationReturningId({
            timestamp: ts,
            priority: "high",
            type: "text",
        });

        const beforePending = await Moderation.getModerationItemsByStatus(
            "pending",
            { limit: 50, start: ts, end: ts }
        );
        const foundBefore = beforePending.items.some(i => i.moderationId === moderationId && i.userId === userId);
        assertTrue(foundBefore, "Pending index should include item before escalation");

        await Moderation.escalateModerationItem(moderationId, userId, "senior-mod-2");
        const escalated = await Moderation.getModerationItemsByStatus(
            "escalated",
            { limit: 50, start: ts, end: ts }
        );

        const foundEscalated = escalated.items.some(i => i.moderationId === moderationId && i.userId === userId);
        assertTrue(foundEscalated, "Escalated index should include item after escalation");

        const afterPending = await Moderation.getModerationItemsByStatus(
            "pending",
            { limit: 50, start: ts, end: ts }
        );
        const stillInPending = afterPending.items.some(i => i.moderationId === moderationId && i.userId === userId);
        assertTrue(!stillInPending, "Pending index should NOT include item after escalation");
    });

    await runTest("Index keeps original timestamp for sort stability", async () => {
        const ts = Date.now();
        const { moderationId, userId } = await createTestModerationReturningId({ timestamp: ts });

        await Moderation.escalateModerationItem(moderationId, userId, "senior-mod-3");

        const escalated = await Moderation.getModerationItemsByStatus(
            "escalated",
            { limit: 20, start: ts, end: ts }
        );
        const item = escalated.items.find(i => i.moderationId === moderationId && i.userId === userId);
        assertTrue(!!item, "Escalated item should be retrievable in the exact timestamp window");
        assertEqual(item.submittedAt, ts, "Index entry should retain original submittedAt timestamp");
    });

    await runTest("Throws error when moderation item not found", async () => {
        let threwError = false;
        try {
            await Moderation.escalateModerationItem("non-existent-id", TEST_USER_ID, "whoever");
        } catch (error) {
            threwError = true;
            assertTrue(error.message.includes("Moderation item not found"), "Error should mention item not found");
        }
        
        assertTrue(threwError, "Should throw when the moderation item cannot be found");
    });
}
