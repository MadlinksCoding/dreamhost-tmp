/**
 * seed.js — Random seed script for MediaHandler
 * Generates random media items for testing and development.
 */

const MediaHandler = require('../src/service/MediaHandler.js');
const { DB, ErrorHandler } = require('../src/utils/index.js');
const { randomUUID } = require('crypto');

// Simple logger
const logger = {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debugLog: console.log,
};

// Colors for output
const colors = {
    red: (text) => `\x1b[31m${text}\x1b[0m`,
    green: (text) => `\x1b[32m${text}\x1b[0m`,
    yellow: (text) => `\x1b[33m${text}\x1b[0m`,
    blue: (text) => `\x1b[34m${text}\x1b[0m`,
};

// Simple indexer (no-op for seeding)
const indexer = {
    upsert: async () => {},
    delete: async () => {},
};

// Simple clock
const clock = {
    now: () => new Date(),
};

// Simple UUID
const uuid = {
    v4: () => randomUUID(),
};

// Random data generators
function randomString(length = 10) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result.trim();
}

function randomUrl(mediaType) {
    const urlPools = {
        audio: [
            'https://www.soundjay.com/misc/sounds/bell-ringing-05.wav',
            'https://www.soundjay.com/misc/sounds/bell-ringing-04.wav',
            'https://www.soundjay.com/misc/sounds/bell-ringing-03.wav',
            'https://www.soundjay.com/misc/sounds/bell-ringing-02.wav',
            'https://www.soundjay.com/misc/sounds/bell-ringing-01.wav',
            'https://www.soundjay.com/misc/sounds/bell-ringing-05.wav',
            'https://www.soundjay.com/misc/sounds/bell-ringing-04.wav',
            'https://www.soundjay.com/misc/sounds/bell-ringing-03.wav',
            'https://www.soundjay.com/misc/sounds/bell-ringing-02.wav',
            'https://www.soundjay.com/misc/sounds/bell-ringing-01.wav'
        ],
        video: [
            'https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_1mb.mp4',
            'https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_2mb.mp4',
            'https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_5mb.mp4',
            'https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_10mb.mp4',
            'https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_20mb.mp4',
            'https://sample-videos.com/zip/10/mp4/SampleVideo_640x360_1mb.mp4',
            'https://sample-videos.com/zip/10/mp4/SampleVideo_640x360_2mb.mp4',
            'https://sample-videos.com/zip/10/mp4/SampleVideo_640x360_5mb.mp4',
            'https://sample-videos.com/zip/10/mp4/SampleVideo_640x360_10mb.mp4',
            'https://sample-videos.com/zip/10/mp4/SampleVideo_640x360_20mb.mp4'
        ],
        image: [
            'https://picsum.photos/800/600?random=1',
            'https://picsum.photos/800/600?random=2',
            'https://picsum.photos/800/600?random=3',
            'https://picsum.photos/800/600?random=4',
            'https://picsum.photos/800/600?random=5',
            'https://picsum.photos/800/600?random=6',
            'https://picsum.photos/800/600?random=7',
            'https://picsum.photos/800/600?random=8',
            'https://picsum.photos/800/600?random=9',
            'https://picsum.photos/800/600?random=10'
        ],
        gallery: [
            'https://picsum.photos/800/600?random=11',
            'https://picsum.photos/800/600?random=12',
            'https://picsum.photos/800/600?random=13',
            'https://picsum.photos/800/600?random=14',
            'https://picsum.photos/800/600?random=15',
            'https://picsum.photos/800/600?random=16',
            'https://picsum.photos/800/600?random=17',
            'https://picsum.photos/800/600?random=18',
            'https://picsum.photos/800/600?random=19',
            'https://picsum.photos/800/600?random=20'
        ],
        file: [
            'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
            'https://www.learningcontainer.com/wp-content/uploads/2020/04/sample-text-file.txt',
            'https://www.learningcontainer.com/wp-content/uploads/2020/04/sample-doc-file.doc',
            'https://www.learningcontainer.com/wp-content/uploads/2020/04/sample-docx-file.docx',
            'https://www.learningcontainer.com/wp-content/uploads/2020/04/sample-ppt-file.ppt',
            'https://www.learningcontainer.com/wp-content/uploads/2020/04/sample-pptx-file.pptx',
            'https://www.learningcontainer.com/wp-content/uploads/2020/04/sample-xls-file.xls',
            'https://www.learningcontainer.com/wp-content/uploads/2020/04/sample-xlsx-file.xlsx',
            'https://www.learningcontainer.com/wp-content/uploads/2020/04/sample-xml-file.xml',
            'https://www.learningcontainer.com/wp-content/uploads/2020/04/sample-json-file.json'
        ]
    };

    const urls = urlPools[mediaType] || urlPools['file'];
    return urls[Math.floor(Math.random() * urls.length)];
}

function randomInt(min = 0, max = 100) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomBool() {
    return Math.random() > 0.5;
}

function randomArray(length = 3, generator = randomString) {
    const arr = [];
    for (let i = 0; i < length; i++) {
        arr.push(generator());
    }
    return arr;
}

function randomTitle(mediaType) {
    const titles = {
        audio: [
            'Summer Breeze Melody',
            'Urban Nights Soundtrack',
            'Acoustic Dreams',
            'Electronic Pulse',
            'Jazz Improvisation',
            'Rock Anthem',
            'Classical Sonata',
            'Hip Hop Beat',
            'Ambient Soundscape',
            'Podcast Episode 1'
        ],
        video: [
            'City Tour Documentary',
            'Cooking Masterclass',
            'Travel Vlog',
            'Music Video',
            'Tutorial Series',
            'Comedy Sketch',
            'Nature Documentary',
            'Fitness Workout',
            'Product Review',
            'Live Performance'
        ],
        image: [
            'Sunset Landscape',
            'Portrait Photography',
            'Abstract Art',
            'Street Photography',
            'Nature Macro',
            'Architecture Study',
            'Fashion Shoot',
            'Product Photography',
            'Digital Art',
            'Photo Manipulation'
        ],
        gallery: [
            'Summer Vacation Photos',
            'Wedding Album',
            'Art Portfolio',
            'Product Catalog',
            'Event Coverage',
            'Nature Collection',
            'Fashion Lookbook',
            'Architecture Series',
            'Food Photography',
            'Travel Memories'
        ],
        file: [
            'User Manual PDF',
            'Research Paper',
            'Presentation Slides',
            'Contract Document',
            'Technical Specification',
            'Resume Template',
            'Tutorial Guide',
            'Report Analysis',
            'Project Documentation',
            'Legal Agreement'
        ]
    };

    return titles[mediaType][Math.floor(Math.random() * titles[mediaType].length)];
}

function randomDescription() {
    const descriptions = [
        'A high-quality media file perfect for your collection.',
        'Professional content created with attention to detail.',
        'Engaging and well-produced media experience.',
        'Creative work showcasing unique artistic vision.',
        'Comprehensive content covering various aspects.',
        'Expertly crafted for maximum impact and enjoyment.',
        'Innovative approach to traditional media formats.',
        'Carefully curated selection of premium content.',
        'Dynamic and engaging multimedia experience.',
        'Thoughtfully designed for diverse audiences.'
    ];
    return descriptions[Math.floor(Math.random() * descriptions.length)];
}

function randomMediaType() {
    // Valid media types: audio, video, image, gallery, file
    // Make it more balanced - more variety
    const types = ['audio', 'video', 'image', 'gallery', 'file'];
    const weights = [0.2, 0.25, 0.25, 0.15, 0.15]; // Different probabilities

    const rand = Math.random();
    let cumulative = 0;
    for (let i = 0; i < types.length; i++) {
        cumulative += weights[i];
        if (rand <= cumulative) {
            return types[i];
        }
    }
    return types[0];
}

function randomVisibility() {
    // Valid visibility values: public, private, subscribers, purchasers, unlisted
    const visibilities = ['public', 'private', 'subscribers', 'purchasers', 'unlisted'];
    const weights = [0.5, 0.2, 0.1, 0.1, 0.1]; // More public content

    const rand = Math.random();
    let cumulative = 0;
    for (let i = 0; i < visibilities.length; i++) {
        cumulative += weights[i];
        if (rand <= cumulative) {
            return visibilities[i];
        }
    }
    return visibilities[0];
}

// Generate random payload for handleAddMediaItem
function generateRandomPayload(collections = []) {
    const mediaType = randomMediaType();
    const payload = {
        owner_user_id: `user_${randomInt(1, 1000)}`,
        media_type: mediaType,
        title: randomTitle(mediaType),
        description: randomDescription(),
        visibility: randomVisibility(),
        featured: Math.random() > 0.8, // 20% chance of being featured
        coming_soon: Math.random() > 0.9, // 10% chance of being coming soon
        asset_url: randomUrl(mediaType),
        file_size_bytes: randomInt(1000, 10000000),
        duration_seconds: mediaType === 'audio' || mediaType === 'video' ? randomInt(60, 3600) : undefined,
        video_width: mediaType === 'video' ? randomInt(640, 1920) : undefined,
        video_height: mediaType === 'video' ? randomInt(480, 1080) : undefined,
        poster_url: mediaType === 'video' ? randomUrl('image') : undefined,
        pending_conversion: mediaType === 'video' ? false : undefined, // Must be false for video publish
        tags: randomArray(randomInt(0, 5), () => randomString(8)),
        coperformers: randomArray(randomInt(0, 3), () => `performer_${randomInt(1, 100)}`),
        placeholder_lock: randomBool(),
        blurred_lock: randomBool(),
        blurred_value_px: randomInt(0, 40),
        trailer_blurred_lock: randomBool(),
        trailer_blurred_value_px: randomInt(0, 40),
    };

    // All gallery items must have collection_id
    if (mediaType === 'gallery' && collections.length > 0) {
        payload.collection_id = collections[Math.floor(Math.random() * collections.length)];
    }

    // Remove undefined fields
    Object.keys(payload).forEach(key => {
        if (payload[key] === undefined) {
            delete payload[key];
        }
    });

    return payload;
}

// Seed collections
async function seedCollections(handler, count = 3) {
    const collections = [];
    console.log(colors.blue(`Creating ${count} collections...`));
    for (let i = 0; i < count; i++) {
        try {
            const payload = {
                owner_user_id: `user_${randomInt(1, 500)}`,
                title: randomTitle(),
                description: randomDescription(),
                visibility: randomVisibility(),
                actorUserId: `actor_${randomInt(1, 100)}`,
            };

            const res = await handler.createCollection(payload);
            collections.push(res.collection_id);
            console.log(colors.green(`Created collection ${i + 1}/${count}: ${res.collection_id}`));
        } catch (err) {
            console.error(colors.red(`Failed to create collection ${i + 1}: ${err.message}`));
        }
    }
    return collections;
}

// Main seed function (media items + optional collection linking)
async function seedMediaItems(handler, count = 22, collections = []) {
    console.log(colors.blue(`Seeding ${count} diverse media items...`));

    for (let i = 0; i < count; i++) {
        try {
            const payload = generateRandomPayload(collections);
            const actorUserId = `actor_${randomInt(1, 100)}`;
            const addResult = await handler.handleAddMediaItem({ payload, actorUserId });

            // Get the current version after add (since add may have bumped it)
            const versionResult = await handler.db.getAll(handler.connection, 'SELECT version FROM media WHERE media_id = $1', [addResult.media_id]);
            const currentVersion = parseInt(versionResult[0].version, 10);

            // Publish public items
            if (payload.visibility === 'public') {
                try {
                    await handler.handlePublishMediaItem({
                        media_id: addResult.media_id,
                        expectedVersion: currentVersion,
                        actorUserId
                    });
                    console.log(colors.yellow(`Published ${addResult.media_id}`));
                } catch (pubErr) {
                    console.error(colors.red(`Failed to publish ${addResult.media_id}: ${pubErr.message}`));
                }
            }

            // Add notes to some items (30% chance)
            if (Math.random() > 0.7) {
                try {
                    const noteText = `Sample note for ${payload.title}: This is a test note added during seeding.`;
                    const noteVersion = await handler.db.getAll(handler.connection, 'SELECT version FROM media WHERE media_id = $1', [addResult.media_id]);
                    const currentNoteVersion = parseInt(noteVersion[0].version, 10);

                    await handler.addNote({
                        media_id: addResult.media_id,
                        note: noteText,
                        addedBy: actorUserId,
                        expectedVersion: currentNoteVersion,
                        isPublic: Math.random() > 0.5, // 50% chance of public notes
                        actorUserId
                    });
                    console.log(colors.yellow(`Added note to ${addResult.media_id}`));
                } catch (noteErr) {
                    console.error(colors.red(`Failed to add note to ${addResult.media_id}: ${noteErr.message}`));
                }
            }

            // Randomly attach to a collection (if not already a gallery with collection_id)
            if (collections.length && Math.random() > 0.5 && payload.media_type !== 'gallery') {
                try {
                    const col = collections[Math.floor(Math.random() * collections.length)];
                    const pos = randomInt(0, 24);
                    const collectionVersion = await handler.db.getAll(handler.connection, 'SELECT version FROM media WHERE media_id = $1', [addResult.media_id]);
                    const currentCollectionVersion = parseInt(collectionVersion[0].version, 10);

                    await handler.addToCollection({
                        collection_id: col,
                        media_id: addResult.media_id,
                        position: pos,
                        expectedVersion: currentCollectionVersion,
                        actorUserId
                    });
                    console.log(colors.yellow(`Added ${addResult.media_id} to collection ${col} at position ${pos}`));
                } catch (err) {
                    console.error(colors.red(`Failed to add to collection: ${err.message}`));
                }
            }

            // Set tags (if any) via handler to populate media_tags
            if (payload.tags && payload.tags.length) {
                try {
                    const tagVersion = await handler.db.getAll(handler.connection, 'SELECT version FROM media WHERE media_id = $1', [addResult.media_id]);
                    const currentTagVersion = parseInt(tagVersion[0].version, 10);

                    await handler.setTags({
                        media_id: addResult.media_id,
                        expectedVersion: currentTagVersion,
                        tags: payload.tags,
                        actorUserId
                    });
                    console.log(colors.yellow(`Set ${payload.tags.length} tags for ${addResult.media_id}`));
                } catch (err) {
                    console.error(colors.red(`Failed setTags: ${err.message}`));
                }
            }

            // Set co-performers (performerIds) if present
            if (payload.coperformers && payload.coperformers.length) {
                try {
                    const performerVersion = await handler.db.getAll(handler.connection, 'SELECT version FROM media WHERE media_id = $1', [addResult.media_id]);
                    const currentPerformerVersion = parseInt(performerVersion[0].version, 10);

                    await handler.setCoPerformers({
                        media_id: addResult.media_id,
                        expectedVersion: currentPerformerVersion,
                        performerIds: payload.coperformers,
                        actorUserId
                    });
                    console.log(colors.yellow(`Set ${payload.coperformers.length} co-performers for ${addResult.media_id}`));
                } catch (err) {
                    console.error(colors.red(`Failed setCoPerformers: ${err.message}`));
                }
            }

            // Occasionally add an extra tag using addTag
            if (Math.random() > 0.8) {
                try {
                    const extraTag = randomString(6);
                    const extraTagVersion = await handler.db.getAll(handler.connection, 'SELECT version FROM media WHERE media_id=$1', [addResult.media_id]);
                    const currentExtraTagVersion = parseInt(extraTagVersion[0].version, 10);

                    await handler.addTag({
                        media_id: addResult.media_id,
                        expectedVersion: currentExtraTagVersion,
                        tag: extraTag,
                        actorUserId
                    });
                    console.log(colors.yellow(`Added extra tag '${extraTag}' to ${addResult.media_id}`));
                } catch (err) {
                    console.error(colors.red(`Failed addTag: ${err.message}`));
                }
            }

            console.log(colors.green(`Seeded media item ${i + 1}/${count}: ${addResult.media_id} (${payload.media_type}) ${payload.featured ? '[FEATURED]' : ''}`));
        } catch (error) {
            console.error(colors.red(`Failed to seed item ${i + 1}: ${error && error.message}`));
            console.error('Error object:', error);
            try {
                const dbErrors = handler && handler.db ? handler.db.getErrors() : [];
                console.error('DB Errors:', dbErrors);
            } catch (e) {
                console.error('Failed to read DB.getErrors():', e && e.message);
            }
            try {
                console.error('ErrorHandler entries:', ErrorHandler.getAllErrors ? ErrorHandler.getAllErrors() : ErrorHandler.getErrors ? ErrorHandler.getErrors() : null);
            } catch (e) {
                console.error('Failed to read ErrorHandler entries:', e && e.message);
            }
        }
    }

    console.log(colors.green('Seeding complete.'));
}

// Run seeding
// Run seeding: create collections, then media
async function main() {
    console.log('Starting diverse seed script...');
    const db = new DB({});
    const handler = new MediaHandler(db, logger, indexer, clock, uuid);

    try {
        const collections = await seedCollections(handler, 6); // More collections for gallery items
        await seedMediaItems(handler, 22, collections); // 22 diverse items
        console.log(colors.green('All diverse seeding finished.'));
    } catch (err) {
        console.error('Diverse seeding failed:', err);
        process.exitCode = 1;
    } finally {
        try { await db.closeAll(); } catch (e) { /* ignore */ }
    }
}

main().catch(error => {
    console.error('Seeding failed:', error);
    process.exit(1);
});
