import { db } from '../src/utils/index.js';

export async function seedTestUsers() {
    console.log("Seeding test users u1 and u2...");
    
    try {
        // Cleanup
        await db.query('default', "DELETE FROM users WHERE uid IN ('u1', 'u2')");

        // Insert u1
        await db.query('default', `
            INSERT INTO users (uid, username_lower, display_name, role, is_new_user)
            VALUES ('u1', 'user1', 'User One', 'user', true)
        `);
        await db.query('default', "INSERT INTO user_settings (uid, locale, notifications, call_video_message, presence_preference) VALUES ('u1', 'en', '{}', false, 'online')");
        await db.query('default', "INSERT INTO user_profiles (uid, bio, background_images) VALUES ('u1', 'test bio', ARRAY['img1.jpg', 'img2.jpg'])");

        // Insert u2
        await db.query('default', `
            INSERT INTO users (uid, username_lower, display_name, role, is_new_user)
            VALUES ('u2', 'user2', 'User Two', 'user', true)
        `);
        await db.query('default', "INSERT INTO user_settings (uid) VALUES ('u2')");
        await db.query('default', "INSERT INTO user_profiles (uid) VALUES ('u2')");
        
        console.log("Test users seeded.");
    } catch (error) {
        console.error("Error seeding test users:", error);
        throw error;
    }
}

export async function cleanupTestUsers() {
    console.log("Cleaning up test users...");
    try {
        await db.query('default', "DELETE FROM users WHERE uid IN ('u1', 'u2')");
        console.log("Test users cleaned up.");
    } catch (error) {
        console.error("Error cleaning up test users:", error);
    }
}
