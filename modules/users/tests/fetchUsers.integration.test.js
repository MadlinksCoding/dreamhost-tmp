const request = require('supertest');
const express = require('express');
const dotenv = require('dotenv');
dotenv.config();

// The utils are not mocked, using real implementations

const { router, initUsersService } = require('../server.js');

describe('Users API Integration Tests', () => {
    let app;

    beforeAll(async () => {
        // Initialize the service
        await initUsersService();

        // Clear existing data and insert deterministic test data
        const { db } = require('../src/utils/index.js');
        await db.query('default', 'TRUNCATE users, user_profiles, user_settings CASCADE');

        // Insert test data - 50 deterministic users
        const { randomUUID } = require('crypto');
        for (let i = 1; i <= 50; i++) {
            const uid = `test${i}`;
            const user_name = `user${i}`;
            const display_name = `Test User ${i}`;
            const avatar_url = `https://example.com/avatar${i}.jpg`;
            const role = i % 2 === 0 ? 'creator' : 'vendor';
            const public_uid = randomUUID();
            const country = i % 2 === 0 ? 'USA' : 'Canada';
            await db.query('default', `
                INSERT INTO users (uid, username_lower, display_name, avatar_url, role, public_uid, is_new_user, created_at, email, phone_number)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (uid) DO NOTHING
            `, [uid, user_name, display_name, avatar_url, role, public_uid, false, '2024-01-01T00:00:00Z', `user${i}@example.com`, `+1-555-000-${String(i).padStart(3,'0')}`]);
            await db.query('default', `
                INSERT INTO user_profiles (uid, country, created_at)
                VALUES ($1, $2, $3)
                ON CONFLICT (uid) DO NOTHING
            `, [uid, country, '2024-01-01T00:00:00Z']);
        }

        // Create express app for testing
        app = express();
        app.use(express.json());
        app.use('/', router);
    });

    describe('GET /users/fetchUsers', () => {
        // Test: Default pagination returns 10 users and total count 50
        it('should return users with default pagination', async () => {
            const response = await request(app)
                .get('/users/fetchUsers')
                .expect(200);

            expect(response.body).toHaveProperty('users');
            expect(response.body).toHaveProperty('count');
            expect(Array.isArray(response.body.users)).toBe(true);
            expect(typeof response.body.count).toBe('number');
            expect(response.body.users.length).toBe(10);
            expect(response.body.count).toBe(50);
        });

        // Test: Limit parameter controls number of users returned
        it('should respect limit parameter', async () => {
            const limit = 5;
            const response = await request(app)
                .get(`/users/fetchUsers?limit=${limit}`)
                .expect(200);

            expect(response.body.users.length).toBe(limit);
            expect(response.body.count).toBe(50);
        });

        // Test: Offset parameter skips users correctly
        it('should respect offset parameter', async () => {
            const offset = 10;
            const response = await request(app)
                .get(`/users/fetchUsers?offset=${offset}`)
                .expect(200);

            expect(response.body.users.length).toBe(10);
            expect(response.body.count).toBe(50);
        });

        // Test: Role filter returns only users with specified role
        it('should filter by role', async () => {
            const role = 'creator';
            const response = await request(app)
                .get(`/users/fetchUsers?role=${role}`)
                .expect(200);

            expect(response.body.users.every(user => user.role === role)).toBe(true);
            expect(response.body.users.length).toBe(10);
            expect(response.body.count).toBe(25);
        });

        // Test: Country filter returns only users from specified country
        it('should filter by country', async () => {
            const country = 'USA';
            const response = await request(app)
                .get(`/users/fetchUsers?country=${country}`)
                .expect(200);

            expect(response.body.users.every(user => user.country === country)).toBe(true);
            expect(response.body.users.length).toBe(10);
            expect(response.body.count).toBe(25);
        });

        // Test: Search query filters by user_name or display name
        it('should filter by search query (q)', async () => {
            const q = 'test';
            const response = await request(app)
                .get(`/users/fetchUsers?q=${q}`)
                .expect(200);

            expect(response.body.users.every(user =>
                user.user_name.toLowerCase().includes(q.toLowerCase()) ||
                user.display_name.toLowerCase().includes(q.toLowerCase())
            )).toBe(true);
            expect(response.body.users.length).toBe(10);
            expect(response.body.count).toBe(50);
        });

        // Test: Created from date filter
        it('should filter by created_from date', async () => {
            const created_from = '2024-01-01';
            const response = await request(app)
                .get(`/users/fetchUsers?created_from=${created_from}`)
                .expect(200);

            expect(response.body.users.length).toBe(10);
            expect(response.body.count).toBe(50);
        });

        // Test: Created to date filter
        it('should filter by created_to date', async () => {
            const created_to = '2025-12-31';
            const response = await request(app)
                .get(`/users/fetchUsers?created_to=${created_to}`)
                .expect(200);

            expect(response.body.users.length).toBe(10);
            expect(response.body.count).toBe(50);
        });

        // Test: Combining multiple filters
        it('should combine multiple filters', async () => {
            const role = 'vendor';
            const country = 'Canada';
            const response = await request(app)
                .get(`/users/fetchUsers?role=${role}&country=${country}&limit=10`)
                .expect(200);

            expect(response.body.users.every(user => user.role === role && user.country === country)).toBe(true);
            expect(response.body.users.length).toBe(10);
            expect(response.body.count).toBe(25);
        });

        // Test: UID filter returns only the specified user
        it('should filter by uid', async () => {
            const uid = 'test2';
            const response = await request(app)
                .get(`/users/fetchUsers?uid=${uid}`)
                .expect(200);

            expect(response.body.users.length).toBe(1);
            expect(response.body.users[0].uid).toBe(uid);
            expect(response.body.count).toBe(1);
        });

        // Test: Public UID filter (use public_uid from the record for test2 to avoid dependence on seed values)
        it('should filter by public_uid', async () => {
            // first fetch test2 to get its public_uid
            const byUid = await request(app)
                .get('/users/fetchUsers?uid=test2')
                .expect(200);
            const publicUid = byUid.body.users[0]?.public_uid;

            const response = await request(app)
                .get(`/users/fetchUsers?public_uid=${publicUid}`)
                .expect(200);

            expect(response.body.users.length).toBe(1);
            expect(response.body.users[0].public_uid).toBe(publicUid);
            expect(response.body.count).toBe(1);
        });

        // Test: Username filter
        it('should filter by user_name', async () => {
            const user_name = 'user2';
            const response = await request(app)
                .get(`/users/fetchUsers?user_name=${user_name}`)
                .expect(200);

            expect(response.body.users.length).toBe(1);
            expect(response.body.users[0].user_name).toBe(user_name);
            expect(response.body.count).toBe(1);
        });

        // Test: Display name filter
        it('should filter by display_name', async () => {
            const displayName = 'Test User 2';
            const response = await request(app)
                .get(`/users/fetchUsers?display_name=${displayName}`)
                .expect(200);

            expect(response.body.users.length).toBe(1);
            expect(response.body.users[0].display_name).toBe(displayName);
            expect(response.body.count).toBe(1);
        });

        // Test: Last activity from date (since not set, expect 0)
        it('should filter by last_activity_from', async () => {
            const lastActivityFrom = '2024-01-01';
            const response = await request(app)
                .get(`/users/fetchUsers?last_activity_from=${lastActivityFrom}`)
                .expect(200);

            expect(response.body.users.length).toBe(0);
            expect(response.body.count).toBe(0);
        });

        // Test: Filter by email
        it('should filter by email', async () => {
            const email = 'user2@example.com';
            const response = await request(app)
                .get(`/users/fetchUsers?email=${encodeURIComponent(email)}`)
                .expect(200);

            expect(response.body.users.length).toBe(1);
            expect(response.body.users[0].email).toBe(email);
            expect(response.body.count).toBe(1);
        });

        // Test: Filter by phone_number
        it('should filter by phone_number', async () => {
            const phone = '+1-555-000-002';
            const response = await request(app)
                .get(`/users/fetchUsers?phone_number=${encodeURIComponent(phone)}`)
                .expect(200);

            expect(response.body.users.length).toBe(1);
            expect(response.body.users[0].phone_number).toBe(phone);
            expect(response.body.count).toBe(1);
        });

        // Test: Search query matches email
        it('should filter by q matching email', async () => {
            const q = 'user2@example.com';
            const response = await request(app)
                .get(`/users/fetchUsers?q=${encodeURIComponent(q)}`)
                .expect(200);

            expect(response.body.users.length).toBe(1);
            expect(response.body.users[0].email).toBe(q);
            expect(response.body.count).toBe(1);
        });

        // Test: Search query matches phone number
        it('should filter by q matching phone number', async () => {
            const q = '+1-555-000-002';
            const response = await request(app)
                .get(`/users/fetchUsers?q=${encodeURIComponent(q)}`)
                .expect(200);

            expect(response.body.users.length).toBe(1);
            expect(response.body.users[0].phone_number).toBe(q);
            expect(response.body.count).toBe(1);
        });

        // Test: Non-matching filters return empty results
        it('should return empty array for non-matching filters', async () => {
            const response = await request(app)
                .get('/users/fetchUsers?role=nonexistent')
                .expect(200);

            expect(response.body.users).toEqual([]);
            expect(response.body.count).toBe(0);
        });
    });
});