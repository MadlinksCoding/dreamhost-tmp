const ScyllaDb = require("../src/services/scylla/scyllaDb.js");

async function deleteTables() {
  try {
    console.log("Deleting tables...");
    
    const tables = ["user_blocks", "system_blocks", "manual_actions"];
    
    for (const table of tables) {
        try {
            console.log(`Deleting table: ${table}`);
            await ScyllaDb.deleteTable(table);
            console.log(`Table ${table} deleted successfully.`);
        } catch (error) {
            // Check for ResourceNotFoundException or similar if the table doesn't exist
            // ScyllaDb.request might throw an error with a message or code
            console.error(`Failed to delete table ${table}:`, error.message || error);
        }
    }

    console.log("Tables deletion process completed.");
  } catch (error) {
    console.error("Error deleting tables:", error);
  }
}

deleteTables();

module.exports = { deleteTables };
