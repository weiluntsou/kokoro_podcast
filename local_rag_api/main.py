from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from qdrant_client import QdrantClient
import ollama
from sentence_transformers import SentenceTransformer
import os
import json
import urllib.request
import re

app = FastAPI(title="Local RAG API", description="使用 Qwen 與 Qdrant 的本地端知識庫查詢")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify the actual origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

QDRANT_HOST = os.getenv("QDRANT_HOST", "localhost")
QDRANT_PORT = int(os.getenv("QDRANT_PORT", 6333))
COLLECTION_NAME = os.getenv("COLLECTION_NAME", "my_knowledge_base")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "sorc/qwen3.5-instruct:0.8b")

qdrant = QdrantClient(QDRANT_HOST, port=QDRANT_PORT)
embedder = SentenceTransformer('all-MiniLM-L6-v2')

class QueryRequest(BaseModel):
    query: str
    top_k: int = 3
    model: str = None
    gemini_api_key: str = None
    gemini_model: str = None

@app.post("/ask")
async def ask_database(request: QueryRequest):
    user_query = request.query
    model_to_use = request.model or OLLAMA_MODEL
    try:
        # 1. 將使用者查詢轉換為向量
        query_vector = embedder.encode(user_query).tolist()
        
        # 1.5 檢查各個知識庫集合
        target_collections = ["hedgedoc_notes", "obsidian_notes"]
        all_points = []
        
        # 2. 跨多個 Table (Collection) 搜尋
        for collection_name in target_collections:
            if qdrant.collection_exists(collection_name=collection_name):
                res = qdrant.query_points(
                    collection_name=collection_name,
                    query=query_vector,
                    limit=request.top_k
                )
                # 記錄來源所在的資料表，以利後續決定優先權
                for point in res.points:
                    all_points.append((collection_name, point))

        if not all_points:
            return {
                "query": user_query,
                "answer": "在目標的向量資料庫表 (`hedgedoc_notes`, `obsidian_notes`) 中找不到任何可用關聯資料，可能為空或尚未寫入。", 
                "source_documents": []
            }
            
        # 根據來源表優先權與相似度分數由高到低排序
        # 優先考量 hedgedoc_notes 回傳的結果，其次才補上 obsidian_notes 的資料
        all_points.sort(key=lambda x: (1 if x[0] == "hedgedoc_notes" else 0, x[1].score), reverse=True)
        best_points = [x[1] for x in all_points[:request.top_k]]
        
        # 3. 提取檢索到的文本內容，並進行相關斷落裁切以加快回應速度
        retrieved_texts_raw = [hit.payload.get("text", hit.payload.get("content", str(hit.payload))) for hit in best_points if hit.payload]
        
        # 簡單切出關鍵字尋找焦點，若都沒有則只找原句
        keywords = [k for k in re.split(r'\W+', user_query) if len(k) >= 2]
        if not keywords:
            keywords = [user_query]
            
        truncated_texts = []
        total_length = 0

        for text in retrieved_texts_raw:
            text = str(text).strip()
            if not text:
                continue
                
            # 尋找關鍵字的第一個匹配位置
            start_pos = 0
            for kw in keywords:
                idx = text.find(kw)
                if idx != -1:
                    # 找到關鍵字，抓前 200 字即可
                    start_pos = max(0, idx - 200)
                    break
            
            # 從決定好的位置開始截取約 400 字 (前後共400代表前後各200字)
            chunk = text[start_pos : start_pos + 400]
            if start_pos > 0:
                chunk = "..." + chunk
            if start_pos + 400 < len(text):
                chunk = chunk + "..."
                
            # 檢查總長度，不超過 1500 字
            if total_length + len(chunk) > 1500:
                allowed_len = max(0, 1500 - total_length)
                if allowed_len > 10:
                    truncated_texts.append(chunk[:allowed_len] + "...")
                break
                
            truncated_texts.append(chunk)
            total_length += len(chunk)

        context_text = "\n---\n".join(truncated_texts)

        if not context_text.strip():
            return {
                "query": user_query,
                "answer": "在資料庫中找不到相關資訊。", 
                "source_documents": []
            }
        
        # 將傳給前端看的來源也更換為截取過的精華版
        retrieved_texts = truncated_texts

        # 4. 構建 Prompt 並調用 Ollama 或 Gemini
        prompt = f"你是一個專業且精準的助手。請「僅根據以下提供的參考資料」來回答使用者的問題。\n如果參考資料中無法回答該問題，請誠實地說你不知道。\n\n[參考資料開始]\n{context_text}\n[參考資料結束]\n\n使用者問題：{user_query}\n\n請提供你的回答："

        answer = ""
        if request.gemini_api_key:
            # 使用 Gemini API 進行高階與快速的生成
            gemini_model = request.gemini_model or "gemini-2.5-flash"
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{gemini_model}:generateContent?key={request.gemini_api_key}"
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.7, "maxOutputTokens": 8192}
            }
            req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'}, method='POST')
            try:
                with urllib.request.urlopen(req) as resp:
                    resp_data = json.loads(resp.read().decode('utf-8'))
                    answer = resp_data.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '')
            except Exception as e:
                print(f"Gemini API Error: {e}")
                answer = f"Gemini API 呼叫失敗: {str(e)}"
        else:
            # 降級使用 Ollama
            response = ollama.chat(model=model_to_use, messages=[
                {'role': 'user', 'content': prompt}
            ])
            answer = response['message']['content']
        
        return {
            "query": user_query,
            "answer": answer,
            "source_documents": retrieved_texts
        }
    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=f"處理過程中發生錯誤: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
