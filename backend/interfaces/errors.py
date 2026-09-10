"""エラー応答の形式と例外ハンドラ。

エラーの JSON 形状を 1 箇所で決める。ステータスコードとアプリ内エラーコードの
対応表もここに集約し、ルート側には散らさない。
"""

import uuid
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from config import logger

_STATUS_TO_CODE = {
    401: "UNAUTHORIZED",
    404: "NOT_FOUND",
    429: "RATE_LIMITED",
    502: "UPSTREAM_ERROR",
    503: "SERVICE_UNAVAILABLE",
}


def error_code_for_status(status_code: int) -> str:
    if status_code in _STATUS_TO_CODE:
        return _STATUS_TO_CODE[status_code]
    if 400 <= status_code < 500:
        return "VALIDATION_ERROR"
    return "INTERNAL_ERROR"


def error_payload(
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


def request_id_of(request: Request) -> str:
    return getattr(request.state, "request_id", str(uuid.uuid4()))


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            content=error_payload(
                error_code_for_status(exc.status_code),
                str(exc.detail),
                request_id_of(request),
            ),
            # 429 / 503 の Retry-After はクライアントの再試行制御に必要。
            # ここで渡さないと HTTPException(headers=...) が握り潰される
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request, exc: RequestValidationError
    ):
        return JSONResponse(
            status_code=422,
            content=error_payload(
                "VALIDATION_ERROR",
                "Invalid request",
                request_id_of(request),
                details=exc.errors(),
            ),
        )

    @app.exception_handler(Exception)
    async def generic_exception_handler(request: Request, exc: Exception):
        # request_id をログに載せないと、利用者が持っている X-Request-ID から
        # 該当のスタックトレースを引けない。返すだけでは相関が取れない。
        request_id = request_id_of(request)
        logger.exception(
            "Unhandled API error [request_id=%s] %s %s",
            request_id,
            request.method,
            request.url.path,
        )
        return JSONResponse(
            status_code=500,
            content=error_payload(
                "INTERNAL_ERROR",
                "Internal server error",
                request_id,
            ),
        )
