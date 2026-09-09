# yt-backend

VSPO Client backend deploy folder.

## Quick Start

```bash
cd /home/donguri0423/yt-backend
python3 -m venv .venv-prod
. .venv-prod/bin/activate
python -m pip install -r requirements.txt
python main.py 8010 127.0.0.1
```

Production uses Cloudflare Tunnel to reach the loopback-only service.

## Production Service

```bash
sudo ./deploy/deploy-backend.sh
systemctl status vspo-backend.service --no-pager
./deploy/healthcheck.sh http://127.0.0.1:8010
```

Runtime settings live in `/etc/vspo-backend.env`.

```bash
VSPO_API_KEY=<32-512 character random value>
VSPO_DISCOVERY_SECONDS=60
VSPO_REFRESH_SECONDS=600
```

If `VSPO_API_KEY` is set, enter the same key in the client settings screen.
