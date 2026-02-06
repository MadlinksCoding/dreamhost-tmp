import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js';
import {NotFoundError, ConflictError} from '../../utils/Error_handler.js';

export default async function testListByOwner() {
    console.log('Starting test for listByOwner...');

    // ✅ Real DB instance
    const db = new DB();

    // ✅ Simple logger + dependencies
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
    // ⚙️ Step 1: Provide an existing owner_user_id in DB
    // ---------------------------------
    const existingOwnerUserId = '42'; // 🧠 Replace with a real owner_user_id that exists in your DB

    // ---------------------------------
    // ⚙️ Step 2: Prepare payload
    // ---------------------------------
    const payload = {
        owner_user_id: existingOwnerUserId,
        includeTags: true, // optional filters
        includeCoPerformers: false,
    };

    // ---------------------------------
    // ⚙️ Step 3: Run the method
    // ---------------------------------
    try {
        const result = await service.listByOwner(payload);

        console.log('✅ Test finished successfully:');
        console.log(
            `Found ${result.items?.length || 0} media items for owner ${existingOwnerUserId}`,
        );

        if (result.items && result.items.length > 0) {
            console.log('Sample item:', result.items);
        } else {
            console.warn('⚠️ No items found — check if owner_user_id exists in your DB');
        }
    } catch (err) {
        if (err instanceof NotFoundError) {
            console.error('❌ Test failed: Owner not found');
        } else if (err instanceof ConflictError) {
            console.error('❌ Test failed: Conflict error');
        } else {
            console.error('❌ Test failed:', err);
        }
    } finally {
        if (typeof db.close === 'function') await db.close();
    }
}

// Run directly
testListByOwner();
