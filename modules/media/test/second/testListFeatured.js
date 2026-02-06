import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js';
import {NotFoundError, ConflictError} from '../../utils/Error_handler.js';

export default async function testListFeatured() {
    console.log('Starting test for listFeatured...');

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
        // Optional filters can be added here if needed
        // e.g. limit: 10, filters: { media_type: "video" }
    };

    // ---------------------------------
    // ⚙️ Step 2: Run the method
    // ---------------------------------
    try {
        const result = await service.listFeatured(payload);

        console.log('✅ Test finished successfully:');
        console.log(`Found ${result.items?.length || 0} featured media items`);

        if (result.items && result.items.length > 0) {
            console.log('Sample item(s):', result.items.slice(0, 2));
        } else {
            console.warn('⚠️ No featured items found — ensure DB has featured media data');
        }
    } catch (err) {
        if (err instanceof NotFoundError) {
            console.error('❌ Test failed: No featured media found');
        } else if (err instanceof ConflictError) {
            console.error('❌ Test failed: Conflict error in DB');
        } else {
            console.error('❌ Test failed:', err);
        }
    } finally {
        // ✅ Clean up DB connection
        if (typeof db.close === 'function') await db.close();
    }
}

// Run directly
testListFeatured();
