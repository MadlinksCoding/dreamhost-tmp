# Token Registry Module

API endpoints for managing token transactions and balances.

## Overview

The Token Registry module provides admin APIs for querying token transactions and user balances. It includes:

- **User Tokens**: Query user token balances (paid, system free, creator free)
- **Token Registry**: Query individual transactions with advanced filtering

## API Routes

### User Tokens
- `GET /user-tokens` - List all user token balances
- `GET /user-tokens/count` - Count user token records
- `GET /user-tokens/creator-free-tokens` - Get creator free token grants
- `GET /user-tokens/:userId/drilldown` - Get detailed balance breakdown for a user

### Token Registry
- `GET /token-registry` - List transactions with filters
- `GET /token-registry/count` - Count transactions matching filters
- `GET /token-registry/:id` - Get transaction details by ID

## Services

- **TokenManager** - Core transaction management (reference to backend service)
  - Handles transaction creation, queries, and state management
  - Location: `backend/src/services/TokenManager.js`

## Database

Uses ScyllaDB with TokenRegistry table:
- Primary Key: `id`
- Indexes:
  - `userIdCreatedAtIndex` - Query by user ID
  - `beneficiaryIdCreatedAtIndex` - Query by beneficiary
  - `refIdTransactionTypeIndex` - Query by reference ID
  - And more...

## Migration Notes

- Migrated from `backend/src/` to `dreamhost-tmp/modules/tokenRegistry/`
- Controllers: `userTokensController.js`, `tokenRegistryController.js`
- Services: References backend `TokenManager.js` for DRY principle
- Utilities: Shared from `dreamhost-tmp/utils/`
