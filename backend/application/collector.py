"""バックグラウンド収集ワーカー。

「いつ・どの順で集めて FeedStore に入れるか」だけを持つ。
実際の取得は infrastructure、並び替えは domain に委譲する。
"""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Set, Tuple

from config import (
    BACKGROUND_REFRESH_SECONDS,
    CHANNEL_FETCH_WORKERS,
    DISCOVERY_OVERLAY_TTL_SECONDS,
    INITIAL_REFRESH_DELAY_SECONDS,
    NEW_VIDEO_DISCOVERY_SECONDS,
    STREAM_DETAIL_LIMIT_PER_CHANNEL,
    STREAM_DETAIL_WORKERS,
    logger,
)
from application.channels import CLIP_QUERIES, TARGET_CHANNELS
from application.feed_store import FeedStore
from domain.video import (
    apply_video_detail,
    build_video_item,
    extract_channel_id,
    is_valid_youtube_channel_id,
    safe_str,
)
from infrastructure.youtube_rss import (
    load_recent_published_timestamps,
    load_recent_video_items,
)
from infrastructure.youtube_scraper import (
    fetch_channel_items,
    fetch_video_detail,
    search_videos,
)

_MAX_DISCOVERY_OVERLAY_ITEMS = 1024


class FeedCollector:
    def __init__(self, store: FeedStore):
        self._store = store
        self._stop_event = threading.Event()
        self._threads: List[threading.Thread] = []
        self._channel_ids_lock = threading.Lock()
        self._discovery_lock = threading.Lock()
        self._discovery_overlay_lock = threading.Lock()
        # video_id -> (最初に観測した monotonic 時刻, 項目)
        self._discovery_overlay: Dict[str, Tuple[float, Dict[str, Any]]] = {}
        self._channel_ids: Set[str] = {
            channel_id
            for url in TARGET_CHANNELS
            if (channel_id := extract_channel_id(url))
        }
        # 永続キャッシュの直近項目を保持し、初回完全更新がRSS由来の新着を
        # 一時的に落として再詳細取得することを防ぐ。
        self._remember_discovery_items(store.official_items_snapshot())

    # --- ライフサイクル -----------------------------------------------------

    def start(self) -> None:
        if any(thread.is_alive() for thread in self._threads):
            return
        self._stop_event.clear()
        self._threads = [
            threading.Thread(
                target=self._run_full_refresh_loop,
                name="feed-full-refresh",
                daemon=True,
            ),
            threading.Thread(
                target=self._run_discovery_loop,
                name="feed-rss-discovery",
                daemon=True,
            ),
        ]
        for thread in self._threads:
            thread.start()

    def stop(self, timeout: float = 10.0) -> None:
        self._stop_event.set()
        deadline = time.monotonic() + timeout
        for thread in self._threads:
            if thread.is_alive() and thread is not threading.current_thread():
                thread.join(timeout=max(0.0, deadline - time.monotonic()))
            if thread.is_alive():
                logger.warning(
                    "Feed collector thread %s did not stop within %.1f seconds",
                    thread.name,
                    timeout,
                )
        self._threads = []

    # --- 収集 ---------------------------------------------------------------

    def _collect_channel(
        self, channel_url: str
    ) -> Tuple[str, List[Dict[str, Any]]]:
        channel_id = extract_channel_id(channel_url)
        published = (
            load_recent_published_timestamps(channel_id)
            if is_valid_youtube_channel_id(channel_id)
            else {}
        )
        result = fetch_channel_items(channel_url, published_timestamps=published)
        resolved_channel_id = result.channel_id or channel_id

        # ハンドルURLでは事前にchannel_idが分からない。yt-dlpの一覧取得で解決後、
        # RSS時刻を補完して以降の毎分RSSチェックにも再利用する。
        if resolved_channel_id and not published:
            published = load_recent_published_timestamps(resolved_channel_id)
            if published:
                result_items = [
                    {
                        **item,
                        "timestamp": published.get(
                            safe_str(item.get("video_id")),
                            item.get("timestamp", 0),
                        ),
                    }
                    if not item.get("timestamp")
                    else item
                    for item in result.items
                ]
            else:
                result_items = result.items
        else:
            result_items = result.items

        if result.failed_tabs:
            logger.warning(
                "Channel fetch degraded: %s (%d/2 tabs failed, %d items)",
                channel_url,
                result.failed_tabs,
                len(result_items),
            )
            self._store.record_channel_failure(
                complete_failure=result.is_complete_failure
            )

        return resolved_channel_id, result_items

    def _collect_official(self) -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=CHANNEL_FETCH_WORKERS) as executor:
            for channel_id, channel_items in executor.map(
                self._collect_channel, TARGET_CHANNELS
            ):
                if is_valid_youtube_channel_id(channel_id):
                    with self._channel_ids_lock:
                        self._channel_ids.add(channel_id)
                items.extend(channel_items)
        return items

    @staticmethod
    def _collect_clips() -> List[Dict[str, Any]]:
        items: List[Dict[str, Any]] = []
        if not CLIP_QUERIES:
            return items
        # 1 クエリが ytsearch30 で数秒かかる。直列だとクエリ数ぶん
        # 完全更新の所要時間が伸びるだけなので並列で回す。
        # executor.map は入力順に返すため、重複排除の先勝ちは変わらない。
        with ThreadPoolExecutor(max_workers=len(CLIP_QUERIES)) as executor:
            for query_items in executor.map(
                lambda query: search_videos(query, limit=30), CLIP_QUERIES
            ):
                items.extend(query_items)
        return items

    @staticmethod
    def _refine_stream_details(
        items: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """配信タブ由来の直近動画だけ個別取得して配信状態を確定させる。

        全件やると重すぎるので、チャンネルごとに新しいものから
        STREAM_DETAIL_LIMIT_PER_CHANNEL 件に絞る。
        """
        grouped: Dict[str, List[Dict[str, Any]]] = {}
        for item in items:
            if not item.get("from_streams_tab"):
                continue
            grouped.setdefault(safe_str(item.get("uploader")), []).append(item)

        candidates: List[Dict[str, Any]] = []
        for uploader_items in grouped.values():
            candidates.extend(
                sorted(
                    uploader_items,
                    key=lambda item: float(item.get("timestamp") or 0),
                    reverse=True,
                )[:STREAM_DETAIL_LIMIT_PER_CHANNEL]
            )

        if not candidates:
            return items

        detail_by_id: Dict[str, Dict[str, Any]] = {}
        with ThreadPoolExecutor(max_workers=STREAM_DETAIL_WORKERS) as executor:
            for detail in executor.map(
                lambda item: fetch_video_detail(safe_str(item.get("video_id")).strip()),
                candidates,
            ):
                video_id = safe_str(detail.get("id")).strip()
                if video_id:
                    detail_by_id[video_id] = detail

        refined = []
        for item in items:
            detail = detail_by_id.get(safe_str(item.get("video_id")))
            refined.append(apply_video_detail(item, detail) if detail else item)
        return refined

    @staticmethod
    def _refine_discovered_item(
        item: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        """新着1件だけ詳細取得し、配信状態と公開可否を確定する。"""
        video_id = safe_str(item.get("video_id")).strip()
        detail = fetch_video_detail(video_id)
        if not detail:
            return item

        # build_video_itemを通し直し、メンバー限定判定も一覧取得と統一する。
        return build_video_item(
            detail,
            fallback_uploader=safe_str(item.get("uploader")),
            published_timestamps={
                video_id: float(item.get("timestamp") or 0),
            },
        )

    def _remember_discovery_items(
        self,
        items: List[Dict[str, Any]],
    ) -> None:
        """RSS 由来の項目を、完全更新の入れ替えに重ねるため保持する。"""
        now = time.monotonic()
        with self._discovery_overlay_lock:
            for item in items:
                video_id = safe_str(item.get("video_id")).strip()
                if not video_id:
                    continue
                # 初めて見た時刻を保つ。再確認のたびに延命すると、RSS に
                # 残っている限り期限切れにならず、期限そのものが無意味になる。
                existing = self._discovery_overlay.get(video_id)
                first_seen = existing[0] if existing else now
                self._discovery_overlay[video_id] = (first_seen, dict(item))

            self._prune_discovery_overlay_locked(now)

    def _prune_discovery_overlay_locked(self, now: float) -> None:
        """期限切れと上限超過を落とす。_discovery_overlay_lock 保持下で呼ぶこと。"""
        expired = [
            video_id
            for video_id, (first_seen, _) in self._discovery_overlay.items()
            if now - first_seen > DISCOVERY_OVERLAY_TTL_SECONDS
        ]
        for video_id in expired:
            del self._discovery_overlay[video_id]
        if expired:
            logger.info(
                "Dropped %d stale discovery overlay item(s) not seen by the "
                "channel listing within %d seconds",
                len(expired),
                DISCOVERY_OVERLAY_TTL_SECONDS,
            )

        if len(self._discovery_overlay) <= _MAX_DISCOVERY_OVERLAY_ITEMS:
            return

        newest = sorted(
            self._discovery_overlay.items(),
            key=lambda entry: float(entry[1][1].get("timestamp") or 0),
            reverse=True,
        )[:_MAX_DISCOVERY_OVERLAY_ITEMS]
        self._discovery_overlay = dict(newest)

    def _forget_discovery_items(self, video_ids: Set[str]) -> None:
        """完全更新の一覧に現れた項目を overlay から外す。

        一覧が正本を持っているなら重ねる必要はない。ここで外さないと、
        削除・非公開化・メンバー限定化された動画がフィードへ戻り続ける。
        """
        if not video_ids:
            return
        with self._discovery_overlay_lock:
            for video_id in video_ids:
                self._discovery_overlay.pop(video_id, None)

    def _discovery_overlay_snapshot(self) -> List[Dict[str, Any]]:
        now = time.monotonic()
        with self._discovery_overlay_lock:
            self._prune_discovery_overlay_locked(now)
            return [dict(item) for _, item in self._discovery_overlay.values()]

    def _merge_discovery_overlay(self) -> None:
        overlay = self._discovery_overlay_snapshot()
        if overlay:
            self._store.merge_official(overlay)

    def _discover_new_official(self) -> int:
        """既知のchannel_idをRSS確認し、未知の動画だけFeedStoreへ追加する。"""
        # 完全更新のreplace直後でも、既知のRSS項目を先に戻してから差分判定する。
        self._merge_discovery_overlay()
        with self._channel_ids_lock:
            channel_ids = tuple(sorted(self._channel_ids))
        if not channel_ids:
            logger.warning("RSS discovery skipped: no resolved YouTube channel IDs")
            return 0

        current_items = self._store.official_items_snapshot()
        current_by_id = {
            safe_str(item.get("video_id")).strip(): item
            for item in current_items
            if safe_str(item.get("video_id")).strip()
        }
        seen_rss_items: List[Dict[str, Any]] = []
        candidates_by_id: Dict[str, Dict[str, Any]] = {}
        with ThreadPoolExecutor(max_workers=CHANNEL_FETCH_WORKERS) as executor:
            for feed_items in executor.map(load_recent_video_items, channel_ids):
                for item in feed_items:
                    video_id = safe_str(item.get("video_id")).strip()
                    if video_id in current_by_id:
                        seen_rss_items.append(current_by_id[video_id])
                    elif video_id:
                        candidates_by_id.setdefault(video_id, item)

        self._remember_discovery_items(seen_rss_items)
        if not candidates_by_id:
            return 0

        refined: List[Dict[str, Any]] = []
        with ThreadPoolExecutor(max_workers=STREAM_DETAIL_WORKERS) as executor:
            for item in executor.map(
                self._refine_discovered_item,
                candidates_by_id.values(),
            ):
                if item:
                    refined.append(item)

        self._remember_discovery_items(refined)
        added = self._store.merge_official(refined)
        if added:
            logger.info("RSS discovery added %d new official video(s)", added)
        return added

    def _run_discovery_once(self) -> None:
        """RSS探索を直列化し、失敗しても最後の成功フィードを維持する。"""
        with self._discovery_lock:
            try:
                added = self._discover_new_official()
                self._store.record_discovery(added)
            except Exception as error:
                logger.exception("RSS new-video discovery failed")
                self._store.record_discovery(0, error)

    def _refresh_full_feed(self) -> bool:
        """動画・配信・切り抜きを再取得し、成功可否を返す。"""
        self._store.set_building(True)
        self._store.reset_failures()
        try:
            official = self._collect_official()
            clips = self._collect_clips()

            # 先に粗いデータを見せてから、詳細で上書きする
            self._store.replace(official, clips, is_building=True)
            self._merge_discovery_overlay()

            refined = self._refine_stream_details(official)
            self._store.replace(refined, clips)
            # 一覧に載っている項目は正本が持っているので overlay から外す。
            # 残るのは「RSS には出たが一覧がまだ追いついていない」項目だけで、
            # それらも TTL を過ぎれば消える（＝削除された動画は戻らない）。
            self._forget_discovery_items(
                {
                    video_id
                    for item in refined
                    if (video_id := safe_str(item.get("video_id")).strip())
                }
            )
            self._merge_discovery_overlay()
            # フル収集中に別ワーカーが追加したRSS新着を最後のreplaceが上書き
            # する可能性があるため、完了直後に必ず差分を再統合する。
            self._run_discovery_once()
            return True
        except Exception as error:
            logger.exception("Background full refresh failed")
            self._store.mark_error(error)
            return False

    @staticmethod
    def _next_deadline(previous: float, interval: int, now: float) -> float:
        """遅延した周期を飛ばし、次の未来の開始時刻を返す。"""
        missed = max(1, int((now - previous) // interval) + 1)
        return previous + missed * interval

    # --- ループ -------------------------------------------------------------

    def _run_full_refresh_loop(self) -> None:
        """重い完全更新専用ループ。RSSの1分周期をブロックしない。"""
        if self._stop_event.wait(timeout=INITIAL_REFRESH_DELAY_SECONDS):
            return
        consecutive_errors = 0
        while not self._stop_event.is_set():
            if self._refresh_full_feed():
                consecutive_errors = 0
                delay = BACKGROUND_REFRESH_SECONDS
            else:
                consecutive_errors += 1
                delay = min(
                    30 * consecutive_errors,
                    BACKGROUND_REFRESH_SECONDS,
                )

            if self._stop_event.wait(timeout=delay):
                return

    def _run_discovery_loop(self) -> None:
        """RSSを締切基準で毎分実行し、完全更新の所要時間から分離する。"""
        if self._stop_event.wait(timeout=INITIAL_REFRESH_DELAY_SECONDS):
            return

        next_discovery = time.monotonic() + NEW_VIDEO_DISCOVERY_SECONDS
        while not self._stop_event.is_set():
            if self._stop_event.wait(
                timeout=max(0.0, next_discovery - time.monotonic())
            ):
                return

            previous_deadline = next_discovery
            self._run_discovery_once()
            next_discovery = self._next_deadline(
                previous_deadline,
                NEW_VIDEO_DISCOVERY_SECONDS,
                time.monotonic(),
            )
