"""フィードの並び順と重複排除のルール。

表示順は「クライアントと完全に一致していること」が要件なので、
規則をこの 1 ファイルに閉じ込めて意図をコメントで残す。
"""

from typing import Any


def sort_feed_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """timestamp の新しい順。クライアント側 sortVideos と同一の規則にする。

    ここに live 優先などの追加規則を入れてはならない。
    切り抜き（ytsearch 由来）は timestamp が全件 0 になるため、
    クライアントの安定ソートが実質 no-op となり、サーバの並びが
    そのまま表示順になる。live 優先で並べると配信中の動画が
    切り抜きタブの先頭に居座ってしまう（実際に退行させた）。
    """
    return sorted(
        items,
        key=lambda item: float(item.get("timestamp") or 0.0),
        reverse=True,
    )


def dedupe_by_video_id(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """同一動画の重複を先勝ちで除去する（順序は保持）。"""
    seen = set()
    unique = []
    for item in items:
        vid = item.get("video_id")
        if vid and vid not in seen:
            seen.add(vid)
            unique.append(item)
    return unique


def normalize_feed(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """配信用に整えたリストを返す（重複排除 → 並び替え）。"""
    return sort_feed_items(dedupe_by_video_id(items))
