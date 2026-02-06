import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js';
import {NotFoundError, ConflictError} from '../../utils/Error_handler.js';

export default async function testListComingSoon() {
    console.log('Starting test for listComingSoon...');

    // ✅ Create a real DB instance
    const db = new DB();

    // ✅ Basic dependencies (logger, indexer, clock, uuid)
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
    const payload = {};

    // ---------------------------------
    // ⚙️ Step 2: Run the method
    // ---------------------------------
    try {
        const result = await service.listComingSoon(payload);

        console.log('✅ Test finished successfully:');
        console.log(`Found ${result.items?.length || 0} coming soon media items`);

        if (result.items && result.items.length > 0) {
            console.log('Sample item(s):', result.items.slice(0, 2)); // show first 2 items
        } else {
            console.warn('⚠️ No coming soon items found — ensure DB has relevant data');
        }
    } catch (err) {
        if (err instanceof NotFoundError) {
            console.error('❌ Test failed: No coming soon media found');
        } else if (err instanceof ConflictError) {
            console.error('❌ Test failed: Conflict error in DB');
        } else {
            console.error('❌ Test failed:', err);
        }
    } finally {
        // ✅ Always close DB connection
        if (typeof db.close === 'function') await db.close();
    }
}

// Run directly
testListComingSoon();
