import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import sys
import threading
import time
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional, Tuple

import pytchat
import uvicorn
import yt_dlp
from fastapi.concurrency import run_in_threadpool
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

# --- 設定 ---
API_VERSION = "3.2.0"
SERVICE_NAME = "vspo-client-api"
API_KEY = os.environ.get("VSPO_API_KEY", "").strip()

# CORS: 明示したオリジンのみ許可する。既定は Electron の file:// と同梱フロントのみ。
_DEFAULT_ALLOWED_ORIGINS = ["null", "http://127.0.0.1:8010", "http://localhost:8010"]
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get("VSPO_ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
] or _DEFAULT_ALLOWED_ORIGINS

# 高コスト経路の保護
COMMENTS_CONCURRENCY = max(1, int(os.environ.get("VSPO_COMMENTS_CONCURRENCY", "4")))
COMMENTS_CACHE_TTL_SECONDS = max(0, int(os.environ.get("VSPO_COMMENTS_CACHE_TTL", "300")))
COMMENTS_CACHE_MAX_ENTRIES = 256
MAX_LIVE_CHAT_CONNECTIONS = max(1, int(os.environ.get("VSPO_MAX_LIVE_CHAT", "16")))
RATE_LIMIT_REQUESTS = max(1, int(os.environ.get("VSPO_RATE_LIMIT_REQUESTS", "30")))
RATE_LIMIT_WINDOW_SECONDS = max(1, int(os.environ.get("VSPO_RATE_LIMIT_WINDOW", "60")))

MEMBER_ONLY_KEYWORDS = ["メンバー限定", "メン限", "Member-only", "Membership"]
DEFAULT_AVATAR_URL = "https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y"
YT_THUMBNAIL_TEMPLATE = "https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
BACKGROUND_REFRESH_SECONDS = 600
BACKGROUND_ERROR_BACKOFF_SECONDS = 60
BACKGROUND_CYCLE_TIMEOUT_SECONDS = 900
INITIAL_REFRESH_DELAY_SECONDS = 2
MAX_COMMENTS_LIMIT = 100
STREAM_DETAIL_LIMIT_PER_CHANNEL = 5
STREAM_DETAIL_WORKERS = 8
CHANNEL_FETCH_WORKERS = 6
YT_SOCKET_TIMEOUT_SECONDS = 15
FEED_XML_MAX_BYTES = 2 * 1024 * 1024
YOUTUBE_VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
YOUTUBE_CHANNEL_ID_PATTERN = re.compile(r"/channel/(?P<channel_id>[A-Za-z0-9_-]+)$")
YOUTUBE_FEED_URL_TEMPLATE = "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"

logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
logger = logging.getLogger("vspo-client")

if getattr(sys, "frozen", False):
    BASE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(__file__).resolve().parent.parent

FRONTEND_DIR = BASE_DIR / "frontend"

def _safe_str(value: Any, default: str = "") -> str:
    return str(value) if value is not None else default

def _is_valid_youtube_video_id(video_id: str) -> bool:
    return isinstance(video_id, str) and bool(YOUTUBE_VIDEO_ID_PATTERN.fullmatch(video_id))


def _error_payload(
    code: str,
    message: str,
    request_id: str,
    details: Optional[Any] = None,
) -> Dict[str, Any]:
    return {
        "status": "error",
        "error": {
            "code": code,
            "message": message,
            "details": details or {},
            "request_id": request_id,
        },
    }


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", str(uuid.uuid4()))


def _constant_time_equals(candidate: Optional[str], secret: str) -> bool:
    if not candidate:
        return False
    return hmac.compare_digest(candidate, secret)


def _extract_bearer_token(authorization: Optional[str]) -> str:
    prefix = "Bearer "
    if authorization and authorization.startswith(prefix):
        return authorization[len(prefix) :].strip()
    return ""


def require_api_key(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
) -> None:
    if not API_KEY:
        return
    if _constant_time_equals(x_api_key, API_KEY):
        return
    if _constant_time_equals(_extract_bearer_token(authorization), API_KEY):
        return
    raise HTTPException(status_code=401, detail="Missing or invalid API key")


class SlidingWindowRateLimiter:
    """クライアントIP単位の固定ウィンドウ・レートリミッタ（プロセス内）。"""

    def __init__(self, max_requests: int, window_seconds: int) -> None:
        self._max_requests = max_requests
        self._window_seconds = window_seconds
        self._hits: Dict[str, Deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, client_key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self._window_seconds
        with self._lock:
            hits = self._hits[client_key]
            while hits and hits[0] < cutoff:
                hits.popleft()
            if len(hits) >= self._max_requests:
                return False
            hits.append(now)
            if len(self._hits) > 4096:
                self._prune_locked(cutoff)
            return True

    def _prune_locked(self, cutoff: float) -> None:
        stale = [key for key, hits in self._hits.items() if not hits or hits[-1] < cutoff]
        for key in stale:
            del self._hits[key]


comments_rate_limiter = SlidingWindowRateLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_SECONDS)
comments_semaphore = asyncio.Semaphore(COMMENTS_CONCURRENCY)
live_chat_semaphore = asyncio.Semaphore(MAX_LIVE_CHAT_CONNECTIONS)

_comments_cache: Dict[str, Any] = {}
_comments_cache_lock = threading.Lock()


def _client_key(request: Request) -> str:
    client = request.client
    return client.host if client else "unknown"


def enforce_rate_limit(request: Request) -> None:
    if not comments_rate_limiter.check(_client_key(request)):
        raise HTTPException(status_code=429, detail="Too many requests")


def _cache_get(cache_key: str) -> Optional[Dict[str, Any]]:
    if COMMENTS_CACHE_TTL_SECONDS <= 0:
        return None
    with _comments_cache_lock:
        entry = _comments_cache.get(cache_key)
        if not entry:
            return None
        if time.monotonic() - entry["stored_at"] > COMMENTS_CACHE_TTL_SECONDS:
            _comments_cache.pop(cache_key, None)
            return None
        return entry["payload"]


def _cache_put(cache_key: str, payload: Dict[str, Any]) -> None:
    if COMMENTS_CACHE_TTL_SECONDS <= 0:
        return
    with _comments_cache_lock:
        if len(_comments_cache) >= COMMENTS_CACHE_MAX_ENTRIES:
            oldest = min(_comments_cache, key=lambda key: _comments_cache[key]["stored_at"])
            _comments_cache.pop(oldest, None)
        _comments_cache[cache_key] = {"stored_at": time.monotonic(), "payload": payload}


def validate_video_id(video_id: str) -> str:
    if not _is_valid_youtube_video_id(video_id):
        raise HTTPException(status_code=400, detail="Invalid YouTube video ID")
    return video_id

def _extract_video_item(
    entry: Dict[str, Any],
    fallback_uploader: str = "",
    from_streams_tab: bool = False,
    published_timestamps: Optional[Dict[str, float]] = None,
) -> Optional[Dict[str, Any]]:
    video_id = _safe_str(entry.get("id")).strip()
    if not video_id or not _is_valid_youtube_video_id(video_id):
        return None

    title = _safe_str(entry.get("title")).strip() or "タイトル不明"

    availability = _safe_str(entry.get("availability")).lower()
    if availability == "subscriber_only":
        return None
    if any(keyword in title for keyword in MEMBER_ONLY_KEYWORDS):
        return None

    live_status = _safe_str(entry.get("live_status")).lower()
    uploader = (
        _safe_str(entry.get("channel")).strip()
        or _safe_str(entry.get("uploader")).strip()
        or fallback_uploader
    )

    raw_ts = entry.get("release_timestamp") or entry.get("timestamp")
    if not raw_ts and published_timestamps:
        raw_ts = published_timestamps.get(video_id)
    if not raw_ts:
        ud = _safe_str(entry.get("upload_date"))
        if ud and len(ud) == 8 and ud.isdigit():
            try:
                raw_ts = datetime.strptime(ud, "%Y%m%d").timestamp()
            except ValueError:
                raw_ts = 0
        else:
            raw_ts = 0

    return {
        "title": title,
        "video_id": video_id,
        "uploader": uploader or "不明なチャンネル",
        "thumbnail": YT_THUMBNAIL_TEMPLATE.format(video_id=video_id),
        "is_live": live_status == "is_live",
        "is_upcoming": live_status == "is_upcoming",
        "is_live_archive": live_status == "was_live"
        or (from_streams_tab and live_status not in {"is_live", "is_upcoming"}),
        "from_streams_tab": from_streams_tab,
        "timestamp": float(raw_ts) if raw_ts else 0.0,
    }


def _extract_channel_id(channel_url: str) -> str:
    match = YOUTUBE_CHANNEL_ID_PATTERN.search(channel_url)
    return match.group("channel_id") if match else ""


def _load_recent_published_timestamps(channel_id: str) -> Dict[str, float]:
    if not channel_id:
        return {}

    feed_url = YOUTUBE_FEED_URL_TEMPLATE.format(channel_id=channel_id)
    try:
        with urllib.request.urlopen(feed_url, timeout=10) as response:
            raw = response.read(FEED_XML_MAX_BYTES + 1)
        if len(raw) > FEED_XML_MAX_BYTES:
            logger.warning("Channel feed too large, skipped: %s", channel_id)
            return {}
        root = ET.fromstring(raw)
    except Exception as error:
        logger.warning("Failed to load channel feed %s: %s", channel_id, error)
        return {}

    namespaces = {
        "atom": "http://www.w3.org/2005/Atom",
        "yt": "http://www.youtube.com/xml/schemas/2015",
    }
    timestamps: Dict[str, float] = {}
    for entry in root.findall("atom:entry", namespaces):
        video_id = entry.findtext("yt:videoId", default="", namespaces=namespaces)
        published = entry.findtext("atom:published", default="", namespaces=namespaces)
        if not video_id or not published:
            continue
        try:
            timestamps[video_id] = datetime.fromisoformat(
                published.replace("Z", "+00:00")
            ).timestamp()
        except ValueError:
            continue
    return timestamps

def _dedupe_by_video_id(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen = set()
    unique = []
    for item in items:
        vid = item.get("video_id")
        if vid and vid not in seen:
            seen.add(vid)
            unique.append(item)
    return unique

# ==========================================
# 🔥 バックグラウンド定期取得システム 🔥
# ==========================================
TARGET_CHANNELS = [
    # --- ぶいすぽっ！ (JP) ---
    "https://www.youtube.com/@KagaSumire",                     # 花芽すみれ
    "https://www.youtube.com/@nazunakaga",                     # 花芽なずな
    "https://www.youtube.com/@totokogara",                     # 小雀とと
    "https://www.youtube.com/@uruhaichinose",                  # 一ノ瀬うるは
    "https://www.youtube.com/@963Noah",                        # 胡桃のあ
    "https://www.youtube.com/@hinanotachiba7",                 # 橘ひなの
    "https://www.youtube.com/@ren_kisaragi__",                 # 如月れん
    "https://www.youtube.com/@tosakimimi3369",                 # 兎咲ミミ
    "https://www.youtube.com/@asumi_sena",                     # 空澄セナ
    "https://www.youtube.com/@lisahanabusa",                   # 英リサ
    "https://www.youtube.com/@KaminariQpi",                    # 神成きゅぴ
    "https://www.youtube.com/channel/UCjXBuHmWkieBApgBhDuJMMQ", # 八雲べに
    "https://www.youtube.com/@AizawaEma",                      # 藍沢エマ
    "https://www.youtube.com/@shinomiyaruna",                  # 紫宮るな
    "https://www.youtube.com/@tsuna_nekota",                   # 猫汰つな
    "https://www.youtube.com/@shiranamiramune",                # 白波らむね
    "https://www.youtube.com/@Met_Komori",                     # 小森めと
    "https://www.youtube.com/@akarindao",                      # 夢野あかり
    "https://www.youtube.com/@YanoKuromu",                     # 夜乃くろむ
    "https://www.youtube.com/@Kokage_Tsumugi",                 # 紡木こかげ
    "https://www.youtube.com/@SendoYuuhi",                     # 千燈ゆうひ
    "https://www.youtube.com/@HanabiChoya",                    # 蝶屋はなび
    "https://www.youtube.com/@Moka_Amayui",                    # 甘結もか
    "https://www.youtube.com/@Saine_Ginjo",                    # 銀城サイネ
    "https://www.youtube.com/@Chise_Tatsumaki",                # 龍巻ちせ

    # --- VSPO! EN ---
    "https://www.youtube.com/@RemiaAotsuki",                   # Remia Aotsuki
    "https://www.youtube.com/@AryaKuroha",                     # Arya Kuroha
    "https://www.youtube.com/@jirajisaki",                     # Jira Jisaki
    "https://www.youtube.com/@narinmikure",                    # Narin Mikure
    "https://www.youtube.com/@rikosolari",                     # Riko Solari
    "https://www.youtube.com/@erissuzukami",                   # Eris Suzukami
    "https://www.youtube.com/@JunoUmezono",                    # Juno Umezono

    # --- 公式チャンネル ---
    "https://www.youtube.com/@Vspo77",                         # ぶいすぽっ！公式
    "https://www.youtube.com/@VSPO-EN",                        # VSPO! EN Official
]
CLIP_QUERIES = ["ぶいすぽ 切り抜き", "VSPO 切り抜き"]

FEED_DATA = {
    "official": [],
    "clips": [],
    "is_building": True,
    "last_updated": None,
    "last_error": None,
}
feed_lock = threading.Lock()


def _snapshot_feed_data() -> Dict[str, Any]:
    with feed_lock:
        return {
            "official": list(FEED_DATA["official"]),
            "clips": list(FEED_DATA["clips"]),
            "is_building": FEED_DATA["is_building"],
            "last_updated": FEED_DATA["last_updated"],
            "last_error": FEED_DATA["last_error"],
        }


def _set_feed_building(is_building: bool) -> None:
    with feed_lock:
        FEED_DATA["is_building"] = is_building


def _mark_feed_error(error: Exception) -> None:
    # 例外文字列には内部パスやURLが混入し得るため、クライアントへは種別のみ返す
    logger.warning("Feed build failed: %s", error)
    with feed_lock:
        FEED_DATA["is_building"] = False
        FEED_DATA["last_error"] = type(error).__name__


def _replace_feed_data(
    official: List[Dict[str, Any]],
    clips: List[Dict[str, Any]],
    is_building: bool = False,
) -> None:
    with feed_lock:
        FEED_DATA["official"] = _dedupe_by_video_id(official)
        FEED_DATA["clips"] = _dedupe_by_video_id(clips)
        FEED_DATA["is_building"] = is_building
        FEED_DATA["last_updated"] = datetime.now().isoformat()
        FEED_DATA["last_error"] = None


def _extract_entries(ydl: yt_dlp.YoutubeDL, url: str) -> Dict[str, Any]:
    try:
        return ydl.extract_info(url, download=False) or {}
    except Exception as error:
        logger.warning("Failed to extract %s: %s", url, error)
        return {}


def _collect_channel_items(
    channel_url: str,
    ydl_opts: Dict[str, Any],
) -> List[Dict[str, Any]]:
    recent_timestamps = _load_recent_published_timestamps(
        _extract_channel_id(channel_url)
    )
    channel_items: List[Dict[str, Any]] = []
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        for tab_url in [f"{channel_url}/streams", f"{channel_url}/videos"]:
            info = _extract_entries(ydl, tab_url)
            from_streams_tab = tab_url.endswith("/streams")
            for entry in info.get("entries", []):
                item = _extract_video_item(
                    entry,
                    info.get("title"),
                    from_streams_tab=from_streams_tab,
                    published_timestamps=recent_timestamps,
                )
                if item:
                    channel_items.append(item)
    return channel_items


def _merge_video_detail(
    detail_ydl: yt_dlp.YoutubeDL,
    entry: Dict[str, Any],
) -> Dict[str, Any]:
    video_id = _safe_str(entry.get("id")).strip()
    if not video_id:
        return entry

    detail = _extract_entries(
        detail_ydl,
        f"https://www.youtube.com/watch?v={video_id}",
    )
    return {**entry, **detail} if detail else entry


def _fetch_video_detail(item: Dict[str, Any]) -> Dict[str, Any]:
    detail_ydl_opts = {
        "quiet": True,
        "skip_download": True,
        "ignoreerrors": True,
    }
    with yt_dlp.YoutubeDL(detail_ydl_opts) as detail_ydl:
        return _merge_video_detail(
            detail_ydl,
            {"id": _safe_str(item.get("video_id")).strip()},
        )


def _refine_recent_stream_details(
    items: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for item in items:
        if not item.get("from_streams_tab"):
            continue
        grouped.setdefault(_safe_str(item.get("uploader")), []).append(item)

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
        for detail in executor.map(_fetch_video_detail, candidates):
            video_id = _safe_str(detail.get("id")).strip()
            if video_id:
                detail_by_id[video_id] = detail

    refined_items = []
    for item in items:
        detail = detail_by_id.get(_safe_str(item.get("video_id")))
        if not detail:
            refined_items.append(item)
            continue

        live_status = _safe_str(detail.get("live_status")).lower()
        refined_item = {
            **item,
            "is_live": live_status == "is_live",
            "is_upcoming": live_status == "is_upcoming",
            "is_live_archive": live_status == "was_live"
            or (item.get("from_streams_tab") and live_status not in {"is_live", "is_upcoming"}),
        }
        if detail.get("release_timestamp"):
            refined_item["timestamp"] = float(detail["release_timestamp"])
        refined_items.append(refined_item)
    return refined_items


def background_worker():
    time.sleep(INITIAL_REFRESH_DELAY_SECONDS)
    base_ydl_opts = {
        "quiet": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "noplaylist": True,
        "ignoreerrors": True,
        "playlistend": 100,
        "socket_timeout": YT_SOCKET_TIMEOUT_SECONDS,
    }
    while True:
        cycle_ok = False
        _set_feed_building(True)
        try:
            temp_official: List[Dict[str, Any]] = []
            with ThreadPoolExecutor(max_workers=CHANNEL_FETCH_WORKERS) as executor:
                # yt-dlp は渡された params dict を書き換えるため、必ずスレッド毎にコピーする
                futures = {
                    executor.submit(_collect_channel_items, url, dict(base_ydl_opts)): url
                    for url in TARGET_CHANNELS
                }
                deadline = time.monotonic() + BACKGROUND_CYCLE_TIMEOUT_SECONDS
                for future, url in futures.items():
                    remaining = max(0.0, deadline - time.monotonic())
                    try:
                        temp_official.extend(future.result(timeout=remaining))
                    except FuturesTimeoutError:
                        logger.warning("Channel fetch timed out, skipped: %s", url)
                        future.cancel()
                    except Exception as error:
                        logger.warning("Channel fetch failed %s: %s", url, error)

            temp_clips: List[Dict[str, Any]] = []
            with yt_dlp.YoutubeDL(dict(base_ydl_opts)) as ydl:
                for query in CLIP_QUERIES:
                    info = _extract_entries(ydl, f"ytsearch30:{query}")
                    for entry in info.get("entries", []):
                        item = _extract_video_item(entry)
                        if item:
                            temp_clips.append(item)

            _replace_feed_data(temp_official, temp_clips, is_building=True)
            refined_official = _refine_recent_stream_details(temp_official)
            _replace_feed_data(refined_official, temp_clips)
            cycle_ok = True
        except Exception as error:
            logger.exception("Background worker error")
            _mark_feed_error(error)

        time.sleep(BACKGROUND_REFRESH_SECONDS if cycle_ok else BACKGROUND_ERROR_BACKOFF_SECONDS)

@asynccontextmanager
async def lifespan(_app: FastAPI):
    worker = threading.Thread(target=background_worker, daemon=True)
    worker.start()
    yield

app = FastAPI(title="VSPO Client API", version=API_VERSION, lifespan=lifespan)


@app.middleware("http")
async def add_request_id(request: Request, call_next):
    request.state.request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    response = await call_next(request)
    response.headers["X-Request-ID"] = request.state.request_id
    return response

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["Authorization", "X-API-Key", "X-Request-ID", "Content-Type"],
)


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    status_code = exc.status_code
    if status_code == 401:
        code = "UNAUTHORIZED"
    elif status_code == 404:
        code = "NOT_FOUND"
    elif 400 <= status_code < 500:
        code = "VALIDATION_ERROR"
    else:
        code = "INTERNAL_ERROR"
    return JSONResponse(
        status_code=status_code,
        content=_error_payload(code, str(exc.detail), _request_id(request)),
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content=_error_payload(
            "VALIDATION_ERROR",
            "Invalid request",
            _request_id(request),
            details=exc.errors(),
        ),
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled API error")
    return JSONResponse(
        status_code=500,
        content=_error_payload(
            "INTERNAL_ERROR",
            "Internal server error",
            _request_id(request),
        ),
    )


@app.get("/")
@app.get("/api/v1/health")
def read_root():
    return {
        "status": "success",
        "service": SERVICE_NAME,
        "version": API_VERSION,
        "message": "VSPO Client API is running perfectly!",
    }


@app.get("/api/v1/feed", dependencies=[Depends(require_api_key)])
@app.get("/api/feed", dependencies=[Depends(require_api_key)], include_in_schema=False)
def get_feed(request: Request, response: Response):
    payload = {"status": "success", "data": _snapshot_feed_data()}
    etag = '"{}"'.format(
        hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
    )
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    response.headers["ETag"] = etag
    return payload


def _get_video_comments(video_id: str, limit: int) -> Dict[str, Any]:
    validated_video_id = validate_video_id(video_id)
    bounded_limit = max(0, min(limit, MAX_COMMENTS_LIMIT))
    cache_key = f"{validated_video_id}:{bounded_limit}"

    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    ydl_opts = {
        "quiet": True,
        "skip_download": True,
        "getcomments": bounded_limit > 0,
        "ignoreerrors": True,
        "socket_timeout": YT_SOCKET_TIMEOUT_SECONDS,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = (
                ydl.extract_info(
                    f"https://www.youtube.com/watch?v={validated_video_id}",
                    download=False,
                )
                or {}
            )
    except Exception as error:
        logger.warning("Failed to fetch comments for %s: %s", validated_video_id, error)
        raise HTTPException(status_code=502, detail="Failed to fetch YouTube comments")

    comments = [
        {
            "author": _safe_str(comment.get("author"), "名無し"),
            "text": _safe_str(comment.get("text")),
            "author_thumbnail": _safe_str(comment.get("author_thumbnail")) or DEFAULT_AVATAR_URL,
        }
        for comment in (info.get("comments") or [])[:bounded_limit]
    ]
    payload = {
        "status": "success",
        "video_id": validated_video_id,
        "results": comments,
        "description": _safe_str(info.get("description")),
    }
    _cache_put(cache_key, payload)
    return payload


async def _get_video_comments_guarded(video_id: str, limit: int) -> Dict[str, Any]:
    # 同期スクレイプが Starlette の共有スレッドプールを食い潰さないよう同時実行数を絞る
    try:
        await asyncio.wait_for(comments_semaphore.acquire(), timeout=10)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="Server busy, retry later")
    try:
        return await run_in_threadpool(_get_video_comments, video_id, limit)
    finally:
        comments_semaphore.release()


@app.get(
    "/api/v1/videos/{video_id}/comments",
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
)
async def get_video_comments(
    video_id: str,
    limit: int = Query(default=20, ge=0, le=MAX_COMMENTS_LIMIT),
):
    return await _get_video_comments_guarded(video_id, limit)


@app.get(
    "/comments",
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    include_in_schema=False,
)
async def get_comments(
    video_id: str,
    limit: int = Query(default=20, ge=0, le=MAX_COMMENTS_LIMIT),
):
    return await _get_video_comments_guarded(video_id, limit)

async def _live_chat_ws(websocket: WebSocket, video_id: str):
    # accept 前に検証し、未認証・不正IDにはハンドシェイクを成立させない
    if API_KEY:
        provided = websocket.query_params.get("api_key") or websocket.headers.get("x-api-key")
        if not _constant_time_equals(provided, API_KEY):
            await websocket.close(code=1008)
            return

    if not _is_valid_youtube_video_id(video_id):
        await websocket.close(code=1008)
        return

    if live_chat_semaphore.locked():
        await websocket.close(code=1013)  # Try Again Later
        return

    await live_chat_semaphore.acquire()
    chat = None
    try:
        await websocket.accept()
        chat = await run_in_threadpool(pytchat.create, video_id)
        while True:
            is_alive = await run_in_threadpool(chat.is_alive)
            if not is_alive:
                break
            items = await run_in_threadpool(lambda: chat.get().sync_items())
            for comment in items:
                await websocket.send_json(
                    {
                        "author": comment.author.name,
                        "text": comment.message,
                        "author_thumbnail": comment.author.imageUrl or DEFAULT_AVATAR_URL,
                        "timestamp": comment.datetime,
                    }
                )
            await asyncio.sleep(1.5)
    except WebSocketDisconnect:
        pass
    except Exception as error:
        logger.warning("Chat error for %s: %s", video_id, error)
        try:
            await websocket.close(code=1011)
        except RuntimeError:
            pass
    finally:
        if chat:
            try:
                await run_in_threadpool(chat.terminate)
            except Exception:
                logger.debug("Failed to terminate pytchat for %s", video_id, exc_info=True)
        live_chat_semaphore.release()


@app.websocket("/api/v1/ws/live-chat/{video_id}")
async def live_chat_ws_v1(websocket: WebSocket, video_id: str):
    await _live_chat_ws(websocket, video_id)


@app.websocket("/ws/live-chat/{video_id}")
async def live_chat_ws(websocket: WebSocket, video_id: str):
    await _live_chat_ws(websocket, video_id)

# API キー設定時は静的フロントを無認証で配らない（明示オプトインのみ）
SERVE_FRONTEND = os.environ.get("VSPO_SERVE_FRONTEND", "").strip() == "1" or not API_KEY
if FRONTEND_DIR.exists() and SERVE_FRONTEND:
    app.mount("/app", StaticFiles(directory=FRONTEND_DIR, html=True), name="app")


def _resolve_bind(argv: List[str]) -> Tuple[str, int]:
    port = 8010
    host = "127.0.0.1"  # 既定はループバック。外部公開は明示指定を必須にする
    if len(argv) > 1:
        try:
            port = int(argv[1])
        except ValueError:
            logger.warning("Invalid port %r, falling back to %d", argv[1], port)
    if len(argv) > 2 and argv[2].strip():
        host = argv[2].strip()
    return host, port


if __name__ == "__main__":
    bind_host, bind_port = _resolve_bind(sys.argv)
    is_public_bind = bind_host not in {"127.0.0.1", "localhost", "::1"}
    if is_public_bind and not API_KEY:
        if os.environ.get("VSPO_ALLOW_INSECURE_BIND", "").strip() != "1":
            logger.error(
                "Refusing to bind %s without VSPO_API_KEY. "
                "Set VSPO_API_KEY, or set VSPO_ALLOW_INSECURE_BIND=1 to override.",
                bind_host,
            )
            sys.exit(1)
        logger.warning("Binding %s WITHOUT authentication (explicitly allowed).", bind_host)

    logger.info("Starting server on %s:%d", bind_host, bind_port)
    uvicorn.run(app, host=bind_host, port=bind_port)
