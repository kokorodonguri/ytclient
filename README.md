# ぶいすぽっ！クライアント (VSPO Client)

ぶいすぽっ！メンバーの YouTube 配信・動画・切り抜きをまとめてチェックできる非公式クライアント。
Electron デスクトップアプリ、Android APK (Capacitor)、ブラウザから同じフロントエンドを利用できる。

## 主な機能

- メンバー配信 / 切り抜きのタブ切り替え表示
- ゲーム別フィルターと追加検索ワードによる絞り込み
- アプリ内プレイヤー (HLS 再生対応) と概要欄・コメントの表示
- ライブチャットのリアルタイム表示 (WebSocket、切断時は自動再接続)
- 複数配信を並べて視聴する分割表示

## 動作環境

- Node.js 20 (Electron / ビルド用)
- Python 3.13 (バックエンドを自分で動かす場合・テスト / lint 用。CI と同じバージョン)
- Windows (exe ビルド)、Android SDK (APK ビルド)

## 構成

バックエンドは 1 つだけで、全クライアントがそれを叩く。アプリにバックエンドは同梱しない。

- `backend/` — **唯一のバックエンド実装**。本番 (youtube.dongurihub.com) で稼働。
  domain/application/infrastructure/interfaces に分割されたレイヤード構成で、
  systemd (`backend/deploy/vspo-backend.service`) + Cloudflare Tunnel 経由で公開している。
  読み取り API は認証不要で、濫用対策はレート制限が担う。詳細は `backend/README.md` と
  `API_DESIGN.md`。
- `src/frontend/` — Electron レンダラー / ブラウザ / APK 共通のフロントエンド (ESモジュール, ビルドツール不要)。
- `main.js` — Electron メインプロセス。画面のローカル配信・単一インスタンス化・IPC・セキュリティ設定を担う。
- `android/` — Capacitor で APK 化するためのラッパー。
- `tests/` — `backend/` の API 境界テスト (pytest)。

## セットアップ

```bash
npm install                       # postinstall で vendor:copy が hls.js を同梱する

# バックエンドを自分で動かす場合のみ
pip install -r backend/requirements.txt -r requirements-dev.txt
```

## 開発時の起動

```bash
npm start                         # Electron を起動 (既定で本番バックエンドに接続)
```

接続先は設定画面、`VSPO_BACKEND_URL`、または `backend-config.json` で変えられる。

バックエンドを手元で動かして試す場合:

```bash
cd backend && python main.py 8010 127.0.0.1
# ブラウザで http://127.0.0.1:8010/app/ を開く (VSPO_FRONTEND_DIR を設定した場合)
```

既定のバインドはループバック。`VSPO_API_KEY` 未設定のまま非ループバックへ
バインドしようとすると起動を拒否する (fail-closed)。設定項目の全体は
`API_DESIGN.md` の Configuration を参照。

## ビルド

```bash
npm run check                     # 構文チェック + チャンネル一覧の整合性チェック
npm test                          # backend/ の API 境界テスト (pytest)
npm run lint                      # eslint + ruff + mypy
npm run build                     # Windows 向け exe
npm run build:apk                 # Android APK (Capacitor)
```

CI (`.github/workflows/ci.yml`) が PR ごとに上記を実行する。

## セキュリティ / 運用上の注意

- 読み取り API は公開で運用する。配信内容は全て公開 YouTube 情報で、守るべき
  ユーザーデータが無く、全員に同じキーを配ればそれは秘密ではなくなる。濫用対策は
  IP 別のレート制限が担う。`VSPO_API_KEY` を設定するのは、Cloudflare Tunnel を挟まず
  LAN へ直接公開する場合など、到達できる相手そのものを絞りたいときだけ。
- バックエンドの既定バインドは `127.0.0.1`。Cloudflare Tunnel 配下では
  `VSPO_TRUST_CLOUDFLARE_HEADERS=1` と `VSPO_TRUSTED_PROXY_NETWORKS` を設定する。
- 設定ファイル (`backend-config.json`) は API キーを含むため `.gitignore` 済み、パーミッションは
  0600 で書き込まれる。コミットしないこと。
- 詳細な環境変数・エンドポイント仕様は `API_DESIGN.md` を参照。

## リポジトリ運用ルール

このリポジトリで Claude Code エージェントに実装を依頼する際の振る舞いは `AGENTS.md` に定義している。
