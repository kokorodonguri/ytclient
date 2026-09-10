"""レート制限キーの決定。

CF-Connecting-IP を無条件に信じると、バックエンドへ直接届く経路
(nginx:80 など) からヘッダーを偽装し、リクエストごとにキーを変えて
レート制限を丸ごと無効化できる。直接の TCP ピアが信頼済みかどうかを
必ず併せて検証する。
"""

import importlib

import pytest


@pytest.fixture
def client_key(build_app):
    """設定を反映した client_key() を返す。"""

    def factory(**env):
        build_app(**env)
        return importlib.import_module("interfaces.client_identity").client_key

    return factory


def test_falls_back_to_the_tcp_peer(client_key):
    key = client_key()
    assert key({"cf-connecting-ip": "203.0.113.9"}, "192.168.1.50") == "peer:192.168.1.50"


def test_trusts_cloudflare_header_from_a_trusted_peer(client_key):
    key = client_key(VSPO_TRUST_CLOUDFLARE_HEADERS=1)
    # cloudflared は同一ホストのループバックから繋いでくる
    assert key({"cf-connecting-ip": "203.0.113.9"}, "127.0.0.1") == "cf:203.0.113.9"


def test_ignores_cloudflare_header_from_an_untrusted_peer(client_key):
    key = client_key(VSPO_TRUST_CLOUDFLARE_HEADERS=1)
    spoofed = key({"cf-connecting-ip": "203.0.113.9"}, "192.168.1.50")
    assert spoofed == "peer:192.168.1.50"


def test_rotating_a_spoofed_header_cannot_change_the_key(client_key):
    """偽装で毎回キーが変われば上限は無意味になる。同じキーに落ちること。"""
    key = client_key(VSPO_TRUST_CLOUDFLARE_HEADERS=1)
    keys = {
        key({"cf-connecting-ip": f"203.0.113.{n}"}, "192.168.1.50")
        for n in range(1, 20)
    }
    assert keys == {"peer:192.168.1.50"}


def test_ignores_a_malformed_cloudflare_header(client_key):
    key = client_key(VSPO_TRUST_CLOUDFLARE_HEADERS=1)
    assert key({"cf-connecting-ip": "not-an-ip"}, "127.0.0.1") == "peer:127.0.0.1"


def test_x_forwarded_for_is_never_trusted(client_key):
    """クライアントが自由に送れるヘッダーは使わない。"""
    key = client_key(VSPO_TRUST_CLOUDFLARE_HEADERS=1)
    assert key({"x-forwarded-for": "203.0.113.9"}, "127.0.0.1") == "peer:127.0.0.1"


def test_respects_a_custom_trusted_network(client_key):
    key = client_key(
        VSPO_TRUST_CLOUDFLARE_HEADERS=1,
        VSPO_TRUSTED_PROXY_NETWORKS="10.0.0.0/8",
    )
    assert key({"cf-connecting-ip": "203.0.113.9"}, "10.1.2.3") == "cf:203.0.113.9"
    assert key({"cf-connecting-ip": "203.0.113.9"}, "127.0.0.1") == "peer:127.0.0.1"


def test_unknown_peer_gets_a_stable_key(client_key):
    key = client_key()
    assert key({}, None) == "peer:unknown"
