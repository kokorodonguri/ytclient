"""FastAPI の依存関係。

アプリ内の概念（レート超過・不正な動画 ID）を HTTP のステータスコードへ
翻訳する境界。下位層は HTTPException を知らない。
"""

from typing import Optional

from fastapi import Header, HTTPException, Request

from config import (
    RATE_LIMIT_MAX_CLIENTS,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_WINDOW_SECONDS,
)
from domain.video import is_valid_youtube_video_id
from infrastructure.rate_limiter import FixedWindowRateLimiter
from interfaces.client_identity import client_key
from interfaces.security import api_key_matches, is_auth_required

_rate_limiter = FixedWindowRateLimiter(
    max_requests=RATE_LIMIT_MAX_REQUESTS,
    window_seconds=RATE_LIMIT_WINDOW_SECONDS,
    max_keys=RATE_LIMIT_MAX_CLIENTS,
)


def require_api_key(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
) -> None:
    if not is_auth_required():
        return

    bearer_prefix = "Bearer "
    bearer_token = (
        authorization[len(bearer_prefix) :].strip()
        if authorization and authorization.startswith(bearer_prefix)
        else ""
    )
    if api_key_matches(x_api_key) or api_key_matches(bearer_token):
        return
    raise HTTPException(status_code=401, detail="Missing or invalid API key")


def _client_key(request: Request) -> str:
    """検証済みのプロキシヘッダー、またはTCPピアからキーを作る。"""
    peer_host = request.client.host if request.client else None
    return client_key(request.headers, peer_host)


def enforce_rate_limit(request: Request) -> None:
    verdict = _rate_limiter.check(_client_key(request))
    if not verdict.allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many requests",
            headers={"Retry-After": str(verdict.retry_after_seconds)},
        )


def validate_video_id(video_id: str) -> str:
    if not is_valid_youtube_video_id(video_id):
        raise HTTPException(status_code=400, detail="Invalid YouTube video ID")
    return video_id
