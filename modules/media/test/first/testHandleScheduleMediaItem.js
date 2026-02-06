const MediaService = require('../../src/service/MediaHandler.js');
const {DB} = require('../../src/utils/index.js');
const {runTest, assertEqual} = require('../../src/utils/TestUtils.js');

async function testHandleScheduleMediaItem() {
    console.log('\n--- Running Suite: handleScheduleMediaItem ---');

    const db = new DB({});
    const log = {info: (...args) => {}, debug: (...args) => {}, error: (...args) => {}};
    const indexer = {upsert: async (id) => {}};
    
    const service = new MediaService({db, log, indexer});

    await runTest('handleScheduleMediaItem: Schedule a media item', async () => {
        // Step 1: Create a media item first
        const addResult = await service.addRow({
            owner_user_id: 'user123',
            media_type: 'video',
            actorUserId: 'actor123',
            title: 'Test Video',
            asset_url: 'https://example.com/video.mp4',
            poster_url: 'https://example.com/poster.jpg',
            duration_seconds: 60,
            pending_conversion: false
        });

        // Step 2: Prepare payload for scheduling
        // Set publish_date to 48 hours and 5 minutes in the future and format as 'yyyy-MM-dd HH:mm:ss' in Asia/Hong_Kong timezone
        const bufferMs = 5 * 60 * 1000; // 5 minutes buffer
        const future = new Date(Date.now() + 48 * 60 * 60 * 1000 + bufferMs);
        // Convert to Asia/Hong_Kong time
        const hkOffset = -8 * 60; // Asia/Hong_Kong is UTC+8, offset in minutes
        const local = new Date(future.getTime() + (future.getTimezoneOffset() - hkOffset) * 60000);
        const pad = (n) => n.toString().padStart(2, '0');
        const publishDateHK = `${local.getFullYear()}-${pad(local.getMonth()+1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
        const payload = {
            media_id: addResult.media_id,
            expectedVersion: 1, 
            publish_date: publishDateHK,
            actorUserId: 'actor123',
        };

        // Step 3: Run the method
        const result = await service.handleScheduleMediaItem(payload);
        assertEqual(result.media_id, addResult.media_id, 'Should return correct media ID');
        assertEqual(result.status, 'scheduled', 'Result status should be scheduled');
        
        const mediaRecord = await service.getById({media_id: addResult.media_id});
        assertEqual(mediaRecord.status, 'scheduled', 'DB status should be scheduled');
        // Note: DB stores timestamps, might need normalization for comparison if we wanted to check publish_date
    });
}

module.exports =  testHandleScheduleMediaItem ;
