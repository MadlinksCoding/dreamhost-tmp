import { BlockService } from "../src/services/BlockService.js";
import ScyllaDb from "../src/services/scylla/scyllaDb.js";

export const TEST_DATA = {
    user1: "test_user_1",
    user2: "test_user_2",
    adminId: "test_admin_1",
    ip: "192.168.1.99",
    email: "test@example.com",
    scope: "private_chat"
};

import path from "path";

export async function setupTestEnvironment() {
    console.log("Setting up test environment...");
    
    // Load ScyllaDB table configs
    const configPath = path.resolve(process.cwd(), "scylla-schema-config.json");
    await ScyllaDb.loadTableConfigs(configPath);
    
    // Ensure we start clean
    await cleanupTestEnvironment();
}

export async function cleanupTestEnvironment() {
    console.log("Cleaning up test environment...");
    
    try {
        // Clean up user blocks
        await BlockService.unblockUser(TEST_DATA.user1, TEST_DATA.user2, TEST_DATA.scope);
        
        // Clean up IP blocks
        await ScyllaDb.deleteItem("system_blocks", { identifier: TEST_DATA.ip });

        // Clean up Email blocks
        const emailHash = crypto.createHash("sha256").update(TEST_DATA.email).digest("hex");
        await ScyllaDb.deleteItem("system_blocks", { identifier: emailHash });

        // Clean up App Access blocks
        await ScyllaDb.deleteItem("system_blocks", { identifier: TEST_DATA.user1 });

        // Clean up Suspensions
        await BlockService.unsuspendUser(TEST_DATA.user1);

        // Clean up Warnings (Manual Actions)
        // Warnings are appended, so we might need to query and delete if we want a full clean, 
        // but for now let's just ensure the specific test artifacts are gone if possible.
        // Since warnings don't have a direct "unwarn" and are historical, we might leave them 
        // or delete by user_id if we want to be thorough.
        // For this test suite, we'll assume we can delete all manual actions for the test user.
        // However, ScyllaDb.deleteItem usually requires the primary key. 
        // Looking at BlockService.js, manual_actions seems to be queried by user_id.
        // If user_id is the partition key, we might need the sort key (created_at?) to delete specific items.
        // For simplicity, we'll rely on unsuspendUser for suspensions.
        
    } catch (error) {
        console.warn("Cleanup warning (might be expected if data didn't exist):", error.message);
    }
    
    console.log("Cleanup complete.");
}

import crypto from "node:crypto";
