#!/usr/bin/env sh
set -eu

APP_DIR="${APP_DIR:-/home/donguri0423/yt-backend}"
SERVICE_NAME="${SERVICE_NAME:-vspo-backend.service}"
ENV_FILE="${ENV_FILE:-/etc/vspo-backend.env}"

cd "$APP_DIR"

# バックエンドはパッケージ構成。main.py だけを更新すると
# import 時に落ちるため、必要な層が揃っているかをここで確認する。
for required_file in main.py config.py requirements.txt; do
  if [ ! -f "$required_file" ]; then
    echo "$required_file was not found in $APP_DIR" >&2
    echo "Copy the whole directory, not just main.py." >&2
    exit 1
  fi
done

for required_dir in domain application infrastructure interfaces; do
  if [ ! -f "$required_dir/__init__.py" ]; then
    echo "Package '$required_dir' is missing or incomplete in $APP_DIR" >&2
    echo "Copy the whole directory, not just main.py." >&2
    exit 1
  fi
done

if [ ! -d ".venv-prod" ]; then
  python3 -m venv .venv-prod
fi

. .venv-prod/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

# 起動前に import が通ることを確かめる。ここで落とせば
# systemctl restart 後にクラッシュループして初めて気づく事態を避けられる。
if ! python -c "import main" >/dev/null 2>&1; then
  echo "Failed to import the backend package. Deployment aborted." >&2
  python -c "import main"
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  generated_api_key="$(python -c 'import secrets; print(secrets.token_hex(32))')"
  temporary_env="$(mktemp)"
  trap 'rm -f "$temporary_env"' EXIT HUP INT TERM
  sed "s|^VSPO_API_KEY=.*|VSPO_API_KEY=$generated_api_key|" \
    deploy/vspo-backend.env.example >"$temporary_env"
  install -m 600 "$temporary_env" "$ENV_FILE"
  rm -f "$temporary_env"
  trap - EXIT HUP INT TERM
  echo "Created $ENV_FILE with a random API key."
fi

python - "$ENV_FILE" <<'PY'
import sys

env_path = sys.argv[1]
api_key = ""
with open(env_path, encoding="utf-8") as env_file:
    for raw_line in env_file:
        line = raw_line.strip()
        if line.startswith("VSPO_API_KEY="):
            api_key = line.split("=", 1)[1].strip().strip("\"'")
            break

weak = {"change-me", "changeme", "replace-me", "secret", "password"}
if not 32 <= len(api_key) <= 512 or api_key.lower() in weak:
    raise SystemExit(
        f"{env_path}: VSPO_API_KEY must be a random 32-512 character value"
    )
PY

install -m 644 deploy/vspo-backend.service "/etc/systemd/system/$SERVICE_NAME"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager
