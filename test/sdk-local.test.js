// 云 SDK 不能依赖外部 CDN：那台电脑访问不到 jsDelivr 时，WorkBuddyCloud 未加载
// → initCloud() 抛错 → auth 保持 null → 点"登录"报
// "Cannot read properties of null (reading 'signInWithPassword')"。
// 运行：node test/sdk-local.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

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

console.log('=== SDK 本地化 ===');

test('SDK 已随仓库提供', () => {
  const p = path.join(ROOT, 'vendor', 'workbuddy-cloud-sdk.js');
  assert.ok(fs.existsSync(p), '缺少 vendor/workbuddy-cloud-sdk.js');
  const size = fs.statSync(p).size;
  assert.ok(size > 50000, `SDK 文件过小（${size}B），可能是下载失败或占位文件`);
});

test('index.html 引用本地 SDK', () => {
  assert.ok(
    /<script src="vendor\/workbuddy-cloud-sdk\.js"><\/script>/.test(INDEX),
    'index.html 应通过同源 vendor/workbuddy-cloud-sdk.js 引入 SDK'
  );
});

test('index.html 不再从 jsDelivr 加载 SDK', () => {
  assert.ok(
    !/jsdelivr[^"']*workbuddy-cloud-sdk/.test(INDEX),
    'SDK 不能再从 CDN 加载——那台电脑拉不到时会直接登录失败'
  );
});

test('server.js 静态白名单放行 vendor/', () => {
  const m = SERVER.match(/ALLOWED_STATIC_PREFIXES\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, '找不到 ALLOWED_STATIC_PREFIXES');
  assert.ok(m[1].includes("'/vendor/'"), `白名单里没有 /vendor/，本地 SDK 会被 404：${m[1]}`);
});

console.log('\n=== 登录健壮性 ===');

test('handleAuth 在 auth 未就绪时会先初始化并给出可读提示', () => {
  const body = APP.slice(APP.indexOf('async function handleAuth'));
  // 用带 auth. 前缀的调用做锚点：注释里提到方法名时不会误匹配
  const signInIdx = body.indexOf('auth.signInWithPassword');
  assert.ok(signInIdx > 0, '找不到 auth.signInWithPassword 调用');
  const beforeSignIn = body.slice(0, signInIdx);

  const initIdx = beforeSignIn.indexOf('await initCloud()');
  assert.ok(
    initIdx > -1,
    'handleAuth 在调用 signInWithPassword 之前应先 await initCloud()，否则 SDK 没加载完就点登录会直接 TypeError'
  );
  assert.ok(
    /if\s*\(\s*!auth\s*\)/.test(beforeSignIn),
    'handleAuth 应显式判断 auth 是否可用，给出"正在连接云服务"之类的提示'
  );
  assert.ok(
    /!ready\s*\|\|\s*!auth/.test(beforeSignIn),
    '初始化失败后应中止并提示，不能继续走到 signInWithPassword'
  );
});

test('initCloud 失败时不留下半初始化状态', () => {
  const body = APP.slice(APP.indexOf('async function initCloud'));
  const fn = body.slice(0, body.indexOf('\n}', body.indexOf('catch')));
  assert.ok(/cloud\s*=\s*null/.test(fn), 'initCloud 失败后应把 cloud/auth/db 复位为 null，避免下次误判为已初始化');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  failures.forEach((f) => console.log(`  - ${f.name}: ${f.message}`));
  process.exit(1);
}
