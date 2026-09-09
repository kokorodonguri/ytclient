"""フィードの保持と配信用ペイロードの生成。

責務:
  - 収集結果の保持（スレッド安全）
  - 応答ボディと ETag の事前生成
  - チャンネル取得の劣化状況の集計

NOTE: プロセス内シングルトン。uvicorn --workers 2+ ではワーカー間で
共有されないため、マルチワーカー化する際は Redis / SQLite 等へ外出しする。
"""

import hashlib
import json
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Tuple

from config import logger
from domain.feed_rules import normalize_feed

_MAX_CACHE_BYTES = 16 * 1024 * 1024


class FeedStore:
    def __init__(
        self,
        total_channels: int = 0,
        cache_path: Path | None = None,
    ):
        self._lock = threading.Lock()
        self._cache_path = cache_path
        self._data: Dict[str, Any] = {
            "official": [],
            "clips": [],
            "is_building": True,
            "last_updated": None,
            "last_error": None,
            # 取得できなかったチャンネル数。0 より大きいときフィードは不完全で、
            # 「特定のメンバーしか出てこない」状態になり得る
            "degraded_channels": 0,
            "total_channels": total_channels,
        }
        self._payload: bytes = b""
        self._etag: str = ""
        self._total_channels = total_channels

        # 1 サイクル分の取得失敗の集計。収集ワーカーの複数スレッドから触られる
        self._failure_lock = threading.Lock()
        self._degraded_channels = 0
        self._failed_channels = 0
        self._last_discovery_at: str | None = None
        self._last_discovery_error: str | None = None
        self._last_discovery_added = 0
        self._discovery_runs = 0

        self._load_cache()

    # --- 永続キャッシュ -----------------------------------------------------

    def _load_cache(self) -> None:
        """最後に成功したフィードを読み、初回収集中も空表示にしない。"""
        path = self._cache_path
        if path is None or not path.is_file():
            return

        try:
            if path.stat().st_size > _MAX_CACHE_BYTES:
                raise ValueError("feed cache exceeds 16 MiB")
            payload = json.loads(path.read_bytes())
            data = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(data, dict):
                raise ValueError("feed cache has no data object")
            official = data.get("official")
            clips = data.get("clips")
            last_updated = data.get("last_updated")
            if (
                not isinstance(official, list)
                or not isinstance(clips, list)
                or not isinstance(last_updated, str)
                or not last_updated
            ):
                raise ValueError("feed cache schema is invalid")

            self._data.update(
                {
                    "official": official,
                    "clips": clips,
                    # 起動直後はキャッシュを見せつつ、裏で最新化中と表示する。
                    "is_building": True,
                    "last_updated": last_updated,
                    "last_error": None,
                    "degraded_channels": max(
                        0, int(data.get("degraded_channels") or 0)
                    ),
                    "total_channels": self._total_channels,
                }
            )
            self._rebuild_cache_locked()
            logger.info(
                "Loaded cached feed (%d official, %d clips)",
                len(official),
                len(clips),
            )
        except Exception as error:
            logger.warning("Ignoring invalid feed cache %s: %s", path, error)

    def _persist_successful_feed(self) -> None:
        """成功スナップショットを同一ディレクトリ内で原子的に置き換える。"""
        path = self._cache_path
        if path is None:
            return

        with self._lock:
            payload = self._payload

        temporary_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        try:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with temporary_path.open("wb") as cache_file:
                cache_file.write(payload)
                cache_file.flush()
                os.fsync(cache_file.fileno())
            os.chmod(temporary_path, 0o600)
            os.replace(temporary_path, path)
        except Exception as error:
            logger.warning("Failed to persist feed cache %s: %s", path, error)
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass

    # --- 取得失敗の集計 -----------------------------------------------------

    def reset_failures(self) -> None:
        with self._failure_lock:
            self._degraded_channels = 0
            self._failed_channels = 0

    def record_channel_failure(self, complete_failure: bool) -> None:
        with self._failure_lock:
            self._degraded_channels += 1
            if complete_failure:
                self._failed_channels += 1

    def _snapshot_failures(self) -> Tuple[int, int]:
        with self._failure_lock:
            return self._degraded_channels, self._failed_channels

    # --- 状態の更新 ---------------------------------------------------------

    def _rebuild_cache_locked(self) -> None:
        """保持データから応答ボディと ETag を再生成する。_lock 保持下で呼ぶこと。

        フィードが入れ替わったときだけ組み立て直し、それ以外のリクエストは
        同じ bytes をそのまま返す。クライアントは is_building 中 5 秒ごとに
        ポーリングするため、毎回シリアライズすると台数 × ペイロードぶんの
        CPU を無駄に焼くことになる。
        """
        body = {"status": "success", "data": dict(self._data)}
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        self._payload = payload
        # 実際に返すバイト列のハッシュ。last_updated も本文に含まれるので、
        # 動画一覧が同じでも周期が回れば ETag は変わる（そこは HTTP の
        # 表現が変わった以上そうあるべき）。304 が効くのは「再組み立てが
        # 起きていない間の連続ポーリング」で、is_building 中の 5 秒間隔は
        # ここに収まる。record_discovery が本文を触らないのはこのため。
        self._etag = f'W/"{hashlib.sha256(payload).hexdigest()[:32]}"'

    def set_building(self, is_building: bool) -> None:
        with self._lock:
            self._data["is_building"] = is_building
            self._rebuild_cache_locked()

    def mark_error(self, error: Exception) -> None:
        with self._lock:
            self._data["is_building"] = False
            self._data["last_error"] = str(error)
            self._rebuild_cache_locked()

    def replace(
        self,
        official: List[Dict[str, Any]],
        clips: List[Dict[str, Any]],
        is_building: bool = False,
    ) -> None:
        degraded, failed = self._snapshot_failures()

        with self._lock:
            # 並び順はクライアント全台で同じなので、ここで一度だけ確定させる
            self._data["official"] = normalize_feed(official)
            self._data["clips"] = normalize_feed(clips)
            self._data["is_building"] = is_building
            self._data["last_updated"] = datetime.now().isoformat()
            self._data["last_error"] = None
            self._data["degraded_channels"] = degraded
            self._data["total_channels"] = self._total_channels
            self._rebuild_cache_locked()

        if degraded:
            logger.warning(
                "Feed is incomplete: %d/%d channels degraded (%d fully failed). "
                "Likely YouTube throttling; some members will be missing from the UI.",
                degraded,
                self._total_channels,
                failed,
            )
        if not is_building:
            self._persist_successful_feed()

    def official_video_ids(self) -> set[str]:
        """現在の公式フィードに含まれる動画IDのスナップショットを返す。"""
        with self._lock:
            return {
                str(item.get("video_id"))
                for item in self._data["official"]
                if item.get("video_id")
            }

    def official_items_snapshot(self) -> List[Dict[str, Any]]:
        """RSSオーバーレイ構築用に公式フィードの浅いコピーを返す。"""
        with self._lock:
            return [dict(item) for item in self._data["official"]]

    def readiness_snapshot(self) -> Dict[str, Any]:
        """監視用に、フィードの可用性だけを小さいペイロードで返す。"""
        with self._lock:
            return {
                "is_building": bool(self._data["is_building"]),
                "last_updated": self._data["last_updated"],
                "last_error": self._data["last_error"],
                "official_count": len(self._data["official"]),
                "clip_count": len(self._data["clips"]),
                "degraded_channels": int(self._data["degraded_channels"]),
                "total_channels": int(self._data["total_channels"]),
                "last_discovery_at": self._last_discovery_at,
                "last_discovery_error": self._last_discovery_error,
                "last_discovery_added": self._last_discovery_added,
                "discovery_runs": self._discovery_runs,
            }

    def record_discovery(
        self,
        added: int,
        error: Exception | None = None,
    ) -> None:
        """RSS周期の実行結果をfeed本体のETagを変えずに記録する。"""
        with self._lock:
            self._last_discovery_at = datetime.now().isoformat()
            self._last_discovery_error = (
                f"{type(error).__name__}: {error}"[:256] if error else None
            )
            self._last_discovery_added = max(0, int(added))
            self._discovery_runs += 1

    def merge_official(self, items: List[Dict[str, Any]]) -> int:
        """RSSで検知した新着だけを公式フィードへ追加し、追加件数を返す。"""
        if not items:
            return 0

        with self._lock:
            known_ids = {
                str(item.get("video_id"))
                for item in self._data["official"]
                if item.get("video_id")
            }
            additions = []
            for item in items:
                video_id = str(item.get("video_id") or "")
                if not video_id or video_id in known_ids:
                    continue
                known_ids.add(video_id)
                additions.append(item)

            if not additions:
                return 0

            self._data["official"] = normalize_feed(
                additions + self._data["official"]
            )
            self._data["last_updated"] = datetime.now().isoformat()
            self._data["last_error"] = None
            self._rebuild_cache_locked()
            added = len(additions)

        self._persist_successful_feed()
        return added

    # --- 読み出し -----------------------------------------------------------

    def response_parts(self) -> Tuple[bytes, str]:
        """(応答ボディ, ETag) を返す。"""
        with self._lock:
            if not self._payload:
                self._rebuild_cache_locked()
            return self._payload, self._etag
