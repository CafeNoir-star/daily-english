// 前端三项修复的回归测试：
// 1) 朗读按钮不再把文本拼进 onclick（撇号会导致语法错误→点击无反应）
// 2) 缺释义生词统一显示「API 补充中」，不再出现失败提示
// 3) 计时只累计页面可见时长
// 运行：node test/ui-fixes.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

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

(async () => {
  console.log('\n── 1. 朗读不再经由 onclick 拼字符串 ──');

  await test('模板里没有 onclick="speak( 的文本拼接', async () => {
    assert.ok(!/onclick="speak\('/.test(appSrc), '仍存在 onclick="speak(\'...\')"');
  });

  await test('朗读按钮改用 data-say 属性', async () => {
    assert.ok(appSrc.includes('data-say='), '缺少 data-say');
  });

  await test('存在事件委托处理 data-say', async () => {
    assert.ok(/closest\('\[data-say\]'\)|closest\("\[data-say\]"\)/.test(appSrc), '缺少 data-say 委托');
  });

  await test('带撇号的句子经属性转义后仍是合法 HTML 属性', async () => {
    const fn = extractFn(appSrc, 'escAttr');
    assert.ok(fn, '缺少 escAttr');
    const factory = new Function(`return (${'function(text){' + fn.body + '}'})`)();
    const out = factory("It's a test");
    assert.ok(!out.includes("'"), "输出仍含裸单引号：" + out);
    assert.strictEqual(out, 'It&#39;s a test');
  });

  console.log('\n── 2. 音频候选与降级 ──');

  await test('CDN 前缀存在时返回“CDN + 同源”两个候选', async () => {
    const fn = extractFn(appSrc, 'audioCandidates');
    assert.ok(fn, '缺少 audioCandidates');
    const factory = new Function(`return (${'function(name, base){' + fn.body + '}'})`)();
    const list = factory('2026-10-21_s0.mp3', 'https://cdn.example/audio/');
    assert.deepStrictEqual(list, [
      'https://cdn.example/audio/2026-10-21_s0.mp3',
      '/audio/2026-10-21_s0.mp3',
    ]);
  });

  await test('无 CDN 前缀时只返回同源地址', async () => {
    const fn = extractFn(appSrc, 'audioCandidates');
    const factory = new Function(`return (${'function(name, base){' + fn.body + '}'})`)();
    assert.deepStrictEqual(factory('a.mp3', ''), ['/audio/a.mp3']);
  });

  await test('已是绝对 URL 时原样返回', async () => {
    const fn = extractFn(appSrc, 'audioCandidates');
    const factory = new Function(`return (${'function(name, base){' + fn.body + '}'})`)();
    assert.deepStrictEqual(factory('https://x/y.mp3', ''), ['https://x/y.mp3']);
  });

  console.log('\n── 3. 生词释义提示统一 ──');

  await test('代码里不再出现“补充失败”文案', async () => {
    assert.ok(!appSrc.includes('补充失败'), '仍存在 补充失败 文案');
  });

  await test('缺释义时显示 API 补充中', async () => {
    assert.ok(appSrc.includes('API'), '未出现 API 文案');
    // 源码里中文可能是字面量，也可能是 \uXXXX 转义，两种都接受
    const literal = /API[^`]{0,12}补充中|补充中[^`]{0,12}API/;
    const escaped = /API[^`]{0,20}\\u8865\\u5145\\u4E2D/;
    assert.ok(literal.test(appSrc) || escaped.test(appSrc), '未找到“API 补充中”文案');
  });

  await test('enrich 回调不再标记 enrichFailed', async () => {
    assert.ok(!appSrc.includes('enrichFailed'), '仍存在 enrichFailed');
  });

  console.log('\n── 4. 计时只累计可见时长 ──');

  await test('存在按可见性累计的 tickActive', async () => {
    const fn = extractFn(appSrc, 'tickActive');
    assert.ok(fn, '缺少 tickActive');
    const factory = new Function(`return (${'function(state, visible, step){' + fn.body + '}'})`)();
    const state = { seconds: 10 };
    factory(state, false, 1);
    assert.strictEqual(state.seconds, 10, '不可见时应停止累计');
    factory(state, true, 1);
    assert.strictEqual(state.seconds, 11, '可见时应累计');
  });

  await test('计时逻辑读取 document.visibilityState', async () => {
    assert.ok(/visibilityState/.test(appSrc), '未使用 visibilityState');
  });

  await test('监听 visibilitychange 以暂停/恢复', async () => {
    assert.ok(/visibilitychange/.test(appSrc), '未监听 visibilitychange');
  });

  await test('计时不从数据库 start_time 恢复整个自然日', async () => {
    assert.ok(!/studyStartTime\s*=\s*new Date\(logs\[0\]\.start_time\)/.test(appSrc), '仍按 start_time 计算');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\n失败详情：');
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
    process.exit(1);
  }
})();
