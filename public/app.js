/* ────────────────────────────────────────────────────
   X Post Processor — Frontend Application
   ──────────────────────────────────────────────────── */

const API = '';

// ─── State ────────────────────────────────────────────
let currentTweet = null;
let currentVideoPath = null;
let currentDirectVideoPath = null;
let currentDirectVideoFilename = null;
let currentDirectVideoUrl = null;
let currentScript = null;
let selectedNoteIds = new Set();
let currentPodcastId = null;
let systemPollInterval = null;
let systemChart = null;

// ─── Init ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    loadNotesList();
    loadPodcastList();
    loadVideosList();

    // Restore podcast playback progress
    const podcastAudio = document.getElementById('podcastAudio');
    podcastAudio.addEventListener('timeupdate', onPodcastTimeUpdate);
    podcastAudio.addEventListener('ended', onPodcastEnded);
    podcastAudio.addEventListener('loadedmetadata', onPodcastLoaded);

    // Driving mode lock screen events
    const lockScreen = document.getElementById('drivingLockScreen');
    if (lockScreen) {
        lockScreen.addEventListener('mousedown', handleLockScreenTouchStart);
        lockScreen.addEventListener('mouseup', handleLockScreenTouchEnd);
        lockScreen.addEventListener('mouseleave', handleLockScreenTouchEnd);
        lockScreen.addEventListener('touchstart', handleLockScreenTouchStart, {passive: true});
        lockScreen.addEventListener('touchend', handleLockScreenTouchEnd);
    }
});

// ─── Navigation ───────────────────────────────────────
function switchPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    document.getElementById(`page-${page}`).classList.add('active');
    const navBtn = document.querySelector(`[data-page="${page}"]`);
    if (navBtn) navBtn.classList.add('active');

    // Refresh data when switching pages
    if (page === 'notes') loadNotesList();
    if (page === 'tasks') TaskQueue.render();
    if (page === 'podcast') {
        loadPodcastNoteSelect();
    }
    if (page === 'player') {
        loadPodcastList();
    }
    if (page === 'video') {
        loadVideosList();
    }
    if (page === 'files') {
        loadFilesList();
    }
    if (page === 'rag') {
        loadDailySynthesis();
    }

    if (page === 'system') {
        loadSystemStatus();
        if (!systemPollInterval) {
            systemPollInterval = setInterval(loadSystemStatus, 2000);
        }
    } else {
        if (systemPollInterval) {
            clearInterval(systemPollInterval);
            systemPollInterval = null;
        }
        if (systemChart) {
            systemChart.destroy();
            systemChart = null;
        }
    }
}

// ─── Toast Notifications ──────────────────────────────
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const icons = { success: '✅', error: '❌', info: 'ℹ️' };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `${icons[type] || ''} ${message}`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ─── Loading ──────────────────────────────────────────
let currentLoadingTarget = null;

function showLoading(text = '處理中...') {
    if (currentLoadingTarget) {
        const el = document.getElementById(currentLoadingTarget);
        if (el) {
            el.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;border-top-color:var(--accent-primary);margin-right:8px;vertical-align:middle;"></span><span style="vertical-align:middle;">' + text.replace(/\n/g, ' ') + '</span>';
            el.style.display = 'inline-flex';
        }
    } else {
        document.getElementById('loadingText').innerText = text;
        document.getElementById('loadingOverlay').classList.add('show');
    }
}

function hideLoading() {
    if (currentLoadingTarget) {
        const el = document.getElementById(currentLoadingTarget);
        if (el) {
            el.style.display = 'none';
            el.innerHTML = '';
        }
    }
    document.getElementById('loadingOverlay').classList.remove('show');
}

// ─── Step Indicator ───────────────────────────────────
function setStep(stepId) {
    const steps = ['parse', 'media', 'note', 'save'];
    const idx = steps.indexOf(stepId);

    document.getElementById('processSteps').style.display = 'flex';

    steps.forEach((s, i) => {
        const el = document.getElementById(`step-${s}`);
        el.classList.remove('active', 'done');
        if (i < idx) el.classList.add('done');
        if (i === idx) el.classList.add('active');
    });
}

// ─── Settings ─────────────────────────────────────────
async function loadSettings() {
    try {
        const res = await fetch(`${API}/api/settings`);
        const settings = await res.json();

        document.getElementById('settingGeminiKey').value = settings.geminiApiKey || '';
        document.getElementById('settingHedgedocUrl').value = settings.hedgedocUrl || '';
        document.getElementById('settingHedgedocCookie').value = settings.hedgedocCookie || '';
        document.getElementById('settingWhisperUrl').value = settings.whisperUrl || 'http://localhost:8080';
        document.getElementById('settingKokoroUrl').value = settings.kokoroUrl || 'http://localhost:8880';
        document.getElementById('settingRagUrl').value = settings.ragUrl || 'http://localhost:8866';
        document.getElementById('settingRagModel').value = settings.ragModel || 'sorc/qwen3.5-instruct:0.8b';
        document.getElementById('settingXCookie').value = settings.xCookie || '';
        const igEl = document.getElementById('settingIgCookie');
        if (igEl) igEl.value = settings.igCookie || '';

        // Load available models from API, then set the saved value
        const savedModel = settings.geminiModel || 'gemma-4-26b-a4b-it';
        if (settings.geminiApiKey) {
            await loadGeminiModels(savedModel);
        } else {
            document.getElementById('settingGeminiModel').value = savedModel;
        }
    } catch (e) {
        console.error('Load settings error:', e);
    }
}

async function saveSettings() {
    try {
        const settings = {
            geminiApiKey: document.getElementById('settingGeminiKey').value.trim(),
            geminiModel: document.getElementById('settingGeminiModel').value,
            hedgedocUrl: document.getElementById('settingHedgedocUrl').value.trim().replace(/\/$/, ''),
            hedgedocCookie: document.getElementById('settingHedgedocCookie').value.trim(),
            whisperUrl: document.getElementById('settingWhisperUrl').value.trim().replace(/\/$/, ''),
            kokoroUrl: document.getElementById('settingKokoroUrl').value.trim().replace(/\/$/, ''),
            ragUrl: document.getElementById('settingRagUrl').value.trim().replace(/\/$/, ''),
            ragModel: document.getElementById('settingRagModel').value.trim(),
            xCookie: document.getElementById('settingXCookie').value.trim(),
            igCookie: (document.getElementById('settingIgCookie')?.value || '').trim()
        };

        const res = await fetch(`${API}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        const data = await res.json();
        if (data.success) {
            showToast('設定已儲存', 'success');
        } else {
            throw new Error('儲存失敗');
        }
    } catch (e) {
        showToast(`儲存失敗: ${e.message}`, 'error');
    }
}

// ─── Load Gemini Models ───────────────────────────────────
async function loadGeminiModels(selectedModel) {
    const select = document.getElementById('settingGeminiModel');
    const status = document.getElementById('modelLoadStatus');

    // Show loading state
    if (status) {
        status.style.display = 'block';
        status.textContent = '⏳ 正在載入可用模型...';
        status.style.color = 'var(--text-muted)';
    }

    // Remember current selection if no explicit model passed
    const currentValue = selectedModel || select.value || 'gemma-4-26b-a4b-it';

    try {
        const res = await fetch(`${API}/api/gemini/models`);
        const data = await res.json();

        if (!res.ok || !data.success) {
            throw new Error(data.error || '載入失敗');
        }

        // Rebuild options
        select.innerHTML = '';
        data.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.id === 'gemma-4-26b-a4b-it' ? `${m.id} (預設)` : m.id;
            opt.title = m.description || '';
            select.appendChild(opt);
        });

        // Restore selection — if the saved model exists in the list, select it
        const modelExists = Array.from(select.options).some(o => o.value === currentValue);
        if (modelExists) {
            select.value = currentValue;
        } else {
            // If saved model not found, add it as a custom option and select it
            const customOpt = document.createElement('option');
            customOpt.value = currentValue;
            customOpt.textContent = `${currentValue} (自訂)`;
            select.insertBefore(customOpt, select.firstChild);
            select.value = currentValue;
        }

        if (status) {
            status.textContent = `✅ 已載入 ${data.models.length} 個可用模型`;
            status.style.color = '#10b981';
            setTimeout(() => { status.style.display = 'none'; }, 3000);
        }
    } catch (e) {
        console.error('Load Gemini models error:', e);
        if (status) {
            status.textContent = `❌ ${e.message}`;
            status.style.color = '#ef4444';
        }
        // Keep the current option so the user can still use it
        if (select.options.length === 0 || !Array.from(select.options).some(o => o.value === currentValue)) {
            select.innerHTML = `<option value="${currentValue}">${currentValue}</option>`;
            select.value = currentValue;
        }
    }
}

// ─── Download URL Platform Detector ─────────────────────
function detectDownloadPlatform(url) {
    if (!url) return null;
    if (/instagram\.com\/(p|reel|tv)\//i.test(url)) return { label: '📸 Instagram', color: '#e1306c', bg: '#fce4ec' };
    if (/x\.com|twitter\.com/i.test(url))           return { label: '✕ X (Twitter)', color: '#1da1f2', bg: '#e3f2fd' };
    if (/youtube\.com|youtu\.be/i.test(url))         return { label: '▶️ YouTube', color: '#ff0000', bg: '#fce4e4' };
    if (url.startsWith('http'))                       return { label: '🌐 其他影片', color: '#6c757d', bg: 'var(--bg-input)' };
    return null;
}

function onDownloadUrlInput(val) {
    const badge = document.getElementById('dlPlatformBadge');
    if (!badge) return;
    const p = detectDownloadPlatform(val.trim());
    if (p) {
        badge.style.display = 'inline-block';
        badge.style.color = p.color;
        badge.style.background = p.bg;
        badge.style.border = `1px solid ${p.color}44`;
        badge.textContent = p.label;
    } else {
        badge.style.display = 'none';
    }
}

async function pasteAndDetect() {
    await pasteFromClipboard('downloadUrl');
    const val = document.getElementById('downloadUrl')?.value || '';
    onDownloadUrlInput(val);
}

// ─── Task Queue ───────────────────────────────────────
const TaskQueue = {
    queue: [],

    async fetchQueue() {
        try {
            const res = await fetch(`${API}/api/tasks?_t=${Date.now()}`);
            const data = await res.json();
            if (data.success) {
                const oldQueue = this.queue || [];
                this.queue = data.queue;
                this.render();
                
                // Refresh lists if any task finished
                let hasNewlyDone = false;
                for (const t of this.queue) {
                    const oldT = oldQueue.find(o => o.id === t.id);
                    if (t.status === 'done' && (!oldT || oldT.status !== 'done')) {
                        hasNewlyDone = true;
                    }
                }
                if (hasNewlyDone) {
                    if (typeof loadNotesList === 'function') loadNotesList();
                    if (typeof loadPodcastList === 'function') loadPodcastList();
                    if (typeof loadVideosList === 'function') loadVideosList();
                }
            }
        } catch(e) {}
    },

    async addProcessTask(url, platformLabel = '') {
        if (!url) return;
        const taskName = platformLabel ? `處理${platformLabel}...` : '處理連結...';
        try {
            const res = await fetch(`${API}/api/tasks/add`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({type: 'process', name: taskName, data: {url}}) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await this.fetchQueue();
            showToast('已加入處理佇列', 'success');
        } catch(e) {
            console.error('addProcessTask error:', e);
            showToast(`加入失敗：伺服器無回應，請確認伺服器是否已啟動`, 'error');
        }
    },

    async addPodcastTask(noteIdsArray, notesData, title, language = 'zh') {
        const name = `Podcast: ${title.substring(0, 20)}...`;
        try {
            const res = await fetch(`${API}/api/tasks/add`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({type: 'podcast', name, data: {noteIds: noteIdsArray, title, language}}) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await this.fetchQueue();
            showToast('已加入 Podcast 佇列', 'success');
        } catch(e) {
            console.error('addPodcastTask error:', e);
            showToast(`加入失敗：伺服器無回應，請確認伺服器是否已啟動`, 'error');
        }
    },

    async addDownloadTask(url, quality = 'best') {
        if (!url) return;
        const platform = /instagram\.com/.test(url) ? 'IG影片' : 'X影片';
        const qualityLabel = quality !== 'best' ? ` (${quality}p)` : '';
        const name = `下載 ${platform}${qualityLabel}: ${url.substring(0, 25)}...`;
        try {
            const res = await fetch(`${API}/api/tasks/add`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({type: 'download', name, data: {url, quality}}) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await this.fetchQueue();
            showToast('已加入下載佇列', 'success');
        } catch(e) {
            console.error('addDownloadTask error:', e);
            showToast(`加入失敗：伺服器無回應，請確認伺服器是否已啟動`, 'error');
        }
    },

    async addDirectDownloadTask(url, quality = 'best') {
        if (!url) { showToast('請輸入連結', 'error'); return; }
        const platform = /instagram\.com/.test(url) ? 'IG影片' : /x\.com|twitter\.com/.test(url) ? 'X影片' : '影片';
        const qualityLabel = quality !== 'best' ? ` (${quality}p)` : '';
        const name = `下載 ${platform}${qualityLabel}: ${url.substring(0, 22)}...`;
        try {
            const res = await fetch(`${API}/api/tasks/add`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({type: 'direct-download', name, data: {url, quality}}) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await this.fetchQueue();
            showToast('已加入下載佇列', 'success');
        } catch(e) {
            console.error('addDirectDownloadTask error:', e);
            showToast(`加入失敗：伺服器無回應，請確認伺服器是否已啟動`, 'error');
        }
    },

    async addVideoNoteTask() {
        if (!currentDirectVideoFilename) return;
        try {
            const res = await fetch(`${API}/api/tasks/add`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({type: 'video-note', name: '影片轉筆記', data: {filename: currentDirectVideoFilename, url: currentDirectVideoUrl}}) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await this.fetchQueue();
            showToast('已加入影片轉筆記佇列', 'success');
        } catch(e) {
            console.error('addVideoNoteTask error:', e);
            showToast(`加入失敗：伺服器無回應，請確認伺服器是否已啟動`, 'error');
        }
    },

    async clearDone() {
        await fetch(`${API}/api/tasks/clear`, { method: 'POST' });
        this.fetchQueue();
    },

    render() {
        const container = document.getElementById('globalQueue');
        const list = document.getElementById('queueList');
        const pageList = document.getElementById('tasksPageList');
        
        let html = '';
        if (this.queue.length === 0) {
            if (container) container.style.display = 'none';
            if (pageList) pageList.innerHTML = `<div class="empty-state" style="padding:20px"><div class="icon">📭</div><p>目前沒有任何任務執行中</p></div>`;
            return;
        }

        if (container) container.style.display = 'block';
        
        html = this.queue.map(t => {
            let icon = '⏳';
            if (t.status === 'processing') icon = '<span class="spinner" style="width:14px;height:14px;border-width:2px;border-top-color:var(--accent-primary);"></span>';
            if (t.status === 'done') icon = '✅';
            if (t.status === 'error') icon = '❌';

            let opacity = t.status === 'done' || t.status === 'error' ? '0.7' : '1';

            return `
            <div style="background:var(--bg-input); border:1px solid var(--border); border-radius:8px; padding:10px; margin-bottom:8px; opacity:${opacity};">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <div style="font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:min(300px, 60vw);" title="${t.name}">${t.name}</div>
                    <div style="font-size:14px; flex-shrink:0;">${icon}</div>
                </div>
                <div style="font-size:11px; color:var(--text-muted);">${t.progress}</div>
            </div>`;
        }).join('');
        
        if (list) list.innerHTML = html;
        if (pageList) pageList.innerHTML = html;
    }
};

setInterval(() => TaskQueue.fetchQueue(), 2000);
TaskQueue.fetchQueue();


// Formats original X post text for readability
function formatOriginalText(text) {
    if (!text) return '';
    return text
        // Remove trailing media URLs
        .replace(/https?:\/\/(t\.co|x\.com|twitter\.com)\/\S+/g, '')
        // Remove repetitive newlines
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[\u200B-\u200D\uFEFF]/g, '') // remove invisible spaces/zero-width chars
        .trim()
        // Format as a markdown blockquote
        .split('\n')
        .map(line => line.trim() ? `> ${line.trim()}` : '>')
        .join('\n');
}

async function pasteFromClipboard(targetId = 'postUrl') {
    // Check for Clipboard API support properly
    if (!navigator.clipboard || !navigator.clipboard.readText) {
        if (!window.isSecureContext) {
            showToast('剪貼簿 API 僅支援 HTTPS 連線。請檢查網址是否為 https://', 'warning');
        } else {
            showToast('瀏覽器不支援自動貼上，請手動貼上。', 'warning');
        }
        return;
    }

    try {
        const text = await navigator.clipboard.readText();
        if (text && text.trim()) {
            const input = document.getElementById(targetId);
            if (input) {
                input.value = text.trim();
                showToast('已從剪貼簿貼上', 'success');
                // Manually trigger an input event for better compatibility
                input.dispatchEvent(new Event('input', { bubbles: true }));
                // 自動加入處理列表
                if (targetId === 'postUrl') {
                    enqueueProcessPost();
                }
            }
        } else if (text === '') {
            showToast('剪貼簿目前沒有文字', 'info');
        } else {
            // navigator.clipboard.readText() might return empty or null depending on permissions
            showToast('讀取不到內容，請確保已允許存取剪貼簿', 'warning');
        }
    } catch (err) {
        console.error('Clipboard error:', err);
        // iOS Safari may show NotAllowedError if the user denies the prompt or it's not a clear gesture
        showToast('無法讀取剪貼簿，請允許貼上權限或手動輸入', 'error');
    }
}



function detectInputUrlType(url) {
    if (!url) return null;
    if (/(?:x\.com|twitter\.com)\/\w+\/(?:status|article)\/\d+/i.test(url)) return { type: 'x', label: 'X 貼文' };
    if (/(?:x\.com|twitter\.com)\/i\/article\/\d+/i.test(url)) return { type: 'x', label: 'X 文章' };
    if (/threads\.net/i.test(url)) return { type: 'threads', label: 'Threads 貼文' };
    if (/^https?:\/\//i.test(url)) return { type: 'web', label: '網頁' };
    return null;
}

function enqueueProcessPost() {
    const url = document.getElementById('postUrl').value.trim();
    if (!url) {
        showToast('請輸入連結', 'error');
        return;
    }
    const detected = detectInputUrlType(url);
    if (!detected) {
        showToast('請輸入有效的網址（支援 X、Threads、Blog、新聞網頁等）', 'error');
        return;
    }

    TaskQueue.addProcessTask(url, detected.label);
    document.getElementById('postUrl').value = '';
}

async function processPostWorker(task) {
    // Moved to backend TaskQueue
}

// ─── Show Tweet Preview ──────────────────────────────
function showTweetPreview(tweet) {
    document.getElementById('tweetPreview').style.display = 'block';
    document.getElementById('tweetAuthor').textContent = `@${tweet.author || 'unknown'}`;
    document.getElementById('tweetText').textContent = tweet.text || '（無法取得文字內容）';

    const badges = document.getElementById('tweetBadges');
    badges.innerHTML = '';
    if (tweet.hasVideo) {
        badges.innerHTML += '<span class="badge badge-info">🎬 含影片</span>';
    }
    if (tweet.parseError) {
        badges.innerHTML += '<span class="badge badge-warning">⚠️ 部分解析</span>';
    }
}

// ─── Show Video Player ────────────────────────────────
function showVideoPlayer(videoPath) {
    const container = document.getElementById('videoContainer');
    const player = document.getElementById('videoPlayer');
    player.src = videoPath;
    container.style.display = 'block';
}

// ─── Download Video Independently ─────────────────────
function enqueueDownloadVideo() {
    if (!currentTweet) return;
    TaskQueue.addDownloadTask(currentTweet.url);
}

async function downloadVideoWorker(task) {
    // Moved to backend TaskQueue
}

// ─── Direct Download ──────────────────────────────────
function enqueueDirectDownload() {
    const url = document.getElementById('downloadUrl').value.trim();
    if (!url) {
        showToast('請輸入影片連結', 'error');
        return;
    }
    // 識別是否為 IG 連結
    const isIG = /instagram\.com/.test(url);
    const isX  = /x\.com|twitter\.com/.test(url);
    if (!isIG && !isX && !url.startsWith('http')) {
        showToast('請輸入有效的連結', 'error');
        return;
    }
    const quality = document.getElementById('downloadQuality')?.value || 'best';
    TaskQueue.addDirectDownloadTask(url, quality);
    document.getElementById('downloadUrl').value = '';
}

async function directDownloadWorker(task) {
    // Moved to backend TaskQueue
}

function playDirectVideo() {
    const player = document.getElementById('directVideoPlayer');
    document.getElementById('directVideoContainer').style.display = 'block';
    player.play();
}

// ─── Video to Note ────────────────────────────────────
function enqueueVideoToNote() {
    if (!currentDirectVideoFilename) {
        showToast('請先下載影片', 'error');
        return;
    }
    TaskQueue.addVideoNoteTask();
}

async function processVideoNoteWorker(task) {
    // Moved to backend TaskQueue
}

function showVideoNoteResult(content, noteEntry) {
    document.getElementById('videoNoteResult').style.display = 'block';
    document.getElementById('videoNoteContent').innerHTML = renderMarkdown(content);

    if (noteEntry && noteEntry.url) {
        document.getElementById('videoNoteLink').href = noteEntry.url;
        document.getElementById('videoNoteLink').style.display = 'inline-flex';
        document.getElementById('videoNoteResultUrl').textContent = noteEntry.url;
    } else {
        document.getElementById('videoNoteLink').style.display = 'none';
        document.getElementById('videoNoteResultUrl').textContent = 'HedgeDoc 儲存失敗，但筆記內容如下';
    }
}

// ─── Load Videos List ──────────────────────────────────
async function loadVideosList() {
    try {
        const res = await fetch(`${API}/api/videos/list`);
        const data = await res.json();
        
        const container = document.getElementById('videosList');
        
        if (!data.videos || data.videos.length === 0) {
            container.innerHTML = `
              <div class="empty-state" style="padding:20px">
                <div class="icon">📭</div>
                <p>尚未有任何已下載影片</p>
              </div>
            `;
            return;
        }

        container.innerHTML = data.videos.map(v => `
          <div class="note-item fade-in" style="cursor: pointer;" onclick="playListedVideo('${v.filename}', '${v.path}', '${v.url || ''}')">
            <div class="note-icon" style="background:var(--accent-info)">🎬</div>
            <div class="note-info">
              <div class="note-title" style="word-break: break-all;">${escapeHtml(v.filename)}</div>
              <div class="note-meta">${formatDate(v.createdAt)}</div>
            </div>
            <div class="note-actions">
              <button class="btn btn-primary btn-sm">▶️ 播放 / 轉筆記</button>
              <button class="btn btn-danger btn-sm" onclick="deleteVideo(decodeURIComponent('${encodeURIComponent(v.filename)}'), event)">🗑️ 刪除</button>
            </div>
          </div>
        `).join('');
    } catch (e) {
        console.error('Load videos error:', e);
    }
}

async function deleteVideo(filename, event) {
    event.stopPropagation();
    if (!confirm(`確定要刪除影片「${filename}」嗎？\n(這也會一併刪除相關的音檔與資料)`)) return;

    try {
        const res = await fetch(`${API}/api/videos/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast('已刪除影片', 'success');
            loadVideosList();
        } else {
            showToast(`刪除失敗: ${data.error || '未知錯誤'}`, 'error');
        }
    } catch (e) {
        showToast('刪除失敗', 'error');
    }
}

function playListedVideo(filename, path, url) {
    currentDirectVideoPath = path;
    currentDirectVideoFilename = filename;
    currentDirectVideoUrl = url || `已下載檔案: ${filename}`;
    
    document.getElementById('btnPlayDirect').style.display = 'flex';
    document.getElementById('videoActionContainer').style.display = 'block';
    
    const player = document.getElementById('directVideoPlayer');
    player.src = path;
    document.getElementById('directVideoContainer').style.display = 'block';
    player.play();
    
    // Scroll to player
    player.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ─── Show Note Result ─────────────────────────────────
function showNoteResult(content, noteEntry) {
    document.getElementById('noteResult').style.display = 'block';
    document.getElementById('noteContent').innerHTML = renderMarkdown(content);

    if (noteEntry && noteEntry.url) {
        document.getElementById('noteLink').href = noteEntry.url;
        document.getElementById('noteLink').style.display = 'inline-flex';
        document.getElementById('noteResultUrl').textContent = noteEntry.url;
    } else {
        document.getElementById('noteLink').style.display = 'none';
        document.getElementById('noteResultUrl').textContent = 'HedgeDoc 儲存失敗，但筆記內容如下';
    }
}

// ─── Simple Markdown Renderer ─────────────────────────
function renderMarkdown(text) {
    if (!text) return '';

    let html = text
        // Code blocks
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        // Inline code
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // Headers
        .replace(/^### (.*$)/gm, '<h3>$1</h3>')
        .replace(/^## (.*$)/gm, '<h2>$1</h2>')
        .replace(/^# (.*$)/gm, '<h1>$1</h1>')
        // Bold
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        // Italic
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        // Unordered lists
        .replace(/^\s*[-*] (.*$)/gm, '<li>$1</li>')
        // Ordered lists
        .replace(/^\s*\d+\. (.*$)/gm, '<li>$1</li>')
        // Line breaks
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');

    // Wrap consecutive <li> in <ul>
    html = html.replace(/(<li>.*?<\/li>)(?:\s*<br>)*(<li>)/g, '$1$2');
    html = html.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
    // Fix nested <ul>
    html = html.replace(/<\/ul>\s*<ul>/g, '');

    return `<p>${html}</p>`;
}

// ─── Notes List ───────────────────────────────────────
async function loadNotesList() {
    try {
        const res = await fetch(`${API}/api/hedgedoc/list?_t=${Date.now()}`);
        const data = await res.json();

        const container = document.getElementById('notesList');

        if (!data.notes || data.notes.length === 0) {
            container.innerHTML = `
        <div class="empty-state">
          <div class="icon">📭</div>
          <p>尚未有任何筆記，去處理一些 X 貼文吧！</p>
        </div>
      `;
            return;
        }

        container.innerHTML = data.notes.map(note => `
      <div class="note-item fade-in">
        <div class="note-icon">📝</div>
        <div class="note-info">
          <div class="note-title">${escapeHtml(note.title)}</div>
          <div class="note-meta">${formatDate(note.createdAt)}</div>
        </div>
        <div class="note-actions">
          <a href="${escapeHtml(note.url)}" target="_blank" class="btn btn-secondary btn-sm">🔗 開啟</a>
          <button class="btn btn-danger btn-sm" onclick="deleteNote('${note.id}')">🗑️</button>
        </div>
      </div>
    `).join('');

    } catch (e) {
        console.error('Load notes error:', e);
    }
}

async function deleteNote(id) {
    if (!confirm('確定要刪除此筆記記錄嗎？')) return;

    try {
        await fetch(`${API}/api/hedgedoc/notes/${id}`, { method: 'DELETE' });
        loadNotesList();
        showToast('已刪除筆記記錄', 'success');
    } catch (e) {
        showToast('刪除失敗', 'error');
    }
}

// ─── Podcast: Note Selection ──────────────────────────
async function loadPodcastNoteSelect() {
    try {
        const res = await fetch(`${API}/api/hedgedoc/list?_t=${Date.now()}`);
        const data = await res.json();

        const container = document.getElementById('podcastNoteSelect');

        if (!data.notes || data.notes.length === 0) {
            container.innerHTML = '<div class="empty-state" style="padding:20px"><p>尚無可用筆記</p></div>';
            return;
        }

        container.innerHTML = data.notes.map(note => `
      <div class="note-select-item ${selectedNoteIds.has(note.id) ? 'selected' : ''}" 
           onclick="toggleNoteSelect('${note.id}', this)">
        <input type="checkbox" ${selectedNoteIds.has(note.id) ? 'checked' : ''} />
        <div>
          <div style="font-size:14px;font-weight:500">${escapeHtml(note.title)}</div>
          <div style="font-size:12px;color:var(--text-muted)">${formatDate(note.createdAt)}</div>
        </div>
      </div>
    `).join('');

    } catch (e) {
        console.error('Load notes for podcast error:', e);
    }
}

function toggleNoteSelect(id, el) {
    if (selectedNoteIds.has(id)) {
        selectedNoteIds.delete(id);
        el.classList.remove('selected');
        el.querySelector('input').checked = false;
    } else {
        selectedNoteIds.add(id);
        el.classList.add('selected');
        el.querySelector('input').checked = true;
    }

    document.getElementById('btnGenPodcast').disabled = selectedNoteIds.size === 0;
}

// ─── Podcast: Queue Handler ───────────────────────────
function enqueuePodcast() {
    if (selectedNoteIds.size === 0) {
        showToast('請先選擇至少一則筆記', 'error');
        return;
    }

    const noteIdsArray = Array.from(selectedNoteIds);
    let title = '未命名';

    // Attempt to get selected note titles from DOM
    const selectedEls = document.querySelectorAll('.note-select-item.selected');
    if (selectedEls.length > 0) {
        const titles = Array.from(selectedEls).map(el => {
            return el.querySelector('div div').textContent;
        });
        title = titles.join(' & ');
    }

    const language = document.getElementById('podcastLanguage').value;
    TaskQueue.addPodcastTask(noteIdsArray, null, title, language);

    // Uncheck all selected notes
    selectedNoteIds.clear();
    document.querySelectorAll('.note-select-item input').forEach(el => {
        el.checked = false;
        el.closest('.note-select-item').classList.remove('selected');
    });
    document.getElementById('btnGenPodcast').disabled = true;
}

function showScriptPreview(script) {
    const section = document.getElementById('scriptSection');
    const preview = document.getElementById('scriptPreview');
    section.style.display = 'block';

    // Try to parse the script from plain text block format
    const lines = [];
    try {
        const blocks = script.split(/\[(host_[fm])\]/i);
        for (let i = 1; i < blocks.length; i += 2) {
            const speaker = blocks[i].toLowerCase();
            const text = blocks[i+1].trim();
            if (text) {
                const displayName = speaker === 'host_f' ? '曉曉(F)' : '雲健(M)';
                const cssClass = speaker === 'host_f' ? 'speaker-a' : 'speaker-b';
                lines.push(`<div><span class="${cssClass}">${displayName}：</span>${escapeHtml(text)}</div>`);
            }
        }
    } catch (e) {
        console.error('Preview parsing error', e);
    }

    if (lines.length === 0) {
        preview.innerHTML = `<div>${escapeHtml(script)}</div>`;
    } else {
        preview.innerHTML = lines.join('');
    }
}

async function processPodcastWorker(task) {
    // Moved to backend TaskQueue
}

// ─── Podcast: Poll Task Status ────────────────────────
async function pollTaskStatus(taskId, podcastEntry, queueTaskId) {
    // Moved to backend TaskQueue Worker
}

// ─── Podcast: Player ──────────────────────────────────
function playPodcastById(id) {
    if (!window.loadedPodcasts) return;
    const podcast = window.loadedPodcasts.find(p => p.id === id);
    if (podcast) {
        playPodcast(podcast);
    }
}

function playPodcast(podcast) {
    currentPodcastId = podcast.id;

    // Switch to the player page automatically
    switchPage('player');

    const playerCard = document.getElementById('podcastPlayerCard');
    const audio = document.getElementById('podcastAudio');

    playerCard.style.display = 'block';
    document.getElementById('currentPodcastTitle').textContent = podcast.title;
    document.getElementById('podcastAudioTitle').textContent = podcast.title;
    
    // Updated for Driving mode
    document.getElementById('drivingPodcastTitle').textContent = podcast.title;

    audio.src = podcast.audioPath;

    // Restore progress
    if (podcast.progress && podcast.progress > 0) {
        audio.currentTime = podcast.progress;
    }

    audio.play().catch(() => { });
    document.getElementById('podcastPlayBtn').textContent = '⏸';
    document.getElementById('drivingPlayBtn').textContent = '⏸';
    document.getElementById('drivingLockPlayBtn').textContent = '⏸';
}

function togglePodcastPlay(e) {
    if (e) e.stopPropagation(); // prevent UI lock click event on mobile
    const audio = document.getElementById('podcastAudio');
    const btn = document.getElementById('podcastPlayBtn');
    const drivingBtn = document.getElementById('drivingPlayBtn');
    const drivingLockBtn = document.getElementById('drivingLockPlayBtn');

    if (audio.paused) {
        audio.play();
        btn.textContent = '⏸';
        drivingBtn.textContent = '⏸';
        drivingLockBtn.textContent = '⏸';
    } else {
        audio.pause();
        btn.textContent = '▶';
        drivingBtn.textContent = '▶';
        drivingLockBtn.textContent = '▶';
    }
}

function onPodcastTimeUpdate() {
    const audio = document.getElementById('podcastAudio');
    if (!audio.duration) return;

    const pct = (audio.currentTime / audio.duration) * 100;
    document.getElementById('podcastProgressBar').style.width = `${pct}%`;
    
    const curTimeStr = formatTime(audio.currentTime);
    const durStr = formatTime(audio.duration);
    document.getElementById('podcastCurrentTime').textContent = curTimeStr;
    document.getElementById('podcastDuration').textContent = durStr;
    document.getElementById('drivingPodcastTime').textContent = `${curTimeStr} / ${durStr}`;

    // Save progress every 5 seconds
    if (currentPodcastId && Math.floor(audio.currentTime) % 5 === 0) {
        savePodcastProgress(currentPodcastId, audio.currentTime, audio.duration);
    }
}

function onPodcastLoaded() {
    const audio = document.getElementById('podcastAudio');
    document.getElementById('podcastDuration').textContent = formatTime(audio.duration);
}

function onPodcastEnded() {
    document.getElementById('podcastPlayBtn').textContent = '▶';
    document.getElementById('drivingPlayBtn').textContent = '▶';
    document.getElementById('drivingLockPlayBtn').textContent = '▶';
    if (currentPodcastId) {
        savePodcastProgress(currentPodcastId, 0, document.getElementById('podcastAudio').duration);
        
        // Auto play next podcast sequentially (looping)
        playNextPodcast();
    }
}

function seekPodcast(event) {
    const audio = document.getElementById('podcastAudio');
    const bar = document.getElementById('podcastProgress');
    const rect = bar.getBoundingClientRect();
    const pct = (event.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
}

async function savePodcastProgress(id, progress, duration) {
    try {
        await fetch(`${API}/api/podcast/${id}/progress`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ progress, duration })
        });
    } catch (e) { }
}

// ─── Podcast List ─────────────────────────────────────
async function loadPodcastList() {
    try {
        const res = await fetch(`${API}/api/podcast/list`);
        const data = await res.json();

        const container = document.getElementById('podcastList');

        if (!data.podcasts || data.podcasts.length === 0) {
            container.innerHTML = `
        <div class="empty-state" style="padding:20px">
          <div class="icon">🎵</div>
          <p>尚未生成任何 Podcast</p>
        </div>
      `;
            return;
        }

        window.loadedPodcasts = data.podcasts;

        container.innerHTML = data.podcasts.map(p => {
            const progressPct = p.duration ? ((p.progress / p.duration) * 100).toFixed(0) : 0;
            return `
        <div class="podcast-item fade-in">
          <div class="podcast-item-header">
            <div class="podcast-icon">🎙️</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.title)}</div>
              <div style="font-size:12px;color:var(--text-muted)">${formatDate(p.createdAt)} ${p.progress > 0 ? `· 進度 ${progressPct}%` : ''}</div>
            </div>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-primary btn-sm" onclick="playPodcastById('${escapeHtml(p.id)}')">
              ▶ 播放
            </button>
            <button class="btn btn-danger btn-sm" onclick="deletePodcast('${p.id}')">🗑️</button>
          </div>
          ${p.progress > 0 ? `
            <div class="audio-progress mt-2" style="pointer-events:none">
              <div class="audio-progress-bar" style="width:${progressPct}%"></div>
            </div>
          ` : ''}
        </div>
      `;
        }).join('');

    } catch (e) {
        console.error('Load podcasts error:', e);
    }
}

async function deletePodcast(id) {
    if (!confirm('確定要刪除此 Podcast 嗎？')) return;

    try {
        await fetch(`${API}/api/podcast/${id}`, { method: 'DELETE' });
        loadPodcastList();
        showToast('已刪除 Podcast', 'success');

        if (currentPodcastId === id) {
            document.getElementById('podcastAudio').pause();
            document.getElementById('podcastPlayerCard').style.display = 'none';
            currentPodcastId = null;
        }
    } catch (e) {
        showToast('刪除失敗', 'error');
    }
}

// ─── Utilities ────────────────────────────────────────
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return d.toLocaleString('zh-TW', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
    });
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ─── Driving Mode & Sequential Play Logic ──────────────
function playNextPodcast() {
    if (!window.loadedPodcasts || !currentPodcastId || window.loadedPodcasts.length === 0) return;
    const currentIndex = window.loadedPodcasts.findIndex(p => p.id === currentPodcastId);
    if (currentIndex !== -1) {
        const nextIndex = (currentIndex + 1) % window.loadedPodcasts.length;
        playPodcast(window.loadedPodcasts[nextIndex]);
    }
}

function playPrevPodcast() {
    if (!window.loadedPodcasts || !currentPodcastId || window.loadedPodcasts.length === 0) return;
    const currentIndex = window.loadedPodcasts.findIndex(p => p.id === currentPodcastId);
    if (currentIndex !== -1) {
        const prevIndex = (currentIndex - 1 + window.loadedPodcasts.length) % window.loadedPodcasts.length;
        playPodcast(window.loadedPodcasts[prevIndex]);
    }
}

let isDrivingLocked = false;
let unlockTimer = null;

function enterDrivingMode() {
    if (!currentPodcastId) {
        showToast('請先播放一個 Podcast', 'info');
        return;
    }
    document.getElementById('drivingModeOverlay').style.display = 'flex';
}

function exitDrivingMode() {
    document.getElementById('drivingModeOverlay').style.display = 'none';
    isDrivingLocked = false;
    document.getElementById('drivingLockScreen').style.display = 'none';
}

function toggleDrivingLock() {
    isDrivingLocked = true;
    document.getElementById('drivingLockScreen').style.display = 'flex';
}

function unlockDrivingMode() {
    isDrivingLocked = false;
    document.getElementById('drivingLockScreen').style.display = 'none';
    showToast('鎖定已解除', 'success');
}

function handleLockScreenTouchStart(e) {
    // Exclude click on lock-play button
    if (e.target.id === 'drivingLockPlayBtn') return;
    unlockTimer = setTimeout(() => {
        unlockDrivingMode();
    }, 1000); // 1 second long press to unlock
}

function handleLockScreenTouchEnd(e) {
    if (unlockTimer) {
        clearTimeout(unlockTimer);
        unlockTimer = null;
    }
}


// ─── Daily Synthesis Summary ──────────────────────────
let synthesisDataCache = null;

async function loadDailySynthesis(force = false) {
    const loading = document.getElementById('synthesisLoading');
    const error = document.getElementById('synthesisError');
    const grid = document.getElementById('synthesisGrid');
    const dateBadge = document.getElementById('synthesisDateBadge');
    const cachedBadge = document.getElementById('synthesisCachedBadge');
    const notesCount = document.getElementById('synthesisNotesCount');
    
    // Show loading, hide others
    loading.style.display = 'flex';
    error.style.display = 'none';
    grid.style.display = 'none';
    cachedBadge.style.display = 'none';
    notesCount.textContent = '';
    dateBadge.textContent = '📅 載入中...';
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 75000); // 75s timeout
        const url = `${API}/api/rag/daily-synthesis${force ? '?force=true' : ''}`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!res.ok) {
            const errText = await res.text();
            let errorText = '合成分析 API 無法連線';
            try {
                const errJson = JSON.parse(errText);
                errorText = errJson.error || errJson.detail || errText;
            } catch (jsErr) {
                errorText = errText || errorText;
            }
            throw new Error(errorText);
        }
        
        const data = await res.json();
        synthesisDataCache = data;
        
        // Update stats
        if (data.stats) {
            const hedgedocCount = data.stats['hedgedoc_notes'] || 0;
            const obsidianCount = data.stats['obsidian_notes'] || 0;
            const total = hedgedocCount + obsidianCount;
            const latestDate = data.stats['latest_date'] || data['latest_date'] || '—';
            const latestFile = data.stats['latest_file'] || data['latest_file'] || '';
            
            const totalEl = document.getElementById('statTotalValue');
            const hedgedocEl = document.getElementById('statHedgedocValue');
            const obsidianEl = document.getElementById('statObsidianValue');
            const latestDateEl = document.getElementById('statLatestDateValue');
            const latestFileEl = document.getElementById('statLatestFileValue');
            
            if (totalEl) totalEl.textContent = total.toLocaleString();
            if (hedgedocEl) hedgedocEl.textContent = hedgedocCount.toLocaleString();
            if (obsidianEl) obsidianEl.textContent = obsidianCount.toLocaleString();
            if (latestDateEl) latestDateEl.textContent = latestDate;
            
            if (latestFileEl) {
                if (latestFile) {
                    latestFileEl.textContent = latestFile;
                    latestFileEl.title = latestFile;
                    latestFileEl.style.display = 'block';
                } else {
                    latestFileEl.textContent = '';
                    latestFileEl.style.display = 'none';
                }
            }
            
            [totalEl, hedgedocEl, obsidianEl, latestDateEl].forEach(el => {
                if (el) {
                    el.classList.remove('animate');
                    void el.offsetWidth;
                    el.classList.add('animate');
                }
            });
        }
        
        // Update date badge
        if (data.date) {
            dateBadge.textContent = `📅 ${data.date}`;
        }
        
        // Show cached badge
        if (data.cached) {
            cachedBadge.style.display = 'inline-flex';
        }
        
        // Show notes count
        if (data.notes_analyzed) {
            notesCount.textContent = `分析了 ${data.notes_analyzed} 篇筆記`;
        }
        
        // Check for errors
        if (data.error) {
            loading.style.display = 'none';
            error.style.display = 'flex';
            document.getElementById('synthesisErrorText').textContent = data.error;
            return;
        }
        
        if (!data.synthesis) {
            loading.style.display = 'none';
            error.style.display = 'flex';
            document.getElementById('synthesisErrorText').textContent = '未能生成合成分析結果';
            return;
        }
        
        // Check for raw_text fallback
        if (data.synthesis.raw_text) {
            loading.style.display = 'none';
            grid.style.display = 'none';
            error.style.display = 'flex';
            document.getElementById('synthesisErrorText').innerHTML = `
                <div style="font-size:13px; text-align:left; max-height:300px; overflow-y:auto; padding:12px; background:rgba(0,0,0,0.1); border-radius:8px; white-space:pre-wrap;">${escapeHtml(data.synthesis.raw_text)}</div>
            `;
            return;
        }
        
        // Render the four cards
        renderSynthesisCards(data.synthesis);
        
        loading.style.display = 'none';
        grid.style.display = 'grid';
        
    } catch (e) {
        console.error('Daily synthesis error:', e);
        loading.style.display = 'none';
        error.style.display = 'flex';
        const isTimeout = e.name === 'AbortError';
        document.getElementById('synthesisErrorText').textContent = isTimeout
            ? '分析逾時，請確認 RAG API 已啟動並重試'
            : e.message;
    }
}

// Helper to find note links from selected_notes
function findNoteLink(title, collection) {
    if (!synthesisDataCache || !synthesisDataCache.selected_notes) return null;
    
    const notes = synthesisDataCache.selected_notes;
    const cleanTitle = (title || '').trim().toLowerCase();
    
    // 1. Exact match on title and collection (if collection provided)
    let found = notes.find(n => {
        const tMatch = (n.title || '').trim().toLowerCase() === cleanTitle;
        const cMatch = collection ? ((n.collection || '').toLowerCase() === collection.toLowerCase()) : true;
        return tMatch && cMatch;
    });
    
    // 2. Fuzzy/partial match fallback
    if (!found) {
        found = notes.find(n => {
            const nTitle = (n.title || '').trim().toLowerCase();
            return nTitle.includes(cleanTitle) || cleanTitle.includes(nTitle);
        });
    }
    
    if (found) {
        const coll = found.collection || collection;
        if (coll && coll.includes('hedgedoc') && found.url) {
            return { type: 'hedgedoc', url: found.url };
        }
    }
    return null;
}

// Helper to generate the note tag HTML (either as link or span)
function generateNoteTagHtml(title, collection) {
    const isHedgedoc = (collection || '').toLowerCase().includes('hedgedoc') || 
                       (synthesisDataCache && synthesisDataCache.selected_notes && 
                        synthesisDataCache.selected_notes.some(n => (n.title || '').trim().toLowerCase() === (title || '').trim().toLowerCase() && (n.collection || '').includes('hedgedoc')));
    
    const noteClass = isHedgedoc ? 'hedgedoc' : 'obsidian';
    const icon = isHedgedoc ? '📝' : '📓';
    const link = findNoteLink(title, collection);
    
    if (link && link.url) {
        return `<a href="${link.url}" target="_blank" class="synthesis-note-tag ${noteClass}" title="${escapeHtml(title || '')}">${icon} ${escapeHtml(title || '')}</a>`;
    } else {
        return `<span class="synthesis-note-tag ${noteClass}" title="${escapeHtml(title || '')}">${icon} ${escapeHtml(title || '')}</span>`;
    }
}

function renderSynthesisCards(synthesis) {
    const grid = document.getElementById('synthesisGrid');
    let html = '';
    
    // ── 1. Connections ──
    const conn = synthesis.connections;
    if (conn) {
        const tagA = generateNoteTagHtml(conn.note_a_title, conn.note_a_collection);
        const tagB = generateNoteTagHtml(conn.note_b_title, conn.note_b_collection);
        html += `
            <div class="synthesis-card">
                <div class="synthesis-card-accent connections"></div>
                <div class="synthesis-card-inner">
                    <div class="synthesis-card-title">
                        <div class="synthesis-card-icon connections">🔗</div>
                        <div>
                            <h5>連結 Connections</h5>
                            <div class="synthesis-card-subtitle">兩份獨立筆記間的非顯而易見關聯</div>
                        </div>
                    </div>
                    <div class="synthesis-note-tags">
                        ${tagA}
                        <span style="color:var(--text-muted); font-size:12px;">↔</span>
                        ${tagB}
                    </div>
                    <div class="synthesis-insight">${escapeHtml(conn.insight || '')}</div>
                    ${conn.reasoning ? `<div class="synthesis-reasoning">${escapeHtml(conn.reasoning)}</div>` : ''}
                </div>
            </div>
        `;
    }
    
    // ── 2. Pattern ──
    const pat = synthesis.pattern;
    if (pat) {
        const noteTags = (pat.note_titles || []).map(t => {
            return generateNoteTagHtml(t, null);
        }).join('');
        html += `
            <div class="synthesis-card">
                <div class="synthesis-card-accent pattern"></div>
                <div class="synthesis-card-inner">
                    <div class="synthesis-card-title">
                        <div class="synthesis-card-icon pattern">🔄</div>
                        <div>
                            <h5>模式 Pattern</h5>
                            <div class="synthesis-card-subtitle">跨越三份以上筆記的共同主題</div>
                        </div>
                    </div>
                    <div style="font-size:15px; font-weight:700; color:var(--text-primary); margin-bottom:10px; display:flex; align-items:center; gap:6px;">
                        <span style="color:#3b82f6;">◆</span> ${escapeHtml(pat.theme || '未知主題')}
                    </div>
                    <div class="synthesis-note-tags">${noteTags}</div>
                    <div class="synthesis-insight">${escapeHtml(pat.summary || '')}</div>
                </div>
            </div>
        `;
    }
    
    // ── 3. Contradiction ──
    const contra = synthesis.contradiction;
    if (contra) {
        const tagA = generateNoteTagHtml(contra.note_a_title, contra.note_a_collection);
        const tagB = generateNoteTagHtml(contra.note_b_title, contra.note_b_collection);
        html += `
            <div class="synthesis-card">
                <div class="synthesis-card-accent contradiction"></div>
                <div class="synthesis-card-inner">
                    <div class="synthesis-card-title">
                        <div class="synthesis-card-icon contradiction">⚡</div>
                        <div>
                            <h5>矛盾 Contradiction</h5>
                            <div class="synthesis-card-subtitle">不同筆記中相互衝突的立場</div>
                        </div>
                    </div>
                    <div class="synthesis-vs">
                        <div style="flex:1;">
                            <div class="synthesis-note-tags" style="margin-bottom:6px;">
                                ${tagA}
                            </div>
                            <div class="synthesis-stance">${escapeHtml(contra.note_a_stance || '')}</div>
                        </div>
                        <div class="synthesis-vs-divider">VS</div>
                        <div style="flex:1;">
                            <div class="synthesis-note-tags" style="margin-bottom:6px;">
                                ${tagB}
                            </div>
                            <div class="synthesis-stance">${escapeHtml(contra.note_b_stance || '')}</div>
                        </div>
                    </div>
                    <div class="synthesis-insight" style="margin-top:10px;">${escapeHtml(contra.conflict || '')}</div>
                </div>
            </div>
        `;
    }
    
    // ── 4. Best Capture ──
    const best = synthesis.best_capture;
    if (best) {
        const tag = generateNoteTagHtml(best.note_title, best.note_collection);
        const directions = (best.development_directions || []).map(d => {
            const escapedD = escapeHtml(d);
            const jsEscapedD = d.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            return `<span class="synthesis-direction-tag" style="cursor: pointer;" onclick="useKeywordAsQuery('${jsEscapedD}')">→ ${escapedD}</span>`;
        }).join('');
        html += `
            <div class="synthesis-card">
                <div class="synthesis-card-accent best-capture"></div>
                <div class="synthesis-card-inner">
                    <div class="synthesis-card-title">
                        <div class="synthesis-card-icon best-capture">⭐</div>
                        <div>
                            <h5>最佳捕捉 Best Capture</h5>
                            <div class="synthesis-card-subtitle">最值得深入發展的筆記</div>
                        </div>
                    </div>
                    <div class="synthesis-note-tags">
                        ${tag}
                    </div>
                    <div class="synthesis-insight">${escapeHtml(best.reason || '')}</div>
                    ${directions ? `<div class="synthesis-directions">${directions}</div>` : ''}
                </div>
            </div>
        `;
    }
    
    grid.innerHTML = html;
}

function useKeywordAsQuery(keyword) {
    const queryInput = document.getElementById('ragQuery');
    if (keyword) {
        queryInput.value = keyword;
    }
    queryInput.focus();
    queryInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('已填入關鍵詞，按下查詢即可搜尋', 'info');
}


// ─── Local RAG Query ──────────────────────────────────
async function askRag() {
    const query = document.getElementById('ragQuery').value.trim();
    if (!query) {
        showToast('請輸入查詢問題', 'error');
        return;
    }

    const btn = document.getElementById('btnRagQuery');
    const btnText = document.getElementById('btnRagText');
    const resultCard = document.getElementById('ragResult');
    const answerDiv = document.getElementById('ragAnswer');
    const sourcesDiv = document.getElementById('ragSources');

    try {
        btn.disabled = true;
        btnText.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;border-top-color:white;"></span> 查詢中...';
        
        let statusDiv = document.getElementById('ragMetaStatus');
        if (!statusDiv) {
            statusDiv = document.createElement('div');
            statusDiv.id = 'ragMetaStatus';
            statusDiv.style = "font-size: 13px; color: var(--text-muted); margin-bottom: 12px; padding: 10px; background: rgba(0,0,0,0.1); border-radius: 6px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px;";
            answerDiv.parentNode.insertBefore(statusDiv, answerDiv);
        }
        
        resultCard.style.display = 'block';
        answerDiv.innerHTML = '';
        sourcesDiv.innerHTML = '';
        
        let startTime = Date.now();
        window.ragTimerInterval = setInterval(() => {
            let elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            let stage = '發送請求中...';
            if (elapsed > 0.5 && elapsed < 2.0) stage = '🔍 尋找關聯文獻...';
            else if (elapsed >= 2.0) stage = '🧠 等候 LLM 生成解答...';
            
            statusDiv.innerHTML = `
                <span><b>🔄 階段:</b> <span style="color:var(--accent-info)">${stage}</span></span>
                <span><b>⏳ 耗時:</b> ${elapsed}s</span>
            `;
        }, 100);

        // 讀取使用者勾選的搜尋範圍
        const collections = [];
        if (document.getElementById('ragCollHedgedoc')?.checked) collections.push('hedgedoc_notes');
        if (document.getElementById('ragCollObsidian')?.checked) collections.push('obsidian_notes');
        if (collections.length === 0) {
            showToast('請至少勾選一個搜尋範圍', 'error');
            btn.disabled = false;
            btnText.innerText = '🚀 查詢';
            return;
        }

        const res = await fetch(`${API}/api/rag/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, top_k: 10, collections })
        });

        if (!res.ok) {
            const errText = await res.text();
            let errorText = '查詢失敗';
            try {
                const errJson = JSON.parse(errText);
                errorText = errJson.detail || errJson.error || errText;
            } catch (e) {
                errorText = errText || '查詢失敗';
            }
            throw new Error(errorText);
        }

        const data = await res.json();
        
        if (window.ragTimerInterval) clearInterval(window.ragTimerInterval);
        const finalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const modelUsed = data.model_used || '未知';
        const threshold = data.score_threshold ? data.score_threshold.toFixed(3) : '0.250';
        const docCount = data.source_documents ? data.source_documents.length : 0;
        
        statusDiv.innerHTML = `
            <span><b>🧠 模型:</b> ${escapeHtml(modelUsed)}</span>
            <span><b>✅ 階段:</b> <span style="color:#10b981">處理完成</span></span>
            <span><b>📊 來源:</b> ${docCount} 筆 (門檻 ${threshold})</span>
            <span><b>⏳ 總耗時:</b> ${finalTime}s</span>
        `;
        
        // Show result
        window.lastRagData = { query, answer: data.answer, source_documents: data.source_documents };
        resultCard.style.display = 'block';
        answerDiv.innerHTML = renderMarkdown(data.answer);
        
        // Show sources with thumbs up/down and export buttons
        if (data.source_documents && data.source_documents.length > 0) {
            sourcesDiv.innerHTML = data.source_documents.map((doc, i) => {
                const text = typeof doc === 'object' && doc.text ? doc.text : doc;
                const title = typeof doc === 'object' && doc.title ? doc.title : '';
                const url = typeof doc === 'object' && doc.url ? doc.url : '';
                const coll = typeof doc === 'object' && doc.collection ? doc.collection : '';
                const sourcePath = typeof doc === 'object' && doc.source_path ? doc.source_path : '';
                const score = typeof doc === 'object' && doc.score ? doc.score : 0;
                
                const collColor = coll === 'hedgedoc_notes' ? '#10b981' : '#8b5cf6';
                const collIcon = coll === 'hedgedoc_notes' ? '📝' : '📓';
                const collBadge = coll ? `<span style="background:${collColor}22; color:${collColor}; padding:2px 8px; border-radius:12px; font-size:10px; border:1px solid ${collColor}44;">${collIcon} ${escapeHtml(coll)}</span>` : '';
                const titleHtml = title ? `<span style="font-weight:600; font-size:13px; color:var(--text-primary);">${escapeHtml(title)}</span>` : '';
                const scoreBadge = `<span style="font-size:10px; color:var(--text-muted); padding:2px 6px; border-radius:8px; background:rgba(0,0,0,0.06);">🎯 ${score.toFixed(4)}</span>`;
                
                // Link button: HedgeDoc sources get direct link, Obsidian sources get export button
                let actionBtns = '';
                if (url && url.startsWith('http')) {
                    actionBtns += `<a href="${escapeHtml(url)}" target="_blank" style="color:var(--accent-info); font-size:11px; text-decoration:none; padding:3px 8px; border:1px solid var(--accent-info); border-radius:6px; white-space:nowrap;">🔗 開啟</a>`;
                }
                if (coll === 'obsidian_notes') {
                    actionBtns += `<button onclick="ragExportObsidian(${i})" style="color:#10b981; font-size:11px; padding:3px 8px; border:1px solid #10b981; border-radius:6px; background:transparent; cursor:pointer; white-space:nowrap;">📤 轉入 HedgeDoc</button>`;
                }
                
                const pathHtml = sourcePath ? `<div style="font-size:11px; color:var(--text-muted); margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">📂 ${escapeHtml(sourcePath)}</div>` : '';

                return `
                <div style="background:var(--bg-card-hover); border:1px solid var(--border); border-radius:8px; padding:12px; margin-top:10px;" id="ragSource-${i}">
                    <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:4px;">
                        <span style="font-size:12px; font-weight:600; color:var(--accent-primary);">[來源 ${i+1}]</span>
                        ${collBadge} ${scoreBadge} ${titleHtml}
                        <div style="margin-left:auto; display:flex; gap:4px; align-items:center;">
                            ${actionBtns}
                        </div>
                    </div>
                    ${pathHtml}
                    <div style="font-size:14px; color:var(--text-primary); white-space:pre-wrap; line-height:1.6; margin-top:8px; padding:8px; background:rgba(0,0,0,0.05); border-radius:6px; border-left:3px solid ${collColor};">${escapeHtml(text)}</div>
                    <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
                        <button onclick="ragFeedback(${i}, ${score}, true)" id="ragThumbUp-${i}" style="font-size:16px; padding:2px 10px; border:1px solid var(--border); border-radius:6px; background:transparent; cursor:pointer;" title="這個來源有幫助">👍</button>
                        <button onclick="ragFeedback(${i}, ${score}, false)" id="ragThumbDown-${i}" style="font-size:16px; padding:2px 10px; border:1px solid var(--border); border-radius:6px; background:transparent; cursor:pointer;" title="這個來源不相關">👎</button>
                        <span id="ragFbLabel-${i}" style="font-size:11px; color:var(--text-muted);"></span>
                    </div>
                </div>
            `;
            }).join('');
        } else {
            sourcesDiv.innerHTML = '<p style="font-size:14px; color:var(--text-muted);">無參考資料</p>';
        }

        showToast('查詢完成', 'success');
        resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    } catch (e) {
        if (window.ragTimerInterval) clearInterval(window.ragTimerInterval);
        console.error('RAG query error:', e);
        showToast(`查詢失敗: ${e.message}`, 'error');
    } finally {
        btn.disabled = false;
        btnText.innerText = '🚀 查詢';
    }
}

// ─── RAG Feedback (thumbs up/down) ───────────────────────────
async function ragFeedback(index, score, isRelevant) {
    const upBtn = document.getElementById(`ragThumbUp-${index}`);
    const downBtn = document.getElementById(`ragThumbDown-${index}`);
    const label = document.getElementById(`ragFbLabel-${index}`);
    
    upBtn.disabled = true;
    downBtn.disabled = true;
    
    if (isRelevant) {
        upBtn.style.background = '#10b98133';
        upBtn.style.borderColor = '#10b981';
    } else {
        downBtn.style.background = '#ef444433';
        downBtn.style.borderColor = '#ef4444';
    }
    
    try {
        const res = await fetch(`${API}/api/rag/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_index: index, score, is_relevant: isRelevant })
        });
        const data = await res.json();
        label.innerText = `✓ 已記錄 (新門檻: ${data.new_threshold?.toFixed(3) || '—'})`;
    } catch (e) {
        label.innerText = '記錄失敗';
    }
}

// ─── RAG: Export Obsidian source to HedgeDoc ─────────────────
async function ragExportObsidian(index) {
    if (!window.lastRagData || !window.lastRagData.source_documents) return;
    const doc = window.lastRagData.source_documents[index];
    if (!doc) return;
    
    try {
        showToast('正在轉入 HedgeDoc...', 'info');
        const res = await fetch(`${API}/api/rag/export-to-hedgedoc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: doc.title || '未命名 Obsidian 筆記',
                text: doc.full_text || doc.text || '',
                source_path: doc.source_path || ''
            })
        });
        const data = await res.json();
        if (data.success && data.noteUrl) {
            showToast('✅ 已轉入 HedgeDoc！', 'success');
            window.open(data.noteUrl, '_blank');
        } else {
            throw new Error(data.error || '轉入失敗');
        }
    } catch (e) {
        showToast(`轉入失敗: ${e.message}`, 'error');
    }
}

// ─── Export RAG to HedgeDoc ──────────────────────────────────────────
async function exportRagToHedgedoc() {
    if (!window.lastRagData) return;
    
    const btn = document.getElementById('btnRagToHedgedoc');
    const oldText = btn.innerHTML;
    
    try {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px;border-top-color:white;margin-right:6px;"></span> 處理中...';
        
        const { query, answer, source_documents } = window.lastRagData;
        
        let mdContent = `###### tags: \`AI查詢\` \`RAG筆記\`\n# 🔍 查詢：${query}\n\n## 🤖 AI 解答\n${answer}\n\n---\n## 📚 參考資料\n`;
        
        if (source_documents && source_documents.length > 0) {
            source_documents.forEach((doc, i) => {
                const text = typeof doc === 'object' && doc.text ? doc.text : doc;
                const title = typeof doc === 'object' && doc.title ? doc.title : `來源 ${i+1}`;
                const url = typeof doc === 'object' && doc.url ? doc.url : '';
                const coll = typeof doc === 'object' && doc.collection ? `[${doc.collection}]` : '';
                
                mdContent += `### ${i+1}. ${title} ${coll}\n`;
                if (url && url.startsWith('http')) {
                    mdContent += `- **來源連結：** [開啟原文](${url})\n`;
                }
                // Quote formatting for readability
                mdContent += `\n> ${text.split('\\n').join('\\n> ')}\n\n`;
            });
        } else {
            mdContent += `無參考資料\n`;
        }
        
        const saveRes = await fetch(`${API}/api/hedgedoc/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: mdContent,
                title: `RAG 查詢分享 - ${query.substring(0, 30)}`,
            })
        });
        
        const saveData = await saveRes.json();
        if (!saveData.success) throw new Error(saveData.error || '儲存失敗');
        
        showToast('✅ 成功轉存至 HedgeDoc！', 'success');
        if (saveData.note && saveData.note.url) {
            // Automatically open the new HedgeDoc note in a fresh tab
            window.open(saveData.note.url, '_blank');
        }
        
    } catch (e) {
        console.error('Export RAG error:', e);
        showToast(`轉存失敗: ${e.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = oldText;
    }
}


// ─── Generate Social Post with APA Citations ─────────────────
async function generateSocialPost() {
    if (!window.lastRagData) {
        showToast('請先執行查詢', 'error');
        return;
    }
    
    const btn = document.getElementById('btnRagSocialPost');
    const oldText = btn.innerHTML;
    const resultDiv = document.getElementById('ragSocialResult');
    const contentDiv = document.getElementById('ragSocialContent');
    
    try {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:2px;border-top-color:white;margin-right:6px;"></span> 生成中...';
        
        resultDiv.style.display = 'block';
        contentDiv.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:20px;">✍️ Gemini 正在將回答重整為社群文章並加註 APA 引用格式...</p>';
        
        const res = await fetch(`${API}/api/rag/social-post`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: window.lastRagData.query,
                answer: window.lastRagData.answer,
                source_documents: window.lastRagData.source_documents
            })
        });
        
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || '生成失敗');
        
        window.lastSocialPost = data.content;
        contentDiv.innerHTML = renderMarkdown(data.content);
        showToast('✅ 社群文章生成完成！', 'success');
        resultDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        
    } catch (e) {
        console.error('Social post error:', e);
        contentDiv.innerHTML = `<p style="color:#ef4444; padding:12px;">❌ ${escapeHtml(e.message)}</p>`;
        showToast(`生成失敗: ${e.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = oldText;
    }
}

// ─── Copy Social Post to Clipboard ───────────────────────────
function copySocialPost() {
    if (!window.lastSocialPost) return;
    navigator.clipboard.writeText(window.lastSocialPost).then(() => {
        showToast('📋 已複製到剪貼簿！', 'success');
    }).catch(() => {
        showToast('複製失敗', 'error');
    });
}

// ─── Export Social Post to HedgeDoc ──────────────────────────
async function exportSocialToHedgedoc() {
    if (!window.lastSocialPost) return;
    
    try {
        const query = window.lastRagData?.query || '社群文章';
        const mdContent = `###### tags: \`社群文章\` \`APA引用\` \`RAG生成\`\n\n${window.lastSocialPost}`;
        
        const saveRes = await fetch(`${API}/api/hedgedoc/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: mdContent,
                title: `社群文章 - ${query.substring(0, 30)}`
            })
        });
        
        const saveData = await saveRes.json();
        if (!saveData.success) throw new Error(saveData.error || '儲存失敗');
        
        showToast('✅ 社群文章已存至 HedgeDoc！', 'success');
        if (saveData.note && saveData.note.url) {
            window.open(saveData.note.url, '_blank');
        }
    } catch (e) {
        showToast(`轉存失敗: ${e.message}`, 'error');
    }
}

// ─── File Management ────────────────────────────────────
async function uploadFile() {
    const fileInput = document.getElementById('fileInput');
    const file = fileInput.files[0];
    if (!file) {
        showToast('請先選擇一個檔案', 'error');
        return;
    }
    
    const formData = new FormData();
    formData.append('file', file);
    
    const btn = document.getElementById('btnUploadFile');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<span class="spinner" style="display:inline-block; width:14px; height:14px; border:2px solid #fff; border-top-color:transparent; border-radius:50%; animation:spin 1s linear infinite; margin-right:8px;"></span>上傳中...`;
    btn.disabled = true;
    
    try {
        const res = await fetch(`${API}/api/files/upload`, {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        
        if (data.success) {
            showToast('檔案上傳成功', 'success');
            fileInput.value = ''; // clear input
            loadFilesList();
        } else {
            throw new Error(data.error || '上傳失敗');
        }
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function loadFilesList() {
    const listEl = document.getElementById('filesList');
    if (!listEl) return;
    try {
        const res = await fetch(`${API}/api/files/list`);
        const data = await res.json();
        
        if (!data.success) throw new Error(data.error || '無法載入檔案列表');
        
        if (data.files.length === 0) {
            listEl.innerHTML = `<div class="empty-state" style="padding:20px"><div class="icon">📭</div><p>暫無檔案，在上方上傳第一個檔案吧！</p></div>`;
            return;
        }
        
        listEl.innerHTML = data.files.map(f => `
            <div class="podcast-item" style="display:flex; justify-content:space-between; align-items:center; padding: 12px; border-bottom: 1px solid var(--border);">
              <div style="flex:1; overflow:hidden;">
                <h4 style="margin:0 0 4px 0; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${f.filename}">${f.filename}</h4>
                <div style="font-size:12px; color:var(--text-muted); display:flex; gap:10px;">
                  <span>📅 ${(new Date(f.createdAt)).toLocaleDateString('zh-TW')}</span>
                  <span>📦 ${(f.size / 1024 / 1024).toFixed(2)} MB</span>
                </div>
              </div>
              <div style="display:flex; gap:8px;">
                <a href="${API}${f.url}" download class="btn btn-secondary btn-sm" title="下載檔案">⬇️</a>
                <button class="btn btn-danger btn-sm" onclick="deleteFile('${f.filename}')" title="刪除檔案">🗑️</button>
              </div>
            </div>
        `).join('');
    } catch (e) {
        listEl.innerHTML = `<div style="padding:20px; color:var(--danger); text-align:center;">載入失敗: ${e.message}</div>`;
    }
}

async function deleteFile(filename) {
    if (!confirm(`確定要刪除「${filename}」嗎？此操作無法還原。`)) return;
    
    try {
        const res = await fetch(`${API}/api/files/${encodeURIComponent(filename)}`, {
             method: 'DELETE'
        });
        const data = await res.json();
        
        if (data.success) {
            showToast('檔案已刪除', 'success');
            loadFilesList();
        } else {
            throw new Error(data.error || '刪除失敗');
        }
    } catch (e) {
        showToast(e.message, 'error');
    }
}

// ─── System Status ────────────────────────────────────
async function loadSystemStatus() {
    try {
        const res = await fetch(`${API}/api/system/status`);
        if (!res.ok) throw new Error(`HTTP 錯誤狀態碼: ${res.status}`);
        
        const contentType = res.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            throw new Error("伺服器未回傳 JSON 格式（可能需要重新啟動 Node.js 伺服器進程）");
        }
        
        const data = await res.json();
        if (!data.success) throw new Error(data.error || '無法取得系統狀態');

        // Render CPU overall
        const cpu = data.cpu || {};
        document.getElementById('cpuOverallLoad').textContent = `${cpu.overallLoad || 0}%`;
        document.getElementById('cpuOverallBar').style.width = `${cpu.overallLoad || 0}%`;
        document.getElementById('cpuOverallTemp').textContent = cpu.overallTemp ? `${cpu.overallTemp}°C` : 'N/A';

        // Render Memory overall
        const mem = data.memory || {};
        document.getElementById('memUsePercent').textContent = `${mem.usePercent || 0}%`;
        document.getElementById('memUseBar').style.width = `${mem.usePercent || 0}%`;
        document.getElementById('memDetails').textContent = `${mem.used || '0 GB'} / ${mem.total || '0 GB'} (剩餘 ${mem.free || '0 GB'})`;

        // Render Disk overall
        const disk = data.disk || {};
        document.getElementById('diskUsePercent').textContent = disk.usePercent || '0%';
        document.getElementById('diskUseBar').style.width = disk.usePercent || '0%';
        document.getElementById('diskDetails').textContent = `${disk.used || '0 GB'} / ${disk.size || '0 GB'} (剩餘 ${disk.avail || '0 GB'})`;

        // Render Power Draw
        let powerVal = null;
        let isEstimated = false;
        if (data.power !== null && data.power !== undefined) {
            if (typeof data.power === 'object') {
                powerVal = data.power.value;
                isEstimated = !!data.power.isEstimated;
            } else {
                powerVal = data.power;
                isEstimated = false;
            }
        }
        const isEstLabel = isEstimated ? ' (估算)' : '';
        document.getElementById('systemPowerDraw').textContent = (powerVal !== null && powerVal !== undefined) ? `${powerVal} W${isEstLabel}` : 'N/A';

        // Render Core Grid details
        const coreGrid = document.getElementById('cpuCoreGrid');
        if (cpu.coreLoads && cpu.coreLoads.length > 0) {
            let coreHtml = '';
            for (let i = 0; i < cpu.coreLoads.length; i++) {
                const load = cpu.coreLoads[i];
                const temp = cpu.coreTemps && cpu.coreTemps[i] !== undefined ? `${cpu.coreTemps[i]}°C` : 'N/A';
                
                // Color formatting based on load
                let loadColor = 'var(--success)';
                if (load > 70) loadColor = 'var(--danger)';
                else if (load > 40) loadColor = 'var(--warning)';

                // Color formatting based on temp
                let tempColor = 'var(--text-secondary)';
                if (cpu.coreTemps && cpu.coreTemps[i] > 80) tempColor = 'var(--danger)';
                else if (cpu.coreTemps && cpu.coreTemps[i] > 65) tempColor = 'var(--warning)';

                coreHtml += `
                    <div class="core-item">
                        <div class="core-header">
                            <span class="core-name">核心 ${i + 1}</span>
                            <span class="core-temp" style="color: ${tempColor}; font-weight: 600;">${temp}</span>
                        </div>
                        <div class="progress-bar-container" style="height: 6px; margin: 8px 0 4px 0;">
                            <div class="progress-bar-fill" style="width: ${load}%; background: ${loadColor};"></div>
                        </div>
                        <div class="core-footer" style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted);">
                            <span>負載</span>
                            <span>${load}%</span>
                        </div>
                    </div>
                `;
            }
            coreGrid.innerHTML = coreHtml;
        } else {
            coreGrid.innerHTML = `
                <div class="empty-state" style="padding: 20px; grid-column: 1 / -1;">
                    <p>尚無 CPU 核心監控數據</p>
                </div>
            `;
        }

        // Render History Chart
        if (data.history && data.history.length > 0) {
            renderHistoryChart(data.history);
        }
    } catch (e) {
        console.error('Fetch system status error:', e);
        showToast(`讀取狀態失敗: ${e.message}`, 'error');
        
        // Reset meters to N/A
        document.getElementById('cpuOverallLoad').textContent = 'N/A';
        document.getElementById('cpuOverallBar').style.width = '0%';
        document.getElementById('cpuOverallTemp').textContent = 'N/A';
        
        document.getElementById('memUsePercent').textContent = 'N/A';
        document.getElementById('memUseBar').style.width = '0%';
        document.getElementById('memDetails').textContent = '連線失敗或需要重啟伺服器';
        
        document.getElementById('diskUsePercent').textContent = 'N/A';
        document.getElementById('diskUseBar').style.width = '0%';
        document.getElementById('diskDetails').textContent = '連線失敗或需要重啟伺服器';
        
        document.getElementById('systemPowerDraw').textContent = 'N/A';
        
        document.getElementById('cpuCoreGrid').innerHTML = `
            <div class="empty-state" style="padding: 20px; grid-column: 1 / -1; color: var(--danger);">
                <p>讀取失敗: ${e.message}</p>
                <p style="font-size: 12px; margin-top: 8px; color: var(--text-secondary);">請檢查終端機並重新啟動 node server.js 進程。</p>
            </div>
        `;
    }
}

// ─── Render History Chart (Chart.js) ───────────────────
function renderHistoryChart(history) {
    const canvas = document.getElementById('systemHistoryChart');
    if (!canvas) return;

    if (typeof Chart === 'undefined') {
        console.warn('Chart.js is not loaded yet.');
        return;
    }

    const ctx = canvas.getContext('2d');
    const labels = history.map(h => h.time);
    const cpuData = history.map(h => h.cpuOverall);
    const tempData = history.map(h => h.cpuTemp !== null ? h.cpuTemp : 0);
    const powerData = history.map(h => {
        if (h.power === null || h.power === undefined) return 0;
        if (typeof h.power === 'object') return h.power.value !== null ? h.power.value : 0;
        const val = parseFloat(h.power);
        return isNaN(val) ? 0 : val;
    });
    const memData = history.map(h => h.memUsePercent);

    if (systemChart) {
        systemChart.data.labels = labels;
        systemChart.data.datasets[0].data = cpuData;
        systemChart.data.datasets[1].data = tempData;
        systemChart.data.datasets[2].data = powerData;
        systemChart.data.datasets[3].data = memData;
        systemChart.update('none');
    } else {
        systemChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'CPU 負載 (%)',
                        data: cpuData,
                        borderColor: '#6366f1',
                        backgroundColor: 'rgba(99, 102, 241, 0.05)',
                        tension: 0.2,
                        borderWidth: 2,
                        pointRadius: 1,
                        fill: true
                    },
                    {
                        label: 'CPU 溫度 (°C)',
                        data: tempData,
                        borderColor: '#ef4444',
                        backgroundColor: 'transparent',
                        tension: 0.2,
                        borderWidth: 2,
                        pointRadius: 1
                    },
                    {
                        label: '功耗 (W)',
                        data: powerData,
                        borderColor: '#f59e0b',
                        backgroundColor: 'rgba(245, 158, 11, 0.05)',
                        tension: 0.2,
                        borderWidth: 2,
                        pointRadius: 1,
                        fill: true
                    },
                    {
                        label: '記憶體使用率 (%)',
                        data: memData,
                        borderColor: '#3b82f6',
                        backgroundColor: 'transparent',
                        tension: 0.2,
                        borderWidth: 2,
                        pointRadius: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        min: 0,
                        grid: {
                            color: 'rgba(255, 255, 255, 0.04)'
                        },
                        ticks: {
                            color: '#8b92a8',
                            font: {
                                family: 'Inter, sans-serif',
                                size: 11
                            }
                        }
                    },
                    x: {
                        grid: {
                            display: false
                        },
                        ticks: {
                            color: '#8b92a8',
                            font: {
                                family: 'Inter, sans-serif',
                                size: 10
                            },
                            maxTicksLimit: 8
                        }
                    }
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: {
                            color: '#e8eaf0',
                            font: {
                                family: 'Inter, sans-serif',
                                size: 12
                            },
                            boxWidth: 12,
                            padding: 15
                        }
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                }
            }
        });
    }
}
