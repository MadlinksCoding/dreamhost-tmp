/**
 * MediaHandler.js — FINAL
 * -----------------------------------------------------------------------------
 * Single-class implementation with 45 methods exactly as indexed/agreed.
 *      - One-line-per-field type registry (FIELD_SPEC) — single source of truth.
 *      - METHOD_RULES apply ONLY to the 4 main handlers.
 *      - All other methods still sanitize/validate (allowlist + type check) but do NOT enforce required fields (per your instruction).
 *      - sanitizeValidateFirst(...) is the VERY FIRST LINE in EVERY method that accepts input.
 *      - Strict, descriptive constants.
 *      - Event map for publish/schedule (simple, per-type).
 *      - Strong logging at start/end of every method + crucial branches.
 *      - Audit logging inside transactions for all writes.
 *      - ES integration points annotated: // Implement elasticsearch here
 *
 * External deps you provide:
 *   - SafeUtils: { sanitizeUrl, ... }
 *   - ErrorHandler: logging utility with addError method
 *   - DB Wrapper (postgress-final.js): { withTransaction, query, getRow, getAll }
 *   - Logger: any object with .info/.warn/.error (you attach via ctor).
 */

'use strict';

const { ErrorHandler, Logger, SafeUtils, DateTime, ConfigFileLoader, DB } = require('../utils/index.js');
const { randomUUID } = require('node:crypto');

// ============================================================================
//                      SHARED CONSTANTS (INITIALIZED ONCE)
// ============================================================================

const STATUS = Object.freeze({
    DRAFT: 'draft',
    PENDING_REVIEW: 'pending_review',
    SCHEDULED: 'scheduled',
    PUBLISHED: 'published',
    ARCHIVED: 'archived',
    DELETED: 'deleted',
});

const MEDIA_TYPE = Object.freeze({
    AUDIO: 'audio',
    VIDEO: 'video',
    IMAGE: 'image',
    GALLERY: 'gallery',
    FILE: 'file',
});

const VISIBILITY = Object.freeze({
    PUBLIC: 'public',
    PRIVATE: 'private',
    SUBSCRIBERS: 'subscribers',
    PURCHASERS: 'purchasers',
    UNLISTED: 'unlisted',
});

const ACTION = Object.freeze({
    ADD: 'add',
    UPDATE: 'update',
    SCHEDULE: 'schedule',
    PUBLISH: 'publish',
    SOFT_DELETE: 'soft_delete',
    HARD_DELETE: 'hard_delete',
    OWNERSHIP: 'set_ownership',
    VISIBILITY: 'set_visibility',
    FEATURED: 'set_featured',
    COMING_SOON: 'set_coming_soon',
    TAGS_REPLACE: 'set_tags',
    TAG_ADD: 'add_tag',
    TAG_REMOVE: 'remove_tag',
    COPERFORMERS_REPLACE: 'set_coperformers',
    ASSET_ATTACH: 'attach_primary_asset',
    POSTER_SET: 'set_poster',
    BLUR_APPLY: 'apply_blur_controls',
    REINDEX: 'reindex',
    COLLECTION_CREATE: 'collection_create',
    COLLECTION_ADD: 'collection_add',
    COLLECTION_REMOVE: 'collection_remove',
    STATUS_SET: 'set_status',
    NOTE_ADD: 'add_note',
});

const METHOD_RULES = Object.freeze({
    handleAddMediaItem: ['owner_user_id', 'media_type'],
    handleUpdateMediaItem: ['media_id', 'expectedVersion'],
    handleScheduleMediaItem: ['media_id', 'expectedVersion', 'publish_date'],
    handlePublishMediaItem: ['media_id', 'expectedVersion'],
});

const EventMap = Object.freeze({
    publishAudioItem: [
        'title',
        'asset_url:https',
        'duration_seconds>0',
        'media_type=audio',
    ],
    publishVideoItem: [
        'title',
        'asset_url:https',
        'duration_seconds>0',
        'poster_url:https',
        'pending_conversion=false',
        'media_type=video',
    ],
    publishImageItem: ['title', 'asset_url:https', 'media_type=image'],
    publishGalleryItem: ['title', 'asset_url:https', 'media_type=gallery'],
    publishFileItem: ['title', 'asset_url:https', 'media_type=file'],
    publishMediaItem: {
        audio: 'publishAudioItem',
        video: 'publishVideoItem',
        image: 'publishImageItem',
        gallery: 'publishGalleryItem',
        file: 'publishFileItem',
    },

    scheduleAudioItem: [
        'title',
        'asset_url:https',
        'duration_seconds>0',
        'media_type=audio',
        'publish_date>now',
    ],
    scheduleVideoItem: [
        'title',
        'asset_url:https',
        'duration_seconds>0',
        'poster_url:https',
        'pending_conversion=false',
        'media_type=video',
        'publish_date>now',
    ],
    scheduleImageItem: ['title', 'asset_url:https', 'media_type=image', 'publish_date>now'],
    scheduleGalleryItem: [
        'title',
        'asset_url:https',
        'media_type=gallery',
        'publish_date>now',
    ],
    scheduleFileItem: ['title', 'asset_url:https', 'media_type=file', 'publish_date>now'],
    scheduleMediaItem: {
        audio: 'scheduleAudioItem',
        video: 'scheduleVideoItem',
        image: 'scheduleImageItem',
        gallery: 'scheduleGalleryItem',
        file: 'scheduleFileItem',
    },

    setStatusPublished: 'publishMediaItem',
    setStatusScheduled: 'scheduleMediaItem',
});

class MediaHandler {
    constructor({ db, log, indexer, clock, uuid, config = {}, connection } = {}) {
        this.db = db || new DB();
        this.connection = connection || config.connection || 'default';
        
        // Validate connection parameter
        if (!this.connection || typeof this.connection !== 'string' || this.connection.trim() === '') {
            throw new Error('Invalid connection parameter: must be a non-empty string');
        }
        
        this.log = log;
        this.indexer = indexer ?? {upsert: async () => {}, delete: async () => {}}; // Implement elasticsearch here
        this.clock = clock ?? {now: () => DateTime.now(undefined, "UTC")};
        this.uuid = uuid ?? {
            v4: () => globalThis.crypto?.randomUUID?.() || randomUUID(),
        };
        this.config = config;

        // --------------------------- Descriptive constants ---------------------------
        this.STATUS = STATUS;
        this.MEDIA_TYPE = MEDIA_TYPE;
        this.VISIBILITY = VISIBILITY;
        this.ACTION = ACTION;

        // ------------------------ Config (caps) --------------------------------------
        const safeConfig = {};
        if (config) {
            for (const key in config) {
                if (config.hasOwnProperty(key) && key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
                    safeConfig[key] = config[key];
                }
            }
        }
        this.config = Object.assign(
            {
                maxTagCount: 25,
                maxTagLength: 48,
                maxCoPerformers: 16,
                maxTitleLength: 200,
                maxDescriptionLength: 16000,
                maxUrlLength: 2000,
                maxDurationSeconds: 8 * 60 * 60, // 8h
                maxJsonLength: 10000, // 10KB limit for JSON fields
                maxNoteLength: 5000,
                maxNotesPerItem: 50,
                defaultPageSize: 24,
                maxPageSize: 100,
            },
            safeConfig,
        );

        // ============================================================================
        //                      SINGLE GLOBAL FIELD SPEC (ONE LINE PER FIELD)
        // ============================================================================
        // type syntax:
        //   string[:nonempty][:max=N]
        //   url:https
        //   int[:>=N][:<=N]
        //   bool
        //   enum:a|b|c
        //   json
        //   datetime
        const S = (rule) => Object.freeze({rule});

        this.FIELD_SPEC = Object.freeze({
            // identities
            id: S('int:>=0'),
            media_id: S('string:nonempty:max=72'),
            mediaVersion: S('int:>=0|optional'),
            owner_user_id: S('string:nonempty:max=191'),
            new_owner_user_id: S('string:nonempty:max=191'),
            collection_id: S('string:nonempty:max=72'),
            actorUserId: S('string:nonempty:max=191'),
            addedBy: S('string:nonempty:max=191'),

            // enums
            media_type: S('enum:audio|video|image|gallery|file'),
            visibility: S('enum:public|private|subscribers|purchasers|unlisted'),

            // text & meta
            title: S(`string:max=${this.config.maxTitleLength}`),
            description: S(`string:max=${this.config.maxDescriptionLength}`),
            note: S(`string:nonempty:max=${this.config.maxNoteLength}`),
            media_meta: S('json'),
            image_variants_json: S('json'),
            file_extension: S('string:max=16'),
            file_name: S('string:max=255'),

            // urls
            asset_url: S('url:https'),
            poster_url: S('url:https'),
            gallery_poster_url: S('url:https'),

            // numbers
            file_size_bytes: S('int:>=0'),
            duration_seconds: S(`int:>=0:<=${this.config.maxDurationSeconds}`),
            video_width: S('int:>=0'),
            video_height: S('int:>=0'),
            expectedVersion: S('int:>=0'),
            position: S('int:>=0'),
            limit: S('int:>=0:<=100'),
            offset: S('int:>=0'),
            blurred_value_px: S('int:>=0:<=40'),
            trailer_blurred_value_px: S('int:>=0:<=40'),

            // booleans
            featured: S('bool'),
            coming_soon: S('bool'),
            pending_conversion: S('bool'),
            includeTags: S('bool'),
            includeCoPerformers: S('bool'),
            placeholder_lock: S('bool'),
            blurred_lock: S('bool'),
            trailer_blurred_lock: S('bool'),
            isPublic: S('bool'),
            soft_delete: S('bool'),
            hard_delete: S('bool'),
            merge: S('bool'),

            // arrays (normalized via helpers)
            tags: S('json'), // string[]
            coperformers: S('json'), // string[]
            performerIds: S('json'), // string[]
            notes: S('json'), // {text, addedBy, addedAt, isPublic}[]

            // misc
            idempotency_key: S('string:max=191'),
            cursor: S('string:max=191'),
            query: S('string:max=500'),
            q: S('string:max=500'),
            sort_by: S('string:max=64'),
            sort_order: S('enum:asc|desc|ASC|DESC'),
            filters: S('json'),

            // dates
            publish_date: S('datetime'),
        });

        // ============================================================================
        //                 PER-HANDLER REQUIRED FIELDS (ONLY handlers use this)
        // ============================================================================
        this.METHOD_RULES = METHOD_RULES;

        // ============================================================================
        //            SIMPLE EVENT MAP (PUBLISH / SCHEDULE) — TYPE-SPECIFIC
        // ============================================================================
        this.EventMap = EventMap;
    }

    // ============================================================================
    //                                SANITIZER
    // ============================================================================

    /**
     * sanitizeValidateFirst(payload, methodKeyOrNull)
     * Description:
     *   FIRST LINE for every method: validates required fields for handlers (if methodKey provided),
     *   and validates/coerces each payload field using FIELD_SPEC. Unknown fields → error.
     * Checklist:
     *   - Ensure payload is object.
     *   - If methodKey in METHOD_RULES → enforce required list.
     *   - For each key: verify it exists in FIELD_SPEC; coerce via _coerceByRule.
     *   - Normalize arrays (tags, performer lists).
     */
    sanitizeValidateFirst(payload, methodKey) {
        if (!payload || typeof payload !== 'object') {
            ErrorHandler.addError('Payload must be an object', { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { payload, methodKey } });
            throw new Error('Payload must be an object');
        }

        if (methodKey) {
            const required = this.METHOD_RULES[methodKey];
            if (!required) {
                ErrorHandler.addError(`Unknown handler rules for '${methodKey}'`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { methodKey } });
                throw new Error(`Unknown handler rules for '${methodKey}'`);
            }
            for (const f of required) {
                if (!(f in payload)) {
                    ErrorHandler.addError(`Missing required field '${f}'`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { f, payload, methodKey } });
                    throw new Error(`Missing required field '${f}'`);
                }
            }
        }

        const clean = {};
        for (const [key, value] of Object.entries(payload)) {
            let kind = null;
            let parts = [];
            try {
                const spec = this.FIELD_SPEC[key];

                if (!spec) {
                    if (typeof Logger !== 'undefined' && Logger.debugLog) {
                        Logger.debugLog(`[defensive] [sanitizeValidateFirst] MISSING FIELD_SPEC: key=${key}, value=${JSON.stringify(value)}, payload keys=${Object.keys(payload)}`);
                    }
                    ErrorHandler.addError(`Unexpected field '${key}'`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, value, payload, methodKey } });
                    throw new Error(`Unexpected field '${key}'`);
                }

                const rule = spec.rule;
                if (typeof rule !== 'string') {
                    if (typeof Logger !== 'undefined' && Logger.debugLog) {
                        Logger.debugLog(`[defensive] [sanitizeValidateFirst] INVALID RULE TYPE: key=${key}, rule=${JSON.stringify(rule)}, value=${JSON.stringify(value)}, spec=${JSON.stringify(spec)}`);
                    }
                    ErrorHandler.addError(`Invalid rule type for field '${key}'`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, value, rule, spec } });
                    throw new Error(`Invalid rule type for field '${key}'`);
                }
                parts = rule.split(':');
                kind = parts[0];

                if (typeof Logger !== 'undefined' && Logger.debugLog) {
                    Logger.debugLog(`[defensive] [sanitizeValidateFirst] key=${key}, rule=${rule}, parts=${JSON.stringify(parts)}, value=${JSON.stringify(value)}`);
                }

                if (kind === 'json') {
                    if (value == null) {
                        clean[key] = null;
                    } else {
                        const jsonStr = JSON.stringify(value);
                        if (jsonStr.length > this.config.maxJsonLength) {
                            ErrorHandler.addError(`${key} JSON too large`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, length: jsonStr.length, max: this.config.maxJsonLength } });
                            throw new Error(`${key} JSON too large`);
                        }
                        const parsed = JSON.parse(jsonStr);
                        // Defensive: always coerce tags/coperformers/performerIds to array of strings
                        if (key === 'tags' || key === 'coperformers' || key === 'performerIds') {
                            const arr = SafeUtils.sanitizeArray(parsed).map(String);
                            clean[key] = arr;
                        } else if (key === 'media_meta' || key === 'image_variants_json' || key === 'filters') {
                            if (typeof parsed !== 'object' || Array.isArray(parsed)) {
                                ErrorHandler.addError(`${key} must be object`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, value: parsed } });
                                throw new Error(`${key} must be object`);
                            }
                            clean[key] = parsed;
                        } else {
                            clean[key] = parsed;
                        }
                    }
                } else if (kind === 'datetime') {
                    const d = DateTime.parseDateToTimestamp(value);
                    if (d == null || Number.isNaN(d)) {
                        ErrorHandler.addError(`${key} invalid datetime`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, value, rule } });
                        throw new Error(`${key} invalid datetime`);
                    }
                    clean[key] = d;
                } else {
                    let type;
                    if (kind === 'string' || kind === 'url' || kind === 'enum') type = 'string';
                    else if (kind === 'int') type = 'int';
                    else if (kind === 'bool') type = 'bool';
                    else type = 'string';

                    const sanitizedValues = SafeUtils.sanitizeValidate({ [key]: { value, type } });
                    const sanitized = sanitizedValues[key];

                    if (sanitized === null && value != null) {
                        ErrorHandler.addError(`${key} invalid ${kind}`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, value, rule } });
                        throw new Error(`${key} invalid ${kind}`);
                    }
                    clean[key] = sanitized;
                }

                // apply constraints
                if (kind === 'string') {
                    const nonempty = parts.includes('nonempty');
                    const maxPart = parts.find((p) => typeof p === 'string' && p.startsWith('max='));
                    const max = maxPart ? Number(maxPart.split('=')[1]) : 10000;
                    const s = clean[key];
                    if (nonempty && !s) {
                        ErrorHandler.addError(`${key} must be nonempty string`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, value, rule } });
                        throw new Error(`${key} must be nonempty string`);
                    }
                    if (s && s.length > max) {
                        ErrorHandler.addError(`${key} too long`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, value, rule, max } });
                        throw new Error(`${key} too long`);
                    }
                }

                if (kind === 'int') {
                    const rules = parts.slice(1).flatMap((p) => p.split('|'));
                    const minPart = rules.find((p) => typeof p === 'string' && p.startsWith('>=')) || null;
                    const maxPart = rules.find((p) => typeof p === 'string' && p.startsWith('<=')) || null;
                    const min = minPart ? Number(minPart.replace('>=', '')) : null;
                    const max = maxPart ? Number(maxPart.replace('<=', '')) : null;
                    const num = clean[key];
                    if ((min !== null && num < min) || (max !== null && num > max)) {
                        ErrorHandler.addError(`${key} invalid int`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, value, rule, min, max } });
                        throw new Error(`${key} invalid int`);
                    }
                }

                if (kind === 'url') {
                    if (value == null || value === '') {
                        clean[key] = null;
                    } else {
                        const https = parts.includes('https');
                        if (https && (!clean[key] || !clean[key].startsWith('https://'))) {
                            ErrorHandler.addError(`${key} must be https URL`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, value, rule } });
                            throw new Error(`${key} must be https URL`);
                        }
                        if (clean[key] && clean[key].length > this.config.maxUrlLength) {
                            ErrorHandler.addError(`${key} too long`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, value, rule, maxUrlLength: this.config.maxUrlLength } });
                            throw new Error(`${key} too long`);
                        }
                    }
                }

                if (kind === 'enum') {
                    const allowed = parts[1] ? parts[1].split('|') : [];
                    if (!allowed.length) {
                        ErrorHandler.addError(`${key} enum definition malformed`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, value, rule, parts } });
                        throw new Error(`${key} enum definition malformed: ${rule}`);
                    }
                    if (clean[key] == null || !allowed.includes(clean[key])) {
                        ErrorHandler.addError(`${key} invalid enum value`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, value, rule, allowed } });
                        throw new Error(`${key} invalid enum value`);
                    }
                }
            } catch (err) {
                if (typeof Logger !== 'undefined' && Logger.debugLog) {
                    Logger.debugLog(`[CATCHALL] [sanitizeValidateFirst] key=${key}, value=${JSON.stringify(value)}, error=${err && err.message}, stack=${err && err.stack}`);
                }
                throw err;
            }
        }

        // normalization (defensive: always ensure arrays)
        if ('tags' in clean) {
            if (!Array.isArray(clean.tags)) {
                if (clean.tags == null) clean.tags = [];
                else if (typeof clean.tags === 'string') clean.tags = [clean.tags];
                else clean.tags = Array.from(clean.tags || []);
            }
            clean.tags = this.normalizeTags(clean.tags);
        }

        if ('coperformers' in clean) {
            if (!Array.isArray(clean.coperformers)) {
                if (clean.coperformers == null) clean.coperformers = [];
                else if (typeof clean.coperformers === 'string') clean.coperformers = [clean.coperformers];
                else clean.coperformers = Array.from(clean.coperformers || []);
            }
            clean.coperformers = this.normalizeCoPerformers(clean.coperformers);
        }

        if ('performerIds' in clean) {
            if (!Array.isArray(clean.performerIds)) {
                if (clean.performerIds == null) clean.performerIds = [];
                else if (typeof clean.performerIds === 'string') clean.performerIds = [clean.performerIds];
                else clean.performerIds = Array.from(clean.performerIds || []);
            }
            clean.performerIds = this.normalizeCoPerformers(clean.performerIds);
        }

        return clean;
    }



    // ============================================================================
    //                           EVENT VALIDATION (PUBLISH/SCHEDULE)
    // ============================================================================

    /**
     * enforceEventList(eventKey, row)
     * Description:
     *   Apply simple event list (publish/schedule) to the current row.
     * Checklist:
     *   - Resolve dispatcher keys by media_type.
     *   - Support atoms: "field", "field:https", "field>0", "field=false", "media_type=video", "publish_date>now".
     */
    enforceEventList(eventKey, row) {
        let list = this.EventMap[eventKey];
        if (!list) {
            ErrorHandler.addError(`Unknown event '${eventKey}'`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { eventKey, row } });
            throw new Error(`Unknown event '${eventKey}'`);
        }

        if (typeof list === 'object' && !Array.isArray(list)) {
            const mt = row.media_type;
            const mapped = list[mt];
            if (!mapped) {
                ErrorHandler.addError(`No event mapping for media_type='${mt}'`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { eventKey, row, mt } });
                throw new Error(`No event mapping for media_type='${mt}'`);
            }
            list = this.EventMap[mapped];
        }
        if (!Array.isArray(list)) {
            ErrorHandler.addError(`Invalid event list for '${eventKey}'`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { eventKey, row, list } });
            throw new Error(`Invalid event list for '${eventKey}'`);
        }

        const now = Math.floor(Date.now() / 1000);

        for (const atom of list) {
            if (typeof Logger !== 'undefined' && Logger.debugLog) {
                Logger.debugLog(`[debug .includes] [event] atom: ${JSON.stringify(atom)}`);
            }
            if (typeof Logger !== 'undefined' && Logger.debugLog) {
                Logger.debugLog(`[trace .includes] [atom] atom=${JSON.stringify(atom)}, typeof atom=${typeof atom}`);
            }
            if (atom.includes('=')) {
                const [lhs, rhs] = atom.split('=');
                if (lhs === 'media_type') {
                    if (row.media_type !== rhs) {
                        ErrorHandler.addError(`media_type must be '${rhs}' to ${eventKey}`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { eventKey, row, lhs, rhs } });
                        throw new Error(`media_type must be '${rhs}' to ${eventKey}`);
                    }
                } else if (lhs === 'pending_conversion' && rhs === 'false') {
                    if (!!row.pending_conversion) {
                        ErrorHandler.addError(`pending_conversion must be false`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { eventKey, row, lhs, rhs } });
                        throw new Error(`pending_conversion must be false`);
                    }
                } else {
                    if (String(row[lhs]) !== rhs) {
                        ErrorHandler.addError(`${lhs} must equal ${rhs}`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { eventKey, row, lhs, rhs } });
                        throw new Error(`${lhs} must equal ${rhs}`);
                    }
                }
                continue;
            }
            if (atom.endsWith('>0')) {
                const field = atom.replace('>0', '');
                if (!(SafeUtils.sanitizeInteger(row[field]) > 0)) {
                    ErrorHandler.addError(`${field} must be > 0`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { eventKey, row, atom, field } });
                    throw new Error(`${field} must be > 0`);
                }
                continue;
            }
            if (atom.endsWith('=false')) {
                const field = atom.replace('=false', '');
                if (!!row[field]) {
                    ErrorHandler.addError(`${field} must be false`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { eventKey, row, atom, field } });
                    throw new Error(`${field} must be false`);
                }
                continue;
            }
            if (atom.endsWith(':https')) {
                const field = atom.replace(':https', '');
                if (!row[field]) {
                    ErrorHandler.addError(`${field} required`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { eventKey, row, atom, field } });
                    throw new Error(`${field} required`);
                }
                const sanitized = SafeUtils.sanitizeUrl(row[field]);
                if (!sanitized || !sanitized.startsWith('https://')) {
                    ErrorHandler.addError(`${field} must be https`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { eventKey, row, atom, field } });
                    throw new Error(`${field} must be https`);
                }
                continue;
            }
            if (atom.endsWith('>now')) {
                const field = atom.replace('>now', '');
                const d = DateTime.parseDateToTimestamp(row[field]);
                if (d == null || Number.isNaN(d) || !(d > now)) {
                    ErrorHandler.addError(`${field} must be in the future`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { eventKey, row, atom, field, now } });
                    throw new Error(`${field} must be in the future`);
                }
                continue;
            }
            if (row[atom] == null || (typeof row[atom] === 'string' && !row[atom].trim())) {
                ErrorHandler.addError(`${atom} is required for ${eventKey}`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { eventKey, row, atom } });
                throw new Error(`${atom} is required for ${eventKey}`);
            }
        }
    }

    // ============================================================================
    //                               NORMALIZERS
    // ============================================================================

    /**
     * normalizeTags(tags)
     * Description:
     *   Trim → lowercase → dedupe; enforce max count/length.
     * Checklist:
     *   - skip empty; clip tag length; cap to maxTagCount.
     */
    normalizeTags(tags) {
        if (!Array.isArray(tags)) {
            if (typeof Logger !== 'undefined' && Logger.debugLog) {
                Logger.debugLog(`[defensive] [normalizeTags] tags is not array: ${JSON.stringify(tags)}`);
            }
            return [];
        }
        const out = [];
        const seen = new Set();
        for (const t of tags) {
            const s = typeof t === 'string' ? t.trim().toLowerCase() : '';
            if (!s) continue;
            const clipped = s.slice(0, this.config.maxTagLength);
            if (seen.has(clipped)) continue;
            out.push(clipped);
            seen.add(clipped);
            if (out.length >= this.config.maxTagCount) break;
        }
        return out;
    }

    /**
     * normalizeCoPerformers(ids)
     * Description:
     *   Trim → dedupe; enforce max, id length <= 191.
     * Checklist:
     *   - skip empty; clip; cap to maxCoPerformers.
     */
    normalizeCoPerformers(ids) {
        if (!Array.isArray(ids)) {
            if (typeof Logger !== 'undefined' && Logger.debugLog) {
                Logger.debugLog(`[defensive] [normalizeCoPerformers] ids is not array: ${JSON.stringify(ids)}`);
            }
            return [];
        }
        const out = [];
        const seen = new Set();
        for (const id of ids) {
            const s = typeof id === 'string' ? id.trim() : '';
            if (!s) continue;
            const clipped = s.slice(0, 191);
            if (seen.has(clipped)) continue;
            out.push(clipped);
            seen.add(clipped);
            if (out.length >= this.config.maxCoPerformers) break;
        }
        return out;
    }

    // ============================================================================
    //                                   HANDLERS (4)
    // ============================================================================

    /**
     * handleAddMediaItem({ payload, actorUserId })
     * Description:
     *   Create a new media row and apply optional updates depending on payload presence.
     * Checklist:
     *   [ ] sanitizeValidateFirst(payload,'handleAddMediaItem')
     *   [ ] addRow (owner_user_id, media_type)
     *   [ ] Branch on presence: tags, coperformers, asset, poster, share flags, blur, ownership
     *   [ ] Log start/end and branch actions; reindex via addRow / subcalls
     */
    async handleAddMediaItem({payload, actorUserId}) {
        try {
            const mediaVersion = 1;
            const expectedVersion = 1;
            const clean = this.sanitizeValidateFirst(payload, 'handleAddMediaItem'); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [handleAddMediaItem] [START] Payload received: ${JSON.stringify(payload)}, actorUserId: ${actorUserId}`);

            const {media_id} = await this.addRow({...clean, actorUserId});
            clean.media_id = media_id;

            if (Array.isArray(clean.tags)) {
                Logger.debugLog?.(`[MediaHandler] [handleAddMediaItem] [BRANCH] setTags for mediaId: ${media_id}`);
                await this.setTags({
                    media_id,
                    expectedVersion,
                    mediaVersion,
                    tags: clean.tags,
                    actorUserId,
                });
            }

            if (Array.isArray(clean.coperformers)) {
                Logger.debugLog?.(`[MediaHandler] [handleAddMediaItem] [BRANCH] setCoPerformers for mediaId: ${media_id}`);
                await this.setCoPerformers({
                    media_id,
                    mediaVersion,
                    expectedVersion,
                    performerIds: clean.coperformers,
                    actorUserId,
                });
            }

            if (
                clean.asset_url ||
                clean.file_extension ||
                clean.file_name ||
                clean.file_size_bytes != null ||
                clean.duration_seconds != null ||
                clean.video_width != null ||
                clean.video_height != null ||
                clean.pending_conversion != null
            ) {
                Logger.debugLog?.(`[MediaHandler] [handleAddMediaItem] [BRANCH] attachPrimaryAsset for mediaId: ${media_id}`);
                await this.attachPrimaryAsset({
                    media_id,
                    mediaVersion,
                    expectedVersion,
                    ...clean,
                    actorUserId,
                });
            }

            if (clean.poster_url) {
                Logger.debugLog?.(`[MediaHandler] [handleAddMediaItem] [BRANCH] setPoster for mediaId: ${media_id}`);
                await this.setPoster({
                    media_id,
                    mediaVersion,
                    expectedVersion,
                    poster_url: clean.poster_url,
                    actorUserId,
                });
            }

            if (
                clean.placeholder_lock != null ||
                clean.blurred_lock != null ||
                clean.blurred_value_px != null ||
                clean.trailer_blurred_lock != null ||
                clean.trailer_blurred_value_px != null
            ) {
                Logger.debugLog?.(`[MediaHandler] [handleAddMediaItem] [BRANCH] applyBlurControls for mediaId: ${media_id}`);
                await this.applyBlurControls({
                    media_id,
                    mediaVersion,
                    expectedVersion,
                    placeholder_lock: clean.placeholder_lock,
                    blurred_lock: clean.blurred_lock,
                    blurred_value_px: clean.blurred_value_px,
                    trailer_blurred_lock: clean.trailer_blurred_lock,
                    trailer_blurred_value_px: clean.trailer_blurred_value_px,
                    actorUserId,
                });
            }

            if (clean.new_owner_user_id || clean.owner_user_id) {
                Logger.debugLog?.(`[MediaHandler] [handleAddMediaItem] [BRANCH] setOwnership for mediaId: ${media_id}`);
                await this.setOwnership({
                    media_id,
                    mediaVersion,
                    expectedVersion,
                    new_owner_user_id: clean.new_owner_user_id || clean.owner_user_id,
                    actorUserId,
                });
            }

            Logger.debugLog?.(`[MediaHandler] [handleAddMediaItem] [SUCCESS] Media item added with id ${media_id}`);
            return await this.getById({ media_id, includeTags: true, includeCoPerformers: true });
        } catch (error) {
            ErrorHandler.addError(`Error in handleAddMediaItem: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, actorUserId, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * handleUpdateMediaItem(payload)
     * Description:
     *   Single-call update that routes to specific setters based on payload presence.
     * Checklist:
     *   [ ] sanitizeValidateFirst(payload,'handleUpdateMediaItem')
     *   [ ] Branch: ownership, asset, poster, metadata, tags, coperformers, blur, soft/hard delete
     *   [ ] Log start/end and each branch taken
     */
    async handleUpdateMediaItem(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, 'handleUpdateMediaItem'); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [handleUpdateMediaItem] [START] Payload received: ${JSON.stringify(payload)}`);

            if (clean.new_owner_user_id || clean.owner_user_id) {
                Logger.debugLog?.(`[MediaHandler] [handleUpdateMediaItem] [BRANCH] setOwnership for mediaId: ${clean.media_id}`);
                const res = await this.setOwnership({
                    media_id: clean.media_id,
                    expectedVersion: clean.expectedVersion,
                    new_owner_user_id: clean.new_owner_user_id || clean.owner_user_id,
                    actorUserId: clean.actorUserId,
                });
                if (res && res.version) clean.expectedVersion = res.version;
            }
            if (
                clean.asset_url ||
                clean.file_extension ||
                clean.file_name ||
                clean.file_size_bytes != null ||
                clean.duration_seconds != null ||
                clean.video_width != null ||
                clean.video_height != null ||
                clean.pending_conversion != null
            ) {
                Logger.debugLog?.(`[MediaHandler] [handleUpdateMediaItem] [BRANCH] attachPrimaryAsset for mediaId: ${clean.media_id}`);
                const res = await this.attachPrimaryAsset({...clean});
                if (res && res.version) clean.expectedVersion = res.version;
            }
            if (clean.poster_url) {
                Logger.debugLog?.(`[MediaHandler] [handleUpdateMediaItem] [BRANCH] setPoster for mediaId: ${clean.media_id}`);
                const res = await this.setPoster({
                    media_id: clean.media_id,
                    expectedVersion: clean.expectedVersion,
                    poster_url: clean.poster_url,
                    actorUserId: clean.actorUserId,
                });
                if (res && res.version) clean.expectedVersion = res.version;
            }
            if (
                clean.title ||
                clean.description ||
                clean.visibility ||
                typeof clean.featured === 'boolean' ||
                typeof clean.coming_soon === 'boolean' ||
                clean.image_variants_json ||
                clean.gallery_poster_url ||
                clean.media_meta
            ) {
                Logger.debugLog?.(`[MediaHandler] [handleUpdateMediaItem] [BRANCH] updateMetadata for mediaId: ${clean.media_id}`);
                const res = await this.updateMetadata({...clean});
                if (res && res.version) clean.expectedVersion = res.version;
            }
            if (Array.isArray(clean.tags)) {
                Logger.debugLog?.(`[MediaHandler] [handleUpdateMediaItem] [BRANCH] setTags for mediaId: ${clean.media_id}`);
                const res = await this.setTags({
                    media_id: clean.media_id,
                    expectedVersion: clean.expectedVersion,
                    tags: clean.tags,
                    actorUserId: clean.actorUserId,
                });
                if (res && res.version) clean.expectedVersion = res.version;
            }
            if (Array.isArray(clean.coperformers)) {
                Logger.debugLog?.(`[MediaHandler] [handleUpdateMediaItem] [BRANCH] setCoPerformers for mediaId: ${clean.media_id}`);
                const res = await this.setCoPerformers({
                    media_id: clean.media_id,
                    expectedVersion: clean.expectedVersion,
                    performerIds: clean.coperformers,
                    actorUserId: clean.actorUserId,
                });
                if (res && res.version) clean.expectedVersion = res.version;
            }
            if (
                clean.placeholder_lock != null ||
                clean.blurred_lock != null ||
                clean.blurred_value_px != null ||
                clean.trailer_blurred_lock != null ||
                clean.trailer_blurred_value_px != null
            ) {
                Logger.debugLog?.(`[MediaHandler] [handleUpdateMediaItem] [BRANCH] applyBlurControls for mediaId: ${clean.media_id}`);
                const res = await this.applyBlurControls({...clean});
                if (res && res.version) clean.expectedVersion = res.version;
            }
            if (clean.soft_delete === true) {
                Logger.debugLog?.(`[MediaHandler] [handleUpdateMediaItem] [BRANCH] softDelete for mediaId: ${clean.media_id}`);
                await this.softDelete({
                    media_id: clean.media_id,
                    expectedVersion: clean.expectedVersion,
                    actorUserId: clean.actorUserId,
                });
            }
            if (clean.hard_delete === true) {
                Logger.debugLog?.(`[MediaHandler] [handleUpdateMediaItem] [BRANCH] hardDelete for mediaId: ${clean.media_id}`);
                await this.hardDelete({media_id: clean.media_id, actorUserId: clean.actorUserId});
            }

            Logger.debugLog?.(`[MediaHandler] [handleUpdateMediaItem] [SUCCESS] Media item updated with id ${clean.media_id}`);
            return await this.getById({ media_id: clean.media_id, includeTags: true, includeCoPerformers: true });
        } catch (error) {
            ErrorHandler.addError(`Error in handleUpdateMediaItem: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * handleScheduleMediaItem(payload)
     * Description:
     *   Validate schedule list for media_type (publish rules + publish_date>now); update to scheduled.
     * Checklist:
     *   [ ] sanitizeValidateFirst(payload,'handleScheduleMediaItem')
     *   [ ] load row; expect version
     *   [ ] enforceEventList('scheduleMediaItem', row with publish_date override)
     *   [ ] set status=scheduled; audit; reindex
     */
    async handleScheduleMediaItem(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, 'handleScheduleMediaItem'); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [handleScheduleMediaItem] [START] Payload received: ${JSON.stringify(payload)}`);

            return await this.db.withTransaction(this.connection, async (client) => {
                const result = await client.query(
                    `SELECT * FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );

                if (!result || result.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                const row = result.rows[0];
                this.expectVersion(row, clean.expectedVersion);

                const validateRow = {...row, publish_date: clean.publish_date};
                this.enforceEventList('scheduleMediaItem', validateRow);

                const now = DateTime.now(undefined, "UTC");
                const newVersion = (row.version || 0) + 1;
                await client.query(
                    `UPDATE media SET status='scheduled', publish_date=$2, last_updated=$3, updated_by_user_id=$4, version=$5 WHERE media_id=$1`,
                    [
                        clean.media_id,
                        clean.publish_date,
                        now,
                        payload.actorUserId || row.updated_by_user_id,
                        newVersion,
                    ],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.SCHEDULE,
                    beforeJson: {
                        status: row.status,
                        publish_date: row.publish_date,
                        version: row.version,
                    },
                    afterJson: {
                        status: 'scheduled',
                        publish_date: clean.publish_date,
                        version: newVersion,
                    },
                });

                await this.indexer.upsert(clean.media_id); // Implement elasticsearch here
                Logger.debugLog?.(`[MediaHandler] [handleScheduleMediaItem] [SUCCESS] Media item scheduled with id ${clean.media_id}`);
                return {
                    media_id: clean.media_id,
                    status: 'scheduled',
                    version: newVersion,
                    publish_date: clean.publish_date,
                };
            });
        } catch (error) {
            Logger.debugLog?.(`[MediaHandler] [handleScheduleMediaItem] [ROLLBACK] Transaction rolled back due to error: ${error.message}`);
            ErrorHandler.addError(`Error in handleScheduleMediaItem: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * handlePublishMediaItem(payload)
     * Description:
     *   Validate per-type publish rules; set status=published; publish_date default now if missing.
     * Checklist:
     *   [ ] sanitizeValidateFirst(payload,'handlePublishMediaItem')
     *   [ ] load row; expect version
     *   [ ] enforceEventList('publishMediaItem', row)
     *   [ ] set status=published; audit; reindex
     */
    async handlePublishMediaItem(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, 'handlePublishMediaItem'); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [handlePublishMediaItem] [START] Payload received: ${JSON.stringify(payload)}`);

            return await this.db.withTransaction(this.connection, async (client) => {
                const result = await client.query(
                    `SELECT * FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );

                if (!result || result.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }

                this.expectVersion(result.rows[0], clean.expectedVersion);
                this.enforceEventList('publishMediaItem', result.rows[0]);

                const now = DateTime.now(undefined, "UTC");
                const publishDate = result.rows[0].publish_date || now;
                const newVersion = (result.rows[0].version || 0) + 1;

                await client.query(
                    `UPDATE media SET status='published', publish_date=$2, last_updated=$3, updated_by_user_id=$4, version=$5 WHERE media_id=$1`,
                    [
                        clean.media_id,
                        publishDate,
                        now,
                        payload.actorUserId || result.rows[0].updated_by_user_id,
                        newVersion,
                    ],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.PUBLISH,
                    beforeJson: {
                        status: result.rows[0].status,
                        publish_date: result.rows[0].publish_date,
                        version: result.rows[0].version,
                    },
                    afterJson: {status: 'published', publish_date: publishDate, version: newVersion},
                });

                await this.indexer.upsert(clean.media_id); // Implement elasticsearch here
                Logger.debugLog?.(`[MediaHandler] [handlePublishMediaItem] [SUCCESS] Media item published with id ${clean.media_id}`);
                return {
                    media_id: clean.media_id,
                    status: 'published',
                    version: newVersion,
                    publish_date: publishDate,
                };
            });
        } catch (error) {
            Logger.debugLog?.(`[MediaHandler] [handlePublishMediaItem] [ROLLBACK] Transaction rolled back due to error: ${error.message}`);
            ErrorHandler.addError(`Error in handlePublishMediaItem: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    // ============================================================================
    //                         CORE METHODS (WRITES + READS)
    // ============================================================================

    /**
     * addRow({...})
     * Description:
     *   Insert a new media row (status=draft). One row per upload.
     * Checklist:
     *   [ ] sanitizeValidateFirst(payload,null)
     *   [ ] INSERT media
     *   [ ] INSERT tags/coperformers if present
     *   [ ] audit add
     *   [ ] ES upsert
     */
    async addRow(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, null); // FIRST LINE
            const now = DateTime.now(undefined, "UTC");
            const media_id = this.uuid.v4();

            // Defensive: Log all values being inserted into media table
            if (typeof Logger !== 'undefined' && Logger.debugLog) {
                Logger.debugLog('[defensive] [addRow] media insert values:', JSON.stringify({
                    media_id,
                    owner_user_id: clean.owner_user_id,
                    created_by_user_id: payload.actorUserId || null,
                    updated_by_user_id: payload.actorUserId || null,
                    media_type: clean.media_type,
                    visibility: clean.visibility || this.VISIBILITY.PRIVATE,
                    title: clean.title || '',
                    description: clean.description || '',
                    featured: !!clean.featured,
                    coming_soon: !!clean.coming_soon,
                    asset_url: clean.asset_url || null,
                    file_extension: clean.file_extension || null,
                    file_name: clean.file_name || null,
                    file_size_bytes: clean.file_size_bytes ?? null,
                    duration_seconds: clean.duration_seconds ?? null,
                    video_width: clean.video_width ?? null,
                    video_height: clean.video_height ?? null,
                    poster_url: clean.poster_url || null,
                    pending_conversion: !!clean.pending_conversion,
                    image_variants_json: clean.image_variants_json || null,
                    gallery_poster_url: clean.gallery_poster_url || null,
                    entry_date: now,
                    publish_date: now,
                    media_meta: clean.media_meta || null,
                    placeholder_lock: !!clean.placeholder_lock,
                    blurred_lock: !!clean.blurred_lock,
                    blurred_value_px: Math.max(0, Math.min(40, SafeUtils.sanitizeInteger(clean.blurred_value_px ?? 0) ?? 0)),
                    trailer_blurred_lock: !!clean.trailer_blurred_lock,
                    trailer_blurred_value_px: Math.max(0, Math.min(40, SafeUtils.sanitizeInteger(clean.trailer_blurred_value_px ?? 0) ?? 0)),
                }));

                // Defensive: Log config and key properties to diagnose null errors
                Logger.debugLog(`[defensive] [addRow] this.config: ${JSON.stringify(this.config)}`);
                if (this.config) {
                    Logger.debugLog(`[defensive] [addRow] this.config.maxJsonLength: ${this.config.maxJsonLength}`);
                    Logger.debugLog(`[defensive] [addRow] this.config.maxUrlLength: ${this.config.maxUrlLength}`);
                    Logger.debugLog(`[defensive] [addRow] this.config.maxTitleLength: ${this.config.maxTitleLength}`);
                    Logger.debugLog(`[defensive] [addRow] this.config.maxDescriptionLength: ${this.config.maxDescriptionLength}`);
                    Logger.debugLog(`[defensive] [addRow] this.config.maxDurationSeconds: ${this.config.maxDurationSeconds}`);
                }
            }

            Logger.debugLog?.(`[MediaHandler] [addRow] [START] owner_user_id: ${clean.owner_user_id}, media_type: ${clean.media_type}, actorUserId: ${payload.actorUserId}`);

            if (!clean.owner_user_id || !clean.media_type) {
                ErrorHandler.addError('owner_user_id and media_type required', { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { clean, payload } });
                throw new Error('owner_user_id and media_type required');
            }

            // Defensive: ensure tags/coperformers are arrays of strings
            let tagsArr = SafeUtils.sanitizeArray(clean.tags);
            let coperformersArr = SafeUtils.sanitizeArray(clean.coperformers);
            
            clean.tags = tagsArr.map(String);
            clean.coperformers = coperformersArr.map(String);

            await this.db.withTransaction(this.connection, async (client) => {
                await client.query(
                    `INSERT INTO media (
                                media_id, owner_user_id, created_by_user_id, updated_by_user_id, media_type, status, visibility,
                                title, description, featured, coming_soon,
                                asset_url, file_extension, file_name, file_size_bytes, duration_seconds, video_width, video_height,
                                poster_url, pending_conversion, image_variants_json, gallery_poster_url,
                                entry_date, publish_date, last_updated, version, is_deleted, deleted_at, media_meta,
                                placeholder_lock, blurred_lock, blurred_value_px, trailer_blurred_lock, trailer_blurred_value_px)
                        VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NULL,$23,1,false,NULL,$24,$25,$26,$27,$28,$29)`,
                    [
                        media_id,
                        clean.owner_user_id,
                        payload.actorUserId || null,
                        payload.actorUserId || null,
                        clean.media_type,
                        clean.visibility || this.VISIBILITY.PRIVATE,
                        clean.title || '',
                        clean.description || '',
                        !!clean.featured,
                        !!clean.coming_soon,
                        clean.asset_url || null,
                        clean.file_extension || null,
                        clean.file_name || null,
                        clean.file_size_bytes ?? null,
                        clean.duration_seconds ?? null,
                        clean.video_width ?? null,
                        clean.video_height ?? null,
                        clean.poster_url || null,
                        !!clean.pending_conversion,
                        clean.image_variants_json ? JSON.stringify(clean.image_variants_json) : null,
                        clean.gallery_poster_url || null,
                        now,
                        now,
                        clean.media_meta ? JSON.stringify(clean.media_meta) : null,
                        !!clean.placeholder_lock,
                        !!clean.blurred_lock,
                        Math.max(0, Math.min(40, SafeUtils.sanitizeInteger(clean.blurred_value_px ?? 0) ?? 0)),
                        !!clean.trailer_blurred_lock,
                        Math.max(0, Math.min(40, SafeUtils.sanitizeInteger(clean.trailer_blurred_value_px ?? 0) ?? 0)),
                    ],
                );

                if (clean.tags.length) {
                    for (const tag of clean.tags) {
                        await client.query(
                            `INSERT INTO media_tags (media_id, tag) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                            [media_id, tag],
                        );
                    }
                }
                if (clean.coperformers.length) {
                    for (const performerId of clean.coperformers) {
                        await client.query(
                            `INSERT INTO media_coperformers (media_id, performer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                            [media_id, performerId],
                        );
                    }
                }

                await this.writeAudit(client, {
                    mediaId: media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.ADD,
                    beforeJson: null,
                    afterJson: {created: true, media_type: clean.media_type},
                });
            });

            await this.indexer.upsert(media_id); // Implement elasticsearch here
            Logger.debugLog?.(`[MediaHandler] [addRow] [SUCCESS] Media row added with id ${media_id}`);
            return await this.getById({ media_id, includeTags: true, includeCoPerformers: true });
        } catch (error) {
            Logger.debugLog?.(`[MediaHandler] [addRow] [ERR] ${error.message}`);
            ErrorHandler.addError(`Error in addRow: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * updateMetadata({...})
     * Description:
     *   Partial metadata fields update (title/description/visibility/etc.) with version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] load row; expectVersion
     *   [ ] dynamic SET; bump version/time; audit; ES upsert
     */
    async updateMetadata(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, null); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [updateMetadata] [START] Payload received: ${JSON.stringify(payload)}`);

            return await this.db.withTransaction(this.connection, async (client) => {
                const result = await client.query(
                    `SELECT * FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );

                if (!result || result.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                if (clean.expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { clean } });
                    throw new Error('expectedVersion required');
                }

                this.expectVersion(result.rows[0], clean.expectedVersion);

                const set = [];
                const vals = [clean.media_id];
                let i = 2;

                const add = (k, v) => {
                    if (v !== undefined) {
                        set.push(`${k}=$${i++}`);
                        vals.push(v);
                    }
                };
                add('title', clean.title);
                add('description', clean.description);
                add('visibility', clean.visibility);

                if (typeof clean.featured === 'boolean') add('featured', clean.featured);
                if (typeof clean.coming_soon === 'boolean') add('coming_soon', clean.coming_soon);

                if (clean.image_variants_json) add('image_variants_json', JSON.stringify(clean.image_variants_json));
                add('gallery_poster_url', clean.gallery_poster_url);
                if (clean.media_meta) add('media_meta', JSON.stringify(clean.media_meta));

                const now = DateTime.now(undefined, "UTC");
                const newVersion = (result.rows[0].version || 0) + 1;

                set.push(`version=$${i++}`);
                vals.push(newVersion);
                set.push(`last_updated=$${i++}`);
                vals.push(now);

                if (set.length) {
                    Logger.debugLog?.(`[MediaHandler] [updateMetadata] [BRANCH] updating fields for mediaId: ${clean.media_id}`);
                    await client.query(
                        `UPDATE media SET ${set.join(', ')}, updated_by_user_id=$${i} WHERE media_id=$1`,
                        [...vals, payload.actorUserId || result.rows[0].updated_by_user_id],
                    );
                }

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.UPDATE,
                    beforeJson: {version: result.rows[0].version},
                    afterJson: {version: newVersion, fields: set.map((s) => s.split('=')[0])},
                });

                await this.indexer.upsert(clean.media_id); // Implement elasticsearch here
                Logger.debugLog?.(`[MediaHandler] [updateMetadata] [SUCCESS] Metadata updated for mediaId: ${clean.media_id}, version: ${newVersion}`);
                return {media_id: clean.media_id, version: newVersion};
            });
        } catch (error) {
            Logger.debugLog?.(`[MediaHandler] [updateMetadata] [ROLLBACK] Transaction rolled back due to error: ${error.message}`);
            ErrorHandler.addError(`Error in updateMetadata: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * addNote({...})
     * Description:
     *   Append a note to media.notes (like moderation notes); version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] load row; expectVersion
     *   [ ] append note; bump; audit; ES upsert
     */
    async addNote(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, null); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [addNote] [START] Payload received: ${JSON.stringify(payload)}`);

            if (!clean.media_id) {
                ErrorHandler.addError('media_id required', { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { payload } });
                throw new Error('media_id required');
            }
            if (!clean.note) {
                ErrorHandler.addError('note required', { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { payload } });
                throw new Error('note required');
            }

            const addedBy = clean.addedBy || clean.actorUserId;
            if (!addedBy) {
                ErrorHandler.addError('addedBy required', { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { payload } });
                throw new Error('addedBy required');
            }

            const isPublic = typeof clean.isPublic === 'boolean' ? clean.isPublic : false;

            return await this.db.withTransaction(this.connection, async (client) => {
                const result = await client.query(
                    `SELECT media_id, version, updated_by_user_id, notes FROM media WHERE media_id=$1 AND is_deleted=false FOR UPDATE`,
                    [clean.media_id],
                );

                if (!result || result.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                if (clean.expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { clean } });
                    throw new Error('expectedVersion required');
                }

                this.expectVersion(result.rows[0], clean.expectedVersion);

                const existingNotes = Array.isArray(result.rows[0].notes) ? result.rows[0].notes : [];
                if (existingNotes.length >= this.config.maxNotesPerItem) {
                    ErrorHandler.addError(`Maximum notes limit (${this.config.maxNotesPerItem}) reached`, { code: "LIMIT_EXCEEDED", origin: "MediaHandler", data: { media_id: clean.media_id, maxNotes: this.config.maxNotesPerItem } });
                    throw new Error(`Maximum notes limit (${this.config.maxNotesPerItem}) reached. Consider archiving old notes before adding new ones.`);
                }

                const now = DateTime.now(undefined, "UTC");
                const newNote = {
                    text: clean.note,
                    addedBy,
                    addedAt: now,
                    isPublic,
                };

                const updatedNotes = [...existingNotes, newNote];
                const newVersion = (result.rows[0].version || 0) + 1;

                await client.query(
                    `UPDATE media SET notes=$2, version=$3, last_updated=$4, updated_by_user_id=$5 WHERE media_id=$1`,
                    [
                        clean.media_id,
                        JSON.stringify(updatedNotes),
                        newVersion,
                        now,
                        payload.actorUserId || result.rows[0].updated_by_user_id,
                    ],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId || addedBy,
                    action: this.ACTION.NOTE_ADD,
                    beforeJson: { version: result.rows[0].version, notesCount: existingNotes.length },
                    afterJson: { version: newVersion, notesCount: updatedNotes.length, isPublic },
                });

                await this.indexer.upsert(clean.media_id); // Implement elasticsearch here

                Logger.writeLog({
                    flag: "MEDIA",
                    action: "noteAdded",
                    data: {
                        mediaId: clean.media_id,
                        addedBy,
                        isPublic,
                        noteLength: clean.note.length,
                    },
                });

                Logger.debugLog?.(`[MediaHandler] [addNote] [SUCCESS] Note added for mediaId: ${clean.media_id}, version: ${newVersion}`);
                return { media_id: clean.media_id, version: newVersion, notesCount: updatedNotes.length };
            });
        } catch (error) {
            ErrorHandler.addError(`Error in addNote: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack },
            });
            throw error;
        }
    }

    /**
     * attachPrimaryAsset({...})
     * Description:
     *   Set/replace primary asset, file/duration/resolution/pending flags; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] load row; expectVersion
     *   [ ] update asset fields; audit; ES upsert
     */
    async attachPrimaryAsset(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, null); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [attachPrimaryAsset] [START] Payload received: ${JSON.stringify(payload)}`);

            return await this.db.withTransaction(this.connection, async (client) => {
                const result = await client.query(
                    `SELECT * FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );

                if (!result || result.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                if (clean.expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { clean } });
                    throw new Error('expectedVersion required');
                }

                this.expectVersion(result.rows[0], clean.expectedVersion);

                const set = [];
                const values = [clean.media_id];
                let paramIndex = 2; // start from 2 because media_id is $1

                const add = (key, value) => {
                    if (value !== undefined) {
                        set.push(`${key}=$${paramIndex++}`);
                        values.push(value);
                    }
                };

                add('asset_url', clean.asset_url);
                add('file_extension', clean.file_extension);
                add('file_name', clean.file_name);
                add('file_size_bytes', clean.file_size_bytes);
                add('duration_seconds', clean.duration_seconds);
                add('video_width', clean.video_width);
                add('video_height', clean.video_height);

                if (typeof clean.pending_conversion === 'boolean')
                    add('pending_conversion', clean.pending_conversion);

                const now = DateTime.now(undefined, "UTC");
                const newVersion = payload?.mediaVersion ?? (result.rows[0].version || 0) + 1;

                set.push(`version=$${paramIndex++}`);
                values.push(newVersion);

                set.push(`last_updated=$${paramIndex++}`);
                values.push(now);

                if (set.length) {
                    Logger.debugLog?.(`[MediaHandler] [attachPrimaryAsset] [BRANCH] updating asset fields for mediaId: ${clean.media_id}`);
                    await client.query(
                        `UPDATE media SET ${set.join(', ')}, updated_by_user_id=$${paramIndex} WHERE media_id=$1`,
                        [...values, payload.actorUserId || result.rows[0].updated_by_user_id],
                    );
                }

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.ASSET_ATTACH,
                    beforeJson: {version: result.rows[0].version},
                    afterJson: {version: newVersion, asset_updated: true},
                });

                await this.indexer.upsert(clean.media_id); // Implement elasticsearch here
                Logger.debugLog?.(`[MediaHandler] [attachPrimaryAsset] [SUCCESS] Primary asset attached for mediaId: ${clean.media_id}, version: ${newVersion}`);
                return {media_id: clean.media_id, version: newVersion};
            });
        } catch (error) {
            Logger.debugLog?.(`[MediaHandler] [attachPrimaryAsset] [ROLLBACK] Transaction rolled back due to error: ${error.message}`);
            ErrorHandler.addError(`Error in attachPrimaryAsset: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * setPoster({...})
     * Description:
     *   Update poster_url; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] load row; expectVersion
     *   [ ] update poster_url; audit; ES upsert
     */
    async setPoster(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, null); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [setPoster] [START] Payload received: ${JSON.stringify(payload)}`);

            return await this.db.withTransaction(this.connection, async (client) => {
                const results = await client.query(
                    `SELECT * FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );

                if (!results || results?.rows?.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                if (clean.expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { clean } });
                    throw new Error('expectedVersion required');
                }

                this.expectVersion(results.rows[0], clean.expectedVersion);

                const now = DateTime.now(undefined, "UTC");
                const newVersion = payload?.mediaVersion ?? (results.rows[0].version || 0) + 1;

                Logger.debugLog?.(`[MediaHandler] [setPoster] [BRANCH] updating poster for mediaId: ${clean.media_id}`);
                await client.query(
                    `UPDATE media SET poster_url=$2, last_updated=$3, updated_by_user_id=$4, version=$5 WHERE media_id=$1`,
                    [
                        clean.media_id,
                        clean.poster_url,
                        now,
                        payload.actorUserId || results.rows[0].updated_by_user_id,
                        newVersion,
                    ],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.POSTER_SET,
                    beforeJson: {
                        poster_url: results.rows[0].poster_url,
                        version: results.rows[0].version,
                    },
                    afterJson: {poster_url: clean.poster_url, version: newVersion},
                });

                await this.indexer.upsert(clean.media_id); // Implement elasticsearch here

                Logger.debugLog?.(`[MediaHandler] [setPoster] [SUCCESS] Poster set for mediaId: ${clean.media_id}, version: ${newVersion}`);
                return {media_id: clean.media_id, version: newVersion};
            });
        } catch (error) {
            Logger.debugLog?.(`[MediaHandler] [setPoster] [ROLLBACK] Transaction rolled back due to error: ${error.message}`);
            ErrorHandler.addError(`Error in setPoster: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * applyBlurControls({...})
     * Description:
     *   Update placeholder/blur flags + intensities; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] load row; expectVersion
     *   [ ] write flags; audit; ES upsert
     */
    async applyBlurControls(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, null); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [applyBlurControls] [START] Payload received: ${JSON.stringify(payload)}`);

            return await this.db.withTransaction(this.connection, async (client) => {
                const results = await client.query(
                    `SELECT * FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );

                if (!results || results.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                if (clean.expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { clean } });
                    throw new Error('expectedVersion required');
                }
                this.expectVersion(results.rows[0], clean.expectedVersion);

                const now = DateTime.now(undefined, "UTC");
                const newVersion = payload?.mediaVersion ?? (results.rows[0].version || 0) + 1;

                Logger.debugLog?.(`[MediaHandler] [applyBlurControls] [BRANCH] applying blur controls for mediaId: ${clean.media_id}`);
                await client.query(
                    `UPDATE media
                     SET
                         placeholder_lock=COALESCE($2, placeholder_lock),
                         blurred_lock=COALESCE($3, blurred_lock),
                         blurred_value_px=COALESCE($4, blurred_value_px),
                         trailer_blurred_lock=COALESCE($5, trailer_blurred_lock),
                         trailer_blurred_value_px=COALESCE($6, trailer_blurred_value_px),
                         last_updated=$7, updated_by_user_id=$8, version=$9
                     WHERE media_id=$1`,
                    [
                        clean.media_id,
                        typeof clean.placeholder_lock === 'boolean' ? clean.placeholder_lock : null,
                        typeof clean.blurred_lock === 'boolean' ? clean.blurred_lock : null,
                        typeof clean.blurred_value_px === 'number' ? clean.blurred_value_px : null,
                        typeof clean.trailer_blurred_lock === 'boolean'
                            ? clean.trailer_blurred_lock
                            : null,
                        typeof clean.trailer_blurred_value_px === 'number'
                            ? clean.trailer_blurred_value_px
                            : null,
                        now,
                        payload.actorUserId || results.rows[0].updated_by_user_id,
                        newVersion,
                    ],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.BLUR_APPLY,
                    beforeJson: {version: results.rows[0].version},
                    afterJson: {version: newVersion},
                });

                await this.indexer.upsert(clean.media_id); // Implement elasticsearch here

                Logger.debugLog?.(`[MediaHandler] [applyBlurControls] [SUCCESS] Blur controls applied for mediaId: ${clean.media_id}, version: ${newVersion}`);
                return {media_id: clean.media_id, version: newVersion};
            });
        } catch (error) {
            Logger.debugLog?.(`[MediaHandler] [applyBlurControls] [ROLLBACK] Transaction rolled back due to error: ${error.message}`);
            ErrorHandler.addError(`Error in applyBlurControls: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * setVisibility({...})
     * Description:
     *   Update visibility enum; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] _simpleFieldUpdate(visibility)
     */
    async setVisibility(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, null); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [setVisibility] [START] Payload received: ${JSON.stringify(payload)}`);

            const res = await this._simpleFieldUpdate({
                media_id: clean.media_id,
                expectedVersion: clean.expectedVersion,
                fields: {visibility: clean.visibility},
                actorUserId: payload.actorUserId,
                action: this.ACTION.VISIBILITY,
            });

            Logger.debugLog?.(`[MediaHandler] [setVisibility] [SUCCESS] Visibility set for mediaId: ${clean.media_id}, version: ${res.version}`);
            return res;
        } catch (error) {
            ErrorHandler.addError(`Error in setVisibility: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * setFeatured({...})
     * Description:
     *   Toggle featured; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] _simpleFieldUpdate(featured)
     */
    async setFeatured(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, null); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [setFeatured] [START] Payload received: ${JSON.stringify(payload)}`);

            const res = await this._simpleFieldUpdate({
                media_id: clean.media_id,
                expectedVersion: clean.expectedVersion,
                fields: {featured: !!clean.featured},
                actorUserId: payload.actorUserId,
                action: this.ACTION.FEATURED,
            });

            Logger.debugLog?.(`[MediaHandler] [setFeatured] [SUCCESS] Featured set for mediaId: ${clean.media_id}, version: ${res.version}`);
            return res;
        } catch (error) {
            ErrorHandler.addError(`Error in setFeatured: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * setComingSoon({...})
     * Description:
     *   Toggle coming_soon; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] _simpleFieldUpdate(coming_soon)
     */
    async setComingSoon(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, null); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [setComingSoon] [START] Payload received: ${JSON.stringify(payload)}`);

            const res = await this._simpleFieldUpdate({
                media_id: clean.media_id,
                expectedVersion: clean.expectedVersion,
                fields: {coming_soon: !!clean.coming_soon},
                actorUserId: payload.actorUserId,
                action: this.ACTION.COMING_SOON,
            });

            Logger.debugLog?.(`[MediaHandler] [setComingSoon] [SUCCESS] Coming soon set for mediaId: ${clean.media_id}, version: ${res.version}`);
            return res;
        } catch (error) {
            ErrorHandler.addError(`Error in setComingSoon: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * setTags({...})
     * Description:
     *   Replace entire tag set atomically; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] load row; expectVersion
     *   [ ] delete old, insert new; audit; ES upsert
     */
    async setTags(payload) {
        try {
            const clean = this.sanitizeValidateFirst(payload, null); // FIRST LINE

            Logger.debugLog?.(`[MediaHandler] [setTags] [START] Payload received: ${JSON.stringify(payload)}`);

            return await this.db.withTransaction(this.connection, async (client) => {
                const results = await client.query(
                    `SELECT media_id, version, updated_by_user_id FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );

                if (!results || results.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                if (clean.expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { clean } });
                    throw new Error('expectedVersion required');
                }

                this.expectVersion(results.rows[0], clean.expectedVersion);

                Logger.debugLog?.(`[MediaHandler] [setTags] [BRANCH] deleting old tags and inserting new for mediaId: ${clean.media_id}`);
                await client.query(`DELETE FROM media_tags WHERE media_id=$1`, [clean.media_id]);

                if (clean.tags?.length) {
                    await client.query(
                        `INSERT INTO media_tags (media_id, tag) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                        [clean.media_id, clean.tags[0]],
                    );

                    for (let i = 1; i < clean.tags.length; i++) {
                        await client.query(
                            `INSERT INTO media_tags (media_id, tag) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                            [clean.media_id, clean.tags[i]],
                        );
                    }
                }

                const now = DateTime.now(undefined, "UTC");
                const newVersion = payload?.mediaVersion ?? (results.rows[0].version || 0) + 1;

                await client.query(
                    `UPDATE media SET version=$2, last_updated=$3, updated_by_user_id=$4 WHERE media_id=$1`,
                    [
                        clean.media_id,
                        newVersion,
                        now,
                        payload.actorUserId || results.rows[0].updated_by_user_id,
                    ],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.TAGS_REPLACE,
                    beforeJson: {version: results.rows[0].version},
                    afterJson: {version: newVersion, tags: clean.tags},
                });

                await this.indexer.upsert(clean.media_id); // Implement elasticsearch here

                Logger.debugLog?.(`[MediaHandler] [setTags] [SUCCESS] Tags set for mediaId: ${clean.media_id}, version: ${newVersion}`);
                return {media_id: clean.media_id, version: newVersion};
            });
        } catch (error) {
            ErrorHandler.addError(`Error in setTags: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * addTag({...})
     * Description:
     *   Add a single tag if missing; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] load row; expectVersion
     *   [ ] upsert tag; bump; audit; ES upsert
     */
    async addTag(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            expectedVersion: { value: payload.expectedVersion, type: "int", required: true },
            tag: { value: payload.tag, type: "string", required: true },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [addTag] [START] Payload received: ${JSON.stringify(payload)}`);

        // Original tag normalization retained because SafeUtils does not support tag-specific validation
        const tag = this.normalizeTags([payload.tag ?? ''])[0];
        if (!tag) {
            ErrorHandler.addError('Invalid tag', { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { payload, clean } });
            throw new Error('Invalid tag');
        }

        try {
            return await this.db.withTransaction(this.connection, async (client) => {
                const result = await client.query(
                    `SELECT media_id, version, updated_by_user_id FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );

                if (!result || result.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                if (clean.expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { clean } });
                    throw new Error('expectedVersion required');
                }

                this.expectVersion(result.rows[0], clean.expectedVersion);

                Logger.debugLog?.(`[MediaHandler] [addTag] [BRANCH] inserting tag for mediaId: ${clean.media_id}`);
                await client.query(
                    `INSERT INTO media_tags (media_id, tag) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                    [clean.media_id, tag],
                );

                const now = DateTime.now(undefined, "UTC");
                const newVersion = (result.rows[0].version || 0) + 1;

                await client.query(
                    `UPDATE media SET version=$2, last_updated=$3, updated_by_user_id=$4 WHERE media_id=$1`,
                    [clean.media_id, newVersion, now, payload.actorUserId || result.rows[0].updated_by_user_id],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.TAG_ADD,
                    beforeJson: {version: result.rows[0].version},
                    afterJson: {version: newVersion, tag},
                });

                await this.indexer.upsert(clean.media_id); // Implement elasticsearch here

                Logger.writeLog({
                    flag: "MEDIA",
                    action: "tagAdded",
                    data: {
                        mediaId: clean.media_id,
                        tag,
                        actorUserId: payload.actorUserId
                    }
                });

                Logger.debugLog?.(`[MediaHandler] [addTag] [SUCCESS] Tag added for mediaId: ${clean.media_id}, version: ${newVersion}`);
                return {media_id: clean.media_id, version: newVersion};
            });
        } catch (error) {
            ErrorHandler.addError(`Error in addTag: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * removeTag({...})
     * Description:
     *   Remove a single tag; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] load row; expectVersion
     *   [ ] delete tag; bump; audit; ES upsert
     */
    async removeTag(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            expectedVersion: { value: payload.expectedVersion, type: "int", required: true },
            tag: { value: payload.tag, type: "string", required: true },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [removeTag] [START] Payload received: ${JSON.stringify(payload)}`);

        // Original tag normalization retained because SafeUtils does not support tag-specific validation
        const tag = this.normalizeTags([payload.tag ?? ''])[0];
        if (!tag) {
            ErrorHandler.addError('Invalid tag', { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { payload, clean } });
            throw new Error('Invalid tag');
        }

        try {
            return await this.db.withTransaction(this.connection, async (client) => {
                const result = await client.query(
                    `SELECT media_id, version, updated_by_user_id FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );

                if (!result || result.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                if (clean.expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { clean } });
                    throw new Error('expectedVersion required');
                }

                this.expectVersion(result.rows[0], clean.expectedVersion);

                Logger.debugLog?.(`[MediaHandler] [removeTag] [BRANCH] deleting tag for mediaId: ${clean.media_id}`);
                await client.query(`DELETE FROM media_tags WHERE media_id=$1 AND tag=$2`, [
                    clean.media_id,
                    tag,
                ]);

                const now = DateTime.now(undefined, "UTC");
                const newVersion = (result.rows[0].version || 0) + 1;
                await client.query(
                    `UPDATE media SET version=$2, last_updated=$3, updated_by_user_id=$4 WHERE media_id=$1`,
                    [clean.media_id, newVersion, now, payload.actorUserId || result.rows[0].updated_by_user_id],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.TAG_REMOVE,
                    beforeJson: {version: result.rows[0].version},
                    afterJson: {version: newVersion, removed: tag},
                });

                await this.indexer.upsert(clean.media_id);

                Logger.writeLog({
                    flag: "MEDIA",
                    action: "tagRemoved",
                    data: {
                        mediaId: clean.media_id,
                        tag,
                        actorUserId: payload.actorUserId
                    }
                });

                Logger.debugLog?.(`[MediaHandler] [removeTag] [SUCCESS] Tag removed for mediaId: ${clean.media_id}, version: ${newVersion}`);
                return {media_id: clean.media_id, version: newVersion};
            });
        } catch (error) {
            ErrorHandler.addError(`Error in removeTag: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * setCoPerformers({...})
     * Description:
     *   Replace coperformers array atomically; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] load row; expectVersion
     *   [ ] delete old; insert new; audit; ES upsert
     */
    async setCoPerformers(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            expectedVersion: { value: payload.expectedVersion, type: "int", required: true },
            performerIds: { value: payload.performerIds, type: "array", required: false },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [setCoPerformers] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            return await this.db.withTransaction(this.connection, async (client) => {
                const results = await client.query(
                    `SELECT media_id, version, updated_by_user_id FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );

                if (!results || results.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                if (clean.expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { clean } });
                    throw new Error('expectedVersion required');
                }

                this.expectVersion(results.rows[0], clean.expectedVersion);

                Logger.debugLog?.(`[MediaHandler] [setCoPerformers] [BRANCH] Replacing co-performers for mediaId: ${clean.media_id}`);
                await client.query(`DELETE FROM media_coperformers WHERE media_id=$1`, [
                    clean.media_id,
                ]);

                if (clean.performerIds?.length) {
                    await client.query(
                        `INSERT INTO media_coperformers (media_id, performer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                        [clean.media_id, clean.performerIds[0]],
                    );

                    for (let i = 1; i < clean.performerIds.length; i++) {
                        await client.query(
                            `INSERT INTO media_coperformers (media_id, performer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                            [clean.media_id, clean.performerIds[i]],
                        );
                    }
                }

                const now = DateTime.now(undefined, "UTC");
                const newVersion = payload?.mediaVersion ?? (results.rows[0].version || 0) + 1;

                await client.query(
                    `UPDATE media SET version=$2, last_updated=$3, updated_by_user_id=$4 WHERE media_id=$1`,
                    [
                        clean.media_id,
                        newVersion,
                        now,
                        payload.actorUserId || results.rows[0].updated_by_user_id,
                    ],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.COPERFORMERS_REPLACE,
                    beforeJson: {version: results.rows[0].version},
                    afterJson: {version: newVersion, coperformers: clean.performerIds},
                });

                await this.indexer.upsert(clean.media_id); // Implement elasticsearch here

                Logger.writeLog({
                    flag: "MEDIA",
                    action: "coPerformersSet",
                    data: {
                        mediaId: clean.media_id,
                        performerIds: clean.performerIds,
                        actorUserId: payload.actorUserId
                    }
                });

                Logger.debugLog?.(`[MediaHandler] [setCoPerformers] [SUCCESS] Co-performers set for mediaId: ${clean.media_id}, version: ${newVersion}`);
                return {media_id: clean.media_id, version: newVersion};
            });
        } catch (error) {
            ErrorHandler.addError(`Error in setCoPerformers: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * setOwnership({...})
     * Description:
     *   Transfer ownership to new_owner_user_id; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] _simpleFieldUpdate(owner_user_id)
     */
    async setOwnership(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            expectedVersion: { value: payload.expectedVersion, type: "int", required: true },
            new_owner_user_id: { value: payload.new_owner_user_id, type: "string", required: true },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [setOwnership] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const result = await this._simpleFieldUpdate({
                media_id: clean.media_id,
                mediaVersion: payload?.mediaVersion,
                expectedVersion: clean.expectedVersion,
                fields: {owner_user_id: clean.new_owner_user_id},
                actorUserId: payload.actorUserId,
                action: this.ACTION.OWNERSHIP,
            });

            Logger.writeLog({
                flag: "MEDIA",
                action: "ownershipTransferred",
                data: {
                    mediaId: clean.media_id,
                    newOwnerUserId: clean.new_owner_user_id,
                    actorUserId: payload.actorUserId
                }
            });

            Logger.debugLog?.(`[MediaHandler] [setOwnership] [SUCCESS] Ownership set for mediaId: ${clean.media_id}, version: ${result.version}`);
            return result;
        } catch (error) {
            ErrorHandler.addError(`Error in setOwnership: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * setCustomMeta({...})
     * Description:
     *   Replace or merge media_meta JSON; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] load row; expectVersion
     *   [ ] merge(if merge=true) or replace; audit; ES upsert
     */
    async setCustomMeta(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            expectedVersion: { value: payload.expectedVersion, type: "int", required: true },
            merge: { value: payload.merge, type: "boolean", required: false },
            media_meta: { value: payload.media_meta, type: "object", required: false },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [setCustomMeta] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            return await this.db.withTransaction(this.connection, async (client) => {
                const result = await client.query(
                    `SELECT media_id, media_meta, version, updated_by_user_id FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );

                if (!result || result.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                if (clean.expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { clean } });
                    throw new Error('expectedVersion required');
                }

                this.expectVersion(result.rows[0], clean.expectedVersion);

                const next = clean.merge
                    ? {...(result.rows[0].media_meta || {}), ...(clean.media_meta || {})}
                    : clean.media_meta || {};

                const now = DateTime.now(undefined, "UTC");
                const newVersion = (result.rows[0].version || 0) + 1;

                await client.query(
                    `UPDATE media SET media_meta=$2, last_updated=$3, updated_by_user_id=$4, version=$5 WHERE media_id=$1`,
                    [
                        clean.media_id,
                        JSON.stringify(next),
                        now,
                        payload.actorUserId || result.rows[0].updated_by_user_id,
                        newVersion,
                    ],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.UPDATE,
                    beforeJson: {version: result.rows[0].version, media_meta: result.rows[0].media_meta},
                    afterJson: {version: newVersion, media_meta: next},
                });

                await this.indexer.upsert(clean.media_id); // Implement elasticsearch here

                Logger.writeLog({
                    flag: "MEDIA",
                    action: "customMetaSet",
                    data: {
                        mediaId: clean.media_id,
                        merge: clean.merge,
                        mediaMeta: next,
                        actorUserId: payload.actorUserId
                    }
                });

                Logger.debugLog?.(`[MediaHandler] [setCustomMeta] [SUCCESS] Custom meta set for mediaId: ${clean.media_id}, version: ${newVersion}`);
                return {media_id: clean.media_id, version: newVersion};
            });
        } catch (error) {
            ErrorHandler.addError(`Error in setCustomMeta: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * softDelete({...})
     * Description:
     *   Soft delete: is_deleted=true, status='deleted'; version bump.
     * Checklist:
     *   [ ] SafeUtils.sanitizeValidate
     *   [ ] load row; expectVersion
     *   [ ] mark deleted; audit; ES delete
     */
    async softDelete(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            expectedVersion: { value: payload.expectedVersion, type: "int", required: true },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [softDelete] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            return await this.db.withTransaction(this.connection, async (client) => {
                const result = await client.query(
                    `SELECT * FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );

                if (!result || result.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                if (clean.expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { clean } });
                    throw new Error('expectedVersion required');
                }

                this.expectVersion(result.rows[0], clean.expectedVersion);

                const now = DateTime.now(undefined, "UTC");
                const newVersion = (result.rows[0].version || 0) + 1;

                await client.query(
                    `UPDATE media SET is_deleted=true, status='deleted', deleted_at=$2, last_updated=$2, updated_by_user_id=$3, version=$4 WHERE media_id=$1`,
                    [clean.media_id, now, payload.actorUserId || result.rows[0].updated_by_user_id, newVersion],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.SOFT_DELETE,
                    beforeJson: {
                        status: result.rows[0].status,
                        is_deleted: result.rows[0].is_deleted,
                        version: result.rows[0].version,
                    },
                    afterJson: {status: 'deleted', is_deleted: true, version: newVersion},
                });

                await this.indexer.delete(clean.media_id); // Implement elasticsearch here

                Logger.writeLog({
                    flag: "MEDIA",
                    action: "softDeleted",
                    data: {
                        mediaId: clean.media_id,
                        actorUserId: payload.actorUserId
                    }
                });

                Logger.debugLog?.(`[MediaHandler] [softDelete] [SUCCESS] Media soft deleted for mediaId: ${clean.media_id}, version: ${newVersion}`);
                return {media_id: clean.media_id, is_deleted: true, version: newVersion};
            });
        } catch (error) {
            ErrorHandler.addError(`Error in softDelete: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * hardDelete({...})
     * Description:
     *   Hard delete media + children; remove ES doc.
     * Checklist:
     *   [ ] SafeUtils.sanitizeValidate
     *   [ ] delete children then media
     *   [ ] audit; ES delete
     */
    async hardDelete(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [hardDelete] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            return await this.db.withTransaction(this.connection, async (client) => {
                await client.query(`DELETE FROM media_tags WHERE media_id=$1`, [clean.media_id]);
                await client.query(`DELETE FROM media_coperformers WHERE media_id=$1`, [
                    clean.media_id,
                ]);
                await client.query(`DELETE FROM media_reminders WHERE media_id=$1`, [clean.media_id]);
                await client.query(`DELETE FROM media_audit WHERE media_id=$1`, [clean.media_id]);
                await client.query(`DELETE FROM collection_media WHERE media_id=$1`, [clean.media_id]);
                await client.query(`DELETE FROM media WHERE media_id=$1`, [clean.media_id]);

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.HARD_DELETE,
                    beforeJson: null,
                    afterJson: {hard_deleted: true},
                });

                await this.indexer.delete(clean.media_id); // Implement elasticsearch here

                Logger.writeLog({
                    flag: "MEDIA",
                    action: "hardDeleted",
                    data: {
                        mediaId: clean.media_id,
                        actorUserId: payload.actorUserId
                    }
                });

                Logger.debugLog?.(`[MediaHandler] [hardDelete] [SUCCESS] Media hard deleted with id ${clean.media_id}`);
                return {media_id: clean.media_id, deleted: true};
            });
        } catch (error) {
            ErrorHandler.addError(`Error in hardDelete: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * getById({...})
     * Description:
     *   Fetch single media row; optionally include tags/coperformers.
     * Checklist:
     *   [ ] SafeUtils.sanitizeValidate
     *   [ ] select row; append relations if requested
     */
    async getById(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            includeTags: { value: payload.includeTags, type: "bool", required: false },
            includeCoPerformers: { value: payload.includeCoPerformers, type: "bool", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [getById] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const row = await this.db.getRow(
                this.connection,
                `SELECT * FROM media WHERE media_id=$1 AND is_deleted=false`,
                [clean.media_id],
            );

            if (!row) {
                ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                throw new Error('Media not found');
            }

            if (clean.includeTags) {
                row.tags = (
                    await this.db.getAll(
                        this.connection,
                        `SELECT tag FROM media_tags WHERE media_id=$1 ORDER BY tag`,
                        [clean.media_id],
                    )
                ).map((r) => r.tag);
            }

            if (clean.includeCoPerformers) {
                row.coperformers = (
                    await this.db.getAll(
                        this.connection,
                        `SELECT performer_id FROM media_coperformers WHERE media_id=$1 ORDER BY performer_id`,
                        [clean.media_id],
                    )
                ).map((r) => r.performer_id);
            }

            Logger.debugLog?.(`[MediaHandler] [getById] [SUCCESS] Media retrieved for mediaId: ${clean.media_id}`);
            return row;
        } catch (error) {
            ErrorHandler.addError(`Error in getById: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * getAuditByMediaId({ media_id, limit, cursor })
     * Description:
     *   Fetch audit trail for a specific media item, ordered by most recent first.
     * Checklist:
     *   [ ] SafeUtils.sanitizeValidate
     *   [ ] select from media_audit with pagination
     */
    async getAuditByMediaId(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            limit: { value: payload.limit, type: "int", required: false },
        });
        const limit = Math.min(clean.limit || 50, 100);

        Logger.debugLog?.(`[MediaHandler] [getAuditByMediaId] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const audits = await this.db.getAll(
                this.connection,
                `SELECT * FROM media_audit 
                 WHERE media_id = $1 
                 ORDER BY occurred_at DESC, id DESC 
                 LIMIT $2`,
                [clean.media_id, limit],
            );

            Logger.debugLog?.(`[MediaHandler] [getAuditByMediaId] [SUCCESS] Audits retrieved for mediaId: ${clean.media_id}, count: ${audits.length}`);
            return {audits};
        } catch (error) {
            ErrorHandler.addError(`Error in getAuditByMediaId: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * listByOwner({...})
     * Description:
     *   Owner-scoped list with filters & keyset pagination (DB fallback to ES).
     * Checklist:
     *   [ ] SafeUtils.sanitizeValidate
     *   [ ] _listWithFilters({ scope:'owner' })
     */
    async listByOwner(payload) {
        const clean = SafeUtils.sanitizeValidate({
            owner_user_id: { value: payload.owner_user_id, type: "string", required: true },
            limit: { value: payload.limit, type: "int", required: false },
            cursor: { value: payload.cursor, type: "string", required: false },
            filters: { value: payload.filters, type: "object", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [listByOwner] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const res = await this._listWithFilters({
                scope: 'owner',
                owner_user_id: clean.owner_user_id,
                ...clean,
            });

            Logger.debugLog?.(`[MediaHandler] [listByOwner] [SUCCESS] List retrieved for owner: ${clean.owner_user_id}, count: ${res.items.length}`);
            return res;
        } catch (error) {
            ErrorHandler.addError(`Error in listByOwner: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * listPublic({...})
     * Description:
     *   Public, published list with filters & keyset pagination (DB fallback to ES).
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] _listWithFilters({ scope:'public' })
     */
    async listPublic(payload) {
        const clean = SafeUtils.sanitizeValidate({
            limit: { value: payload.limit, type: "int", required: false },
            cursor: { value: payload.cursor, type: "string", required: false },
            filters: { value: payload.filters, type: "object", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [listPublic] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const result = await this._listWithFilters({scope: 'public', ...clean});

            Logger.debugLog?.(`[MediaHandler] [listPublic] [SUCCESS] Public list retrieved, count: ${result.items.length}`);
            return result;
        } catch (error) {
            ErrorHandler.addError(`Error in listPublic: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * listAll({...})
     * Description:
     *   Global list with filters & keyset/offset pagination.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] _listWithFilters({ scope:'all' })
     */
    async listAll(payload) {
        console.log(`[MediaHandler] [listAll] this is ${this ? 'defined' : 'undefined'}`);
        try {
            console.log(`[MediaHandler] [listAll] sanitizeValidateFirst type: ${typeof this.sanitizeValidateFirst}`);
        } catch (e) {
            console.log(`[MediaHandler] [listAll] Error checking type: ${e.message}`);
        }
        
        const clean = this.sanitizeValidateFirst(payload, null);

        Logger.debugLog?.(`[MediaHandler] [listAll] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const result = await this._listWithFilters({
                scope: 'all',
                ...clean
            });

            Logger.debugLog?.(`[MediaHandler] [listAll] [SUCCESS] Global list retrieved, count: ${result.items.length}`);
            return result;
        } catch (error) {
            ErrorHandler.addError(`Error in listAll: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * listFeatured({...})
     * Description:
     *   Featured & published list.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] _listWithFilters({ scope:'featured' })
     */
    async listFeatured(payload) {
        const clean = SafeUtils.sanitizeValidate({
            limit: { value: payload.limit, type: "int", required: false },
            cursor: { value: payload.cursor, type: "string", required: false },
            filters: { value: payload.filters, type: "object", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [listFeatured] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const res = await this._listWithFilters({scope: 'featured', ...clean});

            Logger.debugLog?.(`[MediaHandler] [listFeatured] [SUCCESS] Featured list retrieved, count: ${res.items.length}`);
            return res;
        } catch (error) {
            ErrorHandler.addError(`Error in listFeatured: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * listComingSoon({...})
     * Description:
     *   Coming soon list.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] _listWithFilters({ scope:'coming_soon' })
     */
    async listComingSoon(payload) {
        const clean = SafeUtils.sanitizeValidate({
            limit: { value: payload.limit, type: "int", required: false },
            cursor: { value: payload.cursor, type: "string", required: false },
            filters: { value: payload.filters, type: "object", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [listComingSoon] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const res = await this._listWithFilters({scope: 'coming_soon', ...clean});

            Logger.debugLog?.(`[MediaHandler] [listComingSoon] [SUCCESS] Coming soon list retrieved, count: ${res.items.length}`);
            return res;
        } catch (error) {
            ErrorHandler.addError(`Error in listComingSoon: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * listByTag({...})
     * Description:
     *   Tag-filtered list with AND-able extra filters.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] _listWithFilters({ scope:'tag' })
     */
    async listByTag(payload) {
        const clean = SafeUtils.sanitizeValidate({
            tag: { value: payload.tag, type: "string", required: true },
            limit: { value: payload.limit, type: "int", required: false },
            cursor: { value: payload.cursor, type: "string", required: false },
            filters: { value: payload.filters, type: "object", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [listByTag] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const res = await this._listWithFilters({scope: 'tag', tag: clean.tag, ...clean});

            Logger.debugLog?.(`[MediaHandler] [listByTag] [SUCCESS] List by tag retrieved for tag: ${clean.tag}, count: ${res.items.length}`);
            return res;
        } catch (error) {
            ErrorHandler.addError(`Error in listByTag: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * search({...})
     * Description:
     *   ES primary, DB fallback (title/description ILIKE).
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] try ES; fallback: DB
     */
    async search(payload) {
        const clean = SafeUtils.sanitizeValidate({
            query: { value: payload.query, type: "string", required: false },
        });
        const q = (clean.query || '').trim();

        Logger.debugLog?.(`[MediaHandler] [search] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            // Primary: // Implement elasticsearch here
            // Fallback:
            const items = await this.db.getAll(
                this.connection,
                `SELECT * FROM media WHERE is_deleted=false AND status='published'
                 AND (title ILIKE $1 OR description ILIKE $1)
                 ORDER BY COALESCE(publish_date, entry_date) DESC, media_id DESC
                 LIMIT 101`,
                [q ? `%${q}%` : '%%'],
            );

            Logger.debugLog?.(`[MediaHandler] [search] [SUCCESS] Search completed for query: ${q}, count: ${items.length}`);
            return {items, nextCursor: null};
        } catch (error) {
            ErrorHandler.addError(`Error in search: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * reindexSearch({...})
     * Description:
     *   Force ES reindex for a media item.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] indexer.upsert(media_id)
     */
    async reindexSearch(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
        });

        Logger.debugLog?.(`[MediaHandler] [reindexSearch] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            await this.indexer.upsert(clean.media_id); // Implement elasticsearch here

            Logger.debugLog?.(`[MediaHandler] [reindexSearch] [SUCCESS] Reindexed mediaId: ${clean.media_id}`);
            return {media_id: clean.media_id, reindexed: true};
        } catch (error) {
            ErrorHandler.addError(`Error in reindexSearch: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * createCollection({...})
     * Description:
     *   Create a collection/playlist/group.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] insert collection; audit
     */
    async createCollection(payload) {
        const clean = SafeUtils.sanitizeValidate({
            owner_user_id: { value: payload.owner_user_id, type: "string", required: true },
            title: { value: payload.title, type: "string", required: true },
            description: { value: payload.description, type: "string", required: false },
            visibility: { value: payload.visibility, type: "string", required: false },
            poster_url: { value: payload.poster_url, type: "string", required: false },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [createCollection] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const collection_id = this.uuid.v4();
            await this.db.withTransaction(this.connection, async (client) => {
                await client.query(
                    `INSERT INTO collections (collection_id, owner_user_id, title, description, visibility, poster_url, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
                    [
                        collection_id,
                        clean.owner_user_id,
                        clean.title,
                        clean.description || null,
                        clean.visibility || this.VISIBILITY.PRIVATE,
                        clean.poster_url || null,
                    ],
                );
                await this.writeAudit(client, {
                    mediaId: collection_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.COLLECTION_CREATE,
                    beforeJson: null,
                    afterJson: {collection_id, title: clean.title},
                });
            });

            Logger.writeLog({
                flag: "MEDIA",
                action: "collectionCreated",
                data: {
                    collectionId: collection_id,
                    ownerUserId: clean.owner_user_id,
                    title: clean.title,
                    actorUserId: payload.actorUserId
                }
            });

            Logger.debugLog?.(`[MediaHandler] [createCollection] [SUCCESS] Collection created with id ${collection_id}`);
            return {collection_id};
        } catch (error) {
            ErrorHandler.addError(`Error in createCollection: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * addToCollection({...})
     * Description:
     *   Add media to collection (optional position).
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] upsert into collection_media; audit
     */
    async addToCollection(payload) {
        const clean = SafeUtils.sanitizeValidate({
            collection_id: { value: payload.collection_id, type: "string", required: true },
            media_id: { value: payload.media_id, type: "string", required: true },
            position: { value: payload.position, type: "int", required: false },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [addToCollection] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            await this.db.withTransaction(this.connection, async (client) => {
                await client.query(
                    `INSERT INTO collection_media (collection_id, media_id, position)
             VALUES ($1,$2,$3)
             ON CONFLICT (collection_id, media_id) DO UPDATE SET position=EXCLUDED.position`,
                    [
                        clean.collection_id,
                        clean.media_id,
                        typeof clean.position === 'number' ? clean.position : null,
                    ],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.COLLECTION_ADD,
                    beforeJson: null,
                    afterJson: {collection_id: clean.collection_id, position: clean.position ?? null},
                });
            });

            Logger.writeLog({
                flag: "MEDIA",
                action: "addedToCollection",
                data: {
                    collectionId: clean.collection_id,
                    mediaId: clean.media_id,
                    position: clean.position,
                    actorUserId: payload.actorUserId
                }
            });

            Logger.debugLog?.(`[MediaHandler] [addToCollection] [SUCCESS] Media added to collection ${clean.collection_id}`);
            return {collection_id: clean.collection_id, media_id: clean.media_id};
        } catch (error) {
            ErrorHandler.addError(`Error in addToCollection: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * removeFromCollection({...})
     * Description:
     *   Remove media from a collection.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] delete from collection_media; audit
     */
    async removeFromCollection(payload) {
        const clean = SafeUtils.sanitizeValidate({
            collection_id: { value: payload.collection_id, type: "string", required: true },
            media_id: { value: payload.media_id, type: "string", required: true },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [removeFromCollection] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            await this.db.withTransaction(this.connection, async (client) => {
                await client.query(
                    `DELETE FROM collection_media WHERE collection_id=$1 AND media_id=$2`,
                    [clean.collection_id, clean.media_id],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.COLLECTION_REMOVE,
                    beforeJson: null,
                    afterJson: {collection_id: clean.collection_id},
                });
            });

            Logger.writeLog({
                flag: "MEDIA",
                action: "removedFromCollection",
                data: {
                    collectionId: clean.collection_id,
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId
                }
            });

            Logger.debugLog?.(`[MediaHandler] [removeFromCollection] [SUCCESS] Media removed from collection ${clean.collection_id}`);
            return {collection_id: clean.collection_id, media_id: clean.media_id, removed: true};
        } catch (error) {
            ErrorHandler.addError(`Error in removeFromCollection: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * listCollection({...})
     * Description:
     *   List items within a collection, ordered by position desc then id desc.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] join fetch; keyset-ish pagination
     */
    async listCollection(payload) {
        const clean = SafeUtils.sanitizeValidate({
            collection_id: { value: payload.collection_id, type: "string", required: true },
            limit: { value: payload.limit, type: "int", required: false },
        });
        const limit = Math.min(clean.limit || 24, 100);

        Logger.debugLog?.(`[MediaHandler] [listCollection] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const items = await this.db.getAll(
                this.connection,
                `SELECT m.* FROM collection_media cm
                 JOIN media m ON m.media_id = cm.media_id
                 WHERE cm.collection_id=$1 AND m.is_deleted=false
                 ORDER BY COALESCE(cm.position,0) DESC, m.media_id DESC
                 LIMIT $2`,
                [clean.collection_id, limit + 1],
            );

            const hasMore = items.length > limit;
            if (hasMore) items.pop();

            Logger.debugLog?.(`[MediaHandler] [listCollection] [SUCCESS] Collection listed for ${clean.collection_id}, count: ${items.length}`);
            return {items, nextCursor: null};
        } catch (error) {
            ErrorHandler.addError(`Error in listCollection: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * schedulePublish({...})
     * Description:
     *   Thin wrapper that reuses handler validation/logic for scheduling.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] delegate to handleScheduleMediaItem
     */
    async schedulePublish(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            expectedVersion: { value: payload.expectedVersion, type: "int", required: true },
            publish_date: { value: payload.publish_date, type: "string", required: false },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [schedulePublish] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const result = await this.handleScheduleMediaItem({...clean, actorUserId: payload.actorUserId});

            Logger.debugLog?.(`[MediaHandler] [schedulePublish] [SUCCESS] Media scheduled for publish: ${clean.media_id}`);
            return result;
        } catch (error) {
            ErrorHandler.addError(`Error in schedulePublish: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * cancelSchedule({...})
     * Description:
     *   If currently scheduled, revert to pending_review; version bump.
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] load row; expectVersion; must be scheduled
     *   [ ] update; audit; ES upsert
     */
    async cancelSchedule(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            expectedVersion: { value: payload.expectedVersion, type: "int", required: true },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [cancelSchedule] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const result = await this.db.withTransaction(this.connection, async (client) => {
                const row = await client.query(
                    `SELECT * FROM media WHERE media_id=$1 AND is_deleted=false`,
                    [clean.media_id],
                );
                if (!row || row.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id: clean.media_id } });
                    throw new Error('Media not found');
                }
                if (clean.expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { clean } });
                    throw new Error('expectedVersion required');
                }
                this.expectVersion(row.rows[0], clean.expectedVersion);
                if (row.rows[0].status !== this.STATUS.SCHEDULED) {
                    ErrorHandler.addError('Not scheduled', { code: "STATE_ERROR", origin: "MediaHandler", data: { status: row.rows[0].status } });
                    throw new Error('Not scheduled');
                }

                const now = DateTime.now(undefined, "UTC");
                const newVersion = (row.rows[0].version || 0) + 1;
                await client.query(
                    `UPDATE media SET status='pending_review', last_updated=$2, updated_by_user_id=$3, version=$4 WHERE media_id=$1`,
                    [clean.media_id, now, payload.actorUserId || row.rows[0].updated_by_user_id, newVersion],
                );

                await this.writeAudit(client, {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId,
                    action: this.ACTION.SCHEDULE,
                    beforeJson: {status: row.rows[0].status, version: row.rows[0].version},
                    afterJson: {status: 'pending_review', version: newVersion},
                });

                await this.indexer.upsert(clean.media_id); // Implement elasticsearch here

                return {media_id: clean.media_id, status: 'pending_review'};
            });

            Logger.writeLog({
                flag: "MEDIA",
                action: "scheduleCancelled",
                data: {
                    mediaId: clean.media_id,
                    actorUserId: payload.actorUserId
                }
            });

            Logger.debugLog?.(`[MediaHandler] [cancelSchedule] [SUCCESS] Schedule cancelled for mediaId: ${clean.media_id}`);
            return result;
        } catch (error) {
            ErrorHandler.addError(`Error in cancelSchedule: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * setStatusPublished({...})
     * Description:
     *   Delegate to publish handler (same strict validation).
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] delegate to handlePublishMediaItem
     */
    async setStatusPublished(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            expectedVersion: { value: payload.expectedVersion, type: "int", required: true },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [setStatusPublished] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const result = await this.handlePublishMediaItem({...clean, actorUserId: payload.actorUserId});

            Logger.debugLog?.(`[MediaHandler] [setStatusPublished] [SUCCESS] Status set to published for mediaId: ${clean.media_id}`);
            return result;
        } catch (error) {
            ErrorHandler.addError(`Error in setStatusPublished: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * setStatusScheduled({...})
     * Description:
     *   Delegate to schedule handler (same strict validation).
     * Checklist:
     *   [ ] sanitizeValidateFirst
     *   [ ] delegate to handleScheduleMediaItem
     */
    async setStatusScheduled(payload) {
        const clean = SafeUtils.sanitizeValidate({
            media_id: { value: payload.media_id, type: "string", required: true },
            expectedVersion: { value: payload.expectedVersion, type: "int", required: true },
            publish_date: { value: payload.publish_date, type: "string", required: false },
            actorUserId: { value: payload.actorUserId, type: "string", required: false },
        });

        Logger.debugLog?.(`[MediaHandler] [setStatusScheduled] [START] Payload received: ${JSON.stringify(payload)}`);

        try {
            const result = await this.handleScheduleMediaItem({...clean, actorUserId: payload.actorUserId});

            Logger.debugLog?.(`[MediaHandler] [setStatusScheduled] [SUCCESS] Status set to scheduled for mediaId: ${clean.media_id}`);
            return result;
        } catch (error) {
            ErrorHandler.addError(`Error in setStatusScheduled: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { payload, error: error.stack }
            });
            throw error;
        }
    }

    // ============================================================================
    //                             INTERNAL BUILDERS
    // ============================================================================

    /**
     * _simpleFieldUpdate({ media_id, expectedVersion, fields, actorUserId, action })
     * Description:
     *   One-shot field updater with version bump, audit, and ES upsert.
     * Checklist:
     *   [ ] load row; expectVersion
     *   [ ] dynamic SET; bump version/time; audit; ES upsert
     */
    async _simpleFieldUpdate({
        media_id,
        expectedVersion,
        mediaVersion,
        fields,
        actorUserId,
        action,
    }) {
        try {
            Logger.debugLog?.(`[MediaHandler] [_simpleFieldUpdate] [START] Updating fields for mediaId: ${media_id}, fields: ${JSON.stringify(fields)}`);

            return await this.db.withTransaction(this.connection, async (client) => {
                let result;
                try {
                    result = await client.query(
                        `SELECT * FROM media WHERE media_id=$1 AND is_deleted=false FOR UPDATE NOWAIT`,
                        [media_id],
                    );
                } catch (lockError) {
                    if (lockError.code === '55P03') { // lock_not_available
                        ErrorHandler.addError('Media item is currently being updated by another process', { code: "CONFLICT", origin: "MediaHandler", data: { media_id } });
                        throw new Error('Media item is currently being updated by another process');
                    }
                    throw lockError; // Re-throw other errors
                }

                if (!result || result.rows.length === 0) {
                    ErrorHandler.addError('Media not found', { code: "NOT_FOUND", origin: "MediaHandler", data: { media_id } });
                    throw new Error('Media not found');
                }

                if (expectedVersion == null) {
                    ErrorHandler.addError('expectedVersion required', { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { expectedVersion } });
                    throw new Error('expectedVersion required');
                }

                this.expectVersion(result.rows[0], expectedVersion);

                const set = [];
                const values = [media_id];
                let paramsIndex = 2;

                const allowedFields = Object.keys(this.FIELD_SPEC);
                for (const [key, value] of Object.entries(fields)) {
                    if (typeof Logger !== 'undefined' && Logger.debugLog) {
                        Logger.debugLog(`[trace .includes] [allowedFields] key=${key}, typeof allowedFields=${typeof allowedFields}, isArray=${Array.isArray(allowedFields)}, value=${JSON.stringify(allowedFields)}`);
                    }
                    if (!allowedFields.includes(key)) {
                        ErrorHandler.addError(`Invalid field '${key}'`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { key, fields } });
                        throw new Error(`Invalid field '${key}'`);
                    }
                    set.push(`${key}=$${paramsIndex++}`);
                    values.push(value);
                }

                // Check parameter bounds to prevent exceeding PostgreSQL limits
                if (paramsIndex > 1000) {
                    ErrorHandler.addError('Too many fields to update', { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { fieldCount: Object.keys(fields).length, paramsIndex } });
                    throw new Error('Too many fields to update');
                }

                const now = DateTime.now(undefined, "UTC");
                const newVersion = mediaVersion ?? (result.rows[0].version || 0) + 1;

                set.push(`version=$${paramsIndex++}`);
                values.push(newVersion);

                set.push(`last_updated=$${paramsIndex++}`);
                values.push(now);

                await client.query(
                    `UPDATE media SET ${set.join(', ')}, updated_by_user_id=$${paramsIndex} WHERE media_id=$1`,
                    [...values, actorUserId || result.rows[0].updated_by_user_id],
                );

                await this.writeAudit(client, {
                    mediaId: media_id,
                    actorUserId,
                    action: action || this.ACTION.UPDATE,
                    beforeJson: {version: result.rows[0].version},
                    afterJson: {version: newVersion, fields},
                });

                await this.indexer.upsert(media_id); // Implement elasticsearch here

                Logger.debugLog?.(`[MediaHandler] [_simpleFieldUpdate] [SUCCESS] Fields updated for mediaId: ${media_id}, version: ${newVersion}`);
                return {media_id, version: newVersion};
            });
        } catch (error) {
            ErrorHandler.addError(`Error in _simpleFieldUpdate: ${error.message}`, {
                code: "METHOD_ERROR",
                origin: "MediaHandler",
                data: { media_id, fields, error: error.stack }
            });
            throw error;
        }
    }

    /**
     * _listWithFilters({ scope, owner_user_id, tag, query, filters, limit, cursor })
     * Description:
     *   Central list builder (DB fallback to ES); keyset via date+id (simplified).
     * Checklist:
     *   [ ] build WHERE by scope & filters
     *   [ ] ORDER BY COALESCE(publish_date, entry_date) DESC, media_id DESC
     *   [ ] LIMIT +1 detect next cursor (omitted: token)
     */
    async _listWithFilters(params) {
        // Validate that a scope is provided to prevent accidental full table scans
        const validScopes = ['owner', 'public', 'featured', 'coming_soon', 'tag', 'all'];
        if (typeof Logger !== 'undefined' && Logger.debugLog) {
            Logger.debugLog(`[trace .includes] [validScopes] params.scope=${params.scope}, typeof validScopes=${typeof validScopes}, isArray=${Array.isArray(validScopes)}, value=${JSON.stringify(validScopes)}`);
        }
        if (!params.scope || !validScopes.includes(params.scope)) {
            ErrorHandler.addError('VALIDATION_ERROR', 'Missing or invalid scope parameter for list operation');
            throw new Error('Missing or invalid scope parameter for list operation');
        }

        const limit = Math.min(params.limit || this.config.defaultPageSize, this.config.maxPageSize);
        const offset = params.offset || 0;
        const where = ['m.is_deleted=false'];
        const values = [];
        let idx = 1;

        // Parse cursor for keyset pagination (only if offset is 0 or not provided)
        let cursorDate = null;
        let cursorId = null;
        if (params.cursor && !offset) {
            try {
                const decoded = JSON.parse(Buffer.from(params.cursor, 'base64').toString());
                cursorDate = decoded.date;
                cursorId = decoded.id;
                if (cursorDate && cursorId) {
                    where.push(`(COALESCE(m.publish_date, m.entry_date), m.media_id) < ($${idx++}, $${idx++})`);
                    values.push(cursorDate, cursorId);
                }
            } catch (e) {
                // Invalid cursor, ignore
            }
        }

        if (params.scope === 'owner') {
            where.push(`m.owner_user_id=$${idx++}`);
            values.push(params.owner_user_id);
        } else if (params.scope === 'public') {
            where.push(`m.status='published'`);
            where.push(`m.visibility IN ('public','unlisted','subscribers','purchasers')`);
        } else if (params.scope === 'featured') {
            where.push(`m.status='published'`);
            where.push(`m.featured=true`);
        } else if (params.scope === 'coming_soon') {
            where.push(`m.coming_soon=true`);
        } else if (params.scope === 'tag') {
            where.push(
                `EXISTS (SELECT 1 FROM media_tags t WHERE t.media_id=m.media_id AND t.tag=$${idx++})`,
            );
            values.push(params.tag);
        }

        const f = params.filters || {};
        
        // Global Search (q)
        if (f.q || params.q) {
            const qValue = f.q || params.q;
            where.push(`(m.title ILIKE $${idx} OR m.file_name ILIKE $${idx} OR m.media_id ILIKE $${idx} OR m.description ILIKE $${idx++})`);
            values.push(`%${qValue}%`);
        }

        // Title specifically
        if (f.title) {
            where.push(`m.title ILIKE $${idx++}`);
            values.push(`%${f.title}%`);
        }

        // Filter by specific media_id
        if (f.media_id) {
            where.push(`m.media_id=$${idx++}`);
            values.push(f.media_id);
        }

        // Filter by specific id (auto-incrementing primary key)
        if (f.id) {
            where.push(`m.id=$${idx++}`);
            values.push(f.id);
        }

        if (f.media_type) {
            where.push(`m.media_type=$${idx++}`);
            values.push(f.media_type);
        }

        if (f.status) {
            where.push(`m.status=$${idx++}`);
            values.push(f.status);
        }

        if (f.visibility) {
            where.push(`m.visibility=$${idx++}`);
            values.push(f.visibility);
        }

        if (f.owner_user_id) {
            where.push(`m.owner_user_id=$${idx++}`);
            values.push(f.owner_user_id);
        }

        if (f.featured !== undefined && f.featured !== null) {
            where.push(`m.featured=$${idx++}`);
            values.push(!!f.featured);
        }

        if (f.coming_soon !== undefined && f.coming_soon !== null) {
            where.push(`m.coming_soon=$${idx++}`);
            values.push(!!f.coming_soon);
        }

        // File Size in KB to Bytes
        if (Number.isFinite(f.file_size_min)) {
            where.push(`m.file_size_bytes >= $${idx++}`);
            values.push(f.file_size_min * 1024);
        }
        if (Number.isFinite(f.file_size_max)) {
            where.push(`m.file_size_bytes <= $${idx++}`);
            values.push(f.file_size_max * 1024);
        }

        if (Number.isFinite(f.min_duration)) {
            where.push(`COALESCE(m.duration_seconds,0) >= $${idx++}`);
            values.push(f.min_duration);
        }
        if (Number.isFinite(f.max_duration)) {
            where.push(`COALESCE(m.duration_seconds,0) <= $${idx++}`);
            values.push(f.max_duration);
        }
        if (f.tags_all && Array.isArray(f.tags_all) && f.tags_all.length) {
            for (const t of f.tags_all) {
                where.push(
                    `EXISTS (SELECT 1 FROM media_tags tt WHERE tt.media_id=m.media_id AND tt.tag=$${idx++})`,
                );
                values.push(t);
            }
        }

        // Date Handling (Mapping created_at/from/to to entry_date)
        if (f.created_from || f.from_date) {
            const from = f.created_from || f.from_date;
            where.push(`m.entry_date >= $${idx++}`);
            values.push(DateTime.parseDateToTimestamp(from));
        }
        if (f.created_to || f.to_date) {
            const to = f.created_to || f.to_date;
            // Handle end of day for created_to
            let toTs = DateTime.parseDateToTimestamp(to);
            if (toTs) {
                // If the input is just YYYY-MM-DD, add 23:59:59
                if (typeof to === 'string' && to.length <= 10) {
                   const d = new Date(toTs);
                   d.setHours(23, 59, 59, 999);
                   toTs = d.toISOString();
                }
            }
            where.push(`m.entry_date <= $${idx++}`);
            values.push(toTs);
        }

        // Sorting
        let sortBy = 'COALESCE(m.publish_date, m.entry_date)';
        let sortOrder = 'DESC';

        const allowedSortFields = {
            'created_at': 'm.entry_date',
            'entry_date': 'm.entry_date',
            'publish_date': 'm.publish_date',
            'title': 'm.title',
            'file_size': 'm.file_size_bytes',
            'media_type': 'm.media_type',
            'status': 'm.status'
        };

        const requestedSortBy = params.sort_by || (params.filters && params.filters.sort_by);
        if (requestedSortBy && allowedSortFields[requestedSortBy]) {
            sortBy = allowedSortFields[requestedSortBy];
        }

        const requestedSortOrder = params.sort_order || (params.filters && params.filters.sort_order);
        if (requestedSortOrder && ['ASC', 'DESC'].includes(requestedSortOrder.toUpperCase())) {
            sortOrder = requestedSortOrder.toUpperCase();
        }

        const orderBy = `ORDER BY ${sortBy} ${sortOrder}, m.media_id ${sortOrder}`;

        const query = `SELECT m.*
           FROM media m
           WHERE ${where.join(' AND ')}
           ${orderBy}
           LIMIT $${idx++} OFFSET $${idx++}`;

        const rows = await this.db.getAll(this.connection, query, [...values, limit + 1, offset]);
        const hasMore = rows.length > limit;
        if (hasMore) rows.pop();

        // Get total count for pagination
        const countQuery = `SELECT count(*) as total FROM media m WHERE ${where.join(' AND ')}`;
        const countRes = await this.db.getRow(this.connection, countQuery, values);
        const totalCount = parseInt(countRes?.total || 0, 10);

        // Generate next cursor if there are more results
        let nextCursor = null;
        if (hasMore && rows.length > 0) {
            const lastItem = rows[rows.length - 1];
            const cursorData = {
                date: lastItem.publish_date || lastItem.entry_date,
                id: lastItem.media_id
            };
            nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
        }

        return {items: rows, nextCursor, totalCount};
    }

    // ============================================================================
    //                         VERSION GUARD / AUDIT HELPERS
    // ============================================================================

    /**
     * expectVersion(row, expectedVersion)
     * Description:
     *   Optimistic concurrency guard. Throws ConflictError on mismatch.
     * Checklist:
     *   [ ] check integer
     *   [ ] compare to row.version
     */
    expectVersion(row, expectedVersion) {
        if (!Number.isInteger(expectedVersion)) {
            ErrorHandler.addError('expectedVersion required', { code: "CONFLICT", origin: "MediaHandler", data: { expectedVersion } });
            throw new Error('expectedVersion required');
        }
        if (Number(row.version || 0) !== expectedVersion) {
            ErrorHandler.addError('Version mismatch', { code: "CONFLICT", origin: "MediaHandler", data: { rowVersion: row.version, expectedVersion } });
            throw new Error('Version mismatch');
        }
    }

    /**
     * writeAudit(client, { mediaId, actorUserId, action, beforeJson, afterJson })
     * Description:
     *   Insert audit log row (JSONB before/after) inside current TX.
     * Checklist:
     *   [ ] INSERT audit with NOW(), actor id, action, before/after
     */
    async writeAudit(client, {mediaId, actorUserId, action, beforeJson, afterJson}) {
        // Validate action against allowed ACTION constants
        const allowedActions = Object.values(this.ACTION);
        if (typeof Logger !== 'undefined' && Logger.debugLog) {
            Logger.debugLog(`[trace .includes] [allowedActions] action=${action}, typeof allowedActions=${typeof allowedActions}, isArray=${Array.isArray(allowedActions)}, value=${JSON.stringify(allowedActions)}`);
        }
        if (!allowedActions.includes(action)) {
            ErrorHandler.addError(`Invalid audit action '${action}'`, { code: "VALIDATION_ERROR", origin: "MediaHandler", data: { action } });
            throw new Error(`Invalid audit action '${action}'`);
        }

        const now = DateTime.now(undefined, "UTC");
        await client.query(
            `INSERT INTO media_audit (media_id, occurred_at, actor_user_id, action, before_json, after_json)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
            [
                mediaId,
                now,
                actorUserId || null,
                action,
                JSON.stringify(beforeJson ?? null),
                JSON.stringify(afterJson ?? null),
            ],
        );
    }
}
module.exports = MediaHandler;
