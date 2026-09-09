#!/usr/bin/env sh
set -eu

BASE_URL="${1:-http://127.0.0.1:8010}"
API_KEY="${VSPO_API_KEY:-}"
CHECK_PATH="/api/v1/health"
if [ -n "$API_KEY" ]; then
  CHECK_PATH="/api/v1/readiness"
fi

if command -v curl >/dev/null 2>&1; then
  if [ -n "$API_KEY" ]; then
    curl -fsS -H "X-API-Key: $API_KEY" "$BASE_URL$CHECK_PATH" >/dev/null
  else
    curl -fsS "$BASE_URL$CHECK_PATH" >/dev/null
  fi
else
  python3 - "$BASE_URL" "$CHECK_PATH" "$API_KEY" <<'PY'
import json
import sys
import urllib.request

base_url = sys.argv[1].rstrip("/")
check_path = sys.argv[2]
api_key = sys.argv[3]
headers = {"X-API-Key": api_key} if api_key else {}
request = urllib.request.Request(f"{base_url}{check_path}", headers=headers)
with urllib.request.urlopen(request, timeout=5) as response:
    payload = json.loads(response.read().decode("utf-8"))
if payload.get("status") not in {"success", "ready", "degraded"}:
    raise SystemExit("health endpoint did not return an available status")
PY
fi

echo "healthy: $BASE_URL"
