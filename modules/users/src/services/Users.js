const { db, ErrorHandler, Logger, SafeUtils, DateTime } = require("../utils/index.js");
const { randomBytes } = require("crypto");
const { boolean } = require("joi");
const { LRUCache: LRU } = require('lru-cache');

class Users {
    static ROLES = Object.freeze([
        { value: "creator", label: "Creator" },
        { value: "vendor", label: "Vendor" },
        { value: "agent", label: "Agent" },
        { value: "fan", label: "Fan" }
    ]);

    static ERROR_CODES = Object.freeze({
        GET_CUD_FAILED: "GET_CUD_FAILED",
        GET_BATCH_CUD_FAILED: "GET_BATCH_CUD_FAILED",
        GET_PRESENCE_FAILED: "GET_PRESENCE_FAILED",
        GET_BATCH_PRESENCE_FAILED: "GET_BATCH_PRESENCE_FAILED",
        SET_PRESENCE_OVERRIDE_FAILED: "SET_PRESENCE_OVERRIDE_FAILED",
        CHECK_USERNAME_TAKEN_FAILED: "CHECK_USERNAME_TAKEN_FAILED",
        SET_USERNAME_FAILED: "SET_USERNAME_FAILED",
        GET_USER_FIELD_FAILED: "GET_USER_FIELD_FAILED",
        UPDATE_USER_FIELD_FAILED: "UPDATE_USER_FIELD_FAILED",
        BUILD_USER_DATA_FAILED: "BUILD_USER_DATA_FAILED",
        BUILD_USER_SETTINGS_FAILED: "BUILD_USER_SETTINGS_FAILED",
        BUILD_USER_PROFILE_FAILED: "BUILD_USER_PROFILE_FAILED",
        CREATE_USER_FAILED: "CREATE_USER_FAILED",
        UPDATE_USER_SETTINGS_FAILED: "UPDATE_USER_SETTINGS_FAILED",
        UPDATE_USER_PROFILE_FAILED: "UPDATE_USER_PROFILE_FAILED",
        UPDATE_USER_FAILED: "UPDATE_USER_FAILED",
        DELETE_USER_FAILED: "DELETE_USER_FAILED",
    });
    static PRESENCE_MODE = Object.freeze({
        REAL: "real",
        AWAY: "away",
        OFFLINE: "offline",
    });

    static USERNAME_POLICY = Object.freeze({
        MIN_LEN: 3,
        MAX_LEN: 30,
        REGEX: /^[a-zA-Z0-9._-]{3,30}$/,
    });

    static PRESENCE_UPDATE_THROTTLE = 60; // seconds
    static MAX_BATCH_SIZE = 200;
    static DEFAULT_LOCALE = "en";
    static LOGGER_FLAG_USERS = "users";

    /**
     * ================================
     *  HELPER FUNCTIONS (INTERNAL)
     * ================================
     */

    /**
     * Normalize user_name to lowercase, trimmed.
     * @param {string} user_name
     */
    static normalizeUsername(user_name) {
        return (user_name ?? "").toString().trim().toLowerCase();
    }

    /**
     * Validate user_name format against policy.
     * @param {string} user_name
     * @returns {boolean}
     */
    static isUsernameFormatValid(user_name) {
        const u = this.normalizeUsername(user_name);

        if (
            u.length < this.USERNAME_POLICY.MIN_LEN ||
            u.length > this.USERNAME_POLICY.MAX_LEN
        )
            return false;

        return this.USERNAME_POLICY.REGEX.test(u);
    }

    /**
     * Compute initials from a display name.
     * @param {string} displayName
     * @returns {string}
     */
    static initialsFromDisplayName(displayName) {
        // Use regex-based split for clearer intent and performance
        const parts = ((displayName ?? "").trim().match(/\S+/g) || []).slice(
            0,
            2,
        );
        return parts.map((p) => (p[0] || "").toUpperCase()).join("");
    }

    // Example: SafeUtils.sanitizeValidate({ uid: 'required|string|trim' }, data)
    // We will assume SafeUtils.sanitizeValidate returns sanitized data or throws.

    /**
     * ----------------------------------------
     *  CRITICAL USER DATA (CUD)
     *  ----------------------------------------
     */

    /**
     * Return critical user data.
     * Hydrates from Postgres on miss (user_name/displayName/avatar) and merges live presence.
     *
     * @param {string} userId
     * @returns {Promise<{
     *      user_name: string,
     *      displayName: string,
     *      avatar: string,
     *      online: boolean,
     *      status: 'online'|'offline'|'away' }|null>}
     */
    static #cudCache = new LRU({ max: 500, ttl: 1000 * 10 }); // 10 seconds TTL

    static async getCriticalUserData(userId) {
        Logger.debugLog &&
            Logger.debugLog(
                `[Users] [getCriticalUserData] [START] Payload received: ${JSON.stringify({ userId })}`,
            );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: {
                    value: userId,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "getCriticalUserData",
                payload: { userId },
            });
            return {
                status: false,
                data: null,
                error: err.message || "UNKNOWN_ERROR",
            };
        }
        const { uid: validatedUserId } = cleaned;

        const cached = this.#cudCache.get(userId);
        if (cached) {
            Logger.debugLog &&
                Logger.debugLog(
                    `[Users] [getCriticalUserData] [CACHE] Hit for uid: ${userId}`,
                );
            return cached;
        }

        try {
            Logger.debugLog &&
                Logger.debugLog(
                    `[Users] [getCriticalUserData] [PRESENCE] Fetching presence for uid: ${validatedUserId}`,
                );
            const presence = await this.getOnlineStatus(validatedUserId);

            Logger.debugLog &&
                Logger.debugLog(
                    `[Users] [getCriticalUserData] [DB_QUERY] Fetching user data for uid: ${validatedUserId}`,
                );
            const userRow = await db.query(
                "default",
                "SELECT username_lower AS user_name, display_name AS display_name, avatar_url AS avatar FROM users WHERE uid = $1 LIMIT 1",
                [validatedUserId],
            );

            const record = userRow?.rows?.[0];

            if (!record) {
                Logger.debugLog &&
                    Logger.debugLog(
                        `[Users] [getCriticalUserData] [MISS] No record found for uid: ${validatedUserId}`,
                    );
                return { success: false, data: null, error: "User not found" };
            }

            const hydrated = {
                user_name: record.user_name || "",
                displayName: record.display_name || "",
                email: record.email || "",
                avatar: record.avatar || "",
                online: presence?.online,
                status: presence?.status,
                last_activity_at: record.last_activity_at || null,
            };

            this.#cudCache.set(userId, {
                success: true,
                data: hydrated,
                error: null,
            });

            Logger.debugLog &&
                Logger.debugLog(
                    `[Users] [getCriticalUserData] [SUCCESS] Hydrated data: ${JSON.stringify(hydrated)}`,
                );
            return { success: true, data: hydrated, error: null };
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "GET_CUD_FAILED",
                origin: "Users.getCriticalUserData",
                data: { uid: userId },
            });
            return {
                success: false,
                data: null,
                error: err.message || "UNKNOWN_ERROR",
            };
        }
    }

    /**
     * Batched critical user data by UIDs (order-preserving).
     * @param {string[]} userIds
     * @returns {Promise<Array<object>>}
     */
    static async getCriticalUsersData(userIds = []) {
        Logger.debugLog?.(
            `[Users] [getCriticalUsersData] [START] Payload received: ${JSON.stringify({ userIds })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uids: {
                    value: userIds,
                    type: "array",
                    required: true,
                    min: 1,
                    max: 200,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "getCriticalUsersData",
                payload: { userIds },
            });
            return { success: false, data: [], error: err.message };
        }
        const { uids: validatedUserIds } = cleaned;

        if (validatedUserIds.length > Users.MAX_BATCH_SIZE) {
            Logger.writeLog &&
                Logger.writeLog({
                    flag: "TESTS",
                    action: "getCriticalUsersData_limit_exceeded",
                    data: { count: validatedUserIds.length },
                });
            ErrorHandler.addError("Too many user IDs provided", {
                method: "getCriticalUsersData",
                count: validatedUserIds.length,
            });
            return { success: false, data: [], error: "Too many user IDs provided" };
        }

        // Remove redundant manual array length check, rely on SafeUtils.sanitizeValidate max constraint

        try {
            const misses = [...validatedUserIds];
            Logger.debugLog?.(
                `[Users] [getCriticalUsersData] [BATCH_FETCH] Fetching data for ${misses.length} users`,
            );
            // Batch fetch from DB
            const userRows = await db.query(
                "default",
                `SELECT uid, username_lower AS user_name,  email, last_activity_at , display_name, avatar_url FROM users WHERE uid = ANY($1)`,
                [misses],
            );
            const userMap = new Map(
                (userRows?.rows || []).map((row) => [row.uid, row]),
            );
            // Batch fetch presence (stub: offline)
            const presenceMap = new Map(
                misses.map((uid) => [
                    uid,
                    { online: false, status: "offline" },
                ]),
            );
            const results = misses.map((uid) => {
                const record = userMap.get(uid);
                if (record) {
                    return {
                        uid,
                        user_name: record.user_name || "",
                        displayName: record.display_name || "",
                        email: record.email || "",
                        avatar: record.avatar_url || "",
                        online: presenceMap.get(uid)?.online,
                        status: presenceMap.get(uid)?.status,
                        last_activity_at: record.last_activity_at || null,
                    };
                } else {
                    return {
                        uid,
                        user_name: "",
                        displayName: "",
                        email: "",
                        avatar: "",
                        online: false,
                        status: "offline",
                    };
                }
            });
            Logger.debugLog?.(
                `[Users] [getCriticalUsersData] [SUCCESS] Returned ${results.length} user data objects`,
            );
            return { success: true, data: results, error: null };
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "GET_BATCH_CUD_FAILED",
                origin: "Users.getCriticalUsersData",
                data: { uids: userIds },
            });
            return {
                success: false,
                data: [],
                error: err.message || "UNKNOWN_ERROR",
            };
        }
    }

    /**
     * ----------------------------------------
     *  PRESENCE
     * ----------------------------------------
     */

    /**
     * Resolve current presence for a user.
     * Rule: presenceOverride (offline/away/real) → then presence summary.
     * @param {string} uid
     * @returns {Promise<{online:boolean, status:'online'|'offline'|'away'}>}
     */
    static async getOnlineStatus(uid) {
        Logger.debugLog?.(
            `[Users] [getOnlineStatus] [START] Payload received: ${JSON.stringify({ uid })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: { value: uid, type: "string", required: true, trim: true },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "getOnlineStatus",
                payload: { uid },
            });
            return { online: false, status: "offline" };
        }
        const { uid: validatedUid } = cleaned;

        try {
            // Chance-based presence for now (later Redis)
            const rand = Math.random();
            let online, status;
            if (rand < 0.2) {
                online = true;
                status = 'online';
            } else if (rand < 0.4) {
                online = true;
                status = 'away';
            } else {
                online = false;
                status = 'offline';
            }
            const result = { online, status };
            Logger.debugLog?.(
                `[Users] [getOnlineStatus] [SUCCESS] Presence for uid ${validatedUid}: ${JSON.stringify(result)}`,
            );
            return result;
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "GET_PRESENCE_FAILED",
                origin: "Users.getOnlineStatus",
                data: { uid },
            });
            return { online: false, status: "offline" };
        }
    }

    /**
     * Batch presence for multiple users (20–50 typical).
     * @param {string[]} userIds
     * @returns {Promise<Array<{uid:string, online:boolean, status:string}>>}
     */
    static async getBatchOnlineStatus(userIds = []) {
        Logger.debugLog?.(
            `[Users] [getBatchOnlineStatus] [START] Payload received: ${JSON.stringify({ userIds })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uids: {
                    value: userIds,
                    type: "array",
                    required: true,
                    min: 1,
                    max: 500,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "getBatchOnlineStatus",
                payload: { userIds },
            });
            return { success: false, data: [], error: err.message };
        }
        const { uids: validatedIds } = cleaned;

        try {
            // Chance-based presence for now (later Redis)
            const results = validatedIds.map((uid) => {
                const rand = Math.random();
                let online, status;
                if (rand < 0.2) {
                    online = true;
                    status = 'online';
                } else if (rand < 0.4) {
                    online = true;
                    status = 'away';
                } else {
                    online = false;
                    status = 'offline';
                }
                return {
                    uid,
                    online,
                    status,
                };
            });
            Logger.debugLog?.(
                `[Users] [getBatchOnlineStatus] [SUCCESS] Returned presence for ${results.length} users`,
            );
            return { success: true, data: results, error: null };
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "GET_BATCH_PRESENCE_FAILED",
                origin: "Users.getBatchOnlineStatus",
                data: { uids: userIds },
            });
            return { success: false, data: [], error: err.message };
        }
    }

    /**
     * Server-side socket hook: refresh presence summary TTL, optionally bump durable lastActivityAt.
     * (No frontend code here — this is called by your socket server.)
     * @param {string} userId
     * @param {string} connectionId
     * @returns {Promise<void>}
     */
    static async updatePresenceFromSocket(userId, connectionId) {
        Logger.debugLog?.(
            `[Users] [updatePresenceFromSocket] [START] Payload received: ${JSON.stringify({ userId, connectionId })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: {
                    value: userId,
                    type: "string",
                    required: true,
                    trim: true,
                },
                connId: {
                    value: connectionId,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "updatePresenceFromSocket",
                payload: { userId, connectionId },
            });
            return { success: false, error: err.message || "UNKNOWN_ERROR" };
        }
        const { uid: validatedUserId, connId: validatedConnectionId } = cleaned;

        try {
            Logger.debugLog?.(
                `[Users] [updatePresenceFromSocket] [DB_UPDATE] Updating last activity for uid: ${validatedUserId}`,
            );
            // OPTIONAL: Throttle durable lastActivityAt write in Postgres (e.g., once per 60s)
            // This is purely for analytics/labels.
            await db.query(
                "default",
                `UPDATE users SET last_activity_at = NOW() WHERE uid = $1 AND (last_activity_at IS NULL OR NOW() - last_activity_at > INTERVAL '${Users.PRESENCE_UPDATE_THROTTLE} seconds ')`,
                [validatedUserId],
            );

            Logger.writeLog({
                flag: this.LOGGER_FLAG_USERS,
                action: "updatePresenceFromSocket",
                data: { uid: validatedUserId, connId: validatedConnectionId },
            });

            Logger.debugLog?.(
                `[Users] [updatePresenceFromSocket] [SUCCESS] Presence heartbeat processed for uid: ${validatedUserId}`,
            );
            return { success: true };
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "UPDATE_PRESENCE_FAILED",
                origin: "Users.updatePresenceFromSocket",
                data: { uid: userId, connId: connectionId },
            });
            return { success: false, error: err.message || "UNKNOWN_ERROR" };
        }
    }

    /**
     * Apply presence override, and persist preference durably for rebuild.
     * @param {string} userId
     * @param {'real'|'away'|'offline'} mode
     * @returns {Promise<boolean>}
     */
    static async setPresenceOverride(userId, mode) {
        Logger.debugLog?.(
            `[Users] [setPresenceOverride] [START] Payload received: ${JSON.stringify({ userId, mode })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: {
                    value: userId,
                    type: "string",
                    required: true,
                    trim: true,
                },
                mode: {
                    value: mode,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "setPresenceOverride",
                payload: { userId, mode },
            });
            return { success: false, error: err.message };
        }
        const { uid: validatedUserId, mode: validatedMode } = cleaned;

        try {
            // validate that the mode is one of the allowed values.
            if (!Object.values(this.PRESENCE_MODE).includes(validatedMode)) {
                Logger.debugLog?.(
                    `[Users] [setPresenceOverride] [VALIDATION] Invalid mode: ${validatedMode}`,
                );
                throw new Error("INVALID_PRESENCE_MODE");
            }

            Logger.debugLog?.(
                `[Users] [setPresenceOverride] [DB_UPDATE] Updating presence preference for uid: ${validatedUserId}`,
            );
            const result = await db.query(
                "default",
                "UPDATE user_settings SET presence_preference = $1, updated_at = NOW() WHERE uid = $2 RETURNING *",
                [validatedMode, validatedUserId],
            );

            if (!result?.rows[0]) {
                Logger.debugLog?.(
                    `[Users] [setPresenceOverride] [DB_UPDATE] No rows updated for uid: ${validatedUserId}`,
                );
                throw new Error("PERSISTENCE_FAILED");
            }

            Logger.writeLog({
                flag: this.LOGGER_FLAG_USERS,
                action: "setPresenceOverride",
                data: { uid: validatedUserId, mode: validatedMode },
            });

            Logger.debugLog?.(
                `[Users] [setPresenceOverride] [SUCCESS] Presence override updated for uid: ${validatedUserId}`,
            );
            return { success: true };
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "SET_PRESENCE_OVERRIDE_FAILED",
                origin: "Users.setPresenceOverride",
                data: { uid: userId, mode },
            });
            return { success: false, error: err.message };
        }
    }

    /**

    /**
     * ----------------------------------------
     *  USERNAME
     *  ----------------------------------------
     */

    /**
     * Username availability.
     * @param {string} user_name
     * @returns {Promise<boolean>} true if TAKEN, false if FREE
     */
    static async isUsernameTaken(user_name) {
        Logger.debugLog?.(
            `[Users] [isUsernameTaken] [START] Payload received: ${JSON.stringify({ user_name })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                user_name: {
                    value: user_name,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "isUsernameTaken",
                payload: { user_name },
            });
            return { success: false, error: err.message || "UNKNOWN_ERROR" };
        }
        const { user_name: validatedUsername } = cleaned;

        try {
            if (!this.isUsernameFormatValid(validatedUsername)) {
                Logger.debugLog?.(
                    `[Users] [isUsernameTaken] [VALIDATION] Invalid format for user_name: ${validatedUsername}`,
                );
                return true; // invalid format treated as not available
            }

            Logger.debugLog?.(
                `[Users] [isUsernameTaken] [DB_CHECK] Checking availability for user_name: ${validatedUsername}`,
            );
            // Fallback to DB check
            const res = await db.query(
                "default",
                "SELECT 1 FROM users WHERE username_lower = $1",
                [this.normalizeUsername(validatedUsername)],
            );
            const isTaken = res.rows.length > 0;
            Logger.debugLog?.(
                `[Users] [isUsernameTaken] [SUCCESS] Username ${validatedUsername} is ${isTaken ? "taken" : "available"}`,
            );
            return isTaken;
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "CHECK_USERNAME_TAKEN_FAILED",
                origin: "Users.isUsernameTaken",
                data: { user_name },
            });
            return { success: false, error: err.message || "UNKNOWN_ERROR" };
        }
    }

    /**
     * Claim or change user_name, then persist durable copy in Postgres for rebuild.
     *      - Enforces format and uniqueness (atomic check).
     *      - Updates CUD and uid→username mirror.
     *
     * @param {string} userId
     * @param {string} user_name
     * @returns {Promise<{ success: boolean, previous?: string }>}
     */
    static async setUsername(userId, user_name) {
        Logger.debugLog?.(
            `[Users] [setUsername] [START] Payload received: ${JSON.stringify({ userId, user_name })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: {
                    value: userId,
                    type: "string",
                    required: true,
                    trim: true,
                },
                user_name: {
                    value: user_name,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "setUsername",
                payload: { userId, user_name },
            });
            return { success: false, error: err.message || "UNKNOWN_ERROR" };
        }
        const { uid: validatedUserId, user_name: rawUsername } = cleaned;

        try {
            const normalizedUsername = this.normalizeUsername(rawUsername);
            if (!this.isUsernameFormatValid(normalizedUsername)) {
                Logger.debugLog?.(
                    `[Users] [setUsername] [VALIDATION] Invalid format for user_name: ${normalizedUsername}`,
                );
                throw new Error("INVALID_USERNAME_FORMAT");
            }

            Logger.debugLog?.(
                `[Users] [setUsername] [DB_CHECK] Checking if user_name ${normalizedUsername} is taken by another user`,
            );
            // Check if user_name is already taken by another user
            const takenRes = await db.query(
                "default",
                "SELECT uid FROM users WHERE username_lower = $1",
                [normalizedUsername],
            );
            if (takenRes.rows.length > 0 && takenRes.rows[0].uid !== validatedUserId) {
                Logger.debugLog?.(
                    `[Users] [setUsername] [VALIDATION] Username ${normalizedUsername} is taken by another user`,
                );
                return { success: false, error: "USERNAME_TAKEN" };
            }

            Logger.debugLog?.(
                `[Users] [setUsername] [DB_UPDATE] Updating user_name for uid: ${validatedUserId} to ${normalizedUsername}`,
            );
            // persist the new user_name in postgres
            await db.query(
                "default",
                "UPDATE users SET username_lower = $1, updated_at = NOW() WHERE uid = $2 RETURNING *",
                [normalizedUsername, validatedUserId],
            );

            // Handle user_name collision with DB-level UNIQUE constraint and error handling
            try {
                await db.query(
                    "default",
                    "UPDATE users SET username_lower = $1, updated_at = NOW() WHERE uid = $2 RETURNING *",
                    [normalizedUsername, validatedUserId],
                );
            } catch (err) {
                if (err.code === "23505") {
                    // PostgreSQL unique violation
                    ErrorHandler.addError("USERNAME_TAKEN", {
                        method: "setUsername",
                        payload: { userId, user_name },
                    });
                    return { success: false, error: "USERNAME_TAKEN" };
                }
                throw err;
            }

            Logger.writeLog({
                flag: this.LOGGER_FLAG_USERS,
                action: "setUsername",
                data: {
                    uid: validatedUserId,
                    user_name: normalizedUsername,
                },
            });

            Logger.debugLog?.(
                `[Users] [setUsername] [SUCCESS] Username updated for uid: ${validatedUserId}`,
            );
            return { success: true, previous: undefined };
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "SET_USERNAME_FAILED",
                origin: "Users.setUsername",
                data: { uid: userId, user_name },
            });
            return { success: false, error: err.message || "UNKNOWN_ERROR" };
        }
    }

    /**
     * ----------------------------------------
     *  POSTGRES DURABLE: DYNAMIC ACCESS
     *  ----------------------------------------
     */

    /**
     * Read a single field from a durable table (PostgreSQL).
     * @param {string} uid
     * @param {string} tableName - e.g., 'users', 'user_profiles', 'user_settings'
     * @param {string} fieldKey  - column name (or JSON path handled by SQL if needed)
     * @returns {Promise<any>}
     */
    static async getUserField(uid, tableName, fieldKey) {
        Logger.debugLog?.(
            `[Users] [getUserField] [START] Payload received: ${JSON.stringify({ uid, tableName, fieldKey })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: { value: uid, type: "string", required: true, trim: true },
                tableName: {
                    value: tableName,
                    type: "string",
                    required: true,
                    trim: true,
                },
                fieldKey: {
                    value: fieldKey,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "getUserField",
                payload: { uid, tableName, fieldKey },
            });
            return { success: false, error: err.message || "UNKNOWN_ERROR" };
        }
        const {
            uid: validatedUid,
            tableName: validatedTable,
            fieldKey: validatedField,
        } = cleaned;

        // Whitelists for table and field names
        const allowedTables = ["users", "user_profiles", "user_settings"];
        const allowedFields = {
            users: [
                "username_lower",
                "display_name",
                "avatar_url",
                "role",
                "email",
                "phone_number",
                "is_new_user",
                "public_uid",
                "last_activity_at",
                "updated_at",
            ],
            user_profiles: [
                "bio",
                "background_images",
                "social_urls",
                "additional_urls",
                "updated_at",
            ],
            user_settings: [
                "presence_preference",
                "locale",
                "notifications",
                "updated_at",
            ],
        };
        if (
            !allowedTables.includes(validatedTable) ||
            !allowedFields[validatedTable]?.includes(validatedField)
        ) {
            ErrorHandler.addError("Invalid table or field name", {
                method: "getUserField",
                payload: { uid, tableName, fieldKey },
            });
            return { success: false, error: "Invalid table or field name" };
        }
        try {
            const sql = `SELECT ${validatedField} AS value FROM ${validatedTable} WHERE uid = $1 LIMIT 1`;
            Logger.debugLog?.(
                `[Users] [getUserField] [DB_QUERY] Executing: ${sql} for uid: ${validatedUid}`,
            );
            const res = await db.query("default", sql, [validatedUid]);

            if (!res?.rows?.[0]) {
                Logger.debugLog?.(
                    `[Users] [getUserField] [MISS] No data found for uid: ${validatedUid} in ${validatedTable}.${validatedField}`,
                );
                throw new Error("GetUserField_FAILED");
            }

            Logger.debugLog?.(
                `[Users] [getUserField] [SUCCESS] Retrieved field for uid: ${validatedUid}`,
            );
            return res?.rows?.[0];
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "GET_USER_FIELD_FAILED",
                origin: "Users.getUserField",
                data: { uid, tableName, fieldKey },
            });
            return { success: false, error: err.message || "UNKNOWN_ERROR" };
        }
    }

    /**
     * Update a single field in a durable table (PostgreSQL).
     * NOTE: Use this for timestamps or any other field (no separate timestamp setter).
     * @param {string} userId
     * @param {string} tableName - e.g., 'users', 'user_profiles', 'user_settings'
     * @param {string} fieldKey  - column name
     * @param {any} value
     * @returns {Promise<boolean>}
     */
    static async updateUserField(userId, tableName, fieldKey, value) {
        Logger.debugLog?.(
            `[Users] [updateUserField] [START] Payload received: ${JSON.stringify({ userId, tableName, fieldKey, value })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: {
                    value: userId,
                    type: "string",
                    required: true,
                    trim: true,
                },
                tableName: {
                    value: tableName,
                    type: "string",
                    required: true,
                    trim: true,
                },
                fieldKey: {
                    value: fieldKey,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "updateUserField",
                payload: { userId, tableName, fieldKey, value },
            });
            return { success: false, error: err.message || "UNKNOWN_ERROR" };
        }
        const {
            uid: validatedUserId,
            tableName: validatedTable,
            fieldKey: validatedField,
        } = cleaned;

        // Whitelists for table and field names
        const allowedTables = ["users", "user_profiles", "user_settings"];
        const allowedFields = {
            users: [
                "username_lower",
                "display_name",
                "avatar_url",
                "role",
                "email",
                "phone_number",
                "is_new_user",
                "public_uid",
                "last_activity_at",
                "updated_at",
            ],
            user_profiles: [
                "bio",
                "background_images",
                "social_urls",
                "additional_urls",
                "updated_at",
            ],
            user_settings: [
                "presence_preference",
                "locale",
                "notifications",
                "updated_at",
            ],
        };
        if (
            !allowedTables.includes(validatedTable) ||
            !allowedFields[validatedTable]?.includes(validatedField)
        ) {
            ErrorHandler.addError("Invalid table or field name", {
                method: "updateUserField",
                payload: { userId, tableName, fieldKey },
            });
            return { success: false, error: "Invalid table or field name" };
        }

        // Standardized NULL/undefined handling:
        // - Explicit null: clears the field (sets to NULL in DB)
        // - Undefined: no update
        // - Empty string: allowed only for string fields
        if (value === undefined) {
            // Do not update if value is undefined
            return { success: false, error: "No value provided for update" };
        }

        const stringFields = [
            "username_lower",
            "display_name",
            "avatar_url",
            "bio",
            "gender",
            "body_type",
            "hair_color",
            "country",
            "cover_image",
            "presence_preference",
            "locale",
        ];
        let dbValue = value;
        if (value === "" && !stringFields.includes(validatedField)) {
            dbValue = null;
        }

        try {
            Logger.debugLog?.(
                `[Users] [updateUserField] [DB_UPDATE] Updating field ${validatedField} in ${validatedTable} for uid: ${validatedUserId}`,
            );
            // Use DateTime utility for current timestamp
            const now = DateTime.now();
            const res = await db.query(
                "default",
                `UPDATE ${validatedTable} SET ${validatedField} = $1, updated_at = $2 WHERE uid = $3`,
                [dbValue, now, validatedUserId],
            );

            Logger.writeLog({
                flag: this.LOGGER_FLAG_USERS,
                action: "updateUserField",
                data: {
                    uid: validatedUserId,
                    tableName: validatedTable,
                    fieldKey: validatedField,
                },
            });

            if (res.rowCount === 0) {
                Logger.debugLog?.(
                    `[Users] [updateUserField] [DB_UPDATE] No rows updated for uid: ${validatedUserId}`,
                );
                throw new Error("UpdateUserField_FAILED:user not found");
            }

            Logger.debugLog?.(
                `[Users] [updateUserField] [SUCCESS] Field updated for uid: ${validatedUserId}`,
            );
            return { success: true };
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "UPDATE_USER_FIELD_FAILED",
                origin: "Users.updateUserField",
                data: { uid: userId, tableName, fieldKey },
            });
            return { success: false, error: err.message || "UNKNOWN_ERROR" };
        }
    }

    /**
     * ----------------------------------------
     *  UI JSON BUILDERS (COMPOSE PG)
     * ----------------------------------------
     */

    /**
     * Build minimal user data JSON for UI (top bar / header, etc.)
     * Fields: displayName, userName, publicUid, avatar, initials, role, isNewUser
     * @param {string} uid
     * @returns {Promise<object|null>}
     */
    static async buildUserData(uid) {
        Logger.debugLog?.(
            `[Users] [buildUserData] [START] Payload received: ${JSON.stringify({ uid })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: { value: uid, type: "string", required: true, trim: true },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "buildUserData",
                payload: { uid },
            });
            return null;
        }
        const { uid: validatedUid } = cleaned;

        try {
            Logger.debugLog?.(
                `[Users] [buildUserData] [CUD_FETCH] Fetching CUD for uid: ${validatedUid}`,
            );
            const cudResult = await this.getCriticalUserData(validatedUid);
            if (!cudResult || !cudResult.success) {
                Logger.debugLog?.(
                    `[Users] [buildUserData] [MISS] No CUD for uid: ${validatedUid}`,
                );
                return null;
            }
            const cud = cudResult.data;

            Logger.debugLog?.(
                `[Users] [buildUserData] [DB_QUERY] Fetching additional data for uid: ${validatedUid}`,
            );
            const row = await db.query(
                "default",
                "SELECT uid, public_uid, user_name_lower AS user_name, role, email, phone_number,last_activity_at, is_new_user FROM users WHERE uid = $1 LIMIT 1",
                [validatedUid],
            );
            const base = row?.rows?.[0] || {};

            // Standardize object spread usage for default value handling
            const out = {
                uid: base.uid || "",
                publicUid: base.public_uid || "",
                userName: base.user_name || "",
                email: base.email || "",
                phoneNumber: base.phone_number || "",
                avatar: cud.avatar || "",
                displayName: cud.displayName || "",
                initials: this.initialsFromDisplayName(cud.displayName || ""),
                role: base.role || "fan",
                lastActivityAt: base.last_activity_at || null,
                // isNewUser intentionally omitted from public response for security
            };

            Logger.debugLog?.(
                `[Users] [buildUserData] [SUCCESS] Built user data for uid: ${validatedUid}`,
            );
            return out;
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "BUILD_USER_DATA_FAILED",
                origin: "Users.buildUserData",
                data: { uid },
            });
            return null;
        }
    }

    /**
     * Build user settings JSON from durable table.
     * Example shape: { localeConfig, notificationsConfig, callVideoMessage? }
     * @param {string} userId
     * @returns {Promise<object>}
     */
    static async buildUserSettings(userId) {
        Logger.debugLog?.(
            `[Users] [buildUserSettings] [START] Payload received: ${JSON.stringify({ userId })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: {
                    value: userId,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "buildUserSettings",
                payload: { userId },
            });
            return {
                localeConfig: null,
                notificationsConfig: null,
                callVideoMessage: null,
                presencePreference: null,
            };
        }
        const { uid: validatedUserId } = cleaned;

        try {
            Logger.debugLog?.(
                `[Users] [buildUserSettings] [DB_QUERY] Fetching settings for uid: ${validatedUserId}`,
            );
            const result = await db.query(
                "default",
                "SELECT locale, notifications, call_video_message, presence_preference FROM user_settings WHERE uid = $1 LIMIT 1",
                [validatedUserId],
            );

            const s = result?.rows?.[0] || {};
            const settings = {
                localeConfig: s.locale ?? null,
                notificationsConfig: s.notifications ?? null,
                callVideoMessage: boolean(s.call_video_message) ?? null,
                presencePreference: s.presence_preference ?? null,
            };
            Logger.debugLog?.(
                `[Users] [buildUserSettings] [SUCCESS] Built settings for uid: ${validatedUserId}`,
            );
            return settings;
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "BUILD_USER_SETTINGS_FAILED",
                origin: "Users.buildUserSettings",
                data: { uid: userId },
            });
            return {
                localeConfig: null,
                notificationsConfig: null,
                callVideoMessage: null,
                presencePreference: null,
            };
        }
    }

    /**
     * Build public profile JSON by merging durable profile + CUD + required public fields.
     * @param {string} userId
     * @returns {Promise<object|null>}
     */
    static async buildUserProfile(userId) {
        Logger.debugLog?.(
            `[Users] [buildUserProfile] [START] Payload received: ${JSON.stringify({ userId })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: {
                    value: userId,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "buildUserProfile",
                payload: { userId },
            });
            return null;
        }
        const { uid: validatedUserId } = cleaned;

        try {
            Logger.debugLog?.(
                `[Users] [buildUserProfile] [CUD_FETCH] Fetching CUD for uid: ${validatedUserId}`,
            );
            const criticalUserData =
                await this.getCriticalUserData(validatedUserId);
            Logger.debugLog?.(
                `[Users] [buildUserProfile] [DB_QUERY] Fetching all profile data for uid: ${validatedUserId}`,
            );
            const joinedResult = await db.query(
                "default",
                `SELECT *,
                        p.bio, p.gender, p.age, p.body_type, p.hair_color, p.country, p.cover_image, p.background_images, p.social_urls, p.additional_urls,
                        s.locale, s.notifications, s.call_video_message, s.presence_preference
                 FROM users u
                 LEFT JOIN user_profiles p ON u.uid = p.uid
                 LEFT JOIN user_settings s ON u.uid = s.uid
                 WHERE u.uid = $1 LIMIT 1`,
                [validatedUserId],
            );
            const row = joinedResult?.rows?.[0] || {};
            if (!criticalUserData) {
                Logger.debugLog?.(
                    `[Users] [buildUserProfile] [MISS] No CUD for uid: ${validatedUserId}`,
                );
                return null;
            }
            const profile = {
                uid: validatedUserId,
                publicUid: row.public_uid || "",
                role: row.role ,
                email: row.email || "",
                phoneNumber: row.phone_number || "",
                lastActivityAt: row.last_activity_at || null,
                displayName:
                    criticalUserData.displayName || row.display_name || "",
                userName: criticalUserData.user_name || row.username_lower || "",
                avatar: criticalUserData.avatar || row.avatar_url || "",
                user_profile: {
                    bio: row.bio || "",
                    gender: row.gender || "",
                    age: row.age ?? null,
                    bodyType: row.body_type || "",
                    hairColor: row.hair_color || "",
                    country: row.country || "",
                    coverImage: row.cover_image || "",
                    backgroundImages: row.background_images || [],
                    socialUrls: row.social_urls || [],
                    additionalUrls: row.additional_urls || [],
                },
                user_settings: {
                    locale: row.locale || "en",
                    notifications: row.notifications || {},
                    callVideoMessage: row.call_video_message ?? false,
                    presencePreference: row.presence_preference || null,
                },
            };
            Logger.debugLog?.(
                `[Users] [buildUserProfile] [SUCCESS] Built profile for uid: ${validatedUserId}`,
            );
            return profile;
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: Users.ERROR_CODES.BUILD_USER_PROFILE_FAILED,
                origin: "Users.buildUserProfile",
                data: { uid: userId },
            });
            return null;
        }
    }

    /**
     * ----------------------------------------
     *  ADMIN / CRUD OPERATIONS
     * ----------------------------------------
     */

    /**
     * Create a new user with default profile and settings.
     * @param {object} params
     * @returns {Promise<object>}
     */
    static async createUser(params) {
        Logger.debugLog?.(
            `[Users] [createUser] [START] Payload received: ${JSON.stringify(params)}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                user_name: {
                    value: params.user_name,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            return { success: false, error: err.message };
        }
        const { user_name: rawUsername } = cleaned;

        // Server-side user_name format validation
        const normalizedUsername = this.normalizeUsername(rawUsername);
        if (!this.isUsernameFormatValid(normalizedUsername)) {
            Logger.debugLog?.(
                `[Users] [createUser] [VALIDATION] Invalid format for user_name: ${normalizedUsername}`,
            );
            return { success: false, error: "INVALID_USERNAME_FORMAT" };
        }

        // Comprehensive schema validation for create/update payloads
        const userSchema = {
            user_name: { type: "string", required: true, trim: true },
            displayName: {
                type: "string",
                required: false,
                trim: true,
                max: 100,
            },
            avatarUrl: {
                type: "string",
                required: false,
                trim: true,
                max: 200,
            },
            role: { type: "string", required: false, trim: true, max: 20 },
            isNewUser: { type: "boolean", required: false },
            locale: { type: "string", required: false, trim: true, max: 10 },
            notifications: { type: "object", required: false },
            callVideoMessage: { type: "boolean", required: false },
            presencePreference: {
                type: "string",
                required: false,
                trim: true,
                max: 20,
            },
            bio: { type: "string", required: false, trim: true, max: 500 },
            gender: { type: "string", required: false, trim: true, max: 20 },
            age: { type: "integer", required: false },
            bodyType: { type: "string", required: false, trim: true, max: 20 },
            hairColor: { type: "string", required: false, trim: true, max: 20 },
            country: { type: "string", required: false, trim: true, max: 30 },
            coverImage: {
                type: "string",
                required: false,
                trim: true,
                max: 200,
            },
            backgroundImages: { type: "array", required: false },
            socialUrls: { type: "array", required: false },
            additionalUrls: { type: "array", required: false },
        };
        const cleanedParams = SafeUtils.sanitizeValidate(userSchema, params);

        try {
            const {
                displayName,
                avatarUrl,
                role,
                isNewUser,
                // user_settings
                locale,
                notifications,
                callVideoMessage,
                presencePreference,
                // user_profiles
                bio,
                gender,
                age,
                bodyType,
                hairColor,
                country,
                coverImage,
                backgroundImages,
                socialUrls,
                additionalUrls,
            } = cleanedParams;

            // Increase UID entropy for security
            const uid = randomBytes(16).toString("hex");

            const usernameLower = this.normalizeUsername(rawUsername);

            // Define safeRole with allowlist
            const allowedRoles = ['user', 'admin', 'moderator']; // Add more as needed
            const safeRole = allowedRoles.includes(role) ? role : 'user';
            const publicUid = uid; // Use uid as public_uid for now

            Logger.debugLog?.(
                `[Users] [createUser] [DB_CHECK] Checking if user_name ${usernameLower} is taken`,
            );
            // Check if user_name exists
            // Remove redundant pre-check for user_name existence; rely on DB unique constraint

            Logger.debugLog?.(
                `[Users] [createUser] [DB_INSERT] Inserting user with uid: ${uid}`,
            );
            // Insert into users table
            const usersQuery = `
                INSERT INTO users (uid, username_lower, display_name, avatar_url, role, is_new_user, public_uid)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *
            `;
            const usersValues = [
                uid,
                usernameLower,
                displayName || rawUsername,
                avatarUrl || null,
                safeRole,
                isNewUser !== undefined ? isNewUser : true,
                publicUid,
            ];

            Logger.debugLog?.(
                `[Users] [createUser] [DB_INSERT] Inserting profile for uid: ${uid}`,
            );
            // Insert into user_profiles
            const profileQuery = `
                INSERT INTO user_profiles (
                    uid, bio, gender, age, body_type, hair_color, country, 
                    cover_image, background_images, social_urls, additional_urls
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `;
            // Shared utility for array validation and sanitization
            const sanitizeStringArray = (arr, maxLen = 10) => {
                if (!Array.isArray(arr)) return [];
                return arr.slice(0, maxLen).map((item) => {
                    if (typeof item !== "string") return "";
                    try {
                        return SafeUtils.sanitizeValidate({
                            url: { value: item, type: "string", trim: true },
                        }).url;
                    } catch {
                        return "";
                    }
                });
            };
            const safeBackgroundImages =
                backgroundImages !== undefined
                    ? sanitizeStringArray(backgroundImages, 10)
                    : null;
            const safeSocialUrls =
                socialUrls !== undefined
                    ? sanitizeStringArray(socialUrls, 10)
                    : null;
            const safeAdditionalUrls =
                additionalUrls !== undefined
                    ? sanitizeStringArray(additionalUrls, 10)
                    : null;
            const profileValues = [
                uid,
                bio || null,
                gender || null,
                age || null,
                bodyType || null,
                hairColor || null,
                country || null,
                coverImage || null,
                safeBackgroundImages,
                safeSocialUrls,
                safeAdditionalUrls,
            ];
            Logger.debugLog?.(
                `[Users] [createUser] [DB_INSERT] Inserting settings for uid: ${uid}`,
            );
            // Insert into user_settings
            const settingsQuery = `
                INSERT INTO user_settings (
                    uid, locale, notifications, call_video_message, presence_preference
                ) VALUES ($1, $2, $3, $4, $5)
            `;
            const settingsValues = [
                uid,
                locale || "en",
                notifications || "{}",
                callVideoMessage !== undefined ? callVideoMessage : false,
                presencePreference || null,
            ];

            // Begin transaction for multi-table user creation
            await db.query("default", "BEGIN");
            try {
                try {
                    await db.query("default", usersQuery, usersValues);
                } catch (err) {
                    if (err.code === "23505") {
                        // PostgreSQL unique violation
                        await db.query("default", "ROLLBACK");
                        Logger.debugLog?.(
                            `[Users] [createUser] [VALIDATION] Username ${usernameLower} is taken (unique constraint)`,
                        );
                        throw new Error("USERNAME_TAKEN");
                    }
                    await db.query("default", "ROLLBACK");
                    throw err;
                }
                await db.query("default", profileQuery, profileValues);
                await db.query("default", settingsQuery, settingsValues);
                await db.query("default", "COMMIT");
            } catch (err) {
                await db.query("default", "ROLLBACK");
                throw err;
            }
            Logger.debugLog?.(
                `[Users] [createUser] [BUILD_PROFILE] Building profile for uid: ${uid}`,
            );
            const profile = await this.buildUserProfile(uid);
            Logger.debugLog?.(
                `[Users] [createUser] [SUCCESS] Created user with uid: ${uid}`,
            );
            return profile;
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "CREATE_USER_FAILED",
                origin: "Users.createUser",
                data: { user_name: params.user_name },
            });
            throw err;
        }
    }

    /**
     * Get a paginated list of users with optional filters.
     * @param {object} filters - Filter options
     * @param {string} [filters.q] - Search query for user_name or display name
     * @param {string} [filters.uid] - Exact match for internal UID
     * @param {string} [filters.public_uid] - Exact match for public UID
     * @param {string} [filters.user_name] - Filter by user_name (ILIKE)
     * @param {string} [filters.display_name] - Filter by display name (ILIKE)
     * @param {string} [filters.role] - Filter by role
     * @param {string} [filters.country] - Filter by country
     * @param {string} [filters.status] - Filter by status ('online', 'offline', 'away')
     * @param {string} [filters.last_activity_from] - Filter users active from date (ISO string)
     * @param {string} [filters.last_activity_to] - Filter users active to date (ISO string)
     * @param {string} [filters.created_from] - Filter users created from date (ISO string)
     * @param {string} [filters.created_to] - Filter users created to date (ISO string)
     * @param {number} [limit=10] - Number of users to return
     * @param {number} [offset=0] - Number of users to skip
     * @returns {Promise<{users: Array, count: number}>}
     */
    static async getUsersList(filters = {}, limit = 10, offset = 0) {
        Logger.debugLog?.(
            `[Users] [getUsersList] [START] Payload received: ${JSON.stringify({ filters, limit, offset })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                limit: {
                    value: limit,
                    type: "integer",
                    required: false,
                    default: 10,
                },
                offset: {
                    value: offset,
                    type: "integer",
                    required: false,
                    default: 0,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "getUsersList",
                payload: { filters, limit, offset },
            });
            return { users: [], count: 0 };
        }
        const { limit: validatedLimit, offset: validatedOffset } = cleaned;

        try {
            Logger.debugLog?.(
                `[Users] [getUsersList] [DB_QUERY] Fetching users list with filters: ${JSON.stringify(filters)}, limit: ${validatedLimit}, offset: ${validatedOffset}`,
            );

            // Build dynamic WHERE clause
            let conditions = [];
            let params = [];
            let paramIndex = 1;

            if (filters.uid) {
                conditions.push(`users.uid = $${paramIndex}`);
                params.push(filters.uid);
                paramIndex++;
            }
            if (filters.public_uid) {
                conditions.push(`users.public_uid = $${paramIndex}`);
                params.push(filters.public_uid);
                paramIndex++;
            }
            if (filters.q) {
                // Search query across multiple fields (partial, case-insensitive)
                conditions.push(`(users.username_lower ILIKE $${paramIndex} OR users.display_name ILIKE $${paramIndex} OR users.email ILIKE $${paramIndex} OR users.phone_number ILIKE $${paramIndex})`);
                params.push(`%${(filters.q || '').toString()}%`);
                paramIndex++;
            }
            if (filters.user_name) {
                // Username filter should be exact (normalized to lowercase) to avoid partial matches like user2 -> user20
                conditions.push(`users.username_lower = $${paramIndex}`);
                params.push((filters.user_name || '').toString().toLowerCase());
                paramIndex++;
            }
            if (filters.display_name) {
                // Display name filter uses exact match
                conditions.push(`users.display_name = $${paramIndex}`);
                params.push(filters.display_name);
                paramIndex++;
            }
            if (filters.email) {
                // Exact email match (case-insensitive)
                conditions.push(`lower(users.email) = $${paramIndex}`);
                params.push((filters.email || '').toString().toLowerCase());
                paramIndex++;
            }
            if (filters.phone_number) {
                // Exact phone number match
                conditions.push(`users.phone_number = $${paramIndex}`);
                params.push(filters.phone_number);
                paramIndex++;
            }
            if (filters.role) {
                conditions.push(`users.role = $${paramIndex}`);
                params.push(filters.role);
                paramIndex++;
            }
            if (filters.country) {
                conditions.push(`user_profiles.country = $${paramIndex}`);
                params.push(filters.country);
                paramIndex++;
            }
            if (filters.last_activity_from) {
                conditions.push(`users.last_activity_at >= $${paramIndex}`);
                params.push(filters.last_activity_from);
                paramIndex++;
            }
            if (filters.last_activity_to) {
                conditions.push(`users.last_activity_at <= $${paramIndex}`);
                params.push(filters.last_activity_to);
                paramIndex++;
            }
            if (filters.created_from) {
                conditions.push(`user_profiles.created_at >= $${paramIndex}`);
                params.push(filters.created_from);
                paramIndex++;
            }
            if (filters.created_to) {
                conditions.push(`user_profiles.created_at <= $${paramIndex}`);
                params.push(filters.created_to);
                paramIndex++;
            }

            const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

            // Main query with JOIN
            const query = `
                SELECT users.uid, users.public_uid, users.username_lower as user_name, users.display_name, users.phone_number, users.email, users.avatar_url, users.role, user_profiles.created_at, user_profiles.country
                FROM users
                LEFT JOIN user_profiles ON users.uid = user_profiles.uid
                ${whereClause}
                ORDER BY user_profiles.created_at DESC
                LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
            `;
            params.push(validatedLimit, validatedOffset);

            let result, countResult, totalCount;
            try {
                Logger.debugLog?.(
                    `[Users] [getUsersList] [SQL] Executing query: ${query} with params: ${JSON.stringify(params)}`,
                );
                result = await db.query("default", query, params);
                // Query total count with same filters
                const countQuery = `SELECT COUNT(*) AS total FROM users LEFT JOIN user_profiles ON users.uid = user_profiles.uid ${whereClause}`;
                Logger.debugLog?.(
                    `[Users] [getUsersList] [SQL] Executing count query: ${countQuery} with params: ${JSON.stringify(params.slice(0, -2))}`,
                );
                countResult = await db.query("default", countQuery, params.slice(0, -2)); // Remove limit and offset
                totalCount = parseInt(countResult.rows[0]?.total || "0", 10);
            } catch (dbErr) {
                ErrorHandler.addError("Database connection error", {
                    code: "DB_CONNECTION_ERROR",
                    origin: "Users.getUsersList",
                    data: { error: dbErr.message },
                });
                return { users: [], count: 0, error: "DB_CONNECTION_ERROR" };
            }

            // Assign random statuses for demo purposes (deterministic based on uid for consistency)
            result.rows.forEach(user => {
                const statuses = ['online', 'offline', 'away'];
                // Use uid hash for consistent random status per user
                const hash = user.uid.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
                user.status = statuses[hash % statuses.length];
            });

            // Apply status filter if provided (since status is not in DB)
            if (filters.status) {
                result.rows = result.rows.filter(user => user.status === filters.status);
            }

            const usersList = {
                users: result.rows,
                count: result.rows.length,
                totalCount: totalCount,
            };
            Logger.debugLog?.(
                `[Users] [getUsersList] [SUCCESS] Retrieved ${usersList.users.length} users, total count: ${usersList.totalCount}`,
            );
            return usersList;
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "GET_USERS_LIST_FAILED",
                origin: "Users.getUsersList",
                data: { filters, limit, offset },
            });
            throw err;
        }
    }

    /**
     * Update user settings.
     * @param {string} userId
     * @param {object} settings
     * @returns {Promise<boolean>}
     */
    static async updateUserSettings(userId, settings) {
        Logger.debugLog?.(
            `[Users] [updateUserSettings] [START] Payload received: ${JSON.stringify({ userId, settings })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: {
                    value: userId,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "updateUserSettings",
                payload: { userId, settings },
            });
            return null;
        }
        const { uid: validatedUserId } = cleaned;

        let cleanedSettings;
        try {
            cleanedSettings = SafeUtils.sanitizeValidate({
                locale: {
                    value: settings.locale,
                    type: "string",
                    required: false,
                    trim: true,
                    max: 10,
                },
                notifications: {
                    value: settings.notifications,
                    type: "object",
                    required: false,
                },
                callVideoMessage: {
                    value: settings.callVideoMessage,
                    type: "boolean",
                    required: false,
                },
                presencePreference: {
                    value: settings.presencePreference,
                    type: "string",
                    required: false,
                    trim: true,
                    max: 20,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "updateUserSettings",
                payload: { userId, settings },
            });
            return null;
        }

        try {

            const {
                locale,
                notifications,
                callVideoMessage,
                presencePreference,
            } = cleanedSettings;

            const settingsFields = [];
            const settingsValues = [validatedUserId];
            let settingsIdx = 2;

            if (locale != null) {
                settingsFields.push(`locale = $${settingsIdx++}`);
                settingsValues.push(locale);
            }
            if (notifications != null) {
                settingsFields.push(`notifications = $${settingsIdx++}`);
                settingsValues.push(notifications);
            }
            if (callVideoMessage != null) {
                settingsFields.push(`call_video_message = $${settingsIdx++}`);
                settingsValues.push(callVideoMessage);
            }
            if (presencePreference != null) {
                settingsFields.push(`presence_preference = $${settingsIdx++}`);
                settingsValues.push(presencePreference);
            }

            if (settingsFields.length > 0) {
                Logger.debugLog?.(
                    `[Users] [updateUserSettings] [DB_UPSERT] Upserting settings for uid: ${validatedUserId}`,
                );
                // Atomic upsert using INSERT ... ON CONFLICT
                const updateAssignments = settingsFields.join(", ");
                await db.query(
                    "default",
                    `INSERT INTO user_settings (uid${settingsFields.length ? ", " + settingsFields.map((f) => f.split(" = ")[0]).join(", ") : ""})
                    VALUES ($${settingsValues.map((_, i) => i + 1).join(", ")})
                    ON CONFLICT (uid) DO UPDATE SET ${updateAssignments}, updated_at = NOW()`,
                    settingsValues,
                );
            }
            Logger.debugLog?.(
                `[Users] [updateUserSettings] [BUILD_PROFILE] Building updated profile for uid: ${validatedUserId}`,
            );
            const profile = await this.buildUserProfile(validatedUserId);
            Logger.debugLog?.(
                `[Users] [updateUserSettings] [SUCCESS] Updated settings for uid: ${validatedUserId}`,
            );
            return profile;
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "UPDATE_USER_SETTINGS_FAILED",
                origin: "Users.updateUserSettings",
                data: { uid: userId },
            });
            throw err;
        }
    }

    /**
     * Update user profile.
     * @param {string} userId
     * @param {object} profile
     * @returns {Promise<object|null>}
     */
    static async updateUserProfile(userId, profile) {
        Logger.debugLog?.(
            `[Users] [updateUserProfile] [START] Payload received: ${JSON.stringify({ userId, profile })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: {
                    value: userId,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "updateUserProfile",
                payload: { userId, profile },
            });
            return null;
        }
        const { uid: validatedUserId } = cleaned;

        let cleanedProfile;
        try {
            cleanedProfile = SafeUtils.sanitizeValidate({
                bio: {
                    value: profile.bio,
                    type: "string",
                    required: false,
                    trim: true,
                    max: 500,
                },
                gender: {
                    value: profile.gender,
                    type: "string",
                    required: false,
                    trim: true,
                    max: 20,
                },
                age: {
                    value: profile.age,
                    type: "integer",
                    required: false,
                },
                bodyType: {
                    value: profile.bodyType,
                    type: "string",
                    required: false,
                    trim: true,
                    max: 20,
                },
                hairColor: {
                    value: profile.hairColor,
                    type: "string",
                    required: false,
                    trim: true,
                    max: 20,
                },
                country: {
                    value: profile.country,
                    type: "string",
                    required: false,
                    trim: true,
                    max: 30,
                },
                coverImage: {
                    value: profile.coverImage,
                    type: "string",
                    required: false,
                    trim: true,
                    max: 200,
                },
                backgroundImages: {
                    value: profile.backgroundImages,
                    type: "array",
                    required: false,
                },
                socialUrls: {
                    value: profile.socialUrls,
                    type: "array",
                    required: false,
                },
                additionalUrls: {
                    value: profile.additionalUrls,
                    type: "array",
                    required: false,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "updateUserProfile",
                payload: { userId, profile },
            });
            return null;
        }

        try {
            const {
                bio,
                gender,
                age,
                bodyType,
                hairColor,
                country,
                coverImage,
                backgroundImages,
                socialUrls,
                additionalUrls,
            } = cleanedProfile;

            const profileFields = [];
            const profileValues = [];
            let profileIdx = 1;

            if (bio != null) {
                profileFields.push(`bio = $${profileIdx++}`);
                profileValues.push(bio);
            }
            if (gender != null) {
                profileFields.push(`gender = $${profileIdx++}`);
                profileValues.push(gender);
            }
            if (age != null) {
                profileFields.push(`age = $${profileIdx++}`);
                profileValues.push(age);
            }
            if (bodyType != null) {
                profileFields.push(`body_type = $${profileIdx++}`);
                profileValues.push(bodyType);
            }
            if (hairColor != null) {
                profileFields.push(`hair_color = $${profileIdx++}`);
                profileValues.push(hairColor);
            }
            if (country != null) {
                profileFields.push(`country = $${profileIdx++}`);
                profileValues.push(country);
            }
            if (coverImage != null) {
                profileFields.push(`cover_image = $${profileIdx++}`);
                profileValues.push(coverImage);
            }
            if (backgroundImages != null) {
                profileFields.push(`background_images = $${profileIdx++}`);
                profileValues.push(backgroundImages);
            }
            if (socialUrls != null) {
                profileFields.push(`social_urls = $${profileIdx++}`);
                profileValues.push(socialUrls);
            }
            if (additionalUrls != null) {
                profileFields.push(`additional_urls = $${profileIdx++}`);
                profileValues.push(additionalUrls);
            }

            if (profileFields.length > 0) {
                profileValues.push(validatedUserId);
                Logger.debugLog?.(
                    `[Users] [updateUserProfile] [DB_UPSERT] Upserting profile for uid: ${validatedUserId}`,
                );
                // Upsert profile
                const updateAssignments = profileFields.join(", ");
                await db.query(
                    "default",
                    `INSERT INTO user_profiles (uid, ${profileFields.map(f => f.split(' = ')[0]).join(", ")}) 
                     VALUES ($1, ${profileFields.map((_, i) => `$${i + 2}`).join(", ")}) 
                     ON CONFLICT (uid) DO UPDATE SET ${updateAssignments}, updated_at = NOW()`,
                    [validatedUserId, ...profileValues.slice(0, -1)],
                );
            }

            Logger.debugLog?.(
                `[Users] [updateUserProfile] [CUD_FETCH] Fetching CUD for uid: ${validatedUserId}`,
            );
            const criticalUserData =
                await this.getCriticalUserData(validatedUserId);
            Logger.debugLog?.(
                `[Users] [updateUserProfile] [DB_QUERY] Fetching all profile data for uid: ${validatedUserId}`,
            );
            const joinedResult = await db.query(
                "default",
                `SELECT u.public_uid, u.display_name, u.username_lower, u.avatar_url, u.role,
                        p.bio, p.gender, p.age, p.body_type, p.hair_color, p.country, p.cover_image, p.background_images, p.social_urls, p.additional_urls,
                        s.locale, s.notifications, s.call_video_message, s.presence_preference
                 FROM users u
                 LEFT JOIN user_profiles p ON u.uid = p.uid
                 LEFT JOIN user_settings s ON u.uid = s.uid
                 WHERE u.uid = $1 LIMIT 1`,
                [validatedUserId],
            );
            const row = joinedResult?.rows?.[0] || {};
            if (!criticalUserData) {
                Logger.debugLog?.(
                    `[Users] [updateUserProfile] [MISS] No CUD for uid: ${validatedUserId}`,
                );
                return null;
            }
            const profile = {
                uid: validatedUserId,
                publicUid: row.public_uid || "",
                displayName:
                    criticalUserData.displayName || row.display_name || "",
                userName: criticalUserData.user_name || row.username_lower || "",
                avatar: criticalUserData.avatar || row.avatar_url || "",
                user_profile: {
                    bio: row.bio || "",
                    gender: row.gender || "",
                    age: row.age ?? null,
                    bodyType: row.body_type || "",
                    hairColor: row.hair_color || "",
                    country: row.country || "",
                    coverImage: row.cover_image || "",
                    backgroundImages: row.background_images || [],
                    socialUrls: row.social_urls || [],
                    additionalUrls: row.additional_urls || [],
                },
                user_settings: {
                    locale: row.locale || "en",
                    notifications: row.notifications || {},
                    callVideoMessage: row.call_video_message ?? false,
                    presencePreference: row.presence_preference || null,
                },
            };
            Logger.debugLog?.(
                `[Users] [updateUserProfile] [SUCCESS] Built profile for uid: ${validatedUserId}`,
            );
            return profile;
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "BUILD_USER_PROFILE_FAILED",
                origin: "Users.buildUserProfile",
                data: { uid: userId },
            });
            return null;
        }
    }

    /**
     * Update user and profile fields.
     * @param {string} userId
     * @param {object} updates
     * @returns {Promise<object|null>}
     */
    static async updateUser(userId, updates) {
        Logger.debugLog?.(
            `[Users] [updateUser] [START] Payload received: ${JSON.stringify({ userId, updates })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: {
                    value: userId,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "updateUser",
                payload: { userId, updates },
            });
            return null;
        }
        const { uid: validatedUserId } = cleaned;
        try {
            const { user_profile, user_settings, ...userFields } = updates;

            // Sanitize user fields
            const userSchema = {
                displayName: {
                    type: "string",
                    required: false,
                    trim: true,
                    max: 100,
                    default: '',
                },
                avatarUrl: {
                    type: "string",
                    required: false,
                    trim: true,
                    max: 200,
                },
                role: { type: "string", required: false, trim: true, max: 20, default: 'user' },
            };
            const sanitizedUserFields = SafeUtils.sanitizeValidate(
                Object.keys(userSchema).reduce((acc, key) => {
                    acc[key] = { ...userSchema[key], value: userFields[key] };
                    return acc;
                }, {})
            );

            // Sanitize settings
            const settingsSchema = {
                locale: {
                    type: "string",
                    required: false,
                    trim: true,
                    max: 10,
                    default: 'en',
                },
                notifications: { type: "object", required: false,  },
                callVideoMessage: { type: "boolean", required: false, default: false },
                presencePreference: {
                    type: "string",
                    required: false,
                    trim: true,
                    max: 20,
                    default: null,
                },
            };
            console.log("settings:", user_settings);
            const sanitizedSettings = SafeUtils.sanitizeValidate(
                Object.keys(settingsSchema).reduce((acc, key) => {
                    acc[key] = { ...settingsSchema[key], value: user_settings[key] };
                    return acc;
                }, {})
            );
            console.log("sanitized_settings:", sanitizedSettings);
            // Sanitize profile
            const profileSchema = {
                bio: { type: "string", required: false, trim: false, max: 2500, default: '' },
                gender: {
                    type: "string",
                    required: false,
                    trim: true,
                    max: 20,
                },
                age: { type: "integer", required: false},
                bodyType: {
                    type: "string",
                    required: false,
                    trim: true,
                    max: 20,
                },
                hairColor: {
                    type: "string",
                    required: false,
                    trim: true,
                    max: 20,
                },
                country: {
                    type: "string",
                    required: false,
                    trim: true,
                    max: 30,
                },
                coverImage: {
                    type: "string",
                    required: false,
                    trim: true,
                    max: 200,
                },
                backgroundImages: { type: "array", required: false, },
                socialUrls: { type: "array", required: false, },
                additionalUrls: { type: "array", required: false, },
            };
            console.log("user_profile:", user_profile);
            const sanitizedProfile = SafeUtils.sanitizeValidate(
                Object.keys(profileSchema).reduce((acc, key) => {
                    acc[key] = { ...profileSchema[key], value: user_profile[key] };
                    return acc;
                }, {})
            );
            console.log("sanitizedProfile:",sanitizedProfile)

            const {
                displayName,
                avatarUrl,
                role,
            } = sanitizedUserFields;

            // Validate role against allowlist
            const allowedRoles = ['user', 'admin', 'moderator']; // Add more as needed
            const safeRole = role !== undefined ? (allowedRoles.includes(role) ? role : 'user') : undefined;

            // Update users table
            const usersFields = [];
            const usersValues = [];
            let usersIdx = 1;

            // Standardized NULL/undefined handling for update fields:
            if (displayName != null) {
                usersFields.push(`display_name = $${usersIdx++}`);
                usersValues.push(displayName === "" ? "" : displayName);
            }
            if (avatarUrl != null) {
                usersFields.push(`avatar_url = $${usersIdx++}`);
                usersValues.push(avatarUrl === "" ? "" : avatarUrl);
            }
            if (safeRole != null) {
                usersFields.push(`role = $${usersIdx++}`);
                usersValues.push(safeRole === "" ? "" : safeRole);
            }

            try {
                await db.query("default", "BEGIN");
                try {
                    if (usersFields.length > 0) {
                        usersValues.push(validatedUserId);
                        Logger.debugLog?.(
                            `[Users] [updateUser] [DB_UPDATE] Updating users table for uid: ${validatedUserId}`,
                        );
                        await db.query(
                            "default",
                            `UPDATE users SET ${usersFields.join(", ")}, updated_at = NOW() WHERE uid = $${usersIdx}`,
                            usersValues,
                        );
                    }
                    Logger.debugLog?.(
                        `[Users] [updateUser] [UPDATE_SETTINGS] Updating settings for uid: ${validatedUserId}`,
                    );
                    await this.updateUserSettings(validatedUserId, sanitizedSettings);
                    Logger.debugLog?.(
                        `[Users] [updateUser] [UPDATE_PROFILE] Updating profile for uid: ${validatedUserId}`,
                    );
                    await this.updateUserProfile(validatedUserId, {...sanitizedProfile});
                    await db.query("default", "COMMIT");
                } catch (err) {
                    await db.query("default", "ROLLBACK");
                    throw err;
                }
            } catch (err) {
                ErrorHandler.addError(err.message, {
                    code: "UPDATE_USER_FAILED",
                    origin: "Users.updateUser",
                    data: { uid: userId },
                });
                throw err;
            }
            Logger.debugLog?.(
                `[Users] [updateUser] [BUILD_PROFILE] Building updated profile for uid: ${validatedUserId}`,
            );
            const profile = await this.buildUserProfile(validatedUserId);
            Logger.debugLog?.(
                `[Users] [updateUser] [SUCCESS] Updated user for uid: ${validatedUserId}`,
            );
            return profile;
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: "UPDATE_USER_FAILED",
                origin: "Users.updateUser",
                data: { uid: userId },
            });
            throw err;
        }
    }

    /**
     * Delete a user and cleanup resources.
     * @param {string} userId
     * @returns {Promise<boolean>}
     */
    static async deleteUser(userId) {
        Logger.debugLog?.(
            `[Users] [deleteUser] [START] Payload received: ${JSON.stringify({ userId })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: {
                    value: userId,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "deleteUser",
                payload: { userId },
            });
            return false;
        }
        const { uid: validatedUserId } = cleaned;

        try {
            Logger.debugLog?.(
                `[Users] [deleteUser] [DB_DELETE] Deleting user: ${validatedUserId}`,
            );
            // Delete from users table (CASCADE should handle linked tables)
            const result = await db.query(
                "default",
                "DELETE FROM users WHERE uid = $1 RETURNING uid",
                [validatedUserId],
            );

            if (result.rowCount === 0) {
                Logger.debugLog?.(
                    `[Users] [deleteUser] [DB_DELETE] No rows deleted for uid: ${validatedUserId}`,
                );
                return false;
            }

            Logger.writeLog({
                flag: this.LOGGER_FLAG_USERS,
                action: "deleteUser",
                data: { uid: validatedUserId },
            });

            Logger.debugLog?.(
                `[Users] [deleteUser] [SUCCESS] Deleted user and cleaned up resources for uid: ${validatedUserId}`,
            );
            return true;
        } catch (err) {
            ErrorHandler.addError(err.message, {
                code: Users.ERROR_CODES.DELETE_USER_FAILED,
                origin: "Users.deleteUser",
                data: { uid: userId },
            });
            return false;
        }
    }

    /**
     * Clean up all user-related data after deletion.
     * Removes or archives all related records (profiles, settings, logs, etc.) for the given userId.
     * @param {string} userId
     * @returns {Promise<boolean>}
     */
    static async cleanupDeletedUserData(userId) {
        Logger.debugLog?.(
            `[Users] [cleanupDeletedUserData] [START] Payload received: ${JSON.stringify({ userId })}`,
        );
        let cleaned;
        try {
            cleaned = SafeUtils.sanitizeValidate({
                uid: {
                    value: userId,
                    type: "string",
                    required: true,
                    trim: true,
                },
            });
        } catch (err) {
            ErrorHandler.addError(err.message, {
                method: "cleanupDeletedUserData",
                payload: { userId },
            });
            return false;
        }
        const { uid: validatedUserId } = cleaned;
        try {
            await db.query("default", "BEGIN");
            await db.query(
                "default",
                "DELETE FROM user_profiles WHERE uid = $1",
                [validatedUserId],
            );
            await db.query(
                "default",
                "DELETE FROM user_settings WHERE uid = $1",
                [validatedUserId],
            );
            // Add additional cleanup for logs, media, etc. as needed
            await db.query("default", "COMMIT");
            Logger.debugLog?.(
                `[Users] [cleanupDeletedUserData] [SUCCESS] Cleaned up data for uid: ${validatedUserId}`,
            );
            return true;
        } catch (err) {
            await db.query("default", "ROLLBACK");
            ErrorHandler.addError(err.message, {
                code: "CLEANUP_DELETED_USER_DATA_FAILED",
                origin: "Users.cleanupDeletedUserData",
                data: { uid: userId },
            });
            return false;
        }
    }

    /**
     * Utility for building dynamic SQL update queries
     */
    static buildDynamicUpdateQuery(tableName, updates, whereClause) {
        const fields = Object.keys(updates).map(
            (key, idx) => `${key} = $${idx + 1}`,
        );
        const values = Object.values(updates);
        return {
            sql: `UPDATE ${tableName} SET ${fields.join(", ")}, updated_at = NOW() WHERE ${whereClause}`,
            values,
        };
    }
}

module.exports = Users;
