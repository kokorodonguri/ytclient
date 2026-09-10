"""レート制限。

読み取り API を公開した以上、これが唯一の濫用対策になる。バケットの分離は
「フィードのポーリングでコメント取得の枠が枯れない」ことが目的なので、
分離そのものをテストで固定する。
"""

INVALID_VIDEO_ID = "short"


def test_feed_is_rate_limited(make_client):
    client = make_client(VSPO_FEED_RATE_LIMIT_PER_MIN=3)
    for _ in range(3):
        assert client.get("/api/v1/feed").status_code == 200
    assert client.get("/api/v1/feed").status_code == 429


def test_feed_429_carries_retry_after(make_client):
    client = make_client(VSPO_FEED_RATE_LIMIT_PER_MIN=1)
    client.get("/api/v1/feed")
    response = client.get("/api/v1/feed")
    assert response.status_code == 429
    assert int(response.headers["retry-after"]) >= 1


def test_feed_429_uses_the_rate_limited_error_code(make_client):
    client = make_client(VSPO_FEED_RATE_LIMIT_PER_MIN=1)
    client.get("/api/v1/feed")
    body = client.get("/api/v1/feed").json()
    assert body["error"]["code"] == "RATE_LIMITED"


def test_extraction_endpoints_have_their_own_bucket(make_client):
    """依存関係の評価順のおかげで、不正な video_id でも上限は消費される。

    レート制限は dependencies で走り、ID の検証はハンドラ本体で走る。
    つまりネットワークに出ないまま上限だけを試せる。
    """
    client = make_client(VSPO_RATE_LIMIT_PER_MIN=2)
    for _ in range(2):
        # 400 = 上限は通過し、ID 検証で弾かれた
        response = client.get(f"/api/v1/videos/{INVALID_VIDEO_ID}/comments")
        assert response.status_code == 400
    assert client.get(f"/api/v1/videos/{INVALID_VIDEO_ID}/comments").status_code == 429


def test_exhausted_feed_bucket_does_not_block_comments(make_client):
    """以前は単一バケットで、5 秒間隔のポーリングがコメントの枠を食っていた。"""
    client = make_client(VSPO_FEED_RATE_LIMIT_PER_MIN=1, VSPO_RATE_LIMIT_PER_MIN=5)
    client.get("/api/v1/feed")
    assert client.get("/api/v1/feed").status_code == 429

    # フィードが枯れていてもコメント側は生きている
    assert client.get(f"/api/v1/videos/{INVALID_VIDEO_ID}/comments").status_code == 400


def test_exhausted_comment_bucket_does_not_block_the_feed(make_client):
    client = make_client(VSPO_FEED_RATE_LIMIT_PER_MIN=5, VSPO_RATE_LIMIT_PER_MIN=1)
    client.get(f"/api/v1/videos/{INVALID_VIDEO_ID}/comments")
    assert client.get(f"/api/v1/videos/{INVALID_VIDEO_ID}/comments").status_code == 429

    assert client.get("/api/v1/feed").status_code == 200


def test_stream_endpoint_shares_the_extraction_bucket(make_client):
    client = make_client(VSPO_RATE_LIMIT_PER_MIN=1)
    client.get(f"/api/v1/videos/{INVALID_VIDEO_ID}/comments")
    assert client.get(f"/api/v1/videos/{INVALID_VIDEO_ID}/stream").status_code == 429


def test_readiness_shares_the_feed_bucket(make_client):
    client = make_client(VSPO_FEED_RATE_LIMIT_PER_MIN=1)
    client.get("/api/v1/feed")
    assert client.get("/api/v1/readiness").status_code == 429


def test_health_is_never_rate_limited(make_client):
    """死活監視の入口なので、制限で 429 にしてはいけない。"""
    client = make_client(VSPO_FEED_RATE_LIMIT_PER_MIN=1)
    client.get("/api/v1/feed")
    client.get("/api/v1/feed")
    for _ in range(5):
        assert client.get("/api/v1/health").status_code == 200
