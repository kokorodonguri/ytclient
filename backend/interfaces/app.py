"""FastAPI アプリケーションの組み立て。

依存の配線をここ 1 箇所に集約する。各層は自分でシングルトンを掴まず、
組み立て時に渡されたものを使う。
"""

import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
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
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)
    app.include_router(http_routes.create_router(store, comments, streams))
    app.include_router(ws_routes.create_router(chat_hub))

    if FRONTEND_DIR is not None and FRONTEND_DIR.is_dir():
        app.mount("/app", StaticFiles(directory=FRONTEND_DIR, html=True), name="app")

    return app
