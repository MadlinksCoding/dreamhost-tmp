import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js';
import {NotFoundError, ConflictError} from '../../utils/Error_handler.js';

export default async function testListPublic() {
    console.log('Starting test for listPublic...');

    // ✅ Create a real DB instance
    const db = new DB();

    // ✅ Basic dependencies (same as listByOwner)
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
        const result = await service.listPublic(payload);

        console.log('✅ Test finished successfully:');
        console.log(`Found ${result.items?.length || 0} public media items`);

        if (result.items && result.items.length > 0) {
            console.log('Sample item(s):', result.items); // show first 2
        } else {
            console.warn('⚠️ No public items found — ensure DB has public media data');
        }
    } catch (err) {
        if (err instanceof NotFoundError) {
            console.error('❌ Test failed: No public media found');
        } else if (err instanceof ConflictError) {
            console.error('❌ Test failed: Conflict error in DB');
        } else {
            console.error('❌ Test failed:', err);
        }
    } finally {
        if (typeof db.close === 'function') await db.close();
    }
}

// Run directly
testListPublic();
