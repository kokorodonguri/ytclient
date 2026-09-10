"""VSPO_API_KEY を設定した構成（LAN へ直接公開する場合など）。

読み取り API は公開が既定だが、キーを設定する選択肢は残してある。
そちらが壊れていないことを固定する。
"""


def test_feed_requires_a_key_when_one_is_configured(make_client, api_key):
    client = make_client(VSPO_API_KEY=api_key)
    assert client.get("/api/v1/feed").status_code == 401


def test_x_api_key_header_is_accepted(make_client, api_key):
    client = make_client(VSPO_API_KEY=api_key)
    response = client.get("/api/v1/feed", headers={"X-API-Key": api_key})
    assert response.status_code == 200


def test_bearer_token_is_accepted(make_client, api_key):
    client = make_client(VSPO_API_KEY=api_key)
    response = client.get(
        "/api/v1/feed", headers={"Authorization": f"Bearer {api_key}"}
    )
    assert response.status_code == 200


def test_wrong_key_is_rejected(make_client, api_key):
    client = make_client(VSPO_API_KEY=api_key)
    response = client.get("/api/v1/feed", headers={"X-API-Key": "x" * 48})
    assert response.status_code == 401


def test_non_ascii_key_is_rejected_with_401_not_500(make_client, api_key):
    """secrets.compare_digest は非 ASCII の str で TypeError を投げる。

    Starlette はヘッダーを latin-1 でデコードするので、X-API-Key に 0x80 以上の
    バイトを 1 つ入れるだけで非 ASCII の str になり、以前は 401 のはずが 500 に
    なっていた（例外ハンドラ経由の INTERNAL_ERROR）。
    """
    client = make_client(VSPO_API_KEY=api_key)
    response = client.get(
        "/api/v1/feed", headers={b"X-API-Key": ("é" * 48).encode("latin-1")}
    )
    assert response.status_code == 401


def test_overlong_key_is_rejected(make_client, api_key):
    client = make_client(VSPO_API_KEY=api_key)
    response = client.get("/api/v1/feed", headers={"X-API-Key": "y" * 4096})
    assert response.status_code == 401


def test_readiness_stays_public_even_with_a_key(make_client, api_key):
    """外部の死活監視はキーを持たない。401 にしてしまうと監視できない。"""
    client = make_client(VSPO_API_KEY=api_key)
    assert client.get("/api/v1/readiness").status_code != 401


def test_health_stays_public_even_with_a_key(make_client, api_key):
    client = make_client(VSPO_API_KEY=api_key)
    assert client.get("/api/v1/health").status_code == 200


def test_unauthorized_body_uses_the_error_envelope(make_client, api_key):
    client = make_client(VSPO_API_KEY=api_key)
    body = client.get("/api/v1/feed").json()
    assert body["status"] == "error"
    assert body["error"]["code"] == "UNAUTHORIZED"
    assert body["error"]["request_id"]
