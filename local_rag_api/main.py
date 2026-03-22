from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from qdrant_client import QdrantClient
import ollama
from sentence_transformers import SentenceTransformer
import os

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

@app.post("/ask")
async def ask_database(request: QueryRequest):
    user_query = request.query
    model_to_use = request.model or OLLAMA_MODEL
    try:
        # 1. 將使用者查詢轉換為向量
        query_vector = embedder.encode(user_query).tolist()
        
        # 2. 在 Qdrant 中進行搜尋
        search_results = qdrant.query_points(
            collection_name=COLLECTION_NAME,
            query=query_vector,
            limit=request.top_k
        ).points
        
        # 3. 提取檢索到的文本內容
        retrieved_texts = [hit.payload.get("text", "") for hit in search_results if "text" in hit.payload]
        context_text = "\n---\n".join(retrieved_texts)

        if not context_text:
            return {
                "query": user_query,
                "answer": "在資料庫中找不到相關資訊。", 
                "source_documents": []
            }

        # 4. 構建 Prompt 並調用 Ollama
        prompt = f"你是一個專業且精準的助手。請「僅根據以下提供的參考資料」來回答使用者的問題。\n如果參考資料中無法回答該問題，請誠實地說你不知道。\n\n[參考資料開始]\n{context_text}\n[參考資料結束]\n\n使用者問題：{user_query}\n\n請提供你的回答："

        response = ollama.chat(model=model_to_use, messages=[
            {'role': 'user', 'content': prompt}
        ])
        
        return {
            "query": user_query,
            "answer": response['message']['content'],
            "source_documents": retrieved_texts
        }
    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=f"處理過程中發生錯誤: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
