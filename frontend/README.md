# frontend

VSPO Client frontend deploy folder.

This folder is copied from `src/frontend`.

## Local Preview

```powershell
.\start.ps1
```

or on Linux/macOS:

```bash
sh start.sh
```

Then open:

```text
http://127.0.0.1:8080/index.html?apiBaseUrl=http://192.168.1.33:8010
```

The Electron app still uses `src/frontend` during development and packaging.
