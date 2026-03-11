# VolunteerFlow

Node + Fastify + Nunjucks + Postgres implementation per `VolunteerFlow_PRD_v1.0.md`.

## Local dev

```bash
docker compose up
```

Open `http://localhost:3000/`.

Operator guide: `OPERATORS_MANUAL.md`
App logs are written to `logs/app.log` (local dev compose).

Note: `node_modules` is kept inside the container (not bind-mounted) to avoid host/container permission and platform issues.
If you previously ran `docker compose up` before this change, your `node_modules/` or `package-lock.json` may be owned by root; fix with:

```bash
sudo chown -R "$(id -u)":"$(id -g)" node_modules package-lock.json
```

To seed a demo event in dev:

```bash
docker compose exec app npm run seed
```

`seed` prints dev admin/manager credentials (for `/admin/login` and `/manager/login`) to stdout.

Volunteer self-service:

- `http://localhost:3000/my` lets a volunteer request an email link to view their upcoming signups (SMTP integration TBD; dev shows a shortcut link).

Admin/Manager:

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

Testing:

- Run integration tests with Docker: `docker compose -f docker-compose.test.yml up --build --abort-on-container-exit`
- If you previously ran the test stack with a persistent Postgres volume, run `docker compose -f docker-compose.test.yml down -v` once to clear stale data.

Postgres is not exposed on a host port by default; to connect from your machine, use:

```bash
docker compose exec db psql -U volunteerflow volunteerflow
```

## Staging/prod (with Caddy/TLS)

```bash
docker compose -f docker-compose.staging.yml up --build
```
# volunteerflow
