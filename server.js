const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const fetch = require('node-fetch');
const FormData = require('form-data');

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

[DATA_DIR, VIDEOS_DIR, AUDIO_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

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
    geminiModel: 'gemma-3-27b-it',
    hedgedocUrl: '',
    hedgedocCookie: '',
    whisperUrl: 'http://localhost:8080',
    kokoroUrl: 'http://localhost:8880',
    xCookie: ''
  });
}

// ─── Settings API ────────────────────────────────────────────
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

    if (isArticle) {
      console.log(`Detected X Article URL, ID: ${tweetId}`);
    }

    // Method 1: Try yt-dlp --dump-json (works well & detects video)
    try {
      let cookieArgs = '';
      if (settings.xCookie) {
        const cookieFile = path.join(DATA_DIR, 'x_cookies.txt');
        fs.writeFileSync(cookieFile, settings.xCookie, 'utf-8');
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
              tweetText = fxData.tweet.text || '';
              // For articles, also check for article_text or longer content fields
              if (fxData.tweet.article) {
                tweetText = fxData.tweet.article.text || fxData.tweet.article.content || tweetText;
              }
              if (fxData.tweet.media && fxData.tweet.media.videos && fxData.tweet.media.videos.length > 0) {
                hasVideo = true;
              }
              if (tweetText) {
                parseMethod = 'fxtwitter';
                console.log(`FxTwitter parsed successfully from ${fxUrl}`);
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
          if (vxData.mediaURLs && vxData.mediaURLs.some(u => u.includes('.mp4') || u.includes('video'))) {
            hasVideo = true;
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
          if (synData.mediaDetails && synData.mediaDetails.some(m => m.type === 'video')) {
            hasVideo = true;
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

    console.log(`Parse result: method=${parseMethod}, textLen=${tweetText.length}, hasVideo=${hasVideo}`);

    // ─── Try to fetch content from URLs in tweet text ───
    let fetchedUrlContent = '';
    const urlsInText = tweetText.match(/https?:\/\/[^\s]+/g) || [];
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

    res.json({
      success: true,
      tweet: {
        id: tweetId,
        text: tweetText,
        author: author,
        hasVideo,
        url,
        parseMethod,
        fetchedContent: fetchedUrlContent
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

// ─── Download Video (yt-dlp) ─────────────────────────────────
app.post('/api/x/download-video', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: '缺少 URL' });

    const match = url.match(/status\/(\d+)/);
    const videoId = match ? match[1] : Date.now().toString();
    const outputPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);
    const settings = getSettings();

    // Check if already downloaded
    if (fs.existsSync(outputPath)) {
      return res.json({ success: true, filename: `${videoId}.mp4`, path: `/api/videos/${videoId}.mp4` });
    }

    let cookieArgs = '';
    if (settings.xCookie) {
      // Write temp cookie file
      const cookieFile = path.join(DATA_DIR, 'x_cookies.txt');
      fs.writeFileSync(cookieFile, settings.xCookie, 'utf-8');
      cookieArgs = `--cookies "${cookieFile}"`;
    }

    const cmd = `yt-dlp ${cookieArgs} -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${outputPath}" "${url}"`;

    execSync(cmd, { encoding: 'utf-8', timeout: 120000 });

    if (fs.existsSync(outputPath)) {
      res.json({ success: true, filename: `${videoId}.mp4`, path: `/api/videos/${videoId}.mp4` });
    } else {
      // Check for other extensions
      const files = fs.readdirSync(VIDEOS_DIR).filter(f => f.startsWith(videoId));
      if (files.length > 0) {
        res.json({ success: true, filename: files[0], path: `/api/videos/${files[0]}` });
      } else {
        throw new Error('影片下載失敗');
      }
    }
  } catch (error) {
    console.error('Download error:', error.message);
    res.status(500).json({ error: `下載失敗: ${error.message}` });
  }
});

// ─── Serve Videos ────────────────────────────────────────────
app.use('/api/videos', express.static(VIDEOS_DIR));

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

    // Send to Whisper API
    const formData = new FormData();
    formData.append('file', fs.createReadStream(audioFile));
    formData.append('response_format', 'json');

    const whisperRes = await fetch(`${settings.whisperUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders()
    });

    if (!whisperRes.ok) {
      // Try alternative endpoint
      const formData2 = new FormData();
      formData2.append('file', fs.createReadStream(audioFile));

      const whisperRes2 = await fetch(`${settings.whisperUrl}/inference`, {
        method: 'POST',
        body: formData2,
        headers: formData2.getHeaders()
      });

      if (!whisperRes2.ok) throw new Error(`Whisper API 錯誤: ${whisperRes2.status}`);
      const data = await whisperRes2.json();
      return res.json({ success: true, text: data.text || data.transcription || '' });
    }

    const data = await whisperRes.json();
    res.json({ success: true, text: data.text || '' });
  } catch (error) {
    console.error('Whisper error:', error.message);
    res.status(500).json({ error: `轉錄失敗: ${error.message}` });
  }
});

// ─── Gemini Summarize ────────────────────────────────────────
app.post('/api/gemini/summarize', async (req, res) => {
  try {
    const { content, type } = req.body;
    if (!content) return res.status(400).json({ error: '缺少內容' });

    const settings = getSettings();
    if (!settings.geminiApiKey) return res.status(400).json({ error: '請先設定 Gemini API Key' });

    const prompt = type === 'podcast'
      ? req.body.prompt
      : `你是一位專業的筆記整理助手。你的任務是根據以下提供的內容，直接整理成繁體中文筆記。

嚴格規則（必須遵守）：
- 你必須直接輸出整理好的筆記，不可以回覆任何對話、提問或要求更多資訊
- 不要說「請提供連結」或「請貼上內容」之類的話
- 嚴禁捏造、幻想或編造任何不在原始內容中的資訊
- 只能根據下方提供的原始內容進行整理，不可以自行補充你認為可能的內容
- 如果原始內容太少無法整理成有意義的筆記，就直接輸出：「⚠️ 原始內容不足，無法生成完整筆記。」並附上原始內容
- 直接以 Markdown 格式輸出筆記內容

格式要求：
1. 使用 Markdown 格式
2. 包含重點摘要
3. 列出關鍵要點
4. 如果有技術內容，請適當解釋
5. 保持簡潔但完整
6. 語言使用繁體中文

以下是需要整理的原始內容：
---
${content}
---

請直接根據上述原始內容輸出整理好的 Markdown 筆記（禁止編造內容）：`;

    const model = settings.geminiModel || 'gemma-3-27b-it';
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      throw new Error(`Gemini API 錯誤: ${geminiRes.status} - ${errText}`);
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

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
    const { noteContents, noteTitle } = req.body;
    if (!noteContents) return res.status(400).json({ error: '缺少筆記內容' });

    const settings = getSettings();
    if (!settings.geminiApiKey) return res.status(400).json({ error: '請先設定 Gemini API Key' });

    const prompt = `你是一位專業的 Podcast 講稿撰寫者。請根據以下筆記內容，撰寫一份兩位主持人的 Podcast 講稿。

規則：
1. 兩位主持人分別為「小明」和「小華」
2. 語言使用繁體中文，口語化、自然
3. 對話要有互動感，包含提問、回應、補充
4. 開頭要有引言介紹主題，結尾要有總結
5. 每段對話標注說話者，格式為「小明：...」或「小華：...」
6. 內容要有教育性但保持輕鬆有趣
7. 長度約 5-10 分鐘的對話量
8. 不要加入舞台指示或音效標記

筆記標題：${noteTitle || '未命名'}

筆記內容：
${noteContents}`;

    const model = settings.geminiModel || 'gemma-3-27b-it';
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 8192 }
        })
      }
    );

    if (!geminiRes.ok) throw new Error(`Gemini API 錯誤: ${geminiRes.status}`);

    const data = await geminiRes.json();
    const script = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    res.json({ success: true, script });
  } catch (error) {
    console.error('Script generation error:', error.message);
    res.status(500).json({ error: `講稿生成失敗: ${error.message}` });
  }
});

// ─── Podcast: Generate Audio ─────────────────────────────────
app.post('/api/podcast/generate-audio', async (req, res) => {
  try {
    const { script, title } = req.body;
    if (!script) return res.status(400).json({ error: '缺少講稿' });

    const settings = getSettings();
    const podcastId = Date.now().toString();

    // Parse script into segments by speaker
    const lines = script.split('\n').filter(l => l.trim());
    const segments = [];

    for (const line of lines) {
      const speakerMatch = line.match(/^(小明|小華)[：:]\s*(.*)/);
      if (speakerMatch) {
        segments.push({
          speaker: speakerMatch[1],
          text: speakerMatch[2].trim()
        });
      }
    }

    if (segments.length === 0) {
      // Fallback: treat entire script as single segment
      segments.push({ speaker: '小明', text: script });
    }

    // Generate audio for each segment using Kokoro API
    const audioFiles = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const segFile = path.join(AUDIO_DIR, `${podcastId}_seg${i}.wav`);

      // Map speakers to different voices
      const voice = seg.speaker === '小明' ? 'zf_xiaobei' : 'zf_xiaoni';

      try {
        const kokoroRes = await fetch(`${settings.kokoroUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'kokoro',
            input: seg.text,
            voice: voice,
            response_format: 'wav'
          })
        });

        if (!kokoroRes.ok) throw new Error(`Kokoro API: ${kokoroRes.status}`);

        const buffer = await kokoroRes.buffer();
        fs.writeFileSync(segFile, buffer);
        audioFiles.push(segFile);
      } catch (e) {
        console.error(`Segment ${i} TTS error:`, e.message);
      }
    }

    // Merge audio files using ffmpeg
    const outputFile = path.join(AUDIO_DIR, `${podcastId}.wav`);

    if (audioFiles.length > 1) {
      const listFile = path.join(AUDIO_DIR, `${podcastId}_list.txt`);
      const listContent = audioFiles.map(f => `file '${f}'`).join('\n');
      fs.writeFileSync(listFile, listContent);

      try {
        execSync(`ffmpeg -f concat -safe 0 -i "${listFile}" -y "${outputFile}"`, { timeout: 120000 });
      } catch (e) {
        console.error('FFmpeg merge error:', e.message);
        // Fallback: use first file
        if (audioFiles.length > 0) {
          fs.copyFileSync(audioFiles[0], outputFile);
        }
      }

      // Cleanup segment files
      try { fs.unlinkSync(listFile); } catch { }
      audioFiles.forEach(f => { try { fs.unlinkSync(f); } catch { } });
    } else if (audioFiles.length === 1) {
      fs.copyFileSync(audioFiles[0], outputFile);
      try { fs.unlinkSync(audioFiles[0]); } catch { }
    } else {
      throw new Error('所有語音片段生成失敗');
    }

    // Save podcast entry
    const podcasts = loadJSON(PODCASTS_FILE, []);
    const podcastEntry = {
      id: podcastId,
      title: title || '未命名 Podcast',
      audioPath: `/api/audio/${podcastId}.wav`,
      script,
      createdAt: new Date().toISOString(),
      progress: 0,
      duration: 0
    };
    podcasts.unshift(podcastEntry);
    saveJSON(PODCASTS_FILE, podcasts);

    res.json({ success: true, podcast: podcastEntry });
  } catch (error) {
    console.error('Podcast generation error:', error.message);
    res.status(500).json({ error: `Podcast 生成失敗: ${error.message}` });
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

// ─── Fallback to SPA ─────────────────────────────────────────
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 X Post Processor 啟動於 http://localhost:${PORT}\n`);
});
