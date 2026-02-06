# BlockUserService

A robust microservice for handling user blocking, system-level blocks (IP, Email, App), and administrative actions (Suspensions, Warnings). Built with Node.js and ScyllaDB.

## Project Structure

```
BlockUserService/
├── docs/                   # Documentation and audit logs
│   ├── schema.md # schema of the module in md format
│   └── misconduct_flags.md    # Standardized suspension reasons and flags
├── schema/                 # Database schema definitions
│   └── schema.js           # ScyllaDB table schemas
├── scripts/                # Utility scripts
│   ├── createTables.js     # Creates ScyllaDB tables
│   ├── deleteTables.js     # Drops ScyllaDB tables
│   └── seed.js             # Seeds database with test data
├── src/
│   ├── services/
│   │   ├── BlockService.js # Core business logic
│   │   └── scylla/         # ScyllaDB connection wrapper
│   └── utils/              # Helper utilities (Logger, ErrorHandler, etc.)
├── test/                   # Test suite
│   ├── index.js            # Test runner
│   └── blockServiceTests.js# Test cases
├── scylla-schema-config.json # Schema configuration for key validation
├── server.js               # Express API server
└── package.json            # Dependencies and scripts
```

## Usage

### Prerequisites
- Node.js (v18+)
- ScyllaDB (running locally or accessible)

### Setup
1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Environment Configuration**:
   Create a `.env` file (copy from `.env.example` if available) with necessary credentials.

3. **Database Initialization**:
   Only run these if setting up a fresh database or after a schema change.
   ```bash
   # Drop existing tables (CAUTION: DATA LOSS)
   npm run deleteTable

   # Create tables with current schema
   npm run createTable
   ```

### Running the Service
- **Development Mode** (with hot-reload):
  ```bash
  npm run dev
  ```
- **Production Mode**:
  ```bash
  npm start
  ```
- **Run Tests**:
  ```bash
  npm run test:manual
  ```

## API Endpoints

The service runs on port **3002** by default.

### User Blocking
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/block/blockUser` | Block a user in a specific scope. |
| `POST` | `/block/unblockUser` | Unblock a user. |
| `GET` | `/block/isUserBlocked` | Check if a user is blocked. |
| `POST` | `/block/batchCheckUserBlocks` | Check multiple block statuses in one request. |
| `GET` | `/block/listUserBlocks` | List user blocks with filters. |

### System Blocking
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/block/blockIP` | Block an IP address. |
| `GET` | `/block/isIPBlocked` | Check if an IP is blocked. |
| `POST` | `/block/blockEmail` | Block an email address. |
| `GET` | `/block/isEmailBlocked` | Check if an email is blocked. |
| `POST` | `/block/blockAppAccess` | Block access for a specific App ID. |
| `GET` | `/block/isAppAccessBlocked` | Check if App Access is blocked. |
| `GET` | `/block/listSystemBlocks` | List system blocks with filters. |

### Administrative Actions
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/block/suspendUser` | Suspend a user account. |
| `POST` | `/block/unsuspendUser` | Lift a user suspension. |
| `GET` | `/block/isUserSuspended` | Check if a user is suspended. |
| `POST` | `/block/warnUser` | Issue a warning to a user. |
| `GET` | `/block/getUserManualActions` | Get history of manual actions for a user. |
| `GET` | `/block/listManualActions` | List manual actions with filters. |

### Health Check
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Check service status. |

## Database Schema Notes

The schema uses Composite Keys to prevent data collisions:
- **`user_blocks`**: Partition Key: `blocker_id`, Sort Key: `sk_scope` (`blocked_id#scope`)
- **`system_blocks`**: Partition Key: `identifier`, Sort Key: `sk_type` (`ip`, `email`, `app`)
- **`manual_actions`**: Partition Key: `user_id`, Sort Key: `sk_ts` (Timestamp)

#### Here are the table creation results

1. user_blocks table
``` 
user_blocks table create result: {
  TableDescription: {
    TableName: 'user_blocks',
    AttributeDefinitions: [ [Object], [Object] ],
    KeySchema: [ [Object], [Object] ],
    ProvisionedThroughput: { ReadCapacityUnits: 40000, WriteCapacityUnits: 40000 },
    CreationDateTime: 1751402531,
    TableStatus: 'ACTIVE',
    TableId: 'dce05d90-56bb-11f0-a478-97be0e2573f8'
  }
}
```
2. system_blocks table

```
system_blocks table create result: {
  TableDescription: {
    TableName: 'system_blocks',
    AttributeDefinitions: [ [Object] ],
    KeySchema: [ [Object] ],
    ProvisionedThroughput: { ReadCapacityUnits: 40000, WriteCapacityUnits: 40000 },
    ProvisionedThroughput: { ReadCapacityUnits: 40000, WriteCapacityUnits: 40000 },
    CreationDateTime: 1751402531,
    TableStatus: 'ACTIVE',
    TableId: 'dd0857f0-56bb-11f0-a478-97be0e2573f8'
  }
}
```

3. manual_actions table
```
manual_actions table create result: {
  TableDescription: {
    TableName: 'manual_actions',
    AttributeDefinitions: [ [Object] ],
    KeySchema: [ [Object] ],
    ProvisionedThroughput: { ReadCapacityUnits: 40000, WriteCapacityUnits: 40000 },
    CreationDateTime: 1751402793,
    TableStatus: 'ACTIVE',
    TableId: '78e26a30-56bc-11f0-a478-97be0e2573f8'
  }
}

```