const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const Moderation = require('./src/core/moderation.js');
const Scylla = require('./src/services/scylla.js');
const moderationRoutes = require('./src/api/routes/moderationRoutes.js');
const morgan = require('morgan');
const { join } = require('path');
const dotenv = require('dotenv');
const fs = require('fs');

// Import Users API dependencies (lazy load)
let Users, usersDb;
async function loadUsersDependencies() {
    if (Users && usersDb) return; // Already loaded
    
    try {
        const usersPath = join(__dirname, '..', 'users');
        const usersEnvPath = join(usersPath, '.env');
        
        // Load users .env file to get PostgreSQL config (separate from ScyllaDB config)
        // This ensures the users DB uses PostgreSQL, not ScyllaDB
        // We need to do this BEFORE importing DB.js because DB.js calls dotenv.config() at module load
        try {
            
            // Read and parse .env file manually to set env vars before DB.js loads
            if (fs.existsSync(usersEnvPath)) {
                const envContent = fs.readFileSync(usersEnvPath, 'utf8');
                const envLines = envContent.split('\n');
                
                // Store original env vars for PostgreSQL (to restore if needed)
                const postgresVars = ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'PGHOST', 'PGPORT'];
                const originalVars = {};
                postgresVars.forEach(key => {
                    originalVars[key] = process.env[key];
                });
                
                for (const line of envLines) {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#')) {
                        const [key, ...valueParts] = trimmed.split('=');
                        if (key && valueParts.length > 0) {
                            const envKey = key.trim();
                            const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
                            // For PostgreSQL vars, always set (override) to use users config
                            // For other vars, only set if not already set
                            if (postgresVars.includes(envKey) || !process.env[envKey]) {
                                process.env[envKey] = value;
                            }
                        }
                    }
                }
                console.log('✅ Loaded users PostgreSQL configuration from .env');
            } else {
                console.warn(`⚠️  Users .env file not found at: ${usersEnvPath}`);
                console.warn('   Using system environment variables for PostgreSQL');
            }
        } catch (envError) {
            console.warn('⚠️  Could not load users .env file:', envError.message);
            // Continue anyway - might use system env vars
        }
        
        const UsersModulePath = join(usersPath, 'src', 'services', 'Users.js');
        const DbModulePath = join(usersPath, 'src', 'utils', 'DB.js');
        
        const UsersModule = require(UsersModulePath);
        const DbModule = require(DbModulePath);
        
        Users = UsersModule.default || UsersModule;
        usersDb = DbModule.default || DbModule;
        
        console.log('✅ Users API dependencies loaded successfully');
    } catch (error) {
        console.warn('⚠️  Users API dependencies not available:', error.message);
        console.warn('   Make sure PostgreSQL is running and users/.env is configured');
        Users = null;
        usersDb = null;
    }
}

dotenv.config();

const router = express.Router();
// Initialize database connection
let dbInitialized = false;

async function ensureDatabaseReady() {
    if (!dbInitialized) {
            try {
            const schemaPath = join(__dirname, 'src', 'core', 'db_schema.json');
            await Scylla.loadTableConfigs(schemaPath);
            
            // Ensure table exists
            try {
                await Scylla.describeTable(Moderation.TABLE);
            } catch (error) {
                if (error.message && error.message.includes('ResourceNotFoundException')) {
                    console.log('Creating moderation table...');
                    await Moderation.createModerationSchema();
                    console.log('Table created successfully');
                }else {
                    throw error;
                }
            }
            dbInitialized = true;
            console.log('✅ ScyllaDB connection established');
        } catch (error) {
            console.error('❌ Database connection failed:', error.message);
            throw error;
        }
    }
}

// Middleware to ensure DB is ready
router.use(async (req, res, next) => {
    try {
        await ensureDatabaseReady();
        next();
    } catch (error) {
        res.status(500).json({ error: 'Database initialization failed', message: error.message });
    }
});

// ============================================
// GET USER BY USER ID
// ============================================
router.get('/users/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({ 
                error: 'User ID is required' 
            });
        }

        // Use ScyllaDB Users API
        let UsersScylla;
        try {
            const usersPath = join(__dirname, '..', 'users');
            const UsersScyllaPath = 'file:///' + join(usersPath, 'UsersScylla.js').replace(/\\/g, '/');
            const UsersScyllaModule = await import(UsersScyllaPath);
            UsersScylla = UsersScyllaModule.default;
        } catch (error) {
            return res.status(503).json({ 
                error: 'Users ScyllaDB API not available',
                message: error.message 
            });
        }

        // Ensure users table exists
        try {
            const usersSchemaPath = join(__dirname, '..', 'users', 'db_schema.json');
            await Scylla.loadTableConfigs(usersSchemaPath);
            
            try {
                await Scylla.describeTable(UsersScylla.TABLE);
            } catch (error) {
                if (error.message && error.message.includes('ResourceNotFoundException')) {
                    await UsersScylla.createUsersSchema();
                }
            }
        } catch (schemaError) {
            console.warn('Users schema check failed:', schemaError.message);
        }

        // Get user from ScyllaDB
        let user;
        try {
            user = await UsersScylla.getUserById(userId);
        } catch (error) {
            console.error('Error fetching user from ScyllaDB:', error);
            return res.status(500).json({ 
                error: 'Failed to fetch user from database',
                message: error.message,
                userId 
            });
        }
        
        if (!user) {
            return res.status(404).json({ 
                error: 'User not found',
                userId 
            });
        }

        // Format response with all requested fields
        const userData = {
            success: true,
            user: {
                // User ID
                userId: user.userId,
                publicUid: null, // Not in ScyllaDB schema yet
                
                // Username
                username: user.username || null,
                
                // Email
                email: user.email || null,
                
                // Name
                name: user.displayName || user.name || null,
                displayName: user.displayName || user.name || null,
                
                // Phone
                phone: user.phone || null,
                
                // Status
                status: user.status || 'offline',
                online: user.online || false,
                role: user.role || 'user',
                isNewUser: user.isNewUser || false,
                
                // Additional info
                avatar: user.avatar || null,
                lastActivityAt: user.lastActivityAt || null,
                
                // Profile data
                bio: user.bio || null,
                gender: user.gender || null,
                age: user.age || null,
                country: user.country || null,
                
                // Dates
                createdAt: user.createdAt || null,
                updatedAt: user.updatedAt || null,
                profileUpdatedAt: user.updatedAt || null
            }
        };

        res.json(userData);
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ 
            error: 'Failed to fetch user',
            message: error.message 
        });
    }
});

// ============================================
// ROUTES
// ============================================
router.use('/moderation', moderationRoutes);

// ============================================
// ERROR HANDLER
// ============================================
router.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        error: 'Internal server error', 
        message: err.message 
    });
});

// ============================================
// INIT SERVICE
// ============================================
const initModerationService = async () => {
    try {
        await ensureDatabaseReady();
        console.log('✅ ScyllaDB connected for Moderation service');
    } catch (error) {
        console.error('❌ Failed to initialize Moderation service:', error);
        throw error;
    }
};

module.exports = { router, initModerationService };





