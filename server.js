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

              if (fxData.tweet.media && fxData.tweet.media.videos && fxData.tweet.media.videos.length > 0) {
                hasVideo = true;
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
      fs.writeFileSync(cookieFile, convertCookieToNetscape(settings.xCookie), 'utf-8');
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
- ⚠️ 嚴格輸出限制：必須『只』輸出筆記內容，絕對不可以使用 markdown 的 code block（也就是不要用 \`\`\` 包起來）。

格式要求：
1. **非常重要**：筆記的最開頭第一行必須加上標籤，格式為：###### tags: \`標籤1\` \`標籤2\`（請根據內容自動生成 2-3 個相關的標籤）
2. 使用 Markdown 格式（如標題 #、粗體 **、列表 -）來讓閱讀更清晰
3. 包含重點摘要
4. 列出關鍵要點
5. 如果有技術內容，請適當解釋
6. 保持簡潔但完整
7. 語言使用繁體中文

以下是需要整理的原始內容：
---
${content}
---

請直接根據上述原始內容輸出整理好的 Markdown 筆記（嚴禁編造內容，嚴禁使用 \`\`\` 包裝）：`;

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
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Clean up: remove markdown code block markers if present
    text = text.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

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

    const prompt = `請將以下貼文內容改寫為 Podcast 雙人對談腳本。
主持人為曉曉 (host_f，女，活潑好奇) 與雲健 (host_m，男，沉穩專業)。請加入台灣日常口語習慣（如：喔、吧、對啊、其實）。
⚠️ 嚴格輸出限制：你必須『只』輸出一個 Python List 格式，不要包含 Markdown 標記 (如 \`\`\`python )，不要前言結語。格式範例：
[
    ("host_f", "大家好..."),
    ("host_m", "沒錯...")
]

內容標題：${noteTitle || '未命名'}

以下是需要改寫的內容：
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
    let script = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Clean up: remove markdown code block markers if present
    script = script.replace(/^```(?:python)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

    res.json({ success: true, script });
  } catch (error) {
    console.error('Script generation error:', error.message);
    res.status(500).json({ error: `講稿生成失敗: ${error.message}` });
  }
});

// ─── Podcast: Generate Audio (Kokoro generate_podcast API) ───
app.post('/api/podcast/generate-audio', async (req, res) => {
  try {
    const { script, title } = req.body;
    if (!script) return res.status(400).json({ error: '缺少講稿' });

    const settings = getSettings();
    const podcastId = Date.now().toString();

    // Parse the Python List script into a JS array for the API
    let scriptData;
    try {
      // Convert Python tuple format to JSON array format
      // ("host_f", "text") -> ["host_f", "text"]
      const jsonStr = script
        .replace(/\(/g, '[')
        .replace(/\)/g, ']')
        .replace(/'/g, '"');
      scriptData = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('Script parse error, trying regex extraction:', parseErr.message);
      // Fallback: extract tuples using regex
      scriptData = [];
      const tupleRegex = /\(\s*["'](\w+)["']\s*,\s*["']((?:[^"'\\]|\\.)*)["']\s*\)/g;
      let match;
      while ((match = tupleRegex.exec(script)) !== null) {
        scriptData.push([match[1], match[2].replace(/\\"/g, '"').replace(/\\'/g, "'")]);
      }
    }

    if (!scriptData || scriptData.length === 0) {
      throw new Error('無法解析講稿格式，請確認為 Python List 格式');
    }

    // Ensure we don't include /v1 or /generate_podcast in the base URL for these custom endpoints
    let kokoroBaseUrl = settings.kokoroUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    kokoroBaseUrl = kokoroBaseUrl.replace(/\/generate_podcast\/?$/, '');

    // Generate filename strictly as English alphanumeric (Kokoro API requirement)
    const filename = `podcast_${Date.now()}`;

    console.log(`Sending to Kokoro: url=${kokoroBaseUrl}/generate_podcast, filename=${filename}, segments=${scriptData.length}`);

    // Send to Kokoro generate_podcast API

    const kokoroRes = await fetch(`${kokoroBaseUrl}/generate_podcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: filename,
        script: scriptData
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
          // If the API returns file_path, download from /download/{task_id}
          urlsToDownload = [`/download/${taskId}`];
        }

        console.log('urlsToDownload evaluated to:', urlsToDownload);

        if (urlsToDownload.length > 0) {
          let downloadedFiles = [];

          for (let i = 0; i < urlsToDownload.length; i++) {
            let url = urlsToDownload[i];
            const audioUrl = url.startsWith('http')
              ? url
              : `${kokoroBaseUrl}${url.startsWith('/') ? '' : '/'}${url}`;

            try {
              const audioRes = await fetch(audioUrl);
              if (audioRes.ok) {
                const buffer = await audioRes.buffer();
                const ext = audioUrl.match(/\.(\w+)(?:[\?#]|$)/)?.[1] || 'mp3';
                const tempFile = path.join(AUDIO_DIR, `temp_${podcast.id}_${i}.${ext}`);
                fs.writeFileSync(tempFile, buffer);
                downloadedFiles.push(tempFile);
              } else {
                console.error(`Status ${audioRes.status} downloading ${audioUrl}`);
              }
            } catch (dlErr) {
              console.error('Audio download error:', dlErr.message);
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

// ─── Fallback to SPA ─────────────────────────────────────────
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 X Post Processor 啟動於 http://localhost:${PORT}\n`);
});
