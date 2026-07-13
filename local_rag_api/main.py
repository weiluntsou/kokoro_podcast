from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from qdrant_client import QdrantClient
from qdrant_client.models import ScrollRequest, PointIdsList
import os
import ollama
from ollama import Client as OllamaClient
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434")
ollama_client = OllamaClient(host=OLLAMA_HOST)
import torch
# 限制 PyTorch 的 CPU 執行緒數量，避免高負載搶占 CPU 資源
torch.set_num_threads(1)
from sentence_transformers import SentenceTransformer
import json
import urllib.request
import re
import difflib
import random
from typing import List, Optional

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

# 嘗試使用多語言模型 (支援中文+英文)，若 Qdrant 已有資料是用 all-MiniLM-L6-v2 建的則自動降級
EMBEDDER_MODEL = os.getenv("EMBEDDER_MODEL", "paraphrase-multilingual-MiniLM-L12-v2")
try:
    embedder = SentenceTransformer(EMBEDDER_MODEL)
    print(f"===> Embedding 模型: {EMBEDDER_MODEL}", flush=True)
except Exception as e:
    print(f"===> 無法載入 {EMBEDDER_MODEL}，降級使用 all-MiniLM-L6-v2: {e}", flush=True)
    embedder = SentenceTransformer('all-MiniLM-L6-v2')
    EMBEDDER_MODEL = 'all-MiniLM-L6-v2'

LOG_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'data', 'rag_api.log'))

def log_api_step(msg: str):
    try:
        from datetime import datetime
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(f"[{timestamp}] {msg}\n")
    except Exception as e:
        print(f"Log error: {e}", flush=True)

def parse_response_to_keywords(text: str) -> List[str]:
    parsed_kws = []
    # 分割各種常見的分隔符：逗號、分號、換行等
    raw_items = re.split(r'[,，;\n\uff1b]', text)
    for item in raw_items:
        item = item.strip()
        # 移除列表序號與符號 (如 "1. ", "2) ", "- ", "* ")
        item = re.sub(r'^(?:\d+[\.\)]|[\-\*\u2022])\s*', '', item)
        # 移除包覆的外層引號或井字號
        item = re.sub(r'^[\"\'「『#\s]+|[\"\'」』#\s]+$', '', item)
        item = item.strip()
        if len(item) >= 2 and len(item) <= 15:
            # 確保包含字母或中文字，且不是純數字
            if re.search(r'[\w\u4e00-\u9fa5]', item) and not item.replace(".", "").isdigit():
                parsed_kws.append(item)
    return list(dict.fromkeys(parsed_kws))[:5]

def load_feedback():
    """讀取使用者回饋以動態調整相關性門檻"""
    try:
        if os.path.exists(FEEDBACK_FILE):
            with open(FEEDBACK_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception:
        pass
    return {"score_threshold": 0.10, "thumbs_up": 0, "thumbs_down": 0}

def save_feedback(data):
    os.makedirs(os.path.dirname(FEEDBACK_FILE), exist_ok=True)
    with open(FEEDBACK_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

class QueryRequest(BaseModel):
    query: str
    top_k: int = 10
    collections: list = ["hedgedoc_notes", "obsidian_notes"]
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
            
    # 確保皆為字串且不為 None
    title = str(title) if title is not None else ""
    url = str(url) if url is not None else ""
    source_path = str(source_path) if source_path is not None else ""
    return title, url, source_path

def extract_date_from_payload(payload):
    """
    智慧提取 payload 中的日期，可用來尋找該筆記的最晚日期
    """
    if not payload:
        return None
    
    import re
    # 支援的所有日期欄位名稱
    date_keys = [
        "date", "created", "updated", "timestamp", "time", 
        "created_at", "updated_at", "createdAt", "updatedAt",
        "mtime", "ctime", "last_modified", "modified", "publish_date"
    ]
    
    # 1. 檢查 payload 頂層的日期欄位
    for key in date_keys:
        val = payload.get(key)
        if val:
            date_str = str(val).strip()
            # 如果是 timestamp 數字 (例如 1718000000 或者是毫秒 1718000000000)
            if date_str.replace('.', '').isdigit():
                try:
                    t = float(date_str)
                    if t > 1000000000000: # 毫秒
                        t = t / 1000.0
                    if 500000000 < t < 2500000000: # 合理時間戳
                        from datetime import datetime
                        return datetime.fromtimestamp(t).strftime('%Y-%m-%d')
                except Exception:
                    pass
            # 匹配 2026-07-13 或 2026/07/13 格式
            match = re.search(r'\d{4}[-/]\d{2}[-/]\d{2}', date_str)
            if match:
                return match.group(0).replace('/', '-')
            
    # 2. 檢查 metadata 內的欄位
    meta = payload.get("metadata", {})
    if isinstance(meta, dict):
        for key in date_keys:
            val = meta.get(key)
            if val:
                date_str = str(val).strip()
                # 如果是 timestamp 數字 (例如 1718000000 或者是毫秒 1718000000000)
                if date_str.replace('.', '').isdigit():
                    try:
                        t = float(date_str)
                        if t > 1000000000000: # 毫秒
                            t = t / 1000.0
                        if 500000000 < t < 2500000000: # 合理時間戳
                            from datetime import datetime
                            return datetime.fromtimestamp(t).strftime('%Y-%m-%d')
                    except Exception:
                        pass
                match = re.search(r'\d{4}[-/]\d{2}[-/]\d{2}', date_str)
                if match:
                    return match.group(0).replace('/', '-')
                    
    # 3. 從 title 中嘗試匹配日期 (例如 "2026-07-13" 或是 "20260713")
    title = payload.get("title", "")
    if not title and isinstance(meta, dict):
        title = meta.get("title", "")
    if title:
        title_str = str(title).strip()
        # 匹配 2026-07-13
        match = re.search(r'\d{4}[-/]\d{2}[-/]\d{2}', title_str)
        if match:
            return match.group(0).replace('/', '-')
        # 匹配 20260713
        match2 = re.search(r'\b\d{8}\b', title_str)
        if match2:
            s = match2.group(0)
            return f"{s[:4]}-{s[4:6]}-{s[6:]}"

    # 4. 從 source / full_path 中嘗試匹配日期 (例如 "2026-07-13.md")
    source_path = payload.get("source", payload.get("full_path", ""))
    if not source_path and isinstance(meta, dict):
        source_path = meta.get("source", meta.get("full_path", ""))
    if source_path:
        path_str = str(source_path).strip()
        match = re.search(r'\d{4}[-/]\d{2}[-/]\d{2}', path_str)
        if match:
            return match.group(0).replace('/', '-')

    # 5. 最後手段：從 page_content / text / content 的內文中掃描日期
    #    (Obsidian YAML frontmatter 有時會被包含在 page_content 的開頭)
    body_text = (
        payload.get("page_content") or
        payload.get("text") or
        payload.get("content") or ""
    )
    if body_text:
        from datetime import date as _date
        today_str = _date.today().isoformat()  # e.g. "2026-07-13"
        body_str = str(body_text)[:2000]  # 只掃前 2000 字，避免過慢
        # 掃出所有 YYYY-MM-DD 日期，只保留 <= 今天的（排除未來的排程/截止日）
        all_dates = re.findall(r'\d{4}[-/]\d{2}[-/]\d{2}', body_str)
        if all_dates:
            norm = [d.replace('/', '-') for d in all_dates
                    if '2000' <= d[:4] <= '2099'   # 合理年份範圍
                    and d.replace('/', '-') <= today_str]  # 非未來日期
            if norm:
                return max(norm)

    return None

def get_latest_data_date(target_collections):
    """
    從指定的 collections 中找出最晚的資料日期
    """
    latest_date_str = None
    
    for coll in target_collections:
        if not qdrant.collection_exists(collection_name=coll):
            continue
        
        try:
            next_offset = None
            total_scanned = 0
            while True:
                scroll_res = qdrant.scroll(
                    collection_name=coll,
                    limit=1000,
                    offset=next_offset,
                    with_payload=True,
                    with_vectors=False
                )
                points, next_offset = scroll_res
                total_scanned += len(points)
                for point in points:
                    date_val = extract_date_from_payload(point.payload)
                    if date_val:
                        if not latest_date_str or date_val > latest_date_str:
                            latest_date_str = date_val
                if not next_offset:
                    break
            log_api_step(f"Scan collection {coll} completed: scanned {total_scanned} points, latest date so far: {latest_date_str}")
        except Exception as e:
            log_api_step(f"Error scanning collection {coll} for latest date: {e}")
            
    return latest_date_str

@app.get("/explore")
async def explore_knowledge_base(
    collections: str = Query(default="hedgedoc_notes,obsidian_notes", description="逗號分隔的 collection 名稱"),
    keyword: Optional[str] = Query(default=None, description="指定的探索關鍵字"),
    gemini_api_key: Optional[str] = Query(default=None, description="Gemini API 金鑰"),
    gemini_model: Optional[str] = Query(default=None, description="Gemini 模型名稱")
):
    """知識庫探索 — 當未指定 keyword 時，回傳 5 個隨機主題關鍵字與統計數據；指定時，回傳該主題的關聯內容"""
    target_collections = [c.strip() for c in collections.split(",") if c.strip()]
    
    # 主動從 settings.json 載入 Gemini API 設定 (如果參數未提供)
    if not gemini_api_key or not gemini_model:
        try:
            settings_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'data', 'settings.json'))
            if os.path.exists(settings_path):
                with open(settings_path, 'r', encoding='utf-8') as f:
                    settings_data = json.load(f)
                    if not gemini_api_key:
                        gemini_api_key = settings_data.get("geminiApiKey", "")
                    if not gemini_model:
                        gemini_model = settings_data.get("geminiModel", "gemini-2.5-flash")
        except Exception as e_settings:
            log_api_step(f"Error loading settings in explore: {e_settings}")

    try:
        import time
        t0 = time.time()
        log_api_step(f"===> Explore started: collections={target_collections}, keyword={keyword}")
        
        # 1. 取得各 collection 的統計與文件數（統計數據皆需要）
        stats = {}
        valid_collections = []
        for coll in target_collections:
            if not qdrant.collection_exists(collection_name=coll):
                continue
            info = qdrant.get_collection(collection_name=coll)
            count = info.points_count
            stats[coll] = count
            if count > 0:
                valid_collections.append((coll, count))
        
        t1 = time.time()
        log_api_step(f"Explore stats loaded in {t1-t0:.2f}s: {stats}")
        
        # 情況 A：未提供關鍵字，回傳 5 個隨機關鍵字（使用 LLM 模型輔助提取）
        if not keyword:
            all_notes = []
            for coll in target_collections:
                if not qdrant.collection_exists(collection_name=coll):
                    continue
                # Scroll 部分文檔以獲取標題與內容
                scroll_res = qdrant.scroll(
                    collection_name=coll,
                    limit=35,
                    with_payload=True,
                    with_vectors=False
                )
                for point in scroll_res[0]:
                    title, _, _ = extract_metadata_from_payload(point.payload, coll)
                    text = extract_text_from_payload(point.payload)
                    if title and text and len(text.strip()) > 20:
                        all_notes.append((title.strip(), text.strip()))
            
            # 隨機打亂並選取最多 5 個文檔
            random.shuffle(all_notes)
            selected_notes = all_notes[:5]
            
            chosen_keywords = []
            method_used = "fallback"
            gemini_failed = False
            gemini_error_msg = None
            ollama_failed = False
            ollama_error_msg = None
            
            if len(selected_notes) >= 3:
                # 建立 LLM Prompt
                prompt = (
                    "你是一個專業的知識主題提取助手。請根據以下筆記的標題與內容片段，分別為每篇筆記提取出一個最具代表性、具體且針對性的「特殊核心關鍵詞」或「短主題」。\n\n"
                    "## 提取規則：\n"
                    "1. **拒絕空泛詞彙**：絕對不要使用如「會議記錄」、「工作會報」、「學習筆記」、「生活隨記」、「專案規劃」、「隨手寫寫」等過於籠統、概略的詞彙。\n"
                    "2. **尋找具體特徵**：提取該筆記中特有的具體名稱、獨特技術、專有名詞、特定地點或事物。例如：「丸鍾日式速食」、「35BA3B模型」、「工安管理」、「小龍蝦 Context」等具體概念。\n"
                    "3. **簡短有力**：每個關鍵詞字數在 2 到 8 個字之內，能夠精確辨識出該筆記的獨特特徵。\n\n"
                )
                for idx, (title, text) in enumerate(selected_notes):
                    snippet = text[:150].replace("\n", " ")
                    prompt += f"筆記 {idx+1}: 標題:「{title}」, 內容節錄:「{snippet}...」\n"
                prompt += "\n請嚴格按照以下要求輸出：\n1. 只輸出這五個關鍵詞，並以半形逗號（,）分隔。\n2. 每個關鍵詞字數在 2 到 8 個字之內。\n3. 不要輸出 any 外部標題引號、清單編號或多餘說明文字。格式範例：丸鍾日式速食,35BA3B模型,工安管理,小龍蝦 Context"
                
                # 1. 優先嘗試 Gemini API (如果提供金鑰)
                if gemini_api_key:
                    try:
                        g_model = gemini_model or "gemini-2.5-flash"
                        log_api_step(f"Extracting keywords with Gemini API ({g_model})")
                        
                        url = f"https://generativelanguage.googleapis.com/v1beta/models/{g_model}:generateContent?key={gemini_api_key}"
                        payload = {
                            "contents": [{"parts": [{"text": prompt}]}],
                            "generationConfig": {"temperature": 0.3, "maxOutputTokens": 200}
                        }
                        req = urllib.request.Request(
                            url, 
                            data=json.dumps(payload).encode('utf-8'), 
                            headers={'Content-Type': 'application/json'}, 
                            method='POST'
                        )
                        with urllib.request.urlopen(req, timeout=12) as resp:
                            resp_data = json.loads(resp.read().decode('utf-8'))
                            result_text = resp_data.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '').strip()
                        
                        log_api_step(f"Gemini API raw response: {result_text}")
                        parsed_kws = parse_response_to_keywords(result_text)
                        
                        if len(parsed_kws) >= 2:
                            chosen_keywords = parsed_kws
                            method_used = "gemini"
                            log_api_step(f"Successfully extracted keywords using Gemini: {chosen_keywords}")
                        else:
                            gemini_failed = True
                            gemini_error_msg = f"Gemini parser returned too few keywords: {parsed_kws}"
                    except Exception as e_gemini:
                        gemini_failed = True
                        gemini_error_msg = str(e_gemini)
                        log_api_step(f"Gemini keyword extraction failed: {e_gemini}")
                
                # 2. 降級使用 Ollama (當 Gemini 未配置或失敗時)
                if not chosen_keywords:
                    try:
                        log_api_step(f"Falling back to Ollama gemma3:270m")
                        response = ollama_client.chat(model="gemma3:270m", messages=[
                            {'role': 'user', 'content': prompt}
                        ])
                        result_text = response['message']['content'].strip()
                        log_api_step(f"Ollama gemma3:270m raw response: {result_text}")
                        parsed_kws = parse_response_to_keywords(result_text)
                        
                        if len(parsed_kws) >= 2:
                            chosen_keywords = parsed_kws
                            method_used = "ollama"
                            log_api_step(f"Successfully extracted keywords using Ollama: {chosen_keywords}")
                        else:
                            ollama_failed = True
                            ollama_error_msg = f"Ollama parser returned too few keywords: {parsed_kws}"
                    except Exception as e_ollama:
                        ollama_failed = True
                        ollama_error_msg = str(e_ollama)
                        log_api_step(f"Ollama keyword extraction failed (falling back to titles): {e_ollama}")
            else:
                gemini_error_msg = f"Selected notes count ({len(selected_notes)}) is less than 3"
            
            # 備用方案：如果模型提取皆失敗或數量不足，直接使用筆記標題填補
            if len(chosen_keywords) < 5:
                for title, _ in selected_notes:
                    if title and title not in chosen_keywords:
                        # 過濾掉無意義標題
                        if (len(title) >= 2 and len(title) <= 40 and 
                            not title.replace(".", "").replace("-", "").isdigit() and 
                            "untitled" not in title.lower() and 
                            "未命名" not in title):
                            chosen_keywords.append(title)
            
            # 如果還是不夠，從其他文檔中挑選標題
            if len(chosen_keywords) < 5:
                for coll in target_collections:
                    if not qdrant.collection_exists(collection_name=coll):
                        continue
                    scroll_res = qdrant.scroll(collection_name=coll, limit=30, with_payload=True, with_vectors=False)
                    for point in scroll_res[0]:
                        title, _, _ = extract_metadata_from_payload(point.payload, coll)
                        if title and title not in chosen_keywords:
                            if (len(title) >= 2 and len(title) <= 40 and 
                                not title.replace(".", "").replace("-", "").isdigit() and 
                                "untitled" not in title.lower() and 
                                "未命名" not in title):
                                chosen_keywords.append(title)
                                if len(chosen_keywords) >= 5:
                                    break
            
            # 如果依然不足 5 個，使用通用主題填補
            if len(chosen_keywords) < 5:
                fallbacks = ["Kokoro", "AI Podcast", "知識庫", "筆記整理", "RAG 系統", "向量資料庫"]
                for fb in fallbacks:
                    if fb not in chosen_keywords:
                        chosen_keywords.append(fb)
                    if len(chosen_keywords) >= 5:
                        break
            
            # 確保最後回傳的關鍵字陣列去重且長度為 5
            chosen_keywords = list(dict.fromkeys(chosen_keywords))[:5]
            
            t2 = time.time()
            log_api_step(f"Explore keywords loaded in {t2-t1:.2f}s: {chosen_keywords}")
            return {
                "mode": "keywords",
                "keywords": chosen_keywords,
                "stats": stats,
                "debug": {
                    "method": method_used,
                    "gemini_failed": gemini_failed,
                    "gemini_error": gemini_error_msg,
                    "ollama_failed": ollama_failed,
                    "ollama_error": ollama_error_msg,
                    "selected_notes_count": len(selected_notes),
                    "selected_notes_titles": [title for title, _ in selected_notes]
                }
            }
            
        # 情況 B：已提供關鍵字，對關鍵字進行向量相似度搜尋，回傳焦點與關聯筆記
        else:
            log_api_step(f"Encoding keyword: {keyword}")
            keyword_vector = embedder.encode(keyword).tolist()
            t2 = time.time()
            log_api_step(f"Keyword encoded in {t2-t1:.2f}s")
            
            related_docs = []
            for coll in target_collections:
                if not qdrant.collection_exists(collection_name=coll):
                    continue
                # 跨 Collection 搜尋關聯筆記
                res = qdrant.query_points(
                    collection_name=coll,
                    query=keyword_vector,
                    limit=12
                )
                for point in res.points:
                    doc_id = str(point.id)
                    text = extract_text_from_payload(point.payload)
                    title, url, source_path = extract_metadata_from_payload(point.payload, coll)
                    if text and len(text.strip()) > 20:
                        related_docs.append({
                            "id": doc_id,
                            "collection": coll,
                            "title": title,
                            "url": url,
                            "source_path": source_path,
                            "text": text,
                            "score": point.score
                        })
            
            t3 = time.time()
            log_api_step(f"Query points completed in {t3-t2:.2f}s, found {len(related_docs)} items")
            
            if not related_docs:
                log_api_step(f"No related documents found for keyword '{keyword}'")
                return {
                    "mode": "detail",
                    "keyword": keyword,
                    "keyword_doc": None,
                    "related_docs": [],
                    "recent_docs": [],
                    "stats": stats,
                    "message": f"找不到與「{keyword}」相關的文獻資料"
                }
            
            # 按相關度排序
            # 給 hedgedoc_notes 額外 5% 加權（偏好最新的 Hedgedoc 筆記）
            related_docs.sort(key=lambda x: x["score"] * (1.05 if x["collection"] == "hedgedoc_notes" else 1.0), reverse=True)
            
            # 最頂端的一筆作為「今日焦點」
            top_doc = related_docs[0]
            keyword_doc = {
                "id": top_doc["id"],
                "collection": top_doc["collection"],
                "title": top_doc["title"],
                "url": top_doc["url"],
                "source_path": top_doc["source_path"],
                "snippet": top_doc["text"][:500] + ("..." if len(top_doc["text"]) > 500 else ""),
                "text_length": len(top_doc["text"])
            }
            
            # 剩餘的做為「關聯文獻」，去重並限制數量最多 6 筆
            seen_titles = set([top_doc["title"]])
            unique_related = []
            for doc in related_docs[1:]:
                if doc["title"] not in seen_titles:
                    seen_titles.add(doc["title"])
                    unique_related.append({
                        "id": doc["id"],
                        "collection": doc["collection"],
                        "title": doc["title"],
                        "url": doc["url"],
                        "source_path": doc["source_path"],
                        "snippet": doc["text"][:300] + ("..." if len(doc["text"]) > 300 else ""),
                        "score": round(doc["score"], 4)
                    })
                if len(unique_related) >= 6:
                    break
            
            # 取得近期加入的資料（從該 collection 中 scroll 出來）
            recent_formatted = []
            try:
                scroll_res = qdrant.scroll(
                    collection_name=top_doc["collection"],
                    limit=8,
                    with_payload=True,
                    with_vectors=False
                )
                for point in scroll_res[0]:
                    if str(point.id) == top_doc["id"]:
                        continue
                    t = extract_text_from_payload(point.payload)
                    ttl, u, sp = extract_metadata_from_payload(point.payload, top_doc["collection"])
                    if t and ttl:
                        recent_formatted.append({
                            "id": str(point.id),
                            "collection": top_doc["collection"],
                            "title": ttl,
                            "url": u,
                            "source_path": sp,
                            "snippet": t[:200] + ("..." if len(t) > 200 else "")
                        })
                    if len(recent_formatted) >= 6:
                        break
            except Exception as e_scroll:
                log_api_step(f"Scroll recent error: {e_scroll}")
            
            t4 = time.time()
            log_api_step(f"Explore details processed in {t4-t3:.2f}s. Total: {t4-t0:.2f}s")
            
            return {
                "mode": "detail",
                "keyword": keyword,
                "keyword_doc": keyword_doc,
                "related_docs": unique_related,
                "recent_docs": recent_formatted,
                "stats": stats
            }
            
    except Exception as e:
        msg_err = f"Explore error: {e}"
        print(msg_err, flush=True)
        log_api_step(msg_err)
        raise HTTPException(status_code=500, detail=f"探索知識庫時發生錯誤: {str(e)}")


SYNTHESIS_CACHE_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'data', 'daily_synthesis_cache.json'))

def load_synthesis_cache():
    try:
        if os.path.exists(SYNTHESIS_CACHE_FILE):
            with open(SYNTHESIS_CACHE_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception:
        pass
    return {}

def save_synthesis_cache(data):
    os.makedirs(os.path.dirname(SYNTHESIS_CACHE_FILE), exist_ok=True)
    with open(SYNTHESIS_CACHE_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

@app.get("/daily-synthesis")
async def daily_synthesis(
    collections: str = Query(default="hedgedoc_notes,obsidian_notes", description="逗號分隔的 collection 名稱"),
    force: bool = Query(default=False, description="強制重新生成（忽略快取）"),
    gemini_api_key: Optional[str] = Query(default=None, description="Gemini API 金鑰"),
    gemini_model: Optional[str] = Query(default=None, description="Gemini 模型名稱")
):
    """每日合成摘要 — 分析知識庫筆記，產出連結、模式、矛盾、最佳捕捉四大區塊"""
    import time
    from datetime import datetime, date
    
    target_collections = [c.strip() for c in collections.split(",") if c.strip()]
    today_str = date.today().isoformat()
    hedgedoc_base = ""
    
    try:
        settings_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'data', 'settings.json'))
        if os.path.exists(settings_path):
            with open(settings_path, 'r', encoding='utf-8') as f:
                settings_data = json.load(f)
                if not gemini_api_key:
                    gemini_api_key = settings_data.get("geminiApiKey", "")
                if not gemini_model:
                    gemini_model = settings_data.get("geminiModel", "gemini-2.5-flash")
                hedgedoc_base = settings_data.get("hedgedocUrl", "").rstrip('/')
    except Exception as e_settings:
        log_api_step(f"Error loading settings in daily-synthesis: {e_settings}")
    
    # 快取檢查：同日直接回傳
    if not force:
        cache = load_synthesis_cache()
        if cache.get("date") == today_str and cache.get("synthesis"):
            log_api_step(f"Daily synthesis cache hit for {today_str}")
            # 取得最新 stats
            stats = {}
            for coll in target_collections:
                if qdrant.collection_exists(collection_name=coll):
                    info = qdrant.get_collection(collection_name=coll)
                    stats[coll] = info.points_count
                else:
                    stats[coll] = 0
            stats["latest_date"] = get_latest_data_date(target_collections)
            cache["stats"] = stats
            cache["cached"] = True
            
            # 確保 selected_notes 包含 url & source_path (補填邏輯以防舊快取無此資料)
            if "selected_notes" in cache:
                needs_enrich = any("url" not in n or "source_path" not in n for n in cache["selected_notes"])
                if needs_enrich:
                    log_api_step("Enriching cache selected_notes with urls and paths")
                    # 建立標題對應的 URL/source_path 快取
                    note_map = {}
                    for coll in target_collections:
                        if not qdrant.collection_exists(collection_name=coll):
                            continue
                        scroll_res = qdrant.scroll(collection_name=coll, limit=50, with_payload=True, with_vectors=False)
                        for point in scroll_res[0]:
                            title, url, source_path = extract_metadata_from_payload(point.payload, coll)
                            if title:
                                resolved_url = url
                                if coll == "hedgedoc_notes" and hedgedoc_base:
                                    if resolved_url and not resolved_url.startswith("http"):
                                        resolved_url = f"{hedgedoc_base}/{resolved_url}"
                                    elif not resolved_url:
                                        doc_id = point.payload.get("id", point.payload.get("metadata", {}).get("id", ""))
                                        if doc_id:
                                            resolved_url = f"{hedgedoc_base}/{doc_id}"
                                note_map[(title.strip(), coll)] = (resolved_url, source_path)
                    
                    # 補填 url 與 source_path
                    for n in cache["selected_notes"]:
                        title = n.get("title", "").strip()
                        coll = n.get("collection", "")
                        if (title, coll) in note_map:
                            n["url"], n["source_path"] = note_map[(title, coll)]
                        else:
                            n.setdefault("url", "")
                            n.setdefault("source_path", "")
                    
                    # 寫回快取檔案中
                    save_synthesis_cache(cache)
            return cache
    
    try:
        t0 = time.time()
        log_api_step(f"===> Daily synthesis started: collections={target_collections}, force={force}")
        
        # 1. 取得各 collection 的統計資訊
        stats = {}
        valid_collections = []
        for coll in target_collections:
            if not qdrant.collection_exists(collection_name=coll):
                continue
            info = qdrant.get_collection(collection_name=coll)
            count = info.points_count
            stats[coll] = count
            if count > 0:
                valid_collections.append((coll, count))
        
        stats["latest_date"] = get_latest_data_date(target_collections)
        
        t1 = time.time()
        log_api_step(f"Daily synthesis stats loaded in {t1-t0:.2f}s: {stats}")
        
        # 2. 從各 collection 隨機取得筆記
        all_notes = []
        for coll in target_collections:
            if not qdrant.collection_exists(collection_name=coll):
                continue
            scroll_res = qdrant.scroll(
                collection_name=coll,
                limit=50,
                with_payload=True,
                with_vectors=False
            )
            for point in scroll_res[0]:
                title, url, source_path = extract_metadata_from_payload(point.payload, coll)
                text = extract_text_from_payload(point.payload)
                if title and text and len(text.strip()) > 50:
                    # Resolve URL for hedgedoc notes if needed
                    resolved_url = url
                    if coll == "hedgedoc_notes" and hedgedoc_base:
                        if resolved_url and not resolved_url.startswith("http"):
                            resolved_url = f"{hedgedoc_base}/{resolved_url}"
                        elif not resolved_url:
                            doc_id = point.payload.get("id", point.payload.get("metadata", {}).get("id", ""))
                            if doc_id:
                                resolved_url = f"{hedgedoc_base}/{doc_id}"
                    
                    all_notes.append({
                        "title": title.strip(),
                        "text": text.strip(),
                        "collection": coll,
                        "url": resolved_url,
                        "source_path": source_path
                    })
        
        random.shuffle(all_notes)
        selected_notes = all_notes[:15]
        
        t2 = time.time()
        log_api_step(f"Daily synthesis collected {len(selected_notes)} notes in {t2-t1:.2f}s")
        
        if len(selected_notes) < 3:
            return {
                "date": today_str,
                "synthesis": None,
                "stats": stats,
                "notes_analyzed": len(selected_notes),
                "cached": False,
                "error": "知識庫中筆記數量不足（至少需要 3 篇），無法進行合成分析"
            }
        
        # 3. 構建 LLM Prompt
        notes_context = ""
        for idx, note in enumerate(selected_notes):
            snippet = note["text"][:300].replace("\n", " ")
            notes_context += f"\n筆記 {idx+1}: 標題:「{note['title']}」, 來源: {note['collection']}, 內容節錄:「{snippet}...」\n"
        
        synthesis_prompt = f"""你是一位具備深度分析能力的知識庫研究員。以下是從個人知識庫中隨機抽取的 {len(selected_notes)} 篇筆記。

請針對這些筆記進行「每日合成分析」，嚴格依照以下 JSON 格式輸出四個分析區塊。

## 分析要求：

1. **連結 (Connections)**：找出兩份「表面上無關」的筆記之間的非顯而易見關聯。不要選擇主題相近的筆記，要找出跨領域、跨主題的深層連結。
2. **模式 (Pattern)**：總結跨越至少三份筆記的共同主題或趨勢。這個模式應該是筆記作者可能沒有意識到的潛在趨勢。
3. **矛盾 (Contradiction)**：標示出不同筆記中在某個議題上相互衝突或矛盾的立場。如果沒有直接矛盾，可以指出潛在的張力或不一致之處。
4. **最佳捕捉 (Best Capture)**：推薦單一最值得深入發展的筆記，並說明為什麼這篇最值得擴展，以及可能的發展方向。

## 筆記內容：
{notes_context}

## 輸出格式（嚴格 JSON）：

請直接輸出以下 JSON，不要加任何 markdown 代碼區塊標記或多餘文字：

{{
  "connections": {{
    "note_a_title": "筆記A的標題",
    "note_a_collection": "筆記A的來源集合",
    "note_b_title": "筆記B的標題",
    "note_b_collection": "筆記B的來源集合",
    "insight": "這兩篇筆記之間的非顯而易見關聯（2-3 句）",
    "reasoning": "你的推理過程簡述"
  }},
  "pattern": {{
    "theme": "共同主題名稱（簡短）",
    "note_titles": ["涉及的筆記標題1", "筆記標題2", "筆記標題3"],
    "summary": "這些筆記共同反映出的趨勢或模式（2-3 句）"
  }},
  "contradiction": {{
    "note_a_title": "筆記A的標題",
    "note_a_collection": "筆記A的來源集合",
    "note_a_stance": "筆記A的立場簡述",
    "note_b_title": "筆記B的標題",
    "note_b_collection": "筆記B的來源集合",
    "note_b_stance": "筆記B的立場簡述",
    "conflict": "這兩篇筆記在哪個議題上存在衝突或張力（1-2 句）"
  }},
  "best_capture": {{
    "note_title": "推薦筆記的標題",
    "note_collection": "推薦筆記的來源集合",
    "reason": "為什麼這篇最值得深入發展（2-3 句）",
    "development_directions": ["發展方向1", "發展方向2", "發展方向3"]
  }}
}}"""

        # 4. 呼叫 LLM
        synthesis_result = None
        method_used = "none"
        raw_response = ""
        
        # 4a. 優先嘗試 Gemini API
        if gemini_api_key:
            try:
                g_model = gemini_model or "gemini-2.5-flash"
                log_api_step(f"Daily synthesis: calling Gemini API ({g_model})")
                
                url = f"https://generativelanguage.googleapis.com/v1beta/models/{g_model}:generateContent?key={gemini_api_key}"
                payload = {
                    "contents": [{"parts": [{"text": synthesis_prompt}]}],
                    "generationConfig": {"temperature": 0.7, "maxOutputTokens": 4096}
                }
                req = urllib.request.Request(
                    url,
                    data=json.dumps(payload).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                with urllib.request.urlopen(req, timeout=60) as resp:
                    resp_data = json.loads(resp.read().decode('utf-8'))
                    raw_response = resp_data.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '').strip()
                
                log_api_step(f"Gemini daily synthesis raw response length: {len(raw_response)}")
                method_used = "gemini"
            except Exception as e_gemini:
                log_api_step(f"Gemini daily synthesis failed: {e_gemini}")
        
        # 4b. 降級使用 Ollama
        if not raw_response:
            try:
                log_api_step("Daily synthesis: falling back to Ollama")
                response = ollama_client.chat(model="gemma3:270m", messages=[
                    {'role': 'user', 'content': synthesis_prompt}
                ])
                raw_response = response['message']['content'].strip()
                log_api_step(f"Ollama daily synthesis raw response length: {len(raw_response)}")
                method_used = "ollama"
            except Exception as e_ollama:
                log_api_step(f"Ollama daily synthesis failed: {e_ollama}")
        
        # 5. 解析 JSON 回應
        if raw_response:
            try:
                # 清理可能的 markdown 代碼區塊標記
                cleaned = raw_response.strip()
                if cleaned.startswith("```"):
                    # 去掉 ```json 和 ```
                    cleaned = re.sub(r'^```(?:json)?\s*\n?', '', cleaned)
                    cleaned = re.sub(r'\n?```\s*$', '', cleaned)
                synthesis_result = json.loads(cleaned)
                log_api_step(f"Daily synthesis JSON parsed successfully")
            except json.JSONDecodeError as e_json:
                log_api_step(f"Daily synthesis JSON parse failed: {e_json}, raw: {raw_response[:200]}")
                # 嘗試找到第一個 { 和最後一個 }
                first_brace = raw_response.find('{')
                last_brace = raw_response.rfind('}')
                if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
                    try:
                        synthesis_result = json.loads(raw_response[first_brace:last_brace+1])
                        log_api_step("Daily synthesis JSON parsed on second attempt (brace extraction)")
                    except json.JSONDecodeError:
                        synthesis_result = {"raw_text": raw_response}
                        log_api_step("Daily synthesis falling back to raw text")
                else:
                    synthesis_result = {"raw_text": raw_response}
        
        t3 = time.time()
        log_api_step(f"Daily synthesis completed in {t3-t0:.2f}s using {method_used}")
        
        result = {
            "date": today_str,
            "synthesis": synthesis_result,
            "stats": stats,
            "notes_analyzed": len(selected_notes),
            "cached": False,
            "method": method_used,
            "selected_notes": [{"title": n["title"], "collection": n["collection"], "url": n.get("url", ""), "source_path": n.get("source_path", "")} for n in selected_notes]
        }
        
        # 6. 快取結果
        if synthesis_result and "raw_text" not in synthesis_result:
            save_synthesis_cache(result)
            log_api_step(f"Daily synthesis cached for {today_str}")
        
        return result
        
    except Exception as e:
        msg_err = f"Daily synthesis error: {e}"
        print(msg_err, flush=True)
        log_api_step(msg_err)
        raise HTTPException(status_code=500, detail=f"每日合成分析時發生錯誤: {str(e)}")


@app.get("/stats")
async def get_stats(
    collections: str = Query(default="hedgedoc_notes,obsidian_notes")
):
    """取得知識庫各 collection 的統計資訊"""
    target_collections = [c.strip() for c in collections.split(",") if c.strip()]
    stats = {}
    total = 0
    for coll in target_collections:
        if qdrant.collection_exists(collection_name=coll):
            info = qdrant.get_collection(collection_name=coll)
            count = info.points_count
            stats[coll] = count
            total += count
        else:
            stats[coll] = 0
            
    latest_date = get_latest_data_date(target_collections)
    stats["latest_date"] = latest_date
    
    return {"stats": stats, "total": total, "latest_date": latest_date}


@app.post("/ask")
async def ask_database(request: QueryRequest):
    user_query = request.query
    model_to_use = request.model or OLLAMA_MODEL
    try:
        # 1. 將使用者查詢轉換為向量
        query_vector = embedder.encode(user_query).tolist()
        
        # 1.5 使用前端指定的知識庫集合
        target_collections = request.collections or ["hedgedoc_notes", "obsidian_notes"]
        all_points = []
        
        # 讀取動態門檻
        fb = load_feedback()
        score_threshold = fb.get("score_threshold", 0.25)
        
        # 2. 跨多個 Table (Collection) 搜尋 (每個表抓 30 筆候選以確保覆蓋率)
        for collection_name in target_collections:
            if qdrant.collection_exists(collection_name=collection_name):
                res = qdrant.query_points(
                    collection_name=collection_name,
                    query=query_vector,
                    limit=30
                )
                for point in res.points:
                    all_points.append((collection_name, point))

        if not all_points:
            return {
                "query": user_query,
                "answer": "在目標的向量資料庫表中找不到任何可用關聯資料，可能為空或尚未寫入。", 
                "source_documents": [],
                "score_threshold": score_threshold
            }
            
        # 混合兩個資料表，依據分數排序 (給 hedgedoc_notes 額外 5% 加權)
        all_points.sort(key=lambda x: x[1].score * (1.05 if x[0] == "hedgedoc_notes" else 1.0), reverse=True)
        
        # 打印前 10 筆分數供除錯
        print(f"==> Embedding模型: {EMBEDDER_MODEL} | 動態門檻: {score_threshold:.3f} | 原始候選: {len(all_points)}", flush=True)
        for idx, (c, p) in enumerate(all_points[:10]):
            title_debug, _, _ = extract_metadata_from_payload(p.payload, c)
            print(f"    #{idx+1} [{c}] score={p.score:.4f} title={title_debug[:40]}", flush=True)
        
        # 自動過濾：只保留分數高於動態門檻的結果，至少保留 3 筆
        relevant_points = [(c, p) for c, p in all_points if p.score >= score_threshold]
        if len(relevant_points) < 3:
            relevant_points = all_points[:3]
        candidate_points = relevant_points[:request.top_k * 3]
        
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
                
            # 過濾重複內容 (超過 50% 相似度即拋棄)
            is_duplicate = False
            for exist_chunk in truncated_texts:
                if difflib.SequenceMatcher(None, chunk[:200], exist_chunk[:200]).ratio() > 0.50:
                    is_duplicate = True
                    break
            
            if is_duplicate:
                continue
                
            # 總長度上限 4000 字
            if total_length + len(chunk) > 4000:
                allowed_len = max(0, 4000 - total_length)
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
            response = ollama_client.chat(model=model_to_use, messages=[
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

@app.get("/debug-payload")
async def debug_payload(
    collections: str = Query(default="hedgedoc_notes,obsidian_notes"),
    limit: int = Query(default=2, description="每個 collection 抓幾筆")
):
    """
    除錯用 endpoint：列出各 collection 前幾筆的原始 payload 結構，
    並顯示 extract_date_from_payload 的解析結果，方便確認日期欄位是否讀得到。
    """
    target_collections = [c.strip() for c in collections.split(",") if c.strip()]
    result = {}
    for coll in target_collections:
        if not qdrant.collection_exists(collection_name=coll):
            result[coll] = {"error": "collection not found"}
            continue
        scroll_res = qdrant.scroll(
            collection_name=coll,
            limit=limit,
            with_payload=True,
            with_vectors=False
        )
        points_info = []
        for point in scroll_res[0]:
            payload = point.payload or {}
            parsed_date = extract_date_from_payload(payload)
            # 列出所有 payload 的頂層鍵值（截短長字串）
            payload_summary = {}
            for k, v in payload.items():
                if isinstance(v, str) and len(v) > 100:
                    payload_summary[k] = v[:100] + "..."
                elif isinstance(v, dict):
                    payload_summary[k] = {kk: (str(vv)[:60] + "..." if isinstance(vv, str) and len(vv) > 60 else vv)
                                          for kk, vv in v.items()}
                else:
                    payload_summary[k] = v
            points_info.append({
                "id": str(point.id),
                "parsed_date": parsed_date,
                "payload_keys": list(payload.keys()),
                "payload_summary": payload_summary
            })
        result[coll] = points_info
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
