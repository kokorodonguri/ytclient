"""CORS。

濫用対策ではない（Origin を送らない相手には効かない）。それでも読み取り専用
API に必要なのは GET と 4 つのヘッダーだけなので、ワイルドカードに戻らない
ことを固定する。
"""

CAPACITOR_ORIGIN = "capacitor://localhost"


def test_allows_the_capacitor_origin(client):
    response = client.get("/api/v1/feed", headers={"Origin": CAPACITOR_ORIGIN})
    assert response.headers["access-control-allow-origin"] == CAPACITOR_ORIGIN


def test_allows_a_loopback_origin_on_any_port(client):
    """デスクトップアプリは UI をランダムポートのループバックから配信する。"""
    origin = "http://127.0.0.1:53219"
    response = client.get("/api/v1/feed", headers={"Origin": origin})
    assert response.headers["access-control-allow-origin"] == origin


def test_denies_an_unknown_origin(client):
    response = client.get("/api/v1/feed", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in response.headers


def test_preflight_allows_get(client):
    response = client.options(
        "/api/v1/feed",
        headers={
            "Origin": CAPACITOR_ORIGIN,
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert "GET" in response.headers["access-control-allow-methods"]


def test_preflight_rejects_other_methods(client):
    for method in ["POST", "DELETE", "PUT"]:
        response = client.options(
            "/api/v1/feed",
            headers={
                "Origin": CAPACITOR_ORIGIN,
                "Access-Control-Request-Method": method,
            },
        )
        assert response.status_code == 400, method


def test_preflight_rejects_an_unlisted_header(client):
    response = client.options(
        "/api/v1/feed",
        headers={
            "Origin": CAPACITOR_ORIGIN,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "X-Something-Else",
        },
    )
    assert response.status_code == 400


def test_preflight_allows_the_listed_headers(client):
    response = client.options(
        "/api/v1/feed",
        headers={
            "Origin": CAPACITOR_ORIGIN,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "X-API-Key, Authorization",
        },
    )
    assert response.status_code == 200


def test_a_custom_origin_list_replaces_the_default(make_client):
    client = make_client(VSPO_ALLOWED_ORIGINS="https://youtube.dongurihub.com")
    allowed = client.get(
        "/api/v1/feed", headers={"Origin": "https://youtube.dongurihub.com"}
    )
    assert allowed.headers["access-control-allow-origin"]

    denied = client.get("/api/v1/feed", headers={"Origin": CAPACITOR_ORIGIN})
    assert "access-control-allow-origin" not in denied.headers
