require("dotenv/config");
const db = require("../services/DB.js");

async function createTables() {
  try {
    await db.ensureConnected();

    // USERS TABLE
    const usersSql = `
      CREATE TABLE IF NOT EXISTS users (
        uid VARCHAR(10) PRIMARY KEY,
        username_lower VARCHAR(50) UNIQUE NOT NULL,
        display_name VARCHAR(100),
        email VARCHAR(100) UNIQUE,
        phone_number VARCHAR(100) UNIQUE,
        avatar_url TEXT,
        public_uid UUID DEFAULT gen_random_uuid(),
        role VARCHAR(50) DEFAULT 'user',
        is_new_user BOOLEAN DEFAULT true,
        last_activity_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

      )
    `;

    // USER SETTINGS TABLE
    const userSettingsSql = `
      CREATE TABLE IF NOT EXISTS user_settings (
        uid TEXT REFERENCES users(uid) ON DELETE CASCADE,
        locale VARCHAR(10) DEFAULT 'en',
        notifications JSONB DEFAULT '{}'::jsonb,
        call_video_message BOOLEAN DEFAULT false,
        presence_preference VARCHAR(50),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (uid)
      )
    `;

    // USER PROFILES TABLE
    const userProfilesSql = `
      CREATE TABLE IF NOT EXISTS user_profiles (
        uid TEXT REFERENCES users(uid) ON DELETE CASCADE,
        bio TEXT,
        gender VARCHAR(20),
        age INT,
        body_type VARCHAR(50),
        hair_color VARCHAR(50),
        country VARCHAR(50),
        cover_image TEXT,
        background_images TEXT[],
        social_urls TEXT[],
        additional_urls TEXT[],
        PRIMARY KEY (uid),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

      )
    `;

    await db.query("default", usersSql);
    await db.query("default", userSettingsSql);
    await db.query("default", userProfilesSql);

    console.log(
      "✅ Tables created successfully (users, user_settings, user_profiles)"
    );
  } catch (err) {
    console.error("❌ Error creating tables:", err.message);
  } finally {
    await db.closeAll();
  }
}

createTables();
