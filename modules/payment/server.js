/**
 * Payment Gateway Module Server
 * 
 * Independent Express server for Payment Gateway module.
 * Provides admin endpoints for payment sessions, transactions, schedules, tokens, and webhooks.
 * 
 * Usage: node modules/payment/server.js
 * Or: cd modules/payment && node server.js
 */

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const morgan = require('morgan');
const path = require('path');

const paymentRouter = require('./src/routes/index');
const ScyllaDb = require('./src/utils/ScyllaDb');

dotenv.config();

const router = express.Router();
let dbInitialized = false;

async function ensureDatabaseReady() {
  if (!dbInitialized) {
    try {
      const tablesPath = path.join(__dirname, 'src', 'utils', 'tables.json');
      await ScyllaDb.loadTableConfigs(tablesPath);
      
      // Ping database to ensure connection
      await ScyllaDb.ping();
      
      dbInitialized = true;
      console.log('✅ ScyllaDB connected for Payment Gateway service');
    } catch (error) {
      console.error('❌ Failed to initialize Payment Gateway database:', error);
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
    service: 'payment-gateway',
    timestamp: new Date().toISOString()
  });
});

// Mount payment routes
router.use('/', paymentRouter);

// Error handling middleware
// Error and 404 handlers are applied only when running this module standalone

// ============================================
// INIT SERVICE
// ============================================
const initPaymentService = async () => {
  try {
    await ensureDatabaseReady();
    console.log('✅ Payment Gateway service initialized');
  } catch (error) {
    console.error('❌ Failed to initialize Payment Gateway service:', error);
    throw error;
  }
};

// ============================================
// STANDALONE SERVER (when run directly)
// ============================================
if (require.main === module) {
  const app = express();
  const PORT = process.env.PORT || process.env.PAYMENT_PORT || 3005;

  // Apply router middleware
  app.use('/', router);

  // When running standalone, attach module-level error and 404 handlers
  app.use((err, req, res, next) => {
    console.error('Payment Gateway Error:', err);

    const status = err.status || err.statusCode || 500;
    const error = {
      error: err.message || 'Internal Server Error',
      message: err.details || err.message,
      code: err.code,
      status: status
    };

    res.status(status).json(error);
  });

  app.use((req, res) => {
    res.status(404).json({
      error: 'Not Found',
      message: `Route ${req.method} ${req.path} not found`,
      status: 404
    });
  });

  // Start server
  async function startServer() {
    try {
      await initPaymentService();
      
      const server = app.listen(PORT, () => {
        console.log(`🚀 Payment Gateway Server running on port ${PORT}`);
        console.log(`🌐 Health check: http://localhost:${PORT}/health`);
        console.log(`📖 Available endpoints:`);
        console.log(`   - Payment Sessions: /payment-sessions*`);
        console.log(`   - Payment Transactions: /payment-transactions*`);
        console.log(`   - Payment Schedules: /payment-schedules*`);
        console.log(`   - Payment Tokens: /payment-tokens*`);
        console.log(`   - Payment Webhooks: /payment-webhooks*`);
      });

      // Graceful shutdown
      process.on('SIGTERM', () => {
        console.log('SIGTERM received, shutting down gracefully');
        server.close(() => {
          console.log('Payment Gateway server closed');
          process.exit(0);
        });
      });

      process.on('SIGINT', () => {
        console.log('SIGINT received, shutting down gracefully');
        server.close(() => {
          console.log('Payment Gateway server closed');
          process.exit(0);
        });
      });
    } catch (error) {
      console.error('❌ Failed to start Payment Gateway server:', error);
      process.exit(1);
    }
  }

  startServer();
}

module.exports = { router, initPaymentService };
