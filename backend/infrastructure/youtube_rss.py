"""YouTube のチャンネル RSS から公開時刻を補う。

yt_dlp の extract_flat は投稿日時を落とすことが多いため、
軽量な RSS を併用して timestamp を埋める。
"""

import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Any

from config import (
    UPSTREAM_SOCKET_TIMEOUT_SECONDS,
    YOUTUBE_FEED_URL_TEMPLATE,
    logger,
)
from domain.video import build_video_item, is_valid_youtube_channel_id

_NAMESPACES = {
    "atom": "http://www.w3.org/2005/Atom",
    "yt": "http://www.youtube.com/xml/schemas/2015",
}
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def _load_recent_entries(channel_id: str) -> list[dict[str, Any]]:
    """RSSエントリをアプリ内で扱いやすい最小形式へ変換する。"""
    if not is_valid_youtube_channel_id(channel_id):
        logger.warning("RSS discovery ignored invalid channel ID")
        return []

    feed_url = YOUTUBE_FEED_URL_TEMPLATE.format(channel_id=channel_id)
    try:
        with urllib.request.urlopen(
            feed_url, timeout=UPSTREAM_SOCKET_TIMEOUT_SECONDS
        ) as response:
            # YouTube RSS は小さい。上限を設け、異常な応答でメモリを使い切らない。
            body = response.read(_MAX_RESPONSE_BYTES + 1)
            if len(body) > _MAX_RESPONSE_BYTES:
                raise ValueError("YouTube RSS response exceeded 2 MiB")
            root = ET.fromstring(body)
    except Exception as error:
        logger.warning("Failed to load channel feed %s: %s", channel_id, error)
        return []

    fallback_uploader = root.findtext(
        "atom:author/atom:name", default="", namespaces=_NAMESPACES
    )
    entries: list[dict[str, Any]] = []
    for entry in root.findall("atom:entry", _NAMESPACES):
        video_id = entry.findtext("yt:videoId", default="", namespaces=_NAMESPACES)
        title = entry.findtext("atom:title", default="", namespaces=_NAMESPACES)
        uploader = entry.findtext(
            "atom:author/atom:name", default="", namespaces=_NAMESPACES
        )
        published = entry.findtext("atom:published", default="", namespaces=_NAMESPACES)
        if not video_id or not published:
            continue
        try:
            timestamp = datetime.fromisoformat(
                published.replace("Z", "+00:00")
            ).timestamp()
        except ValueError:
            continue
        entries.append(
            {
                "id": video_id,
                "title": title,
                "channel": uploader or fallback_uploader,
                "timestamp": timestamp,
            }
        )
    return entries


def load_recent_video_items(channel_id: str) -> list[dict[str, Any]]:
    """RSSから直近の公開動画を正規化して返す。失敗時は空リスト。"""
    items = []
    for entry in _load_recent_entries(channel_id):
        item = build_video_item(entry)
        if item:
            items.append(item)
    return items


def load_recent_published_timestamps(channel_id: str) -> dict[str, float]:
    """video_id -> 公開時刻(epoch秒) の辞書を返す。失敗時は空 dict。"""
    return {
        str(entry["id"]): float(entry["timestamp"])
        for entry in _load_recent_entries(channel_id)
    }
