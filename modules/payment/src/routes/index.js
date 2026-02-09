const express = require('express');
const router = express.Router();
const paymentGatewayController = require('../controllers/paymentGatewayController');

// Payment gateway (Axcess) endpoints
router.get('/payment-sessions', paymentGatewayController.listSessions);
router.get('/payment-sessions/count', paymentGatewayController.countSessions);
router.get(
  '/payment-sessions/axcess/session/:id',
  paymentGatewayController.getAxcessSession
);
router.get('/payment-transactions', paymentGatewayController.listTransactions);
router.get('/payment-transactions/count', paymentGatewayController.countTransactions);
router.get(
  '/payment-transactions/axcess/transaction/:id',
  paymentGatewayController.getAxcessTransaction
);
router.get('/payment-schedules', paymentGatewayController.listSchedules);
router.get('/payment-schedules/count', paymentGatewayController.countSchedules);
router.get('/payment-tokens', paymentGatewayController.listTokens);
router.get('/payment-tokens/count', paymentGatewayController.countTokens);
router.get('/payment-webhooks', paymentGatewayController.listWebhooks);
router.get('/payment-webhooks/count', paymentGatewayController.countWebhooks);
router.get(
  '/payment-transactions/failed',
  paymentGatewayController.listFailedTransactions
);
router.get(
  '/payment-webhooks/order/:orderId',
  paymentGatewayController.listOrderWebhooks
);
router.get(
  '/payment-webhooks/subscription/:subscriptionId',
  paymentGatewayController.listSubscriptionWebhooks
);

module.exports = router;
