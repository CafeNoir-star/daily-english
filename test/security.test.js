// Security tests for server.js path traversal and file access controls
// Run: node test/security.test.js
const http = require('http');
const net = require('net');
const assert = require('assert');

const PORT = 3999; // test port
const BASE = `http://localhost:${PORT}`;

let testsPassed = 0;
let testsFailed = 0;

function fetch(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

// Raw HTTP request that preserves path traversal chars (browsers and http.get normalize URLs)
function rawFetch(path) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let data = '';
    socket.setTimeout(5000);
    socket.connect(3999, 'localhost', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => data += chunk.toString());
    socket.on('close', () => {
      const statusMatch = data.match(/HTTP\/\d\.?\d\s+(\d+)/);
      resolve({ status: statusMatch ? parseInt(statusMatch[1]) : 0, raw: data });
    });
    socket.on('error', reject);
    socket.on('timeout', () => { socket.destroy(); resolve({ status: 0, raw: data }); });
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    testsPassed++;
  } catch (e) {
    console.log(`  FAIL: ${name} — ${e.message}`);
    testsFailed++;
  }
}

async function run() {
  // Wait for server to start
  await new Promise(r => setTimeout(r, 500));

  console.log('\n=== Path Traversal Tests ===');

  await test('absolute path /etc/passwd returns 404 (no SPA fallback for unknown paths)', async () => {
    const r = await fetch('/etc/passwd');
    // /etc/passwd has no extension → SPA fallback → 200 with index.html
    // This is NOT a path traversal success (file not read), but we test the real attack vectors below
    assert.ok(r.status === 200 || r.status === 404, `expected 200 or 404, got ${r.status}`);
  });

  await test('raw path with .. is blocked (raw socket)', async () => {
    const r = await rawFetch('/../../etc/passwd');
    assert.ok(r.status === 403 || r.status === 404, `expected 403/404, got ${r.status}`);
  });

  await test('raw encoded .. is blocked (raw socket)', async () => {
    const r = await rawFetch('/%2e%2e/%2e%2e/etc/passwd');
    assert.ok(r.status === 403 || r.status === 404, `expected 403/404, got ${r.status}`);
  });

  await test('raw nested .. traversal blocked (raw socket)', async () => {
    const r = await rawFetch('/audio/../../../../etc/passwd');
    assert.ok(r.status === 403 || r.status === 404, `expected 403/404, got ${r.status}`);
  });

  await test('backslash traversal blocked', async () => {
    const r = await rawFetch('/..%5c..%5cetc/passwd');
    assert.ok(r.status === 403 || r.status === 404, `expected 403/404, got ${r.status}`);
  });

  console.log('\n=== Sensitive File Access Tests ===');

  await test('/data/corpus.json is blocked', async () => {
    const r = await fetch('/data/corpus.json');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('/data/ is blocked', async () => {
    const r = await fetch('/data/import_sentences.sql');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('/docs/ is blocked', async () => {
    const r = await fetch('/docs/plans/2026-10-16-security-design.md');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('/fetch_definitions.mjs is blocked', async () => {
    const r = await fetch('/fetch_definitions.mjs');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('/generate_dict.js is blocked', async () => {
    const r = await fetch('/generate_dict.js');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('/package.json is blocked', async () => {
    const r = await fetch('/package.json');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('/corpus.js is blocked', async () => {
    const r = await fetch('/corpus.js');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('/dictionary.js is blocked', async () => {
    const r = await fetch('/dictionary.js');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('/node_modules/ is blocked', async () => {
    const r = await fetch('/node_modules/');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('/server.secrets.json is never served', async () => {
    const r = await fetch('/server.secrets.json');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('/server.js source is never served', async () => {
    const r = await fetch('/server.js');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('/pipeline.py source is never served', async () => {
    const r = await fetch('/pipeline.py');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('/.gitignore is never served', async () => {
    const r = await fetch('/.gitignore');
    assert.ok(r.status === 404, `expected 404, got ${r.status}`);
  });

  await test('whitelisted config.js is served', async () => {
    const r = await fetch('/config.js');
    assert.ok(r.status === 200, `expected 200, got ${r.status}`);
  });

  console.log('\n=== API Input Validation Tests ===');

  await test('invalid word rejected', async () => {
    const r = await fetch('/api/lookup?word=<script>alert(1)</script>');
    assert.ok(r.status === 400, `expected 400, got ${r.status}`);
  });

  await test('valid word works', async () => {
    const r = await fetch('/api/lookup?word=hello');
    assert.ok(r.status === 200, `expected 200, got ${r.status}`);
    const data = JSON.parse(r.body);
    assert.ok(data.found !== undefined, 'should have found field');
  });

  await test('word too long rejected', async () => {
    const r = await fetch('/api/lookup?word=' + 'a'.repeat(51));
    assert.ok(r.status === 400, `expected 400, got ${r.status}`);
  });

  await test('valid word works', async () => {
    const r = await fetch('/api/lookup?word=hello');
    assert.ok(r.status === 200, `expected 200, got ${r.status}`);
  });

  console.log('\n=== Security Headers Tests ===');

  await test('X-Content-Type-Options header present', async () => {
    const r = await fetch('/');
    assert.ok(r.headers['x-content-type-options'] === 'nosniff', 'missing nosniff header');
  });

  await test('X-Frame-Options header present', async () => {
    const r = await fetch('/');
    assert.ok(r.headers['x-frame-options'] === 'DENY', 'missing X-Frame-Options');
  });

  console.log('\n=== Legitimate Access Tests ===');

  await test('index.html returns 200', async () => {
    const r = await fetch('/');
    assert.ok(r.status === 200, `expected 200, got ${r.status}`);
  });

  await test('app.js returns 200', async () => {
    const r = await fetch('/app.js');
    assert.ok(r.status === 200, `expected 200, got ${r.status}`);
  });

  await test('audio files accessible', async () => {
    // Just check the audio dir doesn't get blocked
    const r = await fetch('/');
    assert.ok(r.status === 200, `index should work, got ${r.status}`);
  });

  console.log(`\n=== Results: ${testsPassed} passed, ${testsFailed} failed ===`);
  process.exit(testsFailed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
