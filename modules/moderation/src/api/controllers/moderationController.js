const cacheFlushTag = async (req, res) => {
  // ============================================
  // CACHE FLUSH - TAGS
  // ============================================
  try {
    const { tagId } = req.params;
    // TODO: Integrate with cache service
    // This is a placeholder for cache flush functionality
    // In production, this would:
    // 1. Flush tag-specific cache entries
    // 2. Invalidate related moderation cache
    // 3. Trigger cache refresh
    console.log("🗑️  Cache flush requested for tag:", tagId);
    // Placeholder: In production, implement actual cache flush logic
    // Example: await CacheService.flushTag(tagId);
    res.json({
      success: true,
      message: `Cache flushed for tag: ${tagId}`,
      tagId,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const cacheFlushGeneral = async (req, res) => {
  // ============================================
  // CACHE FLUSH - GENERAL
  // ============================================
  try {
    const { type, id } = req.query;
    // TODO: Integrate with cache service
    // This is a placeholder for cache flush functionality
    // In production, this would:
    // 1. Flush cache by type (tags, moderation, etc.)
    // 2. Optionally flush specific ID
    // 3. Trigger cache refresh
    console.log("🗑️  Cache flush requested:", { type, id });
    if (type === "tags") {
      // Flush all tag-related cache
      // Example: await CacheService.flushTags();
      console.log("🗑️  Flushing tags cache");
    } else if (type === "moderation") {
      // Flush moderation cache
      // Example: await CacheService.flushModeration();
      console.log("🗑️  Flushing moderation cache");
    } else if (type) {
      // Flush specific type
      console.log(`🗑️  Flushing ${type} cache`);
    } else {
      // Flush all cache
      console.log("🗑️  Flushing all cache");
    }
    res.json({
      success: true,
      message: `Cache flushed${type ? ` for type: ${type}` : " (all)"}`,
      type: type || "all",
      id: id || null,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
const { zstdCompress } = require('zlib');
// ============================================
// CREATE MODERATION ENTRY Controller
// ============================================
const Moderation = require('../../core/moderation.js');

const createModerationEntry = async (req, res) => {
  try {
    const {
      userId,
      contentId,
      type,
      priority,
      contentType,
      mediaType,
      isSystemGenerated,
      isPreApproved,
      timestamp,
    } = req.body;
    if (!userId || !contentId || !type) {
      console.log("❗ Missing required fields:", req.body);
      return res.status(400).json({
        error: "Missing required fields",
        required: ["userId", "contentId", "type"],
      });
    }

    const moderationId = await Moderation.createModerationEntry(
      {
        userId,
        contentId,
        type,
        priority: priority || Moderation.PRIORITY.NORMAL,
        contentType,
        mediaType,
        isSystemGenerated: Boolean(isSystemGenerated),
        isPreApproved: Boolean(isPreApproved),
      },
      timestamp
    );

    res.status(201).json({
      success: true,
      moderationId,
      message: "Moderation entry created successfully",
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getModerationItems = async (req, res) => {
  // ============================================
  // GET MODERATION ITEMS (General)
  // ============================================
  try {zstdCompress
    const { limit = 20, nextToken, start, end, asc = "false", show_total_count } = req.query; // General pagination params
    // Extract possible filters from query params
    const { userId, status, priority, type, dayKey, moderatedBy, contentId, escalatedBy, q } = req.query;
    let searchModerationId;
    let searchContentId;
    if (typeof q === "string" && q.trim()) {
      const trimmed = q.trim();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (uuidRegex.test(trimmed)) {
        searchModerationId = trimmed;
      } else {
        searchContentId = trimmed;
      }
    }
    const filters = {
      userId: userId || undefined,
      status: status || undefined,
      priority: priority || undefined,
      type: type || undefined,
      dayKey: dayKey || undefined,
      moderatedBy: moderatedBy || undefined,
      contentId: contentId || searchContentId || undefined,
      escalatedBy: escalatedBy || undefined,
      moderationId: searchModerationId || undefined,
    };
    const options = {
      limit: parseInt(limit, 10),
      nextToken: nextToken || null,
      start: start ? parseInt(start, 10) : null,
      end: end ? parseInt(end, 10) : null,
      asc: asc === "true",
    };
    let totalCount;
    if (show_total_count){
      totalCount= await Moderation.countModerationItemsByStatus(status);
      console.log("total:", totalCount)
    }
    const result = await Moderation.getModerationItems(filters, options);
    res.json({
      success: true,
      items: result.items,
      nextToken: result.nextToken,
      hasMore: result.hasMore,
      count: result.items.length,
      totalCount
    });
  } catch (error) {
    console.log("error:", error);
    res.status(400).json({ error: error.message });
  }
};



const getModerationCount = async (req, res) => {
  // ============================================
  // GET MODERATION COUNT (Option 1: Dedicated Count Endpoint)
  // ============================================
  try {
    const {
      status = "all",
      userId,
      moderatedBy,
      hasRejectionHistory,
      start,
      end,
    } = req.query;

    // Parse boolean query params
    const hasRejectionHistoryBool =
      hasRejectionHistory === "true"
        ? true
        : hasRejectionHistory === "false"
        ? false
        : null;

    // Handle moderatedBy=null (unmoderated items)
    const moderatedByValue = moderatedBy === "null" ? null : moderatedBy;

    const options = {
      userId: userId || null,
      moderatedBy: moderatedByValue !== undefined ? moderatedByValue : null,
      hasRejectionHistory: hasRejectionHistoryBool,
      start: start ? parseInt(start, 10) : null,
      end: end ? parseInt(end, 10) : null,
    };

    const count = await Moderation.countModerationItemsByStatus(
      status,
      options
    );

    res.json({
      success: true,
      count,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};



// ============================================
// outdated section
const getModerationItemsByStatus = async (req, res) => {
  // ============================================
  // GET MODERATION ITEMS BY STATUS
  // ============================================
  try {
    const { status } = req.params;
    const { limit = 20, nextToken, start, end, asc = "false" } = req.query;

    const options = {
      limit: parseInt(limit, 10),
      nextToken: nextToken || null,
      start: start ? parseInt(start, 10) : null,
      end: end ? parseInt(end, 10) : null,
      asc: asc === "true",
    };

    const result = await Moderation.getModerationItemsByStatus(status, options);

    res.json({
      success: true,
      items: result.items,
      nextToken: result.nextToken,
      hasMore: result.hasMore,
      count: result.items.length,
      totalPages: result.totalPages || 1,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getModerationItemsByType = async (req, res) => {
  // ============================================
  // GET MODERATION ITEMS BY TYPE
  // ============================================
  try {
    const { type } = req.params;
    const { limit = 20, nextToken, start, end, asc = "false" } = req.query;

    const options = {
      limit: parseInt(limit, 10),
      nextToken: nextToken || null,
      start: start ? parseInt(start, 10) : null,
      end: end ? parseInt(end, 10) : null,
      asc: asc === "true",
    };

    const result = await Moderation.getModerationItemsByType(type, options);

    res.json({
      success: true,
      items: result.items,
      nextToken: result.nextToken,
      hasMore: result.hasMore,
      count: result.items.length,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getModerationItemsByPriority = async (req, res) => {
  // ============================================
  // GET MODERATION ITEMS BY PRIORITY
  // ============================================
  try {
    const { priority } = req.params;
    const { limit = 20, nextToken, start, end, asc = "false" } = req.query;

    const options = {
      limit: parseInt(limit, 10),
      nextToken: nextToken || null,
      start: start ? parseInt(start, 10) : null,
      end: end ? parseInt(end, 10) : null,
      asc: asc === "true",
    };

    const result = await Moderation.getModerationItemsByPriority(
      priority,
      options
    );

    res.json({
      success: true,
      items: result.items,
      nextToken: result.nextToken,
      hasMore: result.hasMore,
      count: result.items.length,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getUserModerationItemsByStatus = async (req, res) => {
  // ============================================
  // GET USER MODERATION ITEMS BY STATUS
  // ============================================
  try {
    const { userId, status } = req.params;
    const { limit = 20, nextToken, start, end, asc = "false" } = req.query;

    const options = {
      limit: parseInt(limit, 10),
      nextToken: nextToken || null,
      start: start ? parseInt(start, 10) : null,
      end: end ? parseInt(end, 10) : null,
      asc: asc === "true",
    };

    const result = await Moderation.getUserModerationItemsByStatus(
      userId,
      status,
      options
    );

    res.json({
      success: true,
      items: result.items,
      nextToken: result.nextToken,
      hasMore: result.hasMore,
      count: result.items.length,
      totalPages: result.totalPages || 100,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getModerationById = async (req, res) => {
  // ============================================
  // GET MODERATION RECORD BY ID
  // ============================================
  try {
    const { moderationId } = req.params;
    const { userId } = req.query;

    const record = await Moderation.getModerationRecordById(
      moderationId,
      userId || null
    );

    if (!record) {
      return res.status(404).json({
        error: "Moderation record not found",
        moderationId,
      });
    }

    res.json({
      success: true,
      item: record,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getAllByDate = async (req, res) => {
  // ============================================
  // GET ALL BY DATE (Day Key)
  // ============================================
  try {
    const { dayKey } = req.params;
    const { limit = 20, nextToken, start, end, asc = "false" } = req.query;

    const options = {
      limit: parseInt(limit, 10),
      nextToken: nextToken || null,
      start: start ? parseInt(start, 10) : null,
      end: end ? parseInt(end, 10) : null,
      asc: asc === "true",
    };

    const result = await Moderation.getAllByDate(dayKey, options);

    res.json({
      success: true,
      items: result.items,
      nextToken: result.nextToken,
      hasMore: result.hasMore,
      count: result.items.length,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};
// ============================================



const updateModeration = async (req, res) => {
  // ============================================
  // UPDATE MODERATION RECORD (PUT)
  // ============================================
  try {
    const { moderationId } = req.params;
     const {
      userId,
      contentId,
      type,
      priority,
      contentType,
      mediaType,
      isSystemGenerated,
      isPreApproved,
    } = req.body;
    const updates = {
      contentId,
      type,
      priority,
      contentType,
      mediaType,
      isSystemGenerated,
      isPreApproved,
    };

    const result = await Moderation.updateModerationEntry(
      moderationId,
      updates,
    );

    res.json({
      success: true,
      message: "Moderation entry updated successfully",
      item: result,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const deleteModeration = async (req, res) => {
  // ============================================
  // DELETE MODERATION ITEM
  // ============================================
  try {
    const { moderationId } = req.params;
    const { userId, hardDelete = false, deletedBy } = req.query;

    // Parse hardDelete from query string (defaults to false for soft delete)
    const isHardDelete = hardDelete === "true" || hardDelete === true;

    if (isHardDelete) {
      // Hard delete (permanently remove from database)
      const deleted = await Moderation.hardDeleteModerationItem(
        moderationId,
        userId || null
      );

      if (!deleted) {
        return res.status(404).json({
          error: "Moderation record not found",
          moderationId,
        });
      }

      res.json({
        success: true,
        message: "Moderation item permanently deleted",
        moderationId,
      });
    } else {
      // Soft delete (set isDeleted flag) - recommended
      const deletedByParam = deletedBy || userId;
      const result = await Moderation.softDeleteModerationItem(
        moderationId,
        userId || null,
        deletedByParam
      );

      res.json({
        success: true,
        message: "Moderation item soft deleted successfully",
        item: result,
      });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const updateModerationMeta = async (req, res) => {
  // ============================================
  // UPDATE MODERATION META (POST)
  // ============================================
  try {
    const { moderationId } = req.params;
    const { userId, meta } = req.body;

    if (!meta) {
      return res.status(400).json({
        error: "Missing required field: meta",
      });
    }

    // Update meta fields
    const metaUpdates = {
      contentDeleted: meta.contentDeleted,
      contentDeletedAt:
        meta.contentDeletedAt || (meta.contentDeleted ? Date.now() : null),
      updatedBy: meta.updatedBy || userId,
    };

    const result = await Moderation.updateModerationMeta(
      moderationId,
      userId || null,
      metaUpdates
    );

    res.json({
      success: true,
      message: "Moderation meta updated successfully",
      item: result,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const applyModerationAction = async (req, res) => {
  // ============================================
  // APPLY MODERATION ACTION (Approve/Reject)
  // ============================================
  try {
    const { moderationId } = req.params;
    const {
      userId,
      action,
      reason = "",
      moderatedBy = "",
      moderationType = "standard",
      note = null,
      publicNote = null,
    } = req.body;

    if (!userId || !action) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["userId", "action"],
      });
    }

    if (!Object.values(Moderation.ACTION).includes(action)) {
      return res.status(400).json({
        error: "Invalid action",
        valid: Object.values(Moderation.ACTION),
      });
    }

    const result = await Moderation.applyModerationAction(
      moderationId,
      userId,
      action,
      reason,
      moderatedBy,
      moderationType,
      note,
      publicNote
    );

    res.json({
      success: true,
      message: `Moderation ID ${moderationId} Entry successful`,
      item: result,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const escalateModeration = async (req, res) => {
  // ============================================
  // ESCALATE MODERATION ITEM
  // ============================================
  try {
    const { moderationId } = req.params;
    const { userId, escalatedBy } = req.body;

    if (!userId || !escalatedBy) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["userId", "escalatedBy"],
      });
    }

    const result = await Moderation.escalateModerationItem(
      moderationId,
      userId,
      escalatedBy
    );

    res.json({
      success: true,
      message: `Moderation ID ${moderationId} escalated successfully`,
      item: result,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const addNote = async (req, res) => {
  // ============================================
  // ADD NOTE TO MODERATION ITEM
  // ============================================
  try {
    const { moderationId } = req.params;
    const { userId, note, addedBy } = req.body;

    if (!userId || !note || !addedBy) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["userId", "note", "addedBy"],
      });
    }

    const result = await Moderation.addNote(
      moderationId,
      userId,
      note,
      addedBy
    );

    res.json({
      success: true,
      message: "Note added successfully",
      item: result,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const notifyModeration = async (req, res) => {
  // ============================================
  // NOTIFY MODERATION STATUS CHANGE
  // ============================================
  try {
    const { moderationId } = req.params;
    const { event, webhookUrl, notificationData } = req.body;

    // Get moderation record
    const record = await Moderation.getModerationRecordById(moderationId);
    if (!record) {
      return res.status(404).json({
        error: "Moderation record not found",
        moderationId,
      });
    }

    // TODO: Integrate with notification service
    // This is a placeholder for notification/webhook integration
    // In production, this would:
    // 1. Send webhook to configured URL
    // 2. Trigger notification service
    // 3. Log notification event

    const notificationPayload = {
      moderationId: record.moderationId,
      userId: record.userId,
      status: record.status,
      event: event || "status_change",
      timestamp: Date.now(),
      ...notificationData,
    };

    // Placeholder: In production, implement actual notification logic
    console.log("📧 Notification triggered:", notificationPayload);

    // If webhook URL provided, would make HTTP request here
    if (webhookUrl) {
      // TODO: Make HTTP POST to webhookUrl with notificationPayload
      console.log("🔗 Webhook URL provided:", webhookUrl);
    }

    res.json({
      success: true,
      message: "Notification triggered successfully",
      notification: notificationPayload,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getModerationNotes = async (req, res) => {
  // ============================================
  // GET NOTES FOR MODERATION ITEM
  // ============================================
  try {
    const { moderationId } = req.params;
    const { userId } = req.query;

    // Get moderation record
    const record = await Moderation.getModerationRecordById(
      moderationId,
      userId || null
    );

    if (!record) {
      return res.status(404).json({
        error: "Moderation record not found",
        moderationId,
      });
    }

    // Return notes array (empty array if no notes exist)
    const allNotes = Array.isArray(record.notes) ? record.notes : [];

    // Separate private and public notes
    const privateNotes = allNotes.filter(
      (n) => n.isPublic === false || n.isPublic === undefined
    );
    const publicNotes = allNotes.filter((n) => n.isPublic === true);

    res.json({
      success: true,
      moderationId: record.moderationId,
      notes: allNotes,
      privateNotes: privateNotes,
      publicNotes: publicNotes,
      count: allNotes.length,
      privateCount: privateNotes.length,
      publicCount: publicNotes.length,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

const getModerationContent = async (req, res) => {
  // ============================================
  // GET CONTENT FOR MODERATION ITEM
  // ============================================
  // NOTE: This route MUST come before /moderation/:moderationId to avoid route conflicts
  try {
    const { moderationId } = req.params;
    const { userId } = req.query;

    // Get moderation record
    const record = await Moderation.getModerationRecordById(
      moderationId,
      userId || null
    );

    if (!record) {
      return res.status(404).json({
        error: "Moderation record not found",
        moderationId,
      });
    }

    // Fetch actual content based on type
    // You may want to move fetchContentByType to a shared util if needed
    const contentData = await fetchContentByType(
      record.contentId,
      record.type,
      record.contentType,
      record.mediaType
    );

    res.json({
      success: true,
      moderationId: record.moderationId,
      ...contentData,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

module.exports = {
  createModerationEntry,
  getModerationItems,
  getModerationItemsByStatus,
  getModerationCount,
  getModerationItemsByType,
  getModerationItemsByPriority,
  getUserModerationItemsByStatus,
  getModerationById,
  getAllByDate,
  updateModeration,
  deleteModeration,
  updateModerationMeta,
  applyModerationAction,
  escalateModeration,
  addNote,
  notifyModeration,
  getModerationNotes,
  getModerationContent,
  cacheFlushTag,
  cacheFlushGeneral,
};
