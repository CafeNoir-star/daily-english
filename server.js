const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// --- WorkBuddy Cloud 反向代理（Render / 自建服务器时启用） ---
const WB_ENDPOINT = (process.env.WB_ENDPOINT || 'https://daily-english-22755.app.workbuddy.host').replace(/\/+$/, '');
const WB_KEY = (process.env.WB_KEY || '').trim();
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// --- Security: Rate limiting with Map size cap ---
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_MAP_MAX = 10000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimit.get(ip);
  if (!entry || now > entry.resetTime) {
    // Evict oldest entries if Map is too large
    if (rateLimit.size >= RATE_LIMIT_MAP_MAX) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, v] of rateLimit) {
        if (v.resetTime < oldestTime) {
          oldestTime = v.resetTime;
          oldestKey = k;
        }
      }
      if (oldestKey) rateLimit.delete(oldestKey);
    }
    rateLimit.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimit) {
    if (now > entry.resetTime) rateLimit.delete(ip);
  }
  for (const [ip, entry] of cloudRateLimit) {
    if (now > entry.resetTime) cloudRateLimit.delete(ip);
  }
}, 5 * 60 * 1000);

// --- Cloud proxy: separate, higher limit (app makes many DB/LLM calls per load) ---
const cloudRateLimit = new Map();
const CLOUD_RATE_LIMIT_MAX = 300;

function checkCloudRateLimit(ip) {
  const now = Date.now();
  const entry = cloudRateLimit.get(ip);
  if (!entry || now > entry.resetTime) {
    if (cloudRateLimit.size >= RATE_LIMIT_MAP_MAX) {
      const firstKey = cloudRateLimit.keys().next().value;
      if (firstKey) cloudRateLimit.delete(firstKey);
    }
    cloudRateLimit.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= CLOUD_RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
];

function readRequestBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function emailFromAuthBody(pathname, body) {
  try {
    const data = JSON.parse(body.toString('utf8'));
    if (pathname.endsWith('/v1/signin')) {
      return String(data.username || data.email || '').trim().toLowerCase();
    }
    if (pathname.endsWith('/v1/verification')) {
      return String(data.email || '').trim().toLowerCase();
    }
  } catch (e) { /* not JSON, let upstream decide */ }
  return '';
}

// 同源反向代理：浏览器 → /.cloud/* → WorkBuddy（剥离 Origin/Referer，注入 access key）
function proxyCloud(req, res, url, ip) {
  if (!WB_KEY) {
    writeHead(res, 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'WB_KEY not configured' }));
    return;
  }
  if (!checkCloudRateLimit(ip)) {
    writeHead(res, 429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too many requests' }));
    return;
  }

  const gateAuth = ALLOWED_EMAILS.length > 0
    && req.method === 'POST'
    && (url.pathname.endsWith('/v1/signin') || url.pathname.endsWith('/v1/verification'));

  const headers = Object.assign({}, req.headers);
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  headers['x-wb-webapp-access-key'] = WB_KEY;

  let target;
  try {
    target = new URL(WB_ENDPOINT + url.pathname + url.search);
  } catch (e) {
    writeHead(res, 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid target' }));
    return;
  }

  const send = (body) => {
    const proxyReq = https.request(target, { method: req.method, headers, timeout: 180000 }, (upstream) => {
      const responseHeaders = Object.assign({}, upstream.headers);
      for (const name of HOP_BY_HOP) delete responseHeaders[name];
      if (!res.headersSent) res.writeHead(upstream.statusCode || 502, responseHeaders);
      upstream.pipe(res);
    });
    proxyReq.on('timeout', () => proxyReq.destroy(new Error('upstream timeout')));
    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        writeHead(res, 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cloud upstream error', detail: err.message }));
      } else {
        res.destroy();
      }
    });
    if (body) proxyReq.end(body);
    else req.pipe(proxyReq);
  };

  if (gateAuth) {
    readRequestBody(req).then((body) => {
      const email = emailFromAuthBody(url.pathname, body);
      if (!email || !ALLOWED_EMAILS.includes(email)) {
        writeHead(res, 403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'email not allowed' }));
        return;
      }
      headers['content-length'] = String(body.length);
      send(body);
    }).catch(() => {
      writeHead(res, 413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body too large' }));
    });
    return;
  }

  send(null);
}

// --- Security: Extract real client IP safely ---
function getClientIP(req) {
  // Trust x-forwarded-for only for the first IP (set by reverse proxy)
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const firstIP = xff.split(',')[0].trim();
    if (firstIP) return firstIP;
  }
  return req.socket.remoteAddress || 'unknown';
}

// --- Security: Security headers for all responses ---
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; media-src 'self' data: blob: https://api.dictionaryapi.dev https://*.jsdelivr.net https://*.r2.dev https://raw.githubusercontent.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.workbuddy.host https://*.workbuddy.cn https://api.dictionaryapi.dev https://freedictionaryapi.com https://*.jsdelivr.net https://*.r2.dev",
};

function writeHead(res, status, extraHeaders) {
  const headers = Object.assign({}, SECURITY_HEADERS, extraHeaders || {});
  res.writeHead(status, headers);
}

// --- Security: Blocked paths (blacklist) ---
const BLOCKED_PATHS = [
  '/data/',
  '/docs/',
  '/node_modules/',
  '/fetch_definitions.mjs',
  '/generate_dict.js',
  '/corpus.js',
  '/dictionary.js',
  '/package.json',
  '/package-lock.json',
  '/test/',
  '/.workbuddy/',
];

function isPathBlocked(filePath) {
  // Normalize and check
  const normalized = path.normalize(filePath).replace(/\\/g, '/');
  return BLOCKED_PATHS.some(bp => normalized === bp || normalized.startsWith(bp));
}

// --- Dictionary API fallback (free, no key needed) ---
// Cache results in memory to avoid repeated API calls
const dictApiCache = new Map();
const DICT_CACHE_MAX = 2000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, data: null }); }
      });
    }).on('error', reject);
  });
}

async function lookupWordOnline(word) {
  // Check cache first
  if (dictApiCache.has(word)) return dictApiCache.get(word);

  // Check if we have a pre-generated local audio file for this word
  const localAudioPath = `/audio/vocab_${word}.mp3`;
  let hasLocalAudio = false;
  try {
    fs.accessSync(path.join(__dirname, 'audio', `vocab_${word}.mp3`), fs.constants.R_OK);
    hasLocalAudio = true;
  } catch (e) {}

  // Try dictionaryapi.dev first (has audio MP3)
  try {
    const result = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (result.status === 200 && Array.isArray(result.data) && result.data.length > 0) {
      const entry = result.data[0];
      // Find best phonetic (prefer one with audio)
      const phWithAudio = entry.phonetics?.find(p => p.audio && p.audio.length > 0);
      const phWithText = entry.phonetics?.find(p => p.text);
      const phonetic = phWithText?.text || '';
      const audioUrl = phWithAudio?.audio || '';
      // Get first meaning
      const meaning = entry.meanings?.[0];
      const pos = meaning?.partOfSpeech || '';
      const definition = meaning?.definitions?.[0]?.definition || '';
      const example = meaning?.definitions?.[0]?.example || '';

      if (definition) {
        // Prefer local pre-generated audio, fallback to dictionary API audio
        const finalAudioUrl = hasLocalAudio ? localAudioPath : audioUrl;
        const result_obj = {
          found: true,
          phonetic,
          pos,
          definition,
          example_sentence: example,
          example_translation: '',
          audio_url: finalAudioUrl
        };
        // Cache
        if (dictApiCache.size >= DICT_CACHE_MAX) {
          const firstKey = dictApiCache.keys().next().value;
          dictApiCache.delete(firstKey);
        }
        dictApiCache.set(word, result_obj);
        return result_obj;
      }
    }
  } catch (e) {
    console.log(`dictionaryapi.dev failed for "${word}":`, e.message);
  }

  // Fallback: freedictionaryapi.com (no audio, but has definitions)
  try {
    const result = await fetchJson(`https://freedictionaryapi.com/api/v1/entries/en/${encodeURIComponent(word)}`);
    if (result.status === 200 && result.data && result.data.entries) {
      const entry = result.data.entries[0];
      const phonetic = entry.pronunciations?.find(p => p.tags?.includes('US'))?.text
                    || entry.pronunciations?.find(p => p.text)?.text || '';
      const pos = entry.partOfSpeech || '';
      const definition = entry.senses?.[0]?.definition || '';
      const example = entry.senses?.[0]?.examples?.[0] || '';

      if (definition) {
        const result_obj = {
          found: true,
          phonetic,
          pos,
          definition,
          example_sentence: example,
          example_translation: '',
          audio_url: hasLocalAudio ? localAudioPath : ''
        };
        if (dictApiCache.size >= DICT_CACHE_MAX) {
          const firstKey = dictApiCache.keys().next().value;
          dictApiCache.delete(firstKey);
        }
        dictApiCache.set(word, result_obj);
        return result_obj;
      }
    }
  } catch (e) {
    console.log(`freedictionaryapi.com failed for "${word}":`, e.message);
  }

  return { found: false };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const ip = getClientIP(req);

  // 保活探针：不查库、不调上游，响应最快（Render 保活用）
  if (url.pathname === '/api/health') {
    writeHead(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }

  // 同源反向代理：Render / 自建服务器时，前端把 endpoint 指向本站
  if (url.pathname.startsWith('/.cloud/')) {
    proxyCloud(req, res, url, ip);
    return;
  }

  // API routes
  if (url.pathname.startsWith('/api/')) {
    if (!checkRateLimit(ip)) {
      writeHead(res, 429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests' }));
      return;
    }

    // GET /api/lookup?word=xxx
    // Flow: dictionaryapi.dev → freedictionaryapi.com → not found
    // (word_dictionary table is queried by frontend directly, this handles words not in the table)
    if (url.pathname === '/api/lookup' && req.method === 'GET') {
      const word = (url.searchParams.get('word') || '').trim().toLowerCase();
      if (!word || !/^[a-z]+$/.test(word) || word.length > 50) {
        writeHead(res, 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid word' }));
        return;
      }
      // Query free dictionary API (fast, has English definition + audio)
      try {
        const onlineResult = await lookupWordOnline(word);
        if (onlineResult.found) {
          onlineResult.source = 'online'; // marker: needs LLM enrichment
        }
        writeHead(res, 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(onlineResult));
      } catch (e) {
        writeHead(res, 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ found: false }));
      }
      return;
    }

    writeHead(res, 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API not found' }));
    return;
  }

  // --- Static file serving with security checks ---
  let filePath = url.pathname;

  // Security: Reject path traversal in raw URL (before URL normalization removes ..)
  const rawUrl = req.url || '';
  const decodedRaw = decodeURIComponent(rawUrl);
  if (decodedRaw.includes('..') || decodedRaw.includes('\0') || decodedRaw.includes('%5c') || decodedRaw.includes('%5C')) {
    writeHead(res, 403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (filePath === '/') filePath = '/index.html';

  // Security: Check blacklist first
  if (isPathBlocked(filePath)) {
    writeHead(res, 404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  // Security: Resolve to absolute path and verify it stays within __dirname
  // Strip leading slash so path.resolve treats it as relative to __dirname
  const relativePath = filePath.replace(/^\/+/, '');
  const fullPath = path.resolve(__dirname, relativePath);
  const appRoot = path.resolve(__dirname);
  if (!fullPath.startsWith(appRoot + path.sep) && fullPath !== appRoot) {
    writeHead(res, 403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.access(fullPath, fs.constants.R_OK, (err) => {
    if (err) {
      // SPA fallback: only for paths without a file extension (route URLs like /today, /vocab)
      // Paths with extensions (like /etc/passwd, /foo.js) that don't exist → 404
      const ext = path.extname(filePath).toLowerCase();
      if (ext) {
        writeHead(res, 404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      // Fallback to index.html for SPA routing
      const indexPath = path.join(__dirname, 'index.html');
      fs.access(indexPath, fs.constants.R_OK, (err2) => {
        if (err2) {
          writeHead(res, 404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        } else {
          fs.readFile(indexPath, (err3, data) => {
            if (err3) {
              writeHead(res, 500, { 'Content-Type': 'text/plain' });
              res.end('Internal error');
            } else {
              writeHead(res, 200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(data);
            }
          });
        }
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    fs.readFile(fullPath, (err2, data) => {
      if (err2) {
        writeHead(res, 500, { 'Content-Type': 'text/plain' });
        res.end('Internal error');
      } else {
        // no-cache: browser validates with server, only re-downloads if file changed
        writeHead(res, 200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        res.end(data);
      }
    });
  });
});

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
