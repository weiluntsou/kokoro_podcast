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
import difflib

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
FEEDBACK_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'data', 'rag_feedback.json'))

qdrant = QdrantClient(QDRANT_HOST, port=QDRANT_PORT)
embedder = SentenceTransformer('all-MiniLM-L6-v2')

def load_feedback():
    """讀取使用者回饋以動態調整相關性門檻"""
    try:
        if os.path.exists(FEEDBACK_FILE):
            with open(FEEDBACK_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception:
        pass
    return {"score_threshold": 0.25, "thumbs_up": 0, "thumbs_down": 0}

def save_feedback(data):
    os.makedirs(os.path.dirname(FEEDBACK_FILE), exist_ok=True)
    with open(FEEDBACK_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

class QueryRequest(BaseModel):
    query: str
    top_k: int = 10
    model: str = None
    gemini_api_key: str = None
    gemini_model: str = None

class FeedbackRequest(BaseModel):
    source_index: int
    score: float
    is_relevant: bool  # True = 👍, False = 👎

def extract_text_from_payload(payload):
    """從 Qdrant payload 中智慧提取純文字內容"""
    if not payload:
        return ""
    # 情況 1: Obsidian 式 payload，有 page_content 鍵
    if "page_content" in payload:
        return str(payload["page_content"])
    # 情況 2: 直接的 text / content 鍵
    if "text" in payload:
        return str(payload["text"])
    if "content" in payload:
        return str(payload["content"])
    # 情況 3: 嘗試將整個 payload 組合出來（排除 metadata 等非內容欄位）
    parts = []
    for k, v in payload.items():
        if k not in ("metadata", "id", "vector", "score") and isinstance(v, str) and len(v) > 10:
            parts.append(v)
    if parts:
        return "\n".join(parts)
    return ""

def extract_metadata_from_payload(payload, collection_name):
    """從 payload 中提取 title / url / source 等 metadata"""
    title = ""
    url = ""
    source_path = ""
    
    if not payload:
        return title, url, source_path
    
    # 直接在頂層找
    title = payload.get("title", "")
    url = payload.get("url", "")
    source_path = payload.get("source", payload.get("full_path", ""))
    
    # Obsidian 式: metadata 藏在子 dict 裡
    meta = payload.get("metadata", {})
    if isinstance(meta, dict):
        if not title:
            title = meta.get("Header 1", meta.get("Header 2", meta.get("title", "")))
        if not url:
            url = meta.get("url", meta.get("id", ""))
        if not source_path:
            source_path = meta.get("source", meta.get("full_path", ""))
    
    # 如果還是沒有 title，從 source_path 的檔名取
    if not title and source_path:
        basename = source_path.rsplit("/", 1)[-1] if "/" in source_path else source_path
        title = basename.replace(".md", "").strip()
    
    if not title:
        title = payload.get("id", "未命名參考資料")
    
    return title, url, source_path

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
        
        # 讀取動態門檻
        fb = load_feedback()
        score_threshold = fb.get("score_threshold", 0.25)
        
        # 2. 跨多個 Table (Collection) 搜尋 (固定抓 15 筆候選)
        for collection_name in target_collections:
            if qdrant.collection_exists(collection_name=collection_name):
                res = qdrant.query_points(
                    collection_name=collection_name,
                    query=query_vector,
                    limit=15
                )
                for point in res.points:
                    all_points.append((collection_name, point))

        if not all_points:
            return {
                "query": user_query,
                "answer": "在目標的向量資料庫表 (`hedgedoc_notes`, `obsidian_notes`) 中找不到任何可用關聯資料，可能為空或尚未寫入。", 
                "source_documents": [],
                "score_threshold": score_threshold
            }
            
        # 混合兩個資料表，依據分數排序 (給 hedgedoc_notes 額外 5% 加權)
        all_points.sort(key=lambda x: x[1].score * (1.05 if x[0] == "hedgedoc_notes" else 1.0), reverse=True)
        
        # 自動過濾：只保留分數高於動態門檻的結果，至少保留 2 筆、最多 request.top_k 筆
        relevant_points = [(c, p) for c, p in all_points if p.score >= score_threshold]
        if len(relevant_points) < 2:
            relevant_points = all_points[:2]
        candidate_points = relevant_points[:request.top_k * 3]
        
        print(f"==> 動態門檻: {score_threshold:.3f}, 原始候選: {len(all_points)}, 過濾後: {len(relevant_points)}, 取用: {len(candidate_points)}", flush=True)
        
        # 簡單切出關鍵字尋找焦點
        keywords = [k for k in re.split(r'\W+', user_query) if len(k) >= 2]
        if not keywords:
            keywords = [user_query]
            
        truncated_texts = []
        final_best_points = []
        total_length = 0

        for coll, hit in candidate_points:
            text = extract_text_from_payload(hit.payload)
            if not text or len(text.strip()) < 15:
                continue
                
            # 尋找關鍵字的第一個匹配位置
            start_pos = 0
            for kw in keywords:
                idx = text.find(kw)
                if idx != -1:
                    start_pos = max(0, idx - 250)
                    break
            
            # 截取約 500 字的上下文視窗 (前後各 250 字)
            chunk = text[start_pos : start_pos + 500]
            if start_pos > 0:
                chunk = "..." + chunk
            if start_pos + 500 < len(text):
                chunk = chunk + "..."
                
            # 過濾重複內容 (超過 60% 相似度即拋棄)
            is_duplicate = False
            for exist_chunk in truncated_texts:
                if difflib.SequenceMatcher(None, chunk[:200], exist_chunk[:200]).ratio() > 0.60:
                    is_duplicate = True
                    break
            
            if is_duplicate:
                continue
                
            # 總長度上限 3000 字
            if total_length + len(chunk) > 3000:
                allowed_len = max(0, 3000 - total_length)
                if allowed_len > 30:
                    truncated_texts.append(chunk[:allowed_len] + "...")
                    final_best_points.append((coll, hit))
                break
                
            truncated_texts.append(chunk)
            final_best_points.append((coll, hit))
            total_length += len(chunk)
            
            if len(truncated_texts) >= request.top_k:
                break

        # 組合帶有編號的上下文給 LLM (讓 LLM 能引用來源編號)
        context_parts = []
        for i, chunk in enumerate(truncated_texts):
            coll, hit = final_best_points[i]
            title, _, source_path = extract_metadata_from_payload(hit.payload, coll)
            label = f"[來源{i+1}] ({coll}) {title}"
            if source_path:
                label += f" | 路徑: {source_path}"
            context_parts.append(f"{label}\n{chunk}")
        
        context_text = "\n\n---\n\n".join(context_parts)

        if not context_text.strip():
            return {
                "query": user_query,
                "answer": "在資料庫中找不到相關資訊。", 
                "source_documents": []
            }
        
        # 主動讀取 settings.json 來抓取 Gemini 金鑰與 Hedgedoc 網址
        gemini_api_key = request.gemini_api_key
        gemini_model = request.gemini_model or "gemini-2.5-flash"
        hedgedoc_base = ""

        try:
            settings_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'data', 'settings.json'))
            if os.path.exists(settings_path):
                with open(settings_path, 'r', encoding='utf-8') as f:
                    settings_data = json.load(f)
                    if not gemini_api_key:
                        gemini_api_key = settings_data.get("geminiApiKey", "")
                        gemini_model = settings_data.get("geminiModel", "gemini-2.5-flash")
                    hedgedoc_base = settings_data.get("hedgedocUrl", "").rstrip('/')
        except Exception:
            pass

        # 重新打包給前端的詳細來源列表
        source_docs_formatted = []
        for i, snippet in enumerate(truncated_texts):
            coll, hit = final_best_points[i]
            payload = hit.payload or {}
            
            title, raw_url, source_path = extract_metadata_from_payload(payload, coll)
            
            # 嘗試產生可用的連結 URL
            url = raw_url
            if coll == "hedgedoc_notes" and hedgedoc_base:
                if url and not url.startswith("http"):
                    url = f"{hedgedoc_base}/{url}"
                elif not url:
                    # 嘗試從 payload 的 id 組成
                    doc_id = payload.get("id", payload.get("metadata", {}).get("id", ""))
                    if doc_id:
                        url = f"{hedgedoc_base}/{doc_id}"
            
            source_docs_formatted.append({
                "text": snippet,
                "url": url if url else "",
                "title": title,
                "collection": coll,
                "source_path": source_path,
                "score": round(hit.score, 4),
                "full_text": extract_text_from_payload(hit.payload)
            })

        retrieved_texts = source_docs_formatted

        # 4. 構建更好的 Prompt
        prompt = f"""你是一位知識淵博的研究助手。你的任務是根據以下提供的參考資料，為使用者的問題提供「全面、深入、有條理」的回答。

## 回答規則：
1. **盡量引用來源**：在回答時，請使用 [來源1]、[來源2] 等標記註明你引用了哪份參考資料。
2. **綜合整理**：將不同來源的相關資訊融合在一起，整理成有條理的段落或清單。
3. **豐富回答**：不要只是簡單複述原文，請加以歸納、提煉重點、分類整理。
4. **延伸思考**：如果參考資料中的內容可以間接回答問題（例如相關主題、類似概念），也請一併整理出來。
5. **不要捏造**：只根據參考資料回答，但要盡量從中挖掘出有用的資訊。
6. **使用繁體中文** 回答。

## 參考資料：
{context_text}

## 使用者問題：{user_query}

請提供你的完整回答："""

        answer = ""
        if gemini_api_key:
            # 使用 Gemini API 進行高階與快速的生成
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{gemini_model}:generateContent?key={gemini_api_key}"
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.7, "maxOutputTokens": 8192}
            }
            req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'}, method='POST')
            try:
                print("==> 正在透過 Gemini API 生成...", flush=True)
                with urllib.request.urlopen(req, timeout=30) as resp:
                    resp_data = json.loads(resp.read().decode('utf-8'))
                    answer = resp_data.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '')
            except Exception as e:
                print(f"Gemini API Error: {e}")
                answer = f"Gemini API 呼叫失敗: {str(e)}"
        else:
            # 降級使用 Ollama
            print("==> Gemini API Key 未提供，已降級使用 Ollama 進行生成 (這可能需要數十秒到數分鐘)...", flush=True)
            response = ollama.chat(model=model_to_use, messages=[
                {'role': 'user', 'content': prompt}
            ])
            answer = response['message']['content']
        
        return {
            "query": user_query,
            "answer": answer,
            "source_documents": retrieved_texts,
            "score_threshold": score_threshold,
            "model_used": gemini_model if gemini_api_key else model_to_use
        }
    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=f"處理過程中發生錯誤: {str(e)}")

@app.post("/feedback")
async def submit_feedback(request: FeedbackRequest):
    """接收使用者對來源的 👍/👎 回饋，動態微調相關性門檻"""
    fb = load_feedback()
    
    if request.is_relevant:
        fb["thumbs_up"] = fb.get("thumbs_up", 0) + 1
        # 使用者認為相關 → 門檻可以略降以收集更多相關結果
        if request.score < fb["score_threshold"] and fb["score_threshold"] > 0.10:
            fb["score_threshold"] = round(fb["score_threshold"] - 0.01, 3)
    else:
        fb["thumbs_down"] = fb.get("thumbs_down", 0) + 1
        # 使用者認為不相關 → 門檻提高以排除低品質結果
        if request.score >= fb["score_threshold"] * 0.8 and fb["score_threshold"] < 0.90:
            fb["score_threshold"] = round(fb["score_threshold"] + 0.01, 3)
    
    save_feedback(fb)
    print(f"==> 回饋更新: {"👍" if request.is_relevant else "👎"} score={request.score:.4f}, 新門檻={fb['score_threshold']:.3f}", flush=True)
    return {"success": True, "new_threshold": fb["score_threshold"], "stats": fb}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
