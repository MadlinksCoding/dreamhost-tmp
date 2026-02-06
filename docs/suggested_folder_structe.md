```text
Repository root (recommended)

./
├─ modules/                     # Independent services/apps
│  ├─ blockUserService/
│  │  ├─ src/                    # service source (server, controllers, services)
│  │  ├─ configs/                # service-specific config (templates only)
│  │  ├─ test/
│  │  ├─ Dockerfile
│  │  └─ docker-compose.yml
│  ├─ moderation/
│  └─ users/
├─ internal/ or lib/             # shared internal libraries
│  └─ handler/                   # move existing `handler/` here
│     ├─ src/
│     ├─ adapters/               # Db adapters: postgresql, mysql, scylla
│     └─ README.md
├─ utils/                        # small utilities used across modules
├─ configs/                      # repo-level config templates and examples
│  └─ env.example.json           # template, not secrets
├─ infra/                        # docker data, local-only runtime directories (prefer outside repo)
│  └─ pgdata/                    # avoid committing; add to .gitignore
├─ initdb/                       # DB initialization scripts (SQL)
├─ docker-compose.yml            # local compose wiring for dev only
├─ package.json
├─ README.md
└─ docs/

Notes:
- Keep real secrets out of the repo. Add `utils/configs/envConfig.json` and other secret files to `.gitignore`.
- Provide `configs/env.example.json` or `.env.example` with placeholders.
- Prefer moving local data folders (pgdata, mysql data) outside the repo root or list them in `.gitignore`.
- When moving files, update relative imports/require paths; keep commits small and test each service.

Next steps I can take for you:
- Add `utils/configs/envConfig.json` to `.gitignore` and commit that change.
- Create `configs/env.example.json` copied from the current file with secrets redacted.
- Move `handler/` into `internal/handler/` and adjust requires (I will preview changes first).
```