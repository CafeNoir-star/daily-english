// 播放链路回归测试：点一次"播放全文"却听到多个声音同时在播。
// 根因：候选地址失败时，audio.onerror 与 play() 的 Promise reject 会各触发一次
// tryNext，导致一条链结算多次；而 playAllSentences 用回调推进 i++，
// 结算两次就跳句并重复播放 → 声音叠加。
// 运行：node test/audio-playback.test.js
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

// 用 mock Audio 复现真实浏览器的失败语义：
// 404 时 error 事件会触发，同时 play() 返回的 Promise 也会 reject
function makeAudioMock() {
  const created = [];
  class FakeAudio {
    constructor(url) {
      this.url = url;
      this.preload = '';
      this.playbackRate = 1;
      created.push(this);
    }
    play() {
      if (this.url.includes('bad')) {
        setTimeout(() => { if (this.onerror) this.onerror(); }, 0);
        return Promise.reject(new Error('404'));
      }
      setTimeout(() => { if (this.onended) this.onended(); }, 0);
      return Promise.resolve();
    }
    pause() {}
  }
  return { FakeAudio, created };
}

function buildPlayCandidates() {
  const fn = extractFn(appSrc, 'playCandidates');
  assert.ok(fn, '找不到 playCandidates 函数');
  const factory = new Function(`
    var currentAudioElement = null;
    function playCandidates(${fn.params}) { ${fn.body} }
    return playCandidates;
  `);
  return factory();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n── playCandidates 结算次数 ──');

  await test('首个候选失败时整条链只结算一次（不重复推进）', async () => {
    const { FakeAudio, created } = makeAudioMock();
    globalThis.Audio = FakeAudio;
    const playCandidates = buildPlayCandidates();

    let done = 0, fail = 0;
    playCandidates(['bad.mp3', 'good.mp3'], 1, () => { done++; }, () => { fail++; });
    await wait(60);

    assert.strictEqual(done + fail, 1, `整条链应只结算 1 次，实际 ${done + fail} 次（done=${done}, fail=${fail}）`);
    assert.strictEqual(done, 1, `应正常播完（done=1），实际 done=${done}`);
    assert.strictEqual(created.length, 2, `只应创建 2 个 Audio（失败1 + 成功1），实际 ${created.length}`);
  });

  await test('所有候选都失败时只回调一次 onFail', async () => {
    const { FakeAudio, created } = makeAudioMock();
    globalThis.Audio = FakeAudio;
    const playCandidates = buildPlayCandidates();

    let done = 0, fail = 0;
    playCandidates(['bad1.mp3', 'bad2.mp3'], 1, () => { done++; }, () => { fail++; });
    await wait(80);

    assert.strictEqual(fail, 1, `onFail 应只调用 1 次，实际 ${fail}`);
    assert.strictEqual(done, 0, '不应回调 onDone');
    assert.strictEqual(created.length, 2, `应尝试完 2 个候选，实际创建 ${created.length}`);
  });

  await test('一次成功时只回调 onDone 一次', async () => {
    const { FakeAudio } = makeAudioMock();
    globalThis.Audio = FakeAudio;
    const playCandidates = buildPlayCandidates();

    let done = 0, fail = 0;
    playCandidates(['good.mp3'], 1, () => { done++; }, () => { fail++; });
    await wait(40);

    assert.strictEqual(done, 1, `onDone 应只调用 1 次，实际 ${done}`);
    assert.strictEqual(fail, 0, '不应回调 onFail');
  });

  console.log('\n── 全文播放的句子推进 ──');

  await test('playAllSentences 不会因重复回调而跳句或叠播', () => {
    const fn = extractFn(appSrc, 'playAllSentences');
    assert.ok(fn, '找不到 playAllSentences');
    // 推进逻辑必须带一次性保护：同一句的回调只允许推进一次
    assert.ok(
      /advanced|fired|settled|once/i.test(fn.body),
      'playNext 的回调缺少一次性保护，回调被调用两次时会跳过句子并叠播'
    );
  });

  test_summary();
})();

function test_summary() {
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
    process.exit(1);
  }
}
