"""アプリケーション全体の設定値。

環境変数の読み取りはこのモジュールに閉じ込める。他の層は os.environ を直接
参照せず、ここで名前の付いた定数を受け取る。設定の一覧性が上がり、
テスト時に差し替える箇所も一箇所で済む。
"""

import logging
import os
import re
import sys
from pathlib import Path
from typing import List, Optional

# --- サービス識別 ---
API_VERSION = "3.2.0"
SERVICE_NAME = "vspo-client-api"

# --- 認証 ---
API_KEY = os.environ.get("VSPO_API_KEY", "").strip()
WS_AUTH_TIMEOUT_SECONDS = 5.0
MIN_API_KEY_LENGTH = 32
MAX_API_KEY_LENGTH = 512
WEAK_API_KEYS = {"change-me", "changeme", "replace-me", "secret", "password"}

# --- CORS ---
DEFAULT_ALLOWED_ORIGINS = [
    # Capacitor (Android) の WebView オリジン。androidScheme は capacitor.config.json 参照。
    "http://localhost",
    "https://localhost",
    "capacitor://localhost",
]


def _split_env_list(name: str, default: List[str]) -> List[str]:
    raw_value = os.environ.get(name, "").strip()
    if not raw_value:
        return default
    return [item.strip() for item in raw_value.split(",") if item.strip()]


ALLOWED_ORIGINS = _split_env_list("VSPO_ALLOWED_ORIGINS", DEFAULT_ALLOWED_ORIGINS)
DEFAULT_ALLOWED_ORIGIN_REGEX = (
    r"^http://(127\.0\.0\.1|localhost)(:\d+)?$"
)
ALLOWED_ORIGIN_REGEX: Optional[str] = (
    os.environ.get("VSPO_ALLOWED_ORIGIN_REGEX", "").strip()
    or DEFAULT_ALLOWED_ORIGIN_REGEX
)


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw_value = os.environ.get(name, str(default)).strip()
    try:
        value = int(raw_value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _env_bool(name: str, default: bool = False) -> bool:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default
    normalized = raw_value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be a boolean")

# --- 収集ワーカー ---
BACKGROUND_REFRESH_SECONDS = _env_int("VSPO_REFRESH_SECONDS", 600, 30, 86400)
NEW_VIDEO_DISCOVERY_SECONDS = _env_int(
    "VSPO_DISCOVERY_SECONDS", 60, 30, 3600
)
INITIAL_REFRESH_DELAY_SECONDS = 2
STREAM_DETAIL_LIMIT_PER_CHANNEL = _env_int(
    "VSPO_STREAM_DETAIL_LIMIT_PER_CHANNEL", 0, 0, 20
)
STREAM_DETAIL_WORKERS = _env_int("VSPO_STREAM_DETAIL_WORKERS", 4, 1, 16)
CHANNEL_FETCH_WORKERS = 6
# RSS で見つけた新着を、yt-dlp のチャンネル一覧が追いつくまで保持する猶予。
# 一覧側の反映は遅れるので、フル更新の結果だけを信じると新着が消えたり
# 出たりする。逆に無期限に保持すると、削除・非公開化された動画が毎周期
# フィードへ戻り続ける。フル更新 2 周期ぶんを上限にして両方を防ぐ。
DISCOVERY_OVERLAY_TTL_SECONDS = max(2 * BACKGROUND_REFRESH_SECONDS, 1800)

# --- コメント取得 ---
MAX_COMMENTS_LIMIT = 100
COMMENTS_CACHE_TTL_SECONDS = _env_int(
    "VSPO_COMMENTS_CACHE_TTL", 300, 1, 86400
)
COMMENTS_CACHE_MAX_ENTRIES = 256
# 同時に走らせる yt-dlp 抽出の上限。スレッドプール枯渇を防ぐ
MAX_CONCURRENT_EXTRACTIONS = _env_int("VSPO_MAX_EXTRACTIONS", 4, 1, 32)
# 同一動画への同時要求を 1 回の抽出へ集約するための待ち時間。
# 抽出の完了まで待たせると、待機中のリクエストが sync エンドポイント用
# スレッドプールを占有し、/feed や /health まで巻き添えで止まる。
# 短く待って諦め、503 + Retry-After で客に返す方が全体の可用性は高い。
COMMENTS_SINGLEFLIGHT_WAIT_SECONDS = 0.5

# --- 配信ストリーム解決 ---
# 解決した HLS マニフェストは数時間で失効する URL を含む。長く持つと
# 失効済みを配ることになるため、連打を吸収できる程度の短命に留める。
STREAM_CACHE_TTL_SECONDS = _env_int("VSPO_STREAM_CACHE_TTL", 60, 1, 3600)
STREAM_CACHE_MAX_ENTRIES = 64

# --- レート制限 ---
RATE_LIMIT_WINDOW_SECONDS = 60
# yt-dlp を起動する抽出系（コメント・ストリーム解決）の上限。
RATE_LIMIT_MAX_REQUESTS = _env_int("VSPO_RATE_LIMIT_PER_MIN", 20, 1, 10000)
# フィード配信は抽出系と別バケットにする。クライアントは is_building 中
# 5 秒間隔でポーリングするので毎分 12 回に達し、単一バケットだと
# コメント取得の枠を食い潰して誤爆する。フィードは事前シリアライズ済み
# + ETag で 1 リクエストが安いため、抽出系より緩くできる。
FEED_RATE_LIMIT_MAX_REQUESTS = _env_int(
    "VSPO_FEED_RATE_LIMIT_PER_MIN", 60, 1, 10000
)
# 保持するクライアント識別子の最大数。上限に達すると LRU で追い出すため、
# 追い出された分の制限はリセットされる。読み取りAPIを公開で運用する構成では
# 同時クライアント数が増えるので、追い出しが常態化しない値にしておく。
# バケットごとに独立した辞書を持つので、実メモリはこの 2 倍が上限。
RATE_LIMIT_MAX_CLIENTS = _env_int("VSPO_RATE_LIMIT_MAX_CLIENTS", 16384, 128, 65536)
WS_RATE_LIMIT_MAX_CONNECTIONS = _env_int(
    "VSPO_WS_CONNECTIONS_PER_MIN", 30, 1, 1000
)
# 同時に開けるライブチャットのルーム数（＝pytchat セッション数）の上限。
# 毎分の接続試行だけを絞っても、別々の動画IDで張り続けられればルームは
# 際限なく増える。各ルームが 1.5 秒周期でスレッドを使うため、既定の
# executor が飽和して全ルームのチャットが止まる。
WS_MAX_ROOMS = _env_int("VSPO_WS_MAX_ROOMS", 64, 1, 4096)
# 1 クライアント（＝レート制限キー単位）が同時に開けるライブチャットの
# ルーム数。WS_MAX_ROOMS はプロセス全体の合計上限なので、これが無いと
# 1 人が別々の video_id で全枠を占有し、他の視聴者のチャットを止められる。
WS_MAX_ROOMS_PER_CLIENT = _env_int("VSPO_WS_MAX_ROOMS_PER_CLIENT", 5, 1, 256)
# cloudflared が同一ホストから接続する構成でのみ有効にする。
# 無条件にプロキシヘッダーを信頼すると、直接接続したクライアントがIPを詐称できる。
TRUST_CLOUDFLARE_HEADERS = _env_bool("VSPO_TRUST_CLOUDFLARE_HEADERS", False)
# TRUST_CLOUDFLARE_HEADERS 有効時でも、CF-Connecting-IP を信頼するのは
# 「直接の TCP ピアがこのリストに属する」場合だけにする。cloudflared は
# 同一ホストのループバックから 8010 へ繋ぐので既定はループバックのみ。
# これを検証しないと、nginx:80 等でバックエンドに直接届く経路から
# CF-Connecting-IP を偽装してレート制限キーを乗っ取れてしまう。
def _parse_networks(name: str, default: List[str]) -> list:
    import ipaddress

    raw = _split_env_list(name, default)
    networks = []
    for item in raw:
        try:
            networks.append(ipaddress.ip_network(item, strict=False))
        except ValueError as error:
            raise RuntimeError(f"{name} contains an invalid CIDR: {item}") from error
    return networks


TRUSTED_PROXY_NETWORKS = _parse_networks(
    "VSPO_TRUSTED_PROXY_NETWORKS", ["127.0.0.0/8", "::1/128"]
)

# --- 外部 I/O ---
UPSTREAM_SOCKET_TIMEOUT_SECONDS = _env_int(
    "VSPO_UPSTREAM_TIMEOUT_SECONDS", 20, 3, 120
)
UPSTREAM_RETRIES = _env_int("VSPO_UPSTREAM_RETRIES", 2, 0, 10)

# --- YouTube ---
MEMBER_ONLY_KEYWORDS = ["メンバー限定", "メン限", "Member-only", "Membership"]
DEFAULT_AVATAR_URL = (
    "https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y"
)
YT_THUMBNAIL_TEMPLATE = "https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
YOUTUBE_VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")
YOUTUBE_CHANNEL_ID_PATTERN = re.compile(
    r"(?:.*/channel/)?(?P<channel_id>UC[A-Za-z0-9_-]{22})$"
)
YOUTUBE_FEED_URL_TEMPLATE = (
    "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
)

# --- 起動ガード ---
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
ALLOW_INSECURE_BIND = os.environ.get("VSPO_ALLOW_INSECURE_BIND") == "1"

# --- パス ---
# BASE_DIR は「バックエンド本体が置かれているディレクトリ」。
# 開発時は src/backend/、PyInstaller 版は exe の隣、本番は配置先ディレクトリ。
if getattr(sys, "frozen", False):
    BASE_DIR = Path(sys.executable).parent
else:
    BASE_DIR = Path(__file__).resolve().parent


def _resolve_frontend_dir() -> Optional[Path]:
    """/app で配信する UI のディレクトリを決める。

    親ディレクトリを無条件に探索してはならない。本番は main.py と config.py を
    配置先ディレクトリ直下へ平置きする構成なので、「1 つ上の frontend/」は
    ホームディレクトリ配下を指してしまう。StaticFiles のマウントは認証を
    通さないため、そこに無関係な frontend/ があると無認証で公開される。
    """
    override = os.environ.get("VSPO_FRONTEND_DIR", "").strip()
    if override:
        return Path(override).expanduser()

    packaged = BASE_DIR / "frontend"
    if packaged.is_dir():
        return packaged

    # 開発時のリポジトリ構成 (src/backend/ と src/frontend/) だけを特別扱いする
    if BASE_DIR.name == "backend" and BASE_DIR.parent.name == "src":
        repository_frontend = BASE_DIR.parent / "frontend"
        if repository_frontend.is_dir():
            return repository_frontend

    return None


FRONTEND_DIR: Optional[Path] = _resolve_frontend_dir()
_feed_cache_path = os.environ.get("VSPO_FEED_CACHE_PATH", "").strip()
FEED_CACHE_PATH: Optional[Path] = (
    Path(_feed_cache_path).expanduser() if _feed_cache_path else None
)


def configure_logging() -> logging.Logger:
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(message)s")
    # httpx logs full request URLs at INFO, including query-string credentials
    # used by upstream services. Keep application lifecycle logs while ensuring
    # those values never land in production journals.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    return logging.getLogger("vspo-client")


logger = configure_logging()


def validate_security_config() -> None:
    """起動前に危険な認証設定を fail closed で拒否する。"""
    if not API_KEY:
        return
    if (
        len(API_KEY) < MIN_API_KEY_LENGTH
        or len(API_KEY) > MAX_API_KEY_LENGTH
        or API_KEY.lower() in WEAK_API_KEYS
    ):
        raise SystemExit(
            "VSPO_API_KEY must be a random value between "
            f"{MIN_API_KEY_LENGTH} and {MAX_API_KEY_LENGTH} characters."
        )
