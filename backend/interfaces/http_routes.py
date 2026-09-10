"""HTTP ルート定義。

ここには「受け取って、ユースケースを呼んで、HTTP に直す」以外を書かない。
"""

from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import JSONResponse, Response

from config import API_VERSION, MAX_COMMENTS_LIMIT, SERVICE_NAME
from application.comments_service import (
    CommentsService,
    ServiceBusyError,
    UpstreamFetchError,
)
from application.feed_store import FeedStore
from application.stream_service import (
    NoStreamError,
    NotLiveError,
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
    def get_feed(if_none_match: Optional[str] = Header(default=None)):
        """事前シリアライズ済みのフィードを返す。

        クライアントは is_building 中 5 秒間隔でポーリングするが、実データが
        変わるのはバックグラウンドワーカーの 1 周期ごと。ETag が一致する間は
        304 を返してボディの転送とクライアント側の JSON パースを丸ごと省く。
        """
        payload, etag = store.response_parts()
        headers = {"ETag": etag, "Cache-Control": "no-cache"}

        if if_none_match and etag in [tag.strip() for tag in if_none_match.split(",")]:
            return Response(status_code=304, headers=headers)

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
        except NotLiveError as error:
            # クライアントはこれを見て外部ブラウザへ誘導する
            raise HTTPException(status_code=409, detail=str(error)) from error
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
