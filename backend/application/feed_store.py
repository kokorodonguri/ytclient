"""フィードの保持と配信用ペイロードの生成。

責務:
  - 収集結果の保持（スレッド安全）
  - 応答ボディと ETag の事前生成
  - チャンネル取得の劣化状況の集計

NOTE: プロセス内シングルトン。uvicorn --workers 2+ ではワーカー間で
共有されないため、マルチワーカー化する際は Redis / SQLite 等へ外出しする。
"""

import gzip
import hashlib
import json
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

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
        self._data: dict[str, Any] = {
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
        self._payload_gzip: bytes = b""
        self._etag: str = ""
        self._version = 0
        self._published_version = 0
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
        # ここで一度組み立てておけば _payload が空になる状態が無くなり、
        # response_parts() はロックを取って返すだけで済む。
        with self._lock:
            version, snapshot = self._snapshot_locked()
        self._publish(version, snapshot)

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

    def _snapshot_failures(self) -> tuple[int, int]:
        with self._failure_lock:
            return self._degraded_channels, self._failed_channels

    # --- 状態の更新 ---------------------------------------------------------

    def _snapshot_locked(self) -> tuple[int, dict[str, Any]]:
        """公開待ちのスナップショットに版番号を付けて返す。_lock 保持下で呼ぶ。"""
        self._version += 1
        return self._version, dict(self._data)

    def _publish(self, version: int, snapshot: dict[str, Any]) -> None:
        """応答ボディと ETag を組み立て、差し替えだけをロック内で行う。

        json.dumps は約 1.5 MB のフィードを走査し、SHA-256 もその全体を
        読む。これをロック内で回すと、RSS 由来の merge_official が 60 秒ごとに
        走るあいだ response_parts() が待たされ、/feed 全台がそこでブロックする。
        組み立てはロック外で行い、ロックは参照の差し替えだけに使う。

        フィードが入れ替わったときだけ組み立て直し、それ以外のリクエストは
        同じ bytes をそのまま返す。クライアントは is_building 中 5 秒ごとに
        ポーリングするため、毎回シリアライズすると台数 × ペイロードぶんの
        CPU を無駄に焼くことになる。
        """
        body = {"status": "success", "data": snapshot}
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        # 実際に返すバイト列のハッシュ。last_updated も本文に含まれるので、
        # 動画一覧が同じでも周期が回れば ETag は変わる（そこは HTTP の
        # 表現が変わった以上そうあるべき）。304 が効くのは「再組み立てが
        # 起きていない間の連続ポーリング」で、is_building 中の 5 秒間隔は
        # ここに収まる。record_discovery が本文を触らないのはこのため。
        etag = f'W/"{hashlib.sha256(payload).hexdigest()[:32]}"'
        # 約 1.5 MB の JSON を毎リクエスト圧縮すると CPU が溶ける。組み立てと
        # 同じタイミングで 1 回だけ圧縮し、以後はその bytes を配るだけにする。
        # 転送量はおよそ 1/5 になる。
        payload_gzip = gzip.compress(payload, compresslevel=6)

        with self._lock:
            # ロック外で組み立てる以上、収集ワーカーと RSS 周期が同時に
            # 公開しようとすると到着順が入れ替わり得る。版番号で古い
            # スナップショットを捨て、新しい方を残す。
            if version < self._published_version:
                return
            self._payload = payload
            self._payload_gzip = payload_gzip
            self._etag = etag
            self._published_version = version

    def set_building(self, is_building: bool) -> None:
        with self._lock:
            self._data["is_building"] = is_building
            version, snapshot = self._snapshot_locked()
        self._publish(version, snapshot)

    def mark_error(self, error: Exception) -> None:
        # 例外の文字列は配信しない。yt-dlp の例外文には上流URLやローカルの
        # ファイルパスが混じり、last_error は /api/v1/feed と /readiness の
        # 本文にそのまま載る。読み取りAPIは公開なので誰でも読める。
        # 種類だけ返せばクライアント側の分岐には足り、詳細はログに残る。
        logger.warning("Feed refresh failed: %s: %s", type(error).__name__, error)
        with self._lock:
            self._data["is_building"] = False
            self._data["last_error"] = type(error).__name__
            version, snapshot = self._snapshot_locked()
        self._publish(version, snapshot)

    def replace(
        self,
        official: list[dict[str, Any]],
        clips: list[dict[str, Any]],
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
            version, snapshot = self._snapshot_locked()
        self._publish(version, snapshot)

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

    def official_items_snapshot(self) -> list[dict[str, Any]]:
        """RSSオーバーレイ構築用に公式フィードの浅いコピーを返す。"""
        with self._lock:
            return [dict(item) for item in self._data["official"]]

    def _feed_age_seconds_locked(self) -> float | None:
        """最後の更新からの経過秒。_lock 保持下で呼ぶこと。

        「last_updated が入っているか」だけでは、収集スレッドが詰まって
        更新が止まった状態を検知できない。監視が ready を信じ続けるので、
        古さそのものを返して呼び出し側に判断させる。
        """
        raw_value = self._data["last_updated"]
        if not isinstance(raw_value, str) or not raw_value:
            return None
        try:
            updated_at = datetime.fromisoformat(raw_value)
        except ValueError:
            return None
        return max(0.0, (datetime.now() - updated_at).total_seconds())

    def readiness_snapshot(self) -> dict[str, Any]:
        """監視用に、フィードの可用性だけを小さいペイロードで返す。"""
        with self._lock:
            return {
                "is_building": bool(self._data["is_building"]),
                "last_updated": self._data["last_updated"],
                "feed_age_seconds": self._feed_age_seconds_locked(),
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
            # mark_error と同じ理由で例外文は載せない（readiness で配信される）
            self._last_discovery_error = type(error).__name__ if error else None
            self._last_discovery_added = max(0, int(added))
            self._discovery_runs += 1

    def merge_official(self, items: list[dict[str, Any]]) -> int:
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
            version, snapshot = self._snapshot_locked()
            added = len(additions)

        self._publish(version, snapshot)
        self._persist_successful_feed()
        return added

    # --- 読み出し -----------------------------------------------------------

    def response_parts(self, prefer_gzip: bool = False) -> tuple[bytes, str, bool]:
        """(応答ボディ, ETag, gzip済みか) を返す。

        __init__ と各更新経路が publish 済みなので、ここは参照を読むだけ。
        ETag は表現によらず同じ値にし、キャッシュの区別は Vary: Accept-Encoding
        に任せる（弱い ETag なのでこれで整合する）。
        """
        with self._lock:
            if prefer_gzip and self._payload_gzip:
                return self._payload_gzip, self._etag, True
            return self._payload, self._etag, False
