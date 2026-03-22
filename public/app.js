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
    document.querySelector(`[data-page="${page}"]`).classList.add('active');

    // Refresh data when switching pages
    if (page === 'notes') loadNotesList();
    if (page === 'podcast') {
        loadPodcastNoteSelect();
        loadPodcastList();
    }
    if (page === 'video') {
        loadVideosList();
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
        document.getElementById('settingRagUrl').value = settings.ragUrl || 'http://localhost:8866';
        document.getElementById('settingRagModel').value = settings.ragModel || 'sorc/qwen3.5-instruct:0.8b';
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
            ragUrl: document.getElementById('settingRagUrl').value.trim().replace(/\/$/, ''),
            ragModel: document.getElementById('settingRagModel').value.trim(),
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

    addPodcastTask(noteIdsArray, notesData, title, language = 'zh') {
        const task = {
            id: ++this.taskIdCounter,
            type: 'podcast',
            name: `Podcast: ${title.substring(0, 20)}...`,
            status: 'pending',
            progress: '排隊中...',
            data: { noteIds: noteIdsArray, notesData, title, language }
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

    addVideoNoteTask() {
        if (!currentDirectVideoFilename) return;
        const task = {
            id: ++this.taskIdCounter,
            type: 'video-note',
            name: `影片轉筆記`,
            status: 'pending',
            progress: '排隊中...',
            data: { filename: currentDirectVideoFilename, url: currentDirectVideoUrl }
        };
        this.queue.push(task);
        this.render();
        this.processNext();
        showToast('已加入影片轉筆記佇列', 'success');
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
            } else if (task.type === 'video-note') {
                await processVideoNoteWorker(task);
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

        // Append the source url, author, and original text to the note
        const authorInfo = currentTweet.author ? `- **推文作者：** @${currentTweet.author}\n` : '';
        const formattedOriginalText = formatOriginalText(currentTweet.text);
        const originalTextInfo = formattedOriginalText ? `\n**原始貼文內容：**\n\n${formattedOriginalText}` : '';
        const transcriptInfo = (currentTweet.hasVideo && currentVideoPath && contentForNote.includes('影片逐字稿：\n')) ? `\n\n**影片逐字稿：**\n\n${contentForNote.split('影片逐字稿：\n')[1] || ''}` : '';
        
        const finalNoteContent = `${noteData.text}\n\n---\n\n### 原始來源與內容\n\n- **來源連結：** ${url}\n${authorInfo}${originalTextInfo}${transcriptInfo}`;

        // Step 4: Save to HedgeDoc
        setStep('save');
        TaskQueue.updateTask(task.id, '儲存至 HedgeDoc...');

        const noteTitle = currentTweet.articleTitle
            || `X 貼文筆記 - @${currentTweet.author || 'unknown'} - ${new Date().toLocaleDateString('zh-TW')}`;

        const saveRes = await fetch(`${API}/api/hedgedoc/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: finalNoteContent,
                title: noteTitle,
                sourceUrl: url
            })
        });
        const saveData = await saveRes.json();

        // Show result
        showNoteResult(finalNoteContent, saveData.success ? saveData.note : null);
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
            currentDirectVideoFilename = data.filename;
            currentDirectVideoUrl = url;
            document.getElementById('btnPlayDirect').style.display = 'flex';
            document.getElementById('videoActionContainer').style.display = 'block';

            const player = document.getElementById('directVideoPlayer');
            player.src = data.path;
            document.getElementById('directVideoContainer').style.display = 'block';
            
            // Refresh video list
            loadVideosList();
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

// ─── Video to Note ────────────────────────────────────
function enqueueVideoToNote() {
    if (!currentDirectVideoFilename) {
        showToast('請先下載影片', 'error');
        return;
    }
    TaskQueue.addVideoNoteTask();
}

async function processVideoNoteWorker(task) {
    const { filename, url } = task.data;

    // Transcribe
    TaskQueue.updateTask(task.id, '語音轉逐字稿中...');
    const trRes = await fetch(`${API}/api/whisper/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoPath: filename })
    });
    const trData = await trRes.json();
    
    if (!trData.success || !trData.text) {
        throw new Error('語音辨識失敗或無內容');
    }
    
    const contentForNote = `來源連結：${url}\n\n影片逐字稿：\n${trData.text}`;
    
    // Generate Note
    TaskQueue.updateTask(task.id, '生成中文筆記中...');
    const noteRes = await fetch(`${API}/api/gemini/summarize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: contentForNote })
    });
    const noteData = await noteRes.json();

    if (!noteData.success) throw new Error(noteData.error);
    
    // Extract Title from Gemini response
    const titleMatch = noteData.text.match(/^#\s+(.+)$/m);
    let generatedTitle = `影片逐字稿筆記 - ${new Date().toLocaleDateString('zh-TW')}`;
    if (titleMatch && titleMatch[1]) {
        // Remove markdown artifacts like bolding if present inside the title
        generatedTitle = titleMatch[1].replace(/\*\*/g, '').replace(/__/g, '').trim(); 
    }
    
    // Append the source url and transcript to the note
    const finalNoteContent = `${noteData.text}\n\n---\n\n### 原始來源與逐字稿\n\n- **來源連結：** ${url}\n\n**影片完整逐字稿：**\n\n${trData.text}`;

    // Rename Video on the server
    TaskQueue.updateTask(task.id, '重新命名影片檔案...');
    try {
        const renameRes = await fetch(`${API}/api/videos/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldFilename: filename, newTitle: generatedTitle })
        });
        const renameData = await renameRes.json();
        
        if (renameData.success && renameData.newFilename) {
            // Update currently playing video stats to match new names
            if (currentDirectVideoFilename === filename) {
                currentDirectVideoFilename = renameData.newFilename;
                currentDirectVideoPath = renameData.newPath;
                document.getElementById('directVideoPlayer').src = renameData.newPath;
            }
        }
    } catch(e) {
        console.error('Failed to rename video:', e);
    }
    
    // Refresh the videos list
    loadVideosList();

    // Save to HedgeDoc
    TaskQueue.updateTask(task.id, '儲存至 HedgeDoc...');
    const saveRes = await fetch(`${API}/api/hedgedoc/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            content: finalNoteContent,
            title: generatedTitle,
            sourceUrl: url
        })
    });
    const saveData = await saveRes.json();

    // Show result
    showVideoNoteResult(finalNoteContent, saveData.success ? saveData.note : null);
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
            </div>
          </div>
        `).join('');
    } catch (e) {
        console.error('Load videos error:', e);
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
    const { noteIds, title, language } = task.data;

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

    // Determine duration based on total text length
    const minutes = combinedContent.length > 2000 ? 12 : 5;

    TaskQueue.updateTask(task.id, `📍 正在用 Gemini 生成 ${minutes} 分鐘講稿...`);
    const scriptRes = await fetch(`${API}/api/podcast/generate-script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            noteContents: combinedContent,
            noteTitle: combinedTitle || title,
            language: language,
            minutes: minutes
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
            title: `🎙️ ${combinedTitle || title}`,
            language: language
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
        console.error('Missing audioPath in podcast:', podcast, 'From task completion data.');
        throw new Error(`語音生成完成但無法取得音檔，查無路徑: ${JSON.stringify(podcast)}`);
    }
}

// ─── Podcast: Poll Task Status ────────────────────────
async function pollTaskStatus(taskId, podcastEntry, queueTaskId) {
    const maxWait = 7200; // 2 hours max
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
                const progress_percent = Math.round(data.progress_percent || data.progress || 0);
                const current_step = data.current_step || data.step || 0;
                const total_steps = data.total_steps || 0;

                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;

                const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
                if (queueTaskId) {
                    TaskQueue.updateTask(queueTaskId, `任務生成中... ${timeStr}<br>進度：${progress_percent}% (${current_step}/${total_steps})`);
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
        
        // Auto play next podcast sequentially
        if (window.loadedPodcasts && window.loadedPodcasts.length > 0) {
            const currentIndex = window.loadedPodcasts.findIndex(p => p.id === currentPodcastId);
            if (currentIndex !== -1 && currentIndex < window.loadedPodcasts.length - 1) {
                // There is a next podcast, play it directly
                playPodcast(window.loadedPodcasts[currentIndex + 1]);
            }
        }
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
    if (!window.loadedPodcasts || !currentPodcastId) return;
    const currentIndex = window.loadedPodcasts.findIndex(p => p.id === currentPodcastId);
    if (currentIndex !== -1 && currentIndex < window.loadedPodcasts.length - 1) {
        playPodcast(window.loadedPodcasts[currentIndex + 1]);
    } else {
        showToast('已經是最後一首', 'info');
    }
}

function playPrevPodcast() {
    if (!window.loadedPodcasts || !currentPodcastId) return;
    const currentIndex = window.loadedPodcasts.findIndex(p => p.id === currentPodcastId);
    if (currentIndex > 0) {
        playPodcast(window.loadedPodcasts[currentIndex - 1]);
    } else {
        showToast('已經是第一首', 'info');
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


// ─── Local RAG Query ──────────────────────────────────
async function askRag() {
    const query = document.getElementById('ragQuery').value.trim();
    if (!query) {
        showToast('請輸入查詢問題', 'error');
        return;
    }

    const topK = parseInt(document.getElementById('ragTopK').value) || 3;
    const btn = document.getElementById('btnRagQuery');
    const btnText = document.getElementById('btnRagText');
    const resultCard = document.getElementById('ragResult');
    const answerDiv = document.getElementById('ragAnswer');
    const sourcesDiv = document.getElementById('ragSources');

    // Get RAG URL from settings
    const ragUrl = document.getElementById('settingRagUrl').value.trim() || 'http://localhost:8866';

    try {
        const geminiKey = document.getElementById('settingGeminiKey').value.trim();
        const activeModel = geminiKey ? (document.getElementById('settingGeminiModel').value || 'gemini-2.5-flash') : (document.getElementById('settingRagModel').value || 'sorc/qwen3.5-instruct:0.8b');

        btn.disabled = true;
        btnText.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px;border-top-color:white;"></span> 查詢中...';
        
        let statusDiv = document.getElementById('ragMetaStatus');
        if (!statusDiv) {
            statusDiv = document.createElement('div');
            statusDiv.id = 'ragMetaStatus';
            statusDiv.style = "font-size: 13px; color: var(--text-muted); margin-bottom: 12px; padding: 10px; background: rgba(0,0,0,0.1); border-radius: 6px; display: flex; align-items: center; justify-content: space-between;";
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
                <span><b>🧠 模型:</b> ${escapeHtml(activeModel)}</span>
                <span><b>🔄 階段:</b> <span style="color:var(--accent-info)">${stage}</span></span>
                <span><b>⏳ 耗時:</b> ${elapsed}s</span>
            `;
        }, 100);

        const res = await fetch(`${API}/api/rag/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, top_k: topK })
        });

        if (!res.ok) {
            const errText = await res.text();
            let errorText = '查詢失敗';
            try {
                const errJson = JSON.parse(errText);
                errorText = errJson.detail || errJson.error || errText;
            } catch (e) {
                // If not JSON, use the raw text or fallback
                errorText = errText || '查詢失敗';
            }
            throw new Error(errorText);
        }

        const data = await res.json();
        
        if (window.ragTimerInterval) clearInterval(window.ragTimerInterval);
        const finalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        statusDiv = document.getElementById('ragMetaStatus');
        if (statusDiv) {
            statusDiv.innerHTML = `
                <span><b>🧠 模型:</b> ${escapeHtml(activeModel)}</span>
                <span><b>✅ 階段:</b> <span style="color:#10b981">處理完成</span></span>
                <span><b>⏳ 總耗時:</b> ${finalTime}s</span>
            `;
        }
        
        // Show result
        window.lastRagData = { query, answer: data.answer, source_documents: data.source_documents };
        resultCard.style.display = 'block';
        answerDiv.innerHTML = renderMarkdown(data.answer);
        
        // Show sources
        if (data.source_documents && data.source_documents.length > 0) {
            sourcesDiv.innerHTML = data.source_documents.map((doc, i) => {
                const text = typeof doc === 'object' && doc.text ? doc.text : doc;
                const titleHtml = typeof doc === 'object' && doc.title ? `<span style="font-weight:600; font-size:13px; color:var(--text-primary); margin-left:6px;">${escapeHtml(doc.title)}</span>` : '';
                const linkHtml = typeof doc === 'object' && doc.url && doc.url.startsWith('http') ? `<a href="${escapeHtml(doc.url)}" target="_blank" style="margin-left:auto; color:var(--accent-info); font-size:12px; text-decoration:none;">🔗 開啟來源</a>` : '';
                const collBadge = typeof doc === 'object' && doc.collection ? `<span style="background:var(--bg-card); padding:2px 8px; border-radius:12px; font-size:10px; border:1px solid var(--border); margin-left:6px;">${escapeHtml(doc.collection)}</span>` : '';

                return `
                <div style="background:var(--bg-card-hover); border:1px solid var(--border); border-radius:8px; padding:12px; margin-top:10px;">
                    <div style="display:flex; align-items:center; margin-bottom:6px; flex-wrap:wrap;">
                        <span style="font-size:12px; font-weight:600; color:var(--accent-primary);">[來源 ${i+1}]</span>
                        ${collBadge}
                        ${titleHtml}
                        ${linkHtml}
                    </div>
                    <div style="font-size:14px; color:var(--text-primary); white-space:pre-wrap; line-height: 1.6;">${escapeHtml(text)}</div>
                </div>
            `;
            }).join('');
        } else {
            sourcesDiv.innerHTML = '<p style="font-size:14px; color:var(--text-muted);">無參考資料</p>';
        }

        showToast('查詢完成', 'success');
        
        // Scroll to result
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


