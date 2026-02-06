# Users Service

This project provides a robust backend service for managing user data and presence status, with support for multiple environments (development, stage, production). It uses **PostgreSQL** for persistent storage.
---

## 📁 Complete File and Folder Structure

```
users/
├── test/                        # Automated test scripts for all major features
│   ├── index.js
│   ├── setUserName.js
│   ├── getCriticalUserData.js
│   ├── presenceStatus.js
│   ├── updatePresenceFromSocket.js
│   ├── setPresenceOverride.js
│   ├── isUsernameTaken.js
│   ├── getUserField.js
│   ├── updateUserField.js
│   ├── buildUserData.js
│   ├── buildUserSettings.js
│   ├── buildUserProfile.js
│   ├── getCriticalUsersData.js
│   └── getBatchOnlineStatus.js
├── utils/                       # Utility classes and helpers
│   ├── UtilityLogger.js         # Logging utility
│   └── ErrorHandler.js          # Error handling utility
├── .env                         # Environment variables
├── README.md                    # Project documentation
```

---

## ⚙️ Environment Setup

Create a `.env` file in the root directory with the following variables:

```env
APP_ENVIRONMENT=development         # or 'stage' or 'production'
POSTGRES_USER=user_test
POSTGRES_PASSWORD=user_test
POSTGRES_DB=user_test
PGHOST=127.0.0.1
PGPORT=5432
NODE_ENV=local
LOGGING_ENABLED=1
LOGGING_CONSOLE_ENABLED=1
```

---

## 🏃‍♂️ How to Run

### 1. Install Dependencies
```bash
npm install
```

### 2. Database Setup
Start the required services (PostgreSQL) using Docker:
```bash
docker-compose up -d
```

Once the containers are running, create the necessary tables:
```bash
npm run create-tables
```
*(Optional) Seed with sample data:*
```bash
npm run seed
```

### 3. Start the Server
```bash
npm start
```
The server will start on the port defined in `.env` (default: 3000).
- Health Check: `http://localhost:3000/health`
- API Endpoint: `http://localhost:3000/users/fetchUsers`
PostgreSQL Database**: Primary persistent storage for users, profiles, and settings.

## 🚀 Features

- **Comprehensive logging and error handling**.
- **Test suite**: Automated tests for all major features.
- **Extensible utility structure**.

---

## scripts

| Command               | Description                                                      |
| --------------------- | ---------------------------------------------------------------- |
| `npm run createTable` | Creates the database tables                                      |
| `npm run dropTables`  | Drops all existing tables                                        |
| `npm run seed`        | Seeds the database with sample user data                         |
| `npm run deleteUser`  | Deletes a user (script implementation inside `db/deleteUser.js`) |
| `npm run test`        | Runs Jest tests                                                  |
| `npm run test:manual` | Runs manual test script (`test/index.js`)                        |

## 🧪 Running Tests

All test scripts are in the `test/` folder. Example test functions include:

- `setUserNameTest`, `testGetCriticalUserData`, etc. – Test user and presence features.

To run a test, import and execute the desired function from `test/index.js`:

```javascript
import { setUserNameTest } from "./test/index.js";

setUserNameTest().then((result) => {
  if (result) {
    console.log("Test passed!");
  } else {
    console.log("Test failed!");
  }
});
```

Or run all tests by creating a runner script that imports and executes each exported test.

---

## 🛠️ Dependencies

- Node.js
- PostgreSQL (for user data)
- Custom utilities: `UtilityLogger.js`, `ErrorHandler.js`

---

## 📝 Notes

- **Logging**: Controlled by `LOGGING_ENABLED` and `LOGGING_CONSOLE_ENABLED` in `.env`.
- **Database**: Make sure PostgreSQL is running and accessible with the credentials in `.env`.

---

