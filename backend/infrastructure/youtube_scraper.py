"""yt_dlp を使った YouTube の取得。

yt_dlp への依存はこのモジュールに閉じる。呼び出し側は
「チャンネルのアイテム一覧」「検索結果」「動画詳細」という語彙だけを扱う。
"""

from typing import Any, NamedTuple

import yt_dlp

from config import (
    MAX_COMMENTS_LIMIT,
    UPSTREAM_RETRIES,
    UPSTREAM_SOCKET_TIMEOUT_SECONDS,
    logger,
)
from domain.video import build_video_item, safe_str

# 一覧取得用。extract_flat で 1 リクエストあたりの情報量を抑える
LIST_YDL_OPTS: dict[str, Any] = {
    "quiet": True,
    "extract_flat": "in_playlist",
    "skip_download": True,
    "noplaylist": True,
    "ignoreerrors": True,
    "playlistend": 100,
    "socket_timeout": UPSTREAM_SOCKET_TIMEOUT_SECONDS,
    "retries": UPSTREAM_RETRIES,
    "extractor_retries": UPSTREAM_RETRIES,
}

# 個別動画の詳細取得用（配信状態の確定に使う）
DETAIL_YDL_OPTS: dict[str, Any] = {
    "quiet": True,
    "skip_download": True,
    "ignoreerrors": True,
    "socket_timeout": UPSTREAM_SOCKET_TIMEOUT_SECONDS,
    "retries": UPSTREAM_RETRIES,
    "extractor_retries": UPSTREAM_RETRIES,
}

# コメント取得用。getcomments は非常に重い
COMMENTS_YDL_OPTS: dict[str, Any] = {
    "quiet": True,
    "skip_download": True,
    "getcomments": True,
    "ignoreerrors": False,
    "socket_timeout": UPSTREAM_SOCKET_TIMEOUT_SECONDS,
    "retries": UPSTREAM_RETRIES,
    "extractor_retries": UPSTREAM_RETRIES,
    "extractor_args": {
        "youtube": {
            "max_comments": [str(MAX_COMMENTS_LIMIT)],
        }
    },
}


class ChannelFetchResult(NamedTuple):
    """1 チャンネル分の取得結果。

    yt_dlp の失敗は例外ではなく空の結果として返るため、
    「取得できなかった」と「動画が 0 件だった」を呼び出し側が
    区別できるよう failed_tabs を明示的に返す。
    これを潰すと、YouTube にスロットルされたときに
    一部メンバーだけが表示される状態が無言で発生する。
    """

    items: list[dict[str, Any]]
    failed_tabs: int
    channel_id: str

    @property
    def is_complete_failure(self) -> bool:
        return self.failed_tabs == 2


class _YtDlpLogCapture:
    """タブ不存在と通信失敗を区別するための最小 yt-dlp logger。"""

    def __init__(self):
        self._messages: list[str] = []

    def debug(self, _message: str) -> None:
        pass

    def info(self, _message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        self._messages.append(safe_str(message))

    def error(self, message: str) -> None:
        self._messages.append(safe_str(message))

    def consume(self) -> list[str]:
        messages, self._messages = self._messages, []
        return messages


def _tab_is_expectedly_absent(messages: list[str], tab_name: str) -> bool:
    marker = f"this channel does not have a {tab_name} tab"
    return any(marker in message.lower() for message in messages)


def _extract_entries(ydl: "yt_dlp.YoutubeDL", url: str) -> dict[str, Any]:
    try:
        return ydl.extract_info(url, download=False) or {}
    except Exception as error:
        logger.warning("Failed to extract %s: %s", url, error)
        return {}


def fetch_channel_items(
    channel_url: str,
    published_timestamps: dict[str, float] | None = None,
) -> ChannelFetchResult:
    """チャンネルの streams / videos タブからアイテムを集める。"""
    items: list[dict[str, Any]] = []
    failed_tabs = 0
    channel_id = ""
    ydl_log = _YtDlpLogCapture()

    with yt_dlp.YoutubeDL({**LIST_YDL_OPTS, "logger": ydl_log}) as ydl:
        for tab_url in (f"{channel_url}/streams", f"{channel_url}/videos"):
            tab_name = "streams" if tab_url.endswith("/streams") else "videos"
            info = _extract_entries(ydl, tab_url)
            messages = ydl_log.consume()
            if not info:
                if _tab_is_expectedly_absent(messages, tab_name):
                    logger.info("Channel has no %s tab: %s", tab_name, channel_url)
                else:
                    failed_tabs += 1
                    for message in messages:
                        logger.warning("yt-dlp channel fetch: %s", message)
            if not channel_id:
                channel_id = safe_str(
                    info.get("channel_id") or info.get("uploader_id")
                ).strip()
                if not channel_id:
                    for entry in info.get("entries", []):
                        channel_id = safe_str(
                            entry.get("channel_id") or entry.get("uploader_id")
                        ).strip()
                        if channel_id:
                            break
            from_streams_tab = tab_name == "streams"
            for entry in info.get("entries", []):
                item = build_video_item(
                    entry,
                    # title が無いチャンネルもある。None を渡すと
                    # fallback_uploader: str の契約を破る
                    safe_str(info.get("title")),
                    from_streams_tab=from_streams_tab,
                    published_timestamps=published_timestamps,
                )
                if item:
                    items.append(item)

    return ChannelFetchResult(
        items=items,
        failed_tabs=failed_tabs,
        channel_id=channel_id,
    )


def search_videos(query: str, limit: int = 30) -> list[dict[str, Any]]:
    """検索クエリからアイテムを集める（切り抜き用）。"""
    items: list[dict[str, Any]] = []
    with yt_dlp.YoutubeDL(LIST_YDL_OPTS) as ydl:
        info = _extract_entries(ydl, f"ytsearch{limit}:{query}")
        for entry in info.get("entries", []):
            item = build_video_item(entry)
            if item:
                items.append(item)
    return items


def fetch_video_detail(video_id: str) -> dict[str, Any]:
    """1 動画の詳細を取得する。失敗時は空 dict。"""
    cleaned_id = safe_str(video_id).strip()
    if not cleaned_id:
        return {}
    with yt_dlp.YoutubeDL(DETAIL_YDL_OPTS) as ydl:
        detail = _extract_entries(ydl, f"https://www.youtube.com/watch?v={cleaned_id}")
    if not detail:
        return {}
    return {"id": cleaned_id, **detail}


def fetch_video_comments(video_id: str) -> dict[str, Any]:
    """コメントと概要欄を含む生の情報を返す。整形は呼び出し側の責務。"""
    with yt_dlp.YoutubeDL(COMMENTS_YDL_OPTS) as ydl:
        return (
            ydl.extract_info(
                f"https://www.youtube.com/watch?v={video_id}",
                download=False,
            )
            or {}
        )


# 再生用ストリームの解決用。ignoreerrors は立てず、失敗は例外で受ける。
# ただし ignore_no_formats_error は立てる: 配信予定の動画は「フォーマットが
# 無い」だけで、上流障害ではない。例外にすると 502 になり、クライアントが
# 「まだ始まっていない」と「取得に失敗した」を区別できなくなる。
STREAM_YDL_OPTS: dict[str, Any] = {
    "quiet": True,
    "skip_download": True,
    "ignore_no_formats_error": True,
    "socket_timeout": UPSTREAM_SOCKET_TIMEOUT_SECONDS,
    "retries": UPSTREAM_RETRIES,
    "extractor_retries": UPSTREAM_RETRIES,
}


def fetch_video_stream_info(video_id: str) -> dict[str, Any]:
    """再生用フォーマットを含む生の情報を返す。選択は呼び出し側の責務。"""
    cleaned_id = safe_str(video_id).strip()
    if not cleaned_id:
        return {}
    with yt_dlp.YoutubeDL(STREAM_YDL_OPTS) as ydl:
        return (
            ydl.extract_info(
                f"https://www.youtube.com/watch?v={cleaned_id}",
                download=False,
            )
            or {}
        )
