"""HTTP ルート定義。

ここには「受け取って、ユースケースを呼んで、HTTP に直す」以外を書かない。
"""

from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import JSONResponse, Response

from config import (
    API_VERSION,
    MAX_COMMENTS_LIMIT,
    READINESS_MAX_FEED_AGE_SECONDS,
    SERVICE_NAME,
)
from application.comments_service import (
    CommentsService,
    ServiceBusyError,
    UpstreamFetchError,
)
from application.feed_store import FeedStore
from application.stream_service import (
    NoStreamError,
    StreamService,
    UpcomingStreamError,
)
from interfaces.deps import (
    enforce_feed_rate_limit,
    enforce_rate_limit,
    require_api_key,
    validate_video_id,
)


def create_router(
    store: FeedStore, comments: CommentsService, streams: StreamService
) -> APIRouter:
    router = APIRouter()

    @router.get("/")
    @router.get("/api/v1/health")
    def read_root():
        return {
            "status": "success",
            "service": SERVICE_NAME,
            "version": API_VERSION,
            "message": "VSPO Client API is running perfectly!",
        }

    # readiness は認証を課さない。外部の死活監視から使えないと意味がなく、
    # 返すのは件数と劣化状況だけで秘密を含まない。キーを設定した LAN 構成でも
    # 監視できるよう、ここだけは常に公開する。
    @router.get(
        "/api/v1/readiness",
        dependencies=[Depends(enforce_feed_rate_limit)],
    )
    def read_readiness():
        snapshot = store.readiness_snapshot()
        has_feed = bool(
            snapshot["last_updated"]
            and (snapshot["official_count"] or snapshot["clip_count"])
        )
        if not has_feed:
            return JSONResponse(
                status_code=503,
                content={"status": "starting", "data": snapshot},
                headers={"Retry-After": "5"},
            )

        # 「last_updated が入っているか」だけを見ると、収集スレッドが詰まって
        # 更新が止まっても ready を返し続ける。古さそのものを判定に使う。
        age = snapshot["feed_age_seconds"]
        if age is not None and age > READINESS_MAX_FEED_AGE_SECONDS:
            return JSONResponse(
                status_code=503,
                content={"status": "stale", "data": snapshot},
                headers={"Retry-After": "60"},
            )

        status = (
            "degraded"
            if snapshot["last_error"] or snapshot["degraded_channels"]
            else "ready"
        )
        return {"status": status, "data": snapshot}

    # フィードは公開運用（VSPO_API_KEY 未設定）だと誰でも叩けるため、
    # 認証の有無に関わらずレート制限を課す。以前はキーで守られている前提で
    # 上限が無く、公開した時点で無制限の帯域消費経路になっていた。
    @router.get(
        "/api/v1/feed",
        dependencies=[Depends(require_api_key), Depends(enforce_feed_rate_limit)],
    )
    @router.get(
        "/api/feed",
        dependencies=[Depends(require_api_key), Depends(enforce_feed_rate_limit)],
        include_in_schema=False,
    )
    def get_feed(
        if_none_match: Optional[str] = Header(default=None),
        accept_encoding: Optional[str] = Header(default=None),
    ):
        """事前シリアライズ・事前 gzip 済みのフィードを返す。

        クライアントは is_building 中 5 秒間隔でポーリングするが、実データが
        変わるのはバックグラウンドワーカーの 1 周期ごと。ETag が一致する間は
        304 を返してボディの転送とクライアント側の JSON パースを丸ごと省く。

        非 304 のときは事前圧縮した bytes を返す。約 1.5 MB の JSON なので、
        公開運用では非圧縮配信がそのまま帯域になる。
        """
        wants_gzip = "gzip" in (accept_encoding or "").lower()
        payload, etag, is_gzipped = store.response_parts(prefer_gzip=wants_gzip)
        headers = {"ETag": etag, "Cache-Control": "no-cache"}

        # Vary は「自分で Content-Encoding を付けたとき」だけ自分で付ける。
        # GZipMiddleware は Content-Encoding が既に立っている応答を素通しし、
        # そのとき Vary も足さない。逆に非圧縮で返すと middleware 側が
        # add_vary_header で足すので、こちらでも付けると二重になる。
        # （この非対称は starlette の実装依存なので、両方の経路を
        #  tests/test_public_api.py で固定してある）
        if if_none_match and etag in [tag.strip() for tag in if_none_match.split(",")]:
            # 304 は本文を持たないので Content-Encoding は付けない。
            return Response(
                status_code=304, headers={**headers, "Vary": "Accept-Encoding"}
            )

        if is_gzipped:
            headers["Content-Encoding"] = "gzip"
            headers["Vary"] = "Accept-Encoding"

        return Response(
            content=payload,
            media_type="application/json",
            headers=headers,
        )

    def _fetch_comments(video_id: str, limit: int):
        validated = validate_video_id(video_id)
        bounded_limit = max(0, min(limit, MAX_COMMENTS_LIMIT))
        try:
            return comments.get_comments(validated, bounded_limit)
        except ServiceBusyError as error:
            raise HTTPException(
                status_code=503, detail=str(error), headers={"Retry-After": "5"}
            ) from error
        except UpstreamFetchError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @router.get(
        "/api/v1/videos/{video_id}/comments",
        dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    )
    def get_video_comments(
        video_id: str,
        limit: int = Query(default=20, ge=0, le=MAX_COMMENTS_LIMIT),
    ):
        return _fetch_comments(video_id, limit)

    @router.get(
        "/api/v1/videos/{video_id}/stream",
        dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    )
    def get_video_stream(video_id: str):
        """アプリ内ネイティブ再生用の HLS を返す。配信中のみ対象。"""
        validated = validate_video_id(video_id)
        try:
            return streams.get_stream(validated)
        except UpcomingStreamError as error:
            # 409。クライアントはこれを見て「まだ始まっていない」と表示する
            raise HTTPException(
                status_code=409,
                detail="Stream has not started yet",
                headers={"X-Stream-State": "upcoming"},
            ) from error
        except NoStreamError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ServiceBusyError as error:
            raise HTTPException(
                status_code=503, detail=str(error), headers={"Retry-After": "5"}
            ) from error
        except UpstreamFetchError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @router.get(
        "/comments",
        dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
        include_in_schema=False,
    )
    def get_comments(
        video_id: str,
        limit: int = Query(default=20, ge=0, le=MAX_COMMENTS_LIMIT),
    ):
        return _fetch_comments(video_id, limit)

    return router
