"""固定ウィンドウのレート制限。

FastAPI に依存しない純粋なカウンタとして実装する。HTTP への翻訳
（429 と Retry-After）は interfaces 層の責務。

NOTE: プロセス内シングルトン。uvicorn --workers 2+ では
ワーカー数ぶんだけ実効上限が緩む（FEED_DATA と同じ制約）。
"""

import threading
import time
from collections import OrderedDict
from typing import Dict, List, NamedTuple, Optional


class RateLimitVerdict(NamedTuple):
    allowed: bool
    retry_after_seconds: int


class FixedWindowRateLimiter:
    def __init__(self, max_requests: int, window_seconds: int, max_keys: int = 1024):
        if max_requests <= 0 or window_seconds <= 0 or max_keys <= 0:
            raise ValueError("rate limiter limits must be positive")
        self._max_requests = max_requests
        self._window_seconds = window_seconds
        self._max_keys = max_keys
        self._hits: "OrderedDict[str, List[float]]" = OrderedDict()
        self._lock = threading.Lock()

    def check(self, key: str) -> RateLimitVerdict:
        now = time.monotonic()
        cutoff = now - self._window_seconds

        with self._lock:
            hits = self._hits.get(key)
            if hits is None:
                # 期限切れキーを先に掃除し、それでも満杯なら最も長く使われて
                # いないキーを捨てる。攻撃者が毎回別のIPを名乗っても上限を守る。
                #
                # OrderedDict は「最後に触れた順」に並ぶ（既存キーは
                # move_to_end する）ので、先頭から見て期限内のキーに当たった
                # 時点で残りも全て期限内。全キー走査は不要で、毎回別IPを
                # 名乗られても掃除の計算量が保持キー数に比例しない。
                while self._hits:
                    oldest_hits = next(iter(self._hits.values()))
                    if oldest_hits and oldest_hits[-1] > cutoff:
                        break
                    self._hits.popitem(last=False)
                while len(self._hits) >= self._max_keys:
                    self._hits.popitem(last=False)
                hits = []
                self._hits[key] = hits
            else:
                self._hits.move_to_end(key)

            # ウィンドウ外を捨てる
            hits[:] = [t for t in hits if t > cutoff]

            if len(hits) >= self._max_requests:
                retry_after = int(hits[0] + self._window_seconds - now) + 1
                return RateLimitVerdict(False, max(1, retry_after))

            hits.append(now)

        return RateLimitVerdict(True, 0)

    @property
    def key_count(self) -> int:
        with self._lock:
            return len(self._hits)


class TTLCache:
    """スレッドセーフな TTL 付き LRU キャッシュ。"""

    def __init__(self, ttl_seconds: int, max_entries: int):
        if ttl_seconds <= 0 or max_entries <= 0:
            raise ValueError("cache limits must be positive")
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._store: "OrderedDict[str, tuple]" = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[dict]:
        with self._lock:
            entry = self._store.get(key)
            if not entry:
                return None
            expires_at, payload = entry
            if expires_at < time.monotonic():
                self._store.pop(key, None)
                return None
            self._store.move_to_end(key)
            return payload

    def put(self, key: str, payload: dict) -> None:
        with self._lock:
            self._store[key] = (time.monotonic() + self._ttl, payload)
            self._store.move_to_end(key)
            while len(self._store) > self._max_entries:
                self._store.popitem(last=False)
