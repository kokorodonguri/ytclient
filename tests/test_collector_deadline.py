"""収集ワーカーの締切。

executor.map には timeout が無く、yt-dlp の socket_timeout はソケット読み取り
1 回ぶんしか縛らない。抽出が 1 件詰まると収集スレッドが無期限に止まり、
フィードはエラーも出さずに更新されなくなる（readiness も気付けなかった）。
"""

import importlib
import time

import pytest


@pytest.fixture
def run_bounded(build_app):
    def factory(**env):
        build_app(**env)
        return importlib.import_module("application.collector")._run_bounded

    return factory


def test_returns_every_result_when_nothing_overruns(run_bounded):
    bounded = run_bounded()
    results = bounded(
        lambda value: value * 2,
        [1, 2, 3],
        max_workers=3,
        deadline=time.monotonic() + 30,
        label="Test",
    )
    assert sorted(results) == [2, 4, 6]


def test_abandons_a_task_that_overruns_the_deadline(run_bounded):
    bounded = run_bounded()

    def work(value):
        if value == "slow":
            time.sleep(30)
        return value

    started = time.monotonic()
    results = bounded(
        work,
        ["fast", "slow", "also-fast"],
        max_workers=3,
        deadline=time.monotonic() + 1.0,
        label="Test",
    )
    elapsed = time.monotonic() - started

    assert "slow" not in results
    assert "fast" in results and "also-fast" in results
    # 締切を大きく超えて待たないこと（with ThreadPoolExecutor だと 30 秒待つ）
    assert elapsed < 10


def test_a_failing_task_does_not_stop_the_others(run_bounded):
    bounded = run_bounded()

    def work(value):
        if value == "boom":
            raise RuntimeError("upstream said no")
        return value

    results = bounded(
        work,
        ["a", "boom", "b"],
        max_workers=3,
        deadline=time.monotonic() + 30,
        label="Test",
    )
    assert sorted(results) == ["a", "b"]


def test_reports_timeouts_through_on_failure(run_bounded):
    bounded = run_bounded()
    seen = []

    bounded(
        lambda value: time.sleep(30),
        ["stuck"],
        max_workers=1,
        deadline=time.monotonic() + 0.5,
        label="Test",
        on_failure=lambda item, error: seen.append((item, error)),
    )
    assert seen == [("stuck", None)]


def test_reports_exceptions_through_on_failure(run_bounded):
    bounded = run_bounded()
    seen = []

    def work(_value):
        raise RuntimeError("nope")

    bounded(
        work,
        ["item"],
        max_workers=1,
        deadline=time.monotonic() + 30,
        label="Test",
        on_failure=lambda item, error: seen.append(type(error).__name__),
    )
    assert seen == ["RuntimeError"]


def test_an_empty_input_does_not_start_a_pool(run_bounded):
    bounded = run_bounded()
    assert bounded(lambda v: v, [], max_workers=4, deadline=0, label="Test") == []


def test_an_already_passed_deadline_yields_nothing_slow(run_bounded):
    bounded = run_bounded()
    results = bounded(
        lambda value: time.sleep(5),
        ["a", "b"],
        max_workers=2,
        deadline=time.monotonic() - 1,
        label="Test",
    )
    assert results == []


def test_a_timed_out_channel_counts_as_degraded(build_app, monkeypatch):
    """締切超過でチャンネルが落ちたとき degraded_channels に載ること。

    載らないと「一部のメンバーしか出てこないフィード」を正常扱いしてしまう。
    """
    build_app(VSPO_CYCLE_TIMEOUT_SECONDS=60)
    collector_module = importlib.import_module("application.collector")
    feed_store_module = importlib.import_module("application.feed_store")

    store = feed_store_module.FeedStore(total_channels=2)
    collector = collector_module.FeedCollector(store)

    monkeypatch.setattr(
        collector_module,
        "TARGET_CHANNELS",
        ["https://www.youtube.com/@one", "https://www.youtube.com/@two"],
    )
    monkeypatch.setattr(
        collector, "_collect_channel", lambda url: (_ for _ in ()).throw(RuntimeError("x"))
    )

    collector._collect_official(deadline=time.monotonic() + 5)
    store.replace([], [])
    assert store.readiness_snapshot()["degraded_channels"] == 2
