#!/bin/bash
# 取得目前脚本執行目錄的絕對路徑
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

if [ ! -d "venv" ]; then
    echo "正在建立 venv 虛擬環境..."
    python3 -m venv venv
fi

source venv/bin/activate
echo "啟動 FastAPI 伺服器中..."
if [ ! -f "venv/.installed" ]; then
    echo "正在安裝必要的套件 (初次安裝或更新)..."
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
    pip install fastapi uvicorn qdrant-client ollama sentence-transformers pydantic
    touch venv/.installed
else
    echo "套件已安裝，跳過檢查。"
fi

uvicorn main:app --reload --host 0.0.0.0 --port 8866
