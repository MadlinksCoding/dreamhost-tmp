import Scylla from '../src/services/scylla.js';
import Moderation from '../src/core/moderation.js';
import { runTest, assertTrue, assertEqual, assertThrows } from './utils.js';

const TEST_USER_ID = 'test_user_id_1';
const TEST_MODERATOR_ID = 'test_moderator_id';
const TEST_CONTENT_ID = 'test_user_content';

async function createTestModerationEntry(overrides = {}) {
    const data = {
        userId: TEST_USER_ID,
        contentId: TEST_CONTENT_ID,
        type: "image", // Changed from "media" to valid type
        priority: "normal",
        ...overrides
    };

    return await Moderation.createModerationEntry(data);
}

/**
 * Helper to clean up test data
 */
async function cleanupTestData(moderationId, userId) {
    try {
        if (moderationId && userId) {
            const record = await Moderation.getModerationRecordById(moderationId, userId);
            if (record) {
                await Scylla.deleteItem(Moderation.TABLE, {
                    [Moderation.PK]: record[Moderation.PK],
                    [Moderation.SK]: record[Moderation.SK],
                });
            }
        }
    } catch (error) {
        console.log("Cleanup warning:", error.message);
    }
}
export async function testApplyModerationAction() {
    await runTest("Basic Approval Action", async () => {
        const moderationId = await createTestModerationEntry();

        try {
            const result = await Moderation.applyModerationAction(
                moderationId,
                TEST_USER_ID,
                "approve",
                "Content meets guidelines",
                TEST_MODERATOR_ID
            );

            assertTrue(result, "Should return updated record");

            const updatedRecord = await Moderation.getModerationRecordById(moderationId, TEST_USER_ID);

            assertEqual(updatedRecord.status, "approved", "Status should be 'approved'");
            assertEqual(updatedRecord.action, "approve", "Action should be 'approve'");
            assertEqual(updatedRecord.reason, "Content meets guidelines", "Reason should match");
            assertEqual(updatedRecord.moderatedBy, TEST_MODERATOR_ID, "Moderator ID should match");
            assertTrue(updatedRecord.actionedAt, "actionedAt should be set");
            assertTrue(updatedRecord.actionedAt > updatedRecord.submittedAt, "actionedAt should be after submittedAt");

        } finally {
            await cleanupTestData(moderationId, TEST_USER_ID);
        }
    });
    await runTest("Basic rejection action", async () => {
        const moderationId = await createTestModerationEntry();

        try {
            const result = await Moderation.applyModerationAction(
                moderationId,
                TEST_USER_ID,
                "reject",
                "Content violates guidelines",
                TEST_MODERATOR_ID
            );

            assertTrue(Boolean(result), "Should return updated record");

            const updatedRecord = await Moderation.getModerationRecordById(moderationId, TEST_USER_ID);

            assertEqual(updatedRecord.status, "rejected", "Status should be 'rejected'");
            assertEqual(updatedRecord.action, "reject", "Action should be 'reject'");
            assertEqual(updatedRecord.reason, "Content violates guidelines", "Reason should match");

        } finally {
            await cleanupTestData(moderationId, TEST_USER_ID);
        }
    });

    await runTest("Global approval action", async () => {
        const moderationId = await createTestModerationEntry();

        try {
            const result = await Moderation.applyModerationAction(
                moderationId,
                TEST_USER_ID,
                "approve",
                "Content approved globally",
                TEST_MODERATOR_ID,
                "global"
            );

            assertTrue(Boolean(result), "Should return updaed record");

            const updatedRecord = await Moderation.getModerationRecordById(moderationId, TEST_USER_ID);
            assertEqual(updatedRecord.status, "approved_global", "Status should be 'approved_global' for global moderation");

        } finally {
            await cleanupTestData(moderationId, TEST_USER_ID);
        }
    });

    await runTest("Tags type moderation with approval", async () => {
        const moderationId = await createTestModerationEntry({ type: "tags" });

        try {
            const result = await Moderation.applyModerationAction(
                moderationId,
                TEST_USER_ID,
                "approve",
                "Tags approved",
                TEST_MODERATOR_ID
            );

            assertTrue(Boolean(result), "Should return updaed record");

            const updatedRecord = await Moderation.getModerationRecordById(moderationId, TEST_USER_ID);
            assertEqual(updatedRecord.tagStatus, "published", "tagStatus should be 'published' for approved tags");

        } finally {
            await cleanupTestData(moderationId, TEST_USER_ID);
        }
    });

    await runTest("Tags type moderation with rejection", async () => {
        const moderationId = await createTestModerationEntry({ type: "tags" });

        try {
            const result = await Moderation.applyModerationAction(
                moderationId,
                TEST_USER_ID,
                "reject",
                "Tags rejected",
                TEST_MODERATOR_ID
            );
            assertTrue(Boolean(result), "Should return updaed record");

            const updatedRecord = await Moderation.getModerationRecordById(moderationId, TEST_USER_ID);
            assertEqual(updatedRecord.tagStatus, "pending", "tagStatus should be 'pending' for rejected tags");

        } finally {
            await cleanupTestData(moderationId, TEST_USER_ID);
        }
    });

    await runTest("Non-existent moderation item", async () => {
        const nonExistentId = "non-existent-id-123";

        let threwError = false;
        try {
            await Moderation.applyModerationAction(
                nonExistentId,
                TEST_USER_ID,
                "approve",
                "Test reason",
                TEST_MODERATOR_ID
            );
        } catch (error) {
            threwError = true;
            assertTrue(error.message.includes("Moderation item not found"), "Error should mention item not found");
        }
        
        assertTrue(threwError, "Should throw error for non-existent moderation ID");
    });

    await runTest("Wrong user ID for moderation item", async () => {
        const moderationId = await createTestModerationEntry();
        const wrongUserId = "wrong-user-456";

        try {
            let threwError = false;
            try {
                await Moderation.applyModerationAction(
                    moderationId,
                    wrongUserId, // Different user ID
                    "approve",
                    "Test reason",
                    TEST_MODERATOR_ID
                );
            } catch (error) {
                threwError = true;
                assertTrue(error.message.includes("Moderation item not found"), "Error should mention item not found");
            }
            
            assertTrue(threwError, "Should throw error when user ID doesn't match");
        } finally {
            await cleanupTestData(moderationId, TEST_USER_ID);
        }
    });

    await runTest("Empty reason and moderator ID", async () => {
        const moderationId = await createTestModerationEntry();

        try {
            await Moderation.applyModerationAction(
                moderationId,
                TEST_USER_ID,
                "approve"
            );

            // Verify the update in database
            const updatedRecord = await Moderation.getModerationRecordById(moderationId, TEST_USER_ID);
            assertEqual(updatedRecord.reason, "", "Reason should be empty string when not provided");
            assertTrue(updatedRecord.moderatedBy === null || updatedRecord.moderatedBy === "", "moderatedBy should be null or empty when not provided");

        } finally {
            await cleanupTestData(moderationId, TEST_USER_ID);
        }
    });

    await runTest("Multiple actions on same item", async () => {
        const moderationId = await createTestModerationEntry();

        try {
            // First action - approve
            await Moderation.applyModerationAction(
                moderationId,
                TEST_USER_ID,
                "approve",
                "First approval",
                TEST_MODERATOR_ID
            );

            let record = await Moderation.getModerationRecordById(moderationId, TEST_USER_ID);
            const firstActionTime = record.actionedAt;

            // wait a bit to ensure different timestamps
            await new Promise(resolve => setTimeout(resolve, 10));

            await Moderation.applyModerationAction(
                moderationId,
                TEST_USER_ID,
                "reject",
                "Changed mind - reject",
                "different-moderator"
            );

            record = await Moderation.getModerationRecordById(moderationId, TEST_USER_ID);
            assertEqual(record.status, "rejected", "Status should be updated to rejected");
            assertEqual(record.action, "reject", "Action should be updated to reject");
            assertEqual(record.reason, "Changed mind - reject", "Reason should be updated");
            assertEqual(record.moderatedBy, "different-moderator", "Moderator should be updated");
            assertTrue(record.actionedAt > firstActionTime, "actionedAt should be updated to later time");

        } finally {
            await cleanupTestData(moderationId, TEST_USER_ID);
        }
    });
}
