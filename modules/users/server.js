const express = require('express');
const dotenv = require('dotenv');
const Users = require('./src/services/Users.js');
const { db } = require('./src/utils/index.js');

dotenv.config();

const router = express.Router();

// Helper: convert camelCase keys to snake_case in outgoing responses (strict - replaces keys)
const camelToSnake = (s) => s.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
function convertToSnake(obj) {
    if (obj == null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(convertToSnake);
    const out = {};
    for (const [key, val] of Object.entries(obj)) {
        const snake = camelToSnake(key);
        out[snake] = convertToSnake(val);
    }
    return out;
}

// Backwards-compatible helper (preserves original keys) - kept for reference but avoid using it
function addSnakeCase(obj) {
    if (obj == null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(addSnakeCase);
    const out = { ...obj };
    for (const key of Object.keys(obj)) {
        const val = obj[key];
        const snake = camelToSnake(key);
        if (snake !== key && out[snake] === undefined) {
            out[snake] = val;
        }
        if (val && typeof val === 'object') {
            out[key] = addSnakeCase(val);
            if (snake !== key && out[snake] === undefined) out[snake] = out[key];
        }
    }
    return out;
}

// ============================================
// CONTROLLERS
// ============================================
const UserController = {
    /**
     * Create a new user.
     * 
     * @param {object} req.body - The user data.
     * @param {string} req.body.userName - Required. Unique user_name.
     * @param {string} [req.body.displayName] - Display name.
     * @param {string} [req.body.avatarUrl] - URL to avatar image.
     * @param {string} [req.body.role] - User role (default: 'user').
     * @param {boolean} [req.body.isNewUser] - Flag for new user (default: true).
     * @param {object} [req.body.user_settings] - User settings object.
     * @param {string} [req.body.user_settings.locale] - Locale code (e.g., 'en-US').
     * @param {object} [req.body.user_settings.notifications] - Notification preferences.
     * @param {boolean} [req.body.user_settings.callVideoMessage] - Video message preference.
     * @param {string} [req.body.user_settings.presencePreference] - Presence preference.
     * @param {object} [req.body.user_profile] - User profile object.
     * @param {string} [req.body.user_profile.bio] - User biography.
     * @param {string} [req.body.user_profile.gender] - Gender.
     * @param {number} [req.body.user_profile.age] - Age.
     * @param {string} [req.body.user_profile.bodyType] - Body type.
     * @param {string} [req.body.user_profile.hairColor] - Hair color.
     * @param {string} [req.body.user_profile.country] - Country.
     * @param {string} [req.body.user_profile.coverImage] - Cover image URL.
     * @param {string[]} [req.body.user_profile.backgroundImages] - Array of background image URLs.
     * @param {string[]} [req.body.user_profile.socialUrls] - Array of social media URLs.
     * @param {string[]} [req.body.user_profile.additionalUrls] - Array of additional URLs.
     */
    async createUser(req, res) {
        try {
            if (!req.body || typeof req.body !== 'object') {
                return res.status(400).json({ error: 'Request body must be a valid object' });
            }

            const { userName, user_profile, user_settings, ...rest } = req.body;

            if (!userName) {
                return res.status(400).json({ error: 'userName is required' });
            }

            // Flatten nested objects to match service expectation
            const userData = {
                user_name: userName,
                ...rest,
                ...(user_profile || {}),
                ...(user_settings || {})
            };

            const newUser = await Users.createUser(userData);

            res.status(201).json({
                success: true,
                user: convertToSnake(newUser)
            });
        } catch (error) {
            console.error('Error creating user:', error);
            if (error.message === 'USERNAME_TAKEN') {
                return res.status(409).json({ error: 'Username already taken' });
            }
            res.status(500).json({ error: 'Failed to create user', message: error.message });
        }
    },

    /**
     * Get a list of users.
     *
     * @param {string} [req.query.q] - Search query for user_name or display name
     * @param {string} [req.query.role] - Filter by role
     * @param {string} [req.query.country] - Filter by country
     * @param {string} [req.query.created_from] - Filter users created from date (ISO string)
     * @param {string} [req.query.created_to] - Filter users created to date (ISO string)
     * @param {number} [req.query.limit=10] - Number of users to return.
     * @param {number} [req.query.offset=0] - Number of users to skip.
     */
    async getUsers(req, res) {
        try {
            const limit = parseInt(req.query.limit) || 10;
            const offset = parseInt(req.query.offset) || 0;

            const filters = {
                q: req.query.q,
                uid: req.query.uid,
                public_uid: req.query.public_uid,
                user_name: req.query.user_name,
                display_name: req.query.display_name,
                email: req.query.email,
                phone_number: req.query.phone_number,
                role: req.query.role,
                status: req.query.status,
                country: req.query.country,
                last_activity_from: req.query.last_activity_from,
                last_activity_to: req.query.last_activity_to,
                created_from: req.query.created_from,
                created_to: req.query.created_to,
            };

            console.log('[UserController.getUsers] Filters:', filters, 'limit:', limit, 'offset:', offset);

            const { users, count, totalCount } = await Users.getUsersList(filters, limit, offset);

            // Convert response objects to strict snake_case keys
            const usersOut = users.map((u) => convertToSnake(u));

            res.json({
                users: usersOut,
                count,
                totalCount,
                limit,
                offset
            });
        } catch (error) {
            console.error('Error listing users:', error);
            res.status(500).json({ error: 'Failed to list users', message: error.message });
        }
    },

    /**
     * Get a single user by ID.
     * 
     * @param {string} req.params.userId - The user ID (uid).
     */
    async getUser(req, res) {
        try {
            const { userId } = req.params;
            
            // Use the Users service to build the profile which aggregates data
            const userProfile = await Users.buildUserProfile(userId);

            if (!userProfile) {
                return res.status(404).json({ error: 'User not found' });
            }

            // Get online status
            const presence = await Users.getOnlineStatus(userId);

            res.json({
                success: true,
                user: convertToSnake({
                    ...userProfile,
                    online: presence.online,
                    status: presence.status
                })
            });
        } catch (error) {
            console.error('Error fetching user:', error);
            res.status(500).json({ error: 'Failed to fetch user', message: error.message });
        }
    },

    /**
     * Update a user (comprehensive update).
     * Supports updating core user fields, settings, and profile in one request.
     * 
     * @param {string} req.params.userId - The user ID.
     * @param {object} req.body - Fields to update.
     * @param {string} [req.body.displayName]
     * @param {string} [req.body.avatarUrl]
     * @param {string} [req.body.role]
     * @param {boolean} [req.body.isNewUser]
     * @param {object} [req.body.user_settings] - Nested settings object (optional).
     * @param {object} [req.body.user_profile] - Nested profile object (optional).
     * @description Can accept flat fields or nested `user_settings`/`user_profile` objects.
     */
    async updateUser(req, res) {
        try {
            const { userId } = req.params;

            if (!req.body || typeof req.body !== 'object') {
                console.log('Invalid request body:', req.body);
                return res.status(400).json({ error: 'Request body must be a valid object' });
            }

            // Pass the entire body as updates, filtering is done in the service
            const updatedUser = await Users.updateUser(userId, req.body);

            if (!updatedUser) {
                return res.status(404).json({ error: 'User not found' });
            }

            res.json({ success: true, message: 'User updated successfully', user: convertToSnake(updatedUser) });
        } catch (error) {
            console.error('Error updating user:', error);
            res.status(500).json({ error: 'Failed to update user', message: error.message });
        }
    },

    /**
     * Update user settings only.
     * 
     * @param {string} req.params.userId - The user ID.
     * @param {object} req.body - Settings fields.
     * @param {string} [req.body.locale]
     * @param {object} [req.body.notifications]
     * @param {boolean} [req.body.callVideoMessage]
     * @param {string} [req.body.presencePreference]
     */
    async updateUserSettings(req, res) {
        try {
            const { userId } = req.params;

            if (!req.body || typeof req.body !== 'object') {
                return res.status(400).json({ error: 'Request body must be a valid object' });
            }

            const { locale, notifications, callVideoMessage, presencePreference } = req.body;

            const updatedUser = await Users.updateUserSettings(userId, req.body);

            if (!updatedUser) {
                return res.status(404).json({ error: 'User not found' });
            }

            res.json({ success: true, message: 'User settings updated successfully', user: convertToSnake(updatedUser) });
        } catch (error) {
            console.error('Error updating user settings:', error);
            res.status(500).json({ error: 'Failed to update user settings', message: error.message });
        }
    },

    /**
     * Update user profile only.
     * 
     * @param {string} req.params.userId - The user ID.
     * @param {object} req.body - Profile fields.
     * @param {string} [req.body.bio]
     * @param {string} [req.body.gender]
     * @param {number} [req.body.age]
     * @param {string} [req.body.bodyType]
     * @param {string} [req.body.hairColor]
     * @param {string} [req.body.country]
     * @param {string} [req.body.coverImage]
     * @param {string[]} [req.body.backgroundImages]
     * @param {string[]} [req.body.socialUrls]
     * @param {string[]} [req.body.additionalUrls]
     */
    async updateUserProfile(req, res) {
        try {
            const { userId } = req.params;

            if (!req.body || typeof req.body !== 'object') {
                return res.status(400).json({ error: 'Request body must be a valid object' });
            }

            const updatedUser = await Users.updateUserProfile(userId, req.body);

            if (!updatedUser) {
                return res.status(404).json({ error: 'User not found' });
            }

            res.json({ success: true, message: 'User profile updated successfully', user: convertToSnake(updatedUser) });
        } catch (error) {
            console.error('Error updating user profile:', error);
            res.status(500).json({ error: 'Failed to update user profile', message: error.message });
        }
    },

    // Delete a user
    async deleteUser(req, res) {
        try {
            const { userId } = req.params;

            const deleted = await Users.deleteUser(userId);

            if (!deleted) {
                return res.status(404).json({ error: 'User not found' });
            }
            
            res.json({ success: true, message: 'User deleted successfully' });
        } catch (error) {
            console.error('Error deleting user:', error);
            res.status(500).json({ error: 'Failed to delete user', message: error.message });
        }
    }
};

// ============================================
// ROUTES
// ============================================
router.post('/users/createUser', UserController.createUser);
router.get('/users/fetchUsers', UserController.getUsers);
router.get('/users/fetchUserById/:userId', UserController.getUser);
router.put('/users/updateUser/:userId', UserController.updateUser);
router.put('/users/updateUserSettings/:userId', UserController.updateUserSettings);
router.put('/users/updateUserProfile/:userId', UserController.updateUserProfile);
router.delete('/users/deleteUser/:userId', UserController.deleteUser);

// ============================================
// INIT SERVICE
// ============================================
const initUsersService = async () => {
    try {
        // Ensure DB connection
        await db.ensureConnected('default');
        console.log('✅ Postgres connected for Users service');
    } catch (error) {
        console.error('❌ Failed to initialize Users service:', error);
        throw error;
    }
};

module.exports = { router, initUsersService };