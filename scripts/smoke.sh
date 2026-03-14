#!/bin/sh
set -eu

BASE_URL="${BASE_URL:-${1:-}}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
EMAIL_TO="${EMAIL_TO:-}"

usage() {
  cat <<'EOF'
Usage:
  BASE_URL=https://www.trtechapp.com ADMIN_TOKEN=... sh scripts/smoke.sh

Optional:
  EMAIL_TO=you@domain.com   # if set, sends an /ops/email/test

Or pass BASE_URL as the first argument:
  sh scripts/smoke.sh https://www.trtechapp.com
EOF
}

if [ -z "$BASE_URL" ]; then
  usage
  exit 2
fi

fail=0

say() { printf '%s\n' "$*"; }

http_get() {
  url="$1"
  curl -fsS --max-time 10 -H 'accept: application/json' "$url"
}

http_status_html() {
  url="$1"
  curl -sS --max-time 10 -H 'accept: text/html' -o /dev/null -w '%{http_code}' "$url" || printf '000'
}

http_post_json() {
  url="$1"
  json="$2"
  curl -fsS --max-time 15 \
    -H 'content-type: application/json' \
    -d "$json" \
    "$url"
}

check_healthz() {
  say "[1/6] GET /healthz"
  body="$(http_get "$BASE_URL/healthz" || true)"
  if printf '%s' "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    say "  OK"
  else
    say "  FAIL: unexpected response"
    printf '%s\n' "$body" | sed -n '1,5p'
    fail=1
  fi
}

check_ops_health() {
  say "[2/6] GET /ops/health"
  if [ -z "$ADMIN_TOKEN" ]; then
    say "  SKIP: ADMIN_TOKEN not set"
    return 0
  fi

  body="$(curl -fsS --max-time 10 -H "x-admin-token: $ADMIN_TOKEN" "$BASE_URL/ops/health" || true)"
  if printf '%s' "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    say "  OK"
  else
    say "  FAIL: unexpected response"
    printf '%s\n' "$body" | sed -n '1,5p'
    fail=1
  fi
}

check_ops_templates() {
  say "[3/6] GET /ops/templates/compile"
  if [ -z "$ADMIN_TOKEN" ]; then
    say "  SKIP: ADMIN_TOKEN not set"
    return 0
  fi

  body="$(curl -fsS --max-time 15 -H "x-admin-token: $ADMIN_TOKEN" "$BASE_URL/ops/templates/compile" || true)"
  if printf '%s' "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    say "  OK"
  else
    say "  FAIL: unexpected response"
    printf '%s\n' "$body" | sed -n '1,10p'
    fail=1
  fi
}

check_public_pages() {
  say "[4/6] GET / (HTML)"
  code="$(http_status_html "$BASE_URL/" || true)"
  if [ "$code" = "200" ]; then
    say "  OK"
  else
    say "  FAIL: HTTP $code"
    curl -sS --max-time 10 -H 'accept: text/html' "$BASE_URL/" 2>/dev/null | sed -n '1,5p' || true
    fail=1
  fi

  say "[5/6] GET /admin/login (HTML)"
  code="$(http_status_html "$BASE_URL/admin/login" || true)"
  if [ "$code" = "200" ] || [ "$code" = "303" ]; then
    say "  OK"
  else
    say "  FAIL: HTTP $code"
    curl -sS --max-time 10 -H 'accept: text/html' "$BASE_URL/admin/login" 2>/dev/null | sed -n '1,5p' || true
    fail=1
  fi
}

check_email_test() {
  say "[6/6] POST /ops/email/test"
  if [ -z "$ADMIN_TOKEN" ]; then
    say "  SKIP: ADMIN_TOKEN not set"
    return 0
  fi
  if [ -z "$EMAIL_TO" ]; then
    say "  SKIP: EMAIL_TO not set"
    return 0
  fi

  payload="$(printf '{"to":"%s","subject":"VolunteerFlow staging smoke test","text":"Smoke test at %s"}' \
    "$EMAIL_TO" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')")"

  body="$(curl -fsS --max-time 15 -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d "$payload" "$BASE_URL/ops/email/test" || true)"
  if printf '%s' "$body" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    say "  OK"
  else
    say "  FAIL: unexpected response"
    printf '%s\n' "$body" | sed -n '1,5p'
    fail=1
  fi
}

check_healthz
check_ops_health
check_ops_templates
check_public_pages
check_email_test

if [ "$fail" -ne 0 ]; then
  say "Smoke test: FAIL"
  exit 1
fi

say "Smoke test: OK"
