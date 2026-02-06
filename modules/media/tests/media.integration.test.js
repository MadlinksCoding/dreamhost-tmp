/**
 * endpoint_integration.js — Comprehensive Integration tests for Media API
 */

const express = require('express');
const request = require('supertest');
const { router, initMediaService } = require('../server.js');
const { DB } = require('../src/utils/index.js');

async function runIntegrationTests() {
    console.log('--- STARTING MEDIA COMPREHENSIVE INTEGRATION TESTS ---');
    
    // Initialize DB and Service
    await initMediaService();
    
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        // Mock actor header if not present
        if (!req.headers['x-actor-user-id']) {
            req.headers['x-actor-user-id'] = 'tester_actor';
        }
        next();
    });
    app.use('/', router);

    const db = new DB();
    const connection = 'default';

    let testMediaId = 'int_test_' + Date.now();

    // 1. Test POST /media/createMediaItem
    console.log('\n1. Testing: POST /media/createMediaItem');
    const createRes = await request(app)
        .post('/media/createMediaItem')
        .send({
            owner_user_id: 'user_tester',
            media_type: 'video',
            title: 'Integration Test Video',
            description: 'Testing the full flow',
            visibility: 'public',
            asset_url: 'https://example.com/test.mp4',
            poster_url: 'https://example.com/poster.jpg',
            duration_seconds: 60,
            file_size_bytes: 1024 * 1024,
            pending_conversion: false
        });
    
    if (createRes.status !== 201) throw new Error(`Create failed: ${JSON.stringify(createRes.body)}`);
    testMediaId = createRes.body.media.media_id;
    console.log(`✓ Create passed. Created ID: ${testMediaId}`);

    // 2. Test GET /media/fetchMediaItemById/:mediaId
    console.log('\n2. Testing: GET /media/fetchMediaItemById');
    const getByIdRes = await request(app).get(`/media/fetchMediaItemById/${testMediaId}`);
    if (getByIdRes.status !== 200) throw new Error(`GetById failed: ${JSON.stringify(getByIdRes.body)}`);
    if (getByIdRes.body.item.media_id !== testMediaId) throw new Error('ID mismatch in GetById');
    console.log('✓ GetById passed');

    // 3. Test PUT /media/updateMediaItem/:mediaId
    console.log('\n3. Testing: PUT /media/updateMediaItem');
    const updateRes = await request(app)
        .put(`/media/updateMediaItem/${testMediaId}`)
        .send({
            title: 'Updated Integration Title',
            expectedVersion: getByIdRes.body.item.version
        });
    if (updateRes.status !== 200) throw new Error(`Update failed: ${JSON.stringify(updateRes.body)}`);
    console.log('✓ Update passed. Version after update:', updateRes.body.item.version);

    // 4. Test POST /media/addNote/:mediaId
    console.log('\n4. Testing: POST /media/addNote');
    const notePayload = {
        note: 'This is a test note',
        addedBy: 'tester',
        expectedVersion: updateRes.body.item.version,
        actorUserId: 'tester_actor'
    };
    console.log('Sending AddNote Payload:', JSON.stringify(notePayload, null, 2));
    
    const addNoteRes = await request(app)
        .post(`/media/addNote/${testMediaId}`)
        .send(notePayload);
    if (addNoteRes.status !== 200) {
        console.error('AddNote FAILED. Status:', addNoteRes.status);
        console.error('AddNote Body:', addNoteRes.body);
        throw new Error(`AddNote failed with status ${addNoteRes.status}: ${JSON.stringify(addNoteRes.body)}`);
    }
    console.log('✓ AddNote passed');

    // 5. Test POST /media/publishMediaItem/:mediaId
    console.log('\n5. Testing: POST /media/publishMediaItem');
    const publishRes = await request(app)
        .post(`/media/publishMediaItem/${testMediaId}`)
        .send({
            expectedVersion: addNoteRes.body.version
        });
    if (publishRes.status !== 200) {
        console.error('Publish FAILED. Status:', publishRes.status);
        console.error('Publish Body:', publishRes.body);
        throw new Error(`Publish failed with status ${publishRes.status}: ${JSON.stringify(publishRes.body)}`);
    }
    console.log('✓ Publish passed');

    // 6. Test GET /media/fetchMediaItems with New Filters
    console.log('\n6. Testing: GET /media/fetchMediaItems (Filters)');
    
    // Filter by Title
    const filterTitleRes = await request(app).get('/media/fetchMediaItems?title=Updated%20Integration');
    if (!filterTitleRes.body.items.some(i => i.media_id === testMediaId)) throw new Error('Title filter failed');
    console.log('✓ Title filter passed');

    // Filter by q (Global Search)
    const filterQRes = await request(app).get('/media/fetchMediaItems?q=Integration');
    if (!filterQRes.body.items.some(i => i.media_id === testMediaId)) throw new Error('Global search (q) filter failed');
    console.log('✓ Global search (q) passed');

    // Filter by Media Type
    const filterTypeRes = await request(app).get('/media/fetchMediaItems?media_type=video');
    if (!filterTypeRes.body.items.every(i => i.media_type === 'video')) throw new Error('Media type filter failed');
    console.log('✓ Media type filter passed');

    // Filter by Status
    const filterStatusRes = await request(app).get('/media/fetchMediaItems?status=published');
    if (!filterStatusRes.body.items.some(i => i.media_id === testMediaId)) throw new Error('Status filter failed');
    console.log('✓ Status filter passed');

    // Sorting
    const sortRes = await request(app).get('/media/fetchMediaItems?sort_by=created_at&sort_order=desc');
    if (sortRes.status !== 200) throw new Error('Sorting failed');
    console.log('✓ Sorting passed');

    // 7. Test DELETE /media/deleteMediaItem/:mediaId
    console.log('\n7. Testing: DELETE /media/deleteMediaItem');
    const deleteRes = await request(app).delete(`/media/deleteMediaItem/${testMediaId}`);
    if (deleteRes.status !== 200) throw new Error(`Delete failed: ${JSON.stringify(deleteRes.body)}`);
    
    const verifyDelete = await request(app).get(`/media/fetchMediaItemById/${testMediaId}`);
    if (verifyDelete.body.item.is_deleted !== true) throw new Error('Soft delete verification failed');
    console.log('✓ Delete passed');

    console.log('\nALL COMPREHENSIVE INTEGRATION TESTS PASSED!');
    process.exit(0);
}

runIntegrationTests().catch(err => {
    console.error('Integration tests failed:', err);
    process.exit(1);
});
