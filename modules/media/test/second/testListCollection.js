import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js'; // Real DB instance

export default async function testListCollection() {
    console.log('Starting test for listCollection...');

    // ✅ Real DB instance
    const db = new DB();

    // ✅ Basic dependencies
    const log = {info: (...args) => console.log('LOG:', ...args)};
    const indexer = {upsert: async () => {}, delete: async () => {}};
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
        collection_id: 'e8f4b929-4c60-4edb-ad8c-bd7211a2f513', // Replace with a real collection_id in your DB
        limit: 10, // Optional, defaults to 24
    };

    // ---------------------------------
    // ⚙️ Step 2: Run the method
    // ---------------------------------
    try {
        const result = await service.listCollection(payload);

        console.log('✅ Test finished successfully:');
        console.log(
            `Found ${result.items?.length || 0} items in collection ${payload.collection_id}`,
        );

        if (result.items && result.items.length > 0) {
            console.log('Sample item(s):', result.items.slice(0, 2));
        } else {
            console.warn('⚠️ No items found — ensure collection_id exists and has media items');
        }
    } catch (err) {
        console.error('❌ Test failed:', err);
    } finally {
        // ✅ Close DB connection if available
        if (typeof db.close === 'function') await db.close();
    }
}

// Run directly
testListCollection();
