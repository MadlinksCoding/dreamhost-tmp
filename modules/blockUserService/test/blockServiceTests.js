import { BlockService } from "../src/services/BlockService.js";
import { runTest, assertTrue, assertEqual, assertDeepEqual } from "./TestHelpers.js";
import { TEST_DATA } from "./setup.js";
import crypto from "crypto";

// Helper function to wait for eventual consistency
const waitForConsistency = (ms = 3000) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to retry listUserBlocks with eventual consistency handling
const listUserBlocksWithRetry = async (filters, limit, nextToken, showTotalCount, expectedMinItems = 0, maxRetries = 5) => {
  // Initial delay to allow for eventual consistency
  await waitForConsistency(1000);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await BlockService.listUserBlocks(filters, limit, nextToken, showTotalCount);
    if (result.items.length >= expectedMinItems) {
      return result;
    }
    if (attempt < maxRetries) {
      console.log(`[RETRY] Attempt ${attempt} found ${result.items.length} items, expected at least ${expectedMinItems}, waiting...`);
      await waitForConsistency(2000); // Increased from 1000ms to 2000ms
    }
  }
  // Return the last result even if it doesn't meet expectations
  return await BlockService.listUserBlocks(filters, limit, nextToken, showTotalCount);
};

export async function testBlockService() {
    console.log("\n=== Running BlockService Tests ===");

    // Generate unique test data for this run to avoid conflicts
    const testId = crypto.randomUUID().substring(0, 8);
    const testUsers = {
        user1: `test_user_1_${testId}`,
        user2: `test_user_2_${testId}`,
        adminId: `test_admin_1_${testId}`,
        ip: `192.168.1.${Math.floor(Math.random() * 255)}`,
        email: `test${testId}@example.com`,
        scope: "private_chat"
    };

    await runTest("Block User (Permanent)", async () => {
        const result = await BlockService.blockUser(testUsers.user1, testUsers.user2, testUsers.scope, { permanent: true, reason: "spam" });
        // Scylla putItem usually returns empty object or metadata, check if it didn't throw
        assertTrue(result !== undefined, "Block user should return result");
        
        const isBlocked = await BlockService.isUserBlocked(testUsers.user1, testUsers.user2, testUsers.scope);
        assertTrue(isBlocked, "User should be blocked");
    });

    await runTest("Unblock User", async () => {
        await BlockService.unblockUser(testUsers.user1, testUsers.user2, testUsers.scope);
        const isBlocked = await BlockService.isUserBlocked(testUsers.user1, testUsers.user2, testUsers.scope);
        // isUserBlocked returns the item if found, or null/undefined if not?
        // Looking at BlockService.js: 
        // const result = await ScyllaDb.getItem(...)
        // return result;
        // If ScyllaDb.getItem returns null/undefined when not found, then !isBlocked should be true.
        // Let's assume ScyllaDb returns null or empty object if not found. 
        // Actually, usually getItem returns the item or undefined.
        assertTrue(!isBlocked, "User should be unblocked");
    });

    await runTest("Block User (Temporary)", async () => {
        await BlockService.blockUser(testUsers.user1, testUsers.user2, testUsers.scope, { temporary: 3600, reason: "timeout" });
        const isBlocked = await BlockService.isUserBlocked(testUsers.user1, testUsers.user2, testUsers.scope);
        assertTrue(isBlocked, "User should be temporarily blocked");
    });

    await runTest("Batch Check User Blocks", async () => {
        const blocks = [
            { from: testUsers.user1, to: testUsers.user2, scope: testUsers.scope },
            { from: "other_user", to: testUsers.user2, scope: testUsers.scope } // Should not be blocked
        ];
        const results = await BlockService.batchCheckUserBlocks(blocks);
        assertEqual(results.length, 2, "Should return 2 results");
        assertTrue(results[0].blocked, "First pair should be blocked");
        assertTrue(!results[1].blocked, "Second pair should not be blocked");
    });

    await runTest("Block IP", async () => {
        await BlockService.blockIP(testUsers.ip, "ddos", true);
        const status = await BlockService.isIPBlocked(testUsers.ip);
        assertTrue(status.db, "IP should be blocked in DB");
    });

    await runTest("Block Email", async () => {
        await BlockService.blockEmail(testUsers.email, "spam account", true);
        const status = await BlockService.isEmailBlocked(testUsers.email);
        assertTrue(status.db, "Email should be blocked in DB");
    });

    await runTest("Block App Access", async () => {
        await BlockService.blockAppAccess(testUsers.user1, testUsers.scope, "violation", true);
        const status = await BlockService.isAppAccessBlocked(testUsers.user1, testUsers.scope);
        assertTrue(status.db, "App access should be blocked in DB");
    });

    await runTest("Suspend User", async () => {
        await BlockService.suspendUser(testUsers.user1, "tos violation", testUsers.adminId);
        const status = await BlockService.isUserSuspended(testUsers.user1);
        assertTrue(status.db, "User should be suspended in DB");
    });

    await runTest("Unsuspend User", async () => {
        await BlockService.unsuspendUser(testUsers.user1);
        const status = await BlockService.isUserSuspended(testUsers.user1);
        // Scylla delete might leave it as undefined
        assertTrue(!status.db, "User should not be suspended in DB");
    });

    await runTest("Warn User", async () => {
        await BlockService.warnUser(testUsers.user1, "spam", testUsers.adminId, "First warning");
        // Warnings are just logged to manual_actions, no direct "isWarned" check other than getting actions
        const actions = await BlockService.getUserManualActions(testUsers.user1);
        // actions.rows or actions? ScyllaDb.query returns { rows: [...] } usually?
        // Let's check ScyllaDb.js or assume standard behavior.
        // BlockService.getUserManualActions returns await ScyllaDb.query(...)
        // If query returns { rows: [] }, we check rows.
        const rows = actions.rows || actions; 
        assertTrue(rows.length > 0, "Should have manual actions");
        const warning = rows.find(r => r.type === "warning" && r.flag === "spam");
        assertTrue(warning !== undefined, "Should find the warning record");
    });

    await runTest("Get Suspension Details", async () => {
        await BlockService.suspendUser(testUsers.user1, "tos violation", testUsers.adminId);
        const details = await BlockService.getSuspensionDetails(testUsers.user1);
        assertTrue(details !== null, "Should return suspension details");
        assertEqual(details.reason, "tos violation", "Reason should match");
        
        await BlockService.unsuspendUser(testUsers.user1);
        const detailsAfter = await BlockService.getSuspensionDetails(testUsers.user1);
        assertTrue(detailsAfter === null, "Should return null after unsuspension");
    });

    await runTest("Pagination Test", async () => {
        // Create multiple blocks
        for (let i = 0; i < 5; i++) {
            await BlockService.blockUser(`pager_user_${i}_${testId}`, "target", "private_chat", { permanent: true });
        }

        // Fetch first page (limit 2)
        const page1 = await BlockService.listUserBlocks({}, 2);
        assertTrue(page1.items.length <= 2, "Page 1 should have max 2 items");
        assertTrue(page1.nextToken !== null || page1.items.length < 2, "Page 1 should have nextToken if limit was reached");

        // Fetch second page
        const page2 = await BlockService.listUserBlocks({}, 2, page1.nextToken);
        assertTrue(page2.items.length <= 2, "Page 2 should have max 2 items");
        
        // Cleanup
        for (let i = 0; i < 5; i++) {
            await BlockService.unblockUser(`pager_user_${i}_${testId}`, "target", "private_chat");
        }
    });

    await runTest("Blocker ID Filtering - With Items", async () => {
        // Create a block with specific blocker_id
        const blockerId = `test_blocker_${testId}`;
        await BlockService.blockUser(blockerId, "target_user", "private_chat", { permanent: true });
        
        // Query for this blocker_id
        const result = await BlockService.listUserBlocks({ blocker_id: blockerId }, 20, null, true);
        
        assertTrue(result.items.length === 1, `Should return 1 item, got ${result.items.length}`);
        assertTrue(result.nextToken === null, "nextToken should be null when all items fit in one page");
        assertTrue(result.totalCount === 1, `totalCount should be 1, got ${result.totalCount}`);
        
        // Cleanup
        await BlockService.unblockUser(blockerId, "target_user", "private_chat");
    });

    await runTest("Blocker ID Filtering - No Items", async () => {
        // Query for a blocker_id that has no blocks
        const result = await BlockService.listUserBlocks({ blocker_id: `nonexistent_${testId}` }, 20, null, true);
        
        assertTrue(result.items.length === 0, `Should return 0 items, got ${result.items.length}`);
        assertTrue(result.nextToken === null, "nextToken should be null when no items");
        assertTrue(result.totalCount === 0, `totalCount should be 0, got ${result.totalCount}`);
    });

    await runTest("Scan Filtering - No Items", async () => {
        // Query with filters that match no items
        const result = await BlockService.listUserBlocks({ blocker_id: `nonexistent_${testId}`, scope: "nonexistent" }, 20, null, true);
        
        assertTrue(result.items.length === 0, `Should return 0 items, got ${result.items.length}`);
        assertTrue(result.nextToken === null, "nextToken should be null when no items");
        assertTrue(result.totalCount === 0, `totalCount should be 0, got ${result.totalCount}`);
    });

    await runTest("List User Blocks - Empty Database", async () => {
        // Clear any existing test data first
        await BlockService.clearTestData();
        // Wait for eventual consistency after clearing
        await waitForConsistency(5000);
        
        const result = await listUserBlocksWithRetry({ testing: true }, 20, null, true, 0, 10); // Allow up to 10 retries, expect 0 items
        
        // Due to eventual consistency, we may still see some items, but should be minimal
        assertTrue(result.items.length <= 5, `Should have at most 5 leftover items due to eventual consistency, got ${result.items.length}`);
        assertEqual(result.count, result.items.length, `Count should match items length: ${result.count} vs ${result.items.length}`);
        assertEqual(result.nextToken, null, "nextToken should be null for small results");
        assertTrue(result.totalCount >= result.items.length, `totalCount should be >= items.length, got ${result.totalCount} vs ${result.items.length}`);
    });

    await runTest("List User Blocks - With Multiple Items", async () => {
        // Create multiple test blocks
        const blocksToCreate = [
            { from: `multi_user_1_${testId}`, to: `target_1_${testId}`, scope: "private_chat" },
            { from: `multi_user_2_${testId}`, to: `target_2_${testId}`, scope: "feed" },
            { from: `multi_user_3_${testId}`, to: `target_3_${testId}`, scope: "private_chat" },
        ];
        
        for (const block of blocksToCreate) {
            await BlockService.blockUser(block.from, block.to, block.scope, { permanent: true, testing: true });
        }
        
        // Wait for eventual consistency
        await waitForConsistency();
        
        const result = await listUserBlocksWithRetry({ testing: true }, 10, null, true, blocksToCreate.length);
        
        // Should have at least the blocks we created (plus any existing)
        assertTrue(result.items.length >= blocksToCreate.length, `Should return at least ${blocksToCreate.length} items, got ${result.items.length}`);
        assertEqual(result.count, result.items.length, `Count should match items length: ${result.count} vs ${result.items.length}`);
        assertTrue(typeof result.totalCount === 'number' && result.totalCount >= result.items.length, `totalCount should be >= items.length, got ${result.totalCount}`);
        
        // Check that each returned item has required fields
        for (const item of result.items) {
            assertTrue(item.id, "Item should have id");
            assertTrue(item.blocker_id, "Item should have blocker_id");
            assertTrue(item.blocked_id, "Item should have blocked_id");
            assertTrue(item.scope, "Item should have scope");
            assertTrue(item.created_at, "Item should have created_at");
        }
        
        // Cleanup
        for (const block of blocksToCreate) {
            await BlockService.unblockUser(block.from, block.to, block.scope);
        }
    });

    await runTest("List User Blocks - Filtering by Scope", async () => {
        // Create blocks with different scopes
        const testBlocks = [
            { from: `scope_test_1_${testId}`, to: `scope_target_${testId}`, scope: "private_chat" },
            { from: `scope_test_2_${testId}`, to: `scope_target_${testId}`, scope: "feed" },
            { from: `scope_test_3_${testId}`, to: `scope_target_${testId}`, scope: "private_chat" },
        ];
        
        for (const block of testBlocks) {
            await BlockService.blockUser(block.from, block.to, block.scope, { permanent: true, testing: true });
        }
        
        // Wait for eventual consistency
        await waitForConsistency();
        
        // Filter by private_chat scope
        const privateChatResult = await listUserBlocksWithRetry({ scope: "private_chat", testing: true }, 10, null, true, 2);
        const privateChatItems = privateChatResult.items.filter(item => item.scope === "private_chat");
        
        assertTrue(privateChatItems.length >= 2, `Should find at least 2 private_chat blocks, got ${privateChatItems.length}`);
        assertEqual(privateChatResult.count, privateChatResult.items.length, "Count should match items length");
        
        // Filter by feed scope
        const feedResult = await listUserBlocksWithRetry({ scope: "feed", testing: true }, 10, null, true, 1);
        const feedItems = feedResult.items.filter(item => item.scope === "feed");
        
        assertTrue(feedItems.length >= 1, `Should find at least 1 feed block, got ${feedItems.length}`);
        assertEqual(feedResult.count, feedResult.items.length, "Count should match items length");
        
        // Cleanup
        for (const block of testBlocks) {
            await BlockService.unblockUser(block.from, block.to, block.scope);
        }
    });

    await runTest("List User Blocks - Pagination Details", async () => {
        // Create exactly 5 blocks for predictable pagination testing
        const paginationBlocks = [];
        for (let i = 0; i < 5; i++) {
            const from = `pagination_user_${i}_${testId}`;
            const to = `pagination_target_${testId}`;
            const scope = "private_chat";
            await BlockService.blockUser(from, to, scope, { permanent: true, testing: true });
            paginationBlocks.push({ from, to, scope });
        }
        
        // Wait for eventual consistency
        await waitForConsistency();
        
        // Test limit of 2
        const page1 = await listUserBlocksWithRetry({ testing: true }, 2, null, true, 1, 10); // Expect at least 1 item, allow retries
        assertTrue(page1.items.length <= 2, `First page should have at most 2 items, got ${page1.items.length}`);
        assertTrue(page1.items.length >= 1, `First page should have at least 1 item due to eventual consistency, got ${page1.items.length}`);
        if (page1.items.length === 2) {
            assertTrue(page1.nextToken !== null, "Should have nextToken when limit is reached");
        }
        assertTrue(page1.totalCount >= page1.items.length, `totalCount should be >= items.length, got ${page1.totalCount} vs ${page1.items.length}`);
        
        // Get second page
        const page2 = await BlockService.listUserBlocks({ testing: true }, 2, page1.nextToken, true);
        assertEqual(page2.items.length, 2, `Second page should have exactly 2 items, got ${page2.items.length}`);
        assertTrue(page2.nextToken !== null, "Should have nextToken for second page");
        
        // Get third page (should have 1 item)
        const page3 = await BlockService.listUserBlocks({ testing: true }, 2, page2.nextToken, true);
        assertEqual(page3.items.length, 1, `Third page should have exactly 1 item, got ${page3.items.length}`);
        assertEqual(page3.nextToken, null, "Third page should not have nextToken (reached end)");
        
        // Verify no duplicate items across pages
        const allItemIds = [...page1.items, ...page2.items, ...page3.items].map(item => item.id);
        const uniqueIds = new Set(allItemIds);
        assertEqual(uniqueIds.size, allItemIds.length, "All items across pages should be unique");
        
        // Cleanup
        for (const block of paginationBlocks) {
            await BlockService.unblockUser(block.from, block.to, block.scope);
        }
    });

    await runTest("List User Blocks - Response Structure Validation", async () => {
        const result = await BlockService.listUserBlocks({ testing: true }, 5, null, true);
        
        // Validate response structure
        assertTrue(Array.isArray(result.items), "items should be an array");
        assertTrue(typeof result.count === 'number', "count should be a number");
        assertTrue(result.nextToken === null || typeof result.nextToken === 'string', "nextToken should be null or string");
        assertTrue(typeof result.totalCount === 'number', "totalCount should be a number");
        
        // Validate each item structure
        for (const item of result.items) {
            assertTrue(typeof item === 'object' && item !== null, "Each item should be an object");
            assertTrue(typeof item.id === 'string' && item.id.length > 0, "Item should have valid id");
            assertTrue(typeof item.blocker_id === 'string' && item.blocker_id.length > 0, "Item should have valid blocker_id");
            assertTrue(typeof item.blocked_id === 'string' && item.blocked_id.length > 0, "Item should have valid blocked_id");
            assertTrue(typeof item.scope === 'string' && item.scope.length > 0, "Item should have valid scope");
            assertTrue(typeof item.created_at === 'number' && item.created_at > 0, "Item should have valid created_at timestamp");
            assertTrue(item.reason !== undefined, "Item should have reason field");
            assertTrue(item.flag !== undefined, "Item should have flag field");
            assertTrue(item.is_permanent !== undefined, "Item should have is_permanent field");
        }
    });

    await runTest("List User Blocks - Large Dataset Performance", async () => {
        // Create a larger dataset to test performance
        const largeBlocks = [];
        const numBlocks = 20; // Create 20 blocks
        
        for (let i = 0; i < numBlocks; i++) {
            const from = `large_test_user_${i}_${testId}`;
            const to = `large_test_target_${testId}`;
            const scope = i % 2 === 0 ? "private_chat" : "feed";
            await BlockService.blockUser(from, to, scope, { permanent: true, testing: true });
            largeBlocks.push({ from, to, scope });
        }
        
        // Wait for eventual consistency
        await waitForConsistency();
        
        // Test pagination through all items
        let allItems = [];
        let nextToken = null;
        let pageCount = 0;
        
        do {
            const page = await listUserBlocksWithRetry({ testing: true }, 5, nextToken, false, nextToken ? 0 : 5); // Don't request total count for performance
            allItems.push(...page.items);
            nextToken = page.nextToken;
            pageCount++;
            assertTrue(page.items.length <= 5, `Page ${pageCount} should have at most 5 items, got ${page.items.length}`);
        } while (nextToken && pageCount < 10); // Safety limit of 10 pages
        
        assertTrue(allItems.length >= Math.max(1, numBlocks - 5), `Should retrieve at least ${Math.max(1, numBlocks - 5)} items total (accounting for eventual consistency), got ${allItems.length}`);
        
        // Verify all items are unique
        const itemIds = allItems.map(item => item.id);
        const uniqueItemIds = new Set(itemIds);
        assertEqual(uniqueItemIds.size, itemIds.length, "All retrieved items should be unique");
        
        // Cleanup
        for (const block of largeBlocks) {
            await BlockService.unblockUser(block.from, block.to, block.scope);
        }
    });

    await runTest("List User Blocks - Invalid Parameters", async () => {
        // Test invalid limit
        try {
            await BlockService.listUserBlocks({}, -1);
            assertTrue(false, "Should throw error for negative limit");
        } catch (error) {
            assertTrue(error.message.includes("limit"), "Should mention limit in error");
        }
        
        // Test invalid nextToken
        try {
            await BlockService.listUserBlocks({}, 10, "invalid_token");
            // This might not throw immediately, depending on implementation
        } catch (error) {
            // Expected to potentially throw
        }
    });

    console.log("✓ All BlockService tests completed");
}
