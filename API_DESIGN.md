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
- `WS /api/v1/ws/live-chat/{video_id}` via `?api_key=<VSPO_API_KEY>`

Public routes:

- `GET /`
- `GET /api/v1/health`

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

## Operational Notes

- The backend owns YouTube scraping and exposes only cached feed data to clients.
- Feed refresh is asynchronous; clients should tolerate `is_building: true`.
- The Windows exe should use the local packaged backend.
- APK and standalone frontend can target the LAN backend.
