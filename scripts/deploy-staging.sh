#!/bin/sh
set -eu

ENV_FILE="${ENV_FILE:-.env.staging}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
SERVICE="${SERVICE:-app}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE"
  exit 2
fi

echo "[1/2] Build image (runs template compile check)"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build "$SERVICE"

echo "[2/2] Start/recreate service"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build "$SERVICE"

echo "Staging deploy: OK"

