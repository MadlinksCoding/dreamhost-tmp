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

- `handler/` - Main schema handler with version management
- `postgres/` - PostgreSQL adapter with schema support
- `mysql/` - MySQL adapter
- `scylla/` - ScyllaDB adapter
- `docker-compose.yml` - PostgreSQL container setup
- `initdb/` - Database initialization scripts

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










