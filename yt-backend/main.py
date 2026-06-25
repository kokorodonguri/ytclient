import asyncio
import logging
import os
import re
import sys
import threading
import time
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytchat
import uvicorn
import yt_dlp
from fastapi.concurrency import run_in_threadpool
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

# --- 設定 ---
API_VERSION = "3.2.0"
SERVICE_NAME = "vspo-client-api"
API_KEY = os.environ.get("VSPO_API_KEY", "").strip()
MEMBER_ONLY_KEYWORDS = ["メンバー限定", "メン限", "Member-only", "Membership"]
DEFAULT_AVATAR_URL = "https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y"
YT_THUMBNAIL_TEMPLATE = "https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
BACKGROUND_REFRESH_SECONDS = 600
INITIAL_REFRESH_DELAY_SECONDS = 2
MAX_COMMENTS_LIMIT = 100
STREAM_DETAIL_LIMIT_PER_CHANNEL = 5
STREAM_DETAIL_WORKERS = 8
CHANNEL_FETCH_WORKERS = 6
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


def require_api_key(
    authorization: Optional[str] = Header(default=None),
    x_api_key: Optional[str] = Header(default=None),
) -> None:
    if not API_KEY:
        return

    bearer_prefix = "Bearer "
    bearer_token = (
        authorization[len(bearer_prefix) :].strip()
        if authorization and authorization.startswith(bearer_prefix)
        else ""
    )
    if x_api_key == API_KEY or bearer_token == API_KEY:
        return
    raise HTTPException(status_code=401, detail="Missing or invalid API key")


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
            root = ET.fromstring(response.read())
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
    with feed_lock:
        FEED_DATA["is_building"] = False
        FEED_DATA["last_error"] = str(error)


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
    ydl_opts = {
        "quiet": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "noplaylist": True,
        "ignoreerrors": True,
        "playlistend": 100,
    }
    while True:
        _set_feed_building(True)
        try:
            temp_official = []
            with ThreadPoolExecutor(max_workers=CHANNEL_FETCH_WORKERS) as executor:
                for channel_items in executor.map(
                    lambda url: _collect_channel_items(url, ydl_opts),
                    TARGET_CHANNELS,
                ):
                    temp_official.extend(channel_items)

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                temp_clips = []
                for q in CLIP_QUERIES:
                    info = _extract_entries(ydl, f"ytsearch30:{q}")
                    for e in info.get("entries", []):
                        item = _extract_video_item(e)
                        if item:
                            temp_clips.append(item)

            _replace_feed_data(temp_official, temp_clips, is_building=True)
            refined_official = _refine_recent_stream_details(temp_official)
            _replace_feed_data(refined_official, temp_clips)
        except Exception as e:
            logger.exception("Background worker error")
            _mark_feed_error(e)

        time.sleep(BACKGROUND_REFRESH_SECONDS)

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
    allow_origins=[
        "null",
        "http://127.0.0.1:8000",
        "http://localhost:8000",
    ],
    allow_origin_regex=r"^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d+)?$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
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
def get_feed():
    return {"status": "success", "data": _snapshot_feed_data()}


def _get_video_comments(video_id: str, limit: int) -> Dict[str, Any]:
    validated_video_id = validate_video_id(video_id)
    bounded_limit = max(0, min(limit, MAX_COMMENTS_LIMIT))
    ydl_opts = {
        "quiet": True,
        "skip_download": True,
        "getcomments": True,
        "ignoreerrors": True,
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
            raw_comments = info.get("comments", [])
            comments = []
            for c in raw_comments[:bounded_limit]:
                comments.append(
                    {
                        "author": _safe_str(c.get("author"), "名無し"),
                        "text": _safe_str(c.get("text")),
                        "author_thumbnail": _safe_str(c.get("author_thumbnail"))
                        or DEFAULT_AVATAR_URL,
                    }
                )
            return {
                "status": "success",
                "video_id": validated_video_id,
                "results": comments,
                "description": _safe_str(info.get("description")),
            }
    except Exception as e:
        logger.warning("Failed to fetch comments for %s: %s", validated_video_id, e)
        raise HTTPException(status_code=502, detail="Failed to fetch YouTube comments")


@app.get("/api/v1/videos/{video_id}/comments", dependencies=[Depends(require_api_key)])
def get_video_comments(
    video_id: str,
    limit: int = Query(default=20, ge=0, le=MAX_COMMENTS_LIMIT),
):
    return _get_video_comments(video_id, limit)


@app.get("/comments", dependencies=[Depends(require_api_key)], include_in_schema=False)
def get_comments(
    video_id: str,
    limit: int = Query(default=20, ge=0, le=MAX_COMMENTS_LIMIT),
):
    return _get_video_comments(video_id, limit)

async def _live_chat_ws(websocket: WebSocket, video_id: str):
    await websocket.accept()
    if API_KEY and websocket.query_params.get("api_key") != API_KEY:
        await websocket.close(code=1008, reason="Missing or invalid API key")
        return

    if not _is_valid_youtube_video_id(video_id):
        await websocket.close(code=1008, reason="Invalid YouTube video ID")
        return

    chat = None
    try:
        chat = await run_in_threadpool(lambda: pytchat.create(video_id=video_id))
        while chat.is_alive():
            items = await run_in_threadpool(
                lambda: chat.get().sync_items() if chat.is_alive() else []
            )
            for c in items:
                await websocket.send_json(
                    {
                        "author": c.author.name,
                        "text": c.message,
                        "author_thumbnail": c.author.imageUrl or DEFAULT_AVATAR_URL,
                        "timestamp": c.datetime,
                    }
                )
            await asyncio.sleep(1.5)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning("Chat error for %s: %s", video_id, e)
        try:
            await websocket.close()
        except RuntimeError:
            pass
    finally:
        if chat:
            await run_in_threadpool(chat.terminate)


@app.websocket("/api/v1/ws/live-chat/{video_id}")
async def live_chat_ws_v1(websocket: WebSocket, video_id: str):
    await _live_chat_ws(websocket, video_id)


@app.websocket("/ws/live-chat/{video_id}")
async def live_chat_ws(websocket: WebSocket, video_id: str):
    await _live_chat_ws(websocket, video_id)

if FRONTEND_DIR.exists():
    app.mount("/app", StaticFiles(directory=FRONTEND_DIR, html=True), name="app")

if __name__ == "__main__":
    port = 8010
    host = "0.0.0.0"
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            pass
    if len(sys.argv) > 2:
        host = sys.argv[2]
    print(f"Starting server on {host}:{port}...")
    uvicorn.run(app, host=host, port=port)
