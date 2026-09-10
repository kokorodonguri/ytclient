"""起動時の bind ガードと設定エラーの扱い。

このサーバーは任意の video_id に対して yt-dlp / pytchat を実行する。キー無しで
非ループバックへ晒すと、同一ネットワークの誰でもスクレイピングの踏み台に
できてしまう。既定値が「開いた」状態にならないことを固定する。
"""

import importlib

import pytest


@pytest.fixture
def backend_main(build_app):
    def factory(**env):
        build_app(**env)
        return importlib.import_module("main")

    return factory


def test_default_host_is_loopback(backend_main):
    """引数を省いた起動が公開にならないこと。"""
    assert backend_main().DEFAULT_HOST == "127.0.0.1"


def test_loopback_bind_is_allowed_without_a_key(backend_main):
    main = backend_main()
    main.guard_public_bind("127.0.0.1")  # 例外が出なければ通過


def test_public_bind_without_a_key_is_refused(backend_main):
    main = backend_main()
    with pytest.raises(SystemExit):
        main.guard_public_bind("0.0.0.0")


def test_public_bind_with_a_key_is_allowed(backend_main, api_key):
    main = backend_main(VSPO_API_KEY=api_key)
    main.guard_public_bind("0.0.0.0")


def test_public_bind_can_be_forced(backend_main):
    main = backend_main(VSPO_ALLOW_INSECURE_BIND=1)
    main.guard_public_bind("0.0.0.0")


def test_parse_args_defaults_to_loopback(backend_main):
    main = backend_main()
    assert main.parse_args(["main.py"]) == ("127.0.0.1", 8010)


def test_parse_args_reads_port_and_host(backend_main):
    main = backend_main()
    assert main.parse_args(["main.py", "9000", "0.0.0.0"]) == ("0.0.0.0", 9000)


def test_weak_api_key_is_refused_at_startup(build_app):
    with pytest.raises(SystemExit) as exit_info:
        build_app(VSPO_API_KEY="change-me")
    assert exit_info.value.code == 78


def test_short_api_key_is_refused_at_startup(build_app):
    with pytest.raises(SystemExit) as exit_info:
        build_app(VSPO_API_KEY="tooshort")
    assert exit_info.value.code == 78


def test_a_bad_integer_setting_exits_with_ex_config(build_app):
    """設定不備は再起動しても直らない。EX_CONFIG(78) で止まること。

    systemd 側の RestartPreventExitStatus=78 がこの値に依存している。
    """
    with pytest.raises(SystemExit) as exit_info:
        build_app(VSPO_RATE_LIMIT_PER_MIN="not-a-number")
    assert exit_info.value.code == 78


def test_an_out_of_range_setting_exits_with_ex_config(build_app):
    with pytest.raises(SystemExit) as exit_info:
        build_app(VSPO_RATE_LIMIT_PER_MIN=0)
    assert exit_info.value.code == 78


def test_a_bad_boolean_setting_exits_with_ex_config(build_app):
    with pytest.raises(SystemExit) as exit_info:
        build_app(VSPO_TRUST_CLOUDFLARE_HEADERS="maybe")
    assert exit_info.value.code == 78


def test_a_bad_cidr_exits_with_ex_config(build_app):
    with pytest.raises(SystemExit) as exit_info:
        build_app(VSPO_TRUSTED_PROXY_NETWORKS="not-a-cidr")
    assert exit_info.value.code == 78


def test_an_empty_key_is_a_valid_configuration(build_app):
    """公開読み取り API の既定。ここが SystemExit になると本番が起動しない。"""
    build_app(VSPO_API_KEY="")
