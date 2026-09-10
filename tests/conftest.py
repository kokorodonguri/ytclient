"""テスト用のアプリ組み立て。

backend/ は「起動時に環境変数を読む」設計になっている。config.py は import 時に
os.environ を読み、deps.py と ws_routes.py はモジュール読み込み時にレート
リミッタを生成する。したがってテストごとに設定を変えるには、モジュールを
捨てて再 import する必要がある。副作用としてレート制限のカウンタも初期化され、
テスト間の干渉が無くなる。
"""

import importlib
import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# backend/ 側のトップレベルパッケージ名。再 import の対象を絞るために使う。
_BACKEND_PACKAGES = {
    "config",
    "main",
    "domain",
    "infrastructure",
    "application",
    "interfaces",
}


def purge_backend_modules() -> None:
    for name in [m for m in sys.modules if m.split(".")[0] in _BACKEND_PACKAGES]:
        del sys.modules[name]


@pytest.fixture
def build_app(monkeypatch):
    """VSPO_* を白紙にし、渡された環境変数でアプリを組み立てて返す。

    テストを実行する開発機の環境変数が結果を変えないよう、既存の VSPO_* は
    すべて外してから始める。
    """
    for key in [k for k in os.environ if k.startswith("VSPO_")]:
        monkeypatch.delenv(key, raising=False)

    def factory(**env):
        for name, value in env.items():
            monkeypatch.setenv(name, str(value))
        purge_backend_modules()
        return importlib.import_module("main").app

    yield factory
    # 次のテストが素の sys.modules から始められるようにする
    purge_backend_modules()


@pytest.fixture
def make_client(build_app):
    """TestClient を返すファクトリ。

    lifespan は起動しない（`with` を使わない）。起動すると FeedCollector が
    実際に YouTube を叩き始めてしまう。
    """
    from starlette.testclient import TestClient

    def factory(**env):
        return TestClient(build_app(**env))

    return factory


@pytest.fixture
def client(make_client):
    """既定構成（APIキー無し = 公開読み取り）のクライアント。"""
    return make_client()


@pytest.fixture
def api_key():
    return "t" * 48
