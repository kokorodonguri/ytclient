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

# 読み取り API は公開で運用する（配信内容は全て公開 YouTube 情報）。
# 初期配置では VSPO_API_KEY を空のままにし、濫用対策はレート制限に任せる。
# キーを設定するのは、Cloudflare Tunnel を挟まず LAN へ直接公開する場合など。
if [ ! -f "$ENV_FILE" ]; then
  install -m 600 deploy/vspo-backend.env.example "$ENV_FILE"
  echo "Created $ENV_FILE (VSPO_API_KEY is empty: public read-only API)."
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

# 空は「公開読み取り API」を意味する正当な設定なので許す。ただし
# 設定されている場合は、弱い値や短い値をそのまま本番へ通さない。
if not api_key:
    print(f"{env_path}: VSPO_API_KEY is empty (public read-only API).")
    raise SystemExit(0)

weak = {"change-me", "changeme", "replace-me", "secret", "password"}
if not 32 <= len(api_key) <= 512 or api_key.lower() in weak:
    raise SystemExit(
        f"{env_path}: VSPO_API_KEY is set but weak. Use a random 32-512 "
        "character value, or leave it empty for a public read-only API."
    )
PY

install -m 644 deploy/vspo-backend.service "/etc/systemd/system/$SERVICE_NAME"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager
