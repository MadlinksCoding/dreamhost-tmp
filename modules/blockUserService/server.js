const express = require('express');
const dotenv = require('dotenv');
const { resolve } = require('path');

const { BlockService } = require('./src/services/BlockService.js');
const ScyllaDb = require('./src/services/scylla/scyllaDb.js');

dotenv.config();

const router = express.Router();


// ============================================
// CONTROLLERS
// ============================================
const BlockController = {
  
  /**
   * List user blocks with filters.
   * GET /block-users/listUserBlocks
   */
  async listUserBlocks(req, res) {
    try {
      const { limit, to, from, blocker_id, scope, is_permanent, nextToken, show_total_count, testing, show_deleted = true, sort_by = 'created_at', sort_order = 'desc', id, q, blocked_id, flag, expired, created_from, created_to } = req.query;

      let parsedLimit = 20;
      if (limit) {
        parsedLimit = parseInt(limit);
        if (isNaN(parsedLimit) || parsedLimit <= 0) {
          return res
            .status(400)
            .json({ error: "limit must be a positive number" });
        }
      }
      // Handle nextToken if it's an array (take first element)
      let parsedNextToken = nextToken;
      if (Array.isArray(nextToken)) {
        parsedNextToken = nextToken[0] || null;
      }

      // Validate sort parameters
      const allowedSortFields = {
        'created_at': true,
        'updated_at': true
      };
      const allowedSortOrders = {
        'asc': true,
        'desc': true,
        'ASC': true,
        'DESC': true
      };

      if (sort_by && !allowedSortFields[sort_by]) {
        return res
          .status(400)
          .json({ error: `sort_by must be one of: ${Object.keys(allowedSortFields).join(', ')}` });
      }

      if (sort_order && !allowedSortOrders[sort_order]) {
        return res
          .status(400)
          .json({ error: "sort_order must be 'asc' or 'desc'" });
      }

      const filters = {
        blocked_id: blocked_id || to, // Support both blocked_id and to parameters for backward compatibility
        blocker_id: blocker_id || from, // Support both blocker_id and from parameters
        scope,
        is_permanent: is_permanent !== undefined ? (is_permanent === 'true' || is_permanent === '1' || is_permanent === 1 ? 1 : 0) : undefined,
        testing: testing !== undefined ? (testing === 'true' || testing === '1' || testing === 1) : undefined,
        show_deleted: show_deleted === 'true' || show_deleted === '1' || show_deleted === 1,
        sort_by: sort_by,
        sort_order: sort_order,
        id: id,
        q: q,
        flag: flag,
        expired: expired !== undefined ? (expired === 'true' || expired === '1' || expired === 1) : undefined,
        created_from: created_from,
        created_to: created_to
      };
      const result = await BlockService.listUserBlocks(
        filters,
        parsedLimit,
        parsedNextToken, 
        show_total_count ==true
      );
      res.json({
        success: true,
        count: result.count,
        items: result.items,
        nextToken: result.nextToken || undefined,
        hasMore: !!result.nextToken || false,
        totalCount: result.totalCount,
      });
    } catch (error) {
      console.error("Error listing user blocks:", error);
      res
        .status(500)
        .json({ error: "Failed to list user blocks", message: error.message });
    }
  },
  /**
   * Block a user.
   * POST /block-users/blockUser
   */
  async blockUser(req, res) {
    try {
      const { from, to, scope, reason, flag, is_permanent, expires_at, testing } =
        req.body;

      if (!from || !to || !scope) {
        return res
          .status(400)
          .json({ error: "from, to, and scope are required" });
      }

      let temporaryDuration = undefined;
      if (expires_at) {
        temporaryDuration = parseInt(expires_at);
        if (isNaN(temporaryDuration) || temporaryDuration <= 0) {
          return res
            .status(400)
            .json({ error: "expires_at must be a positive number (seconds)" });
        }
      }

      const options = {
        reason,
        flag,
        is_permanent: !!is_permanent,
        expires_at: temporaryDuration,
        testing: !!testing,
      };

      const result = await BlockService.blockUser(from, to, scope, options);
      res.status(201).json({ success: true, result });
    } catch (error) {
      console.error("Error blocking user:", error);
      res
        .status(500)
        .json({ error: "Failed to block user", message: error.message });
    }
  },

  /**
   * Unblock a user.
   * POST /block-users/unblockUser
   */
  async unblockUser(req, res) {
    try {
      const { from, to, scope } = req.body;

      if (!from || !to || !scope) {
        return res
          .status(400)
          .json({ error: "from, to, and scope are required" });
      }

      const result = await BlockService.unblockUser(from, to, scope);
      res.json({ success: true, result });
    } catch (error) {
      console.error("Error unblocking user:", error);
      res
        .status(500)
        .json({ error: "Failed to unblock user", message: error.message });
    }
  },

  /**
   * Check if a user is blocked.
   * GET /block-users/isUserBlocked
   */
  async isUserBlocked(req, res) {
    try {
      const { from, to, scope } = req.query;

      if (!from || !to || !scope) {
        return res
          .status(400)
          .json({ error: "from, to, and scope are required" });
      }

      const result = await BlockService.isUserBlocked(from, to, scope);
      // result is the block item if found, or null/undefined
      res.json({
        blocked: !!result,
        blockDetails: result || null,
      });
    } catch (error) {
      console.error("Error checking block status:", error);
      res.status(500).json({
        error: "Failed to check block status",
        message: error.message,
      });
    }
  },

  /**
   * Batch check user blocks.
   * POST /block-users/batchCheckUserBlocks
   */
  async batchCheckUserBlocks(req, res) {
    try {
      const { blocks } = req.body;

      if (!Array.isArray(blocks)) {
        return res.status(400).json({ error: "blocks must be an array" });
      }

      const results = await BlockService.batchCheckUserBlocks(blocks);
      res.json({ results });
    } catch (error) {
      console.error("Error batch checking blocks:", error);
      res.status(500).json({
        error: "Failed to batch check blocks",
        message: error.message,
      });
    }
  },

  async GetBlocksForUser(req, res) {
    try {
    const { to, show_deleted , ...options } = req.query;
    if(!to)
        res.status(400).json({
            error:"invalid input",
            message:"to is required"
        })
      const results = await BlockService.GetBlocksForUser(to, show_deleted, options );
      res.json({ ...results });
    } catch (error) {
      console.error("Error GetBlocksForUser:", error);
      res.status(500).json({
        error: "Failed to GetBlocksForUser",
        message: error.message,
      });
    }
  },

  /**
   * Block an IP address.
   * POST /block-users/blockIP
   */
  async blockIP(req, res) {
    try {
      const { ip, reason, permanent,...options } = req.body;

      if (!ip) {
        return res.status(400).json({ error: "ip is required" });
      }

      await BlockService.blockIP(ip, reason, permanent,options);
      res.status(201).json({ success: true });
    } catch (error) {
      console.error("Error blocking IP:", error);
      res
        .status(500)
        .json({ error: "Failed to block IP", message: error.message });
    }
  },

  /**
   * Check if an IP is blocked.
   * GET /block-users/isIPBlocked
   */
  async isIPBlocked(req, res) {
    try {
      const { ip } = req.query;

      if (!ip) {
        return res.status(400).json({ error: "ip is required" });
      }

      const result = await BlockService.isIPBlocked(ip);
      res.json({
        blocked: !!result.db,
        details: result,
      });
    } catch (error) {
      console.error("Error checking IP block:", error);
      res
        .status(500)
        .json({ error: "Failed to check IP block", message: error.message });
    }
  },

  /**
   * Block an Email.
   * POST /block-users/blockEmail
   */
  async blockEmail(req, res) {
    try {
      const { email, reason, permanent,...options } = req.body;

      if (!email) {
        return res.status(400).json({ error: "email is required" });
      }

      await BlockService.blockEmail(email, reason, permanent, options);
      res.status(201).json({ success: true });
    } catch (error) {
      console.error("Error blocking email:", error);
      res
        .status(500)
        .json({ error: "Failed to block email", message: error.message });
    }
  },

  /**
   * Check if an Email is blocked.
   * GET /block-users/isEmailBlocked
   */
  async isEmailBlocked(req, res) {
    try {
      const { email } = req.query;

      if (!email) {
        return res.status(400).json({ error: "email is required" });
      }

      const result = await BlockService.isEmailBlocked(email);
      res.json({
        blocked: !!result.db,
        details: result,
      });
    } catch (error) {
      console.error("Error checking email block:", error);
      res
        .status(500)
        .json({ error: "Failed to check email block", message: error.message });
    }
  },

  /**
   * Block App Access for a user.
   * POST /block-users/blockAppAccess
   */
  async blockAppAccess(req, res) {
    try {
      const { userId, scope, reason, permanent,...options } = req.body;

      if (!userId || !scope) {
        return res.status(400).json({ error: "userId and scope are required" });
      }

      await BlockService.blockAppAccess(userId, scope, reason, permanent,options);
      res.status(201).json({ success: true });
    } catch (error) {
      console.error("Error blocking app access:", error);
      res
        .status(500)
        .json({ error: "Failed to block app access", message: error.message });
    }
  },

  /**
   * Check if App Access is blocked.
   * GET /block-users/isAppAccessBlocked
   */
  async isAppAccessBlocked(req, res) {
    try {
      const { userId, scope } = req.query;

      if (!userId || !scope) {
        return res.status(400).json({ error: "userId and scope are required" });
      }

      const result = await BlockService.isAppAccessBlocked(userId, scope);
      res.json({
        blocked: !!result.db,
        details: result,
      });
    } catch (error) {
      console.error("Error checking app access block:", error);
      res.status(500).json({
        error: "Failed to check app access block",
        message: error.message,
      });
    }
  },

  /**
   * Suspend a user.
   * POST /block-users/suspendUser
   */
  async suspendUser(req, res) {
    try {
      const { userId, reason, adminId, flag, note,...options } = req.body;

      if (!userId || !reason || !adminId) {
        return res
          .status(400)
          .json({ error: "userId, reason, and adminId are required" });
      }

      await BlockService.suspendUser(userId, reason, adminId, flag, note,options);
      res.status(201).json({ success: true });
    } catch (error) {
      console.error("Error suspending user:", error);
      res
        .status(500)
        .json({ error: "Failed to suspend user", message: error.message });
    }
  },

  /**
   * Unsuspend a user.
   * POST /block-users/unsuspendUser
   */
  async unsuspendUser(req, res) {
    try {
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ error: "userId is required" });
      }

      await BlockService.unsuspendUser(userId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error unsuspending user:", error);
      res
        .status(500)
        .json({ error: "Failed to unsuspend user", message: error.message });
    }
  },

  /**
   * Check if a user is suspended.
   * GET /block-users/isUserSuspended
   */
  async isUserSuspended(req, res) {
    try {
      const { userId } = req.query;

      if (!userId) {
        return res.status(400).json({ error: "userId is required" });
      }

      const result = await BlockService.isUserSuspended(userId);
      res.json({
        suspended: !!result.db,
        details: result,
      });
    } catch (error) {
      console.error("Error checking suspension:", error);
      res
        .status(500)
        .json({ error: "Failed to check suspension", message: error.message });
    }
  },

  /**
   * Warn a user.
   * POST /block-users/warnUser
   */
  async warnUser(req, res) {
    try {
      const { userId, flag, adminId, note,...options } = req.body;

      if (!userId || !flag || !adminId) {
        return res
          .status(400)
          .json({ error: "userId, flag, and adminId are required" });
      }

      await BlockService.warnUser(userId, flag, adminId, note, options);
      res.status(201).json({ success: true });
    } catch (error) {
      console.error("Error warning user:", error);
      res
        .status(500)
        .json({ error: "Failed to warn user", message: error.message });
    }
  },

  /**
   * Get manual actions for a user.
   * GET /block-users/getUserManualActions
   */
  async getUserManualActions(req, res) {
    try {
      const { userId } = req.query;

      if (!userId) {
        return res.status(400).json({ error: "userId is required" });
      }

      const result = await BlockService.getUserManualActions(userId);
      res.json({
        success: true,
        count: result.items.length,
        items: result.items,
        nextToken: result.nextToken || undefined,
        hasMore: !!result.nextToken || false,
        totalCount: result.totalCount,
      });
    } catch (error) {
      console.error("Error getting manual actions:", error);
      res.status(500).json({
        error: "Failed to get manual actions",
        message: error.message,
      });
    }
  },


  /**
   * List system blocks with filters.
   * GET /block-users/listSystemBlocks
   */
  async listSystemBlocks(req, res) {
    try {
      const { limit, nextToken, ...filters } = req.query;

      let parsedLimit = 20;
      if (limit) {
        parsedLimit = parseInt(limit);
        if (isNaN(parsedLimit) || parsedLimit <= 0) {
          return res
            .status(400)
            .json({ error: "limit must be a positive number" });
        }
      }

      const result = await BlockService.listSystemBlocks(
        filters,
        parsedLimit,
        nextToken
      );
      res.json({
        success: true,
        count: result.count,
        items: result.items,
        nextToken: result.nextToken || undefined,
        hasMore: !!result.nextToken || false,
        totalCount: result.totalCount,
      });
    } catch (error) {
      console.error("Error listing system blocks:", error);
      res.status(500).json({
        error: "Failed to list system blocks",
        message: error.message,
      });
    }
  },

  /**
   * List manual actions with filters.
   * GET /block-users/listManualActions
   */
  async listManualActions(req, res) {
    try {
      const { limit, nextToken, ...filters } = req.query;

      let parsedLimit = 20;
      if (limit) {
        parsedLimit = parseInt(limit);
        if (isNaN(parsedLimit) || parsedLimit <= 0) {
          return res
            .status(400)
            .json({ error: "limit must be a positive number" });
        }
      }

      const result = await BlockService.listManualActions(
        filters,
        parsedLimit,
        nextToken
      );
      res.json({
        success: true,
        count: result.count,
        actions: result.items,
        nextToken: result.nextToken || undefined,
        hasMore: !!result.nextToken || false,
        totalCount: result.totalCount,
      });
    } catch (error) {
      console.error("Error listing manual actions:", error);
      res.status(500).json({
        error: "Failed to list manual actions",
        message: error.message,
      });
    }
  },


  async getUserActivityStats(req,res){
    const {userId} = req.body;
    console.log("getting user activity");
    const result = await BlockService.getUserActivityStats(userId);
    res.json({
      ...result
    })

  }
};

// ============================================
// ROUTES
// ============================================

// User Blocking
router.get("/block-users/listUserBlocks", BlockController.listUserBlocks);
router.get("/block-users/getBlocksForUser", BlockController.GetBlocksForUser);
router.post("/block-users/blockUser", BlockController.blockUser);
router.post("/block-users/unblockUser", BlockController.unblockUser);
router.get("/block-users/isUserBlocked", BlockController.isUserBlocked);
router.get("/block-users/getUserBlockes", BlockController.isUserBlocked);
router.post("/block-users/batchCheckUserBlocks", BlockController.batchCheckUserBlocks);

// System Blocking (IP, Email, App)
router.get("/block-users/listSystemBlocks", BlockController.listSystemBlocks);
router.post("/block-users/blockIP", BlockController.blockIP);
router.get("/block-users/isIPBlocked", BlockController.isIPBlocked);
router.post("/block-users/blockEmail", BlockController.blockEmail);
router.get("/block-users/isEmailBlocked", BlockController.isEmailBlocked);
router.post("/block-users/blockAppAccess", BlockController.blockAppAccess);
router.get("/block-users/isAppAccessBlocked", BlockController.isAppAccessBlocked);

// Manual Actions (Suspend, Warn)
router.get("/block-users/listManualActions", BlockController.listManualActions);
router.get("/block-users/getUserManualActions", BlockController.getUserManualActions);
router.post("/block-users/suspendUser", BlockController.suspendUser);
router.post("/block-users/unsuspendUser", BlockController.unsuspendUser);
router.get("/block-users/isUserSuspended", BlockController.isUserSuspended);
router.post("/block-users/warnUser", BlockController.warnUser);
router.post("/block-users/UserStats",BlockController.getUserActivityStats);

router.post("/block-users/clean-up", (res)=>{
  res.json({
      "success":true,
      "message":"not implemented yet"
  })
});

// ============================================
// INIT SERVICE
// ============================================
const initBlockUserService = async () => {
    try {
        // Load Scylla Configs
        const configPath = resolve(__dirname, "scylla-schema-config.json");
        await ScyllaDb.loadTableConfigs(configPath);
        console.log("ScyllaDB configs loaded.");

        // Check ScyllaDB connection
        try {
            // Ensure table exists
            await ScyllaDb.describeTable("user_blocks");

            console.log('✅ ScyllaDB connection established');

        } catch (connErr) {
            console.error('❌ Database connection failed:', connErr.message);

            console.warn("ScyllaDB connection check failed:", connErr.message);
            console.warn("Service may run with degraded functionality.");
        }
    } catch (err) {
        console.error("Service initialization error:", err);
        // Don't exit, allow running with degraded functionality if possible
    }
};

module.exports = { router, initBlockUserService };
