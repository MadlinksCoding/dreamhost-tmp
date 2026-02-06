import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js'; // connects to your real PostgreSQL DB

export default async function testRemoveTag() {
    console.log('Starting test for removeTag...');

    // ✅ Create real DB instance
    const db = new DB();

    // ✅ Dependencies
    const log = {info: (...args) => console.log('LOG:', ...args)};
    const indexer = {upsert: async (id) => console.log('Indexer upsert:', id)};
    const clock = {now: () => new Date()};
    const uuid = {v4: () => 'test-uuid-' + Date.now()};

    // ✅ Create MediaService instance
    const service = new MediaService(log, indexer, clock, uuid);
    service.db = db;
    service.log = log;

    // ---------------------------------
    // ⚙️ Step 1: Ensure your media record exists in DB
    // ---------------------------------
    const existingMediaId = 'test123'; // replace with actual ID in your media table
    const expectedVersion = 4; // update according to your DB (must match `media.version` column)

    // ---------------------------------
    // ⚙️ Step 2: Prepare payload (tag to remove)
    // ---------------------------------
    const payload = {
        media_id: existingMediaId,
        expectedVersion, // must match DB version
        tags: ['fortune'], // tag you want to remove
        actorUserId: 42,
    };

    // ---------------------------------
    // ⚙️ Step 3: Run the method
    // ---------------------------------
    try {
        const result = await service.removeTag(payload);
        console.log('✅ Test finished successfully:');
        console.log(result);
    } catch (err) {
        console.error('❌ Test failed:', err);
    } finally {
        // ✅ Close DB connection cleanly
        if (typeof db.close === 'function') await db.close();
    }
}

// Run directly
testRemoveTag();
