import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js'; // Real DB instance

export default async function testAddToCollection() {
    console.log('Starting test for addToCollection...');

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
        collection_id: 'e8f4b929-4c60-4edb-ad8c-bd7211a2f513', // Replace with real collection_id
        media_id: 'test123', // Replace with real media_id
        position: 1, // Optional
        actorUserId: 99, // User performing the action
    };

    // ---------------------------------
    // ⚙️ Step 2: Run the method
    // ---------------------------------
    try {
        const result = await service.addToCollection(payload);

        console.log('✅ Test finished successfully:');
        console.log(`Added media ${result.media_id} to collection ${result.collection_id}`);
    } catch (err) {
        console.error('❌ Test failed:', err);
    } finally {
        // ✅ Close DB connection if available
        if (typeof db.close === 'function') await db.close();
    }
}

// Run directly
testAddToCollection();
