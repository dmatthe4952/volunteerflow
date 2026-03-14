# Systemd (staging)

This is an optional way to ensure the VolunteerFlow Docker Compose stack starts on boot.

## Prerequisites

- Docker Engine installed and working (`docker info` succeeds).
- Docker Compose v2 available as `docker compose`.
- The `WorkingDirectory` you choose contains:
  - `docker-compose.staging.yml`
  - `.env.staging`

## Install

1. Copy the unit file:
   - `sudo cp deploy/systemd/volunteerflow.service /etc/systemd/system/volunteerflow.service`
2. Edit `/etc/systemd/system/volunteerflow.service` and set:
   - `WorkingDirectory=` to the folder containing `docker-compose.staging.yml` and `.env.staging`
3. Enable + start:
   - `sudo systemctl daemon-reload`
   - `sudo systemctl enable --now volunteerflow`

Notes:
- Some servers won’t have a `docker.service` unit name (snap installs, custom setups). The unit waits for `docker info` to succeed instead of depending on a specific service name.

## Recommended deploy flow (before enabling systemd)

From the repo root on the server:

1. Deploy/update:
   - `sh scripts/deploy-staging.sh`
   - Or (git pull + deploy + smoke test): `sh scripts/deploy-staging-from-git.sh`
2. Smoke test:
   - `BASE_URL="$(grep -E '^APP_URL=' .env.staging | tail -n 1 | sed 's/^APP_URL=//')" sh scripts/smoke.sh`

## Operate

- Status: `sudo systemctl status volunteerflow`
- Logs: `sudo journalctl -u volunteerflow -f`
- Restart: `sudo systemctl restart volunteerflow`

## Troubleshooting

- Deploy comes up but wrong port binding: ensure you start compose with `--env-file .env.staging` (Compose reads port mappings before containers start).
- Emails not sending: confirm `SMTP_HOST` and `SMTP_FROM_EMAIL` are set in `.env.staging` (and your network/provider allows outbound SMTP or you’re using a relay).
- App unhealthy: check `logs/app.log`, then verify required env vars in `.env.staging` (`APP_URL`, `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_TOKEN`).
