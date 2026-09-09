"""アプリケーション層。

ユースケース（フィードを保持して配る／コメントを取る／定期収集する）を
組み立てる。domain と infrastructure に依存してよいが、
FastAPI には依存しない。HTTP や WebSocket の語彙はここには出てこない。
"""
