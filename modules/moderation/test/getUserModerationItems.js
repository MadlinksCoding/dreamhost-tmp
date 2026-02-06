import { runTest, assertTrue } from './utils.js';
import Moderation from '../src/core/moderation.js';

async function createTestModerationReturningId({
    timestamp = undefined,
    userId = "user-a",
    type = "text",
} = {}) {
    const data = {
        userId,
        contentId: 'user_test_content',
        type,
        contentType: "post",
        mediaType: null,
        priority: "normal",
        isSystemGenerated: false,
        isPreApproved: false,
    };
    const moderationId = await Moderation.createModerationEntry(data, timestamp);
    return { moderationId, submittedAt: timestamp ?? Date.now(), userId };
}

export async function testGetUserModerationItems() {
    await runTest("Fetch all items for user by status", async () => {
        await createTestModerationReturningId({ userId: "userX" });
        await createTestModerationReturningId({ userId: "userX" });

        const response = await Moderation.getUserModerationItemsByStatus("userX", "pending");
        assertTrue(response.items.every(i => i.userId === "userX"), "All items belong to userX");
        assertTrue(response.items.length >= 2, "Should find at least 2 items for userX");
    });

    await runTest("User date range works", async () => {
        const now = Date.now();
        const oneHour = 3600000;
        const t1 = now - 2 * oneHour;
        const t2 = now - 1 * oneHour;
        const t3 = now + 1 * oneHour;

        await createTestModerationReturningId({ userId: "userY", timestamp: t1 });
        await createTestModerationReturningId({ userId: "userY", timestamp: t2 });
        await createTestModerationReturningId({ userId: "userY", timestamp: t3 });

        const response = await Moderation.getUserModerationItemsByStatus("userY", "pending", { limit: 20, start: now - 3 * oneHour, end: now });
        assertTrue(response.items.every(i => i.submittedAt <= now), "Items within range");
    });

    await runTest("Pagination works for user", async () => {
        const now = Date.now();
        const user = "userZ";

        await createTestModerationReturningId({ userId: user, timestamp: now - 3000 });
        await createTestModerationReturningId({ userId: user, timestamp: now - 2000 });

        const page1 = await Moderation.getUserModerationItemsByStatus(user, "pending", { limit: 1 });
        assertTrue(page1.items.length === 1, "First page has 1 item");

        const page2 = await Moderation.getUserModerationItemsByStatus(user, "pending", { limit: 1, nextToken: page1.nextToken });
        assertTrue(page2.items.length === 1, "Second page has 1 item");
        assertTrue(page1.items[0].moderationId !== page2.items[0].moderationId, "Pages differ");
    });
}
