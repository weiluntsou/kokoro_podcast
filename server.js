const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const fetch = require('node-fetch');
const FormData = require('form-data');
const multer = require('multer');
const os = require('os');

let macosTemp = null;
try {
  macosTemp = require('macos-temperature-sensor');
} catch (e) {
  console.warn('macos-temperature-sensor could not be loaded:', e.message);
}

const app = express();
const PORT = 3777;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Data directories ───────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const VIDEOS_DIR = path.join(DATA_DIR, 'videos');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
const PODCASTS_FILE = path.join(DATA_DIR, 'podcasts.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

[DATA_DIR, VIDEOS_DIR, AUDIO_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Background CPU Load Tracker ──────────────────────────────
let lastCpuInfo = os.cpus();
let cpuUsages = [];
let cpuOverall = 0;

setInterval(() => {
  const currentCpuInfo = os.cpus();
  const newUsages = [];
  let totalDeltaIdle = 0;
  let totalDeltaTotal = 0;

  for (let i = 0; i < currentCpuInfo.length; i++) {
    const start = lastCpuInfo[i];
    const end = currentCpuInfo[i];
    if (!start || !end) continue;

    const startTotal = Object.values(start.times).reduce((a, b) => a + b, 0);
    const endTotal = Object.values(end.times).reduce((a, b) => a + b, 0);

    const deltaIdle = end.times.idle - start.times.idle;
    const deltaTotal = endTotal - startTotal;

    const usage = deltaTotal > 0 ? (1 - deltaIdle / deltaTotal) * 100 : 0;
    newUsages.push(Math.round(usage));

    totalDeltaIdle += deltaIdle;
    totalDeltaTotal += deltaTotal;
  }

  if (newUsages.length > 0) {
    cpuUsages = newUsages;
    cpuOverall = totalDeltaTotal > 0 ? Math.round((1 - totalDeltaIdle / totalDeltaTotal) * 100) : 0;
  }
  lastCpuInfo = currentCpuInfo;
}, 2000);

// ─── Helpers ─────────────────────────────────────────────────
function loadJSON(file, fallback = {}) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) { console.error(`Error loading ${file}:`, e.message); }
  return fallback;
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function getSettings() {
  return loadJSON(SETTINGS_FILE, {
    geminiApiKey: '',
    geminiModel: 'gemma-4-26b-a4b-it',
    hedgedocUrl: '',
    hedgedocCookie: '',
    whisperUrl: 'http://localhost:8080',
    kokoroUrl: 'http://localhost:8880',
    ragUrl: 'http://localhost:8866',
    ragModel: 'sorc/qwen3.5-instruct:0.8b',
    xCookie: '',
    igCookie: ''
  });
}

// ─── yt-dlp Path Helper ──────────────────────────────────────
function getYtDlpPath() {
  const candidates = [
    'yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
    '/opt/local/bin/yt-dlp',
    `${process.env.HOME}/.local/bin/yt-dlp`,
    `${process.env.HOME}/bin/yt-dlp`,
    `${process.env.HOME}/.cargo/bin/yt-dlp`,
  ];
  for (const p of candidates) {
    try { execSync(`"${p}" --version`, { stdio: 'ignore', timeout: 5000 }); return p; } catch {}
  }
  throw new Error('找不到 yt-dlp，請先安裝：pip3 install yt-dlp 或 brew install yt-dlp');
}

// ─── Background Task Manager ─────────────────────────────────
const TASK_QUEUE_FILE = path.join(DATA_DIR, 'task_queue.json');
let taskQueue = loadJSON(TASK_QUEUE_FILE, []);
let isProcessingServerTasks = false;

function saveTaskQueue() {
  saveJSON(TASK_QUEUE_FILE, taskQueue);
}

function updateServerTask(taskId, progress) {
  const task = taskQueue.find(t => t.id === taskId);
  if (task) {
    task.progress = progress;
    saveTaskQueue();
  }
}

async function internalFetch(urlPath, body, method = 'POST') {
  const url = `http://localhost:${PORT}${urlPath}`;
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok || (!data.success && data.success !== undefined)) {
    throw new Error(data.error || data.detail || 'Internal request failed');
  }
  return data;
}

function formatOriginalText(text) {
  if (!text) return '';
  return text.replace(/https?:\/\/(t\.co|x\.com|twitter\.com)\/\S+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim().split('\n').map(l => l.trim() ? `> ${l.trim()}` : '>').join('\n');
}

function formatOriginalWebText(text) {
  if (!text) return '';
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim().split('\n').map(l => l.trim() ? `> ${l.trim()}` : '>').join('\n');
}

// ─── URL Type Detection ──────────────────────────────────────
function detectUrlType(url) {
  if (!url) return 'unknown';
  if (/(?:x\.com|twitter\.com)\/\w+\/(?:status|article)\/\d+/i.test(url)) return 'x';
  if (/(?:x\.com|twitter\.com)\/i\/article\/\d+/i.test(url)) return 'x';
  if (/threads\.net/i.test(url)) return 'threads';
  // Generic web pages (blogs, news, etc.)
  if (/^https?:\/\//i.test(url)) return 'web';
  return 'unknown';
}

async function processPostWorker(task) {
  const { url } = task.data;
  const urlType = detectUrlType(url);

  if (urlType === 'x') {
    // ── X (Twitter) post flow ──
    await processXPostWorker(task);
  } else if (urlType === 'threads' || urlType === 'web') {
    // ── Threads / Blog / News flow ──
    await processWebPageWorker(task);
  } else {
    throw new Error('不支援的 URL 格式');
  }
}

async function processXPostWorker(task) {
  const { url } = task.data;
  updateServerTask(task.id, '解析 X 貼文中...');
  const parseData = await internalFetch('/api/x/parse', { url });
  const currentTweet = parseData.tweet;

  let contentForNote = currentTweet.text;
  if (currentTweet.fetchedContent) {
    contentForNote += `\n\n連結頁面內容：\n${currentTweet.fetchedContent}`;
  }

  let currentVideoPath = null;
  if (currentTweet.hasVideo) {
    updateServerTask(task.id, '下載影片中...');
    const dlData = await internalFetch('/api/x/download-video', { url });
    currentVideoPath = dlData.path;

    updateServerTask(task.id, '語音轉逐字稿中...');
    const trData = await internalFetch('/api/whisper/transcribe', { videoPath: dlData.filename });
    if (trData.text) {
      contentForNote = `貼文內容：\n${currentTweet.text}\n\n影片逐字稿：\n${trData.text}`;
    }
  }

  updateServerTask(task.id, '生成中文筆記中...');
  const noteData = await internalFetch('/api/gemini/summarize', { content: contentForNote });

  const authorInfo = currentTweet.author ? `- **推文作者：** @${currentTweet.author}\n` : '';
  const formattedOriginalText = formatOriginalText(currentTweet.text);
  const originalTextInfo = formattedOriginalText ? `\n**原始貼文內容：**\n\n${formattedOriginalText}` : '';
  const transcriptInfo = (currentTweet.hasVideo && currentVideoPath && contentForNote.includes('影片逐字稿：\n')) ? `\n\n**影片逐字稿：**\n\n${contentForNote.split('影片逐字稿：\n')[1] || ''}` : '';
  const formattedImages = (currentTweet.images && currentTweet.images.length > 0) ? `\n\n### 相關圖片\n\n${currentTweet.images.map(img => `![image](${img})`).join('\n\n')}` : '';
  const finalNoteContent = `${noteData.text}\n\n---\n\n### 原始來源與內容\n\n- **來源連結：** ${url}\n${authorInfo}${originalTextInfo}${transcriptInfo}${formattedImages}`;

  updateServerTask(task.id, '儲存至 HedgeDoc...');
  const noteTitle = currentTweet.articleTitle || `X 貼文筆記 - @${currentTweet.author || 'unknown'} - ${new Date().toLocaleDateString('zh-TW')}`;
  const hdResult = await internalFetch('/api/hedgedoc/create', { content: finalNoteContent, title: noteTitle, sourceUrl: url });
  
  if (hdResult && hdResult.note && hdResult.note.url) {
    task.data = task.data || {};
    task.data.noteUrl = hdResult.note.url;
  }
}

async function processWebPageWorker(task) {
  const { url } = task.data;
  const isThreads = /threads\.net/i.test(url);
  updateServerTask(task.id, isThreads ? '解析 Threads 貼文中...' : '解析網頁內容中...');
  
  const parseData = await internalFetch('/api/web/parse', { url });
  const page = parseData.page;

  let contentForNote = '';
  if (page.title) contentForNote += `標題：${page.title}\n\n`;
  if (page.author) contentForNote += `作者：${page.author}\n\n`;
  if (page.description) contentForNote += `摘要：${page.description}\n\n`;
  if (page.text) contentForNote += `內文：\n${page.text}`;

  if (!contentForNote.trim()) {
    throw new Error('無法從網頁擷取到有效內容');
  }

  updateServerTask(task.id, '生成中文筆記中...');
  const noteData = await internalFetch('/api/gemini/summarize', { content: contentForNote });

  const authorInfo = page.author ? `- **作者：** ${page.author}\n` : '';
  const siteInfo = page.siteName ? `- **網站：** ${page.siteName}\n` : '';
  const pubDateInfo = page.publishedDate ? `- **發佈日期：** ${page.publishedDate}\n` : '';
  const formattedOriginal = formatOriginalWebText(page.text);
  const originalTextInfo = formattedOriginal ? `\n**原始內容：**\n\n${formattedOriginal}` : '';
  const platformLabel = isThreads ? 'Threads 貼文' : (page.siteName || '網頁');
  const formattedImages = (page.images && page.images.length > 0) ? `\n\n### 相關圖片\n\n${page.images.map(img => `![image](${img})`).join('\n\n')}` : '';
  const finalNoteContent = `${noteData.text}\n\n---\n\n### 原始來源與內容\n\n- **來源連結：** ${url}\n- **來源平台：** ${platformLabel}\n${authorInfo}${siteInfo}${pubDateInfo}${originalTextInfo}${formattedImages}`;

  updateServerTask(task.id, '儲存至 HedgeDoc...');
  const noteTitle = page.title || `${platformLabel}筆記 - ${new Date().toLocaleDateString('zh-TW')}`;
  const hdResult = await internalFetch('/api/hedgedoc/create', { content: finalNoteContent, title: noteTitle, sourceUrl: url });
  
  if (hdResult && hdResult.note && hdResult.note.url) {
    task.data = task.data || {};
    task.data.noteUrl = hdResult.note.url;
  }
}

async function downloadVideoWorker(task) {
  const { url, quality } = task.data;
  updateServerTask(task.id, '下載影片中...');
  await internalFetch('/api/x/download-video', { url, quality });
}

async function processVideoNoteWorker(task) {
  const { filename, url } = task.data;
  updateServerTask(task.id, '語音轉逐字稿中...');
  const trData = await internalFetch('/api/whisper/transcribe', { videoPath: filename });
  const contentForNote = `來源連結：${url}\n\n影片逐字稿：\n${trData.text}`;
  
  updateServerTask(task.id, '生成中文筆記中...');
  const noteData = await internalFetch('/api/gemini/summarize', { content: contentForNote });
  
  const titleMatch = noteData.text.match(/^#\s+(.+)$/m);
  let generatedTitle = `影片逐字稿筆記 - ${new Date().toLocaleDateString('zh-TW')}`;
  if (titleMatch && titleMatch[1]) {
    generatedTitle = titleMatch[1].replace(/\*\*/g, '').replace(/__/g, '').trim(); 
  }
  const finalNoteContent = `${noteData.text}\n\n---\n\n### 原始來源與逐字稿\n\n- **來源連結：** ${url}\n\n**影片完整逐字稿：**\n\n${trData.text}`;

  updateServerTask(task.id, '重新命名影片檔案...');
  try {
    await internalFetch('/api/videos/rename', { oldFilename: filename, newTitle: generatedTitle });
  } catch (e) {
    console.error('Task: Failed to rename video:', e.message);
  }
  
  updateServerTask(task.id, '儲存至 HedgeDoc...');
  const hdResult = await internalFetch('/api/hedgedoc/create', { content: finalNoteContent, title: generatedTitle, sourceUrl: url });

  if (hdResult && hdResult.note && hdResult.note.url) {
    task.data = task.data || {};
    task.data.noteUrl = hdResult.note.url;
  }
}

async function processPodcastWorker(task) {
  const { noteIds, title, language } = task.data;
  updateServerTask(task.id, '讀取 Hedgehog 筆記中...');
  const notesRes = await internalFetch('/api/hedgedoc/list', null, 'GET');
  const selectedNotes = notesRes.notes.filter(n => noteIds.includes(n.id));

  let combinedContent = '';
  let combinedTitle = '';
  const settings = getSettings();
  
  for (const note of selectedNotes) {
    combinedTitle += (combinedTitle ? ' & ' : '') + note.title;
    try {
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

  const minutes = combinedContent.length > 2000 ? 12 : 5;
  updateServerTask(task.id, `📍 正在用 Gemini 生成 ${minutes} 分鐘講稿...`);
  const scriptData = await internalFetch('/api/podcast/generate-script', { 
    noteContents: combinedContent, noteTitle: combinedTitle || title, language, minutes 
  });
  
  updateServerTask(task.id, '📍 正在發送講稿到 Kokoro 生成語音...');
  const audioData = await internalFetch('/api/podcast/generate-audio', {
    script: scriptData.script, title: `🎙️ ${combinedTitle || title}`, language
  });
  
  const taskId = audioData.taskId;
  updateServerTask(task.id, `Kokoro 語音生成中... (Task: ${taskId.substring(0, 8)}...)`);
  
  const maxWait = 7200;
  const interval = 5;
  let elapsed = 0;
  while (elapsed < maxWait) {
    await new Promise(r => setTimeout(r, interval * 1000));
    elapsed += interval;
    try {
      const statusData = await internalFetch(`/api/podcast/task-status/${taskId}`, null, 'GET');
      if (statusData.status === 'completed') {
        return;
      } else if (statusData.status === 'error' || statusData.status === 'failed') {
        throw new Error('語音生成任務失敗');
      } else {
        const progress_percent = Math.round(statusData.progress_percent || statusData.progress || 0);
        const current_step = statusData.current_step || statusData.step || 0;
        const total_steps = statusData.total_steps || 0;
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`;
        updateServerTask(task.id, `任務生成中... ${timeStr}<br>進度：${progress_percent}% (${current_step}/${total_steps})`);
      }
    } catch(e) {
      if (e.message.indexOf('失敗') > -1) throw e;
    }
  }
  throw new Error('語音生成超時（超過 2 小時）');
}

async function processServerNextTask() {
  if (isProcessingServerTasks) return;
  const pendingTaskIndex = taskQueue.findIndex(t => t.status === 'pending');
  if (pendingTaskIndex === -1) return;

  isProcessingServerTasks = true;
  const task = taskQueue[pendingTaskIndex];
  task.status = 'processing';
  saveTaskQueue();

  try {
    if (task.type === 'process') {
      await processPostWorker(task);
    } else if (task.type === 'podcast') {
      await processPodcastWorker(task);
    } else if (task.type === 'download' || task.type === 'direct-download') {
      await downloadVideoWorker(task);
    } else if (task.type === 'video-note') {
      await processVideoNoteWorker(task);
    }
    task.status = 'done';
    task.progress = '處理完成';
  } catch (err) {
    task.status = 'error';
    task.progress = `錯誤: ${err.message}`;
  }
  
  saveTaskQueue();
  isProcessingServerTasks = false;
  processServerNextTask();
}

// Reset processing tasks on boot
(() => {
  taskQueue.forEach(t => {
    if (t.status === 'processing') {
      t.status = 'error';
      t.progress = '處理中斷 (伺服器重新啟動)';
    }
  });
  saveTaskQueue();
  setTimeout(() => processServerNextTask(), 3000);
})();

app.get('/api/tasks', (req, res) => {
  res.json({ success: true, queue: taskQueue });
});

app.post('/api/tasks/add', (req, res) => {
  const task = {
    id: Date.now().toString() + Math.floor(Math.random() * 1000),
    type: req.body.type,
    name: req.body.name,
    status: 'pending',
    progress: '排隊中...',
    data: req.body.data,
    createdAt: new Date().toISOString()
  };
  taskQueue.push(task);
  saveTaskQueue();
  processServerNextTask();
  res.json({ success: true, task });
});

app.post('/api/tasks/clear', (req, res) => {
  taskQueue = taskQueue.filter(t => t.status === 'pending' || t.status === 'processing');
  saveTaskQueue();
  res.json({ success: true });
});

// ─── Settings API ────────────────────────────────────────────
function convertCookieToNetscape(cookieString, domain = '.x.com') {
  if (!cookieString) return '';
  const lines = ['# Netscape HTTP Cookie File', ''];
  const cookies = cookieString.split(';');
  const expireTime = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60; // 1 year from now
  for (const cookie of cookies) {
    const parts = cookie.trim().split('=');
    if (parts.length >= 2) {
      const name = parts[0];
      const value = parts.slice(1).join('=');
      lines.push(`${domain}\tTRUE\t/\tTRUE\t${expireTime}\t${name}\t${value}`);
    }
  }
  return lines.join('\n');
}

app.get('/api/settings', (req, res) => {
  res.json(getSettings());
});

app.post('/api/settings', (req, res) => {
  const settings = { ...getSettings(), ...req.body };
  saveJSON(SETTINGS_FILE, settings);
  res.json({ success: true, settings });
});

// ─── X Post Parse (yt-dlp + FxTwitter + syndication + oEmbed) ─
app.post('/api/x/parse', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: '缺少 URL' });

    // Extract tweet ID and author from URL (support both /status/ and /article/)
    const match = url.match(/(?:x\.com|twitter\.com)\/(\w+)\/(?:status|article)\/(\d+)/);
    // Also support /i/article/ format
    const articleMatch = !match && url.match(/(?:x\.com|twitter\.com)\/i\/article\/(\d+)/);
    if (!match && !articleMatch) return res.status(400).json({ error: '無效的 X 貼文連結' });
    const author = match ? match[1] : '';
    const tweetId = match ? match[2] : articleMatch[1];
    const isArticle = url.includes('/article/');

    const settings = getSettings();
    let tweetText = '';
    let hasVideo = false;
    let parseMethod = '';
    let tweetImages = [];

    if (isArticle) {
      console.log(`Detected X Article URL, ID: ${tweetId}`);
    }

    // Method 1: Try yt-dlp --dump-json (works well & detects video)
    try {
      let cookieArgs = '';
      if (settings.xCookie) {
        const cookieFile = path.join(DATA_DIR, 'x_cookies.txt');
        fs.writeFileSync(cookieFile, convertCookieToNetscape(settings.xCookie), 'utf-8');
        cookieArgs = `--cookies "${cookieFile}"`;
      }

      const result = execSync(
        `yt-dlp ${cookieArgs} --dump-json --no-download "${url}" 2>/dev/null`,
        { encoding: 'utf-8', timeout: 30000 }
      );

      const info = JSON.parse(result);
      tweetText = info.description || info.title || '';
      hasVideo = true; // yt-dlp only succeeds if there is media
      parseMethod = 'yt-dlp';
    } catch (ytErr) {
      console.log('yt-dlp parse: no media found or error, trying other methods...');
    }

    // Method 2: X API with Cookie authentication (uses your configured cookie)
    if (!tweetText && settings.xCookie) {
      // Extract ct0 (CSRF token) from cookie
      const ct0Match = settings.xCookie.match(/ct0=([^;\s]+)/);
      const csrfToken = ct0Match ? ct0Match[1] : '';

      if (csrfToken) {
        const xHeaders = {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Cookie': settings.xCookie,
          'x-csrf-token': csrfToken,
          'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
          'x-twitter-active-user': 'yes',
          'x-twitter-auth-type': 'OAuth2Session',
          'Accept': 'application/json'
        };

        // 2a: Try Twitter API v1.1 (works for regular tweets)
        if (!isArticle) {
          try {
            console.log('Trying X API v1.1 with cookie...');
            const xApiRes = await fetch(
              `https://api.x.com/1.1/statuses/show.json?id=${tweetId}&tweet_mode=extended`,
              { headers: xHeaders }
            );
            if (xApiRes.ok) {
              const xData = await xApiRes.json();
              tweetText = xData.full_text || xData.text || '';
              if (xData.extended_entities && xData.extended_entities.media) {
                hasVideo = xData.extended_entities.media.some(m => m.type === 'video' || m.type === 'animated_gif');
                xData.extended_entities.media.filter(m => m.type === 'photo').forEach(m => tweetImages.push(m.media_url_https));
              }
              if (tweetText) {
                parseMethod = 'x-api-v1.1';
                console.log(`X API v1.1 parsed successfully, textLen=${tweetText.length}`);
              }
            } else {
              console.log(`X API v1.1 returned ${xApiRes.status}`);
            }
          } catch (xErr) {
            console.log('X API v1.1 failed:', xErr.message);
          }
        }

        // 2b: Try X GraphQL TweetDetail API (works for tweets and articles)
        if (!tweetText) {
          try {
            console.log('Trying X GraphQL TweetDetail with cookie...');
            const variables = JSON.stringify({
              tweetId: tweetId,
              withCommunity: false,
              includePromotedContent: false,
              withVoice: false
            });
            const features = JSON.stringify({
              creator_subscriptions_tweet_preview_api_enabled: true,
              communities_web_enable_tweet_community_results_fetch: true,
              c9s_tweet_anatomy_moderator_badge_enabled: true,
              articles_preview_enabled: true,
              responsive_web_edit_tweet_api_enabled: true,
              graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
              view_counts_everywhere_api_enabled: true,
              longform_notetweets_consumption_enabled: true,
              responsive_web_twitter_article_tweet_consumption_enabled: true,
              tweet_awards_web_tipping_enabled: false,
              creator_subscriptions_quote_tweet_preview_enabled: false,
              freedom_of_speech_not_reach_fetch_enabled: true,
              standardized_nudges_misinfo: true,
              tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
              rweb_video_timestamps_enabled: true,
              longform_notetweets_rich_text_read_enabled: true,
              longform_notetweets_inline_media_enabled: true,
              responsive_web_enhance_cards_enabled: false
            });

            const gqlRes = await fetch(
              `https://x.com/i/api/graphql/xOhkmRac04YFZmOzU9PJHg/TweetResultByRestId?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`,
              { headers: xHeaders }
            );

            if (gqlRes.ok) {
              const gqlData = await gqlRes.json();
              // Navigate the GraphQL response structure
              const tweetResult = gqlData?.data?.tweetResult?.result;
              if (tweetResult) {
                const legacy = tweetResult.legacy || tweetResult.tweet?.legacy;
                if (legacy) {
                  tweetText = legacy.full_text || '';
                }
                // Check for article/note content
                const noteText = tweetResult.note_tweet?.note_tweet_results?.result?.text;
                if (noteText) {
                  tweetText = noteText;
                }
                // Check for article content
                if (tweetResult.article || tweetResult.tweet?.article) {
                  const article = tweetResult.article || tweetResult.tweet?.article;
                  if (article.content) tweetText = article.content;
                  if (article.body) tweetText = article.body;
                  if (article.text) tweetText = article.text;
                }
                if (tweetText) {
                  parseMethod = 'x-graphql';
                  console.log(`X GraphQL parsed successfully, textLen=${tweetText.length}`);
                }
              }
            } else {
              console.log(`X GraphQL returned ${gqlRes.status}`);
            }
          } catch (gqlErr) {
            console.log('X GraphQL failed:', gqlErr.message);
          }
        }

        // 2c: For articles, also try fetching the page HTML with cookies
        if (!tweetText && isArticle) {
          try {
            console.log('Trying to fetch article page with cookie...');
            const pageRes = await fetch(url, {
              headers: {
                ...xHeaders,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
              },
              redirect: 'follow'
            });
            if (pageRes.ok) {
              const pageHtml = await pageRes.text();

              // Try to extract __NEXT_DATA__ or embedded JSON
              const nextDataMatch = pageHtml.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
              if (nextDataMatch) {
                try {
                  const nextData = JSON.parse(nextDataMatch[1]);
                  // Try to find article content in the nested data
                  const jsonStr = JSON.stringify(nextData);
                  // Look for content/body/text fields
                  const bodyMatch = jsonStr.match(/"body":"((?:[^"\\]|\\.)*)"/);
                  const contentMatch = jsonStr.match(/"content":"((?:[^"\\]|\\.)*)"/);
                  if (bodyMatch) tweetText = JSON.parse(`"${bodyMatch[1]}"`);
                  else if (contentMatch) tweetText = JSON.parse(`"${contentMatch[1]}"`);
                } catch { }
              }

              // Try to extract from script tags containing tweet data
              if (!tweetText) {
                const scriptMatches = pageHtml.match(/<script[^>]*>[\s\S]*?"full_text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                if (scriptMatches) {
                  try {
                    tweetText = JSON.parse(`"${scriptMatches[1]}"`);
                  } catch { }
                }
              }

              // Try to extract og:description as fallback
              if (!tweetText) {
                const ogMatch = pageHtml.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([\s\S]*?)["']/i);
                if (ogMatch && ogMatch[1].length > 20) {
                  tweetText = ogMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                }
              }

              if (tweetText) {
                parseMethod = 'x-page-cookie';
                console.log(`Article page parsed with cookie, textLen=${tweetText.length}`);
              }
            }
          } catch (pageErr) {
            console.log('Article page fetch failed:', pageErr.message);
          }
        }
      } else {
        console.log('X Cookie found but no ct0 CSRF token detected. Cookie format should include ct0=xxx');
      }
    }

    // Method 3: FxTwitter API (most reliable for text content)
    if (!tweetText) {
      // Try multiple FxTwitter URL patterns
      const fxUrls = [];
      if (author) {
        fxUrls.push(`https://api.fxtwitter.com/${author}/status/${tweetId}`);
      }
      // For articles, also try direct ID access
      fxUrls.push(`https://api.fxtwitter.com/i/status/${tweetId}`);
      if (isArticle) {
        fxUrls.push(`https://api.fxtwitter.com/${author || 'i'}/article/${tweetId}`);
      }

      for (const fxUrl of fxUrls) {
        if (tweetText) break;
        try {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
          console.log(`Trying FxTwitter: ${fxUrl}`);
          const fxRes = await fetch(fxUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; bot)',
              'Accept': 'application/json'
            }
          });
          if (fxRes.ok) {
            const fxData = await fxRes.json();
            if (fxData.tweet) {
              console.log('FxTwitter tweet keys:', Object.keys(fxData.tweet).join(', '));
              tweetText = fxData.tweet.text ? String(fxData.tweet.text) : '';

              // For articles, extract full article content
              if (fxData.tweet.article) {
                const art = fxData.tweet.article;
                console.log('FxTwitter article keys:', Object.keys(art).join(', '));

                // Debug: log content type and preview
                console.log('FxTwitter article.content type:', typeof art.content);
                if (art.content) {
                  const preview = typeof art.content === 'string'
                    ? art.content.substring(0, 200)
                    : JSON.stringify(art.content).substring(0, 200);
                  console.log('FxTwitter article.content preview:', preview);
                }

                // Build article text from available fields
                const articleParts = [];
                if (art.title) articleParts.push(String(art.title));
                if (art.preview_text) articleParts.push(String(art.preview_text));

                // Handle content field - could be string (HTML/markdown), object, or array
                if (art.content) {
                  let contentStr = '';
                  if (typeof art.content === 'string') {
                    // Could be HTML - strip tags
                    contentStr = art.content
                      .replace(/<br\s*\/?>/gi, '\n')
                      .replace(/<\/p>/gi, '\n\n')
                      .replace(/<\/h[1-6]>/gi, '\n\n')
                      .replace(/<\/li>/gi, '\n')
                      .replace(/<li[^>]*>/gi, '- ')
                      .replace(/<[^>]*>/g, '')
                      .replace(/&amp;/g, '&')
                      .replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>')
                      .replace(/&quot;/g, '"')
                      .replace(/&#39;/g, "'")
                      .replace(/&nbsp;/g, ' ')
                      .replace(/\n{3,}/g, '\n\n')
                      .trim();
                  } else if (Array.isArray(art.content)) {
                    // Array of content blocks
                    contentStr = art.content.map(block => {
                      if (typeof block === 'string') return block;
                      if (block.text) return String(block.text);
                      if (block.content) return String(block.content);
                      return JSON.stringify(block);
                    }).join('\n\n');
                  } else if (typeof art.content === 'object') {
                    // Object - try to extract text
                    contentStr = art.content.text || art.content.body ||
                      art.content.html || JSON.stringify(art.content);
                    if (typeof contentStr !== 'string') contentStr = JSON.stringify(contentStr);
                    // Strip HTML if present
                    contentStr = contentStr
                      .replace(/<[^>]*>/g, ' ')
                      .replace(/\s+/g, ' ')
                      .trim();
                  }
                  if (contentStr && contentStr.length > 10) {
                    articleParts.push(contentStr);
                  }
                }

                const fullArticle = articleParts.join('\n\n');
                if (fullArticle.length > tweetText.length) {
                  tweetText = fullArticle;
                  console.log(`FxTwitter article text built, len=${tweetText.length}`);
                }
              }

              if (fxData.tweet.media) {
                if (fxData.tweet.media.videos && fxData.tweet.media.videos.length > 0) hasVideo = true;
                if (fxData.tweet.media.photos && fxData.tweet.media.photos.length > 0) {
                  fxData.tweet.media.photos.forEach(p => tweetImages.push(p.url));
                }
              }
              if (tweetText) {
                parseMethod = 'fxtwitter';
                console.log(`FxTwitter parsed successfully from ${fxUrl}, textLen=${tweetText.length}`);
              }
            }
          }
        } catch (fxErr) {
          console.log(`FxTwitter failed for ${fxUrl}:`, fxErr.message);
        }
      }
    }

    // Method 4: VxTwitter / FixupX API (alternative)
    if (!tweetText) {
      const vxAuthor = author || 'i';
      try {
        const vxRes = await fetch(
          `https://api.vxtwitter.com/${vxAuthor}/status/${tweetId}`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; bot)',
              'Accept': 'application/json'
            }
          }
        );
        if (vxRes.ok) {
          const vxData = await vxRes.json();
          tweetText = vxData.text || '';
          if (vxData.mediaURLs) {
            if (vxData.mediaURLs.some(u => u.includes('.mp4') || u.includes('video'))) hasVideo = true;
            vxData.mediaURLs.filter(u => /(jpg|jpeg|png|webp)/i.test(u) && !u.includes('video')).forEach(u => tweetImages.push(u));
          }
          if (tweetText) {
            parseMethod = 'vxtwitter';
            console.log('VxTwitter parsed successfully');
          }
        }
      } catch (vxErr) {
        console.log('VxTwitter API failed:', vxErr.message);
      }
    }

    // Method 5: Twitter syndication API
    if (!tweetText) {
      try {
        const synRes = await fetch(
          `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=zh-tw&token=0`,
          {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
              'Accept': 'application/json'
            }
          }
        );
        if (synRes.ok) {
          const synData = await synRes.json();
          tweetText = synData.text || synData.full_text || '';
          if (synData.mediaDetails) {
            if (synData.mediaDetails.some(m => m.type === 'video')) hasVideo = true;
            synData.mediaDetails.filter(m => m.type === 'photo').forEach(m => tweetImages.push(m.media_url_https));
          }
          if (tweetText) {
            parseMethod = 'syndication';
            console.log('Syndication API parsed successfully');
          }
        }
      } catch (synErr) {
        console.log('Syndication API failed:', synErr.message);
      }
    }

    // Method 6: Twitter oEmbed API (last resort — limited info)
    if (!tweetText) {
      try {
        const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}&omit_script=true`;
        const oeRes = await fetch(oembedUrl);
        if (oeRes.ok) {
          const oeData = await oeRes.json();
          // Extract text from the blockquote content (skip the author link at the end)
          const htmlContent = oeData.html || '';
          // Get only the <p> content inside <blockquote>
          const pMatch = htmlContent.match(/<blockquote[^>]*>.*?<p[^>]*>([\s\S]*?)<\/p>/i);
          let extractedText = '';
          if (pMatch) {
            extractedText = pMatch[1]
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<a[^>]*>(.*?)<\/a>/gi, '$1')
              .replace(/<[^>]*>/g, '')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/https?:\/\/t\.co\/\S+/g, '')  // remove t.co links
              .replace(/\s+/g, ' ')
              .trim();
          }
          if (extractedText && extractedText.length > 5) {
            tweetText = extractedText;
            parseMethod = 'oembed';
            console.log('oEmbed parsed successfully');
          }
        }
      } catch (oeErr) {
        console.log('oEmbed API failed:', oeErr.message);
      }
    }

    // Ensure tweetText is always a string (some APIs may return objects)
    if (tweetText && typeof tweetText !== 'string') {
      try { tweetText = JSON.stringify(tweetText); } catch { tweetText = String(tweetText); }
    }
    if (!tweetText) tweetText = '';

    console.log(`Parse result: method=${parseMethod}, textLen=${tweetText.length}, hasVideo=${hasVideo}`);

    // ─── Try to fetch content from URLs in tweet text ───
    let fetchedUrlContent = '';
    const urlsInText = (typeof tweetText === 'string' ? tweetText.match(/https?:\/\/[^\s]+/g) : null) || [];
    // Also check the original URL for article links
    const allUrls = [...urlsInText];
    if (url.includes('/i/article/') || url.includes('/articles/')) {
      allUrls.push(url);
    }

    for (const linkUrl of allUrls) {
      if (fetchedUrlContent) break;
      try {
        // Skip t.co links that just redirect to X itself
        const cleanUrl = linkUrl.replace(/[).,]+$/, '');
        console.log(`Trying to fetch content from: ${cleanUrl}`);

        const linkRes = await fetch(cleanUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          redirect: 'follow',
          timeout: 15000
        });

        if (linkRes.ok) {
          const contentType = linkRes.headers.get('content-type') || '';
          if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
            const html = await linkRes.text();

            // Extract readable text from HTML
            let textContent = html
              // Remove script and style
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
              .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
              .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
              // Try to extract article/main content
              .replace(/^[\s\S]*?(<article[\s\S]*?<\/article>)/i, '$1')
              || html;

            // Also try <meta name="description"> and <title>
            const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
            const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
            const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);

            // Clean HTML tags
            textContent = textContent
              .replace(/<[^>]*>/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&nbsp;/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();

            // Build fetched content
            const parts = [];
            if (titleMatch) parts.push(`標題：${titleMatch[1].trim()}`);
            if (ogDesc) parts.push(`摘要：${ogDesc[1].trim()}`);
            else if (metaDesc) parts.push(`摘要：${metaDesc[1].trim()}`);
            if (textContent.length > 50) {
              // Limit to first ~3000 chars to avoid overloading the LLM
              parts.push(`內文：${textContent.substring(0, 3000)}`);
            }

            if (parts.length > 0) {
              fetchedUrlContent = parts.join('\n\n');
              console.log(`Fetched ${fetchedUrlContent.length} chars from ${cleanUrl}`);
            }
          }
        }
      } catch (fetchErr) {
        console.log(`Failed to fetch ${linkUrl}: ${fetchErr.message}`);
      }
    }

    // Extract article title if available
    let articleTitle = '';
    // Check if tweetText starts with a title line (from FxTwitter article)
    if (tweetText.includes('\n\n')) {
      const firstLine = tweetText.split('\n\n')[0];
      // If first line looks like a title (short, no URLs)
      if (firstLine.length < 200 && !firstLine.match(/https?:\/\//)) {
        articleTitle = firstLine;
      }
    }

    res.json({
      success: true,
      tweet: {
        id: tweetId,
        text: tweetText,
        author: author,
        hasVideo,
        images: [...new Set(tweetImages)],
        url,
        parseMethod,
        fetchedContent: fetchedUrlContent,
        articleTitle: articleTitle
      }
    });
  } catch (error) {
    console.error('X parse error:', error.message);
    const match = req.body.url?.match(/(?:x\.com|twitter\.com)\/(\w+)\/(?:status|article)\/(\d+)/)
      || req.body.url?.match(/(?:x\.com|twitter\.com)\/i\/article\/(\d+)/);
    res.json({
      success: true,
      tweet: {
        id: match?.[2] || 'unknown',
        text: '',
        author: match?.[1] || '',
        hasVideo: false,
        url: req.body.url,
        parseError: error.message
      }
    });
  }
});

// ─── Generic Web Page Parse (Threads / Blog / News) ──────────
app.post('/api/web/parse', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: '缺少 URL' });

    console.log(`[web/parse] Parsing URL: ${url}`);
    const isThreads = /threads\.net/i.test(url);

    let pageTitle = '';
    let pageAuthor = '';
    let pageDescription = '';
    let pageText = '';
    let pageSiteName = '';
    let pagePublishedDate = '';
    let pageImages = [];

    // ─── Threads: try specific approach first ───
    if (isThreads) {
      // Try fetching with a mobile UA for better Threads scraping
      try {
        const threadsRes = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
          },
          redirect: 'follow',
          timeout: 20000
        });

        if (threadsRes.ok) {
          const html = await threadsRes.text();

          // Extract from meta tags (Threads embeds content in OG)
          const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i);
          const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
          const ogSite = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i);
          const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i);
          const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);

          if (ogTitle) pageTitle = ogTitle[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
          if (ogDesc) pageDescription = ogDesc[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
          if (ogSite) pageSiteName = ogSite[1];
          if (!pageSiteName) pageSiteName = 'Threads';
          if (ogImage) pageImages.push(ogImage[1].replace(/&amp;/g, '&'));

          // Try to extract author from title (Threads format: "@user on Threads")
          if (pageTitle) {
            const authorMatch = pageTitle.match(/^@?(\S+)\s+(?:on|在)\s*Threads/i);
            if (authorMatch) pageAuthor = `@${authorMatch[1]}`;
          }

          // Extract from JSON-LD structured data
          const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
          for (const m of jsonLdMatches) {
            try {
              const ld = JSON.parse(m[1]);
              if (ld.articleBody) pageText = ld.articleBody;
              if (ld.text) pageText = ld.text;
              if (ld.description && !pageDescription) pageDescription = ld.description;
              if (ld.author) {
                const author = typeof ld.author === 'string' ? ld.author : (ld.author.name || ld.author.identifier || '');
                if (author) pageAuthor = author;
              }
              if (ld.datePublished) pagePublishedDate = ld.datePublished;
            } catch {}
          }

          // If still no text, use description as fallback
          if (!pageText && pageDescription) {
            pageText = pageDescription;
          }

          // Extract from page content as last resort
          if (!pageText) {
            // Try to get text from the main content area
            let bodyText = html
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
              .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
              .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
              .replace(/<[^>]*>/g, ' ')
              .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (bodyText.length > 50) {
              pageText = bodyText.substring(0, 5000);
            }
          }

          console.log(`[web/parse] Threads parse: title="${pageTitle}", author="${pageAuthor}", textLen=${pageText.length}`);
        }
      } catch (e) {
        console.log(`[web/parse] Threads fetch error: ${e.message}`);
      }
    }

    // ─── Generic Web Page parsing ───
    if (!pageText) {
      try {
        const pageRes = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
          },
          redirect: 'follow',
          timeout: 20000
        });

        if (!pageRes.ok) {
          throw new Error(`HTTP ${pageRes.status}`);
        }

        const contentType = pageRes.headers.get('content-type') || '';
        if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
          throw new Error('此 URL 不是 HTML 網頁');
        }

        const html = await pageRes.text();

        // ── Extract metadata ──
        const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i);
        const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["']/i);
        const ogSite = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i);
        const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i);
        const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i);
        const metaAuthor = html.match(/<meta[^>]*name=["']author["'][^>]*content=["']([^"']*)["']/i);
        const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const articleDatePub = html.match(/<meta[^>]*(?:property=["']article:published_time["']|name=["']publish[_-]?date["'])[^>]*content=["']([^"']*)["']/i);

        pageTitle = (ogTitle ? ogTitle[1] : (titleTag ? titleTag[1] : '')).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
        pageDescription = (ogDesc ? ogDesc[1] : (metaDesc ? metaDesc[1] : '')).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
        if (ogSite) pageSiteName = ogSite[1].trim();
        if (metaAuthor) pageAuthor = metaAuthor[1].trim();
        if (articleDatePub) pagePublishedDate = articleDatePub[1].trim();
        if (ogImage) pageImages.push(ogImage[1].replace(/&amp;/g, '&'));

        // ── Extract from JSON-LD structured data ──
        const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
        for (const m of jsonLdMatches) {
          try {
            let ld = JSON.parse(m[1]);
            // Handle @graph arrays
            if (ld['@graph']) ld = ld['@graph'].find(item => item['@type'] === 'Article' || item['@type'] === 'NewsArticle' || item['@type'] === 'BlogPosting') || ld;
            if (ld.articleBody && ld.articleBody.length > (pageText?.length || 0)) {
              pageText = ld.articleBody;
            }
            if (ld.text && ld.text.length > (pageText?.length || 0)) {
              pageText = ld.text;
            }
            if (ld.headline && !pageTitle) pageTitle = ld.headline;
            if (ld.author && !pageAuthor) {
              const author = typeof ld.author === 'string' ? ld.author : (Array.isArray(ld.author) ? ld.author.map(a => a.name || a).join(', ') : (ld.author.name || ''));
              if (author) pageAuthor = author;
            }
            if (ld.datePublished && !pagePublishedDate) pagePublishedDate = ld.datePublished;
            if (ld.publisher && ld.publisher.name && !pageSiteName) pageSiteName = ld.publisher.name;
          } catch {}
        }

        // ── Extract article text from HTML ──
        if (!pageText || pageText.length < 100) {
          // Strategy 1: Try <article> tag
          const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
          // Strategy 2: Try main content area
          const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
          // Strategy 3: Try common content selectors via class/id patterns
          const contentMatch = html.match(/<div[^>]*(?:class|id)=["'][^"']*(?:article|content|post|entry|story|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);

          let rawContent = '';
          if (articleMatch) {
            rawContent = articleMatch[1];
          } else if (mainMatch) {
            rawContent = mainMatch[1];
          } else if (contentMatch) {
            rawContent = contentMatch[1];
          }

          if (rawContent) {
            // Extract text from HTML
            let extractedText = rawContent
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, '') // remove figures
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/p>/gi, '\n\n')
              .replace(/<\/h[1-6]>/gi, '\n\n')
              .replace(/<\/li>/gi, '\n')
              .replace(/<li[^>]*>/gi, '- ')
              .replace(/<\/blockquote>/gi, '\n')
              .replace(/<blockquote[^>]*>/gi, '> ')
              .replace(/<[^>]*>/g, '')
              .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
              .replace(/\n{3,}/g, '\n\n')
              .trim();

            if (extractedText.length > (pageText?.length || 0)) {
              pageText = extractedText;
            }
          }
        }

        // ── Fallback: full body text extraction ──
        if (!pageText || pageText.length < 100) {
          let bodyText = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
            .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
            .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
            .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<\/h[1-6]>/gi, '\n\n')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (bodyText.length > (pageText?.length || 0) && bodyText.length > 50) {
            pageText = bodyText;
          }
        }

        // ── Limit text length to avoid LLM overload ──
        if (pageText && pageText.length > 8000) {
          pageText = pageText.substring(0, 8000) + '\n\n[... 內容已截斷 ...]';
        }

        // ── Infer site name from URL if missing ──
        if (!pageSiteName) {
          try {
            const hostname = new URL(url).hostname.replace(/^www\./, '');
            pageSiteName = hostname;
          } catch {}
        }

        console.log(`[web/parse] Generic parse: title="${pageTitle}", author="${pageAuthor}", site="${pageSiteName}", textLen=${(pageText || '').length}`);
      } catch (e) {
        console.error(`[web/parse] Fetch error: ${e.message}`);
        throw new Error(`網頁擷取失敗: ${e.message}`);
      }
    }

    res.json({
      success: true,
      page: {
        title: pageTitle || '',
        author: pageAuthor || '',
        description: pageDescription || '',
        text: pageText || '',
        siteName: pageSiteName || '',
        publishedDate: pagePublishedDate || '',
        images: [...new Set(pageImages)],
        url
      }
    });
  } catch (error) {
    console.error('[web/parse] Error:', error.message);
    res.status(500).json({ error: `網頁解析失敗: ${error.message}` });
  }
});

// ─── Download Video (yt-dlp) — 支援 X / Instagram / YouTube 等 ──
// 偵測平台並套用對應 cookie
function buildCookieArgs(url, settings) {
  const isX = /x\.com|twitter\.com/.test(url);
  if (isX && settings.xCookie) {
    const cookieFile = path.join(DATA_DIR, 'x_cookies.txt');
    fs.writeFileSync(cookieFile, convertCookieToNetscape(settings.xCookie), 'utf-8');
    return `--cookies "${cookieFile}"`;
  }
  // Instagram: yt-dlp 可透過 cookies-from-browser 或 cookie file
  // 若未設置 IG cookie 則直接嘗試（公開貼文可無 cookie 下載）
  if (/instagram\.com/.test(url) && settings.igCookie) {
    const cookieFile = path.join(DATA_DIR, 'ig_cookies.txt');
    fs.writeFileSync(cookieFile, convertCookieToNetscape(url.includes('instagram') ? settings.igCookie : '', '.instagram.com'), 'utf-8');
    return `--cookies "${cookieFile}"`;
  }
  return '';
}

// quality: 'best' | '1080' | '720' | '480' | '360'
function buildFormatArg(quality) {
  switch (quality) {
    case '1080': return '-f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"';
    case '720':  return '-f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best"';
    case '480':  return '-f "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best"';
    case '360':  return '-f "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360]/best"';
    default:     return '-f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"';
  }
}

app.post('/api/x/download-video', async (req, res) => {
  try {
    const { url, quality = 'best' } = req.body;
    if (!url) return res.status(400).json({ error: '缺少 URL' });

    // ── 產生安全的檔案 ID ──
    // X: 用 status ID；IG: 用 shortcode；其他: timestamp
    let videoId;
    const xMatch = url.match(/status\/(\d+)/);
    const igMatch = url.match(/(?:instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+))/);
    if (xMatch)    videoId = xMatch[1];
    else if (igMatch) videoId = `ig_${igMatch[1]}`;
    else           videoId = `vid_${Date.now()}`;

    // 畫質後綴 (同一影片不同畫質分開存)
    const qualitySuffix = quality !== 'best' ? `_${quality}p` : '';
    const fileBase = `${videoId}${qualitySuffix}`;
    const outputPath = path.join(VIDEOS_DIR, `${fileBase}.mp4`);
    const metaPath   = path.join(VIDEOS_DIR, `${fileBase}.meta.json`);
    const settings   = getSettings();

    // ── 已下載過則直接回傳 ──
    if (fs.existsSync(outputPath)) {
      if (!fs.existsSync(metaPath)) { fs.writeFileSync(metaPath, JSON.stringify({ url, quality }), 'utf8'); }
      return res.json({ success: true, filename: `${fileBase}.mp4`, path: `/api/videos/${fileBase}.mp4`, quality });
    }

    const ytDlp = getYtDlpPath();
    const cookieArgs = buildCookieArgs(url, settings);
    const formatArg  = buildFormatArg(quality);

    const cmd = `"${ytDlp}" ${cookieArgs} ${formatArg} --merge-output-format mp4 --no-playlist -o "${outputPath}" "${url}"`;
    console.log(`[download] cmd: ${cmd.replace(/--cookies "[^"]+"/, '--cookies <hidden>')}`);

    // Use async exec to avoid blocking event loop & allow longer timeout (10 min)
    await new Promise((resolve, reject) => {
      const child = exec(cmd, { encoding: 'utf-8', timeout: 600000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          // Provide a cleaner error message for timeout
          if (error.killed && error.signal === 'SIGTERM') {
            reject(new Error('下載超時（超過 10 分鐘），請嘗試較低畫質或檢查網路連線'));
          } else {
            reject(error);
          }
        } else {
          resolve(stdout);
        }
      });
      // Log yt-dlp progress to console
      if (child.stderr) {
        child.stderr.on('data', (data) => {
          const line = data.toString().trim();
          if (line) console.log(`[yt-dlp] ${line}`);
        });
      }
    });

    if (fs.existsSync(outputPath)) {
      fs.writeFileSync(metaPath, JSON.stringify({ url, quality }), 'utf8');
      res.json({ success: true, filename: `${fileBase}.mp4`, path: `/api/videos/${fileBase}.mp4`, quality });
    } else {
      // 有時 yt-dlp 輸出非 .mp4（罕見），掃描找檔案
      const files = fs.readdirSync(VIDEOS_DIR).filter(f => f.startsWith(fileBase) && !f.endsWith('.meta.json'));
      if (files.length > 0) {
        const returnedFile = files[0];
        const baseName = returnedFile.replace(/\.[^/.]+$/, '');
        fs.writeFileSync(path.join(VIDEOS_DIR, `${baseName}.meta.json`), JSON.stringify({ url, quality }), 'utf8');
        res.json({ success: true, filename: returnedFile, path: `/api/videos/${returnedFile}`, quality });
      } else {
        throw new Error('影片下載失敗，請確認連結是否有效或嘗試其他畫質');
      }
    }
  } catch (error) {
    console.error('Download error:', error.message);
    const friendly = error.message.includes('yt-dlp') ? error.message
      : error.message.includes('429') ? '下載次數過多，請稍後再試'
      : error.message.includes('Private') || error.message.includes('private') ? '此影片為私人內容，請確認登入狀態'
      : `下載失敗: ${error.message.split('\n')[0]}`;
    res.status(500).json({ error: friendly });
  }
});

// ─── IG Cookie 設定 API ───────────────────────────────────────
// (igCookie 欄位沿用 settings 機制，在此提供路由供 frontend 存取)
// igCookie 已自動合併到 /api/settings POST，不需額外路由

// ─── Serve Videos ────────────────────────────────────────────
app.use('/api/videos', express.static(VIDEOS_DIR));

app.get('/api/videos/list', (req, res) => {
  try {
    const files = fs.readdirSync(VIDEOS_DIR)
      .filter(f => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mkv'))
      .map(f => {
        const stats = fs.statSync(path.join(VIDEOS_DIR, f));
        const baseName = f.replace(/\.[^/.]+$/, '');
        const metaPath = path.join(VIDEOS_DIR, `${baseName}.meta.json`);
        let originalUrl = '';
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            originalUrl = meta.url || '';
          } catch (e) { }
        }
        return {
          filename: f,
          path: `/api/videos/${f}`,
          createdAt: stats.birthtime, // Use creation or modification time
          size: stats.size,
          url: originalUrl
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);

    res.json({ success: true, videos: files });
  } catch (error) {
    console.error('List videos error:', error.message);
    res.status(500).json({ error: '無法讀取影片清單' });
  }
});

app.post('/api/videos/rename', (req, res) => {
  try {
    const { oldFilename, newTitle } = req.body;
    if (!oldFilename || !newTitle) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    // Create safe filename from the title
    const safeTitle = newTitle.replace(/[/\\?%*:|"<>]/g, '-').trim();
    if (!safeTitle) return res.status(400).json({ error: 'Invalid title' });

    const ext = path.extname(oldFilename);
    const newFilename = `${safeTitle}${ext}`;

    const oldPath = path.join(VIDEOS_DIR, oldFilename);
    const newPath = path.join(VIDEOS_DIR, newFilename);

    if (fs.existsSync(oldPath)) {
      if (oldPath !== newPath) {
        fs.renameSync(oldPath, newPath);
        // Also try to rename matching .wav if present
        const oldBase = oldPath.replace(/\.[^/.]+$/, '');
        const newBase = newPath.replace(/\.[^/.]+$/, '');
        if (fs.existsSync(`${oldBase}.wav`)) fs.renameSync(`${oldBase}.wav`, `${newBase}.wav`);
        if (fs.existsSync(`${oldBase}.meta.json`)) fs.renameSync(`${oldBase}.meta.json`, `${newBase}.meta.json`);
      }
      res.json({ success: true, newFilename, newPath: `/api/videos/${newFilename}` });
    } else {
      res.status(404).json({ error: 'Video file not found' });
    }
  } catch (error) {
    console.error('Rename error:', error.message);
    res.status(500).json({ error: '重新命名影片失敗: ' + error.message });
  }
});

app.delete('/api/videos/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    if (!filename || filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const videoPath = path.join(VIDEOS_DIR, filename);
    const baseName = videoPath.replace(/\.[^/.]+$/, '');
    
    if (fs.existsSync(videoPath)) {
      fs.unlinkSync(videoPath);
      if (fs.existsSync(`${baseName}.wav`)) fs.unlinkSync(`${baseName}.wav`);
      if (fs.existsSync(`${baseName}.meta.json`)) fs.unlinkSync(`${baseName}.meta.json`);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Video file not found' });
    }
  } catch (error) {
    console.error('Delete video error:', error.message);
    res.status(500).json({ error: '刪除影片失敗: ' + error.message });
  }
});

// ─── Serve Audio ─────────────────────────────────────────────
app.use('/api/audio', express.static(AUDIO_DIR));

// ─── Whisper Transcription ───────────────────────────────────
app.post('/api/whisper/transcribe', async (req, res) => {
  try {
    const { videoPath } = req.body;
    if (!videoPath) return res.status(400).json({ error: '缺少影片路徑' });

    const settings = getSettings();
    const fullPath = path.join(VIDEOS_DIR, path.basename(videoPath));

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: '找不到影片檔案' });
    }

    // Extract audio from video first
    const audioPath = fullPath.replace(/\.[^/.]+$/, '.wav');
    try {
      execSync(`ffmpeg -i "${fullPath}" -ar 16000 -ac 1 -y "${audioPath}"`, { timeout: 120000 });
    } catch (e) {
      console.error('FFmpeg error:', e.message);
    }

    const audioFile = fs.existsSync(audioPath) ? audioPath : fullPath;

    const whisperBase = (settings.whisperUrl || 'http://localhost:8080').replace(/\/$/, '');

    // Try multiple common endpoints for Whisper API wrappers
    const endpoints = [
      '/v1/audio/transcriptions', // OpenAI standard
      '/inference',               // whisper.cpp server
      '/transcribe',              // common flask wrappers
      '/asr',                     // whisper-asr-webservice
      '/api/transcribe',
      '/'                         // some root endpoints
    ];

    let lastData = null;
    let errorLog = [];
    let success = false;

    for (const endpoint of endpoints) {
      const fullEndpointUrl = `${whisperBase}${endpoint}`;
      const form = new FormData();
      // append the file stream and explicitly supply the filename string to ensure flask reads it as a file upload correctly
      form.append('file', fs.createReadStream(audioFile), { filename: path.basename(audioFile) });
      form.append('response_format', 'json');

      try {
        const res = await fetch(fullEndpointUrl, {
          method: 'POST',
          body: form,
          headers: form.getHeaders(),
          timeout: 120000 // Give whisper some time to process
        });

        if (res.ok) {
          lastData = await res.json();
          success = true;
          break; // Found working endpoint
        } else {
          const errText = await res.text().catch(() => '');
          errorLog.push(`[${fullEndpointUrl} 回傳 ${res.status}] ${errText.substring(0, 50)}`);
        }
      } catch (e) {
        errorLog.push(`[${fullEndpointUrl} 錯誤] ${e.message}`);
      }
    }

    if (!success) {
      throw new Error(`連線失敗或找不到正確的路徑。日誌: ${errorLog.join(' | ')}`);
    }

    const text = lastData.text || lastData.transcription || lastData.result || '';
    if (!text && lastData) {
      console.log('Warn: whisper parsed blank, lastData keys:', Object.keys(lastData));
    }

    res.json({ success: true, text: text });
  } catch (error) {
    console.error('Whisper error:', error.message);
    res.status(500).json({ error: `轉錄失敗: ${error.message}` });
  }
});

// ─── Gemini Models List ──────────────────────────────────────
app.get('/api/gemini/models', async (req, res) => {
  try {
    const settings = getSettings();
    if (!settings.geminiApiKey) return res.status(400).json({ error: '請先設定 Gemini API Key' });

    const apiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${settings.geminiApiKey}&pageSize=100`
    );

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      throw new Error(`Gemini API 錯誤: ${apiRes.status} - ${errText}`);
    }

    const data = await apiRes.json();
    const models = (data.models || [])
      .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => ({
        id: m.name.replace('models/', ''),
        displayName: m.displayName || m.name.replace('models/', ''),
        description: m.description || ''
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    res.json({ success: true, models });
  } catch (error) {
    console.error('Gemini models list error:', error.message);
    res.status(500).json({ error: `取得模型列表失敗: ${error.message}` });
  }
});

// ─── Gemini Summarize ────────────────────────────────────────
app.post('/api/gemini/summarize', async (req, res) => {
  try {
    const { content, type } = req.body;
    if (!content) return res.status(400).json({ error: '缺少內容' });

    const settings = getSettings();
    if (!settings.geminiApiKey) return res.status(400).json({ error: '請先設定 Gemini API Key' });

    const systemInstruction = `你是專業筆記整理助手。將使用者提供的原始內容整理成結構化的繁體中文筆記。

規則：
- 只輸出最終整理好的筆記，不要輸出思考過程、自我檢查、修正紀錄。
- 全部使用台灣繁體中文用語（影片、軟體、智慧、資訊、連結、資料夾）。
- 不要捏造原文沒有的資訊。
- 不要用 markdown code blocks 包裹輸出。
- 不要輸出任何英文的自我檢查清單 (如 "Check:", "Self-Correction", "Final check")。

輸出格式（嚴格遵守此順序）：
第一行：###### tags: 標籤1 標籤2 標籤3
第二行：# 主標題
接下來：
## 執行摘要
（一段總結）
## 核心要點
（條列式重點）
## 詳細內容
（依主題分段說明）`;

    const userPrompt = type === 'podcast'
      ? req.body.prompt
      : `請將以下內容整理成繁體中文結構化筆記：

${content}`;

    const model = settings.geminiModel || 'gemma-4-26b-a4b-it';
    const FALLBACK_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-1.5-flash'];

    // Build request body for a given model
    function buildRequestBody(targetModel) {
      const isGemma = targetModel.toLowerCase().includes('gemma');
      return {
        ...(isGemma ? {} : { system_instruction: { parts: [{ text: systemInstruction }] } }),
        contents: [{ role: 'user', parts: [{ text: isGemma ? systemInstruction + '\n\n' + userPrompt : userPrompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 }
      };
    }

    // Try a model with retries, returns { data, usedModel } or throws
    async function tryModelWithRetries(targetModel, maxRetries = 3) {
      const body = buildRequestBody(targetModel);
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${settings.geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          }
        );

        if (res.ok) {
          return { data: await res.json(), usedModel: targetModel };
        }

        const errText = await res.text();
        const isServerError = res.status === 500 || res.status === 503;
        const isRateLimit = res.status === 429;
        const isRetryable = isServerError || isRateLimit;

        if (isRetryable && attempt < maxRetries) {
          // For 429, try to parse the API-suggested retry delay
          let delayMs = Math.pow(2, attempt - 1) * 1000;
          if (isRateLimit) {
            try {
              const errObj = JSON.parse(errText);
              const retryInfo = errObj?.error?.details?.find(d => d['@type']?.includes('RetryInfo'));
              if (retryInfo?.retryDelay) {
                const secs = parseInt(retryInfo.retryDelay);
                if (secs > 0) delayMs = (secs + 2) * 1000; // add 2s buffer
              }
            } catch (e) { /* ignore parse error */ }
          }
          console.log(`[gemini-retry] ${targetModel} 第 ${attempt}/${maxRetries} 次失敗 (${res.status})，${delayMs/1000}s 後重試...`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }

        // Non-retryable or last attempt
        throw { status: res.status, text: errText, isRetryable };
      }
    }

    // ── Ollama chunked summarization (for small local models) ──
    async function summarizeWithOllama(inputContent) {
      const ollamaUrl = 'http://localhost:11434';
      const ollamaModel = 'gemma3:270m';
      console.log(`[ollama-fallback] 使用本地 Ollama (${ollamaModel}) 進行分段摘要...`);

      // Split content into ~1000 char chunks at sentence boundaries
      const MAX_CHUNK = 1000;
      const chunks = [];
      const sentences = inputContent.split(/(?<=[。！？\.\!\?\n])\s*/);
      let currentChunk = '';
      for (const s of sentences) {
        if (currentChunk.length + s.length > MAX_CHUNK && currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = s;
        } else {
          currentChunk += s;
        }
      }
      if (currentChunk.trim()) chunks.push(currentChunk.trim());

      console.log(`[ollama-fallback] 分為 ${chunks.length} 段進行摘要`);

      // Summarize each chunk
      const chunkSummaries = [];
      for (let i = 0; i < chunks.length; i++) {
        console.log(`[ollama-fallback] 處理第 ${i + 1}/${chunks.length} 段 (${chunks[i].length} 字)...`);
        const chunkPrompt = `請用繁體中文簡要摘要以下內容的重點，不要加入任何額外說明：\n\n${chunks[i]}`;
        try {
          const ollamaRes = await fetch(`${ollamaUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: ollamaModel,
              prompt: chunkPrompt,
              stream: false,
              options: { temperature: 0.3, num_predict: 512 }
            })
          });
          if (!ollamaRes.ok) throw new Error(`Ollama ${ollamaRes.status}`);
          const ollamaData = await ollamaRes.json();
          const summary = ollamaData.response?.trim();
          if (summary) chunkSummaries.push(summary);
        } catch (chunkErr) {
          console.log(`[ollama-fallback] 第 ${i + 1} 段失敗: ${chunkErr.message}`);
          // Still continue with other chunks
        }
      }

      if (chunkSummaries.length === 0) {
        throw new Error('Ollama 本地模型也無法處理，請確認 Ollama 是否正在運行');
      }

      // Final merge: combine chunk summaries into structured note
      const mergedContent = chunkSummaries.join('\n\n');
      console.log(`[ollama-fallback] 合併 ${chunkSummaries.length} 段摘要，生成最終筆記...`);

      const finalPrompt = `你是筆記整理助手。請將以下分段摘要合併整理成一篇完整的繁體中文結構化筆記。

格式要求（嚴格遵守）：
第一行：###### tags: 標籤1 標籤2 標籤3
第二行：# 主標題
然後：
## 執行摘要
（一段總結）
## 核心要點
（條列式重點）
## 詳細內容
（分段說明）

以下是分段摘要：

${mergedContent}`;

      const finalRes = await fetch(`${ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ollamaModel,
          prompt: finalPrompt,
          stream: false,
          options: { temperature: 0.3, num_predict: 2048 }
        })
      });

      if (!finalRes.ok) throw new Error(`Ollama 最終合併失敗: ${finalRes.status}`);
      const finalData = await finalRes.json();
      return finalData.response?.trim() || mergedContent;
    }

    // Primary model → Gemini fallbacks → Ollama local fallback
    let data, usedModel;
    let text; // declare here for Ollama path
    try {
      ({ data, usedModel } = await tryModelWithRetries(model));
    } catch (primaryErr) {
      if (primaryErr.isRetryable) {
        let fallbackSuccess = false;
        for (const fb of FALLBACK_MODELS) {
          if (fb === model) continue;
          console.log(`[gemini-fallback] ${model} 持續失敗，嘗試備用模型 ${fb}...`);
          try {
            ({ data, usedModel } = await tryModelWithRetries(fb, 2));
            console.log(`[gemini-fallback] ✅ ${fb} 成功`);
            fallbackSuccess = true;
            break;
          } catch (fbErr) {
            console.log(`[gemini-fallback] ❌ ${fb} 也失敗 (${fbErr.status})`);
          }
        }
        if (!fallbackSuccess) {
          // Ultimate fallback: local Ollama
          console.log('[gemini-fallback] 所有 Gemini 模型均失敗，嘗試本地 Ollama...');
          try {
            const ollamaResult = await summarizeWithOllama(userPrompt);
            data = null; // signal that we used Ollama
            usedModel = 'ollama:gemma3:270m';
            text = ollamaResult; // directly set text, skip Gemini data extraction
          } catch (ollamaErr) {
            throw new Error(`所有模型均失敗 — Gemini API: ${primaryErr.status}, Ollama: ${ollamaErr.message}`);
          }
        }
      } else {
        throw new Error(`Gemini API 錯誤: ${primaryErr.status} - ${primaryErr.text}`);
      }
    }

    // Extract text from Gemini response (skip if Ollama already set text)
    if (data) {
      text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
    if (usedModel !== model) {
      console.log(`[fallback] 使用備用模型 ${usedModel} 產出`);
    }

    console.log('[gemini-raw] 原始輸出長度:', text.length, '前 500 字:', text.substring(0, 500));

    // ── Step 1: Strip code blocks ──
    text = text.replace(/^```[a-zA-Z]*\s*\n?/gm, '').replace(/\n?```\s*$/gm, '').trim();
    if (text.startsWith('```') && text.endsWith('```')) {
      text = text.slice(3).slice(0, -3).replace(/^[a-zA-Z]*\s*\n?/, '').trim();
    }

    // ── Step 2: Smart extraction — find the structured Chinese content block ──
    // Gemma models often output: junk preamble → English outline → Chinese structured notes
    // Strategy: find the LAST occurrence of "## 執行摘要" or "## 核心要點" or similar Chinese headers
    // and work backwards to find the tags/title that belongs to it
    {
      // Look for the structured Chinese section markers
      const sectionMarkers = [
        /^#{1,6}\s*(?:tags|標籤):\s*.+/gim,  // tags line
        /^##\s*執行摘要/gm,
        /^##\s*核心要點/gm,
        /^##\s*詳細內容/gm,
        /^##\s*摘要/gm,
        /^##\s*重點/gm,
      ];

      // Find the last tags line that is followed by Chinese content
      const allTagsPositions = [...text.matchAll(/^#{1,6}\s*(?:tags|標籤):\s*.+$/gim)];
      const allChineseTitlePositions = [...text.matchAll(/^#\s+[\u4e00-\u9fa5].*$/gm)];

      if (allTagsPositions.length > 0) {
        // Find the best tags line: prefer the one closest before a Chinese title
        let bestTagsIdx = allTagsPositions.length - 1; // default: last
        for (let t = allTagsPositions.length - 1; t >= 0; t--) {
          const tagsPos = allTagsPositions[t].index;
          // Check if there's a Chinese title after this tags line
          const hasChineseTitleAfter = allChineseTitlePositions.some(m => m.index > tagsPos && m.index - tagsPos < 200);
          if (hasChineseTitleAfter) {
            bestTagsIdx = t;
            break;
          }
        }
        const bestTagsMatch = allTagsPositions[bestTagsIdx];
        if (bestTagsMatch && bestTagsMatch.index > 0) {
          console.log(`[post-process] 找到最佳 tags 行位置: ${bestTagsMatch.index}，截取後續內容`);
          text = text.slice(bestTagsMatch.index).trim();
        }
      }
    }

    // ── Step 3: Remove model thinking / self-check / prompt echo ──
    // Remove entire blocks of English-language thinking, self-checks, and compliance checklists
    text = text
      // Prompt instruction echoes
      .replace(/^\s*Structured Traditional Chinese.*$/gm, '')
      .replace(/^\s*\*\s+Only output the final note.*$/gm, '')
      .replace(/^\s*\*\s+Use Taiwan Traditional Chinese.*$/gm, '')
      .replace(/^\s*\*\s+Do not (?:fabricate|use markdown|output).*$/gm, '')
      // Numbered format echoes (e.g., "3.  `## 執行摘要` (Summary paragraph)")
      .replace(/^\s*\d+\.\s+`[#].*?`\s*\(.*?\)\s*$/gm, '')
      .replace(/^\s*\d+\.\s+`[#].*?`\s*$/gm, '')
      // Self-check lines
      .replace(/^\s*\*?\s*\*?(?:Check|Self[- ]?Correct|Final (?:Polish|check)|Ready to output|Wait,).*$/gim, '')
      .replace(/^\s*\(.*?(?:Self-Correction|drafting|polish|Ready to output).*?\)\s*$/gim, '')
      // English outline items (lines starting with * followed by English italic labels)
      .replace(/^\s*\*\s+\*(?:Core Problem|The Flaw|The Solution|The Four-Layer|The Role of AI|The Key File|The Outcome|The Competitive|Actionable Advice|Summary|Core Points|Detailed Content|Tags|Title):?\*.*$/gm, '')
      // Numbered English items within outlines
      .replace(/^\s+\d+\.\s+(?:Capture|Automation|Memory|Intelligence)\s*\(.*?\)\.?$/gm, '')
      // Remove leaked prompt keywords
      .replace(/\[TASK INSTRUCTIONS\][\s\S]*?\[RAW CONTENT\]/gi, '')
      .replace(/\[TASK INSTRUCTIONS\]/gi, '')
      .replace(/\[RAW CONTENT\]/gi, '')
      .replace(/STRICT RULES?\s*\(MUST FOLLOW\)/gi, '')
      .replace(/FORMAT PIPELINE:?/gi, '')
      .replace(/professional note-taking assistant/gi, '')
      .replace(/STRICT OUTPUT RESTRICTION/gi, '')
      .replace(/----- SOURCE (?:START|END) -----/g, '')
      .replace(/^.*?LANGUAGE RESTRICTION.*$/gm, '')
      .replace(/^.*?NO HALLUCINATION.*$/gm, '');

    // ── Step 4: Remove any remaining pure-English paragraphs/lines ──
    // Split into lines and remove lines that are predominantly English (no Chinese chars)
    // BUT keep lines that are markdown headers with Chinese, or lines with significant Chinese
    {
      const lines = text.split('\n');
      const cleaned = [];
      let inEnglishBlock = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Always keep empty lines (they're just spacing)
        if (!trimmed) {
          if (!inEnglishBlock) cleaned.push(line);
          continue;
        }

        // Always keep HedgeDoc tags line
        if (/^#{1,6}\s*(?:tags|標籤):/i.test(trimmed)) {
          inEnglishBlock = false;
          cleaned.push(line);
          continue;
        }

        // Count Chinese vs total characters
        const chineseChars = (trimmed.match(/[\u4e00-\u9fa5]/g) || []).length;
        const totalChars = trimmed.replace(/\s/g, '').length;
        const chineseRatio = totalChars > 0 ? chineseChars / totalChars : 0;

        // Lines with reasonable Chinese content — keep
        if (chineseChars >= 2 || chineseRatio > 0.15) {
          inEnglishBlock = false;
          cleaned.push(line);
          continue;
        }

        // Keep markdown formatting lines (##, -, **) only if they contain Chinese
        if (/^#{1,3}\s/.test(trimmed) || /^\*\*/.test(trimmed) || /^-\s/.test(trimmed)) {
          if (chineseChars > 0) {
            inEnglishBlock = false;
            cleaned.push(line);
          } else {
            inEnglishBlock = true; // Start of English block
          }
          continue;
        }

        // Pure English or non-Chinese line — skip
        if (chineseChars === 0 && /[a-zA-Z]/.test(trimmed)) {
          inEnglishBlock = true;
          continue;
        }

        // Lines with special chars, numbers, etc. — keep if short or has some Chinese
        if (chineseChars > 0 || (!trimmed.match(/[a-zA-Z]{3,}/) && trimmed.length < 10)) {
          cleaned.push(line);
        }
      }
      text = cleaned.join('\n');
    }

    // ── Step 5: Clean up ──
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    if (text.includes('⚠️ 原始內容不足，無法生成完整筆記。')) {
      throw new Error('原始內容不足，無法生成完整筆記。');
    }

    // ── Step 6: Quality check with auto-fix ──
    let hasTags = /^#{1,6}\s*(?:tags|標籤):\s*.+/im.test(text);
    let hasTitle = false;
    const textLines = text.split('\n');
    for (const line of textLines) {
      const trimmed = line.trim();
      if (/^#{1,3}\s+[\u4e00-\u9fa5].+/.test(trimmed) && !/tags:/i.test(trimmed) && !/標籤:/i.test(trimmed)) {
        hasTitle = true;
        break;
      }
    }

    const chineseCharCount = (text.match(/[\u4e00-\u9fa5]/g) || []).length;

    if (chineseCharCount < 10) {
      console.log('[quality-check] 中文字數過少:', chineseCharCount, '原始輸出:', text.substring(0, 300));
      throw new Error(`生成品質未達要求 (中文內容過少或未正確轉換，僅 ${chineseCharCount} 字)`);
    }

    // Auto-fix: tags — extract meaningful Chinese keywords from ## headers
    if (!hasTags) {
      console.log('[auto-fix] 缺少 tags 行，自動補充');
      // Try to extract tags from ## section headers first
      const sectionHeaders = text.match(/^##\s+([\u4e00-\u9fa5].+)$/gm) || [];
      let autoTagWords = [];
      if (sectionHeaders.length > 0) {
        // Extract 2-4 char words from section headers
        for (const h of sectionHeaders) {
          const words = h.replace(/^##\s+/, '').match(/[\u4e00-\u9fa5]{2,4}/g) || [];
          autoTagWords.push(...words);
        }
      }
      if (autoTagWords.length === 0) {
        autoTagWords = (text.match(/[\u4e00-\u9fa5]{2,4}/g) || []);
      }
      const uniqueWords = [...new Set(autoTagWords)].slice(0, 3);
      const autoTags = uniqueWords.length > 0 ? uniqueWords.join(' ') : '筆記';
      text = `###### tags: ${autoTags}\n${text}`;
    }

    // Auto-fix: Chinese title
    if (!hasTitle) {
      console.log('[auto-fix] 缺少中文主標題行，自動補充');
      const contentLines = text.split('\n');
      let titleText = '';
      // Try to find a suitable Chinese title from the content
      for (let i = 0; i < contentLines.length; i++) {
        const trimmed = contentLines[i].trim();
        if (!trimmed || /^#+\s*(?:tags|標籤):/i.test(trimmed)) continue;
        const chCount = (trimmed.match(/[\u4e00-\u9fa5]/g) || []).length;
        if (chCount >= 3) {
          titleText = trimmed
            .replace(/^[#*\->\s]+/, '')
            .replace(/[*_`]/g, '')
            .replace(/^\*\*(.+)\*\*$/, '$1')
            .substring(0, 60);
          const tagsIdx = contentLines.findIndex(l => /^#+\s*(?:tags|標籤):/i.test(l.trim()));
          const insertIdx = tagsIdx >= 0 ? tagsIdx + 1 : 0;
          contentLines.splice(insertIdx, 0, `# ${titleText}`);
          text = contentLines.join('\n');
          break;
        }
      }
      if (!titleText) {
        text = text.replace(/^(#{1,6}\s*(?:tags|標籤):.*\n)/, '$1# 筆記整理\n');
      }
    }

    // ── Step 7: Ensure tags line is first and properly formatted for HedgeDoc ──
    const tagsMatch = text.match(/(#{1,6}\s*(?:tags|標籤):\s*)(.+)/i);
    if (tagsMatch && typeof tagsMatch.index === 'number') {
      // Cut everything before the tags line (junk preamble)
      text = text.slice(tagsMatch.index).trim();

      const newlineIndex = text.indexOf('\n');
      const firstLine = newlineIndex !== -1 ? text.substring(0, newlineIndex) : text;
      const restText = newlineIndex !== -1 ? text.substring(newlineIndex) : '';

      const prefixMatch = firstLine.match(/^(#{1,6}\s*(?:tags|標籤):\s*)/i);
      if (prefixMatch) {
        const prefix = prefixMatch[1];
        const tagsStr = firstLine.substring(prefix.length).trim();
        // Clean tags: remove #hashtag style, wrap in backticks
        const formattedTags = tagsStr
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(tag => {
            let clean = tag.replace(/^`+|`+$/g, '').replace(/^#+/, '');
            return `\`${clean}\``;
          })
          .join(' ');
        text = prefix + formattedTags + restText;
      }
    }

    // ── Step 8: Final cleanup ──
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    console.log('[gemini-clean] 清洗後長度:', text.length, '前 200 字:', text.substring(0, 200));

    res.json({ success: true, text });
  } catch (error) {
    console.error('Gemini error:', error.message);
    res.status(500).json({ error: `Gemini 處理失敗: ${error.message}` });
  }
});

// ─── HedgeDoc Create Note ────────────────────────────────────
app.post('/api/hedgedoc/create', async (req, res) => {
  try {
    const { content, title } = req.body;
    if (!content) return res.status(400).json({ error: '缺少筆記內容' });

    const settings = getSettings();
    if (!settings.hedgedocUrl) return res.status(400).json({ error: '請先設定 HedgeDoc URL' });

    const fullContent = title ? `# ${title}\n\n${content}` : content;

    const hdRes = await fetch(`${settings.hedgedocUrl}/new`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/markdown',
        'Cookie': settings.hedgedocCookie || ''
      },
      body: fullContent,
      redirect: 'manual'
    });

    // HedgeDoc redirects to the new note URL
    let noteUrl = '';
    if (hdRes.status === 302 || hdRes.status === 301) {
      noteUrl = hdRes.headers.get('location') || '';
      if (noteUrl && !noteUrl.startsWith('http')) {
        noteUrl = `${settings.hedgedocUrl}${noteUrl}`;
      }
    } else if (hdRes.ok) {
      const responseText = await hdRes.text();
      // Try to extract URL from response
      noteUrl = `${settings.hedgedocUrl}/${responseText.trim()}`;
    } else {
      throw new Error(`HedgeDoc 錯誤: ${hdRes.status}`);
    }

    // Save to notes list
    const notes = loadJSON(NOTES_FILE, []);
    const noteEntry = {
      id: Date.now().toString(),
      title: title || '未命名筆記',
      url: noteUrl,
      createdAt: new Date().toISOString(),
      sourceUrl: req.body.sourceUrl || ''
    };
    notes.unshift(noteEntry);
    saveJSON(NOTES_FILE, notes);

    res.json({ success: true, note: noteEntry });
  } catch (error) {
    console.error('HedgeDoc error:', error.message);
    res.status(500).json({ error: `HedgeDoc 建立失敗: ${error.message}` });
  }
});

// ─── HedgeDoc List Notes ─────────────────────────────────────
app.get('/api/hedgedoc/list', (req, res) => {
  const notes = loadJSON(NOTES_FILE, []);
  res.json({ success: true, notes });
});

// ─── Delete Note ─────────────────────────────────────────────
app.delete('/api/hedgedoc/notes/:id', (req, res) => {
  const notes = loadJSON(NOTES_FILE, []);
  const filtered = notes.filter(n => n.id !== req.params.id);
  saveJSON(NOTES_FILE, filtered);
  res.json({ success: true });
});

// ─── Podcast: Generate Script ────────────────────────────────
app.post('/api/podcast/generate-script', async (req, res) => {
  try {
    const { noteContents, noteTitle, language, minutes } = req.body;
    if (!noteContents) return res.status(400).json({ error: '缺少筆記內容' });

    const settings = getSettings();
    if (!settings.geminiApiKey) return res.status(400).json({ error: '請先設定 Gemini API Key' });

    const isEnglish = language === 'en';
    const numMinutes = minutes || 5;
    const targetWordCount = numMinutes * 200;
    
    // 中文內容長度加倍 (改為 4 倍)
    const cnMinutes = numMinutes * 4;
    const cnWordCount = targetWordCount * 4;

    const podcastSystemPrompt = isEnglish
      ? `You are a podcast script writer. Write a ${numMinutes}-minute two-host podcast script in English.
Hosts are Bella (host_f, female, curious and lively) and Eric (host_m, male, grounded and professional).
Make the conversation sound natural, engaging, and suitable for a ${numMinutes}-minute audio!
IMPORTANT: A normal speaking rate is about 200 words per minute. To hit the ${numMinutes}-minute mark, your script MUST contain approximately ${targetWordCount} words in total across all dialogue. Please expand on the topics, add natural banter, examples, and deep dives to reach this length without sounding repetitive.
⚠️ Output ONLY plain text in the following format. No JSON, no arrays, no code blocks (no \`\`\`), no preamble, no conclusion.
Format each line with speaker tag:
[host_f]
Hello everyone...

[host_m]
Yes, exactly...`
      : `You are an expert podcast scriptwriter. Rewrite the provided content into a ${cnMinutes}-minute two-host podcast script.
The hosts are 建國 (host_f, male, asks questions and guides the flow) and 雲健 (host_m, male, calm and professional analysis). Inject Taiwanese colloquialisms (e.g., 喔, 吧, 對啊, 其實). The goal is to deeply explore the topic, providing unique insights and inspiration to the listener.
⚠️ LANGUAGE REQUIREMENT (CRITICAL): The entire script MUST be written entirely in Traditional Chinese (繁體中文). NO mix of English! All English terminology, technical terms, and brand names must be translated or transliterated into Chinese (e.g., Machine Learning -> 機器學習, API -> 應用程式介面). DO NOT insert English words into the Chinese dialogue.
⚠️ LENGTH REQUIREMENT: Average speaking rate is 200 words/min. To ensure ${cnMinutes} minutes of audio, your script MUST reach approximately ${cnWordCount} words in total. Use examples, hypothetical scenarios, deep dives, and natural banter to significantly expand the length without being repetitive or empty.
⚠️ STRICT OUTPUT REQUIREMENT: Output ONLY plain text. NO JSON, NO arrays, NO markdown code blocks (\`\`\`). NO preamble or conclusion.
Use exactly this format, prepending the speaker tag to every single line of dialogue:
[host_f]
大家好...

[host_m]
沒錯...`;

    const podcastUserContent = `Title: ${noteTitle || 'Untitled'}
Target Language: ${isEnglish ? 'English' : 'Traditional Chinese (繁體中文)'}

Raw Content to Adapt:
${noteContents}`;

    const prompt = `[TASK INSTRUCTIONS]
${podcastSystemPrompt}

[RAW CONTENT]
${podcastUserContent}

Follow the [TASK INSTRUCTIONS] strictly. DO NOT map or translate the instructions. Generate ONLY the podcast script based on the raw content:`;

    const model = settings.geminiModel || 'gemma-4-26b-a4b-it';
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 8192 }
        })
      }
    );

    if (!geminiRes.ok) throw new Error(`Gemini API 錯誤: ${geminiRes.status}`);

    const data = await geminiRes.json();
    let script = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Clean up: remove markdown code block markers if present
    script = script.replace(/^```(?:json|python|javascript|text)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    res.json({ success: true, script });
  } catch (error) {
    console.error('Script generation error:', error.message);
    res.status(500).json({ error: `講稿生成失敗: ${error.message}` });
  }
});

// ─── Podcast: Generate Audio (Kokoro generate_podcast API) ───
app.post('/api/podcast/generate-audio', async (req, res) => {
  try {
    const { script, title, language } = req.body;
    if (!script) return res.status(400).json({ error: '缺少講稿' });

    const settings = getSettings();
    const podcastId = Date.now().toString();

    // Parse the script into a JS array from plain text format
    let scriptData = [];
    try {
      const blocks = script.split(/\[(host_[fm])\]/i);
      for (let i = 1; i < blocks.length; i += 2) {
        const speaker = blocks[i].toLowerCase();
        const text = blocks[i + 1].trim();
        if (text) {
          scriptData.push([speaker, text]);
        }
      }
    } catch (parseErr) {
      console.error('Text block parse error:', parseErr.message);
    }

    if (!scriptData || scriptData.length === 0) {
      throw new Error('無法解析純文字講稿標籤格式，請確認是否為帶有 [host_f] [host_m] 正確標註的內文');
    }

    // 根據前端傳來的 language 參數決定語音模型 (不再自動偵測中文)
    // 中文兩人皆使用男性聲音
    let voiceF = 'zm_yunxi';
    let voiceM = 'zm_yunjian';

    if (language === 'en') {
      voiceF = 'af_bella';
      voiceM = 'am_eric';
    }

    // Replace generic host tags with specific Kokoro voice IDs and strictly chunk long texts
    let processedScript = [];
    scriptData.forEach(([speaker, text]) => {
      let finalSpeaker = speaker;
      let finalVoiceEng = 'am_michael'; // Default English counterpart for host_f

      if (speaker === 'host_f') {
        finalSpeaker = voiceF;
        finalVoiceEng = voiceF === 'zm_yunxi' ? 'am_michael' : voiceF;
      } else if (speaker === 'host_m') {
        finalSpeaker = voiceM;
        finalVoiceEng = voiceM === 'zm_yunjian' ? 'am_eric' : voiceM;
      }

      // Split text by common punctuation to avoid PyTorch tensor size limits (usually >250-300 chars crashes Kokoro)
      const sentences = text.split(/(?<=[。！？；.!?;\n])\s*/).filter(s => s.trim().length > 0);

      if (language === 'en') {
        let currentChunk = '';
        sentences.forEach(sentence => {
          if (currentChunk.length + sentence.length > 200) {
            if (currentChunk) processedScript.push([finalSpeaker, currentChunk]);
            currentChunk = sentence;
          } else {
            currentChunk += (currentChunk ? ' ' : '') + sentence;
          }
        });
        if (currentChunk) processedScript.push([finalSpeaker, currentChunk]);
      } else {
        // 中文模式：遇到英文時切割並切換英文語音發聲
        sentences.forEach(sentence => {
          // 利用 Regex 切割中英文字串 (將字母、數字、其內部空白與橫/底線視為英文段落)
          const parts = sentence.split(/([a-zA-Z0-9][a-zA-Z0-9\s\-_]*[a-zA-Z0-9]|[a-zA-Z0-9])/).filter(p => p.length > 0);
          
          parts.forEach(part => {
             const isEnglish = /^[a-zA-Z0-9\s\-_]+$/.test(part);
             const targetVoice = isEnglish ? finalVoiceEng : finalSpeaker;
             if (part.trim().length > 0 || !isEnglish) {
               processedScript.push([targetVoice, part]);
             }
          });
        });
      }
    });

    // Ensure we don't include /v1 or /generate_podcast in the base URL for these custom endpoints
    let kokoroBaseUrl = settings.kokoroUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    kokoroBaseUrl = kokoroBaseUrl.replace(/\/generate_podcast\/?$/, '');

    // Generate filename strictly as English alphanumeric (Kokoro API requirement)
    const filename = `podcast_${Date.now()}`;

    console.log(`Sending to Kokoro: url=${kokoroBaseUrl}/generate_podcast, filename=${filename}, parsed_segments=${processedScript.length}, voices=${voiceF}/${voiceM}`);

    // Send to Kokoro generate_podcast API

    const kokoroRes = await fetch(`${kokoroBaseUrl}/generate_podcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: filename,
        script: processedScript,
        speed: 0.9,  // Slow down speech speed by 10%
        language: language === 'en' ? 'a' : 'z' // Kokoro uses single-character language codes: 'a' for American English, 'z' for Mandarin
      })
    });

    if (!kokoroRes.ok) {
      const errText = await kokoroRes.text();
      throw new Error(`Kokoro API 錯誤: ${kokoroRes.status} - ${errText}`);
    }

    const kokoroData = await kokoroRes.json();
    const taskId = kokoroData.task_id;

    if (!taskId) {
      throw new Error('Kokoro API 未回傳 task_id');
    }

    console.log(`Kokoro task started: ${taskId}`);

    // Save podcast entry (pending state)
    const podcasts = loadJSON(PODCASTS_FILE, []);
    const podcastEntry = {
      id: podcastId,
      title: title || '未命名 Podcast',
      audioPath: '',
      taskId: taskId,
      status: 'generating',
      script,
      createdAt: new Date().toISOString(),
      progress: 0,
      duration: 0
    };
    podcasts.unshift(podcastEntry);
    saveJSON(PODCASTS_FILE, podcasts);

    res.json({ success: true, podcast: podcastEntry, taskId });
  } catch (error) {
    console.error('Podcast generation error:', error.message);
    res.status(500).json({ error: `Podcast 生成失敗: ${error.message}` });
  }
});

// ─── Podcast: Check Task Status ──────────────────────────────
app.get('/api/podcast/task-status/:taskId', async (req, res) => {
  try {
    const settings = getSettings();
    const { taskId } = req.params;

    // Ensure we don't include /v1 or /generate_podcast in the base URL
    let kokoroBaseUrl = settings.kokoroUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    kokoroBaseUrl = kokoroBaseUrl.replace(/\/generate_podcast\/?$/, '');

    const statusRes = await fetch(`${kokoroBaseUrl}/status/${taskId}`);
    if (!statusRes.ok) throw new Error(`Task status API: ${statusRes.status}`);

    const statusData = await statusRes.json();
    if (statusData.status === 'processing') {
      const progress_percent = statusData.progress_percent || statusData.progress || 0;
      const current_step = statusData.current_step || statusData.step || 0;
      const total_steps = statusData.total_steps || 0;
      console.log(`Task ${taskId} 正在生成中... 目前進度：${progress_percent}% (${current_step}/${total_steps})`);
    } else {
      console.log(`Task ${taskId} status:`, statusData.status);
    }

    // If task is completed, download the audio file(s) and save locally
    if (statusData.status === 'completed') {
      // Find the podcast entry with this taskId
      const podcasts = loadJSON(PODCASTS_FILE, []);
      const podcast = podcasts.find(p => p.taskId === taskId);

      if (podcast && !podcast.audioPath) {
        // Collect URLs to download
        console.log('Task completed! Full status data keys:', Object.keys(statusData));
        if (statusData.result) console.log('statusData.result keys:', Object.keys(statusData.result));

        let urlsToDownload = [];
        if (Array.isArray(statusData.urls)) {
          urlsToDownload = statusData.urls;
        } else if (Array.isArray(statusData.audio_urls)) {
          urlsToDownload = statusData.audio_urls;
        } else if (statusData.result && Array.isArray(statusData.result.urls)) {
          urlsToDownload = statusData.result.urls;
        } else if (typeof statusData.audio_url === 'string') {
          urlsToDownload = [statusData.audio_url];
        } else if (statusData.result && typeof statusData.result.audio_url === 'string') {
          urlsToDownload = [statusData.result.audio_url];
        } else if (statusData.result && typeof statusData.result.url === 'string') {
          urlsToDownload = [statusData.result.url];
        } else if (typeof statusData.url === 'string') {
          urlsToDownload = [statusData.url];
        } else if (typeof statusData.file_path === 'string') {
          // If the API returns file_path, try to guess the real download endpoint
          // Since Kokoro-FastAPI might expose outputs directly, test multiple common paths
          urlsToDownload = [];
          const fn = statusData.filename;
          const possiblePaths = [
            `/download/${taskId}`,
            `/audio/${fn}.wav`,
            `/outputs/${fn}.wav`,
            `/v1/audio/generations/${fn}.wav`,
            `/${fn}.wav`
          ];

          const cleanBaseUrl = kokoroBaseUrl.replace(/\/+$/, '');
          for (const p of possiblePaths) {
            const testUrl = `${cleanBaseUrl}${p}`;
            try {
              const headRes = await fetch(testUrl);
              if (headRes.ok) {
                const cType = headRes.headers.get('content-type') || '';
                if (cType.includes('audio') || cType.includes('video') || cType === 'application/octet-stream') {
                  urlsToDownload = [testUrl];
                  console.log(`Found valid audio file endpoint at: ${testUrl}`);
                  break;
                }
              }
            } catch (e) { /* ignore */ }
          }

          if (urlsToDownload.length === 0) {
            console.error('Could not find a valid audio download URL for the Kokoro task.');
          }
        }

        console.log('urlsToDownload evaluated to:', urlsToDownload);

        if (urlsToDownload.length > 0) {
          let downloadedFiles = [];

          for (let i = 0; i < urlsToDownload.length; i++) {
            let url = urlsToDownload[i];

            // If url is literally just the path like /download/xxx, prepend kokoroBaseUrl correctly
            // The user's settings.kokoroUrl might be http://localhost:8880, but the API may return a string like `http://localhost:8000/download/xxx` if Kokoro's internal host config differs.
            // We must force the download to use the host/port defined in the user settings!

            const userKokoroBaseUrl = settings.kokoroUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '').replace(/\/generate_podcast\/?$/, '');
            let audioUrl = url;

            if (url.startsWith('http')) {
              // Force the host:port from user settings if the internal Kokoro URL returned differs
              try {
                const urlObj = new URL(url);
                const baseObj = new URL(userKokoroBaseUrl);
                urlObj.protocol = baseObj.protocol;
                urlObj.host = baseObj.host;
                urlObj.port = baseObj.port;
                audioUrl = urlObj.toString();
              } catch (e) {
                // Fallback
                audioUrl = url;
              }
            } else {
              const cleanUrlPath = url.replace(/^\/+/, '');
              audioUrl = `${userKokoroBaseUrl}/${cleanUrlPath}`;
            }

            try {
              console.log(`Downloading audio chunk from: ${audioUrl}`);
              const audioRes = await fetch(audioUrl);
              if (audioRes.ok) {
                const cType = audioRes.headers.get('content-type') || '';
                if (!cType.includes('audio') && !cType.includes('video') && !cType.includes('octet-stream')) {
                  console.error(`Downloaded chunk from ${audioUrl} but content-type is ${cType}, expecting audio! Skipping.`);
                  continue;
                }
                const buffer = await audioRes.buffer();
                // 不要依賴下載網址來判斷副檔名，直接從 Python 回傳的 file_path 抓取，或者預設為 mp3
                const ext = statusData.file_path ? statusData.file_path.split('.').pop() : 'mp3';
                const tempFile = path.join(AUDIO_DIR, `temp_${podcast.id}_${i}.${ext}`);
                fs.writeFileSync(tempFile, buffer);
                downloadedFiles.push(tempFile);
                console.log(`Successfully downloaded chunk to ${tempFile}`);
              } else {
                console.error(`Status ${audioRes.status} downloading ${audioUrl} - Check if Kokoro container is accessible from this network.`);
              }
            } catch (dlErr) {
              console.error(`Audio download error from ${audioUrl}:`, dlErr.message);
            }
          }

          if (downloadedFiles.length === 1) {
            const ext = downloadedFiles[0].match(/\.(\w+)$/)[1];
            const finalFile = `${podcast.id}.${ext}`;
            fs.renameSync(downloadedFiles[0], path.join(AUDIO_DIR, finalFile));
            podcast.audioPath = `/api/audio/${finalFile}`;
            podcast.status = 'completed';
            saveJSON(PODCASTS_FILE, podcasts);
            console.log(`Audio downloaded and saved: ${finalFile}`);
          } else if (downloadedFiles.length > 1) {
            // Merge multiple segments using ffmpeg
            const ext = downloadedFiles[0].match(/\.(\w+)$/)[1];
            const finalFile = `${podcast.id}.${ext}`;
            const finalPath = path.join(AUDIO_DIR, finalFile);

            const listPath = path.join(AUDIO_DIR, `list_${podcast.id}.txt`);
            const listContent = downloadedFiles.map(f => `file '${f}'`).join('\n');
            fs.writeFileSync(listPath, listContent);

            try {
              // Concat without re-encoding
              execSync(`ffmpeg -f concat -safe 0 -i "${listPath}" -c copy -y "${finalPath}"`);
              podcast.audioPath = `/api/audio/${finalFile}`;
              podcast.status = 'completed';
              saveJSON(PODCASTS_FILE, podcasts);
              console.log(`Audios downloaded and merged to: ${finalFile}`);
            } catch (ffmpegErr) {
              console.error('FFmpeg merge error:', ffmpegErr.message);
            } finally {
              // Cleanup temp files
              downloadedFiles.forEach(f => {
                try { fs.unlinkSync(f); } catch (e) { }
              });
              try { fs.unlinkSync(listPath); } catch (e) { }
            }
          } else {
            console.error('No audio segments downloaded.');
          }
        }
      }
    }

    res.json({ success: true, ...statusData });
  } catch (error) {
    console.error('Task status error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── Podcast List & Progress ─────────────────────────────────
app.get('/api/podcast/list', (req, res) => {
  const podcasts = loadJSON(PODCASTS_FILE, []);
  res.json({ success: true, podcasts });
});

app.put('/api/podcast/:id/progress', (req, res) => {
  const podcasts = loadJSON(PODCASTS_FILE, []);
  const podcast = podcasts.find(p => p.id === req.params.id);
  if (podcast) {
    podcast.progress = req.body.progress || 0;
    podcast.duration = req.body.duration || podcast.duration;
    saveJSON(PODCASTS_FILE, podcasts);
  }
  res.json({ success: true });
});

app.delete('/api/podcast/:id', (req, res) => {
  const podcasts = loadJSON(PODCASTS_FILE, []);
  const podcast = podcasts.find(p => p.id === req.params.id);
  if (podcast) {
    // Delete audio file
    const audioFile = path.join(AUDIO_DIR, `${podcast.id}.wav`);
    try { fs.unlinkSync(audioFile); } catch { }
  }
  const filtered = podcasts.filter(p => p.id !== req.params.id);
  saveJSON(PODCASTS_FILE, filtered);
  res.json({ success: true });
});

// ─── Local RAG Query Proxy ───────────────────────────────────
app.post('/api/rag/ask', async (req, res) => {
  try {
    const { query, top_k, collections } = req.body;
    const settings = getSettings();
    const ragBaseUrl = (settings.ragUrl || 'http://localhost:8866').replace(/\/$/, '');

    const ragRes = await fetch(`${ragBaseUrl}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        query, 
        top_k: top_k || 10,
        collections: collections || ["hedgedoc_notes", "obsidian_notes"],
        model: settings.ragModel,
        gemini_api_key: settings.geminiApiKey,
        gemini_model: settings.geminiModel
      })
    });

    if (!ragRes.ok) {
      const errText = await ragRes.text();
      let errJson;
      try {
        errJson = JSON.parse(errText);
      } catch (e) {
        errJson = { detail: errText };
      }
      return res.status(ragRes.status).json(errJson);
    }

    const data = await ragRes.json();
    res.json(data);
  } catch (error) {
    console.error('RAG proxy error:', error.message);
    res.status(500).json({ error: `RAG 查詢失敗 (可能後端 API 未啟動): ${error.message}` });
  }
});

// ─── RAG Feedback Proxy ─────────────────────────────────────
app.post('/api/rag/feedback', async (req, res) => {
  try {
    const settings = getSettings();
    const ragBaseUrl = (settings.ragUrl || 'http://localhost:8866').replace(/\/$/, '');
    const ragRes = await fetch(`${ragBaseUrl}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await ragRes.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── RAG: Export Obsidian content to HedgeDoc ───────────────
app.post('/api/rag/export-to-hedgedoc', async (req, res) => {
  try {
    const { title, text, source_path } = req.body;
    const settings = getSettings();
    if (!settings.hedgedocUrl) return res.status(400).json({ error: '請先設定 HedgeDoc URL' });

    const mdContent = `###### tags: \`Obsidian匯入\` \`RAG來源\`\n# ${title || '未命名筆記'}\n\n> 📂 原始路徑：\`${source_path || '未知'}\`\n\n---\n\n${text || '（無內容）'}`;

    const hdRes = await fetch(`${settings.hedgedocUrl}/new`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/markdown',
        'Cookie': settings.hedgedocCookie || ''
      },
      body: mdContent,
      redirect: 'manual'
    });

    let noteUrl = '';
    if (hdRes.status === 302) {
      noteUrl = hdRes.headers.get('location') || '';
      if (noteUrl && !noteUrl.startsWith('http')) {
        noteUrl = `${settings.hedgedocUrl}${noteUrl}`;
      }
    } else {
      const responseText = await hdRes.text();
      noteUrl = `${settings.hedgedocUrl}/${responseText.trim()}`;
    }

    res.json({ success: true, noteUrl });
  } catch (error) {
    console.error('Export to HedgeDoc error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── RAG: Generate Social Post with APA Citations ───────────
app.post('/api/rag/social-post', async (req, res) => {
  try {
    const { query, answer, source_documents } = req.body;
    const settings = getSettings();
    
    if (!settings.geminiApiKey) {
      return res.status(400).json({ error: '需要 Gemini API Key 才能生成社群文章，請在設定中填寫' });
    }

    // 過濾來源：只保留有原始外部連結的資料（排除 HedgeDoc/Obsidian 內部連結）
    const validSources = [];
    if (source_documents && source_documents.length > 0) {
      for (const doc of source_documents) {
        const text = doc.text || doc.full_text || '';
        const title = doc.title || '';
        
        // 嘗試從內容中提取原始來源連結（如 X/Twitter, YouTube, 網站等）
        const urlMatches = text.match(/https?:\/\/(?!.*hedgedoc)(?!.*localhost)[^\s\]\)）」>]+/gi) || [];
        // 也檢查 doc.url 是否為真正的外部連結（排除 HedgeDoc 內部網址）
        let originalUrl = '';
        if (doc.url && doc.url.startsWith('http') && !doc.url.includes('hedgedoc') && !doc.url.includes('localhost')) {
          originalUrl = doc.url;
        } else if (urlMatches.length > 0) {
          originalUrl = urlMatches[0];
        }
        
        // 嘗試提取作者名稱
        let author = '';
        const authorMatch = text.match(/@(\w+)/);
        if (authorMatch) author = `@${authorMatch[1]}`;
        
        // 嘗試推斷來源平台
        let platform = '';
        if (originalUrl.includes('x.com') || originalUrl.includes('twitter.com')) platform = 'X (Twitter)';
        else if (originalUrl.includes('youtube.com') || originalUrl.includes('youtu.be')) platform = 'YouTube';
        else if (originalUrl.includes('medium.com')) platform = 'Medium';
        else if (originalUrl) platform = new URL(originalUrl).hostname.replace('www.', '');
        
        if (originalUrl || author) {
          validSources.push({
            index: validSources.length + 1,
            title: title,
            author: author,
            url: originalUrl,
            platform: platform,
            excerpt: text.substring(0, 300)
          });
        }
      }
    }

    // 構建來源清單
    let sourceList = '';
    if (validSources.length > 0) {
      validSources.forEach(s => {
        sourceList += `\n來源 ${s.index}:\n  標題: ${s.title}\n  作者: ${s.author || '未知'}\n  平台: ${s.platform || '未知'}\n  原始連結: ${s.url}\n  摘錄: ${s.excerpt}\n`;
      });
    } else {
      sourceList = '\n（無可引用的外部原始來源）\n';
    }

    const today = new Date().toISOString().split('T')[0];

    const socialSystemPrompt = `You are a professional social media content editor. Your task is to rewrite the AI's answer into an engaging, knowledge-based thread suitable for Threads.

FORMAT RULES (Threads):
- Split the article into multiple distinct paragraphs, separated by --- lines.
- Each paragraph represents a single Threads post (keep each under 150-300 words).
- Post 1: Start with a catchy hook (a question or strong statement) to introduce the topic.
- Middle Posts: Focus on one key point per post. Use emojis and bullet points to improve readability.
- Final Post: Conclusion + Call to Action (CTA) + hashtags.

APA CITATION RULES:
- ONLY cite sources that have clear original attribution (Author, Platform, URL).
- Use in-line APA citations like: (@Author, Date) or (Title, Platform, Date).
- The "References" section at the end MUST use APA format and ONLY include sources with an original URL.
- DO NOT invent or fabricate any sources. 
- PROHIBITED: Do not include links from HedgeDoc, Obsidian, localhost, or any internal notebook systems in the References.
- If there are no valid external sources to cite, omit the References section entirely.

MISCELLANEOUS:
- The entire output MUST be written in Traditional Chinese (繁體中文).
- Add 3-5 relevant hashtags at the very end.
- Output ONLY the final Threads post content. Do not include any conversational preamble or conclusion.`;

    const socialUserPrompt = `Original User Query:
${query}

Original AI Answer text:
${answer}

Available Source Material (CITE ONLY THESE):
${sourceList}

Today's Date: ${today}`;

    const prompt = `[TASK INSTRUCTIONS]
${socialSystemPrompt}

[RAW CONTENT]
${socialUserPrompt}

Follow the [TASK INSTRUCTIONS] strictly. Output the final Traditional Chinese Threads post directly without any other chatter:`;

    const geminiModel = settings.geminiModel || 'gemma-4-26b-a4b-it';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${settings.geminiApiKey}`;
    
    const geminiRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 8192 }
      })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      throw new Error(`Gemini API 錯誤: ${geminiRes.status} - ${errText}`);
    }

    const geminiData = await geminiRes.json();
    const socialPost = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    if (!socialPost) throw new Error('Gemini 未回傳內容');

    res.json({ success: true, content: socialPost, valid_sources: validSources.length });
  } catch (error) {
    console.error('Social post generation error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── File Management ──────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    // try fixing character encoding issues with originalname
    const origName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, origName);
  }
});
const upload = multer({ storage });

app.post('/api/files/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: '未上傳任何檔案' });
  res.json({ success: true, message: '檔案上傳成功', filename: req.file.filename });
});

app.get('/api/files/list', (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR)
      .filter(f => !f.startsWith('.'))
      .map(f => {
        const stats = fs.statSync(path.join(UPLOADS_DIR, f));
        return {
          filename: f,
          url: `/api/files/download/${encodeURIComponent(f)}`,
          size: stats.size,
          createdAt: stats.mtime
        };
    }).sort((a, b) => b.createdAt - a.createdAt);
    res.json({ success: true, files });
  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.delete('/api/files/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    // basic sanitization
    if (filename.includes('/') || filename.includes('\\')) throw new Error('Invalid filename');
    
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: '找不到檔案' });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Helper for Linux CPU temperatures (reads hwmon/coretemp/k10temp or thermal_zone)
function getLinuxCpuTemperatures() {
  let overallTemp = null;
  let coreTemps = [];
  try {
    const hwmonDir = '/sys/class/hwmon';
    if (fs.existsSync(hwmonDir)) {
      const hwmons = fs.readdirSync(hwmonDir);
      for (const hwmon of hwmons) {
        const namePath = path.join(hwmonDir, hwmon, 'name');
        if (fs.existsSync(namePath)) {
          const driverName = fs.readFileSync(namePath, 'utf8').trim();
          if (driverName === 'coretemp' || driverName === 'k10temp' || driverName === 'zenpower') {
            const files = fs.readdirSync(path.join(hwmonDir, hwmon));
            const tempFiles = files.filter(f => /^temp\d+_input$/.test(f)).sort();
            const temps = tempFiles.map(file => {
              try {
                const raw = fs.readFileSync(path.join(hwmonDir, hwmon, file), 'utf8');
                return Math.round(parseInt(raw, 10) / 1000);
              } catch {
                return null;
              }
            }).filter(t => t !== null);
            
            if (temps.length > 0) {
              if (driverName === 'coretemp') {
                overallTemp = temps[0];
                coreTemps = temps.slice(1);
              } else {
                overallTemp = temps[0];
                coreTemps = temps;
              }
              break;
            }
          }
        }
      }
    }
    
    if (overallTemp === null) {
      const thermalDir = '/sys/class/thermal';
      if (fs.existsSync(thermalDir)) {
        const zones = fs.readdirSync(thermalDir).filter(z => z.startsWith('thermal_zone'));
        for (const zone of zones) {
          const typePath = path.join(thermalDir, zone, 'type');
          if (fs.existsSync(typePath)) {
            const typeName = fs.readFileSync(typePath, 'utf8').trim().toLowerCase();
            if (typeName.includes('cpu') || typeName.includes('pkg') || typeName.includes('acpi')) {
              const tempPath = path.join(thermalDir, zone, 'temp');
              if (fs.existsSync(tempPath)) {
                const raw = fs.readFileSync(tempPath, 'utf8');
                overallTemp = Math.round(parseInt(raw, 10) / 1000);
                break;
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('Error reading Linux CPU temperature:', e.message);
  }
  return { overallTemp, coreTemps };
}

// ─── System Status API ───────────────────────────────────────
app.get('/api/system/status', (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsePercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;
    
    let diskInfo = { size: 'N/A', used: 'N/A', avail: 'N/A', usePercent: '0%' };
    try {
      const stdout = execSync('df -hP /', { encoding: 'utf8', timeout: 5000 });
      const lines = stdout.trim().split('\n');
      let targetLine = lines[1];
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim().endsWith(' /') || lines[i].trim().endsWith('/')) {
          targetLine = lines[i];
          break;
        }
      }
      if (targetLine) {
        const parts = targetLine.trim().split(/\s+/);
        if (parts.length >= 5) {
          diskInfo = {
            size: parts[1],
            used: parts[2],
            avail: parts[3],
            usePercent: parts[4]
          };
        }
      }
    } catch (e) {
      console.error('Error reading disk usage:', e.message);
    }

    let overallTemp = null;
    let coreTemps = [];
    if (os.platform() === 'darwin' && macosTemp) {
      try {
        const data = macosTemp.temperature();
        if (data) {
          overallTemp = data.cpu ? Math.round(data.cpu) : null;
          coreTemps = data.cpuDieTemps ? data.cpuDieTemps.map(t => Math.round(t)) : [];
        }
      } catch (e) {
        console.error('Error reading macOS CPU temperature:', e.message);
      }
    } else if (os.platform() === 'linux') {
      const linuxTemps = getLinuxCpuTemperatures();
      overallTemp = linuxTemps.overallTemp;
      coreTemps = linuxTemps.coreTemps;
    }

    res.json({
      success: true,
      cpu: {
        overallLoad: cpuOverall,
        coreLoads: cpuUsages,
        overallTemp,
        coreTemps
      },
      memory: {
        total: (totalMem / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
        used: (usedMem / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
        free: (freeMem / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
        usePercent: memUsePercent
      },
      disk: diskInfo
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use('/api/files/download', express.static(UPLOADS_DIR));

// ─── Fallback to SPA ─────────────────────────────────────────
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 X Post Processor 啟動於 http://localhost:${PORT}\n`);
});
