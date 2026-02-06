import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js'; // connects to your real DB

export default async function testSetCoPerformers() {
    console.log('Starting test for setCoPerformers...');

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
    const existingMediaId = 'f4a881fc-440c-4887-a811-bf6c6a9ed70e'; // Replace with your actual media_id
    const expectedVersion = 3; // must match the current version in your DB

    // ---------------------------------
    // ⚙️ Step 2: Prepare payload
    // ---------------------------------
    const payload = {
        media_id: existingMediaId,
        expectedVersion, // must match DB version
        performerIds: ['101', '102', '12jjs'], // example performer IDs to set
        actorUserId: 42,
    };

    // ---------------------------------
    // ⚙️ Step 3: Run the method
    // ---------------------------------
    try {
        const result = await service.setCoPerformers(payload);
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
testSetCoPerformers();
