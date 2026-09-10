"""readiness。

「last_updated が入っているか」だけを見ていたため、収集スレッドが詰まって
更新が止まっても ready を返し続けていた。古さそのものを見ることを固定する。
"""

import importlib
from datetime import datetime, timedelta

import pytest


@pytest.fixture
def store_and_client(make_client):
    """アプリと、そのアプリが実際に使っている FeedStore を返す。

    create_app() が app.state.feed_store に載せているので、ルートが握って
    いるのと同じインスタンスを触れる。
    """

    def factory(**env):
        client = make_client(**env)
        return client, client.app.state.feed_store

    return factory


def test_reports_starting_before_the_first_feed(client):
    response = client.get("/api/v1/readiness")
    assert response.status_code == 503
    assert response.json()["status"] == "starting"
    assert response.headers["retry-after"] == "5"


def test_reports_ready_once_a_feed_exists(store_and_client):
    client, store = store_and_client()
    store.replace([{"video_id": "a" * 11, "title": "t"}], [])

    response = client.get("/api/v1/readiness")
    assert response.status_code == 200
    assert response.json()["status"] == "ready"


def test_reports_degraded_when_channels_failed(store_and_client):
    client, store = store_and_client()
    store.record_channel_failure(complete_failure=True)
    store.replace([{"video_id": "a" * 11, "title": "t"}], [])

    body = client.get("/api/v1/readiness").json()
    assert body["status"] == "degraded"
    assert body["data"]["degraded_channels"] == 1


def test_reports_stale_when_the_feed_stops_updating(store_and_client):
    """収集スレッドが詰まった状態。以前はここで ready を返していた。"""
    client, store = store_and_client()
    store.replace([{"video_id": "a" * 11, "title": "t"}], [])

    config = importlib.import_module("config")
    frozen = datetime.now() - timedelta(
        seconds=config.READINESS_MAX_FEED_AGE_SECONDS + 60
    )
    with store._lock:
        store._data["last_updated"] = frozen.isoformat()

    response = client.get("/api/v1/readiness")
    assert response.status_code == 503
    assert response.json()["status"] == "stale"
    assert response.headers["retry-after"] == "60"


def test_stale_threshold_follows_the_refresh_interval(build_app):
    build_app(VSPO_REFRESH_SECONDS=3600)
    config = importlib.import_module("config")
    assert config.READINESS_MAX_FEED_AGE_SECONDS == 3 * 3600


def test_readiness_never_serves_exception_text(store_and_client):
    client, store = store_and_client()
    store.replace([{"video_id": "a" * 11, "title": "t"}], [])
    store.mark_error(RuntimeError("ERROR: [youtube] https://internal/path /home/me/x"))

    body = client.get("/api/v1/readiness").json()
    assert body["data"]["last_error"] == "RuntimeError"
