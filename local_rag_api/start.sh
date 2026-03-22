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
# 預先安裝 PyTorch，若在 Linux (例如 Docker 內) 則優先強制使用 CPU 版本以避免下載龐大的 NVIDIA CUDA 函式庫
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install fastapi uvicorn qdrant-client ollama sentence-transformers pydantic

uvicorn main:app --reload --host 0.0.0.0 --port 8000
