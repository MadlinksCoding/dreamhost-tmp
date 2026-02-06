const { BlockService } = require("../src/services/BlockService.js");
const ScyllaDb = require("../src/services/scylla/scyllaDb.js");
const path = require("path");

// Full list of misconduct flags supported by BlockService
const flags = [
    "fraud",
    "abuse",
    "violence",
    "unacceptable_behavior",
    "exploitation",
    "hate",
    "harassment",
    "child_safety",
    "self_injury",
    "graphic_violence",
    "dangerous_activities",
    "impersonation",
    "security",
    "spam",
];

// Realistic block reasons
const userBlockReasons = [
    "Repeated harassment and threats",
    "Sharing inappropriate content",
    "Impersonating another user",
    "Spamming messages",
    "Violating community guidelines",
    "Hate speech and discrimination",
    "Soliciting illegal activities",
    "Sharing personal information without consent",
    "Creating fake accounts",
    "Disrupting conversations",
    "Inappropriate profile content",
    "Stalking behavior",
    "Doxxing attempts",
    "Extortion or blackmail",
    "Promoting harmful ideologies"
];

// Realistic system block reasons
const systemBlockReasons = [
    "Confirmed botnet activity",
    "Mass spam campaign",
    "Brute force login attempts",
    "DDoS attack source",
    "Malware distribution",
    "Phishing attempts",
    "Data scraping violations",
    "VPN abuse",
    "Proxy server misuse",
    "Automated account creation",
    "API abuse",
    "Rate limiting violations",
    "Suspicious traffic patterns",
    "Known malicious IP range",
    "Email spoofing detected"
];

// Realistic suspension reasons
const suspensionReasons = [
    "Multiple violations of terms of service",
    "Severe harassment of community members",
    "Distribution of illegal content",
    "Attempted account takeover",
    "Fraudulent activity",
    "Child safety violations",
    "Terrorism or violence promotion",
    "Extortion scheme",
    "Identity theft",
    "System security breach"
];

// Realistic warning messages
const warningMessages = [
    "Please review our community guidelines",
    "Inappropriate content has been removed",
    "Your account is under review",
    "Please cease harassing other users",
    "Profile content violates our policies",
    "Spamming is not allowed",
    "Threats are taken seriously",
    "Please respect other users",
    "Account verification required",
    "Behavior improvement needed"
];

const reasons  =[ "harassment", "spam", "fraud", "abuse", "violence", "unacceptable_behavior", "exploitation", "hate", "child_safety", "self_injury", "graphic_violence", "dangerous_activities", "impersonation", "security"];

async function seed() {
    console.log("Starting seed process...");

    // Helper function to ensure block exists (unblock first if needed)
    async function ensureBlock(from, to, scope, options) {
        try {
            await BlockService.unblockUser(from, to, scope);
        } catch (error) {
            // Ignore if no block exists
        }
        return await BlockService.blockUser(from, to, scope, options);
    }

    // Helper to override created_at/updated_at for sorting tests
    async function setUserBlockCreatedAt(from, to, scope, createdAt) {
        const existingBlock = await BlockService.isUserBlocked(from, to, scope);
        if (!existingBlock) return;

        await ScyllaDb.updateItem(
            "user_blocks",
            { blocker_id: existingBlock.blocker_id, sk_scope: existingBlock.sk_scope },
            { created_at: createdAt, updated_at: createdAt }
        );
    }

    try {
        // Load Scylla Configs
        const configPath = path.resolve(__dirname, '../scylla-schema-config.json');
        await ScyllaDb.loadTableConfigs(configPath);

        console.log("Seeding User Blocks...");
        const baseCreatedAt = Date.now();

        await ensureBlock("u1", "u2", "private_chat", { reason: "Persistent harassment and threats", expires_at: 86400 ,testing:true}); // 24 hours
        await setUserBlockCreatedAt("u1", "u2", "private_chat", baseCreatedAt - 5 * 60 * 1000);

        await ensureBlock("u1", "u3", "private_chat", { is_permanent: true, reason: "Sharing inappropriate content and violating community guidelines" ,testing:true});
        await setUserBlockCreatedAt("u1", "u3", "private_chat", baseCreatedAt - 4 * 60 * 1000);

        await ensureBlock("u2", "u4", "feed", { expires_at: 3600 ,testing:true}); // 1 hour
        await setUserBlockCreatedAt("u2", "u4", "feed", baseCreatedAt - 3 * 60 * 1000);

        console.log("Seeding System Blocks...");
        await BlockService.blockIP("10.0.0.1", "Confirmed botnet activity and automated spam", true,null,{testing:true});
        await BlockService.blockEmail("spammer@example.com", "Mass spam campaign and phishing attempts", true, undefined, {testing:true});
        await BlockService.blockAppAccess("u5", "app", "Multiple security violations and unauthorized access attempts", true, undefined, {testing:true});

        console.log("Seeding Manual Actions...");
        await BlockService.suspendUser("u6", "Severe harassment and threats against multiple community members", "community_1","harassment","Account suspended pending investigation","note",{testing:true});
        await BlockService.warnUser("u7", "spam", "community_1", "Please cease spamming other users - this is your first warning",{testing:true});

        // --- BULK SEEDING ---
        console.log("\n--- Starting Bulk Seeding ---");

        const USER_BLOCK_COUNT = 40; // Maximum 40 user-user blocks
        const SYSTEM_COUNT = 50; // Number of IPs/Emails to block
        const ACTION_COUNT = 50; // Number of manual actions
        // Create exactly USER_BLOCK_COUNT user blocks with staggered created_at timestamps
        for (let i = 0; i < USER_BLOCK_COUNT; i++) {
            const blocker = `testuser_${String(i + 100).padStart(3, '0')}`;
            const blocked = `testuser_${String(i + 101).padStart(3, '0')}`; // Block the next user
            const scope = Math.random() > 0.5 ? "private_chat" : "feed";
            const isPermanent = Math.random() > 0.3; // 70% permanent blocks
            const reason = userBlockReasons[Math.floor(Math.random() * userBlockReasons.length)];

            const blockOptions = {
                reason: reason,
                flag: flags[Math.floor(Math.random() * flags.length)],
                testing: true,
                is_permanent: isPermanent
            };

            // Add expiration for non-permanent blocks
            if (!isPermanent) {
                blockOptions.expires_at = Math.floor(Math.random() * 30) * 86400 + 86400; // 1-30 days
            }

            await ensureBlock(blocker, blocked, scope, blockOptions);

            // Stagger created_at by 1 minute for each item (older items have smaller timestamps)
            const createdAt = baseCreatedAt - (i + 6) * 60 * 1000;
            await setUserBlockCreatedAt(blocker, blocked, scope, createdAt);
        }

        console.log(`Generating ${SYSTEM_COUNT} random system blocks...`);
        const systemPromises = [];
        for (let i = 0; i < SYSTEM_COUNT; i++) {
            // Generate realistic IP addresses
            const ip = `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
            const ipReason = systemBlockReasons[Math.floor(Math.random() * systemBlockReasons.length)];
            systemPromises.push(BlockService.blockIP(ip, ipReason, true, null, {testing:true}));
            
            // Generate realistic email addresses
            const emailDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'example.com'];
            const email = `suspicious_user_${i}_${Date.now()}@${emailDomains[Math.floor(Math.random() * emailDomains.length)]}`;
            const emailReason = systemBlockReasons[Math.floor(Math.random() * systemBlockReasons.length)];
            systemPromises.push(BlockService.blockEmail(email, emailReason, true, null, {testing:true}));
        }
        await Promise.all(systemPromises);

        console.log(`Generating ${ACTION_COUNT} random manual actions...`);
        const actionPromises = [];
        for (let i = 0; i < ACTION_COUNT; i++) {
            const userId = `testuser_${String(i + 200).padStart(3, '0')}`;
            const aprivate_chatinId = `community_${Math.floor(Math.random() * 5)}`;
            const flag = flags[Math.floor(Math.random() * flags.length)];
            
            if (Math.random() > 0.5) {
                const suspensionReason = suspensionReasons[Math.floor(Math.random() * suspensionReasons.length)];
                actionPromises.push(BlockService.suspendUser(userId, suspensionReason, aprivate_chatinId, flag, "Account temporarily suspended for policy violations", {testing:true}));
            } else {
                const warningMessage = warningMessages[Math.floor(Math.random() * warningMessages.length)];
                actionPromises.push(BlockService.warnUser(userId, flag, aprivate_chatinId, warningMessage, {testing:true}));
            }
        }
        await Promise.all(actionPromises);

        console.log("Seed completed successfully.");

    } catch (error) {
        console.error("Seed failed:", error);
    }
}

seed();
