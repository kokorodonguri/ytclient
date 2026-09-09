# ぶいすぽっ！クライアント (VSPO Client)

ぶいすぽっ！メンバーの YouTube 配信・動画・切り抜きをまとめてチェックできる非公式クライアント。
Electron デスクトップアプリ、Android APK (Capacitor)、ブラウザから同じフロントエンドを利用できる。

## 構成

- `src/backend/main.py` — Electron 同梱用のバックエンド (単一ファイル)。`npm start` / `npm run backend` は
  こちらを使う。PyInstaller で `backend.exe` に固めて配布ビルドへ同梱する (`package.json` の `build:backend`)。
- `backend/` — **本番 (youtube.dongurihub.com) で稼働している実装**。domain/application/infrastructure/interfaces
  に分割されたレイヤードアーキテクチャで、RSS新着検知・レート制限・ライブチャットのfan-outなど
  `src/backend/main.py` より進んだ機能を持つ。systemd (`backend/deploy/vspo-backend.service`) 経由で
  本番サーバー上に直接デプロイされており、Electron ビルドの配布経路にはまだ組み込まれていない。
  `backend/README.md` と、統合手順を具体的にまとめた `BACKEND_UNIFICATION.md` を参照。
- `src/frontend/` — Electron レンダラー / ブラウザ / APK 共通のフロントエンド (ESモジュール, ビルドツール不要)。
- `main.js` — Electron メインプロセス。ローカルバックエンドの起動・単一インスタンス化・IPC・セキュリティ設定を担う。
- `android/` — Capacitor で APK 化するためのラッパー。

## セットアップ

```bash
npm install                       # postinstall で vendor:copy が hls.js を同梱する
pip install -r backend-requirements.txt
```

## 開発時の起動

```bash
npm start                         # Electron を起動 (ローカルバックエンドを自動起動)
# または、バックエンドとフロントエンドを別々に確認する場合
npm run backend                   # 127.0.0.1:8010 で起動
# ブラウザで http://127.0.0.1:8010/app/ を開く
```

LAN上の別端末からバックエンドへ接続する場合:

```bash
npm run backend:lan               # 0.0.0.0:8010 で起動
```

`VSPO_API_KEY` 未設定のまま非ループバックへバインドしようとすると起動を拒否する
(fail-closed)。公開環境では必ず `VSPO_API_KEY` を設定すること。設定項目の全体は
`API_DESIGN.md` の Configuration を参照。

## ビルド

```bash
npm run check                     # 構文チェック + IPCチャンネル整合性チェック + backend の py_compile
npm run build                     # Windows 向け exe (PyInstaller でバックエンドを同梱)
npm run build:apk                 # Android APK (Capacitor)
```

## セキュリティ / 運用上の注意

- バックエンドの既定バインドは `127.0.0.1`。外部公開する場合は `VSPO_API_KEY` と
  `VSPO_ALLOWED_ORIGINS` を設定し、リバースプロキシ配下では `VSPO_TRUST_PROXY_HEADER=1` を検討する。
- 設定ファイル (`backend-config.json`) は API キーを含むため `.gitignore` 済み、パーミッションは
  0600 で書き込まれる。コミットしないこと。
- 詳細な環境変数・エンドポイント仕様は `API_DESIGN.md` を参照。
- フロントエンド内部のモジュール構成は `src/frontend/README.md` を参照。

## リポジトリ運用ルール

このリポジトリで Claude Code エージェントに実装を依頼する際の振る舞いは `AGENTS.md` に定義している。
