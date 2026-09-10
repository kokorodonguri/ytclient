"""FastAPI の依存関係。

アプリ内の概念（レート超過・不正な動画 ID）を HTTP のステータスコードへ
翻訳する境界。下位層は HTTPException を知らない。
"""

from typing import Optional

from fastapi import Header, HTTPException, Request

from config import (
    FEED_RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_MAX_CLIENTS,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_WINDOW_SECONDS,
)
from domain.video import is_valid_youtube_video_id
from infrastructure.rate_limiter import FixedWindowRateLimiter
from interfaces.client_identity import client_key
from interfaces.security import api_key_matches, is_auth_required

# 抽出系（yt-dlp を起動するコメント・ストリーム解決）と、フィード配信を
# 別バケットにする。共有すると、is_building 中 5 秒間隔のフィードポーリング
# だけで毎分 12 回を消費し、同じ枠を使うコメント取得が誤爆する。
_extraction_rate_limiter = FixedWindowRateLimiter(
    max_requests=RATE_LIMIT_MAX_REQUESTS,
    window_seconds=RATE_LIMIT_WINDOW_SECONDS,
    max_keys=RATE_LIMIT_MAX_CLIENTS,
)
_feed_rate_limiter = FixedWindowRateLimiter(
    max_requests=FEED_RATE_LIMIT_MAX_REQUESTS,
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


def _enforce(limiter: FixedWindowRateLimiter, request: Request) -> None:
    verdict = limiter.check(_client_key(request))
    if not verdict.allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many requests",
            headers={"Retry-After": str(verdict.retry_after_seconds)},
        )


def enforce_rate_limit(request: Request) -> None:
    """抽出系エンドポイント（コメント・ストリーム解決）の上限。"""
    _enforce(_extraction_rate_limiter, request)


def enforce_feed_rate_limit(request: Request) -> None:
    """フィード配信の上限。

    読み取りAPIを公開で運用するため、キー認証の有無に関わらずここで絞る。
    以前はキーで守られている前提でフィードに上限が無かった。
    """
    _enforce(_feed_rate_limiter, request)


def validate_video_id(video_id: str) -> str:
    if not is_valid_youtube_video_id(video_id):
        raise HTTPException(status_code=400, detail="Invalid YouTube video ID")
    return video_id
