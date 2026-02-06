# Moderation Module — Technical Assessment & Improvement Recommendations

## Brief Summary

Independent moderation API layer built on Express and ScyllaDB (Alternator, DynamoDB-compatible). Provides endpoints to create and manage moderation records (approve/reject/escalate, notes, soft/hard delete), query by status/type/priority/date, and fetch related content placeholders. Includes custom Scylla client, input sanitization via `SafeUtils`, and in-memory error logging. Some cross-module dependencies exist (users and shared utils), so independence is partial.

---

## Module Overview

- Purpose: Centralize moderation workflows for user-generated content across media, text, tags, links, and reports.
- Runtime: Node.js (ESM), Express server (`server.js`) with JSON and CORS middleware.
- Storage: ScyllaDB Alternator using a DynamoDB-compatible schema; table `moderation` with GSIs for status/date, user status/date, dayKey, type, priority, and moderationId.
- Core components:
  - Moderation domain (`moderation.js`): record creation, actions (approve/reject/pending_resubmission), notes, soft/hard delete, meta updates, retrieval and queries, pagination.
  - Scylla client (`scylla.js`): signed AWS-style requests, retries/backoff, table config loader, marshalling helpers.
  - Server (`server.js`): REST endpoints, DB initialization, content fetch placeholders, cache flush placeholders.
  - Utilities: `SafeUtils` (sanitize/validate), `Logger` (console + ErrorHandler), `ErrorHandler` (in-memory store).
- Dependencies (selected): express, cors, dotenv, redis, pg, AWS SDK (S3), luxon/moment (both present).

### Data Model

- Table: `moderation` with keys `pk = moderation#<userId>`, `sk = media#<submittedAt>`.
- GSIs: StatusSubmittedAt, UserStatusDate, AllByDate (dayKey), Priority, TypeDate, ByModerationId.
- Fields: `moderationId`, `userId`, `contentId`, `type`, `status`, `priority`, `submittedAt`, `actionedAt`, `moderatedBy`, `escalatedBy`, `reason`, `action`, `notes`, `meta`, soft delete flags.
- Audit meta: versioned with history entries; updated per mutations.

---

## API Overview

Public endpoints exposed by the Express server:

- Health: GET `/health` — simple status probe.
- Create: POST `/moderation` — create record (requires `userId`, `contentId`, `type`).
- Retrieve:
  - GET `/moderation/:moderationId` — single record (optional `userId`).
  - GET `/moderation/:moderationId/content` — placeholder content fetch integration.
  - GET `/moderation/:moderationId/notes` — notes (public/private separated).
- Query:
  - GET `/moderation/status/:status`
  - GET `/moderation/type/:type`
  - GET `/moderation/priority/:priority`
  - GET `/moderation/user/:userId/status/:status`
  - GET `/moderation/date/:dayKey`
  - GET `/moderation/count` — filtered counts.
  - GET `/moderation/counts` — aggregate counts.
- Mutations:
  - PUT `/moderation/:moderationId` — update (meta).
  - POST `/moderation/:moderationId/meta` — update meta (alternate route).
  - POST `/moderation/:moderationId/action` — apply approve/reject/pending_resubmission (+ optional notes).
  - POST `/moderation/:moderationId/escalate` — mark escalated.
  - POST `/moderation/:moderationId/note` or `/notes` — add note.
  - DELETE `/moderation/:moderationId` — soft/hard delete.
- Integration placeholders:
  - POST `/moderation/:moderationId/notify` — webhook/notification stub.
  - POST `/tags/:tagId/cache/flush` and POST `/cache/flush` — cache invalidation stubs.

### Endpoint Status Notes

- Outdated: GET `/moderation/:moderationId/notes` — legacy shape and visibility model; should be consolidated behind a single notes service with access controls and pagination.
- Outdated: GET `/moderation/:moderationId/content` — placeholder-only integration; replace with a dedicated Content API adapter and remove this route from the moderation surface.

Recommended actions: mark both endpoints as deprecated, add server warnings when called, migrate clients to the appropriate Content/Notes services, and remove in the next minor release.

---

## Security Assessment

Observations:

- No authentication or authorization: All endpoints are publicly writable; moderation actions lack role checks.
- CORS: Enabled globally with default `cors()` (permissive); no origin restrictions.
- Input validation: Domain layer uses `SafeUtils.sanitizeValidate`, but request-layer schemas are implicit and not enforced with a schema library.
- Rate limiting & abuse protection: Not present.
- Transport to Scylla: Alternator endpoint may be `http://` by default; SigV4 signing is used, but secrets exist in env; no secret leakage protections.
- Logging: Error details may include stack traces; no PII scrubbing; logs are console + in-memory `ErrorHandler` only.
- Dependency hygiene: Both `moment` and `luxon` present; no security middleware (`helmet`), no input size limits.
- Cross-module coupling: Server lazy-loads users API and DB; utilities wrap shared root files, reducing true modular isolation.

Recommendations (prioritized):

1) Authentication & Authorization (High impact)
	- Add JWT/API-key auth middleware; enforce RBAC (e.g., `moderator`, `admin`) for action endpoints and deletion.
	- Consider per-route scopes, e.g., read-only for GETs, privileged for mutating routes.

2) Request Validation (High impact)
	- Adopt a schema validator (Zod/Joi/Valibot) at route level with strict types and limits.
	- Validate `type`, `priority`, `notes` length, `timestamps`, and enumerations at the request boundary.

3) Security Middleware & Hardening (High impact)
	- Add `helmet` with sensible defaults; configure `content-security-policy` if serving any content.
	- Restrict `cors` to known origins; set `methods` and `allowedHeaders` explicitly.
	- Enforce body size limits (e.g., `express.json({ limit: '256kb' })`).

4) Rate Limiting & DoS Controls (Medium impact)
	- Use `express-rate-limit` per-IP/per-key; stricter limits on write endpoints (`POST`, `PUT`, `DELETE`).
	- Add basic bot/abuse detection (user-agent checks, burst suppression).

5) Secrets & Transport (Medium impact)
	- Ensure Alternator endpoint uses HTTPS where available; treat Scylla behind trusted network if HTTP.
	- Never log credentials; audit `.env` handling, centralize config and rotate keys regularly.

6) Logging & Audit (Medium impact)
	- Add request IDs and structured JSON logs with masked PII.
	- Persist audit logs (file/stdout with shipper, or external sink like ELK/Datadog).
	- Expand meta audit-history to include actor identity and origin IP.

7) Dependency & DX Hygiene (Low/Medium)
	- Remove `moment` (use `luxon` only) to reduce surface.
	- Pin dependency ranges; add `npm audit` CI step.

---

## Reliability & Performance

Observations:

- Retries/backoff in Scylla client exist; timeouts are low (1s) and error handling accumulates in memory.
- No circuit breaker or backpressure for database failures.
- Pagination via `nextToken` implemented; caching disabled by default; basic awareness of throttling.
- Content fetch stubs; integration points not implemented, so latency budget unknown.

Recommendations:

- Add circuit breaker and retry policies per operation category (reads vs writes).
- Increase and tune timeouts; add per-request cancellation (AbortController) to avoid hung connections.
- Introduce per-route concurrency limits for write-heavy endpoints.
- Consider local caching for read endpoints (status/type/date queries) with TTL and invalidation hooks.
- Add indexed query patterns benchmarks; validate GSIs sizing under realistic workloads.

---

## Observability & Operations

Recommendations:

- Metrics: add counters/timers for endpoint latency, error rates, DB calls, retries, and throttling; expose `/metrics` (Prometheus).
- Health & readiness: expand `/health` to include DB connectivity, table existence, and dependencies readiness.
- Structured logs: use a logger with levels, JSON output, correlation IDs, and PII scrubbing.
- Error handling: persist errors beyond in-memory; implement alerting on error spikes.

---

## Independence & Packaging

Observations:

- References to `../users` and shared `../../utils/*` reduce true independence.

Recommendations:

- Introduce adapter interfaces for external modules (Users, Tags, Media, Cache) and inject implementations.
- Internalize utility wrappers or publish shared utils as a versioned NPM package; remove path-based coupling.
- Provide a minimal `index` export for the moderation domain (library mode) and a separate server entry (service mode).
- Add a sample `.env.example` scoped to moderation only.

---

## Testing & Quality

Observations:

- Test scripts exist under `test/` but runner is custom; Jest is included but not wired.

Recommendations:

- Adopt Jest fully: unit tests for domain methods (create/applyAction/addNote/query) and integration tests for endpoints.
- Add contract tests for request validation schemas and error cases.
- Add linting/formatting (`eslint`, `prettier`) and CI checks.
- Consider TypeScript migration for domain/server to align with `types.ts` and improve safety.

---

## Deployment & Environment

Observations:

- `docker-compose.yml` provides ScyllaDB; server bootstrap initializes the table on demand.

Recommendations:

- Add containerization for the moderation API with environment-driven config.
- Provide readiness probes and graceful shutdown (SIGTERM handlers).
- Document environment variables and defaults; include `.env.example`.

---

## Roadmap: Prioritized Improvements

Quick Wins (1–3 days):

- Add `helmet`, restrict `cors`, body size limits.
- Add `express-rate-limit` with per-route policies.
- Consolidate date libraries to `luxon` only.
- Wire Jest and add core unit tests.

Medium (1–2 weeks):

- Implement authentication (JWT/API key) and RBAC for mutations and deletion.
- Introduce request validation with Zod/Joi; strict schemas per route.
- Structured logging with request IDs; basic metrics.
- Adapter interfaces to decouple Users/Media/Tags; remove direct path imports.

Longer-Term (2–4+ weeks):

- Migrate moderation domain + server to TypeScript; leverage `types.ts`.
- Implement circuit breaker/backpressure; improve retry policies and caching.
- Production-grade observability: metrics, tracing, log shipping, alerts.
- Package the module as an NPM library with clear API, separate service entry, and published docs.

---

## Action Checklist

- [ ] Add auth & RBAC middleware and guards on mutation endpoints.
- [ ] Add per-route validation schemas (Zod/Joi) and enforce limits.
- [ ] Add `helmet`, restricted CORS, and JSON body size limits.
- [ ] Implement rate limiting and basic abuse detection.
- [ ] Replace `moment` usage with `luxon` exclusively.
- [ ] Introduce structured logging and persist error/audit logs.
- [ ] Expand `/health` with dependency checks; add readiness endpoint.
- [ ] Add Jest tests and CI pipeline with linting/audit.
- [ ] Define adapter interfaces; remove cross-module imports (users/utils).
- [ ] Provide `.env.example` and module-level configuration docs.
