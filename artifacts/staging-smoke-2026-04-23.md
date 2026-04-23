# Staging Smoke Evidence — 2026-04-23

## Scope
- Environment: `https://www.trtechapp.com`
- Script: `scripts/smoke.sh`
- Run date (UTC): 2026-04-23

## Command
```bash
BASE_URL=https://www.trtechapp.com sh scripts/smoke.sh > artifacts/staging-smoke-2026-04-23.txt
```

## Result
- Overall status: **FAIL**
- Passed checks:
  - `GET /healthz` (`{"ok":true}`)
  - `GET /` (HTTP 200)
  - `GET /login` (HTTP 200)
- Skipped checks (missing admin token in shell env):
  - `GET /ops/health`
  - `GET /ops/templates/compile`
  - `POST /ops/email/test`
- Blocking check:
  - `GET /admin/login` expected 404 (legacy surface removed) but got **303**

## Blocking Evidence
`curl -sS -D - -o /tmp/staging_admin_login_body.html https://www.trtechapp.com/admin/login`

Observed response headers:

```text
HTTP/1.1 303 See Other
location: /login?role=admin
```

## Additional Captured Evidence
- Smoke log: `artifacts/staging-smoke-2026-04-23.txt`
- `/login` headers captured via curl: HTTP 200
- `/healthz` body captured via curl: `{"ok":true}`
- Local parity run: `BASE_URL=http://localhost:3000 sh scripts/smoke.sh` returned `Smoke test: OK` with `/admin/login` returning 404 as expected (`artifacts/local-smoke-2026-04-23.txt`).

## Follow-up Required
1. Confirm whether staging is intentionally allowing compatibility redirect from `/admin/login` to `/login?role=admin`.
2. If PRD/E1 requires route removal behavior (`404`), deploy route-removal change to staging and rerun smoke.
3. Export `ADMIN_TOKEN` on the staging shell and rerun smoke to complete ops-authenticated checks.
