// 音频 CDN 缓存一致性：jsDelivr 按 URL 缓存，覆盖语料后同名 mp3 的内容会变，
// 但 CDN 仍返回旧文件（页面文字是新的、播放出来是旧的）。
// 实测：purge 接口对 Cloudflare 节点（cdn.jsdelivr.net）生效，对 gcore 节点无效。
// 运行：node test/audio-cdn.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.js');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'audio-sync.yml');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
    console.log(`  FAIL ${name} -> ${err.message}`);
  }
}

const config = fs.readFileSync(CONFIG, 'utf8');
const workflow = fs.readFileSync(WORKFLOW, 'utf8');

const baseMatch = config.match(/audioBase:\s*"([^"]*)"/);
const audioBase = baseMatch ? baseMatch[1] : '';

console.log('=== 音频 CDN 节点 ===');

test('audioBase 已配置', () => {
  assert.ok(audioBase, 'config.js 里应能找到 audioBase');
});

test('使用 purge 生效的 Cloudflare 节点', () => {
  assert.ok(
    audioBase.includes('//cdn.jsdelivr.net/'),
    `audioBase 应指向 cdn.jsdelivr.net（purge 对 CF 生效），当前是 ${audioBase}`
  );
});

test('不再指向 gcore 节点', () => {
  assert.ok(
    !audioBase.includes('gcore.jsdelivr.net'),
    'gcore 节点的缓存清不掉，覆盖语料后会播到旧音频'
  );
});

test('保留同源 /audio/ 作为回退', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.ok(
    /list\.push\('\/audio\/' \+ relative\)/.test(src),
    'app.js 的 audioCandidates 必须保留同源回退'
  );
});

console.log('\n=== 缓存清理步骤 ===');

test('workflow 含 Purge CDN cache 步骤', () => {
  assert.ok(/name:\s*Purge CDN cache/.test(workflow), '缺少 purge 步骤，覆盖后 CDN 不会刷新');
});

test('purge 在提交音频之后执行', () => {
  const commitIdx = workflow.indexOf('name: Commit audio');
  const purgeIdx = workflow.indexOf('name: Purge CDN cache');
  assert.ok(commitIdx > -1, '找不到 Commit audio 步骤');
  assert.ok(purgeIdx > commitIdx, 'purge 必须在音频提交之后，否则清的是旧文件的缓存');
});

test('purge 只处理本次变更的 mp3', () => {
  const purgeBlock = workflow.slice(workflow.indexOf('name: Purge CDN cache'));
  assert.ok(
    /git show --name-only|git diff --name-only/.test(purgeBlock),
    'purge 应基于本次提交的文件清单，而不是清全量'
  );
  assert.ok(/\*\.mp3/.test(purgeBlock), 'purge 应只针对 mp3 文件');
});

test('purge 走 jsDelivr 官方接口', () => {
  const purgeBlock = workflow.slice(workflow.indexOf('name: Purge CDN cache'));
  assert.ok(purgeBlock.includes('purge.jsdelivr.net'), '应调用 https://purge.jsdelivr.net/gh/<owner>/<repo>@main/<file>');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
  process.exit(1);
}
