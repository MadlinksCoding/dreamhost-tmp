/**
 * Admin-Only Express Server for Token Manager & Payment Gateway
 * 
 * Migrated from backend/src/server.js
 * Provides admin endpoints for:
 * - User tokens management
 * - Token registry management  
 * - Payment gateway management (Axcess)
 * 
 * Usage: node admin-server.js
 * With npm: npm run admin:start
 */

const express = require('express');
const tokenRegistryRouter = require('./modules/tokenRegistry/src/routes/index');
const paymentRouter = require('./modules/payment/src/routes/index');

const app = express();
const PORT = process.env.ADMIN_PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS: allow frontend to use all endpoints (any origin, common methods and headers)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'admin-api' });
});

// Mount routers
app.use('/', tokenRegistryRouter);
app.use('/', paymentRouter);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);

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
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    status: 404
  });
});

// Start server only when run directly (not when required by tests)
let server = null;
if (require.main === module) {
  server = app.listen(PORT, () => {
    console.log(`Admin Server running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log('\nAvailable endpoints:');
    console.log('  User Tokens: /user-tokens*');
    console.log('  Token Registry: /token-registry*');
    console.log('  Payment Gateway: /payment-*');
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
}

module.exports = app;
