const express = require('express');
const dotenv = require('dotenv');
const { randomUUID } = require('crypto');
const MediaHandler = require('./src/service/MediaHandler.js');
const { DB, Logger, DateTime } = require('./src/utils/index.js');

dotenv.config();

const router = express.Router();

// Initialize MediaHandler
const db = new DB();
const log = Logger;
const indexer = { upsert: async () => {}, delete: async () => {} }; // Placeholder for Elasticsearch
const clock = DateTime;
const uuid = { v4: () => randomUUID() };
const config = {};
const mediaHandler = new MediaHandler({ db, log, indexer, clock, uuid, config });

// ============================================
// CONTROLLERS
// ============================================
const MediaController = {
    /**
     * Create a new media item.
     *
     * @param {object} req.body - The media data.
     * @param {string} req.body.owner_user_id - Required. Owner user ID.
     * @param {string} req.body.media_type - Required. Type: 'image', 'video', 'audio', 'file', 'gallery'.
     * @param {string} req.body.title - Required. Media title.
     * @param {string} [req.body.description] - Media description.
     * @param {string} [req.body.visibility] - Visibility: 'public', 'subscribers', 'purchasers', 'private', 'unlisted'.
     * @param {boolean} [req.body.featured] - Featured flag.
     * @param {boolean} [req.body.coming_soon] - Coming soon flag.
     * @param {string} [req.body.asset_url] - Asset URL.
     * @param {number} [req.body.file_size_bytes] - File size in bytes.
     * @param {string[]} [req.body.tags] - Array of tags.
     * @param {string[]} [req.body.coperformers] - Array of co-performer IDs.
     * @param {boolean} [req.body.placeholder_lock] - Placeholder lock.
     * @param {boolean} [req.body.blurred_lock] - Blurred lock.
     * @param {number} [req.body.blurred_value_px] - Blurred value in pixels.
     * @param {boolean} [req.body.trailer_blurred_lock] - Trailer blurred lock.
     * @param {number} [req.body.trailer_blurred_value_px] - Trailer blurred value in pixels.
     * @param {string} req.headers['x-actor-user-id'] - Actor user ID from headers.
     */
    async createMediaItem(req, res) {
        try {
            const payload = req.body;
            const actorUserId = req.headers['x-actor-user-id'];

            if (!actorUserId) {
                return res.status(400).json({ error: 'x-actor-user-id header is required' });
            }

            const result = await mediaHandler.handleAddMediaItem({ payload, actorUserId });

            res.status(201).json({
                success: true,
                media: result
            });
        } catch (error) {
            console.error('Error creating media item:', error);
            res.status(500).json({ error: 'Failed to create media item', message: error.message });
        }
    },

    /**
     * Get a list of media items.
     *
     * @param {number} [req.query.limit=10] - Number of items to return.
     * @param {number} [req.query.offset=0] - Number of items to skip.
     * @param {string} [req.query.owner_user_id] - Filter by owner.
     * @param {string} [req.query.media_type] - Filter by type.
     * @param {string} [req.query.visibility] - Filter by visibility.
     */
    async fetchMediaItems(req, res) {
        try {
            console.log('Fetch media items with query:', req.query);
            const limit = parseInt(req.query.limit) || 10;
            const offset = parseInt(req.query.offset) || 0;
            
            // Extract filters based on specification
            const filters = {};
            if (req.query.q) filters.q = req.query.q;
            if (req.query.title) filters.title = req.query.title;
            if (req.query.media_id) filters.media_id = req.query.media_id;
            if (req.query.id) filters.id = parseInt(req.query.id);
            if (req.query.media_type) filters.media_type = req.query.media_type;
            if (req.query.status) filters.status = req.query.status;
            if (req.query.visibility) filters.visibility = req.query.visibility;
            if (req.query.owner_user_id) filters.owner_user_id = req.query.owner_user_id;
            if (req.query.featured !== undefined) filters.featured = req.query.featured === 'true' || req.query.featured === true;
            if (req.query.coming_soon !== undefined) filters.coming_soon = req.query.coming_soon === 'true' || req.query.coming_soon === true;
            if (req.query.created_from) filters.created_from = req.query.created_from;
            if (req.query.created_to) filters.created_to = req.query.created_to;
            if (req.query.file_size_min) filters.file_size_min = parseFloat(req.query.file_size_min);
            if (req.query.file_size_max) filters.file_size_max = parseFloat(req.query.file_size_max);

            const payload = {
                limit,
                offset,
                q: req.query.q,
                sort_by: req.query.sort_by,
                filters
            };

            // Only include sort_order if provided
            if (req.query.sort_order) {
                payload.sort_order = req.query.sort_order;
            }

            let result;
            if (req.query.owner_user_id && !req.query.q) {
                // Use listByOwner for owner-specific lists if no global search
                result = await mediaHandler.listByOwner({
                    owner_user_id: req.query.owner_user_id,
                    ...payload
                });
            } else {
                // Use listAll for general lists or when searching globally
                result = await mediaHandler.listAll(payload);
            }

            res.json({
                items: result.items,
                count: result.items.length,
                totalCount: result.totalCount, // Per-page count or total if available
                limit,
                offset,
                nextCursor: result.nextCursor
            });
        } catch (error) {
            console.error('Error fetching media items:', error);
            res.status(500).json({ error: 'Failed to fetch media items', message: error.message });
        }
    },

    /**
     * Get a single media item by ID.
     *
     * @param {string} req.params.mediaId - The media ID.
     */
    async fetchMediaItemById(req, res) {
        try {
            const { mediaId } = req.params;

            const item = await mediaHandler.getById({ media_id: mediaId });

            if (!item) {
                return res.status(404).json({ error: 'Media item not found' });
            }

            res.json({
                success: true,
                item
            });
        } catch (error) {
            console.error('Error fetching media item:', error);
            res.status(500).json({ error: 'Failed to fetch media item', message: error.message });
        }
    },

    /**
     * Update a media item.
     *
     * @param {string} req.params.mediaId - The media ID.
     * @param {object} req.body - Fields to update.
     * @param {string} req.headers['x-actor-user-id'] - Actor user ID.
     */
    async updateMediaItem(req, res) {
        try {
            const { mediaId } = req.params;
            const updates = req.body;
            const actorUserId = req.headers['x-actor-user-id'];

            if (!actorUserId) {
                return res.status(400).json({ error: 'x-actor-user-id header is required' });
            }

            const payload = { media_id: mediaId, ...updates, actorUserId };
            const result = await mediaHandler.handleUpdateMediaItem(payload);

            if (!result) {
                return res.status(404).json({ error: 'Media item not found' });
            }

            res.json({ success: true, message: 'Media item updated successfully', item: result });
        } catch (error) {
            console.error('Error updating media item:', error);
            res.status(500).json({ error: 'Failed to update media item', message: error.message });
        }
    },

    /**
     * Schedule a media item for publication.
     *
     * @param {string} req.params.mediaId - The media ID.
     * @param {object} req.body - Schedule data.
     * @param {string} req.body.publish_at - ISO date string for publish time.
     * @param {string} req.headers['x-actor-user-id'] - Actor user ID.
     */
    async scheduleMediaItem(req, res) {
        try {
            const { mediaId } = req.params;
            const { publish_date, expectedVersion } = req.body;
            const actorUserId = req.headers['x-actor-user-id'];

            if (!actorUserId) {
                return res.status(400).json({ error: 'x-actor-user-id header is required' });
            }

            const payload = { media_id: mediaId, publish_date, expectedVersion, actorUserId };
            const result = await mediaHandler.handleScheduleMediaItem(payload);

            res.json({ success: true, message: 'Media item scheduled successfully', item: result });
        } catch (error) {
            console.error('Error scheduling media item:', error);
            res.status(500).json({ error: 'Failed to schedule media item', message: error.message });
        }
    },

    /**
     * Publish a media item immediately.
     *
     * @param {string} req.params.mediaId - The media ID.
     * @param {string} req.headers['x-actor-user-id'] - Actor user ID.
     */
    async publishMediaItem(req, res) {
        try {
            const { mediaId } = req.params;
            const { expectedVersion } = req.body;
            const actorUserId = req.headers['x-actor-user-id'];

            if (!actorUserId) {
                return res.status(400).json({ error: 'x-actor-user-id header is required' });
            }

            const payload = { media_id: mediaId, expectedVersion, actorUserId };
            const result = await mediaHandler.handlePublishMediaItem(payload);

            res.json({ success: true, message: 'Media item published successfully', item: result });
        } catch (error) {
            console.error('Error publishing media item:', error);
            res.status(500).json({ error: 'Failed to publish media item', message: error.message });
        }
    },

    /**
     * Soft delete a media item.
     *
     * @param {string} req.params.mediaId - The media ID.
     * @param {string} req.headers['x-actor-user-id'] - Actor user ID.
     */
    async deleteMediaItem(req, res) {
        try {
            const { mediaId } = req.params;
            const actorUserId = req.headers['x-actor-user-id'];

            if (!actorUserId) {
                return res.status(400).json({ error: 'x-actor-user-id header is required' });
            }

            const payload = { media_id: mediaId, actorUserId };
            const result = await mediaHandler.softDelete(payload);

            if (!result) {
                return res.status(404).json({ error: 'Media item not found' });
            }

            res.json({ success: true, message: 'Media item deleted successfully' });
        } catch (error) {
            console.error('Error deleting media item:', error);
            res.status(500).json({ error: 'Failed to delete media item', message: error.message });
        }
    },

    /**
     * Add a note to a media item.
     *
     * @param {string} req.params.mediaId - The media ID.
     * @param {object} req.body - Note data.
     * @param {string} req.body.note - Required. The note text.
     * @param {string} req.body.addedBy - Required. User ID who added the note.
     * @param {boolean} [req.body.isPublic=false] - Whether the note is public.
     * @param {number} req.body.expectedVersion - Required. Current version for optimistic locking.
     * @param {string} req.body.actorUserId - Actor user ID from headers.
     */
    async addNote(req, res) {
        try {
            const { mediaId } = req.params;
            const { note, addedBy, isPublic, expectedVersion, actorUserId } = req.body;

            if (!actorUserId) {
                return res.status(400).json({ error: 'actorUserId is required' });
            }

            if (!note || !addedBy || expectedVersion == null) {
                return res.status(400).json({
                    error: 'Missing required fields',
                    required: ['note', 'addedBy', 'expectedVersion']
                });
            }

            const payload = {
                media_id: mediaId,
                note,
                addedBy,
                isPublic: isPublic || false,
                expectedVersion,
                actorUserId
            };

            const result = await mediaHandler.addNote(payload);

            res.json({
                success: true,
                message: 'Note added successfully',
                media_id: result.media_id,
                version: result.version,
                notesCount: result.notesCount
            });
        } catch (error) {
            console.error('Error adding note to media item:', error);
            res.status(500).json({ error: 'Failed to add note', message: error.message });
        }
    }
};
// ============================================
// ROUTES
// ============================================
router.post('/media/createMediaItem', MediaController.createMediaItem);
router.get('/media/fetchMediaItems', MediaController.fetchMediaItems);
router.get('/media/fetchMediaItemById/:mediaId', MediaController.fetchMediaItemById);
router.put('/media/updateMediaItem/:mediaId', MediaController.updateMediaItem);
router.post('/media/scheduleMediaItem/:mediaId', MediaController.scheduleMediaItem);
router.post('/media/publishMediaItem/:mediaId', MediaController.publishMediaItem);
router.delete('/media/deleteMediaItem/:mediaId', MediaController.deleteMediaItem);
router.post('/media/addNote/:mediaId', MediaController.addNote);

// ============================================
// INIT SERVICE
// ============================================
const initMediaService = async () => {
    try {
        // Ensure DB connection
        await db.ensureConnected('default');
        console.log('✅ Postgres connected for Media service');
    } catch (error) {
        console.error('❌ Failed to initialize Media service:', error);
        throw error;
    }
};

module.exports = { router, initMediaService };
