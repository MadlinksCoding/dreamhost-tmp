const dotenv = require('dotenv');
const db = require("../services/DB.js");

dotenv.config();

const roles = [
    { value: "creator", label: "Creator" },
    { value: "vendor", label: "Vendor" },
    { value: "agent", label: "Agent" },
    { value: "fan", label: "Fan" }
];

async function seedAllTables() {
    try {
        await db.ensureConnected();

        // Cleanup existing test data
        console.log("Cleaning up existing test data...");
        await db.query("default", "DELETE FROM user_settings WHERE uid LIKE 'test%'");
        await db.query("default", "DELETE FROM user_profiles WHERE uid LIKE 'test%'");
        await db.query("default", "DELETE FROM users WHERE uid LIKE 'test%'");

        // Generate and insert 50 test users
        console.log("Seeding 50 test users...");
        const users = [];
        const userSettings = [];
        const userProfiles = [];

        const timestamp = Date.now();
        for (let i = 1; i <= 50; i++) {
            const uid = `test${i}`;
            const username = `user${i}`;
            
            // Users
            const userData = {
                uid,
                username_lower: username,
                // Add contact fields
                email: `user${i}@example.com`,
                phone_number: `+1-555-000-${String(i).padStart(3, '0')}`,
                display_name: `Test User ${i}`,
                avatar_url: `https://picsum.photos/seed/user${i}/150/150`,
                role: roles[i % roles.length].value,
                is_new_user: i > 10 ? false : true, // First 10 are new, rest have activity
            };
            
            // Only add last_activity_at if it should have a value
            if (i % 3 !== 0) {
                userData.last_activity_at = new Date(timestamp - i * 86400000).toISOString();
            }
            
            users.push(userData);

            // User Settings
            const locales = ['en', 'fr', 'es', 'de'];
            const presenceModes = ['online', 'away', 'offline'];
            userSettings.push({
                uid,
                locale: locales[i % locales.length],
                notifications: JSON.stringify({ 
                    email: i % 2 === 0, 
                    push: i % 3 === 0,
                    sms: i % 4 === 0
                }),
                call_video_message: i % 3 === 0,
                presence_preference: presenceModes[i % presenceModes.length]
            });

            // User Profiles
            const genders = ['male', 'female', 'other'];
            const bodyTypes = ['athletic', 'average', 'slim', 'muscular'];
            const hairColors = ['blonde', 'brown', 'black', 'red', 'gray'];
            const countries = ['USA', 'Canada', 'UK', 'Germany', 'France', 'Japan'];
            
            userProfiles.push({
                uid,
                bio: `Hello, I am test user ${i}. This is my bio.`,
                gender: genders[i % genders.length],
                age: 20 + (i % 40),
                body_type: bodyTypes[i % bodyTypes.length],
                hair_color: hairColors[i % hairColors.length],
                country: countries[i % countries.length],
                cover_image: `https://picsum.photos/seed/cover${i}/800/200`,
                background_images: [`https://picsum.photos/seed/bg${i}1/400/300`, `https://picsum.photos/seed/bg${i}2/400/300`],
                social_urls: [`https://twitter.com/user${i}`, `https://github.com/user${i}`],
                additional_urls: i % 4 === 0 ? [`https://portfolio${i}.com`] : []
            });
        }
        console.log("users:", users.length);
        console.log("userSettings:", userSettings.length);
        console.log("userProfiles:", userProfiles.length);

        // Batch insert users
        console.log("Inserting users...");
        for (const user of users) {
            await db.insert("default", "users", user);
        }

        // Batch insert user settings
        console.log("Inserting user settings...");
        for (const settings of userSettings) {
            await db.insert("default", "user_settings", settings);
        }

        // Batch insert user profiles
        console.log("Inserting user profiles...");
        for (const profile of userProfiles) {
            await db.insert("default", "user_profiles", profile);
        }

        // Verify seeding
        const userCount = await db.getRow(
            "default", 
            "SELECT COUNT(*) as count FROM users WHERE uid LIKE 'test%'"
        );
        const settingsCount = await db.getRow(
            "default", 
            "SELECT COUNT(*) as count FROM user_settings WHERE uid LIKE 'test%'"
        );
        const profilesCount = await db.getRow(
            "default", 
            "SELECT COUNT(*) as count FROM user_profiles WHERE uid LIKE 'test%'"
        );

        console.log(`Seeding completed:`);
        console.log(`- Users: ${userCount.count}`);
        console.log(`- User Settings: ${settingsCount.count}`);
        console.log(`- User Profiles: ${profilesCount.count}`);

    } catch (err) {
        console.error("Seeding failed:", err);
    } finally {
        await db.closeAll();
    }
}

seedAllTables();
