# BlockUserService Audit Log

## Overview
The `BlockUserService` handles user blocking, system-level blocks (IP, Email, App), and administrative actions (Suspensions, Warnings). It uses ScyllaDB as the primary data store.

## Work Completed

### 1. Core Service Refactoring (`BlockService.js`)
- **List & Filter**: Added `listUserBlocks`, `listSystemBlocks`, and `listManualActions` with dynamic filter generation (`buildScanOptions`).

### 2. Database Configuration
- **Schema Config**: Created `scylla-schema-config.json` defining Partition Keys (PK) and Sort Keys (SK) for:
  - `user_blocks` (PK: blocker_id, SK: blocked_id)
  - `system_blocks` (PK: identifier)
  - `manual_actions` (PK: user_id)
- **Integration**: Configured `ScyllaDb` helper to load these definitions on startup to ensure correct key validation.

### 3. API Server (`server.js`)
- **Express Setup**: Initialized an Express.js server on port **3002**.
- **Controller Pattern**: Implemented `BlockController` to separate HTTP logic from business logic.
- **Endpoints**:
  - **User**: `POST /block/blockUser`, `POST /block/unblockUser`, `GET /block/isUserBlocked`, `POST /block/batchCheckUserBlocks`, `GET /block/listUserBlocks`
  - **System**: `POST /block/blockIP`, `GET /block/isIPBlocked`, `POST /block/blockEmail`, `GET /block/isEmailBlocked`, `POST /block/blockAppAccess`, `GET /block/isAppAccessBlocked`, `GET /block/listSystemBlocks`
  - **Admin**: `POST /block/suspendUser`, `POST /block/unsuspendUser`, `POST /block/warnUser`, `GET /block/getUserManualActions`, `GET /block/listManualActions`

### 4. Utilities & Scripts
- **Data Management**:
  - `npm run seed`: Populates the database with initial seed data.
  - `npm run deleteTable`: Cleans up tables.
  - `npm run createTable`: Initializes schema.
- **Documentation**: Created `schema.md` with Prisma-style definitions.

## Current State
- **Service Status**: Operational.
- **Database**: ScyllaDB connected and schema validated.
- **API**: Fully exposed and ready for integration.

## Updates - (Schema & Feature Enhancements)

### 1. Schema Redesign (Collision Fixes)
Identified and resolved critical data collision issues where new records would overwrite existing ones due to insufficient Primary Key definitions.
- **Strategy**: Introduced "Shadow Sort Keys" to enforce uniqueness without altering the public API data model.
- **`user_blocks`**: Added `sk_scope` (Sort Key).
  - Format: `${blocked_id}#${scope}`
  - Benefit: Allows a user to block the same target in multiple scopes (e.g., 'dm', 'feed') independently.
- **`system_blocks`**: Added `sk_type` (Sort Key).
  - Format: `ip`, `email`, or `app`
  - Benefit: Prevents an IP block from overwriting an Email block if the identifier hash happened to collide (or if logic changed), and strictly separates block types.
- **`manual_actions`**: Added `sk_ts` (Sort Key).
  - Format: Timestamp string.
  - Benefit: Allows multiple actions (warnings, suspensions) to coexist for a single user. Previously, a new warning would overwrite an active suspension.

### 2. Feature Additions
- **Suspension Metadata**:
  - Added `getSuspensionDetails(userId)` helper.
  - Retrieves the active suspension record to provide context (reason, admin ID, timestamp) to the frontend/API.
- **Misconduct Flags Standardization**:
  - Refactored `MISCONDUCT_FLAGS` into a structured configuration (`_getMisconductRules`).
  - Each flag now includes `text`, `action`, and `slug` properties.
  - `getSuspensionDetails` now enriches the response with these details for UI consumption.

### 3. Codebase Updates
- **`BlockService.js`**: Refactored all read/write methods to utilize the new Sort Keys.
- **`schema/schema.js`**: Updated table definitions to include the new AttributeDefinitions and KeySchema.

### 4. Migration Status
- **Tables Recreated**: `user_blocks`, `system_blocks`, and `manual_actions` have been dropped and recreated with the new schema.

