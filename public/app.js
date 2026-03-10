/* ────────────────────────────────────────────────────
   X Post Processor — Frontend Application
   ──────────────────────────────────────────────────── */

const API = '';

// ─── State ────────────────────────────────────────────
let currentTweet = null;
let currentVideoPath = null;
let currentDirectVideoPath = null;
let currentScript = null;
let selectedNoteIds = new Set();
let currentPodcastId = null;

// ─── Init ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    loadNotesList();
    loadPodcastList();

    // Restore podcast playback progress
    const podcastAudio = document.getElementById('podcastAudio');
    podcastAudio.addEventListener('timeupdate', onPodcastTimeUpdate);
    podcastAudio.addEventListener('ended', onPodcastEnded);
    podcastAudio.addEventListener('loadedmetadata', onPodcastLoaded);
});

// ─── Navigation ───────────────────────────────────────
function switchPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    document.getElementById(`page-${page}`).classList.add('active');
    document.querySelector(`[data-page="${page}"]`).classList.add('active');

    // Refresh data when switching pages
    if (page === 'notes') loadNotesList();
    if (page === 'podcast') {
        loadPodcastNoteSelect();
        loadPodcastList();
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
        document.getElementById('settingGeminiModel').value = settings.geminiModel || 'gemma-3-27b-it';
        document.getElementById('settingHedgedocUrl').value = settings.hedgedocUrl || '';
        document.getElementById('settingHedgedocCookie').value = settings.hedgedocCookie || '';
        document.getElementById('settingWhisperUrl').value = settings.whisperUrl || 'http://localhost:8080';
        document.getElementById('settingKokoroUrl').value = settings.kokoroUrl || 'http://localhost:8880';
        document.getElementById('settingXCookie').value = settings.xCookie || '';
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
            xCookie: document.getElementById('settingXCookie').value.trim()
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

// ─── Task Queue ───────────────────────────────────────
const TaskQueue = {
    queue: [],
    isProcessing: false,
    taskIdCounter: 0,

    addProcessTask(url) {
        if (!url) return;
        const task = {
            id: ++this.taskIdCounter,
            type: 'process',
            name: `處理貼文...`,
            status: 'pending',
            progress: '排隊中...',
            data: { url }
        };
        this.queue.push(task);
        this.render();
        this.processNext();
        showToast('已加入處理佇列', 'success');
    },

    addPodcastTask(noteIdsArray, notesData, title) {
        const task = {
            id: ++this.taskIdCounter,
            type: 'podcast',
            name: `Podcast: ${title.substring(0, 20)}...`,
            status: 'pending',
            progress: '排隊中...',
            data: { noteIds: noteIdsArray, notesData, title }
        };
        this.queue.push(task);
        this.render();
        this.processNext();
        showToast('已加入 Podcast 佇列', 'success');
    },

    addDownloadTask(url) {
        if (!url) return;
        const task = {
            id: ++this.taskIdCounter,
            type: 'download',
            name: `下載: ${url.substring(0, 30)}...`,
            status: 'pending',
            progress: '排隊中...',
            data: { url }
        };
        this.queue.push(task);
        this.render();
        this.processNext();
        showToast('已加入下載佇列', 'success');
    },

    addDirectDownloadTask(url) {
        if (!url) {
            showToast('請輸入連結', 'error');
            return;
        }
        const task = {
            id: ++this.taskIdCounter,
            type: 'direct-download',
            name: `直接下載: ${url.substring(0, 30)}...`,
            status: 'pending',
            progress: '排隊中...',
            data: { url }
        };
        this.queue.push(task);
        this.render();
        this.processNext();
        showToast('已加入下載佇列', 'success');
    },

    updateTask(id, progress) {
        const task = this.queue.find(t => t.id === id);
        if (task) {
            task.progress = progress;
            this.render();
        }
    },

    clearDone() {
        this.queue = this.queue.filter(t => t.status === 'pending' || t.status === 'processing');
        this.render();
    },

    async processNext() {
        if (this.isProcessing) return;
        const taskIndex = this.queue.findIndex(t => t.status === 'pending');
        if (taskIndex === -1) return;

        this.isProcessing = true;
        const task = this.queue[taskIndex];
        task.status = 'processing';
        this.render();

        try {
            if (task.type === 'process') {
                await processPostWorker(task);
            } else if (task.type === 'podcast') {
                await processPodcastWorker(task);
            } else if (task.type === 'download') {
                await downloadVideoWorker(task);
            } else if (task.type === 'direct-download') {
                await directDownloadWorker(task);
            }
            task.status = 'done';
            task.progress = '處理完成';
            showToast(`[${task.name}] 處理完成`, 'success');
        } catch (err) {
            task.status = 'error';
            task.progress = `錯誤: ${err.message}`;
            showToast(`[${task.name}]發生錯誤: ${err.message}`, 'error');
        }

        this.isProcessing = false;
        this.render();
        this.processNext();
    },

    render() {
        const container = document.getElementById('globalQueue');
        const list = document.getElementById('queueList');
        if (!container || !list) return;

        if (this.queue.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        list.innerHTML = this.queue.map(t => {
            let icon = '⏳';
            if (t.status === 'processing') icon = '<span class="spinner" style="width:14px;height:14px;border-width:2px;border-top-color:var(--accent-primary);"></span>';
            if (t.status === 'done') icon = '✅';
            if (t.status === 'error') icon = '❌';

            let opacity = t.status === 'done' || t.status === 'error' ? '0.7' : '1';

            return `
            <div style="background:var(--bg-input); border:1px solid var(--border); border-radius:8px; padding:10px; margin-bottom:8px; opacity:${opacity};">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <div style="font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:200px;" title="${t.name}">${t.name}</div>
                    <div style="font-size:14px; flex-shrink:0;">${icon}</div>
                </div>
                <div style="font-size:11px; color:var(--text-muted);">${t.progress}</div>
            </div>`;
        }).join('');
    }
};

// ─── Process X Post ───────────────────────────────────
function enqueueProcessPost() {
    const url = document.getElementById('postUrl').value.trim();
    if (!url) {
        showToast('請輸入 X 貼文連結', 'error');
        return;
    }
    if (!url.match(/https?:\/\/(x\.com|twitter\.com)\/\w+\/status\/\d+/i)) {
        showToast('請輸入有效的 X 貼文連結', 'error');
        return;
    }

    TaskQueue.addProcessTask(url);
    document.getElementById('postUrl').value = '';
}

async function processPostWorker(task) {
    const url = task.data.url;

    try {
        // Step 1: Parse tweet
        setStep('parse');
        TaskQueue.updateTask(task.id, '解析貼文中...');

        const parseRes = await fetch(`${API}/api/x/parse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const parseData = await parseRes.json();

        if (!parseData.success) throw new Error(parseData.error);

        currentTweet = parseData.tweet;
        showTweetPreview(currentTweet);

        // Step 2: Handle media (video)
        setStep('media');
        let contentForNote = currentTweet.text;

        // Append fetched URL content (article, linked page, etc.)
        if (currentTweet.fetchedContent) {
            contentForNote += `\n\n連結頁面內容：\n${currentTweet.fetchedContent}`;
        }

        if (currentTweet.hasVideo) {
            // Show video section
            document.getElementById('videoSection').style.display = 'block';

            // Download video
            TaskQueue.updateTask(task.id, '下載影片中...');
            const dlRes = await fetch(`${API}/api/x/download-video`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url })
            });
            const dlData = await dlRes.json();

            if (dlData.success) {
                currentVideoPath = dlData.path;
                showVideoPlayer(dlData.path);

                // Transcribe
                TaskQueue.updateTask(task.id, '語音轉逐字稿中...');
                const trRes = await fetch(`${API}/api/whisper/transcribe`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ videoPath: dlData.filename })
                });
                const trData = await trRes.json();

                if (trData.success && trData.text) {
                    contentForNote = `貼文內容：\n${currentTweet.text}\n\n影片逐字稿：\n${trData.text}`;
                }
            }
        } else {
            document.getElementById('videoSection').style.display = 'none';
        }

        // Step 3: Generate note via Gemini
        setStep('note');

        // Check content quality - strip URLs and whitespace to measure real text
        const textOnly = contentForNote.replace(/https?:\/\/\S+/g, '').replace(/[@#]\w+/g, '').trim();
        if (textOnly.length < 20) {
            showToast('⚠️ 貼文內容較少，筆記品質可能受限', 'info');
        }

        TaskQueue.updateTask(task.id, '生成中文筆記中...');

        const noteRes = await fetch(`${API}/api/gemini/summarize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: contentForNote })
        });
        const noteData = await noteRes.json();

        if (!noteData.success) throw new Error(noteData.error);

        // Step 4: Save to HedgeDoc
        setStep('save');
        TaskQueue.updateTask(task.id, '儲存至 HedgeDoc...');

        const noteTitle = currentTweet.articleTitle
            || `X 貼文筆記 - @${currentTweet.author || 'unknown'} - ${new Date().toLocaleDateString('zh-TW')}`;

        const saveRes = await fetch(`${API}/api/hedgedoc/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: noteData.text,
                title: noteTitle,
                sourceUrl: url
            })
        });
        const saveData = await saveRes.json();

        // Show result
        showNoteResult(noteData.text, saveData.success ? saveData.note : null);
    } catch (e) {
        console.error(e);
        throw e;
    }
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
    const url = task.data.url;
    TaskQueue.updateTask(task.id, '下載影片中...');

    try {
        const res = await fetch(`${API}/api/x/download-video`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();

        if (data.success) {
            currentVideoPath = data.path;
            showVideoPlayer(data.path);
        } else {
            throw new Error(data.error);
        }
    } catch (e) {
        console.error(e);
        throw e;
    }
}

// ─── Direct Download ──────────────────────────────────
function enqueueDirectDownload() {
    const url = document.getElementById('downloadUrl').value.trim();
    if (!url) {
        showToast('請輸入連結', 'error');
        return;
    }
    TaskQueue.addDirectDownloadTask(url);
    document.getElementById('downloadUrl').value = '';
}

async function directDownloadWorker(task) {
    const url = task.data.url;
    TaskQueue.updateTask(task.id, '下載影片中...');

    try {
        const res = await fetch(`${API}/api/x/download-video`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();

        if (data.success) {
            currentDirectVideoPath = data.path;
            document.getElementById('btnPlayDirect').style.display = 'flex';

            const player = document.getElementById('directVideoPlayer');
            player.src = data.path;
            document.getElementById('directVideoContainer').style.display = 'block';
        } else {
            throw new Error(data.error);
        }
    } catch (e) {
        console.error(e);
        throw e;
    }
}

function playDirectVideo() {
    const player = document.getElementById('directVideoPlayer');
    document.getElementById('directVideoContainer').style.display = 'block';
    player.play();
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
        const res = await fetch(`${API}/api/hedgedoc/list`);
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
        const res = await fetch(`${API}/api/hedgedoc/list`);
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

    TaskQueue.addPodcastTask(noteIdsArray, null, title);

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

    const tupleRegex = /\(\s*["'](host_[fm])["']\s*,\s*["']((?:[^"'\\]|\\.)*)["']\s*\)/g;
    let match;
    const lines = [];

    while ((match = tupleRegex.exec(script)) !== null) {
        const speaker = match[1];
        const text = match[2].replace(/\\"/g, '"').replace(/\\'/g, "'");
        const displayName = speaker === 'host_f' ? '曉曉' : '雲健';
        const cssClass = speaker === 'host_f' ? 'speaker-a' : 'speaker-b';
        lines.push(`<div><span class="${cssClass}">${displayName}：</span>${escapeHtml(text)}</div>`);
    }

    if (lines.length === 0) {
        preview.innerHTML = `<div>${escapeHtml(script)}</div>`;
    } else {
        preview.innerHTML = lines.join('');
    }
}

async function processPodcastWorker(task) {
    const { noteIds, title } = task.data;

    TaskQueue.updateTask(task.id, '讀取 Hedgehog 筆記中...');

    const notesRes = await fetch(`${API}/api/hedgedoc/list`);
    const notesData = await notesRes.json();
    const selectedNotes = notesData.notes.filter(n => noteIds.includes(n.id));

    let combinedContent = '';
    let combinedTitle = '';

    for (const note of selectedNotes) {
        combinedTitle += (combinedTitle ? ' & ' : '') + note.title;
        try {
            const settingsRes = await fetch(`${API}/api/settings`);
            const settings = await settingsRes.json();
            const noteId = note.url.split('/').pop();
            const contentRes = await fetch(`${settings.hedgedocUrl}/${noteId}/download`, {
                headers: { 'Cookie': settings.hedgedocCookie || '' }
            });
            if (contentRes.ok) {
                const content = await contentRes.text();
                combinedContent += `\n\n--- ${note.title} ---\n${content}`;
            } else {
                combinedContent += `\n\n--- ${note.title} ---\n（標題：${note.title}）`;
            }
        } catch {
            combinedContent += `\n\n--- ${note.title} ---\n（標題：${note.title}）`;
        }
    }

    TaskQueue.updateTask(task.id, '📍 正在用 Gemini 生成 Podcast 講稿...');
    const scriptRes = await fetch(`${API}/api/podcast/generate-script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            noteContents: combinedContent,
            noteTitle: combinedTitle || title
        })
    });
    const scriptData = await scriptRes.json();

    if (!scriptData.success) {
        throw new Error(scriptData.error || '講稿生成失敗');
    }

    const script = scriptData.script;
    currentScript = script; // Keep this mainly for UI display if needed
    showScriptPreview(script);

    TaskQueue.updateTask(task.id, '📍 正在發送講稿到 Kokoro 生成語音...');
    const audioRes = await fetch(`${API}/api/podcast/generate-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            script: script,
            title: `🎙️ ${combinedTitle || title}`
        })
    });

    const data = await audioRes.json();
    if (!data.success) throw new Error(data.error);

    const taskId = data.taskId;
    if (!taskId) throw new Error('未取得 task_id');

    TaskQueue.updateTask(task.id, `Kokoro 語音生成中... (Task: ${taskId.substring(0, 8)}...)`);
    const podcast = await pollTaskStatus(taskId, data.podcast, task.id);

    if (podcast && podcast.audioPath) {
        playPodcast(podcast);
        loadPodcastList();
    } else {
        throw new Error('語音生成完成但無法取得音檔');
    }
}

// ─── Podcast: Poll Task Status ────────────────────────
async function pollTaskStatus(taskId, podcastEntry, queueTaskId) {
    const maxWait = 600; // 10 minutes max
    const interval = 5; // Check every 5 seconds
    let elapsed = 0;

    while (elapsed < maxWait) {
        await new Promise(resolve => setTimeout(resolve, interval * 1000));
        elapsed += interval;

        try {
            const res = await fetch(`${API}/api/podcast/task-status/${taskId}`);
            const data = await res.json();

            if (data.status === 'completed') {
                const listRes = await fetch(`${API}/api/podcast/list`);
                const listData = await listRes.json();
                const updated = listData.podcasts.find(p => p.taskId === taskId);
                return updated || { ...podcastEntry, audioPath: data.audio_url, status: 'completed' };
            } else if (data.status === 'failed' || data.status === 'error') {
                throw new Error(data.error || '語音生成任務失敗');
            } else {
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;

                const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
                if (queueTaskId) {
                    TaskQueue.updateTask(queueTaskId, `Kokoro 語音生成中... ${timeStr}\\n狀態: ${data.status || 'processing'}`);
                }
            }
        } catch (e) {
            if (e.message.includes('失敗')) throw e;
            console.log('Status check error:', e.message);
        }
    }

    throw new Error('語音生成超時（超過 10 分鐘）');
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

    const playerCard = document.getElementById('podcastPlayerCard');
    const audio = document.getElementById('podcastAudio');

    playerCard.style.display = 'block';
    document.getElementById('currentPodcastTitle').textContent = podcast.title;
    document.getElementById('podcastAudioTitle').textContent = podcast.title;

    audio.src = podcast.audioPath;

    // Restore progress
    if (podcast.progress && podcast.progress > 0) {
        audio.currentTime = podcast.progress;
    }

    audio.play().catch(() => { });
    document.getElementById('podcastPlayBtn').textContent = '⏸';
}

function togglePodcastPlay() {
    const audio = document.getElementById('podcastAudio');
    const btn = document.getElementById('podcastPlayBtn');

    if (audio.paused) {
        audio.play();
        btn.textContent = '⏸';
    } else {
        audio.pause();
        btn.textContent = '▶';
    }
}

function onPodcastTimeUpdate() {
    const audio = document.getElementById('podcastAudio');
    if (!audio.duration) return;

    const pct = (audio.currentTime / audio.duration) * 100;
    document.getElementById('podcastProgressBar').style.width = `${pct}%`;
    document.getElementById('podcastCurrentTime').textContent = formatTime(audio.currentTime);
    document.getElementById('podcastDuration').textContent = formatTime(audio.duration);

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
    if (currentPodcastId) {
        savePodcastProgress(currentPodcastId, 0, document.getElementById('podcastAudio').duration);
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
