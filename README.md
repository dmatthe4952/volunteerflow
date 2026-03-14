# VolunteerFlow

Node + Fastify + Nunjucks + Postgres implementation per `VolunteerFlow_PRD_v1.0.md`.

Operator runbook: `OPERATORS_MANUAL.md`

## Staging / production

VolunteerFlow is intended to be run via Docker Compose on a server (staging and above). The app runs DB migrations automatically on startup.

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

Testing:

- Run integration tests with Docker: `npm run test:db`
- Cleanup test containers/volumes: `npm run test:db:clean`

Postgres is not exposed on a host port by default; to connect from your machine, use:

```bash
docker compose exec db psql -U volunteerflow volunteerflow
```
