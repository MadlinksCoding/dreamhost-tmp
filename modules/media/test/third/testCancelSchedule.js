import MediaService from '../../service/MediaHandler.js';
import DB from '../../utils/DB.js'; // Real DB instance
import {NotFoundError, ConflictError, StateTransitionError} from '../../utils/Error_handler.js';

export default async function testCancelSchedule() {
    console.log('Starting test for cancelSchedule...');

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
    service.clock = clock;
    service.indexer = indexer;

    // ---------------------------------
    // ⚙️ Step 1: Ensure a media item exists in DB
    // (Must be SCHEDULED status)
    // ---------------------------------
    const existingMediaId = '5ef95e1f-1b27-4b5f-8807-5cdd419cbf63'; // Replace with a real scheduled media_id

    // ---------------------------------
    // ⚙️ Step 2: Prepare payload for canceling schedule
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
        await service.cancelSchedule(payload);

        console.log('✅ Test finished successfully:');
        console.log(`Media ${existingMediaId} schedule canceled`);
    } catch (err) {
        if (err instanceof NotFoundError) {
            console.error('❌ Test failed: Media not found');
        } else if (err instanceof ConflictError) {
            console.error('❌ Test failed: expectedVersion missing or mismatch');
        } else if (err instanceof StateTransitionError) {
            console.error('❌ Test failed: Media is not in SCHEDULED state');
        } else {
            console.error('❌ Test failed:', err);
        }
    } finally {
        // ✅ Close DB connection if available
        if (typeof db.close === 'function') await db.close();
    }
}

// Run test directly
testCancelSchedule();
