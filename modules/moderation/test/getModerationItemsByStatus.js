import { runTest, assertTrue } from './utils.js';
import Moderation from '../src/core/moderation.js';

const TEST_USER_ID = "test-user-1";

async function createTestModeration({ timestamp = undefined, userId = TEST_USER_ID }) {
    const types = ['image', 'video', 'text', 'link'];
    const type = types[Math.floor((Math.random() * types.length))]

    const data = {
        userId,
        contentId: 'range_test_content',
        type,
        contentType: "post",
        mediaType: type === 'image' ? 'jpg' : type === 'video' ? 'mp4' : null,
        priority: Math.random() > 0.7 ? "high" : "normal",
        isSystemGenerated: Math.random() > 0.5,
        isPreApproved: false,
    };

    await Moderation.createModerationEntry(data, timestamp);
}


export async function testGetModerationItemsByStatus() {
    await runTest("Get pending items without filters", async () => {
        // Create a test item first to ensure there's data to query
        await createTestModeration({ userId: 'test-pending-query-user' });
        
        const result = await Moderation.getModerationItemsByStatus("pending");

        assertTrue(Array.isArray(result.items), "Result should have items array");
        assertTrue(result.items.length >= 1, "Should find at least one pending item");
        assertTrue(typeof result.nextToken === 'string' || result.nextToken === null, "nextToken should be string or null");
        assertTrue(typeof result.hasMore === 'boolean', "hasMore should be boolean");

        // Verify item structure
        const item = result.items[0];
        assertTrue(item.moderationId, "Item should have moderationId");
        assertTrue(item.userId, "Item should have userId");
        assertTrue(item.submittedAt, "Item should have submittedAt");
    });

    await runTest("Date range filtering - items within range", async () => {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;

        // create test items with specific timestamps
        const timestamp1 = now - (2 * oneHour); // 2 hours ago
        const timestamp2 = now - oneHour;       // 1 hour ago
        const timestamp3 = now + oneHour;       // 1 hour in future

        await createTestModeration({ userId: 'range_test_user_id_1', timestamp: timestamp1 });
        await createTestModeration({ userId: 'range_test_user_id_2', timestamp: timestamp2 });
        await createTestModeration({ userId: 'range_test_user_id_3', timestamp: timestamp3 });

        // Test: Get items from 3 hours ago to now (should find id1 and id2)
        const startDate = now - (3 * oneHour);
        const endDate = now;

        const result = await Moderation.getModerationItemsByStatus(
            "pending",
            { limit: 20, start: startDate, end: endDate }
        );

        assertTrue(result.items.length >= 2, "Should find items within date range");

        // Items should be in descending order by default (newest first)
        const timestamps = result.items.map(item => item.submittedAt);
        assertTrue(timestamps[0] >= timestamps[1], "Items should be in descending order by default");
    });
}

