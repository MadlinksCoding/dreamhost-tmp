const request = require('supertest');
const { expect } = require('chai');
const express = require('express');
const cors = require('cors');
const { router, initBlockUserService } = require('../server.js');

describe('BlockService API Integration Tests', () => {
  let app;
  let server;

  before(async () => {
    // Create express app for testing
    app = express();

    // Middleware (same as main server)
    app.use(cors());
    app.use(express.json());

    // Mount the block user service router
    app.use('/', router);

    // Initialize the service
    await initBlockUserService();

    server = app.listen(0); // Use random port for testing
  });

  after(async () => {
    if (server) {
      server.close();
    }
  });

  describe('GET /block-users/listUserBlocks', () => {
    before(async () => {
      // Seed some test data for consistent testing
      try {
        const timestamp = Date.now(); // Use timestamp to ensure unique test data

        // Create blocks with different created_at timestamps for sorting tests
        await new Promise(resolve => setTimeout(resolve, 100));
        await request(app).post('/block-users/blockUser').send({
          from: `sort_test_blocker_1_${timestamp}`,
          to: `sort_test_target_1_${timestamp}`,
          scope: 'private_chat',
          is_permanent: true,
          testing: true,
          reason: 'Sort test block 1'
        }).catch(err => {
          // Ignore if block already exists
          if (!err.message.includes('Block already exists')) throw err;
        });

        await new Promise(resolve => setTimeout(resolve, 100));
        await request(app).post('/block-users/blockUser').send({
          from: `sort_test_blocker_2_${timestamp}`,
          to: `sort_test_target_2_${timestamp}`,
          scope: 'feed',
          is_permanent: true,
          testing: true,
          reason: 'Sort test block 2'
        }).catch(err => {
          if (!err.message.includes('Block already exists')) throw err;
        });

        await new Promise(resolve => setTimeout(resolve, 100));
        await request(app).post('/block-users/blockUser').send({
          from: `sort_test_blocker_3_${timestamp}`,
          to: `sort_test_target_3_${timestamp}`,
          scope: 'private_chat',
          is_permanent: true,
          testing: true,
          reason: 'Sort test block 3'
        }).catch(err => {
          if (!err.message.includes('Block already exists')) throw err;
        });

        // Wait for eventual consistency
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error) {
        console.log('Test data seeding failed:', error.message);
      }
    });

    after(async () => {
      // Clean up test data
      try {
        // Get all test blocks and delete them
        const response = await request(app)
          .get('/block-users/listUserBlocks')
          .query({
            testing: true,
            limit: 1000 // Get all test blocks
          });

        if (response.body.success && response.body.items.length > 0) {
          // Delete each test block
          for (const block of response.body.items) {
            try {
              await request(app).delete('/block-users/unblockUser').send({
                from: block.blocker_id,
                to: block.blocked_id,
                scope: block.scope,
                testing: true
              });
            } catch (err) {
              console.error(`Failed to delete block ${block.id}:`, err.message);
            }
          }
        }
      } catch (error) {
        console.error('Error cleaning up test data:', error);
      }
    });

    it('should filter by blocker_id using blocker_id parameter', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          blocker_id: 'integration_test_blocker',
          show_total_count: 1,
          limit: 10
        })
        .expect(200);

      expect(response.body).to.have.property('success', true);
      expect(response.body).to.have.property('items').that.is.an('array');
      expect(response.body).to.have.property('count').that.is.a('number');
      expect(response.body).to.have.property('totalCount').that.is.a('number');

      // All returned items should have the correct blocker_id
      response.body.items.forEach(item => {
        expect(item.blocker_id).to.equal('integration_test_blocker');
      });
    });

    it('should filter by blocker_id using from parameter (backward compatibility)', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          from: 'integration_test_blocker',
          show_total_count: 1,
          limit: 10
        })
        .expect(200);

      expect(response.body).to.have.property('success', true);
      expect(response.body).to.have.property('items').that.is.an('array');

      // All returned items should have the correct blocker_id
      response.body.items.forEach(item => {
        expect(item.blocker_id).to.equal('integration_test_blocker');
      });
    });

    it('should return empty results for non-existent blocker_id', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          blocker_id: 'non_existent_blocker_12345',
          show_total_count: 1,
          limit: 10
        })
        .expect(200);

      expect(response.body).to.have.property('success', true);
      expect(response.body).to.have.property('items').that.is.an('array').with.lengthOf(0);
      expect(response.body).to.have.property('count', 0);
      expect(response.body).to.have.property('totalCount', 0);
    });

    it('should filter by scope', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          scope: 'private_chat',
          testing: true,
          show_total_count: 1,
          limit: 10
        })
        .expect(200);

      expect(response.body).to.have.property('success', true);
      expect(response.body).to.have.property('items').that.is.an('array');

      // All returned items should have the correct scope
      response.body.items.forEach(item => {
        expect(item.scope).to.equal('private_chat');
      });
    });

    it('should filter by testing flag', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          show_total_count: 1,
          limit: 10
        })
        .expect(200);

      expect(response.body).to.have.property('success', true);
      expect(response.body).to.have.property('items').that.is.an('array');

      // All returned items should have testing = true
      response.body.items.forEach(item => {
        expect(item.testing).to.equal(true);
      });
    });

    it('should handle pagination correctly', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          limit: 2,
          show_total_count: 1
        })
        .expect(200);

      expect(response.body).to.have.property('success', true);
      expect(response.body.items.length).to.be.at.most(2);
      expect(response.body).to.have.property('count').that.is.at.most(2);

      if (response.body.items.length === 2) {
        expect(response.body).to.have.property('nextToken').that.is.a('string');
      }
    });

    it('should respect limit parameter', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          limit: 1,
          show_total_count: 1
        })
        .expect(200);

      expect(response.body).to.have.property('success', true);
      expect(response.body.items.length).to.be.at.most(1);
      expect(response.body.count).to.be.at.most(1);
    });

    it('should handle invalid limit parameter', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          limit: -1
        })
        .expect(400);

      expect(response.body).to.have.property('error').that.includes('limit must be a positive number');
    });

    it('should handle invalid limit type', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          limit: 'not_a_number'
        })
        .expect(400);

      expect(response.body).to.have.property('error').that.includes('limit must be a positive number');
    });

    it('should combine multiple filters correctly', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          blocker_id: 'integration_test_blocker',
          scope: 'private_chat',
          testing: true,
          show_total_count: 1,
          limit: 10
        })
        .expect(200);

      expect(response.body).to.have.property('success', true);
      expect(response.body).to.have.property('items').that.is.an('array');

      // All returned items should match all filters
      response.body.items.forEach(item => {
        expect(item.blocker_id).to.equal('integration_test_blocker');
        expect(item.scope).to.equal('private_chat');
        expect(item.testing).to.equal(true);
      });
    });

    it('should sort by created_at descending (default)', async () => {
      // First, get a large dataset of test items to verify sorting against
      const largeDatasetResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          limit: 300, // Get up to 300 test items
          show_total_count: true
        })
        .expect(200);

      expect(largeDatasetResponse.body).to.have.property('success', true);
      expect(largeDatasetResponse.body).to.have.property('items').that.is.an('array');

      const testItems = largeDatasetResponse.body.items;
      expect(testItems.length).to.be.greaterThan(10, 'Need at least 10 test items for meaningful sort validation');

      // Sort the items manually by created_at descending to get expected order
      const expectedOrder = [...testItems].sort((a, b) => b.created_at - a.created_at);

      // Now query the API with sorting to get the actual sorted results
      const sortedResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          sort_by: 'created_at',
          sort_order: 'desc',
          limit: 1000 // Large limit to get all items
        })
        .expect(200);

      expect(sortedResponse.body).to.have.property('success', true);
      expect(sortedResponse.body).to.have.property('items').that.is.an('array');

      const sortedItems = sortedResponse.body.items;
      expect(sortedItems.length).to.be.at.least(testItems.length, 'Should return at least as many items as in the large dataset');

      // Verify that the first N items (where N is the size of our test dataset) are correctly sorted
      // by comparing against the expected order
      for (let i = 0; i < Math.min(expectedOrder.length, sortedItems.length); i++) {
        expect(sortedItems[i].id).to.equal(expectedOrder[i].id,
          `Item at position ${i} should be ${expectedOrder[i].id} but got ${sortedItems[i].id}`);
      }

      // Additionally verify the sort order is correct by checking timestamps
      for (let i = 1; i < Math.min(50, sortedItems.length); i++) { // Check first 50 items
        expect(sortedItems[i-1].created_at).to.be.at.least(sortedItems[i].created_at,
          `Item ${i-1} created_at (${sortedItems[i-1].created_at}) should be >= item ${i} created_at (${sortedItems[i].created_at})`);
      }
    });

    it('should sort by created_at ascending', async () => {
      // First, get a large dataset of test items to verify sorting against
      const largeDatasetResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          limit: 300, // Get up to 300 test items
          show_total_count: true
        })
        .expect(200);

      expect(largeDatasetResponse.body).to.have.property('success', true);
      expect(largeDatasetResponse.body).to.have.property('items').that.is.an('array');

      const testItems = largeDatasetResponse.body.items;
      expect(testItems.length).to.be.greaterThan(10, 'Need at least 10 test items for meaningful sort validation');

      // Sort the items manually by created_at ascending to get expected order
      const expectedOrder = [...testItems].sort((a, b) => a.created_at - b.created_at);

      // Now query the API with sorting to get the actual sorted results
      const sortedResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          sort_by: 'created_at',
          sort_order: 'asc',
          limit: 1000 // Large limit to get all items
        })
        .expect(200);

      expect(sortedResponse.body).to.have.property('success', true);
      expect(sortedResponse.body).to.have.property('items').that.is.an('array');

      const sortedItems = sortedResponse.body.items;
      expect(sortedItems.length).to.be.at.least(testItems.length, 'Should return at least as many items as in the large dataset');

      // Verify that the first N items (where N is the size of our test dataset) are correctly sorted
      // by comparing against the expected order
      for (let i = 0; i < Math.min(expectedOrder.length, sortedItems.length); i++) {
        expect(sortedItems[i].id).to.equal(expectedOrder[i].id,
          `Item at position ${i} should be ${expectedOrder[i].id} but got ${sortedItems[i].id}`);
      }

      // Additionally verify the sort order is correct by checking timestamps
      for (let i = 1; i < Math.min(50, sortedItems.length); i++) { // Check first 50 items
        expect(sortedItems[i-1].created_at).to.be.at.most(sortedItems[i].created_at,
          `Item ${i-1} created_at (${sortedItems[i-1].created_at}) should be <= item ${i} created_at (${sortedItems[i].created_at})`);
      }
    });

    it('should sort by updated_at descending', async () => {
      // First, get a large dataset of test items to verify sorting against
      const largeDatasetResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          limit: 300, // Get up to 300 test items
          show_total_count: true
        })
        .expect(200);

      expect(largeDatasetResponse.body).to.have.property('success', true);
      expect(largeDatasetResponse.body).to.have.property('items').that.is.an('array');

      const testItems = largeDatasetResponse.body.items;
      expect(testItems.length).to.be.greaterThan(10, 'Need at least 10 test items for meaningful sort validation');

      // Sort the items manually by updated_at descending to get expected order
      const expectedOrder = [...testItems].sort((a, b) => b.updated_at - a.updated_at);

      // Now query the API with sorting to get the actual sorted results
      const sortedResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          sort_by: 'updated_at',
          sort_order: 'desc',
          limit: 1000 // Large limit to get all items
        })
        .expect(200);

      expect(sortedResponse.body).to.have.property('success', true);
      expect(sortedResponse.body).to.have.property('items').that.is.an('array');

      const sortedItems = sortedResponse.body.items;
      expect(sortedItems.length).to.be.at.least(testItems.length, 'Should return at least as many items as in the large dataset');

      // Verify that the first N items (where N is the size of our test dataset) are correctly sorted
      // by comparing against the expected order
      for (let i = 0; i < Math.min(expectedOrder.length, sortedItems.length); i++) {
        expect(sortedItems[i].id).to.equal(expectedOrder[i].id,
          `Item at position ${i} should be ${expectedOrder[i].id} but got ${sortedItems[i].id}`);
      }

      // Additionally verify the sort order is correct by checking timestamps
      for (let i = 1; i < Math.min(50, sortedItems.length); i++) { // Check first 50 items
        expect(sortedItems[i-1].updated_at).to.be.at.least(sortedItems[i].updated_at,
          `Item ${i-1} updated_at (${sortedItems[i-1].updated_at}) should be >= item ${i} updated_at (${sortedItems[i].updated_at})`);
      }
    });

    it('should sort by updated_at ascending', async () => {
      // First, get a large dataset of test items to verify sorting against
      const largeDatasetResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          limit: 300, // Get up to 300 test items
          show_total_count: true
        })
        .expect(200);

      expect(largeDatasetResponse.body).to.have.property('success', true);
      expect(largeDatasetResponse.body).to.have.property('items').that.is.an('array');

      const testItems = largeDatasetResponse.body.items;
      expect(testItems.length).to.be.greaterThan(10, 'Need at least 10 test items for meaningful sort validation');

      // Sort the items manually by updated_at ascending to get expected order
      const expectedOrder = [...testItems].sort((a, b) => a.updated_at - b.updated_at);

      // Now query the API with sorting to get the actual sorted results
      const sortedResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          sort_by: 'updated_at',
          sort_order: 'asc',
          limit: 1000 // Large limit to get all items
        })
        .expect(200);

      expect(sortedResponse.body).to.have.property('success', true);
      expect(sortedResponse.body).to.have.property('items').that.is.an('array');

      const sortedItems = sortedResponse.body.items;
      expect(sortedItems.length).to.be.at.least(testItems.length, 'Should return at least as many items as in the large dataset');

      // Verify that the first N items (where N is the size of our test dataset) are correctly sorted
      // by comparing against the expected order
      for (let i = 0; i < Math.min(expectedOrder.length, sortedItems.length); i++) {
        expect(sortedItems[i].id).to.equal(expectedOrder[i].id,
          `Item at position ${i} should be ${expectedOrder[i].id} but got ${sortedItems[i].id}`);
      }

      // Additionally verify the sort order is correct by checking timestamps
      for (let i = 1; i < Math.min(50, sortedItems.length); i++) { // Check first 50 items
        expect(sortedItems[i-1].updated_at).to.be.at.most(sortedItems[i].updated_at,
          `Item ${i-1} updated_at (${sortedItems[i-1].updated_at}) should be <= item ${i} updated_at (${sortedItems[i].updated_at})`);
      }
    });

    it('should handle invalid sort_by parameter', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          sort_by: 'invalid_field',
          limit: 5
        })
        .expect(400);

      expect(response.body).to.have.property('error').that.includes('sort_by must be one of');
    });

    it('should handle invalid sort_order parameter', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          sort_by: 'created_at',
          sort_order: 'invalid_order',
          limit: 5
        })
        .expect(400);

      expect(response.body).to.have.property('error').that.includes("sort_order must be 'asc' or 'desc'");
    });

    it('should return test data when filtering by testing=true', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          show_total_count: 1,
          limit: 20
        })
        .expect(200);

      expect(response.body).to.have.property('success', true);
      expect(response.body).to.have.property('items').that.is.an('array');
      expect(response.body).to.have.property('count').that.is.a('number');
      expect(response.body).to.have.property('totalCount').that.is.a('number');

      // Note: This test may return 0 items if test data from before hook is not found
      // due to eventual consistency, but the API should still work correctly
      if (response.body.items.length > 0) {
        // Verify all returned items have testing=true
        response.body.items.forEach(item => {
          expect(item.testing).to.equal(true, 'All items should have testing=true when filtered by testing=true');
        });
      }
    });

    it('should return data when no filters provided (default behavior)', async () => {
      const response = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          show_total_count: 1,
          limit: 20
        })
        .expect(200);

      expect(response.body).to.have.property('success', true);
      expect(response.body).to.have.property('items').that.is.an('array');
      expect(response.body).to.have.property('count').that.is.a('number');
      expect(response.body).to.have.property('totalCount').that.is.a('number');

      // Should return data if database has content
      expect(response.body.count).to.be.greaterThan(0, 'API should return data when database has content');
      expect(response.body.totalCount).to.be.greaterThan(0, 'Total count should be greater than 0');
      expect(response.body.items.length).to.equal(response.body.count);
      expect(response.body.items).to.have.lengthOf(response.body.count);
    });

    it('should properly filter and sort with length validation', async () => {
      // First create some additional test data with specific blocker_id
      await request(app).post('/block-users/blockUser').send({
        from: 'test_blocker_length',
        to: 'test_target_1',
        scope: 'private_chat',
        is_permanent: true,
        testing: false,
        reason: 'Length test block 1'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      await request(app).post('/block-users/blockUser').send({
        from: 'test_blocker_length',
        to: 'test_target_2',
        scope: 'feed',
        is_permanent: true,
        testing: false,
        reason: 'Length test block 2'
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      await request(app).post('/block-users/blockUser').send({
        from: 'test_blocker_length',
        to: 'test_target_3',
        scope: 'private_chat',
        is_permanent: true,
        testing: false,
        reason: 'Length test block 3'
      });

      // Wait for consistency
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Test filtering by blocker_id
      const filterResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          blocker_id: 'test_blocker_length',
          show_total_count: 1,
          limit: 10
        })
        .expect(200);

      expect(filterResponse.body.items).to.have.lengthOf(3, 'Should return exactly 3 blocks for test_blocker_length');
      expect(filterResponse.body.count).to.equal(3);
      expect(filterResponse.body.totalCount).to.equal(3);

      // Test sorting and limiting
      const sortResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          blocker_id: 'test_blocker_length',
          sort_by: 'created_at',
          sort_order: 'desc',
          limit: 2,
          show_total_count: 1
        })
        .expect(200);

      expect(sortResponse.body.items).to.have.lengthOf(2, 'Should respect limit parameter');
      expect(sortResponse.body.count).to.equal(2);
      expect(sortResponse.body.totalCount).to.equal(3);
      expect(sortResponse.body.hasMore).to.equal(true);

      // Verify sorting order
      expect(sortResponse.body.items[0].created_at).to.be.at.least(sortResponse.body.items[1].created_at);
    });

    it('should filter by id', async () => {
      // First get a block id from existing data
      const listResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          testing: true,
          limit: 1
        })
        .expect(200);

      expect(listResponse.body.items.length).to.be.greaterThan(0);
      const testId = listResponse.body.items[0].id;

      // Now filter by that specific id
      const idResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          id: testId,
          show_total_count: 1
        })
        .expect(200);

      expect(idResponse.body).to.have.property('success', true);
      expect(idResponse.body).to.have.property('items').that.is.an('array');
      expect(idResponse.body.items.length).to.equal(1);
      expect(idResponse.body.items[0].id).to.equal(testId);
      expect(idResponse.body).to.have.property('count', 1);
      expect(idResponse.body).to.have.property('totalCount', 1);
    });

    it('should filter by search term (q)', async () => {
      // Create a block with a specific blocker_id for testing search
      const searchBlockerId = `search_test_blocker_${Date.now()}`;
      const searchTargetId = `search_test_target_${Date.now()}`;

      await request(app)
        .post('/block-users/blockUser')
        .send({
          from: searchBlockerId,
          to: searchTargetId,
          scope: 'private_chat',
          reason: 'Search test block',
          testing: true
        })
        .expect(201);

      // Wait for eventual consistency
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Search by blocker_id
      const searchResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          q: 'search_test_blocker', // Partial match
          testing: true,
          show_total_count: 1,
          limit: 1000 // Increase limit to scan all items
        })
        .expect(200);

      expect(searchResponse.body).to.have.property('success', true);
      expect(searchResponse.body).to.have.property('items').that.is.an('array');
      expect(searchResponse.body.items.length).to.be.at.least(1);
      // Verify that at least one result contains the search term
      const found = searchResponse.body.items.some(item =>
        item.blocker_id.includes(searchBlockerId.substring(0, 10)) ||
        item.blocked_id.includes(searchBlockerId.substring(0, 10))
      );
      expect(found).to.equal(true);
    });

    it('should filter by blocked_id', async () => {
      // Create a block with a specific blocked_id
      const filterBlockerId = `filter_blocker_${Date.now()}`;
      const filterTargetId = `filter_target_${Date.now()}`;

      await request(app)
        .post('/block-users/blockUser')
        .send({
          from: filterBlockerId,
          to: filterTargetId,
          scope: 'private_chat',
          reason: 'Filter test block',
          testing: true
        })
        .expect(201);

      // Wait for eventual consistency
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Filter by blocked_id
      const filterResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          blocked_id: filterTargetId,
          testing: true,
          show_total_count: 1,
          limit: 1000 // Increase limit to scan all items
        })
        .expect(200);

      expect(filterResponse.body).to.have.property('success', true);
      expect(filterResponse.body).to.have.property('items').that.is.an('array');
      expect(filterResponse.body.items.length).to.be.at.least(1);
      // Verify all results have the correct blocked_id
      filterResponse.body.items.forEach(item => {
        expect(item.blocked_id).to.equal(filterTargetId);
      });
    });

    it('should filter by flag', async () => {
      // Create a block with a specific flag
      const flagBlockerId = `flag_blocker_${Date.now()}`;
      const flagTargetId = `flag_target_${Date.now()}`;

      await request(app)
        .post('/block-users/blockUser')
        .send({
          from: flagBlockerId,
          to: flagTargetId,
          scope: 'private_chat',
          reason: 'Flag test block',
          flag: 'spam',
          testing: true
        })
        .expect(201);

      // Wait for eventual consistency
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Filter by flag
      const flagResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          flag: 'spam',
          testing: true,
          show_total_count: 1,
          limit: 1000 // Increase limit to scan all items
        })
        .expect(200);

      expect(flagResponse.body).to.have.property('success', true);
      expect(flagResponse.body).to.have.property('items').that.is.an('array');
      expect(flagResponse.body.items.length).to.be.at.least(1);
      // Verify all results have the correct flag
      flagResponse.body.items.forEach(item => {
        expect(item.flag).to.equal('spam');
      });
    });

    it('should filter by expired status', async () => {
      // Create an expired block
      const expiredBlockerId = `expired_blocker_${Date.now()}`;
      const expiredTargetId = `expired_target_${Date.now()}`;

      await request(app)
        .post('/block-users/blockUser')
        .send({
          from: expiredBlockerId,
          to: expiredTargetId,
          scope: 'private_chat',
          reason: 'Expired test block',
          expires_at: 1, // 1 second
          testing: true
        })
        .expect(201);

      // Wait for the block to expire
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Filter for expired blocks
      const expiredResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          expired: 1,
          testing: true,
          show_total_count: 1,
          limit: 1000 // Increase limit to scan all items
        })
        .expect(200);

      expect(expiredResponse.body).to.have.property('success', true);
      expect(expiredResponse.body).to.have.property('items').that.is.an('array');
      // Should find at least the expired block we created
      const foundExpired = expiredResponse.body.items.some(item =>
        item.blocker_id === expiredBlockerId && item.blocked_id === expiredTargetId
      );
      expect(foundExpired).to.equal(true);

      // Filter for non-expired blocks
      const activeResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          expired: 0,
          testing: true,
          show_total_count: 1,
          limit: 1000 // Increase limit to scan all items
        })
        .expect(200);

      expect(activeResponse.body).to.have.property('success', true);
      // The expired block should not appear in non-expired results
      const foundInActive = activeResponse.body.items.some(item =>
        item.blocker_id === expiredBlockerId && item.blocked_id === expiredTargetId
      );
      expect(foundInActive).to.equal(false);
    });

    it('should filter by date range', async () => {
      // Create a block at a specific time
      const dateBlockerId = `date_blocker_${Date.now()}`;
      const dateTargetId = `date_target_${Date.now()}`;

      const beforeCreate = new Date();
      await request(app)
        .post('/block-users/blockUser')
        .send({
          from: dateBlockerId,
          to: dateTargetId,
          scope: 'private_chat',
          reason: 'Date test block',
          testing: true
        })
        .expect(201);
      const afterCreate = new Date();

      // Wait for eventual consistency
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Filter by created_from
      const fromResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          created_from: beforeCreate.toISOString(),
          testing: true,
          show_total_count: 1,
          limit: 1000 // Increase limit to scan all items
        })
        .expect(200);

      expect(fromResponse.body).to.have.property('success', true);
      expect(fromResponse.body.items.length).to.be.at.least(1);

      // Filter by created_to
      const toResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          created_to: afterCreate.toISOString(),
          testing: true,
          show_total_count: 1
        })
        .expect(200);

      expect(toResponse.body).to.have.property('success', true);
      expect(toResponse.body.items.length).to.be.at.least(1);

      // Filter by date range
      const rangeResponse = await request(app)
        .get('/block-users/listUserBlocks')
        .query({
          created_from: beforeCreate.toISOString(),
          created_to: afterCreate.toISOString(),
          testing: true,
          show_total_count: 1,
          limit: 1000 // Increase limit to scan all items
        })
        .expect(200);

      expect(rangeResponse.body).to.have.property('success', true);
      expect(rangeResponse.body.items.length).to.be.at.least(1);
      // Verify the block we created is in the range
      const foundInRange = rangeResponse.body.items.some(item =>
        item.blocker_id === dateBlockerId && item.blocked_id === dateTargetId
      );
      expect(foundInRange).to.equal(true);
    });
  });
});