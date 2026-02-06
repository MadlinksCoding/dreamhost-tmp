import { runTest, assertTrue } from './utils.js';
import Moderation from '../src/core/moderation.js';

async function createTestModerationReturningId({
    timestamp = undefined,
    userId = "type-user",
    type = "image",
    priority = "normal"
} = {}) {
    const data = {
        userId,
        contentId: 'type_test_content',
        type,
        contentType: "post",
        mediaType: type === 'image' ? 'jpg' : type === 'video' ? 'mp4' : null,
        priority,
        isSystemGenerated: false,
        isPreApproved: false,
    };
    const moderationId = await Moderation.createModerationEntry(data, timestamp);
    return { moderationId, submittedAt: timestamp ?? Date.now(), userId, type, priority };
}

export async function testGetModerationItemsByType() {
    await runTest("Fetch items by type", async () => {
        await createTestModerationReturningId({ type: "text" });
        await createTestModerationReturningId({ type: "text" });
        const result = await Moderation.getModerationItemsByType("text");
        assertTrue(result.items.length >= 2, "Should return text-type items");
    });

    await runTest("Date range filter works for type", async () => {
        const now = Date.now();
        const oneHour = 3600000;
        const t1 = now - oneHour;
        const t2 = now + oneHour;
        await createTestModerationReturningId({ timestamp: t1, type: "video" });
        await createTestModerationReturningId({ timestamp: t2, type: "video" });

        const res = await Moderation.getModerationItemsByType("video", { limit: 20, start: now - 2 * oneHour, end: now });
        assertTrue(res.items.every(i => i.submittedAt <= now), "Items should be <= endDate");
    });

    await runTest("Sort ascending by type", async () => {
        const now = Date.now();
        await createTestModerationReturningId({ timestamp: now - 3000, type: "link" });
        await createTestModerationReturningId({ timestamp: now - 2000, type: "link" });
        const res = await Moderation.getModerationItemsByType("link", { limit: 10, start: now - 10000, end: now, asc: true });
        const times = res.items.map(i => i.submittedAt);
        assertTrue(times.every((v, i) => i === 0 || times[i - 1] <= v), "Should sort ascending");
    });
}
