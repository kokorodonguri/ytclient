"""コメント取得のユースケース。

1 リクエストあたり yt-dlp のフル抽出（getcomments）を走らせるため、
数秒の CPU と外向き通信を消費する。素の状態では
  - キャッシュが無いので同じ動画でも毎回取りに行く
  - 上限が無いので同時接続を増やすだけで sync エンドポイント用スレッドプールを
    食い潰し、/health まで巻き添えで応答しなくなる
  - 実質 YouTube スクレイピングの踏み台として使える
という状態になるため、TTL キャッシュと同時実行制御をここで持つ。

HTTP のステータスコードには翻訳しない（interfaces 層の責務）。
呼び出し側は例外の型で分岐する。
"""

import threading
from typing import Any

from config import (
    COMMENTS_CACHE_MAX_ENTRIES,
    COMMENTS_CACHE_TTL_SECONDS,
    COMMENTS_SINGLEFLIGHT_WAIT_SECONDS,
    DEFAULT_AVATAR_URL,
    MAX_COMMENTS_LIMIT,
    MAX_CONCURRENT_EXTRACTIONS,
    logger,
)
from domain.video import safe_str
from infrastructure.rate_limiter import TTLCache
from infrastructure.youtube_scraper import fetch_video_comments


class ServiceBusyError(Exception):
    """同時実行の上限に達していて、いま処理を受けられない。"""


class UpstreamFetchError(Exception):
    """YouTube 側からの取得に失敗した。"""


class CommentsService:
    def __init__(self):
        self._cache = TTLCache(
            ttl_seconds=COMMENTS_CACHE_TTL_SECONDS,
            max_entries=COMMENTS_CACHE_MAX_ENTRIES,
        )
        self._semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_EXTRACTIONS)
        # 同じ動画への同時キャッシュミスを1回の抽出へ集約する。
        # 動画IDごとの無制限なロック辞書はDoS対象になるため固定ストライプを使う。
        self._singleflight_locks = tuple(threading.Lock() for _ in range(32))

    def get_comments(self, video_id: str, limit: int) -> dict[str, Any]:
        bounded_limit = max(0, min(limit, MAX_COMMENTS_LIMIT))
        cached = self._cache.get(video_id)
        if cached is not None:
            return self._limit_payload(cached, bounded_limit)

        lock = self._singleflight_locks[hash(video_id) % len(self._singleflight_locks)]
        # 抽出の完了までは待たない。先行リクエストが数秒かかる間、待機側が
        # sync エンドポイント用スレッドプールを占有すると /feed や /health まで
        # 巻き添えで止まる。短く待って取れなければ 503 を返す。
        if not lock.acquire(timeout=COMMENTS_SINGLEFLIGHT_WAIT_SECONDS):
            raise ServiceBusyError("Server busy, please retry shortly")
        try:
            # ロック待ちの間に同じ動画がキャッシュされた可能性がある。
            cached = self._cache.get(video_id)
            if cached is not None:
                return self._limit_payload(cached, bounded_limit)

            # 同時抽出数を絞る。取得できなければ待たずに諦め、
            # sync エンドポイント用スレッドプールを埋めてしまうのを避ける。
            if not self._semaphore.acquire(blocking=False):
                raise ServiceBusyError("Server busy, please retry shortly")

            try:
                info = fetch_video_comments(video_id)
                payload = {
                    "status": "success",
                    "video_id": video_id,
                    # yt-dlp は limit に関係なくコメントを取得するため、動画単位で
                    # 最大件数を1回だけキャッシュし、レスポンス時に切り出す。
                    "results": self._format_comments(
                        info.get("comments", []), MAX_COMMENTS_LIMIT
                    ),
                    "description": safe_str(info.get("description")),
                }
                self._cache.put(video_id, payload)
                return self._limit_payload(payload, bounded_limit)
            except Exception as error:
                logger.warning("Failed to fetch comments for %s: %s", video_id, error)
                raise UpstreamFetchError("Failed to fetch YouTube comments") from error
            finally:
                self._semaphore.release()
        finally:
            lock.release()

    @staticmethod
    def _limit_payload(payload: dict[str, Any], limit: int) -> dict[str, Any]:
        return {
            **payload,
            # スライスがコピーを作るので list() で二重に複製しない
            "results": payload.get("results", [])[:limit],
        }

    @staticmethod
    def _format_comments(raw_comments, limit: int):
        if not isinstance(raw_comments, list):
            return []
        return [
            {
                "author": safe_str(c.get("author"), "名無し"),
                "text": safe_str(c.get("text")),
                "author_thumbnail": safe_str(c.get("author_thumbnail"))
                or DEFAULT_AVATAR_URL,
            }
            for c in raw_comments[:limit]
        ]
