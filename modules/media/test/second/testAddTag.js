import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js'; // connects to your real DB

export default async function testAddTag() {
    console.log('Starting test for addTag...');

    // ✅ Real DB instance
    const db = new DB();

    // ✅ Logger and dependencies
    const log = {info: (...args) => console.log('LOG:', ...args)};
    const indexer = {upsert: async (id) => console.log('Indexer upsert:', id)};
    const clock = {now: () => new Date()};
    const uuid = {v4: () => 'test-uuid-' + Date.now()};

    // ✅ Create MediaService instance
    const service = new MediaService(log, indexer, clock, uuid);
    service.db = db;
    service.log = log;

    // ---------------------------------
    // ⚙️ Step 1: Ensure a media record exists in your DB
    // ---------------------------------
    const existingMediaId = 'test123'; // Replace with a real media_id

    // ---------------------------------
    // ⚙️ Step 2: Prepare payload
    // ---------------------------------
    const payload = {
        media_id: existingMediaId,
        expectedVersion: 1, // must match the version in your media table
        tags: ['fortune', 'winner'], // example tags to apply
        actorUserId: 42,
    };

    // ---------------------------------
    // ⚙️ Step 3: Run the method
    // ---------------------------------
    try {
        const result = await service.addTag(payload);
        console.log('✅ Test finished successfully:');
        console.log(result);
    } catch (err) {
        console.error('❌ Test failed:', err);
    } finally {
        // ✅ Always close DB connection if available
        if (typeof db.close === 'function') await db.close();
    }
}

// Run directly
testAddTag();
