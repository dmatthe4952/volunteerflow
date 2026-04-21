# LocalShifts

Node + Fastify + Nunjucks + Postgres implementation for LocalShifts.

Operator runbook: `OPERATORS_MANUAL.md`

## Staging / production

LocalShifts is intended to be run via Docker Compose on a server (staging and above). The app runs DB migrations automatically on startup.

1) Create `.env.staging` on the server (start from `.env.staging.example`) and set at least:
- `APP_URL`
- `DATABASE_URL`
- `SESSION_SECRET`
- `ADMIN_TOKEN`

2) Start the app:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml up -d --build
```

Optional profiles:
- TLS via Caddy: add `--profile caddy` (configure `CADDY_HOST`/`CADDY_EMAIL` in `.env.staging`)
- Local Postgres (if not using a managed DB): add `--profile localdb`

Notes:
- App logs are written to `logs/app.log`.
- Volunteer “email me a link” requires SMTP to be configured in `.env.staging` (see `.env.staging.example`).
- For a more reliable deploy flow (build → up → smoke test), use:
  - `sh scripts/deploy-staging.sh`
  - `sh scripts/deploy-staging-from-git.sh`
  - `sh scripts/smoke.sh "$APP_URL"`

Admin/Manager entrypoints:

- First-time setup (only if no Super Admin exists yet): `GET /admin/setup` (dev/test), or send `x-admin-token: $ADMIN_TOKEN` in prod.
- Admin login: `GET /admin/login`
- Manager login: `GET /manager/login`
- Admin creates managers at: `GET /admin/users`
- Admin creates organizations at: `GET /admin/organizations` (required before managers can create events)
- Manager event CRUD:
  - `GET /manager/events`
  - `GET /manager/events/new`
  - `GET /manager/events/:id/edit`
  - `GET /manager/events/:id/signups` (roster + manual add/remove + CSV)
  - `GET /manager/events/:id/cancel` (cancel with message + notify)

Ops (temporary, until admin/manager UI exists):

- Cancel an event + notify volunteers: `POST /ops/events/:slugOrId/cancel` with header `x-admin-token: $ADMIN_TOKEN` and JSON body `{"message":"..."}`.

## Development (optional)

Local dev:

```bash
docker compose up
```

To seed a demo event in dev:

```bash
docker compose exec app npm run seed
```

`seed` prints dev admin/manager credentials (for `/admin/login` and `/manager/login`) to stdout.

Database backup / recovery helpers:

- Create JSON backup (timestamped under `./backups`): `npm run db:backup:json`
- Restore from JSON backup (destructive, requires confirmation): `npm run db:restore:json -- --file ./backups/<file>.json`
- Initialize DB with recovery choice:
  - interactive: `npm run db:init`
  - non-interactive empty init: `npm run db:init -- --mode empty`
  - non-interactive restore: `npm run db:init -- --mode restore --file ./backups/<file>.json --yes`

Testing:

- Run integration tests with Docker: `npm run test:db`
- Cleanup test containers/volumes: `npm run test:db:clean`

## Known Security Debt

As of April 18, 2026, `npm audit` reports vulnerabilities that currently only resolve via `npm audit fix --force` and require breaking dependency upgrades.

Current decision:
- Defer those forced upgrades for now because the immediate regression risk is higher than the current risk profile for this stage of the project.
- Revisit when feature work is stabilized and security-only upgrades can be isolated and validated more clearly.

Reassessment trigger:
- Re-run `npm audit` regularly and prioritize this work if severity increases, exploitability changes, or release timing allows focused regression testing.

Postgres is not exposed on a host port by default; to connect from your machine, use:

```bash
docker compose exec db psql -U localshifts localshifts
```
