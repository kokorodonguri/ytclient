"""入力検証。

video_id をそのまま yt-dlp へ渡さないための境界。ここが緩むと任意の文字列で
外向きの抽出を起動できる。
"""

import pytest

VALID_ID = "dQw4w9WgXcQ"


@pytest.mark.parametrize(
    "video_id",
    [
        "short",
        "way-too-long-id",
        "invalid!chars",
        "../../etc/passwd",
        "%2e%2e%2f",
        " " + VALID_ID,
    ],
)
def test_rejects_malformed_video_ids(client, video_id):
    response = client.get(f"/api/v1/videos/{video_id}/comments")
    assert response.status_code in (400, 404)


def test_malformed_id_uses_the_validation_error_code(client):
    body = client.get("/api/v1/videos/short/comments").json()
    assert body["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize("limit", [-1, 101, 1000])
def test_rejects_out_of_range_limits(client, limit):
    response = client.get(f"/api/v1/videos/{VALID_ID}/comments?limit={limit}")
    assert response.status_code == 422


def test_rejects_a_non_numeric_limit(client):
    response = client.get(f"/api/v1/videos/{VALID_ID}/comments?limit=abc")
    assert response.status_code == 422


def test_validation_error_body_is_an_envelope(client):
    body = client.get(f"/api/v1/videos/{VALID_ID}/comments?limit=999").json()
    assert body["status"] == "error"
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert body["error"]["request_id"]


def test_stream_endpoint_validates_the_id_too(client):
    assert client.get("/api/v1/videos/short/stream").status_code == 400
