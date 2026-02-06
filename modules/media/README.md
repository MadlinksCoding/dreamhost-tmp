# Media Handler System

A robust and comprehensive media management system designed to handle various types of media items (audio, video, image, gallery, file) with strict validation, atomic operations, and consistent audit logging.

## Overview

MediaHandler serves as a centralized "traffic controller" for media items, providing:

- Structured input validation and sanitization
- Atomic database operations
- Comprehensive audit logging
- Search indexing capabilities
- Collection management
- Scheduling and publishing controls

## Features

- **Strict Input Validation**: Every method performs thorough sanitization and validation of inputs
- **Atomic Operations**: All database operations are transaction-safe
- **Optimistic Concurrency**: Version-based conflict detection to prevent overwrites
- **Comprehensive Auditing**: Every change is logged with before/after states
- **Flexible Search**: Built-in search capabilities with Elasticsearch support (optional)
- **Collection Management**: Support for organizing media into collections/playlists
- **Publishing Workflow**: Draft → Schedule → Publish pipeline with strict validation
- **Mock Support**: Testing-friendly with mock database capabilities

## Core Handlers

### 1. handleAddMediaItem

Creates new media items with optional metadata, assets, and relationships.

### 2. handleUpdateMediaItem

Updates existing media items with comprehensive field validation.

### 3. handleScheduleMediaItem

Schedules media items for future publishing with validation checks.

### 4. handlePublishMediaItem

Publishes media items with type-specific requirement validation.

## Installation

```bash
npm install
```

## Database Setup

Create database tables:

```bash
npm run table:create
```

Drop database tables:

```bash
npm run table:drop
```

## Tests

The project includes comprehensive test suites:

```bash
# Run first test suite
npm test

# Run second test suite
npm run test:second

# Run third test suite
npm run test:third
```

## Project Structure

```
.
├── db/
│   └── scripts/
│       ├── createTables.js
│       └── deleteTables.js
├── service/
│   └── MediaHandler.js
├── test/
│   ├── first/
│   ├── second/
│   └── third/
├── utils/
│   ├── DB.js
│   ├── Error_handler.js
│   ├── ErrorHandler.js
│   └── SafeUtils.js
└── docker-compose.yml
```

## Key Operations

### Media Management

- Create and update media items
- Attach primary assets and posters
- Set visibility and featured status
- Apply blur controls
- Manage tags and co-performers
- Transfer ownership
- Custom metadata management

### Collection Management

- Create collections
- Add/remove items to/from collections
- List collection contents
- Manage collection metadata

### Publishing Workflow

- Draft creation
- Schedule for future publishing
- Immediate publishing
- Cancel scheduled publications
- Status management

## Error Handling

The system provides specific error types for different scenarios:

- `ValidationError`: Invalid input data
- `ConflictError`: Version mismatch conflicts
- `NotFoundError`: Resource not found
- `StateTransitionError`: Invalid state transitions

## Dependencies

```json
{
    "dependencies": {
        "dotenv": "^17.2.3",
        "pg": "^8.16.3",
        "pg-cloudflare": "^1.2.7",
        "pg-connection-string": "^2.9.1",
        "pg-int8": "^1.0.1",
        "pg-pool": "^3.10.1",
        "pg-protocol": "^1.10.3",
        "pg-types": "^2.2.0",
        "pgpass": "^1.0.5",
        "postgres-array": "^2.0.0",
        "postgres-bytea": "^1.0.0",
        "postgres-date": "^1.0.7",
        "postgres-interval": "^1.2.0",
        "split2": "^4.2.0",
        "uuid": "^13.0.0",
        "xtend": "^4.0.2"
    }
}
```

## License

ISC

## Architecture Benefits

1. **Single Source of Truth**: Centralized field validation and constraints
2. **Composability**: Small, focused methods that can be combined for complex operations
3. **Auditability**: Comprehensive logging of all changes
4. **Testability**: Mock database support for fast, deterministic tests
5. **Reliability**: Search fallback mechanisms and consistent validation
6. **Scalability**: Optimistic concurrency and efficient database operations

## Best Practices

1. Always provide version numbers for updates to prevent conflicts
2. Use transactions for multi-step operations
3. Validate input data before processing
4. Log all significant operations
5. Handle errors appropriately using provided error types
6. Use the mock database capability for testing

## Contributing

When contributing to this project, please:

1. Ensure all tests pass
2. Add appropriate test coverage for new features
3. Follow the existing code style and validation patterns
4. Document new features and changes
5. Use the provided error types for consistent error handling
