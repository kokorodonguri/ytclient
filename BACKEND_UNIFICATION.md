# Backend unification plan

Two backend implementations exist in this repo and they are **not** currently
merged. This documents the concrete gap and the steps to close it, so the
next session doesn't have to re-derive it.

- `src/backend/main.py` — single file. What `npm start` / `npm run backend`
  actually run, and what `build:backend` (PyInstaller `--onefile`) packages
  into the shipped Electron/exe build.
- `backend/` — package (`domain/`, `application/`, `infrastructure/`,
  `interfaces/`). What is actually running in production at
  `youtube.dongurihub.com`, deployed via `backend/deploy/deploy-backend.sh` +
  systemd. Was undocumented and untracked until this session imported it.

Nothing ships to end users from `backend/` today, and production does not
run `src/backend/main.py`. They evolved independently after forking apart.

## Concrete differences to reconcile

**Config surface (env var names don't match — this is the main blocker):**

| Concern | `src/backend/main.py` | `backend/` (production) |
|---|---|---|
| Proxy trust | `VSPO_TRUST_PROXY_HEADER=1` (bool) | `VSPO_TRUST_CLOUDFLARE_HEADERS=1` + `VSPO_TRUSTED_PROXY_NETWORKS` (CIDR allowlist of the trusted peer, not just "trust or don't") |
| Comment rate limit | `VSPO_RATE_LIMIT_REQUESTS` / `VSPO_RATE_LIMIT_WINDOW` | `VSPO_RATE_LIMIT_PER_MIN` (window fixed at 60s) |
| Live chat cap | `VSPO_MAX_LIVE_CHAT` (global only) | `VSPO_WS_MAX_ROOMS` (global) + `VSPO_WS_MAX_ROOMS_PER_CLIENT` (per-client — prevents one client from occupying every room) |
| Extraction concurrency | separate `VSPO_COMMENTS_CONCURRENCY` / `VSPO_STREAM_CONCURRENCY` | one shared `VSPO_MAX_EXTRACTIONS` |
| New-video latency | only the 600s full refresh | separate ~60s RSS discovery loop (`VSPO_DISCOVERY_SECONDS`) merged into the feed between full refreshes |
| Feed durability | in-memory only; empty feed after a restart until the first refresh completes | persisted to `VSPO_FEED_CACHE_PATH`, served immediately on restart |
| Health | `/api/v1/health` only | adds `/api/v1/readiness` (feed-availability aware, used by `deploy/healthcheck.sh`) |

**Regressions to avoid if migrating wholesale:**

- `backend/interfaces/app.py` sets `allow_methods=["*"], allow_headers=["*"]`
  on CORS. `src/backend/main.py` allowlists `GET` and four specific headers.
  Don't adopt the wildcard — narrow `backend/`'s CORS to match what
  `src/backend/main.py` already does before cutover.
- `backend/` computes `is_members_only` per item and keeps the item in the
  feed; `src/backend/main.py` drops members-only items from the feed
  entirely (`MEMBER_ONLY_KEYWORDS` filter in `_extract_video_item`). The
  frontend (`grid.js`, `player.js`) has no code path for `is_members_only`
  today — decide the intended behavior before switching, or members-only
  videos will silently start appearing with no client-side handling.
- `package.json`'s `build:backend` runs
  `PyInstaller --onefile ... src/backend/main.py`. `backend/` is a multi-module
  package; a naive `--onefile main.py` run from within `backend/` needs the
  sibling packages (`domain/`, `application/`, `infrastructure/`,
  `interfaces/`) discovered — verify with `--paths` / hidden-imports before
  assuming it PyInstalls cleanly, and diff the resulting exe's behavior
  against the current one.
- `config._resolve_frontend_dir()` in `backend/` special-cases
  `BASE_DIR.name == "backend" and BASE_DIR.parent.name == "src"` for dev-repo
  frontend discovery. That check is dead as long as `backend/` lives at the
  repo root rather than `src/backend/`; update it (or set
  `VSPO_FRONTEND_DIR` explicitly) if `backend/` becomes the dev-time backend.

## Suggested order of work (not started)

1. Pick one canonical env var naming scheme and update whichever side
   doesn't match (recommend keeping `backend/`'s names — they're more
   precise, e.g. per-client WS limits — and porting `src/backend/main.py`'s
   *values*/defaults onto them).
2. Decide the `is_members_only` behavior and make both sides agree.
3. Narrow `backend/`'s CORS to an explicit allowlist.
4. Point `build:backend` at `backend/main.py` and confirm the PyInstaller
   output actually boots (`./backend.exe 8010 127.0.0.1` + `curl .../health`).
5. Run the full functional smoke test already used for `src/backend/main.py`
   in this session's PR description against `backend/` too (auth, ETag/304,
   gzip+Vary, CORS allow/deny, rate limit 429, fail-closed public bind, WS
   auth accept/reject) before deleting `src/backend/main.py`.
6. Only then delete `src/backend/main.py` and repoint `npm start` / `npm run
   backend` / `npm run backend:lan` at `backend/main.py`.

Until step 6, treat both files as needing the same bug fixes applied twice
(see the pytchat `interruptable=False` and WebSocket-auth-via-message fixes
landed in `src/backend/main.py` this session — `backend/` already had both,
which is how the gap was noticed).
