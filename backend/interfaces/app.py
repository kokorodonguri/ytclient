"""FastAPI アプリケーションの組み立て。

依存の配線をここ 1 箇所に集約する。各層は自分でシングルトンを掴まず、
組み立て時に渡されたものを使う。
"""

import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from config import (
    ALLOWED_ORIGIN_REGEX,
    ALLOWED_ORIGINS,
    API_VERSION,
    FEED_CACHE_PATH,
    FRONTEND_DIR,
    validate_security_config,
)
from application.channels import TARGET_CHANNELS
from application.collector import FeedCollector
from application.comments_service import CommentsService
from application.feed_store import FeedStore
from application.live_chat_hub import LiveChatHub
from application.stream_service import StreamService
from interfaces import http_routes, ws_routes
from interfaces.errors import register_exception_handlers


def create_app() -> FastAPI:
    # 起動方法によらず必ず通る場所で検証する。main() に置くと
    # `uvicorn interfaces.app:create_app` や `uvicorn main:app` で起動したとき
    # だけ弱い API キーが素通りしてしまう。
    validate_security_config()

    store = FeedStore(
        total_channels=len(TARGET_CHANNELS),
        cache_path=FEED_CACHE_PATH,
    )
    comments = CommentsService()
    streams = StreamService()
    collector = FeedCollector(store)
    # ライブチャットは動画単位で1本の pytchat に集約する。
    # 視聴者ごとにセッションを張ると人数に比例して YouTube への接続が増え、
    # スロットルされて全員のチャットが止まる
    chat_hub = LiveChatHub()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        collector.start()
        try:
            yield
        finally:
            # アプリ終了時にワーカーへ停止シグナルを送信
            collector.stop()
            await chat_hub.shutdown()

    app = FastAPI(title="VSPO Client API", version=API_VERSION, lifespan=lifespan)

    @app.middleware("http")
    async def add_request_id(request: Request, call_next):
        request.state.request_id = request.headers.get("x-request-id") or str(
            uuid.uuid4()
        )
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_origin_regex=ALLOWED_ORIGIN_REGEX,
        allow_credentials=False,
        # Private Network Access: パブリックなオリジン（Cloudflare Tunnel 経由の
        # https ページなど）からプライベート IP のこのサーバーへ到達する場合、
        # ブラウザが preflight で Access-Control-Request-Private-Network を送る。
        # これを許可しないと Chrome 系でブロックされる。
        allow_private_network=True,
        # ワイルドカードにしない。読み取り専用 API なので許すのは GET だけで
        # 足り、ヘッダーもクライアントが実際に送る 4 つに限る。CORS は濫用
        # 対策ではないが、広げる理由が無いものを広げておく意味も無い。
        allow_methods=["GET"],
        allow_headers=["Authorization", "X-API-Key", "X-Request-ID", "Content-Type"],
    )

    # /api/v1/feed は自前で事前 gzip 済み（Content-Encoding 設定済みの応答は
    # GZipMiddleware が素通しする）。ここで効くのは /app 配下の静的ファイルと
    # コメント・ストリームの JSON。
    app.add_middleware(GZipMiddleware, minimum_size=500)

    # 組み立てたものを app に載せておく。運用時の内省と、テストから同じ
    # インスタンスを触るために使う（ルートのクロージャを掘らずに済む）。
    app.state.feed_store = store
    app.state.live_chat_hub = chat_hub
    app.state.feed_collector = collector

    register_exception_handlers(app)
    app.include_router(http_routes.create_router(store, comments, streams))
    app.include_router(ws_routes.create_router(chat_hub))

    if FRONTEND_DIR is not None and FRONTEND_DIR.is_dir():
        app.mount("/app", StaticFiles(directory=FRONTEND_DIR, html=True), name="app")

    return app
