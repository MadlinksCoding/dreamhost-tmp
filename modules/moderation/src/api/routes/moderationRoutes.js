const express = require('express');
const router = express.Router();
const moderationController = require('../controllers/moderationController.js');

// ============================================
// CREATE MODERATION ENTRY
// ============================================
router.post("/createModerationEntry", moderationController.createModerationEntry);

// ============================================
// GET MODERATION ENTRIES
// ============================================
router.get("/fetchModerations", moderationController.getModerationItems);

// ============================================
// GET MODERATION RECORD BY ID
// ============================================
router.get("/fetchModerationById/:moderationId", moderationController.getModerationById);


// ============================================
// GET MODERATION COUNT (Option 1: Dedicated Count Endpoint)
// ============================================
router.get("/count", moderationController.getModerationCount);


// ============================================
// UPDATE MODERATION RECORD (PUT)
// ============================================
router.put("/updateModeration/:moderationId", moderationController.updateModeration);

// ============================================
// DELETE MODERATION ITEM
// ============================================
router.delete("/deleteModeration/:moderationId", moderationController.deleteModeration);

// ============================================
// APPLY MODERATION ACTION (Approve/Reject)
// ============================================
router.post("/applyModerationAction/:moderationId", moderationController.applyModerationAction);

// ============================================
// ESCALATE MODERATION ITEM
// ============================================
router.post("/escalateModeration/:moderationId", moderationController.escalateModeration);

// ============================================
// ADD NOTE TO MODERATION ITEM/S
// ============================================
router.post("/addNote/:moderationId", moderationController.addNote);

// ============================================
// UPDATE MODERATION META (POST)
// ============================================
router.post("/updateModerationMeta/:moderationId", moderationController.updateModerationMeta);

// ============================================
// NOTIFY MODERATION STATUS CHANGE
// ============================================
router.post("/notifyModeration/:moderationId", moderationController.notifyModeration);

// ============================================
// GET NOTES FOR MODERATION ITEM
// ============================================
router.get("/fetchModerationNotes/:moderationId", moderationController.getModerationNotes);

// ============================================
// GET CONTENT FOR MODERATION ITEM
// ============================================
router.get("/fetchModerationContent/:moderationId", moderationController.getModerationContent);

// ============================================
// CACHE FLUSH - TAGS
// ============================================
router.post("/cacheFlushTag/:tagId", moderationController.cacheFlushTag);

// ============================================
// CACHE FLUSH - GENERAL
// ============================================
router.post("/cacheFlushGeneral", moderationController.cacheFlushGeneral);

module.exports = router;
