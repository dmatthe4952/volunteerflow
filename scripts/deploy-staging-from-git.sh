#!/bin/sh
set -eu

ENV_FILE="${ENV_FILE:-.env.staging}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
SERVICE="${SERVICE:-app}"

GIT_REMOTE_NAME="${GIT_REMOTE_NAME:-origin}"
GIT_REMOTE_URL="${GIT_REMOTE_URL:-}" # e.g. https://github.com/dmatthe4952/localshifts.git
GIT_BRANCH="${GIT_BRANCH:-}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE"
  exit 2
fi

if [ -n "$GIT_REMOTE_URL" ]; then
  current_url="$(git remote get-url "$GIT_REMOTE_NAME" 2>/dev/null || true)"
  if [ -z "$current_url" ]; then
    git remote add "$GIT_REMOTE_NAME" "$GIT_REMOTE_URL"
  elif [ "$current_url" != "$GIT_REMOTE_URL" ]; then
    git remote set-url "$GIT_REMOTE_NAME" "$GIT_REMOTE_URL"
  fi
fi

if [ -z "$GIT_BRANCH" ]; then
  GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi

before_sha="$(git rev-parse --short HEAD)"

echo "[1/4] git pull ($GIT_REMOTE_NAME/$GIT_BRANCH)"
git pull --ff-only "$GIT_REMOTE_NAME" "$GIT_BRANCH"

after_sha="$(git rev-parse --short HEAD)"
echo "  Deployed ref: $before_sha -> $after_sha"

echo "[2/4] Build+up (staging)"
sh scripts/deploy-staging.sh

BASE_URL="${BASE_URL:-}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"

if [ -z "$BASE_URL" ]; then
  BASE_URL="$(grep -E '^APP_URL=' "$ENV_FILE" | tail -n 1 | sed 's/^APP_URL=//' | tr -d '\r' || true)"
fi
if [ -z "$ADMIN_TOKEN" ]; then
  ADMIN_TOKEN="$(grep -E '^ADMIN_TOKEN=' "$ENV_FILE" | tail -n 1 | sed 's/^ADMIN_TOKEN=//' | tr -d '\r' || true)"
fi

echo "[3/4] Smoke test"
BASE_URL="$BASE_URL" ADMIN_TOKEN="$ADMIN_TOKEN" sh scripts/smoke.sh

echo "[4/4] Done ($after_sha)"
