import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js'; // Real DB instance

export default async function testCreateCollection() {
    console.log('Starting test for createCollection...');

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
        owner_user_id: '42', // replace with a real user in your DB
        title: 'Test Collection',
        description: 'Collection created during test',
        visibility: 'public', // optional, defaults to PRIVATE
        poster_url: 'http://example.com/poster.jpg',
        actorUserId: 99, // user performing the action
    };

    // ---------------------------------
    // ⚙️ Step 2: Run the method
    // ---------------------------------
    try {
        const result = await service.createCollection(payload);

        console.log('✅ Test finished successfully:');
        console.log(`Created collection with ID: ${result.collection_id}`);
    } catch (err) {
        console.error('❌ Test failed:', err);
    } finally {
        // ✅ Close DB connection if available
        if (typeof db.close === 'function') await db.close();
    }
}

// Run directly
testCreateCollection();
