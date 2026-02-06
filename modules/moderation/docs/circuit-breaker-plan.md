# Circuit breaker and backpressure plan

## Goals
- Protect Scylla Alternator from cascaded failures by failing fast when downstream is unhealthy.
- Prevent unbounded concurrent requests; provide predictable latency under load.
- Keep existing retry/backoff semantics where safe, but avoid runaway retries during outages.

## Current gaps
- No circuit breaker: repeated failures keep hammering the DB until retries are exhausted.
- No backpressure: all call sites invoke `request` directly with unbounded concurrency.
- `rawRequest` and helpers have no protection path; errors are only logged to an array.

## Proposed approach
- Wrap the low-level HTTP call in `request` with an `opossum` breaker. Single static breaker covers all operations (including `rawRequest`).
- Add a `p-limit` limiter around the breaker to cap concurrent in-flight requests; queued calls wait or are rejected if a queue limit is exceeded.
- Keep existing exponential retry/backoff inside the breaker action; only the outer breaker decides when to open/half-open.
- Emit breaker state changes (open/halfOpen/close/timeout/reject) to the existing logger or console for observability.

## Config additions (via `configure`)
- `circuitBreaker`: `{ enabled, errorThresholdPercentage, volumeThreshold, resetTimeout, timeout }`
  - `timeout` maps to breaker action timeout (ms).
- `concurrency`: `{ maxConcurrent, maxQueue, queueBehavior }`
  - `maxConcurrent`: number of simultaneous requests allowed (default e.g. 20).
  - `maxQueue`: optional queue size; beyond this, requests are rejected fast.
  - `queueBehavior`: `reject` (default) or `wait` (wait until a slot is free if queue not full).
- Behavior toggles:
  - `cacheBypass`: `{ enabledForGetItemCacheHits: true }` to skip breaker/limiter when `getItem` returns from in-memory cache (no network).
  - `breakerMode`: `global` (default) or `perOperation` to allow separate breaker instances/config for `read`, `write`, `batch`, etc. (start with global unless SLOs diverge).
  - `queuePolicy`: `{ onSaturated: 'reject' | 'wait' | 'error' }` to define response when queue is full; `reject` fast is default.

## Code touchpoints
- `request`: route through limiter -> breaker -> existing HTTP call. Breaker wraps the promise that already performs retries/backoff.
- `rawRequest`: ensure it uses the same wrapped `request` (no bypass).
- `configure`: merge new config, (re)initialize breaker and limiter if relevant settings change.
- `beginSession/endSession`: optionally tie into breaker events to close the persistent agent when open for long (nice-to-have).

## Observability
- Add lightweight logging for breaker events (open/halfOpen/close) and rejects due to maxQueue.
- Expose simple metrics counters (e.g., breaker opens, rejects) via `MetricsCollector` if available, else console.

## Rollout steps
1) Add dependencies: `opossum`, `p-limit` to `moderation/package.json`.
2) Implement breaker+limiter in `scylla.js` as above; wire config parsing and defaults.
3) Add minimal docs in README describing new config knobs and defaults.
4) Test matrix:
   - Healthy downstream: baseline success path still works.
   - Forced failures to trip breaker: verify open -> half-open -> close sequence and fast-fail while open.
   - Concurrency cap hit: calls queue or reject according to config; ensure no unbounded promise creation.
5) Roll out with conservative defaults (e.g., maxConcurrent=20, volumeThreshold=10, errorThreshold=50%, resetTimeout=30s) and tune from metrics.

## Open questions (now config-driven)
- Cache hits: default bypass breaker/limiter for `getItem` when served from in-memory cache; can be disabled via `cacheBypass.enabledForGetItemCacheHits = false`.
- Per-operation breaker: default to one global breaker; allow opt-in per-operation breakers via `breakerMode = 'perOperation'` when read/write SLOs differ.
- Queue saturation: default fast-reject when queue is full; configurable via `queuePolicy.onSaturated` to `wait` (if not time-sensitive) or `error` (raise explicit error type).
