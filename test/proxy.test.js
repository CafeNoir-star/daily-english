// 同源代理与密钥隔离测试
// 目标：公开的 publishableKey 不再具备调用大模型的能力，真 key 只存在于服务端。
// 运行：node test/proxy.test.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3998;
const UPSTREAM_PORT = 4107;
const REAL_KEY = 'wbpk_REDACTED';
const PLACEHOLDER = 'wbpk_REDACTED';
const SITE_ORIGIN = 'https://site.example.test';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok   ${name}`);
    })
    .catch((err) => {
      failed++;
      failures.push({ name, message: err.message });
      console.log(`  FAIL ${name} -> ${err.message}`);
    });
}

function request(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: options.method || 'GET', headers: options.headers || {} },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (options.body) req.write(options.body);
    req.end();
  });
}

function waitFor(port, attempts = 60) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      n++;
      if (n >= attempts) return reject(new Error(`port ${port} 未就绪`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function waitUpstream(port, attempts = 60) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/ping', timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      n++;
      if (n >= attempts) return reject(new Error(`upstream ${port} 未就绪`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function startUpstream() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('pong');
      }
      if (req.url.includes('/missing')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          path: req.url,
          method: req.method,
          body,
          seen: {
            key: req.headers['x-wb-webapp-access-key'] || '',
            origin: req.headers.origin || '',
            authorization: req.headers.authorization || '',
            referer: req.headers.referer || '',
          },
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(server)));
}

function startApp() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      WB_KEY: REAL_KEY,
      WB_ENDPOINT: `http://127.0.0.1:${UPSTREAM_PORT}`,
      WB_SITE_ORIGIN: SITE_ORIGIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

async function run() {
  const upstream = await startUpstream();
  await waitUpstream(UPSTREAM_PORT);
  const app = startApp();

  try {
    await waitFor(APP_PORT);
    console.log('\n── 1. 代理必须拒绝大模型接口 ──');

    await test('GET /wb-api/.cloud/llm/models 返回 403', async () => {
      const r = await request(APP_PORT, '/wb-api/.cloud/llm/models');
      assert.strictEqual(r.status, 403, `期望 403，实际 ${r.status}`);
    });

    await test('POST /wb-api/.cloud/llm/chat/completions 返回 403', async () => {
      const r = await request(APP_PORT, '/wb-api/.cloud/llm/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"model":"x","messages":[]}',
      });
      assert.strictEqual(r.status, 403, `期望 403，实际 ${r.status}`);
    });

    await test('非白名单路径（storage）返回 403', async () => {
      const r = await request(APP_PORT, '/wb-api/.cloud/storage/bucket');
      assert.strictEqual(r.status, 403, `期望 403，实际 ${r.status}`);
    });

    await test('路径穿越 /database/rest/../../x 返回 403', async () => {
      const r = await request(APP_PORT, '/wb-api/.cloud/database/rest/%2e%2e/%2e%2e/etc');
      assert.strictEqual(r.status, 403, `期望 403，实际 ${r.status}`);
    });

    console.log('\n── 2. 白名单请求正确转发 ──');

    await test('读语料转发成功且原样返回上游 JSON', async () => {
      const r = await request(APP_PORT, '/wb-api/.cloud/database/rest/daily_sentences?select=date');
      assert.strictEqual(r.status, 200, `期望 200，实际 ${r.status}`);
      const data = JSON.parse(r.body);
      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.path, '/.cloud/database/rest/daily_sentences?select=date', '查询串必须原样转发');
    });

    await test('上游收到的是真 key，而不是浏览器占位串', async () => {
      const r = await request(APP_PORT, '/wb-api/.cloud/database/rest/word_dictionary?limit=1', {
        headers: { 'x-wb-webapp-access-key': PLACEHOLDER },
      });
      const seen = JSON.parse(r.body).seen;
      assert.strictEqual(seen.key, REAL_KEY, `上游收到 ${seen.key}`);
    });

    await test('auth 转发带 Origin/Referer，database 转发不带', async () => {
      const auth = await request(APP_PORT, '/wb-api/.cloud/auth/v1/signin', { method: 'POST', body: '{}' });
      const authSeen = JSON.parse(auth.body).seen;
      assert.strictEqual(authSeen.origin, SITE_ORIGIN, 'auth 必须补 Origin');
      const db = await request(APP_PORT, '/wb-api/.cloud/database/rest/daily_sentences?select=date');
      const dbSeen = JSON.parse(db.body).seen;
      assert.strictEqual(dbSeen.origin, '', 'database 不应携带 Origin');
    });

    await test('登录态 Authorization 头原样透传', async () => {
      const r = await request(APP_PORT, '/wb-api/.cloud/database/rest/vocabulary', {
        headers: { Authorization: 'Bearer token-abc' },
      });
      assert.strictEqual(JSON.parse(r.body).seen.authorization, 'Bearer token-abc');
    });

    await test('上游 4xx 状态原样返回', async () => {
      const r = await request(APP_PORT, '/wb-api/.cloud/database/rest/missing');
      assert.strictEqual(r.status, 404, `期望 404，实际 ${r.status}`);
    });

    await test('POST body 原样转发', async () => {
      const payload = JSON.stringify([{ word: 'beacon' }]);
      const r = await request(APP_PORT, '/wb-api/.cloud/database/rest/word_dictionary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      assert.strictEqual(JSON.parse(r.body).body, payload);
    });

    await test('请求体过大返回 413', async () => {
      const big = 'x'.repeat(2 * 1024 * 1024);
      const r = await request(APP_PORT, '/wb-api/.cloud/database/rest/word_dictionary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: big,
      });
      assert.ok([413, 403].includes(r.status), `期望 413/403，实际 ${r.status}`);
    });

    console.log('\n── 3. 其他路由不受影响 ──');

    await test('/api/health 仍然可用', async () => {
      const r = await request(APP_PORT, '/api/health');
      assert.strictEqual(r.status, 200);
    });

    await test('首页正常', async () => {
      const r = await request(APP_PORT, '/');
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.includes('<html'));
    });

    console.log('\n── 4. 密钥不出现在前端与仓库 ──');

    await test('app.js 不含真实 key', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
      assert.ok(!/wbpk_e6Oe[A-Za-z0-9_]+/.test(src), 'app.js 里仍有真实 publishableKey');
    });

    await test('app.js 指向同源代理而非 WorkBuddy 域名', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
      assert.ok(src.includes('/wb-api'), 'app.js 未使用 /wb-api 前缀');
      assert.ok(!/daily-english-\d+\.app\.workbuddy\.host/.test(src), 'app.js 仍硬编码 WorkBuddy 域名');
    });

    await test('server.js 不含真实 key', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
      assert.ok(!/wbpk_e6Oe[A-Za-z0-9_]+/.test(src), 'server.js 里仍有真实 publishableKey');
    });

    await test('server.secrets.json 已被 gitignore', async () => {
      const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
      assert.ok(/server\.secrets\.json/.test(gi), '.gitignore 未排除 server.secrets.json');
    });
  } finally {
    app.kill();
    upstream.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\n失败详情：');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('测试运行失败：', err);
  process.exit(1);
});
