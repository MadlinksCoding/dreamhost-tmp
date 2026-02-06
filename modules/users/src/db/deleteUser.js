// db/seedUser.js
const  db = require("../services/DB.js");

async function deleteAllUsers() {
  // const db = new DB(); // create instance
  try {
    // Delete all users
    const deleted = await db.delete("default", "users", "uid IS NOT NULL");
    console.log(`✅ Deleted ${deleted.length} users`);

    // Optional: verify deletion
    const remaining = await db.getAll(
      "default",
      "SELECT uid, username_lower, display_name FROM users"
    );
    console.log("Remaining users:", remaining);
  } catch (err) {
    console.error("❌ Deletion failed:", err);
  } finally {
    await db.closeAll(); // close connections
  }
}

// Run script if executed directly
if (require.main === module) {
  deleteAllUsers()
    .then(() => console.log("✅ All users deleted successfully"))
    .catch((err) => console.error("❌ Error:", err));
}
