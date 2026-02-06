import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js'; // Real DB instance

export default async function testSetStatusPublished() {
    console.log('Starting test for setStatusPublished...');

    // ✅ Real DB instance
    const db = new DB();

    // ✅ Simple logger + dependencies
    const log = {info: (...args) => console.log('LOG:', ...args)};
    const indexer = {upsert: async (id) => console.log('Indexer upsert:', id)};
    const clock = {now: () => new Date()};
    const uuid = {v4: () => 'test-uuid-' + Date.now()};

    // ✅ Create MediaService instance
    const service = new MediaService(log, indexer, clock, uuid);
    service.db = db;
    service.log = log;

    // ---------------------------------
    // ⚙️ Step 1: Ensure a media item exists in DB
    // (You can reuse handleAddMediaItem or insert manually)
    // ---------------------------------
    const existingMediaId = '5ef95e1f-1b27-4b5f-8807-5cdd419cbf63'; // Replace with a real media_id

    // ---------------------------------
    // ⚙️ Step 2: Prepare payload for publishing
    // ---------------------------------
    const payload = {
        media_id: existingMediaId,
        expectedVersion: 1, // Replace with actual version from DB
        actorUserId: 99,
    };

    // ---------------------------------
    // ⚙️ Step 3: Run the method
    // ---------------------------------
    try {
        const result = await service.setStatusPublished(payload);

        console.log('✅ Test finished successfully:');
        console.log(`Media ${existingMediaId} status set to PUBLISHED:`, result);
    } catch (err) {
        console.error('❌ Test failed:', err);
    } finally {
        // ✅ Close DB connection if available
        if (typeof db.close === 'function') await db.close();
    }
}

// Run test directly
testSetStatusPublished();
