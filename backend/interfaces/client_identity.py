"""リバースプロキシ配下でのクライアント識別。

クライアントが自由に送れる X-Forwarded-For は使用しない。Cloudflare Tunnel
構成を明示的に有効化し、かつ直接の TCP ピアが信頼済みプロキシである場合だけ、
Cloudflare が付与する CF-Connecting-IP を採用する。それ以外は常に TCP ピアの
アドレスへフォールバックする。

「TRUST_CLOUDFLARE_HEADERS だけ」でヘッダーを信頼すると、nginx:80 等
バックエンドへ直接届く別経路から CF-Connecting-IP を偽装され、レート制限の
キーを 1 リクエストごとに変えて全制限を無効化できる。ピア検証まで課すことで、
Cloudflare が上書きした値（クライアントは書き換えられない）だけを信頼する。
"""

import ipaddress
from collections.abc import Mapping

from config import TRUST_CLOUDFLARE_HEADERS, TRUSTED_PROXY_NETWORKS


def _normalize_ip(raw_value: str | None) -> str | None:
    if not raw_value:
        return None
    try:
        return str(ipaddress.ip_address(raw_value.strip()))
    except ValueError:
        return None


def _is_trusted_proxy(peer_ip: str | None) -> bool:
    if not peer_ip:
        return False
    try:
        address = ipaddress.ip_address(peer_ip)
    except ValueError:
        return False
    return any(address in network for network in TRUSTED_PROXY_NETWORKS)


def client_key(headers: Mapping[str, str], peer_host: str | None) -> str:
    """レート制限に使う、検証済みの安定したクライアントキーを返す。"""
    peer_ip = _normalize_ip(peer_host)

    # 転送系ヘッダーを信じるのは、直接の TCP ピアが信頼済みプロキシのときだけ。
    if TRUST_CLOUDFLARE_HEADERS and _is_trusted_proxy(peer_ip):
        cloudflare_ip = _normalize_ip(headers.get("cf-connecting-ip"))
        if cloudflare_ip:
            return f"cf:{cloudflare_ip}"

    if peer_ip:
        return f"peer:{peer_ip}"
    return "peer:unknown"
