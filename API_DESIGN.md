# VSPO Client API Design

## Goals

- Provide a stable production API for the Electron client, Android WebView client, and optional LAN clients.
- Keep legacy routes working while introducing versioned REST routes.
- Fail closed when authentication is configured, but allow local/offline packaged use without extra setup.
- Return consistent JSON error envelopes for API clients.

## Base URL

- Windows packaged app: `http://127.0.0.1:8010`
- LAN/API server deployment: `http://192.168.1.33:8010`

## Versioning

All production API routes live under `/api/v1`.

Legacy routes remain as compatibility aliases:

- `GET /api/feed` -> `GET /api/v1/feed`
- `GET /comments?video_id=...` -> `GET /api/v1/videos/{video_id}/comments`
- `WS /ws/live-chat/{video_id}` -> `WS /api/v1/ws/live-chat/{video_id}`

## Authentication

Authentication is optional by default for local packaged use.

When `VSPO_API_KEY` is set, protected API routes require one of:

- `Authorization: Bearer <VSPO_API_KEY>`
- `X-API-Key: <VSPO_API_KEY>`

Protected routes:

- `GET /api/v1/feed`
- `GET /api/v1/videos/{video_id}/comments`
- `GET /api/v1/videos/{video_id}/stream`
- `WS /api/v1/ws/live-chat/{video_id}` — see below

Public routes:

- `GET /`
- `GET /api/v1/health`

**WebSocket auth.** Browsers cannot set custom headers on a WS handshake, and
a query-string key would land in any reverse proxy's or tunnel's access logs
that record full request URLs. Instead, the server accepts the handshake and
then waits up to 5 seconds for a single text frame:

```json
{ "type": "auth", "api_key": "<VSPO_API_KEY>" }
```

An invalid key, malformed message, or timeout closes the socket with code
`1008` before any chat data is sent. No key ever appears in the connection
URL or in `VSPO_API_KEY`-bearing proxy/tunnel access logs.

## REST Endpoints

### `GET /api/v1/health`

Returns API identity and runtime status.

Response:

```json
{
  "status": "success",
  "service": "vspo-client-api",
  "version": "3.2.0",
  "message": "VSPO Client API is running perfectly!"
}
```

### `GET /api/v1/feed`

Returns the current cached feed snapshot.

Response:

```json
{
  "status": "success",
  "data": {
    "official": [],
    "clips": [],
    "is_building": false,
    "last_updated": "2026-06-25T12:00:00",
    "last_error": null
  }
}
```

### `GET /api/v1/videos/{video_id}/comments`

Returns video description and up to `limit` comments.

Validation:

- `video_id`: YouTube video ID, `^[A-Za-z0-9_-]{11}$`
- `limit`: integer from `0` to `100`, default `20`

Response:

```json
{
  "status": "success",
  "video_id": "abcdefghijk",
  "results": [],
  "description": ""
}
```

### `GET /api/v1/videos/{video_id}/stream`

Resolves a playable source for the video: an HLS manifest URL for live
streams, or separate video/audio (or progressive) URLs for VODs. Backed by a
short-lived cache (`VSPO_STREAM_CACHE_TTL`, default 60s) since resolved URLs
expire.

Validation:

- `video_id`: YouTube video ID, `^[A-Za-z0-9_-]{11}$`

Response:

```json
{
  "status": "success",
  "data": {
    "video_id": "abcdefghijk",
    "is_live": true,
    "protocol": "hls",
    "url": "https://...",
    "audio_url": null,
    "progressive_url": null,
    "height": null,
    "title": "..."
  }
}
```

Errors: `409` if the stream has not started yet (`X-Stream-State: upcoming`),
`404` if no playable source is found, `502` if resolution fails upstream.

### `WS /api/v1/ws/live-chat/{video_id}`

Streams live chat messages as JSON.

Validation:

- `video_id`: YouTube video ID, `^[A-Za-z0-9_-]{11}$`

Message:

```json
{
  "author": "name",
  "text": "message",
  "author_thumbnail": "https://...",
  "timestamp": "2026-06-25T12:00:00Z"
}
```

## Error Envelope

All HTTP API errors return:

```json
{
  "status": "error",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": {},
    "request_id": "uuid"
  }
}
```

Standard codes:

- `UNAUTHORIZED`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `UPSTREAM_ERROR`
- `INTERNAL_ERROR`

## Configuration

All settings are environment variables read at startup.

| Variable | Default | Purpose |
| --- | --- | --- |
| `VSPO_API_KEY` | *(empty)* | Enables authentication. Required for any non-loopback bind. |
| `VSPO_ALLOWED_ORIGINS` | `null,http://127.0.0.1:8010,http://localhost:8010` | Comma-separated CORS allowlist. |
| `VSPO_TRUST_PROXY_HEADER` | `0` | Set to `1` only when the origin is reachable exclusively through a trusted proxy/tunnel. Makes rate limiting use `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For`. |
| `VSPO_COMMENTS_CONCURRENCY` | `4` | Max simultaneous comment scrapes. |
| `VSPO_COMMENTS_CACHE_TTL` | `300` | Comment cache lifetime in seconds; `0` disables. |
| `VSPO_STREAM_CONCURRENCY` | `4` | Max simultaneous stream-URL resolutions. |
| `VSPO_STREAM_CACHE_TTL` | `60` | Resolved stream URL cache lifetime in seconds; `0` disables. |
| `VSPO_MAX_LIVE_CHAT` | `16` | Max concurrent live-chat WebSockets. |
| `VSPO_RATE_LIMIT_REQUESTS` | `30` | Comment/stream requests allowed per window, per client. |
| `VSPO_RATE_LIMIT_WINDOW` | `60` | Rate limit window in seconds. |
| `VSPO_SERVE_FRONTEND` | *(unset)* | Set to `1` to serve `/app` even when a key is configured. |
| `VSPO_ALLOW_INSECURE_BIND` | *(unset)* | Set to `1` to permit a public bind with no key. Not recommended. |

Binding defaults to `127.0.0.1`. A non-loopback bind without `VSPO_API_KEY`
exits with an error unless `VSPO_ALLOW_INSECURE_BIND=1`.

`/app` is not mounted when `VSPO_API_KEY` is set, because static files cannot
carry the auth dependency.

## Operational Notes

- The backend owns YouTube scraping and exposes only cached feed data to clients.
- Feed refresh is asynchronous; clients should tolerate `is_building: true`.
- The Windows exe should use the local packaged backend.
- APK and standalone frontend can target the LAN backend.
