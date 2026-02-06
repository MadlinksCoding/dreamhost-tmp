const express = require('express');
const request = require('supertest');
const { router, initMediaService } = require('../../server.js');

async function testAddNote() {
    await initMediaService();
    const app = express();
    app.use(express.json());
    app.use('/', router);

    // Create item first
    const createRes = await request(app)
        .post('/media/createMediaItem')
        .set('x-actor-user-id', 'tester')
        .send({
            owner_user_id: 'user1',
            media_type: 'image',
            title: 'Test',
            visibility: 'public'
        });
    
    console.log('Create Response Body:', JSON.stringify(createRes.body, null, 2));
    const mediaId = createRes.body.media.media_id;
    const version = createRes.body.media.version;

    console.log(`Created media ${mediaId} with version ${version}`);

    const addNoteRes = await request(app)
        .post(`/media/addNote/${mediaId}`)
        .send({
            note: 'Test note',
            addedBy: 'tester',
            expectedVersion: version,
            actorUserId: 'tester'
        });

    console.log('AddNote Status:', addNoteRes.status);
    console.log('AddNote Body:', JSON.stringify(addNoteRes.body, null, 2));

    process.exit(addNoteRes.status === 200 ? 0 : 1);
}

module.exports = testAddNote ;

if (require.main === module) {
    testAddNote();
}