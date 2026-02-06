#!/usr/bin/env node
"use strict";

/**
 * Test ScyllaDB Alternator Connection
 * Uses AWS SDK to connect to ScyllaDB via DynamoDB API
 */

require("dotenv").config();

// Check if AWS SDK is available
let DynamoDBClient, ListTablesCommand;
try {
    const awsSdk = require("@aws-sdk/client-dynamodb");
    DynamoDBClient = awsSdk.DynamoDBClient;
    ListTablesCommand = awsSdk.ListTablesCommand;
} catch (err) {
    console.error("❌ AWS SDK not installed.");
    console.error("   Install with: npm install @aws-sdk/client-dynamodb");
    process.exit(1);
}

const endpoint = process.env.SCYLLA_ALTERNATOR_ENDPOINT || "http://localhost:8000";
const region = process.env.SCYLLA_ACCESS_REGION || "us-east-1";
const accessKey = process.env.SCYLLA_ACCESS_KEY || "fakeAccessKey";
const secretKey = process.env.SCYLLA_ACCESS_PASSWORD || "fakeSecretKey";

console.log("=".repeat(60));
console.log("  ScyllaDB Alternator Connection Test");
console.log("=".repeat(60));
console.log();

const client = new DynamoDBClient({
    endpoint: endpoint,
    region: region,
    credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey
    }
});

(async () => {
    try {
        console.log("📡 Connection Details:");
        console.log(`   Endpoint: ${endpoint}`);
        console.log(`   Region: ${region}`);
        console.log(`   Access Key: ${accessKey.substring(0, 8)}...`);
        console.log();
        
        console.log("🔄 Testing connection...");
        const command = new ListTablesCommand({});
        const response = await client.send(command);
        
        console.log();
        console.log("✅ Connection successful!");
        console.log();
        console.log("📊 Tables found:");
        if (response.TableNames && response.TableNames.length > 0) {
            response.TableNames.forEach((table, index) => {
                console.log(`   ${index + 1}. ${table}`);
            });
        } else {
            console.log("   (No tables found)");
        }
        console.log();
        console.log("=".repeat(60));
        console.log("  Connection Test Complete");
        console.log("=".repeat(60));
        
    } catch (error) {
        console.error();
        console.error("❌ Connection failed!");
        console.error();
        console.error("Error:", error.message);
        console.error();
        
        if (error.message.includes("ECONNREFUSED")) {
            console.error("💡 Troubleshooting:");
            console.error("   1. Make sure ScyllaDB is running");
            console.error("   2. Check endpoint: " + endpoint);
            console.error("   3. Verify port 8000 is accessible");
        } else if (error.message.includes("UnknownOperationException")) {
            console.log("⚠️  Note: This error is normal for ScyllaDB Alternator");
            console.log("   It means the connection works, but the operation format may differ");
        }
        
        console.error();
        process.exit(1);
    }
})();








