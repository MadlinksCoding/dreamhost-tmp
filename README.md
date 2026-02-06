# Database Schema Handler Project

A multi-database schema migration handler supporting PostgreSQL, MySQL, and ScyllaDB with per-table versioning and environment-aware deployments.

## 🚀 Quick Start

1. **Set up environment:**
   ```bash
   copy .env.example .env
   # Edit .env with your settings
   ```

2. **Start PostgreSQL:**
   ```bash
   docker-compose up -d postgres
   ```

3. **Run handler tests:**
   ```bash
   cd handler
   npm install
   node test.js plan ./schema.v2.2.json
   ```

See **[HOW_TO_RUN.md](./HOW_TO_RUN.md)** for detailed instructions.

## 📁 Project Structure

- Top-level files:
   - `dev.dockerfile` — development Dockerfile
   - `index.js` — optional app entrypoint / example script
   - `server.js` — server bootstrap (varies by module)
   - `package.json` — repo-level npm config
   - `dev.docker-compose.yml` — top-level compose for local development
   - `README.md` — this file

- `configs/` — repo-wide configuration templates and route logs (e.g. `envConfig.json`, `logRoutes.json`)

- `databases/` — DB helpers, compose and integration scripts, tests and setup helpers for all database flavors

- `handler/` — Database Schema Handler service
   - `package.json`, `db/`, `config/`, `utils/`, `schema.v2.*.json`, test scripts and seed data

- `initdb/` — SQL scripts to initialise roles, users and security objects

- Adapters (lightweight runtime wrappers):
   - `mysql/` — MySQL adapter and test harness
   - `postgres/` — PostgreSQL adapter and test harness
   - `scylla/` — ScyllaDB adapter and local compose

- `modules/` — feature micro-services. Each module typically contains `server.js`, `package.json`, `src/`, `scripts/`, `test/`, `docs/`.
   - Examples: `blockUserService/`, `media/`, `moderation/`, `users/`

- `utils/` — small, repo-wide helpers (e.g. `ConfigFileLoader.js`, `Logger.js`, `EnvLoader.js`, `DateTime.js`, `SafeUtils.js`)

- `docs/` — high-level documentation and endpoint guides

### Module Architecture

- Modules are implemented as self-contained classes (one class per service) and live under `modules/<service>/`.
- Modules can be built, tested and deployed independently — they are intended to run as separate services when required.
- Required exports: every module should export an `init()` method and a `router()` method:
   - `init()` — perform startup initialization (load config, connect to DBs, register metrics, etc.).
   - `router()` — return the module's HTTP/router instance (Express/fastify router or similar) so the host can mount routes.
- Export example (CommonJS):

   ```js
   function init(options) { /* setup */ }
   function router() { /* return express.Router() */ }

   module.exports = { init, router };
   ```

Notes:
- Each module under `modules/` is intended to be self-contained. See the module's `README.md` for start/test commands.
- Handler-specific docs live in `handler/README.md` and `handler/schema.v2.*.json` files are the canonical schema examples.

## 🔧 Features

- ✅ Per-table versioning via environment variables
- ✅ Multi-database support (PostgreSQL, MySQL, ScyllaDB)
- ✅ Custom schema support (defaults to `app` schema)
- ✅ Non-destructive operations (only additive changes)
# Database Schema Handler

This repository contains a multi-database schema migration handler (PostgreSQL, MySQL, ScyllaDB) and several service modules. The repo has been reorganized: see `suggested_folder_struct.md` for the recommended layout.

## Quick Start

1. Copy the example env and fill values (do NOT commit real secrets):

```powershell
copy .\configs\env.example.json .\utils\configs\envConfig.json
# Edit .\utils\configs\envConfig.json locally (this file is git-ignored)
```

2. Start development services (local Docker):

```powershell
docker-compose up -d
```

3. Run a handler dry-run (example):

```powershell
cd handler
npm install
node test.js plan ./schema.v2.2.json
```

## What changed

- Services are grouped under `modules/` (each service has `src/`, `configs/`, `test/`).
- Shared code lives under `internal/` or `lib/` (moved from `handler/`).
- `utils/` contains small, repo-wide helpers.
- Local runtime data (e.g. `pgdata/`) should be kept outside the repo or added to `.gitignore`.
- Secrets must be stored out of source (use environment variables or a secret manager). A `configs/env.example.json` template should be used instead of committing real credentials.

See `suggested_folder_struct.md` for a full, recommended layout.

## Security / Secrets

- `utils/configs/envConfig.json` is expected to be git-ignored. If you haven't already, add it to `.gitignore`.
- If secrets were accidentally committed, remove them from history with `git filter-repo` or interactive rebase and rotate the leaked credentials immediately.

## Running specific modules

Each service under `modules/<service>/` typically exposes its own start/test commands. Example:

```powershell
cd modules/blockUserService
npm install
npm test
npm start
```

## Docs

- `suggested_folder_struct.md` — repo layout and next steps
- `handler/README.md` — handler-specific docs

If you'd like, I can:
- Add `utils/configs/envConfig.json` to `.gitignore` and commit the change.
- Create a redacted `configs/env.example.json` from your current `utils/configs/envConfig.json`.
- Move selected folders into the new `modules/` layout and update imports (I'll preview changes first).










