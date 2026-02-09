/**
 * Token Registry Module Server
 * 
 * Independent Express server for Token Registry module.
 * Provides admin endpoints for user tokens and token registry management.
 * 
 * Usage: node modules/tokenRegistry/server.js
 * Or: cd modules/tokenRegistry && node server.js
 */

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const morgan = require('morgan');
const path = require('path');

const tokenRegistryRouter = require('./src/routes/index');
const ScyllaDb = require('./src/utils/ScyllaDb');
const TokenManager = require('./src/services/TokenManager');

dotenv.config();

const router = express.Router();
let dbInitialized = false;

async function ensureDatabaseReady() {
  if (!dbInitialized) {
    try {
      // Ensure TokenRegistry table exists
      const tableName = TokenManager.TABLES.TOKEN_REGISTRY;
      const exists = await ScyllaDb.tableExists(tableName).catch(() => false);
      
      if (!exists) {
        console.log(`Creating ${tableName} table...`);
        // Table creation should be done via init-tables.js script
        // This is just a check
        console.warn(`⚠️  Table ${tableName} does not exist. Run init-tables.js first.`);
      }
      
      // Ping database to ensure connection
      await ScyllaDb.ping();
      
      dbInitialized = true;
      console.log('✅ ScyllaDB connected for Token Registry service');
    } catch (error) {
      console.error('❌ Failed to initialize Token Registry database:', error);
      throw error;
    }
  }
}

// Middleware
router.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
  maxAge: 86400
}));

router.use(express.json());
router.use(express.urlencoded({ extended: true }));
router.use(morgan('dev'));

// Health check
router.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'token-registry',
    timestamp: new Date().toISOString()
  });
});

// Mount token registry routes
router.use('/', tokenRegistryRouter);

// Error handling middleware
router.use((err, req, res, next) => {
  console.error('Token Registry Error:', err);

  const status = err.status || err.statusCode || 500;
  const error = {
    error: err.message || 'Internal Server Error',
    message: err.details || err.message,
    code: err.code,
    status: status
  };

  res.status(status).json(error);
});

// 404 handler
router.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    status: 404
  });
});

// ============================================
// INIT SERVICE
// ============================================
const initTokenRegistryService = async () => {
  try {
    await ensureDatabaseReady();
    console.log('✅ Token Registry service initialized');
  } catch (error) {
    console.error('❌ Failed to initialize Token Registry service:', error);
    throw error;
  }
};

// ============================================
// STANDALONE SERVER (when run directly)
// ============================================
if (require.main === module) {
  const app = express();
  const PORT = process.env.PORT || process.env.TOKEN_REGISTRY_PORT || 3006;

  // Apply router middleware
  app.use('/', router);

  // Start server
  async function startServer() {
    try {
      await initTokenRegistryService();
      
      const server = app.listen(PORT, () => {
        console.log(`🚀 Token Registry Server running on port ${PORT}`);
        console.log(`🌐 Health check: http://localhost:${PORT}/health`);
        console.log(`📖 Available endpoints:`);
        console.log(`   - User Tokens: /user-tokens*`);
        console.log(`   - Token Registry: /token-registry*`);
      });

      // Graceful shutdown
      process.on('SIGTERM', () => {
        console.log('SIGTERM received, shutting down gracefully');
        server.close(() => {
          console.log('Token Registry server closed');
          process.exit(0);
        });
      });

      process.on('SIGINT', () => {
        console.log('SIGINT received, shutting down gracefully');
        server.close(() => {
          console.log('Token Registry server closed');
          process.exit(0);
        });
      });
    } catch (error) {
      console.error('❌ Failed to start Token Registry server:', error);
      process.exit(1);
    }
  }

  startServer();
}

module.exports = { router, initTokenRegistryService };
