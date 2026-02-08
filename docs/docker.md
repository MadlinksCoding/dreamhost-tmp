# Running with Docker and ScyllaDB

The API runs on **port 3000** and uses **ScyllaDB** (Alternator/DynamoDB API) for token registry and payment gateway data. The frontend can call all admin endpoints and use seeded data after the stack is up.

## Stack

- **scylladb** – ScyllaDB with Alternator on port 8000 (DynamoDB-compatible API), CQL on 9042
- **init-db** – Creates tables and seeds token registry + payment gateway data
- **app** – Admin API server (`admin-server.js`) on port **3000**
- **test** – Runs tests against the app and ScyllaDB (optional)

## Quick start

```bash
# Start ScyllaDB, init (tables + seed), and API
docker compose up -d

# API is available at http://localhost:3000
curl http://localhost:3000/health
curl http://localhost:3000/token-registry?limit=5
curl http://localhost:3000/user-tokens?limit=5
curl http://localhost:3000/payment-sessions?limit=5
```

## Endpoints (port 3000)

All endpoints are available for the frontend; CORS allows any origin.

| Area | Examples |
|------|----------|
| **Health** | `GET /health` |
| **Token registry** | `GET /token-registry`, `GET /token-registry/count`, `GET /token-registry/:id` |
| **User tokens** | `GET /user-tokens`, `GET /user-tokens/count`, `GET /user-tokens/creator-free-tokens`, `GET /user-tokens/:userId/drilldown` |
| **Payment gateway** | `GET /payment-sessions`, `GET /payment-transactions`, `GET /payment-schedules`, `GET /payment-tokens`, `GET /payment-webhooks`, etc. |

## Seeded data

After `docker compose up`, the init container:

1. Waits for ScyllaDB and creates the keyspace (CQL).
2. Creates DynamoDB (Alternator) tables: `TokenRegistry`, `paymentGateway_sessions`, `paymentGateway_transactions`, `paymentGateway_schedules`, `paymentGateway_tokens`, `paymentGateway_webhooks`.
3. Seeds **token registry** (sales-registry style rows, user balances, creator-free-tokens).
4. Seeds **payment gateway** (sessions, transactions, schedules, tokens, webhooks).

The frontend can use this data immediately against `http://localhost:3000`.

## Testing against ScyllaDB

### Option 1: Run the test service in Docker

Runs payment gateway tests and admin API integration tests against the app and ScyllaDB:

```bash
docker compose up --abort-on-container-exit test
# or
npm run docker:test
```

### Option 2: Run tests locally against Docker API

With the stack running:

```bash
docker compose up -d
# Admin API integration tests against localhost:3000
ADMIN_API_URL=http://localhost:3000 npm run test:integration
```

### Option 3: TokenManager integration tests (CQL)

Requires ScyllaDB with CQL (same stack). From the host:

```bash
# Ensure ScyllaDB is up (docker compose up -d)
# Then run CQL-based TokenManager integration tests (optional)
npm run test:token-manager-int
```

## Environment variables (app container)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` / `ADMIN_PORT` | 3000 | API port |
| `DYNAMODB_ENDPOINT` | http://scylladb:8000 | ScyllaDB Alternator URL |

## Frontend configuration

Point the frontend API base URL to:

- **Docker:** `http://localhost:3000`
- **Same host:** `http://localhost:3000` or `http://127.0.0.1:3000`

CORS is configured to allow all origins and common methods/headers so the frontend can call all endpoints.
