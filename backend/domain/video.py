"""動画エンティティの正規化。

yt_dlp が返す雑多な dict を、アプリ内で扱う 1 つの形に落とす純粋関数群。
ここには I/O を持ち込まない（yt_dlp の呼び出しは infrastructure 層の責務）。
"""

from datetime import datetime
from typing import Any, Dict, Optional

from config import (
    MEMBER_ONLY_KEYWORDS,
    YOUTUBE_CHANNEL_ID_PATTERN,
    YOUTUBE_VIDEO_ID_PATTERN,
    YT_THUMBNAIL_TEMPLATE,
)


def safe_str(value: Any, default: str = "") -> str:
    return str(value) if value is not None else default


def is_valid_youtube_video_id(video_id: Any) -> bool:
    return isinstance(video_id, str) and bool(
        YOUTUBE_VIDEO_ID_PATTERN.fullmatch(video_id)
    )


def extract_channel_id(channel_url: str) -> str:
    match = YOUTUBE_CHANNEL_ID_PATTERN.fullmatch(channel_url)
    return match.group("channel_id") if match else ""


def is_valid_youtube_channel_id(channel_id: Any) -> bool:
    return isinstance(channel_id, str) and bool(
        YOUTUBE_CHANNEL_ID_PATTERN.fullmatch(channel_id)
    )


def _resolve_timestamp(
    entry: Dict[str, Any],
    video_id: str,
    published_timestamps: Optional[Dict[str, float]],
) -> float:
    """公開時刻を決める。

    yt_dlp の extract_flat では時刻が落ちることが多いため、
    release_timestamp → timestamp → RSS 由来 → upload_date の順に拾う。
    どれも無ければ 0.0（＝並び順の情報を持たない）。
    """
    raw_ts = entry.get("release_timestamp") or entry.get("timestamp")
    if not raw_ts and published_timestamps:
        raw_ts = published_timestamps.get(video_id)
    if not raw_ts:
        upload_date = safe_str(entry.get("upload_date"))
        if upload_date and len(upload_date) == 8 and upload_date.isdigit():
            try:
                raw_ts = datetime.strptime(upload_date, "%Y%m%d").timestamp()
            except ValueError:
                raw_ts = 0
        else:
            raw_ts = 0
    return float(raw_ts) if raw_ts else 0.0


def _live_flags(live_status: str, from_streams_tab: bool) -> Dict[str, bool]:
    return {
        "is_live": live_status == "is_live",
        "is_upcoming": live_status == "is_upcoming",
        "is_live_archive": live_status == "was_live"
        or (from_streams_tab and live_status not in {"is_live", "is_upcoming"}),
    }


def is_members_only(entry: Dict[str, Any], title: str) -> bool:
    """メンバーシップ限定かどうか。

    availability が正本だが、extract_flat の一覧では欠けることがある。
    その場合の保険としてタイトルの慣用表記も見る。
    """
    if safe_str(entry.get("availability")).lower() == "subscriber_only":
        return True
    return any(keyword in title for keyword in MEMBER_ONLY_KEYWORDS)


def build_video_item(
    entry: Dict[str, Any],
    fallback_uploader: str = "",
    from_streams_tab: bool = False,
    published_timestamps: Optional[Dict[str, float]] = None,
) -> Optional[Dict[str, Any]]:
    """yt_dlp のエントリを 1 件の動画アイテムに変換する。

    メンバーシップ限定のものも除外せず is_members_only を立てて返す。
    加入者にとっては視聴できる動画であり、フィードから消してしまうと
    そもそも存在に気づけない。埋め込みプレイヤーでは再生できないため、
    クライアント側で YouTube アプリへ渡す導線に切り替える。
    """
    video_id = safe_str(entry.get("id")).strip()
    if not video_id or not is_valid_youtube_video_id(video_id):
        return None

    title = safe_str(entry.get("title")).strip() or "タイトル不明"

    live_status = safe_str(entry.get("live_status")).lower()
    uploader = (
        safe_str(entry.get("channel")).strip()
        or safe_str(entry.get("uploader")).strip()
        or fallback_uploader
    )

    return {
        "title": title,
        "video_id": video_id,
        "uploader": uploader or "不明なチャンネル",
        "thumbnail": YT_THUMBNAIL_TEMPLATE.format(video_id=video_id),
        **_live_flags(live_status, from_streams_tab),
        "is_members_only": is_members_only(entry, title),
        "from_streams_tab": from_streams_tab,
        "timestamp": _resolve_timestamp(entry, video_id, published_timestamps),
    }


def apply_video_detail(
    item: Dict[str, Any],
    detail: Dict[str, Any],
) -> Dict[str, Any]:
    """個別取得した詳細で配信状態と公開時刻を上書きした新しいアイテムを返す。"""
    live_status = safe_str(detail.get("live_status")).lower()
    refined = {
        **item,
        **_live_flags(live_status, bool(item.get("from_streams_tab"))),
    }
    if detail.get("release_timestamp"):
        refined["timestamp"] = float(detail["release_timestamp"])
    return refined
