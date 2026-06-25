# yt-backend

VSPO Client backend deploy folder.

## Setup

```bash
cd /home/donguri0423/yt-backend
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python main.py
```

The default server address is `0.0.0.0:8010`, so other PCs on the LAN can connect to `http://192.168.1.33:8010`.

## Custom Port

```bash
python main.py 8010 0.0.0.0
```
