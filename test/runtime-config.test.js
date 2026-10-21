// 运行时下发 publishableKey：仓库不含 key，浏览器在页面加载后向本站取配置。
// 运行：node test/runtime-config.test.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT_WITH_KEY = 3996;
const PORT_WITHOUT_KEY = 3995;
const TEST_KEY = 'wbpk_REDACTED';

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

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
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

function start(port, key) {
  const env = { ...process.env, PORT: String(port) };
  if (key) {
    env.WB_KEY = key;
  } else {
    delete env.WB_KEY;
    // 同时屏蔽本地密钥文件，模拟"未配置"的真实部署
    env.WB_SECRETS_FILE = path.join(ROOT, 'test', 'nonexistent-secrets.json');
  }
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

// 从 app.js 抽取前端函数体，用于在 Node 里直接测纯逻辑
function extractFn(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const bodyStart = i;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return { params: m[1], body: src.slice(bodyStart, i - 1) };
}

async function run() {
  const appWithKey = start(PORT_WITH_KEY, TEST_KEY);
  const appNoKey = start(PORT_WITHOUT_KEY, '');

  try {
    await waitFor(PORT_WITH_KEY);
    await waitFor(PORT_WITHOUT_KEY);

    console.log('\n── 1. 配置接口 ──');

    await test('配置接口返回 publishableKey', async () => {
      const r = await get(PORT_WITH_KEY, '/api/runtime-config');
      assert.strictEqual(r.status, 200, `期望 200，实际 ${r.status}`);
      const data = JSON.parse(r.body);
      assert.strictEqual(data.publishableKey, TEST_KEY);
    });

    await test('配置接口禁止缓存', async () => {
      const r = await get(PORT_WITH_KEY, '/api/runtime-config');
      assert.ok(/no-store/.test(r.headers['cache-control'] || ''), `cache-control=${r.headers['cache-control']}`);
    });

    await test('未配置密钥时返回 503 且不泄露内部信息', async () => {
      const r = await get(PORT_WITHOUT_KEY, '/api/runtime-config');
      assert.strictEqual(r.status, 503);
      assert.ok(!/wbpk_/.test(r.body), '响应里不应出现任何 key');
    });

    console.log('\n── 2. 前端运行时获取 ──');

    const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const fn = extractFn(appSrc, 'ensureRuntimeConfig');
    assert.ok(fn, 'app.js 缺少 ensureRuntimeConfig');

    const build = () => {
      const config = { publishableKey: '' };
      const factory = new Function('PUBLIC_CONFIG', 'fetch', 'fetchImpl', `return (async () => {${fn.body}})();`);
      return { config, call: (fetchImpl) => factory(config, fetchImpl, fetchImpl) };
    };

    await test('页面配置为空时从接口取回 key', async () => {
      const ctx = build();
      const ok = await ctx.call(async () => ({ ok: true, json: async () => ({ publishableKey: TEST_KEY }) }));
      assert.strictEqual(ok, true);
      assert.strictEqual(ctx.config.publishableKey, TEST_KEY);
    });

    await test('接口 404 时返回 false 且不写入', async () => {
      const ctx = build();
      const ok = await ctx.call(async () => ({ ok: false, json: async () => ({}) }));
      assert.strictEqual(ok, false);
      assert.strictEqual(ctx.config.publishableKey, '');
    });

    await test('返回非法 key 时拒绝采用', async () => {
      const ctx = build();
      const ok = await ctx.call(async () => ({ ok: true, json: async () => ({ publishableKey: 'not-a-key' }) }));
      assert.strictEqual(ok, false);
      assert.strictEqual(ctx.config.publishableKey, '');
    });

    await test('网络异常时返回 false，不抛错', async () => {
      const ctx = build();
      const ok = await ctx.call(async () => {
        throw new Error('network down');
      });
      assert.strictEqual(ok, false);
    });

    await test('已有 key 时不再请求接口', async () => {
      const config = { publishableKey: 'wbpk_already_there' };
      const factory = new Function('PUBLIC_CONFIG', 'fetch', 'fetchImpl', `return (async () => {${fn.body}})();`);
      let called = 0;
      const impl = async () => {
        called++;
        return { ok: true, json: async () => ({ publishableKey: TEST_KEY }) };
      };
      const ok = await factory(config, impl, impl);
      assert.strictEqual(ok, true);
      assert.strictEqual(called, 0, '不应重复请求');
    });

    console.log('\n── 3. 仓库与前端都不含真 key ──');

    await test('app.js 不含真实 publishableKey', async () => {
      assert.ok(!/wbpk_e6Oe[A-Za-z0-9_]+/.test(appSrc), 'app.js 仍硬编码真 key');
    });

    await test('app.js 通过 /api/runtime-config 取配置', async () => {
      assert.ok(appSrc.includes('/api/runtime-config'), 'app.js 未引用配置接口');
    });

    await test('server.js 不含真实 publishableKey', async () => {
      const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
      assert.ok(!/wbpk_e6Oe[A-Za-z0-9_]+/.test(src));
    });

    await test('server.secrets.json 已被 gitignore', async () => {
      const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
      assert.ok(/server\.secrets\.json/.test(gi));
    });
  } finally {
    appWithKey.kill();
    appNoKey.kill();
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
