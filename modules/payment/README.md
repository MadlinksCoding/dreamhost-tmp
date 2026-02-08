# Payment Gateway Module

API endpoints for managing payment sessions, transactions, schedules, tokens, and webhooks using the Axcess payment gateway.

## Overview

The Payment Gateway module provides comprehensive admin APIs for querying payment data and integration with the Axcess payment gateway. It includes:

- **Payment Sessions**: Query checkout sessions
- **Payment Transactions**: Query transaction history
- **Payment Schedules**: Query subscription schedules
- **Payment Tokens**: Query stored payment tokens
- **Payment Webhooks**: Query webhook events

## API Routes

### Payment Sessions
- `GET /payment-sessions` - List all payment sessions
- `GET /payment-sessions/count` - Count sessions matching filters
- `GET /payment-sessions/axcess/session/:id` - Get session details from Axcess

### Payment Transactions
- `GET /payment-transactions` - List all transactions
- `GET /payment-transactions/count` - Count transactions matching filters
- `GET /payment-transactions/axcess/transaction/:id` - Get transaction details from Axcess
- `GET /payment-transactions/failed` - List failed transactions

### Payment Schedules
- `GET /payment-schedules` - List subscription schedules
- `GET /payment-schedules/count` - Count schedules

### Payment Tokens
- `GET /payment-tokens` - List stored payment tokens
- `GET /payment-tokens/count` - Count tokens

### Payment Webhooks
- `GET /payment-webhooks` - List all webhooks
- `GET /payment-webhooks/count` - Count webhooks
- `GET /payment-webhooks/order/:orderId` - Get webhooks for an order
- `GET /payment-webhooks/subscription/:subscriptionId` - Get webhooks for a subscription

## Services

- **paymentGatewayService** - Payment data queries and CRUD operations
  - Location: `backend/src/services/paymentGatewayService.js`

- **Axcess** - Payment gateway integration
  - Handles API calls to Axcess payment gateway
  - Location: `backend/src/services/Axcess.js`

## Database

Uses ScyllaDB with multiple tables:
- `paymentGateway_sessions` - Payment checkout sessions
- `paymentGateway_transactions` - Payment transactions
- `paymentGateway_schedules` - Subscription schedules
- `paymentGateway_tokens` - Stored payment tokens
- `paymentGateway_webhooks` - Webhook events

## Migration Notes

- Migrated from `backend/src/` to `dreamhost-tmp/modules/payment/`
- Controller: `paymentGatewayController.js`
- Services: References backend `paymentGatewayService.js` and `Axcess.js` for DRY principle
- Utilities: Shared from `dreamhost-tmp/utils/`
