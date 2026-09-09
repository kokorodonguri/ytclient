"""WebSocket ルート（ライブチャット配信）。"""

import asyncio
import json
import re
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from config import (
    ALLOWED_ORIGIN_REGEX,
    ALLOWED_ORIGINS,
    RATE_LIMIT_MAX_CLIENTS,
    RATE_LIMIT_WINDOW_SECONDS,
    WS_AUTH_TIMEOUT_SECONDS,
    WS_RATE_LIMIT_MAX_CONNECTIONS,
    logger,
)
from application.live_chat_hub import LiveChatHub, RoomCapacityError
from domain.video import is_valid_youtube_video_id
from infrastructure.rate_limiter import FixedWindowRateLimiter
from interfaces.client_identity import client_key
from interfaces.security import api_key_matches, is_auth_required

_connection_limiter = FixedWindowRateLimiter(
    max_requests=WS_RATE_LIMIT_MAX_CONNECTIONS,
    window_seconds=RATE_LIMIT_WINDOW_SECONDS,
    max_keys=RATE_LIMIT_MAX_CLIENTS,
)
_allowed_origin_pattern = (
    re.compile(ALLOWED_ORIGIN_REGEX) if ALLOWED_ORIGIN_REGEX else None
)


def _origin_is_allowed(origin: Optional[str]) -> bool:
    if not origin:
        # CLI 等の非ブラウザクライアントは Origin を送らない。API キー認証は必須。
        return True
    return origin in ALLOWED_ORIGINS or bool(
        _allowed_origin_pattern and _allowed_origin_pattern.fullmatch(origin)
    )


def _websocket_client_key(websocket: WebSocket) -> str:
    peer_host = websocket.client.host if websocket.client else None
    return client_key(websocket.headers, peer_host)


async def _authenticate(websocket: WebSocket) -> bool:
    """ハンドシェイク後の最初のメッセージで API キーを検証する。

    クエリパラメータ経由の認証は受け付けない（アクセスログに平文で残るため）。
    検証に失敗した場合はソケットを閉じて False を返す。
    """
    try:
        raw = await asyncio.wait_for(
            websocket.receive_text(), timeout=WS_AUTH_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError:
        await websocket.close(code=1008, reason="Authentication timeout")
        return False
    except WebSocketDisconnect:
        return False

    try:
        auth_msg = json.loads(raw)
    except ValueError:
        auth_msg = None

    if (
        not isinstance(auth_msg, dict)
        or auth_msg.get("type") != "auth"
        or not api_key_matches(auth_msg.get("api_key"))
    ):
        await websocket.close(code=1008, reason="Missing or invalid API key")
        return False

    return True


async def _wait_for_disconnect(websocket: WebSocket) -> None:
    """送信するチャットが無い間もクライアント切断を検知する。"""
    try:
        while True:
            event = await websocket.receive()
            if event.get("type") == "websocket.disconnect":
                return
    except WebSocketDisconnect:
        return


async def _stream_live_chat(
    hub: LiveChatHub, websocket: WebSocket, video_id: str
) -> None:
    if not is_valid_youtube_video_id(video_id):
        await websocket.close(code=1008, reason="Invalid YouTube video ID")
        return

    if not _origin_is_allowed(websocket.headers.get("origin")):
        await websocket.close(code=1008, reason="Origin not allowed")
        return

    client_key = _websocket_client_key(websocket)
    verdict = _connection_limiter.check(client_key)
    if not verdict.allowed:
        await websocket.close(code=1013, reason="Too many connection attempts")
        return

    await websocket.accept()

    if is_auth_required() and not await _authenticate(websocket):
        return

    # 実際の pytchat セッションはハブが動画単位で1本だけ持つ。
    # ここは配られてくるメッセージを自分のソケットへ流すだけ。
    try:
        queue = await hub.subscribe(video_id, client_key)
    except RoomCapacityError:
        # 1013 = Try Again Later。クライアントは再接続してよい
        await websocket.close(code=1013, reason="Too many live chat sessions")
        return
    disconnect_task = asyncio.create_task(_wait_for_disconnect(websocket))
    try:
        while True:
            message_task = asyncio.create_task(queue.get())
            done, _ = await asyncio.wait(
                {message_task, disconnect_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnect_task in done:
                message_task.cancel()
                await asyncio.gather(message_task, return_exceptions=True)
                await disconnect_task
                break

            message = message_task.result()
            if message is None:
                # 配信終了（ルームが閉じた）
                break
            await websocket.send_json(message)
    except WebSocketDisconnect:
        pass
    except Exception as error:
        logger.warning("Chat delivery error for %s: %s", video_id, error)
        try:
            await websocket.close()
        except RuntimeError:
            pass
    finally:
        if not disconnect_task.done():
            disconnect_task.cancel()
        await asyncio.gather(disconnect_task, return_exceptions=True)
        await hub.unsubscribe(video_id, queue, client_key)


def create_router(hub: LiveChatHub) -> APIRouter:
    router = APIRouter()

    @router.websocket("/api/v1/ws/live-chat/{video_id}")
    async def live_chat_ws_v1(websocket: WebSocket, video_id: str):
        await _stream_live_chat(hub, websocket, video_id)

    @router.websocket("/ws/live-chat/{video_id}")
    async def live_chat_ws(websocket: WebSocket, video_id: str):
        await _stream_live_chat(hub, websocket, video_id)

    return router
