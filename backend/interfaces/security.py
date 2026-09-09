"""API キーの検証。

HTTP ヘッダ経由と WebSocket のハンドシェイクメッセージ経由の両方から
使うため、比較そのものを 1 箇所に置く。
"""

import secrets
from typing import Optional

from config import API_KEY, MAX_API_KEY_LENGTH


def api_key_matches(candidate: Optional[str]) -> bool:
    """API キーを定数時間で比較する。

    `==` は最初に不一致となったバイトで早期終了するため、応答時間の差から
    キーを 1 バイトずつ絞り込める。ネットワーク越しではノイズに埋もれがちだが、
    LAN 内やローカルループバックでは十分に観測可能な差になる。
    """
    if (
        not isinstance(candidate, str)
        or not candidate
        or len(candidate) > MAX_API_KEY_LENGTH
    ):
        return False
    return secrets.compare_digest(candidate, API_KEY)


def is_auth_required() -> bool:
    return bool(API_KEY)
