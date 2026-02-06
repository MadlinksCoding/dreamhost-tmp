const { user_blocks_schema, system_blocks_schema, manual_actions_schema } = require("../schema/schema.js");
const ScyllaDb = require("../src/services/scylla/scyllaDb.js");

async function createTables() {
  try {
    console.log("Creating tables...");
    // Create user_blocks table
    const resp_user_blocks = await ScyllaDb.createTable(user_blocks_schema);

    console.log("user_blocks table create result:", resp_user_blocks);
    // Check if the table was created successfully
    if (!resp_user_blocks) { 
        throw new Error("Failed to create user_blocks table");    
    }

    // Create system_blocks table
    const resp_system_blocks = await ScyllaDb.createTable(system_blocks_schema);

    console.log("system_blocks table create result:", resp_system_blocks);
    // Check if the table was created successfully
    if (!resp_system_blocks) { 
        throw new Error("Failed to create system_blocks table");    
    }

    // Create manual_actions table
    const resp_manual_actions = await ScyllaDb.createTable(manual_actions_schema);

    console.log("manual_actions table create result:", resp_manual_actions);
    // Check if the table was created successfully
    if (!resp_manual_actions) { 
        throw new Error("Failed to create manual_actions table");    
    }

    console.log("Tables created successfully.");
  } catch (error) {
    console.error("Error creating tables:", error);
  }
}

// Run the createTables function to create the tables
createTables();

module.exports = { createTables };