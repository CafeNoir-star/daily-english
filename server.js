const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

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
  for (const [ip, entry] of proxyRateLimit) {
    if (now > entry.resetTime) proxyRateLimit.delete(ip);
  }
}, 5 * 60 * 1000);

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

// --- Cloud 同源代理：真实 publishableKey 只存在于服务端 ---
// 浏览器只带一个占位串访问 /wb-api/*，由这里注入真 key 并转发到 WorkBuddy。
// 大模型接口一律拒绝，因此公开的前端代码即使被读走也无法调用 LLM。
const PROXY_PREFIX = '/wb-api';
const PROXY_ALLOWED = ['/.cloud/database/rest', '/.cloud/auth'];
const PROXY_BLOCKED = ['/.cloud/llm'];
const PROXY_MAX_BODY = 1024 * 1024;
const PROXY_RATE_MAX = 600;
const proxyRateLimit = new Map();

function loadSecrets() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'server.secrets.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

const SECRETS = loadSecrets();
const WB_KEY = String(process.env.WB_KEY || SECRETS.wbKey || '').trim();
const WB_UPSTREAM = String(process.env.WB_ENDPOINT || SECRETS.endpoint || '').replace(/\/+$/, '');
const SITE_ORIGIN = String(process.env.WB_SITE_ORIGIN || SECRETS.siteOrigin || '').replace(/\/+$/, '');

function checkProxyRateLimit(ip) {
  const now = Date.now();
  const entry = proxyRateLimit.get(ip);
  if (!entry || now > entry.resetTime) {
    if (proxyRateLimit.size >= RATE_LIMIT_MAP_MAX) proxyRateLimit.clear();
    proxyRateLimit.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  if (entry.count >= PROXY_RATE_MAX) return false;
  entry.count++;
  return true;
}

// 返回可转发的上游路径；null 表示拒绝
function resolveProxyPath(pathname) {
  if (!pathname.startsWith(PROXY_PREFIX + '/')) return null;
  const rest = pathname.slice(PROXY_PREFIX.length);
  let decoded;
  try {
    decoded = decodeURIComponent(rest);
  } catch (e) {
    return null;
  }
  if (!decoded.startsWith('/')) return null;
  if (decoded.includes('..') || decoded.includes('\0') || decoded.includes('\\')) return null;
  const lower = decoded.toLowerCase();
  if (PROXY_BLOCKED.some((p) => lower.startsWith(p))) return null;
  if (!PROXY_ALLOWED.some((p) => lower.startsWith(p))) return null;
  return rest;
}

function jsonError(res, status, message) {
  writeHead(res, status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

function proxyCloud(req, res, url, ip) {
  const upstreamPath = resolveProxyPath(url.pathname);
  if (!upstreamPath) {
    jsonError(res, 403, 'path not allowed');
    return;
  }
  if (!WB_KEY || !WB_UPSTREAM) {
    jsonError(res, 503, 'cloud proxy not configured');
    return;
  }
  if (!checkProxyRateLimit(ip)) {
    jsonError(res, 429, 'too many requests');
    return;
  }

  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > PROXY_MAX_BODY) {
    jsonError(res, 413, 'payload too large');
    req.resume();
    return;
  }

  let target;
  try {
    target = new URL(WB_UPSTREAM + upstreamPath + url.search);
  } catch (e) {
    jsonError(res, 400, 'bad request path');
    return;
  }
  const lib = target.protocol === 'https:' ? https : http;

  const headers = {
    host: target.host,
    'x-wb-webapp-access-key': WB_KEY,
    accept: req.headers.accept || 'application/json',
  };
  // auth 接口（signin 等）依赖 Origin 生成 JWT 的 azp，必须补；
  // 数据库接口走服务端模式（不带 Origin）——平台机房内带 Origin 会被判 invalid_grant
  if (SITE_ORIGIN && upstreamPath.toLowerCase().startsWith('/.cloud/auth')) {
    headers.origin = SITE_ORIGIN;
    headers.referer = SITE_ORIGIN + '/';
  }
  for (const name of ['authorization', 'content-type', 'prefer', 'accept-profile', 'content-profile', 'range', 'if-none-match']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  if (declaredLength) headers['content-length'] = String(declaredLength);

  const upstreamReq = lib.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: req.method,
      headers,
      timeout: 30000,
    },
    (upstreamRes) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (['connection', 'transfer-encoding', 'keep-alive', 'content-length'].includes(k)) continue;
        outHeaders[k] = v;
      }
      writeHead(res, upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(res);
    }
  );

  let received = 0;
  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
  upstreamReq.on('error', () => {
    if (!res.headersSent) jsonError(res, 502, 'upstream unreachable');
  });

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > PROXY_MAX_BODY) {
      upstreamReq.destroy();
      if (!res.headersSent) jsonError(res, 413, 'payload too large');
    }
  });
  req.pipe(upstreamReq);
}

// --- Security: Security headers for all responses ---
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; media-src 'self' data: blob: https://api.dictionaryapi.dev https://*.jsdelivr.net https://*.r2.dev https://raw.githubusercontent.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.workbuddy.host https://*.workbuddy.cn https://api.dictionaryapi.dev https://freedictionaryapi.com https://*.jsdelivr.net https://*.r2.dev; frame-ancestors 'none'",
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

  // 同源云代理：/wb-api/* → WorkBuddy .cloud（真 key 仅在此注入）
  if (url.pathname === PROXY_PREFIX || url.pathname.startsWith(PROXY_PREFIX + '/')) {
    proxyCloud(req, res, url, ip);
    return;
  }

  // TEMP 诊断路由：只调用 httpbin.org 回显沙箱出口实际发出的请求头（不含真实密钥）
  if (url.pathname === '/api/proxy-echo') {
    const payload = JSON.stringify({ probe: 'wb-egress' });
    const echoReq = https.request(
      {
        hostname: 'httpbin.org',
        port: 443,
        path: '/anything/wb-echo',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-wb-webapp-access-key': 'wbpk_REDACTED',
          'x-custom-probe': 'probe-1',
          origin: SITE_ORIGIN || 'https://unset',
          referer: (SITE_ORIGIN || 'https://unset') + '/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36',
        },
        timeout: 20000,
      },
      (echoRes) => {
        let body = '';
        echoRes.on('data', (d) => (body += d));
        echoRes.on('end', () => {
          writeHead(res, 200, { 'Content-Type': 'application/json' });
          res.end(body);
        });
      }
    );
    echoReq.on('timeout', () => echoReq.destroy(new Error('echo timeout')));
    echoReq.on('error', (e) => {
      writeHead(res, 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    echoReq.end(payload);
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
