"""公開読み取り API の振る舞い。

キーを配らずに「みんなが使える」状態にした結果を固定する。ここが 401 に
戻ると、全利用者へ同じキーを配る運用に逆戻りすることになる。
"""


def test_health_is_public(client):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["service"] == "vspo-client-api"


def test_feed_is_public_without_credentials(client):
    assert client.get("/api/v1/feed").status_code == 200


def test_legacy_feed_alias_is_public(client):
    assert client.get("/api/feed").status_code == 200


def test_readiness_is_public(client):
    # 中身は起動直後なので 503 だが、401 ではない（監視から使える）
    assert client.get("/api/v1/readiness").status_code == 503


def test_feed_is_gzipped_with_vary(client):
    response = client.get("/api/v1/feed", headers={"Accept-Encoding": "gzip"})
    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"
    assert response.headers["vary"] == "Accept-Encoding"


def test_feed_falls_back_to_identity(client):
    response = client.get("/api/v1/feed", headers={"Accept-Encoding": "identity"})
    assert response.status_code == 200
    assert "content-encoding" not in response.headers
    # Vary は「表現が分岐する」事実そのものなので、非圧縮でも付いていること。
    # 非圧縮経路では GZipMiddleware 側が足す（get_feed のコメント参照）。
    # 重複していないことも同時に確認する。
    assert response.headers["vary"] == "Accept-Encoding"


def test_feed_etag_returns_304(client):
    first = client.get("/api/v1/feed")
    etag = first.headers["etag"]
    assert etag

    second = client.get("/api/v1/feed", headers={"If-None-Match": etag})
    assert second.status_code == 304
    assert second.content == b""
    assert second.headers["etag"] == etag


def test_feed_etag_accepts_a_list_of_tags(client):
    etag = client.get("/api/v1/feed").headers["etag"]
    response = client.get(
        "/api/v1/feed", headers={"If-None-Match": f'W/"other", {etag}'}
    )
    assert response.status_code == 304


def test_gzip_and_identity_share_one_etag(client):
    """弱い ETag + Vary で区別する設計なので、表現ごとに変えない。"""
    gzipped = client.get("/api/v1/feed", headers={"Accept-Encoding": "gzip"})
    identity = client.get("/api/v1/feed", headers={"Accept-Encoding": "identity"})
    assert gzipped.headers["etag"] == identity.headers["etag"]


def test_request_id_is_echoed(client):
    response = client.get("/api/v1/health", headers={"X-Request-ID": "abc-123"})
    assert response.headers["x-request-id"] == "abc-123"


def test_request_id_is_generated_when_absent(client):
    assert client.get("/api/v1/health").headers["x-request-id"]
