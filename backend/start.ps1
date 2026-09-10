$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath ".venv-prod")) {
  python -m venv .venv-prod
}

& ".\.venv-prod\Scripts\Activate.ps1"
python -m pip install -r requirements.txt
# ループバックに縛る。LAN へ公開する場合は VSPO_API_KEY を設定した上で
# 引数を 0.0.0.0 に変えること（キー未設定では起動を拒否する）。
python main.py 8010 127.0.0.1
