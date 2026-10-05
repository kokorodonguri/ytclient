"""キャッシュ制御。

フィードは「毎回検証させて 304 を取らせる」、コメントとストリーム解決は
「クライアント側に残させない」で、方向が逆。以前はデスクトップ側の
webRequest フックが全バックエンド応答へ no-store を強制していたため、
フィードの ETag が一度も 304 にならず、5 秒ごとに約 1.5MB を再取得していた。
"""

import importlib

import pytest

VIDEO_ID = "dQw4w9WgXcQ"


def test_feed_asks_the_client_to_revalidate(client):
    """no-cache = 保存はしてよいが、使う前に必ず検証する。"""
    response = client.get("/api/v1/feed")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["etag"]


def test_a_304_still_carries_the_validators(client):
    etag = client.get("/api/v1/feed").headers["etag"]
    response = client.get("/api/v1/feed", headers={"If-None-Match": etag})
    assert response.status_code == 304
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["etag"] == etag


def test_a_304_does_not_claim_a_content_encoding(client):
    """本文を返さない応答に Content-Encoding を付けない。"""
    etag = client.get("/api/v1/feed").headers["etag"]
    response = client.get(
        "/api/v1/feed",
        headers={"If-None-Match": etag, "Accept-Encoding": "gzip"},
    )
    assert response.status_code == 304
    assert "content-encoding" not in response.headers


@pytest.fixture
def comments_client(make_client, monkeypatch):
    """yt-dlp を差し替えたクライアント。"""

    def factory(**env):
        client = make_client(**env)
        service = importlib.import_module("application.comments_service")
        monkeypatch.setattr(
            service,
            "fetch_video_comments",
            lambda video_id: {
                "description": "説明文",
                "comments": [{"author": "a", "text": "b"}],
            },
        )
        return client

    return factory


def test_comments_must_not_be_stored_by_the_client(comments_client):
    """サーバー側に TTL キャッシュがある。二重にかかると古い内容が出る。"""
    client = comments_client()
    response = client.get(f"/api/v1/videos/{VIDEO_ID}/comments")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"


def test_the_legacy_comments_alias_also_says_no_store(comments_client):
    client = comments_client()
    response = client.get(f"/comments?video_id={VIDEO_ID}")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"


def test_stream_urls_must_not_be_stored_by_the_client(make_client, monkeypatch):
    """解決した HLS の URL は数時間で失効する。掴み続けさせない。"""
    client = make_client()
    service = importlib.import_module("application.stream_service")
    monkeypatch.setattr(
        service,
        "fetch_video_stream_info",
        lambda video_id: {
            "id": video_id,
            "title": "配信",
            "is_live": True,
            "formats": [
                {
                    "protocol": "m3u8_native",
                    "url": "https://example.invalid/live.m3u8",
                    "vcodec": "avc1",
                    "acodec": "mp4a",
                }
            ],
        },
    )
    response = client.get(f"/api/v1/videos/{VIDEO_ID}/stream")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
