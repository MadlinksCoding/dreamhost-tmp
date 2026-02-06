import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js';
import {NotFoundError, ConflictError} from '../../utils/Error_handler.js';

export default async function testListByTag() {
    console.log('Starting test for listByTag...');

    // ✅ Real DB instance
    const db = new DB();

    // ✅ Basic dependencies
    const log = {info: (...args) => console.log('LOG:', ...args)};
    const indexer = {
        delete: async (id) => console.log('Indexer delete:', id),
    };
    const clock = {now: () => new Date()};
    const uuid = {v4: () => 'test-uuid-' + Date.now()};

    // ✅ Create MediaService instance
    const service = new MediaService(log, indexer, clock, uuid);
    service.db = db;
    service.log = log;

    // ---------------------------------
    // ⚙️ Step 1: Prepare payload
    // ---------------------------------
    const payload = {
        tags: ['rag1', 'rag2', 'tag1'], // Replace with a tag that exists in your DB
        // includeTags: true,  // optional
        // includeCoPerformers: false, // optional
    };

    // ---------------------------------
    // ⚙️ Step 2: Run the method
    // ---------------------------------
    try {
        const result = await service.listByTag(payload);

        console.log('✅ Test finished successfully:');
        console.log(`Found ${result.items?.length || 0} media items for tag "`);

        if (result.items && result.items.length > 0) {
            console.log('Sample item(s):', result.items.slice(0, 5)); // show first 2
        } else {
            console.warn(`⚠️ No items found — ensure the tag "${payload.tag}" exists in your DB`);
        }
    } catch (err) {
        if (err instanceof NotFoundError) {
            console.error(`❌ Test failed: No media found for tag "${payload.tag}"`);
        } else if (err instanceof ConflictError) {
            console.error('❌ Test failed: Conflict error in DB');
        } else {
            console.error('❌ Test failed:', err);
        }
    } finally {
        // ✅ Close DB connection
        if (typeof db.close === 'function') await db.close();
    }
}

// Run directly
testListByTag();
