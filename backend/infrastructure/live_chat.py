"""pytchat を使ったライブチャット取得。

pytchat への依存はこのモジュールに閉じる。呼び出し側は
「チャットを開く / 次のメッセージを取る / 閉じる」だけを扱う。
"""

from typing import Any

import pytchat

from config import DEFAULT_AVATAR_URL


def create_chat(video_id: str) -> Any:
    """チャットセッションを開く（ブロッキング。threadpool 経由で呼ぶこと）。

    interruptable=False が必須。既定の True だと pytchat が SIGINT ハンドラを
    登録しようとするが、signal.signal() はメインスレッドでしか呼べないため
    「signal only works in main thread of the main interpreter」で必ず失敗する。
    ここは threadpool 上で動くので、既定のままではライブチャットが一度も
    繋がらない。
    """
    return pytchat.create(video_id=video_id, interruptable=False)


def poll_messages(chat: Any) -> list[dict[str, Any]]:
    """溜まっているメッセージを配信用の形に整えて返す。

    ブロッキング呼び出しなので threadpool 経由で使う。
    """
    if not chat.is_alive():
        return []
    return [
        {
            "author": item.author.name,
            "text": item.message,
            "author_thumbnail": item.author.imageUrl or DEFAULT_AVATAR_URL,
            "timestamp": item.datetime,
        }
        for item in chat.get().sync_items()
    ]


def is_alive(chat: Any) -> bool:
    return bool(chat.is_alive())


def terminate(chat: Any) -> None:
    chat.terminate()
