"""エントリポイント。

起動引数の解釈と bind ガードだけを持つ。アプリの組み立ては
interfaces/app.py の create_app() が行う。

層構成:
    domain/          外部 I/O に依存しない規則（動画の正規化・並び順）
    infrastructure/  yt_dlp / pytchat / HTTP など外部システムへの依存を隔離
    application/     ユースケース（収集ワーカー・フィード保持・コメント取得）
    interfaces/      FastAPI（ルート・依存関係・例外ハンドラ）

依存の向きは interfaces → application → domain の一方向。
domain は他のどの層も知らない。
"""

import sys

import uvicorn

from config import (
    ALLOW_INSECURE_BIND,
    API_KEY,
    LOOPBACK_HOSTS,
    logger,
)
from interfaces.app import create_app

DEFAULT_PORT = 8010
# 既定はループバック。本番は cloudflared が同一ホストからここへ繋ぐ。
# 既定を 0.0.0.0 にすると、引数を省いた起動が「開いた」状態になる。
# guard_public_bind はキー未設定時しか止めないので、既定値自体を閉じておく。
DEFAULT_HOST = "127.0.0.1"

# uvicorn の import 文字列や PyInstaller から参照できるようモジュール属性として公開する。
# API キーの妥当性検証は create_app() の中で行うため、この経路でも必ず走る。
# ただし bind ガード（guard_public_bind）は host を知る main() でしか働かない。
# `uvicorn main:app` で起動する場合は --host を自分でループバックに縛ること。
app = create_app()


def guard_public_bind(host: str) -> None:
    """API キー無しでループバック以外に bind するのを拒否する。

    このサーバは yt-dlp / pytchat を任意の動画 ID に対して実行する。
    キー未設定のまま 0.0.0.0 に晒すと、同一ネットワークの誰でも
    YouTube スクレイピングの踏み台として使えてしまう。
    既定値が「開いている」状態にならないよう、ここで落とす。
    意図的に開放する場合は VSPO_ALLOW_INSECURE_BIND=1 を明示する。
    """
    if host in LOOPBACK_HOSTS or API_KEY:
        return
    if ALLOW_INSECURE_BIND:
        logger.warning(
            "Binding to %s without VSPO_API_KEY (VSPO_ALLOW_INSECURE_BIND=1)", host
        )
        return
    raise SystemExit(
        f"Refusing to bind {host} without VSPO_API_KEY.\n"
        "Set VSPO_API_KEY, or bind 127.0.0.1, or set VSPO_ALLOW_INSECURE_BIND=1 "
        "if you really intend to expose this server unauthenticated."
    )


def parse_args(argv) -> tuple:
    port = DEFAULT_PORT
    host = DEFAULT_HOST
    if len(argv) > 1:
        try:
            port = int(argv[1])
        except ValueError:
            pass
    if len(argv) > 2:
        host = argv[2]
    return host, port


def main(argv=None) -> None:
    host, port = parse_args(argv if argv is not None else sys.argv)
    guard_public_bind(host)
    logger.info("Starting server on %s:%d", host, port)
    # ライブチャットの WebSocket は数時間開いたままになる。既定では uvicorn が
    # その全てが閉じるのを待つため、停止要求が事実上効かない。上限を切って、
    # 残っている接続は落として終了する。
    #
    # 収集ワーカーのスレッドプールは別問題で、詰まった yt-dlp 抽出が 1 件でも
    # あると concurrent.futures の atexit フックがそれを join しようとして
    # インタプリタ終了自体が止まる。そこは unit 側の TimeoutStopSec=20 →
    # SIGKILL が最終的な上限になる。
    uvicorn.run(app, host=host, port=port, timeout_graceful_shutdown=10)


if __name__ == "__main__":
    main()
