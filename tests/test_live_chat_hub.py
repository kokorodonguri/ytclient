"""ライブチャットの fan-out。

視聴者ごとに pytchat セッションを張ると、YouTube への接続数が視聴者数に
比例してスロットルされ、全員のチャットが止まる。「動画1本につき1セッション」
という不変条件をここで固定する。

WebSocket 越しではなくハブを直接叩く。TestClient の WebSocket セッションを
入れ子にすると終了処理が互いに競合するため、多人数の検証には向かない。
"""

import asyncio
import importlib

import pytest

VIDEO_ID = "dQw4w9WgXcQ"
OTHER_VIDEO_ID = "aBcDeFgHiJk"
MESSAGE = {"author": "viewer", "text": "hello"}


class FakeChat:
    def __init__(self, video_id):
        self.video_id = video_id
        self.batches = [[MESSAGE]]
        self.alive = True
        self.terminated = False


@pytest.fixture
def hub_factory(build_app, monkeypatch):
    """live_chat を差し替えたハブと、生成されたセッションの記録を返す。"""

    def factory(**env):
        build_app(**env)
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
            return []

        monkeypatch.setattr(live_chat, "create_chat", create_chat)
        monkeypatch.setattr(live_chat, "poll_messages", poll_messages)
        monkeypatch.setattr(live_chat, "is_alive", lambda chat: chat.alive)
        monkeypatch.setattr(
            live_chat, "terminate", lambda chat: setattr(chat, "terminated", True)
        )
        monkeypatch.setattr(hub_module, "POLL_INTERVAL_SECONDS", 0.01)
        return hub_module, created

    return factory


def test_many_viewers_share_one_youtube_session(hub_factory):
    hub_module, created = hub_factory()

    async def scenario():
        hub = hub_module.LiveChatHub()
        queues = [
            await hub.subscribe(VIDEO_ID, f"client-{index}") for index in range(5)
        ]
        received = [
            await asyncio.wait_for(queue.get(), timeout=3) for queue in queues
        ]
        for index, queue in enumerate(queues):
            await hub.unsubscribe(VIDEO_ID, queue, f"client-{index}")
        return received

    received = asyncio.run(scenario())
    assert len(created) == 1, "視聴者ごとにセッションを張ってしまっている"
    assert received == [MESSAGE] * 5


def test_the_session_is_terminated_when_the_last_viewer_leaves(hub_factory):
    hub_module, created = hub_factory()

    async def scenario():
        hub = hub_module.LiveChatHub()
        first = await hub.subscribe(VIDEO_ID, "client-a")
        second = await hub.subscribe(VIDEO_ID, "client-b")
        # セッションの生成は _run_room タスクの中で起きる。1 通受け取れた時点で
        # 生成済みが確実になる。
        await asyncio.wait_for(first.get(), timeout=3)
        await hub.unsubscribe(VIDEO_ID, first, "client-a")
        # まだ 1 人残っているので閉じない
        assert not created[0].terminated
        await hub.unsubscribe(VIDEO_ID, second, "client-b")

    asyncio.run(scenario())
    assert created[0].terminated


def test_the_global_room_cap_refuses_a_new_video(hub_factory):
    hub_module, _ = hub_factory(VSPO_WS_MAX_ROOMS=1)

    async def scenario():
        hub = hub_module.LiveChatHub()
        await hub.subscribe(VIDEO_ID, "client-a")
        with pytest.raises(hub_module.RoomCapacityError):
            await hub.subscribe(OTHER_VIDEO_ID, "client-a")

    asyncio.run(scenario())


def test_the_global_room_cap_still_allows_sharing(hub_factory):
    """相乗りを拒否すると、人気配信に 2 人目が入れなくなってしまう。"""
    hub_module, created = hub_factory(VSPO_WS_MAX_ROOMS=1)

    async def scenario():
        hub = hub_module.LiveChatHub()
        await hub.subscribe(VIDEO_ID, "client-a")
        await hub.subscribe(VIDEO_ID, "client-b")

    asyncio.run(scenario())
    assert len(created) == 1


def test_the_per_client_cap_stops_one_client_taking_every_room(hub_factory):
    """これが無いと 1 人が別々の動画IDで全枠を占有し、他の視聴者を止められる。"""
    hub_module, _ = hub_factory(VSPO_WS_MAX_ROOMS=64, VSPO_WS_MAX_ROOMS_PER_CLIENT=2)

    async def scenario():
        hub = hub_module.LiveChatHub()
        await hub.subscribe("aaaaaaaaaaa", "greedy")
        await hub.subscribe("bbbbbbbbbbb", "greedy")
        with pytest.raises(hub_module.RoomCapacityError):
            await hub.subscribe("ccccccccccc", "greedy")
        # 別のクライアントは自分の枠を持っているので影響を受けない
        await hub.subscribe("ccccccccccc", "polite")

    asyncio.run(scenario())


def test_leaving_a_room_returns_the_per_client_slot(hub_factory):
    hub_module, _ = hub_factory(VSPO_WS_MAX_ROOMS_PER_CLIENT=1)

    async def scenario():
        hub = hub_module.LiveChatHub()
        queue = await hub.subscribe(VIDEO_ID, "client-a")
        await hub.unsubscribe(VIDEO_ID, queue, "client-a")
        # 枠が返っているので別の動画を開ける
        await hub.subscribe(OTHER_VIDEO_ID, "client-a")

    asyncio.run(scenario())


def test_a_slow_subscriber_does_not_block_the_others(hub_factory):
    """キューが溢れたら古いものを捨てる。詰まらせない。"""
    hub_module, _ = hub_factory()

    async def scenario():
        hub = hub_module.LiveChatHub()
        room = hub_module._Room(VIDEO_ID)
        queue = asyncio.Queue(maxsize=2)
        room.subscribers.add(queue)

        for index in range(10):
            hub._broadcast(room, {"text": f"message-{index}"})

        drained = []
        while not queue.empty():
            drained.append(queue.get_nowait())
        return drained

    drained = asyncio.run(scenario())
    assert len(drained) == 2
    # 最新が残っていること（古いものから捨てる）
    assert drained[-1]["text"] == "message-9"


def test_shutdown_closes_every_room(hub_factory):
    hub_module, created = hub_factory()

    async def scenario():
        hub = hub_module.LiveChatHub()
        await hub.subscribe("aaaaaaaaaaa", "client-a")
        await hub.subscribe("bbbbbbbbbbb", "client-b")
        await hub.shutdown()

    asyncio.run(scenario())
    assert len(created) == 2
    assert all(chat.terminated for chat in created)
