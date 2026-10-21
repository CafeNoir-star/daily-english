// 待补词队列测试：确认前端不再直接调用大模型
// 运行：node test/enrich-queue.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const pipeSrc = fs.readFileSync(path.join(ROOT, 'pipeline.py'), 'utf8');
const wfSrc = fs.readFileSync(path.join(ROOT, '.github/workflows/audio-sync.yml'), 'utf8');

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

console.log('── 1. 前端不再直连大模型 ──');

test('app.js 中没有 chat.completions.create', () => {
  assert(!/chat\.completions\.create/.test(appSrc), '仍存在直接调用大模型的代码');
});

test('app.js 中没有 LLM 批量查询函数', () => {
  assert(!/function llmLookupWordsBatch/.test(appSrc), 'llmLookupWordsBatch 仍存在');
});

test('app.js 不再包含每日配额逻辑（已无调用可限）', () => {
  assert(!/LLM_DAILY_LIMIT/.test(appSrc), 'LLM_DAILY_LIMIT 仍存在');
});

console.log('── 2. 改为写入待补队列 ──');

test('存在 queuePendingWords 函数', () => {
  assert(/function queuePendingWords|async function queuePendingWords/.test(appSrc), '缺少 queuePendingWords');
});

test('queuePendingWords 写入 pending_words 表', () => {
  const m = /async function queuePendingWords[\s\S]{0,900}?\n\}/.exec(appSrc);
  assert(m, '未找到函数体');
  assert(/pending_words/.test(m[0]), '函数体内未引用 pending_words');
});

test('缺释义词会进入队列而非被丢弃', () => {
  // enrichWordsFromDBorLLM 中应调用 queuePendingWords
  const m = /async function enrichWordsFromDBorLLM[\s\S]{0,900}?\n\}/.exec(appSrc);
  assert(m, '未找到 enrichWordsFromDBorLLM');
  assert(/queuePendingWords/.test(m[0]), 'enrichWordsFromDBorLLM 未把词放进队列');
});

console.log('── 3. 流水线补齐 ──');

test('pipeline.py 支持 --enrich-pending', () => {
  assert(/--enrich-pending/.test(pipeSrc), '缺少 CLI 参数');
});

test('pipeline.py 有 fetch_pending_words 函数', () => {
  assert(/def fetch_pending_words/.test(pipeSrc), '缺少 fetch_pending_words');
});

test('pipeline.py 有 parse_word_payload 函数', () => {
  assert(/def parse_word_payload/.test(pipeSrc), '缺少 parse_word_payload');
});

test('pipeline.py 有 upsert_words / 删除待补记录的逻辑', () => {
  assert(/pending_words/.test(pipeSrc), 'pipeline 未引用 pending_words');
});

console.log('── 4. 工作流接入 ──');

test('audio-sync.yml 包含补齐待补词的步骤', () => {
  assert(/enrich/i.test(wfSrc) && /--enrich-pending/.test(wfSrc), '工作流未调用 --enrich-pending');
});

console.log(`\n==== Results: ${passed} passed, ${failed} failed ====`);
process.exit(failed > 0 ? 1 : 0);
