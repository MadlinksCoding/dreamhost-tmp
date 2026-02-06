# Moderation Service

A self-contained service for content moderation. This module exposes HTTP endpoints (Express for local development) to manage moderation items, actions, and workflows. In production, it is intended to run serverlessly, while remaining easy to develop in isolation.

## Overview
- Independent module: develop and run without global dependencies.
- Local development: Express server with module-local Docker Compose.
- Production intent: serverless deployment; no changes needed for local dev.
- Constraints: do not modify global/shared files (DB helpers, utilities) outside this module.

## Features
- Moderation APIs (see Postman collection `Moderation_API.postman_collection.json`).
- Data access layer for ScyllaDB Alternator (DynamoDB-compatible).
- Optional resiliency: circuit breaker (opossum) and backpressure (p-limit).
- In-process caching for common reads.

## Prerequisites
- Docker (Desktop or Linux, or any compatible Docker runtime)
- Node.js 18+
- Environment variables: see `.env.example` for all supported options.
	- Common:
		- `SCYLLA_ALTERNATOR_ENDPOINT` (default `http://localhost:8000/`)
		- `SCYLLA_ACCESS_REGION` (default `us-east-1`)
		- `SCYLLA_ACCESS_KEY`, `SCYLLA_ACCESS_PASSWORD`
		- `ENABLE_CACHE` (`true` to enable in-process cache)

## Getting Started
```bash
cd moderation
npm install
docker compose up -d
npm run start
```
- Use `npm run dev` for hot reload with `nodemon`.
- Containers defined in `moderation/docker-compose.yml` are sufficient; no global stack needed.


## Seeding and Cleaning the Database
```bash
cd moderation
docker compose up -d
npm run seed   # Populate initial data
npm run clean  # Remove all moderation data (reset DB)
```
Re-run seeding after `docker compose down` → `up` cycles as needed. Use `npm run clean` to clear the DB before reseeding or for a fresh start.

## Running Tests
Automated:
```bash
cd moderation
npm run test
```
Manual/local checks:
```bash
cd moderation
npm run test:manual
```

## API Reference
- See `Moderation_API.postman_collection.json` for endpoints, payloads, and sample requests.
- The development server is defined in `server.js`.

## Architecture & Directories
- `scylla.js`: Alternator client used by the service (data access layer).
- `RedisClient.js`: Redis integration.
- `utils.js` and `utils/`: local utilities for moderation flows.
- `types/`: Type definitions (e.g., content types).
- `test/`: automated and manual tests.

## Configuration (Service & Data Access)
Configure the Scylla client via `Scylla.configure(partialConfig)`:
- `endpoint`/`port`/`retries`/`backoff`: transport + retry behavior.
- `circuitBreaker`:
	- `enabled`: enable/disable breaker
	- `errorThresholdPercentage`: % failures to open circuit
	- `volumeThreshold`: minimum call count before error % considered
	- `resetTimeout`: ms open → half-open probe
	- `timeout`: breaker action timeout (ms)
- `concurrency`:
	- `maxConcurrent`: simultaneous in-flight requests (p-limit)
	- `maxQueue`: queued operations; `Infinity` for unbounded
	- `queueBehavior`: legacy alias for `queuePolicy.onSaturated`
- `queuePolicy`:
	- `onSaturated`: `reject` (default), `wait`, or `error`
- `cacheBypass`:
	- `enabledForGetItemCacheHits`: bypass guards on `getItem` cache hits
- `breakerMode`:
	- `global` (default) or `perOperation` breakers

Example:
```js
import Scylla from './scylla.js';

Scylla.configure({
	circuitBreaker: { errorThresholdPercentage: 50, resetTimeout: 30000 },
	concurrency: { maxConcurrent: 20, maxQueue: 50 },
	queuePolicy: { onSaturated: 'reject' },
});
```

## Resiliency: Circuit Breaker & Backpressure
- Guard pipeline: `p-limit` (concurrency cap) → optional `opossum` breaker → core request with retry/backoff.
- Breaker events logged: `open`, `halfOpen`, `close`, `timeout`, `reject`.
- Queue saturation policy: configurable; default fast-reject to protect latency.

## Cache Hit Bypass
When `cacheBypass.enabledForGetItemCacheHits` is true, `getItem` cache hits return without breaker/limiter (no network call).

## Methods Overview (Data Access Layer)
- `beginSession()` / `endSession()`: manage HTTPS keep-alive agent.
- `configure(config)`: apply partial configuration; refresh guards.
- `getItem/putItem/updateItem/deleteItem`: CRUD with marshalling.
- `batchWriteItem/batchGetItem`: batch operations (limits enforced).
- `query/scan`: pagination and expression marshalling.
- `transactWrite/transactGet`: simulated transaction helpers.
- `rawRequest(target, payload)`: direct Alternator call via guards.

## Error Tracking
`getErrors()` returns an in-memory history of failures for diagnostics/metrics.

## Tuning & Troubleshooting
- Start conservatively: `maxConcurrent=20`, `errorThreshold=50%`, `volumeThreshold=10`, `resetTimeout=30s`.
- Increase `maxQueue` only if waiting is acceptable; otherwise prefer `reject`.
- Ensure `docker compose up -d` is running before `npm run start` and `npm run seed`.
- Verify env vars match your Alternator setup.
- Check logs for breaker events or queue saturation (`SCYLLA_QUEUE_SATURATED`).




