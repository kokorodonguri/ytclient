#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if [ ! -d ".venv-prod" ]; then
  python3 -m venv .venv-prod
fi

. .venv-prod/bin/activate
python -m pip install -r requirements.txt
# ループバックに縛る。LAN へ公開する場合は VSPO_API_KEY を設定した上で
# 引数を 0.0.0.0 に変えること（キー未設定では起動を拒否する）。
exec python main.py 8010 127.0.0.1
