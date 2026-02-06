import { runTest, assertTrue, assertEqual, assertThrows } from './utils.js';
import Moderation from '../src/core/moderation.js';

async function createTestModerationReturningId({
    timestamp = undefined,
    userId = "note-user-1",
    type = "text",
    priority = "normal",
} = {}) {
    const data = {
        userId,
        contentId: 'note_test_content',
        type,
        contentType: "post",
        mediaType: null,
        priority,
        isSystemGenerated: false,
        isPreApproved: false,
    };
    const moderationId = await Moderation.createModerationEntry(data, timestamp);
    return { moderationId, userId, submittedAt: timestamp ?? Date.now() };
}

export async function testAddNote() {
    await runTest("Adds first note to a record", async () => {
        const { moderationId, userId } = await createTestModerationReturningId();

        const updated = await Moderation.addNote(moderationId, userId, "First note", "mod-a");
        assertTrue(!!updated, "Should return updated record");
        assertTrue(Array.isArray(updated.notes), "notes should be an array");
        assertEqual(updated.notes.length, 1, "Should have 1 note");

        const n = updated.notes[0];
        assertEqual(n.text, "First note", "Note text matches");
        assertEqual(n.addedBy, "mod-a", "addedBy matches");
        assertTrue(!!n.addedAt, "addedAt should be set");
    });

    await runTest("Appends subsequent notes in order", async () => {
        const { moderationId, userId } = await createTestModerationReturningId();

        await Moderation.addNote(moderationId, userId, "N1", "mod-a");
        const updated = await Moderation.addNote(moderationId, userId, "N2", "mod-b");

        assertEqual(updated.notes.length, 2, "Should have 2 notes");
        assertEqual(updated.notes[0].text, "N1", "First note text preserved");
        assertEqual(updated.notes[1].text, "N2", "Second note text appended");
    });

    await runTest("Trims note text", async () => {
        const { moderationId, userId } = await createTestModerationReturningId();
        const updated = await Moderation.addNote(moderationId, userId, "   spaced   ", "mod-a");
        assertEqual(updated.notes[0].text, "spaced", "Should trim note text");
    });

    await runTest("Rejects empty note text", async () => {
        const { moderationId, userId } = await createTestModerationReturningId();
        let threwError = false;
        try {
            await Moderation.addNote(moderationId, userId, "   ", "mod-a");
        } catch (error) {
            threwError = true;
            assertTrue(error.message.includes("Note text is required"), "Error should mention note text required");
        }
        
        assertTrue(threwError, "Should throw for empty note text");
    });

    await runTest("Rejects missing addedBy", async () => {
        const { moderationId, userId } = await createTestModerationReturningId();
        let threwError = false;
        try {
            await Moderation.addNote(moderationId, userId, "valid", "");
        } catch (error) {
            threwError = true;
            assertTrue(error.message.includes("addedBy is required"), "Error should mention addedBy required");
        }
        
        assertTrue(threwError, "Should throw for missing addedBy");
    });

    await runTest("Throws when record not found", async () => {
        let threwError = false;
        try {
            await Moderation.addNote("no-such-id", "no-such-user", "X", "mod-x");
        } catch (error) {
            threwError = true;
            assertTrue(error.message.includes("Moderation item not found"), "Error should mention item not found");
        }
        
        assertTrue(threwError, "Should throw when the moderation item cannot be found");
    });
}
