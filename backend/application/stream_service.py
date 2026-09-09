"""配信ストリーム解決のユースケース。

アプリ内でのネイティブ再生に使う URL を返す。

  配信中 : HLS のマスタープレイリスト (画質は再生側の ABR に任せる)
  それ以外: 映像のみ + 音声のみ の組 (最大 1080p)。再生側が 2 要素を同期させる。
            取れない場合の保険として結合済みフォーマット (通常 360p) も返す。

YouTube は結合済みの高画質フォーマットを出さないため、1080p を出すには
映像と音声を別々に取るしかない。ここではその選択だけを行い、同期の実装は
クライアントの責務とする。

コメント取得と同じく 1 リクエストあたり yt-dlp のフル抽出が走るため、
短命キャッシュと同時実行制御をここで持つ。HTTP への翻訳はしない。
"""

import threading
from typing import Any, Dict, List, Optional

from config import (
    MAX_CONCURRENT_EXTRACTIONS,
    STREAM_CACHE_MAX_ENTRIES,
    STREAM_CACHE_TTL_SECONDS,
    logger,
)
from application.comments_service import ServiceBusyError, UpstreamFetchError
from domain.video import safe_str
from infrastructure.rate_limiter import TTLCache
from infrastructure.youtube_scraper import fetch_video_stream_info

# 1080p を超える映像は帯域とデコード負荷に見合わないので選ばない
MAX_VIDEO_HEIGHT = 1080


class NotLiveError(Exception):
    """配信中ではない（現在は VOD も扱うため通常は送出しない）。"""


class UpcomingStreamError(Exception):
    """開始前の配信。まだ再生できるものが存在しない。"""


class NoStreamError(Exception):
    """再生できるストリームが見つからない。"""


def _http_formats(info: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [
        fmt
        for fmt in (info.get("formats") or [])
        if fmt.get("url") and (fmt.get("protocol") or "") == "https"
    ]


def _pick_hls_source(info: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """配信中の HLS を選ぶ。

    マスタープレイリストがあればそれを返し、画質の選択は再生側の ABR に任せる。
    無い場合だけ、最も高い解像度のバリアントを直接返す。
    """
    hls_formats = [
        fmt
        for fmt in (info.get("formats") or [])
        if "m3u8" in (fmt.get("protocol") or "") and fmt.get("url")
    ]
    if not hls_formats:
        return None

    best = max(hls_formats, key=lambda fmt: fmt.get("height") or 0)
    master = info.get("manifest_url") or best.get("manifest_url")
    if master:
        return {"url": master, "height": None}
    return {"url": best["url"], "height": best.get("height")}


def _pick_video_only(formats: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    # 音声トラックを持たない mp4 (H.264) のみ。webm/VP9 は音声との組で
    # コンテナが混ざると扱いが面倒なため避ける。
    candidates = [
        fmt
        for fmt in formats
        if fmt.get("acodec") == "none"
        and fmt.get("vcodec") not in (None, "none")
        and fmt.get("ext") == "mp4"
        and (fmt.get("height") or 0) <= MAX_VIDEO_HEIGHT
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda f: ((f.get("height") or 0), (f.get("tbr") or 0)))


def _pick_audio_only(formats: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    candidates = [
        fmt
        for fmt in formats
        if fmt.get("vcodec") == "none"
        and fmt.get("acodec") not in (None, "none")
        and fmt.get("ext") == "m4a"
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda f: (f.get("abr") or 0))


def _pick_progressive(formats: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    candidates = [
        fmt
        for fmt in formats
        if fmt.get("acodec") not in (None, "none")
        and fmt.get("vcodec") not in (None, "none")
        and fmt.get("ext") == "mp4"
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda f: (f.get("height") or 0))


class StreamService:
    def __init__(self):
        self._cache = TTLCache(
            ttl_seconds=STREAM_CACHE_TTL_SECONDS,
            max_entries=STREAM_CACHE_MAX_ENTRIES,
        )
        self._semaphore = threading.BoundedSemaphore(MAX_CONCURRENT_EXTRACTIONS)

    def get_stream(self, video_id: str) -> Dict[str, Any]:
        cached = self._cache.get(video_id)
        if cached is not None:
            return cached

        # 抽出の完了を待たせない。待機側が sync エンドポイント用スレッドプールを
        # 占有すると /feed や /health まで巻き添えで止まる。
        if not self._semaphore.acquire(blocking=False):
            raise ServiceBusyError("Server busy, please retry shortly")

        try:
            try:
                info = fetch_video_stream_info(video_id)
            except Exception as error:
                logger.warning("Failed to resolve stream for %s: %s", video_id, error)
                raise UpstreamFetchError("Failed to resolve stream") from error

            if not info:
                raise UpstreamFetchError("Failed to resolve stream")

            # 開始前の配信は「取得失敗」ではない。待機所しか無いので
            # 再生させず、その旨をクライアントへ伝える
            if info.get("live_status") == "is_upcoming" or info.get("is_upcoming"):
                raise UpcomingStreamError("Stream has not started yet")

            if info.get("is_live"):
                source = _pick_hls_source(info)
                if not source:
                    raise NoStreamError("No playable stream found")
                data = {
                    "video_id": video_id,
                    "is_live": True,
                    "protocol": "hls",
                    "url": source["url"],
                    "audio_url": None,
                    "progressive_url": None,
                    "height": source["height"],
                    "title": safe_str(info.get("title")),
                }
            else:
                formats = _http_formats(info)
                video = _pick_video_only(formats)
                audio = _pick_audio_only(formats)
                progressive = _pick_progressive(formats)

                if video and audio:
                    data = {
                        "video_id": video_id,
                        "is_live": False,
                        "protocol": "split",
                        "url": video["url"],
                        "audio_url": audio["url"],
                        "progressive_url": progressive["url"] if progressive else None,
                        "height": video.get("height"),
                        "title": safe_str(info.get("title")),
                    }
                elif progressive:
                    data = {
                        "video_id": video_id,
                        "is_live": False,
                        "protocol": "progressive",
                        "url": progressive["url"],
                        "audio_url": None,
                        "progressive_url": progressive["url"],
                        "height": progressive.get("height"),
                        "title": safe_str(info.get("title")),
                    }
                else:
                    raise NoStreamError("No playable stream found")

            payload = {"status": "success", "data": data}
            self._cache.put(video_id, payload)
            return payload
        finally:
            self._semaphore.release()
