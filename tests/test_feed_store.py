"""FeedStore。

公開応答の組み立てとロック運用。ここが崩れると /feed が詰まるか、
内部のエラー文字列が全世界に配信される。
"""

import gzip
import importlib
import json

import pytest


@pytest.fixture
def store(build_app):
    def factory(**env):
        build_app(**env)
        return importlib.import_module("application.feed_store").FeedStore

    return factory


def test_payload_is_ready_before_any_update(store):
    """response_parts() が空を返す状態が無いこと。"""
    instance = store()(total_channels=2)
    payload, etag, is_gzipped = instance.response_parts()
    assert payload
    assert etag
    assert is_gzipped is False
    assert json.loads(payload)["status"] == "success"


def test_gzip_variant_decompresses_to_the_same_bytes(store):
    instance = store()(total_channels=1)
    identity, _, _ = instance.response_parts()
    compressed, _, is_gzipped = instance.response_parts(prefer_gzip=True)
    assert is_gzipped is True
    assert gzip.decompress(compressed) == identity


def test_gzip_actually_shrinks_a_real_sized_feed(store):
    instance = store()(total_channels=1)
    items = [
        {
            "video_id": f"{index:011d}",
            "title": "ぶいすぽっ！メンバーの配信タイトル",
            "uploader": "テストチャンネル",
            "thumbnail": f"https://i.ytimg.com/vi/{index:011d}/hqdefault.jpg",
        }
        for index in range(400)
    ]
    instance.replace(items, [])
    identity, _, _ = instance.response_parts()
    compressed, _, _ = instance.response_parts(prefer_gzip=True)
    assert len(compressed) < len(identity) / 2


def test_etag_changes_when_the_feed_changes(store):
    instance = store()(total_channels=1)
    _, before, _ = instance.response_parts()
    instance.replace([{"video_id": "a" * 11, "title": "t"}], [])
    _, after, _ = instance.response_parts()
    assert before != after


def test_mark_error_serves_only_the_exception_type(store):
    """yt-dlp の例外文には上流URLとローカルパスが混じる。"""
    instance = store()(total_channels=1)
    instance.mark_error(
        RuntimeError("ERROR: [youtube] https://internal.example/x /home/me/cookies.txt")
    )
    body = json.loads(instance.response_parts()[0])
    assert body["data"]["last_error"] == "RuntimeError"
    assert "internal.example" not in instance.response_parts()[0].decode()


def test_record_discovery_serves_only_the_exception_type(store):
    instance = store()(total_channels=1)
    instance.record_discovery(0, ValueError("https://internal.example/leak"))
    assert instance.readiness_snapshot()["last_discovery_error"] == "ValueError"


def test_record_discovery_does_not_change_the_feed_etag(store):
    """RSS 周期の記録で ETag が変わると、304 が効かなくなる。"""
    instance = store()(total_channels=1)
    instance.replace([{"video_id": "a" * 11, "title": "t"}], [])
    _, before, _ = instance.response_parts()
    instance.record_discovery(3)
    _, after, _ = instance.response_parts()
    assert before == after


def test_a_stale_publish_cannot_overwrite_a_newer_one(store):
    """組み立てをロック外に出した副作用。到着順が入れ替わっても新しい方が残る。"""
    instance = store()(total_channels=1)
    instance.replace([{"video_id": "a" * 11, "title": "old"}], [])
    stale_version, stale_snapshot = 1, {"official": [], "clips": [], "marker": "stale"}

    instance.replace([{"video_id": "b" * 11, "title": "new"}], [])
    newest = instance.response_parts()[0]

    # 古い版番号で publish しても無視されること
    instance._publish(stale_version, stale_snapshot)
    assert instance.response_parts()[0] == newest


def test_merge_official_adds_only_unseen_videos(store):
    instance = store()(total_channels=1)
    instance.replace([{"video_id": "a" * 11, "title": "existing"}], [])

    added = instance.merge_official(
        [
            {"video_id": "a" * 11, "title": "duplicate"},
            {"video_id": "b" * 11, "title": "new"},
        ]
    )
    assert added == 1


def test_merge_official_is_a_no_op_for_an_empty_list(store):
    instance = store()(total_channels=1)
    assert instance.merge_official([]) == 0


def test_feed_age_is_none_before_the_first_update(store):
    instance = store()(total_channels=1)
    assert instance.readiness_snapshot()["feed_age_seconds"] is None


def test_feed_age_is_zero_right_after_an_update(store):
    instance = store()(total_channels=1)
    instance.replace([{"video_id": "a" * 11, "title": "t"}], [])
    assert instance.readiness_snapshot()["feed_age_seconds"] < 5


def test_an_invalid_cache_file_is_ignored(store, tmp_path):
    cache = tmp_path / "feed.json"
    cache.write_text("{ this is not json", encoding="utf-8")
    instance = store()(total_channels=1, cache_path=cache)
    # 壊れたキャッシュで起動を止めない
    assert json.loads(instance.response_parts()[0])["data"]["official"] == []


def test_a_valid_cache_file_is_served_immediately(store, tmp_path):
    cache = tmp_path / "feed.json"
    cache.write_text(
        json.dumps(
            {
                "status": "success",
                "data": {
                    "official": [{"video_id": "a" * 11, "title": "cached"}],
                    "clips": [],
                    "last_updated": "2026-01-01T00:00:00",
                },
            }
        ),
        encoding="utf-8",
    )
    instance = store()(total_channels=1, cache_path=cache)
    body = json.loads(instance.response_parts()[0])
    assert len(body["data"]["official"]) == 1
    # 起動直後はキャッシュを見せつつ裏で最新化中
    assert body["data"]["is_building"] is True


def test_an_oversized_cache_file_is_ignored(store, tmp_path):
    cache = tmp_path / "feed.json"
    cache.write_bytes(b"x" * (17 * 1024 * 1024))
    instance = store()(total_channels=1, cache_path=cache)
    assert json.loads(instance.response_parts()[0])["data"]["official"] == []
