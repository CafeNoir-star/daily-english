// 安全加固回归测试
// 运行前先启动服务：PORT=3999 node server.js
// 然后：node test/security-hardening.test.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} — ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name} — ${e.message}`);
    failed++;
  }
}

function fetchHeaders(p) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${p}`, (res) => {
      res.resume();
      res.on('end', () => resolve(res.headers));
    }).on('error', reject);
  });
}

// 从源码里提取具名函数的函数体（用于测试浏览器脚本中的纯函数）
function extractFn(src, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)\\s*\\{`);
  const m = re.exec(src);
  if (!m) return null;
  const bodyStart = m.index + m[0].length;
  let depth = 1;
  let i = bodyStart;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return { params: m[1], body: src.slice(bodyStart, i - 1) };
}

const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

function loadAppFn(name, injected) {
  const fn = extractFn(appSrc, name);
  assert(fn, `app.js 中缺少函数 ${name}`);
  const params = fn.params.split(',').map((s) => s.trim()).filter(Boolean);
  const names = Object.keys(injected || {});
  const values = names.map((k) => injected[k]);
  // 返回一个真正接受原函数参数的调用体，注入的变量作为闭包捕获
  return new Function(...names, `return function(${params.join(',')}) {${fn.body}};`)(...values);
}

console.log('── 1. XSS 防护：属性转义 ──');

test('escAttr 转义双引号（属性上下文的关键字符）', () => {
  const escAttr = loadAppFn('escAttr');
  assert.strictEqual(escAttr('a"b'), 'a&quot;b');
});

test('escAttr 转义单引号', () => {
  const escAttr = loadAppFn('escAttr');
  assert.strictEqual(escAttr("a'b"), 'a&#39;b');
});

test('escAttr 转义尖括号与和号，阻断标签注入', () => {
  const escAttr = loadAppFn('escAttr');
  const out = escAttr('<img src=x onerror=alert(1)>');
  assert(!out.includes('<') && !out.includes('>'), `尖括号未转义：${out}`);
});

test('escAttr 对 null/undefined 返回空串', () => {
  const escAttr = loadAppFn('escAttr');
  assert.strictEqual(escAttr(null), '');
  assert.strictEqual(escAttr(undefined), '');
});

test('app.js 不再把原始数据拼进 onclick 属性', () => {
  // 危险的旧写法：.replace(/'/g,"\\'") 只处理单引号，双引号可截断属性
  const bad = /onclick="[^"]*\$\{[^}]*\.replace\(\/'\/g/.test(appSrc);
  assert(!bad, '仍存在用 replace 单引号的 onclick 拼接，应改用 escAttr');
});

test('所有 onclick 中的动态插值都经过转义', () => {
  const lines = appSrc.split('\n');
  const offenders = [];
  lines.forEach((ln, idx) => {
    const m = ln.match(/onclick="[^"]*\$\{([^}]+)\}/g);
    if (!m) return;
    for (const hit of m) {
      const expr = /\$\{([^}]+)\}/.exec(hit)[1].trim();
      const safe = /^esc(Attr)?\(/.test(expr) || /^\d+$/.test(expr) || /^[a-z]$/i.test(expr);
      if (!safe) offenders.push(`L${idx + 1}: ${expr.slice(0, 60)}`);
    }
  });
  assert.strictEqual(offenders.length, 0, '未转义：\n    ' + offenders.join('\n    '));
});

console.log('── 2. 前端 LLM 调用配额 ──');

function makeQuota(store, limit, DateImpl) {
  const fn = extractFn(appSrc, 'llmQuota');
  assert(fn, 'app.js 中缺少函数 llmQuota');
  const factory = new Function(
    'localStorage', 'LLM_DAILY_LIMIT', 'Date',
    `return function() {${fn.body}};`
  );
  return factory(
    {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; }
    },
    limit,
    DateImpl || Date
  );
}

test('存在每日配额常量', () => {
  assert(/LLM_DAILY_LIMIT\s*=\s*\d+/.test(appSrc), 'app.js 未定义 LLM_DAILY_LIMIT');
});

test('配额未超限时允许调用', () => {
  const store = {};
  const quota = makeQuota(store, 5);
  const st = quota();
  assert.strictEqual(st.exceeded, false, '首次调用不应超限');
  assert.strictEqual(st.count, 0);
});

test('达到上限后 exceeded 为真', () => {
  const store = {};
  const quota = makeQuota(store, 2);
  quota().consume();
  quota().consume();
  const st = quota();
  assert.strictEqual(st.count, 2, `计数应为 2，实际 ${st.count}`);
  assert.strictEqual(st.exceeded, true, '达到上限后应标记超限');
});

test('跨天后配额自动重置', () => {
  const store = {};
  const Day1 = class extends Date { constructor() { super('2026-01-01T00:00:00Z'); } };
  const Day2 = class extends Date { constructor() { super('2026-01-02T00:00:00Z'); } };

  const q1 = makeQuota(store, 2, Day1);
  q1().consume();
  q1().consume();
  assert.strictEqual(q1().exceeded, true, '第一天应已超限');

  const q2 = makeQuota(store, 2, Day2);
  assert.strictEqual(q2().count, 0, '跨天后计数应归零');
  assert.strictEqual(q2().exceeded, false, '跨天后不应超限');
});

console.log('── 3. 安全响应头 ──');

(async () => {
  const h = await fetchHeaders('/');

  await testAsync('响应包含 Strict-Transport-Security', () => {
    assert(h['strict-transport-security'], '缺少 HSTS 头');
    assert(/max-age=\d+/.test(h['strict-transport-security']), 'HSTS 缺少 max-age');
  });

  await testAsync('响应包含 Permissions-Policy', () => {
    assert(h['permissions-policy'], '缺少 Permissions-Policy 头');
    assert(/camera=\(\)/.test(h['permissions-policy']), 'Permissions-Policy 未禁用 camera');
  });

  await testAsync('CSP 仍然存在且限制脚本来源', () => {
    const csp = h['content-security-policy'] || '';
    assert(csp.includes("script-src"), 'CSP 缺少 script-src');
    assert(csp.includes("'self'"), 'CSP 未限制为 self');
  });

  console.log('── 4. CI 供应链 ──');

  test('所有 actions 固定到完整 commit SHA', () => {
    const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/audio-sync.yml'), 'utf8');
    const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    assert(uses.length > 0, '未找到 uses 声明');
    const unpinned = uses.filter((u) => !/@[0-9a-f]{40}$/.test(u));
    assert.strictEqual(unpinned.length, 0, `未固定 SHA：${unpinned.join(', ')}`);
  });

  console.log('── 5. 示例配置 ──');

  test('.env.example 不含真实邮箱', () => {
    const env = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    assert(!/noir_cafe@163\.com/.test(env), '.env.example 仍含真实邮箱');
  });

  console.log(`\n==== Results: ${passed} passed, ${failed} failed ====`);
  process.exit(failed > 0 ? 1 : 0);
})();
