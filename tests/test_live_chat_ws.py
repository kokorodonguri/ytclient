"""ライブチャット WebSocket。

pytchat には触らない。infrastructure.live_chat を差し替えて、境界
（Origin 検査・post-accept 認証・接続レート・ルーム上限・fan-out）だけを見る。
"""

import importlib

import pytest
from starlette.websockets import WebSocketDisconnect

VIDEO_ID = "dQw4w9WgXcQ"
OTHER_VIDEO_ID = "aBcDeFgHiJk"
MESSAGE = {
    "author": "viewer",
    "text": "こんにちは",
    "author_thumbnail": "https://example.invalid/a.png",
    "timestamp": "2026-01-01T00:00:00Z",
}


class FakeChat:
    def __init__(self, video_id):
        self.video_id = video_id
        self.batches = [[MESSAGE]]
        self.alive = True
        self.terminated = False


@pytest.fixture
def chat_client(make_client, monkeypatch):
    """live_chat を差し替えた TestClient と、生成呼び出しの記録を返す。"""

    def factory(**env):
        client = make_client(**env)
        live_chat = importlib.import_module("infrastructure.live_chat")
        hub_module = importlib.import_module("application.live_chat_hub")
        created = []

        def create_chat(video_id):
            chat = FakeChat(video_id)
            created.append(chat)
            return chat

        def poll_messages(chat):
            if chat.batches:
                return chat.batches.pop(0)
            # これ以上流すものが無いので配信終了として扱う
            chat.alive = False
            return []

        def terminate(chat):
            chat.terminated = True

        monkeypatch.setattr(live_chat, "create_chat", create_chat)
        monkeypatch.setattr(live_chat, "poll_messages", poll_messages)
        monkeypatch.setattr(live_chat, "is_alive", lambda chat: chat.alive)
        monkeypatch.setattr(live_chat, "terminate", terminate)
        # 既定の 1.5 秒待ちをテストで待たない
        monkeypatch.setattr(hub_module, "POLL_INTERVAL_SECONDS", 0.01)
        return client, created

    return factory


def _close_code(client, path, send=None, **kwargs):
    """接続が拒否されたときのクローズコードを返す。

    accept() より前に閉じるとハンドシェイク自体が失敗して
    WebSocketDisconnect になり、accept() 後に閉じると close が通常の
    メッセージとして届く。呼び出し側がその差を気にしないよう吸収する。
    """
    try:
        with client.websocket_connect(path, **kwargs) as socket:
            if send is not None:
                if isinstance(send, str):
                    socket.send_text(send)
                else:
                    socket.send_json(send)
            message = socket.receive()
            if message.get("type") == "websocket.close":
                return message.get("code")
            return None
    except WebSocketDisconnect as disconnect:
        return disconnect.code


def test_delivers_a_chat_message(chat_client):
    client, _ = chat_client()
    with client.websocket_connect(f"/api/v1/ws/live-chat/{VIDEO_ID}") as socket:
        assert socket.receive_json() == MESSAGE


def test_legacy_path_still_works(chat_client):
    client, _ = chat_client()
    with client.websocket_connect(f"/ws/live-chat/{VIDEO_ID}") as socket:
        assert socket.receive_json() == MESSAGE


def test_rejects_a_malformed_video_id(chat_client):
    client, _ = chat_client()
    assert _close_code(client, "/api/v1/ws/live-chat/short") == 1008


def test_rejects_a_disallowed_origin(chat_client):
    client, _ = chat_client()
    code = _close_code(
        client,
        f"/api/v1/ws/live-chat/{VIDEO_ID}",
        headers={"Origin": "https://evil.example"},
    )
    assert code == 1008


def test_allows_the_capacitor_origin(chat_client):
    client, _ = chat_client()
    with client.websocket_connect(
        f"/api/v1/ws/live-chat/{VIDEO_ID}", headers={"Origin": "capacitor://localhost"}
    ) as socket:
        assert socket.receive_json() == MESSAGE


def test_needs_no_auth_message_when_no_key_is_configured(chat_client):
    """公開運用の既定。認証メッセージを送らずに繋がること。"""
    client, _ = chat_client()
    with client.websocket_connect(f"/api/v1/ws/live-chat/{VIDEO_ID}") as socket:
        assert socket.receive_json() == MESSAGE


def test_accepts_a_valid_auth_message_when_keyed(chat_client, api_key):
    client, _ = chat_client(VSPO_API_KEY=api_key)
    with client.websocket_connect(f"/api/v1/ws/live-chat/{VIDEO_ID}") as socket:
        socket.send_json({"type": "auth", "api_key": api_key})
        assert socket.receive_json() == MESSAGE


def test_rejects_a_wrong_key(chat_client, api_key):
    client, _ = chat_client(VSPO_API_KEY=api_key)
    code = _close_code(
        client,
        f"/api/v1/ws/live-chat/{VIDEO_ID}",
        send={"type": "auth", "api_key": "wrong" * 10},
    )
    assert code == 1008


def test_rejects_a_malformed_auth_message(chat_client, api_key):
    client, _ = chat_client(VSPO_API_KEY=api_key)
    code = _close_code(
        client, f"/api/v1/ws/live-chat/{VIDEO_ID}", send="not json at all"
    )
    assert code == 1008


def test_rejects_a_non_ascii_key_with_1008_not_1011(chat_client, api_key):
    """compare_digest の TypeError が 1011 になっていた経路。"""
    client, _ = chat_client(VSPO_API_KEY=api_key)
    code = _close_code(
        client,
        f"/api/v1/ws/live-chat/{VIDEO_ID}",
        send={"type": "auth", "api_key": "é" * 48},
    )
    assert code == 1008


def test_rejects_a_non_string_key_with_1008(chat_client, api_key):
    client, _ = chat_client(VSPO_API_KEY=api_key)
    code = _close_code(
        client,
        f"/api/v1/ws/live-chat/{VIDEO_ID}",
        send={"type": "auth", "api_key": 12345},
    )
    assert code == 1008


def test_auth_timeout_closes_the_socket(chat_client, api_key, monkeypatch):
    """認証メッセージを送らないまま放置した接続を閉じること。"""
    client, _ = chat_client(VSPO_API_KEY=api_key)
    ws_routes = importlib.import_module("interfaces.ws_routes")
    monkeypatch.setattr(ws_routes, "WS_AUTH_TIMEOUT_SECONDS", 0.05)

    assert _close_code(client, f"/api/v1/ws/live-chat/{VIDEO_ID}") == 1008


def test_connection_attempts_are_rate_limited(chat_client):
    client, _ = chat_client(VSPO_WS_CONNECTIONS_PER_MIN=1)
    with client.websocket_connect(f"/api/v1/ws/live-chat/{VIDEO_ID}") as socket:
        socket.receive_json()
    assert _close_code(client, f"/api/v1/ws/live-chat/{OTHER_VIDEO_ID}") == 1013


def test_the_global_room_cap_is_enforced(chat_client):
    client, _ = chat_client(VSPO_WS_MAX_ROOMS=1)
    with client.websocket_connect(f"/api/v1/ws/live-chat/{VIDEO_ID}") as first:
        first.receive_json()
        assert _close_code(client, f"/api/v1/ws/live-chat/{OTHER_VIDEO_ID}") == 1013


def test_the_per_client_room_cap_is_enforced(chat_client):
    """これが無いと 1 人が別々の動画IDで全枠を占有できる。"""
    client, _ = chat_client(VSPO_WS_MAX_ROOMS=64, VSPO_WS_MAX_ROOMS_PER_CLIENT=1)
    with client.websocket_connect(f"/api/v1/ws/live-chat/{VIDEO_ID}") as first:
        first.receive_json()
        assert _close_code(client, f"/api/v1/ws/live-chat/{OTHER_VIDEO_ID}") == 1013


