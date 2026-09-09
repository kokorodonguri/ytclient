$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath ".venv-prod")) {
  python -m venv .venv-prod
}

& ".\.venv-prod\Scripts\Activate.ps1"
python -m pip install -r requirements.txt
python main.py 8010 0.0.0.0
