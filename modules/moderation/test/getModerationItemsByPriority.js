import { runTest, assertTrue } from './utils.js';
import Moderation from '../src/core/moderation.js';

async function createTestModerationReturningId({
    timestamp = undefined,
    userId = "prio-user",
    priority = "normal"
} = {}) {
    const data = {
        userId,
        contentId: 'prio_test_content',
        type: "text",
        contentType: "post",
        mediaType: null,
        priority,
        isSystemGenerated: false,
        isPreApproved: false,
    };
    const moderationId = await Moderation.createModerationEntry(data, timestamp);
    return { moderationId, submittedAt: timestamp ?? Date.now(), userId, priority };
}

export async function testGetModerationItemsByPriority() {
    await runTest("Fetch items by priority", async () => {
        await createTestModerationReturningId({ priority: "high" });
        const result = await Moderation.getModerationItemsByPriority("high");
        assertTrue(result.items.length >= 1, "Should return high-priority items");
    });

    await runTest("End date filter works", async () => {
        const now = Date.now();
        const oneHour = 3600000;
        const past = now - 2 * oneHour;
        const future = now + oneHour;
        await createTestModerationReturningId({ timestamp: past, priority: "normal" });
        await createTestModerationReturningId({ timestamp: future, priority: "normal" });
        const res = await Moderation.getModerationItemsByPriority("normal", { limit: 20, end: now });
        assertTrue(res.items.every(i => i.submittedAt <= now), "All items <= endDate");
    });

    await runTest("Sort ascending by priority", async () => {
        const now = Date.now();
        await createTestModerationReturningId({ timestamp: now - 3000, priority: "urgent" });
        await createTestModerationReturningId({ timestamp: now - 2000, priority: "urgent" });
        const res = await Moderation.getModerationItemsByPriority("urgent", { limit: 10, start: now - 10000, end: now, asc: true });
        const times = res.items.map(i => i.submittedAt);
        assertTrue(times.every((v, i) => i === 0 || times[i - 1] <= v), "Should sort ascending");
    });
}
