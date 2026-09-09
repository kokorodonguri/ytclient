"""ライブチャットの fan-out。

同じ配信を N 人が見るとき、素直に実装すると WebSocket 接続ごとに
pytchat セッションが1本ずつ張られ、YouTube への接続数が視聴者数に比例する。
人数が増えるとスロットルされ、全員のチャットが止まる。

ここでは「動画1本につき pytchat 1本」に集約し、取得したメッセージを
購読者全員のキューへ配る。最後の購読者が抜けたらセッションを終了する。

NOTE: プロセス内シングルトン（FeedStore と同じ制約）。
"""

import asyncio
from collections import defaultdict
from typing import Dict, Optional, Set

from config import WS_MAX_ROOMS, WS_MAX_ROOMS_PER_CLIENT, logger
from infrastructure import live_chat

# ポーリング間隔。pytchat 側の更新頻度に合わせる
POLL_INTERVAL_SECONDS = 1.5

# create_chat / poll_messages がスレッド内で完了してセッションを安全に解放するまで
# 待つ猶予。応答しない外部呼び出しでアプリ終了が無期限に止まることは避ける。
ROOM_SHUTDOWN_GRACE_SECONDS = 5.0

# 1 購読者あたりのバッファ上限。
# 受信の遅いクライアントがいても配信側が詰まらないよう、
# 溢れたら古いものから捨てる（チャットは取りこぼしても致命的でない）
SUBSCRIBER_QUEUE_MAXSIZE = 200


class RoomCapacityError(Exception):
    """同時に開けるルーム数の上限に達している。"""


class _Room:
    """1 動画分のチャット配信。"""

    def __init__(self, video_id: str):
        self.video_id = video_id
        self.subscribers: Set[asyncio.Queue] = set()
        self.task: Optional[asyncio.Task] = None
        self.chat = None
        self.closed = False


class LiveChatHub:
    def __init__(self):
        self._rooms: Dict[str, _Room] = {}
        # クライアントキー -> そのキーが「新規に開いた」video_id 集合。
        # 相乗り（既存ルームへの subscribe）は数えず、新規オープンだけを数える。
        self._opened_by_client: Dict[str, Set[str]] = defaultdict(set)
        # ルームの生成・破棄が購読者の出入りと競合しないよう直列化する
        self._lock = asyncio.Lock()

    async def subscribe(self, video_id: str, client_key: str) -> asyncio.Queue:
        """購読を開始し、メッセージが流れてくるキューを返す。

        その動画のルームが無ければ作り、pytchat の取得タスクを起動する。
        全体上限、または呼び出し元 1 クライアントの保有上限に達していて新規に
        開けない場合は RoomCapacityError を投げる。
        """
        queue: asyncio.Queue = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE_MAXSIZE)

        async with self._lock:
            room = self._rooms.get(video_id)
            is_new_room = room is None or room.closed
            owned = self._opened_by_client[client_key]

            if is_new_room:
                # 既存ルームへの相乗りは常に許す。増やせないのは新規のときだけ。
                # 閉じたルームの張り直しは総数が増えないので全体上限に数えない。
                if room is None and len(self._rooms) >= WS_MAX_ROOMS:
                    logger.warning(
                        "Live chat room limit reached (%d); refusing %s",
                        WS_MAX_ROOMS,
                        video_id,
                    )
                    raise RoomCapacityError("Too many live chat rooms")
                # 1 クライアントが別々の動画で全枠を占有する DoS を防ぐ。
                # 既にこのキーが開いている動画への再購読は数に含めない。
                if (
                    video_id not in owned
                    and len(owned) >= WS_MAX_ROOMS_PER_CLIENT
                ):
                    logger.warning(
                        "Per-client room limit reached (%d) for a client; refusing %s",
                        WS_MAX_ROOMS_PER_CLIENT,
                        video_id,
                    )
                    raise RoomCapacityError("Too many live chat rooms for this client")
                room = _Room(video_id)
                self._rooms[video_id] = room
                room.task = asyncio.create_task(self._run_room(room))
                logger.info(
                    "Live chat room opened: %s (rooms=%d)", video_id, len(self._rooms)
                )

            room.subscribers.add(queue)
            owned.add(video_id)
            logger.info(
                "Live chat subscriber joined: %s (subscribers=%d)",
                video_id,
                len(room.subscribers),
            )

        return queue

    async def unsubscribe(
        self, video_id: str, queue: asyncio.Queue, client_key: str
    ) -> None:
        """購読を解除する。最後の1人が抜けたらルームを閉じる。"""
        task_to_wait: Optional[asyncio.Task] = None

        async with self._lock:
            # このキーの保有集合から外す。ルームが他の購読者で生き残っても、
            # このクライアント自身はもう保有していないので枠を返す。
            owned = self._opened_by_client.get(client_key)
            if owned is not None:
                owned.discard(video_id)
                if not owned:
                    self._opened_by_client.pop(client_key, None)

            room = self._rooms.get(video_id)
            if room is None:
                return

            room.subscribers.discard(queue)
            if room.subscribers:
                logger.info(
                    "Live chat subscriber left: %s (subscribers=%d)",
                    video_id,
                    len(room.subscribers),
                )
                return

            # 誰も見ていないので YouTube への接続を畳む
            room.closed = True
            self._rooms.pop(video_id, None)
            if room.task:
                task_to_wait = room.task
            logger.info(
                "Live chat room closed: %s (rooms=%d)", video_id, len(self._rooms)
            )

        if task_to_wait:
            await self._finish_room_tasks([task_to_wait])

    @staticmethod
    def _create_chat(room: _Room):
        """生成中に閉じられたセッションもバックグラウンド側で確実に解放する。"""
        chat = live_chat.create_chat(room.video_id)
        room.chat = chat
        if room.closed:
            room.chat = None
            try:
                live_chat.terminate(chat)
            except Exception:
                logger.warning("Failed to terminate chat for %s", room.video_id)
            return None
        return chat

    @staticmethod
    async def _finish_room_tasks(tasks: list[asyncio.Task]) -> None:
        """正常終了を短時間待ち、残った外部呼び出しだけをキャンセルする。"""
        _, pending = await asyncio.wait(
            tasks, timeout=ROOM_SHUTDOWN_GRACE_SECONDS
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    def _broadcast(self, room: _Room, message: dict) -> None:
        for queue in list(room.subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # 受信が遅れている購読者。最古を1件捨てて詰め直す
                try:
                    queue.get_nowait()
                    queue.put_nowait(message)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    @staticmethod
    def _signal_closed(queue: asyncio.Queue) -> None:
        """満杯の購読キューにも終端マーカーを必ず届ける。"""
        try:
            queue.put_nowait(None)
            return
        except asyncio.QueueFull:
            pass

        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            pass

        try:
            queue.put_nowait(None)
        except asyncio.QueueFull:
            # 同一イベントループ内では通常到達しないが、終了処理を例外で止めない。
            pass

    async def _run_room(self, room: _Room) -> None:
        """1 動画分の pytchat をポーリングして購読者へ配る。"""
        chat = None
        try:
            chat = await asyncio.to_thread(self._create_chat, room)
            if chat is None:
                return
            while not room.closed and await asyncio.to_thread(
                live_chat.is_alive, chat
            ):
                messages = await asyncio.to_thread(live_chat.poll_messages, chat)
                for message in messages:
                    self._broadcast(room, message)
                await asyncio.sleep(POLL_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning("Chat error for %s: %s", room.video_id, error)
        finally:
            room.closed = True
            # 配信終了を購読者へ伝える（None を終端マーカーとして使う）
            for queue in list(room.subscribers):
                self._signal_closed(queue)
            chat = chat or room.chat
            room.chat = None
            if chat:
                try:
                    await asyncio.to_thread(live_chat.terminate, chat)
                except Exception:
                    logger.warning("Failed to terminate chat for %s", room.video_id)
            async with self._lock:
                if self._rooms.get(room.video_id) is room:
                    self._rooms.pop(room.video_id, None)

    async def shutdown(self) -> None:
        """全ルームを閉じる（アプリ終了時）。"""
        async with self._lock:
            rooms = list(self._rooms.values())
            self._rooms.clear()
        tasks = []
        for room in rooms:
            room.closed = True
            if room.task:
                tasks.append(room.task)
        if tasks:
            await self._finish_room_tasks(tasks)

    @property
    def room_count(self) -> int:
        return len(self._rooms)
