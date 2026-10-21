// ========================================================================
// CONFIG
// ========================================================================
const PUBLIC_CONFIG = {
  endpoint: "https://daily-english-38358.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_REDACTED"
};

// Cloud 端点：留空直连 WorkBuddy；Render 部署时在 config.js 里设 "same-origin" 走本站反代
const CLOUD_ENDPOINT = (function resolveCloudEndpoint() {
  const raw = (window.APP_CONFIG && window.APP_CONFIG.cloudEndpoint) || '';
  if (raw === 'same-origin') return window.location.origin;
  return raw || PUBLIC_CONFIG.endpoint;
})();

// 音频 CDN 前缀（config.js 可覆盖；留空则使用站点同目录 audio/）
const AUDIO_BASE = String((window.APP_CONFIG && window.APP_CONFIG.audioBase) || '').replace(/\/+$/, '');
function audioSrc(name) {
  if (!name) return '';
  const value = String(name);
  if (/^(https?:)?\/\//.test(value) || value.startsWith('data:')) return value;
  const relative = value.replace(/^\/?audio\//, '');
  return AUDIO_BASE ? `${AUDIO_BASE}/${relative}` : `audio/${relative}`;
}

// 生词音频文件名（与 pipeline.py 的 safe_word 保持一致）
function wordAudioFile(word) {
  const safe = String(word).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `vocab_${safe}.mp3`;
}
let cloud = null, db = null, llm = null, auth = null;
let currentUser = null;
let todayDate = (function() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })();
let studyStartTime = null, studyTimerInterval = null;
let currentPhase = 0;
let todayData = null;
let markedWords = new Set();
let todayVocab = [];
let speechVoices = [];
let authMode = 'login';
let llmModelId = null;
let isPhaseInitialized = false; // Fix: prevent phase reset on tab switch
let wordAudioCache = new Map(); // word -> audio_url (from dictionary API)

const SRS_INTERVALS = { 1: [0, 0.02, 0.1], 2: [1, 3, 7], 3: [14, 30, 90], 4: [180, 365] };

// Security: 前端调用大模型的每日上限。publishableKey 必须公开，无法阻止
// 脚本直接调用，这里只用于约束正常用户、降低误触发的积分消耗。
const LLM_DAILY_LIMIT = 50;

// 读取/消耗当日 LLM 配额。返回对象带 consume()，写入失败时静默降级。
function llmQuota() {
  const KEY = 'llmDailyCount';
  const today = new Date().toISOString().slice(0, 10);
  let rec = {};
  try {
    rec = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch (e) {
    rec = {};
  }
  const count = rec.date === today ? (Number(rec.count) || 0) : 0;
  const state = {
    today: today,
    count: count,
    limit: LLM_DAILY_LIMIT,
    exceeded: count >= LLM_DAILY_LIMIT
  };
  state.consume = function () {
    try {
      localStorage.setItem(KEY, JSON.stringify({ date: today, count: count + 1 }));
    } catch (e) { /* 存储不可用时不影响主流程 */ }
    return state;
  };
  return state;
}

// Security: HTML escape function for all dynamic data inserted into innerHTML
function esc(text) {
  if (text == null) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// Security: 属性上下文专用转义。esc() 只处理 & < >，无法防止双引号截断
// HTML 属性，因此凡是要拼进 onclick="..." 的值都必须走这个函数。
function escAttr(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ========================================================================
// THEME
// ========================================================================
function initTheme() {
  const saved = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = saved === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19';
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  document.getElementById('themeBtn').textContent = next === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19';
}

// ========================================================================
// CLOUD INIT
// ========================================================================
async function initCloud() {
  if (cloud) return true;
  try {
    cloud = WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: CLOUD_ENDPOINT,
      oauthRelayBaseUrl: PUBLIC_CONFIG.oauthRelayBaseUrl,
      publishableKey: PUBLIC_CONFIG.publishableKey
    });
    db = cloud.database;
    llm = cloud.llm;
    auth = cloud.auth;
    return true;
  } catch (e) {
    console.error('Cloud init failed:', e);
    showToast('\u4E91\u670D\u52A1\u8FDE\u63A5\u5931\u8D25');
    return false;
  }
}

// ========================================================================
// AUTH
// ========================================================================
async function checkSession() {
  if (!await initCloud()) return false;
  try {
    const { data: session, error } = await auth.getSession();
    if (error || !session) return false;
    currentUser = session.user;
    // Load username from user_profiles
    try {
      const profiles = await dbSelect('user_profiles', 'username', {});
      if (profiles.length > 0) currentUser.username = profiles[0].username;
    } catch (e) { console.warn('Failed to load username:', e); }
    return true;
  } catch (e) { return false; }
}

function showAuth() {
  document.getElementById('authOverlay').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}
function showApp() {
  document.getElementById('authOverlay').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  initTheme();
  initSpeech();
  isPhaseInitialized = false;
  currentPhase = 0;
  todayData = null;
  todayVocab = [];
  markedWords.clear();
  // Start timer immediately (before tab data loads) to avoid delay
  initStudyTimer();
  // Restore which tab the user was on
  const tab = restoreTab();
  if (tab === 'today') loadToday();
  else if (tab === 'vocab') loadVocab();
  else if (tab === 'review') loadReview();
  else if (tab === 'dashboard') loadDashboard();
  loadStreak();
  // Set username badge after a tick to ensure DOM is ready
  setTimeout(() => {
    if (currentUser) {
      const badge = document.getElementById('userBadge');
      if (badge) {
        const name = currentUser.username || currentUser.name || (currentUser.email ? currentUser.email.split('@')[0] : '');
        badge.textContent = name;
      }
    }
  }, 50);
}

function switchAuthTab(mode) {
  authMode = mode;
  document.getElementById('tabLogin').classList.toggle('active', mode === 'login');
  document.getElementById('tabRegister').classList.toggle('active', mode === 'register');
  document.getElementById('confirmField').style.display = mode === 'register' ? 'block' : 'none';
  document.getElementById('usernameField').style.display = mode === 'register' ? 'block' : 'none';
  document.getElementById('authSubmit').textContent = mode === 'login' ? '\u767B\u5F55' : '\u6CE8\u518C';
  document.getElementById('authError').textContent = '';
}

async function handleAuth() {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const confirm = document.getElementById('authConfirm').value;
  const username = document.getElementById('authUsername')?.value.trim() || '';
  const errEl = document.getElementById('authError');
  errEl.textContent = '';
  if (!email || !email.includes('@')) { errEl.textContent = '\u8BF7\u8F93\u5165\u6709\u6548\u7684\u90AE\u7BB1'; return; }
  if (!password || password.length < 6) { errEl.textContent = '\u5BC6\u7801\u81F3\u5C116\u4F4D'; return; }
  if (authMode === 'register' && !username) { errEl.textContent = '\u8BF7\u8F93\u5165\u7528\u6237\u540D'; return; }
  const btn = document.getElementById('authSubmit');
  btn.disabled = true; btn.textContent = '\u5904\u7406\u4E2D...';
  try {
    if (authMode === 'register') {
      if (password !== confirm) { errEl.textContent = '\u4E24\u6B21\u5BC6\u7801\u4E0D\u4E00\u81F4'; btn.disabled = false; btn.textContent = '\u6CE8\u518C'; return; }
      const sent = await auth.sendOtp({ email });
      if (sent.error) { errEl.textContent = sent.error.message; btn.disabled = false; btn.textContent = '\u6CE8\u518C'; return; }
      const code = prompt(`\u9A8C\u8BC1\u7801\u5DF2\u53D1\u9001\u5230 ${email}\uFF0C\u8BF7\u8F93\u51656\u4F4D\u9A8C\u8BC1\u7801\u5B8C\u6210\u6CE8\u518C\uFF1A`);
      if (!code) { btn.disabled = false; btn.textContent = '\u6CE8\u518C'; return; }
      const completed = await auth.verifyOtp({ email, verificationId: sent.data.verificationId, isExistingUser: sent.data.isExistingUser, token: code, password });
      if (completed.error) { errEl.textContent = completed.error.message; btn.disabled = false; btn.textContent = '\u6CE8\u518C'; return; }
      currentUser = completed.data.user;
      // Save username to user_profiles
      await dbInsert('user_profiles', { username: username });
      currentUser.username = username;
      showToast('\u6CE8\u518C\u6210\u529F\uFF01');
    } else {
      const { data: session, error } = await auth.signInWithPassword({ email, password });
      if (error) { errEl.textContent = error.message; btn.disabled = false; btn.textContent = '\u767B\u5F55'; return; }
      currentUser = session.user;
      // Load username from user_profiles
      const profiles = await dbSelect('user_profiles', 'username', {});
      if (profiles.length > 0) currentUser.username = profiles[0].username;
      showToast('\u767B\u5F55\u6210\u529F\uFF01');
    }
    showApp();
  } catch (e) {
    errEl.textContent = e.message || '\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5';
    btn.disabled = false; btn.textContent = authMode === 'login' ? '\u767B\u5F55' : '\u6CE8\u518C';
  }
}

async function handleLogout() {
  if (!auth) return;
  try { await auth.signOut(); } catch (e) {}
  currentUser = null; studyStartTime = null;
  if (studyTimerInterval) clearInterval(studyTimerInterval);
  showAuth();
}

// ========================================================================
// DB HELPERS
// ========================================================================
async function dbSelect(table, sel = '*', filters = {}, order = null, limit = null) {
  let q = db.from(table).select(sel);
  for (const [c, v] of Object.entries(filters)) { if (v != null) q = q.eq(c, v); }
  if (order) q = q.order(order.col, { ascending: order.ascending });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) console.error('DB select:', table, error);
  return data || [];
}
async function dbInsert(table, row) {
  const { data, error } = await db.from(table).insert(row).select();
  if (error) console.error('DB insert:', table, error);
  return data ? data[0] : null;
}
async function dbUpdate(table, updates, filters) {
  let q = db.from(table).update(updates);
  for (const [c, v] of Object.entries(filters)) q = q.eq(c, v);
  const { data, error } = await q.select();
  if (error) console.error('DB update:', table, error);
  return data || [];
}
async function dbDelete(table, filters) {
  let q = db.from(table).delete();
  for (const [c, v] of Object.entries(filters)) q = q.eq(c, v);
  const { data, error } = await q.select();
  if (error) console.error('DB delete:', table, error);
  return data || [];
}

// ========================================================================
// CORPUS SYNC - removed, now handled by backend /api/today
// ========================================================================

// ========================================================================
// TTS - Pre-generated audio files + Web Speech API fallback
// ========================================================================
function initSpeech() {
  if ('speechSynthesis' in window) {
    const loadVoices = () => { speechVoices = speechSynthesis.getVoices(); };
    loadVoices();
    if (typeof speechSynthesis.onvoiceschanged !== 'undefined') {
      speechSynthesis.onvoiceschanged = loadVoices;
    }
    let tries = 0;
    const poll = setInterval(() => {
      speechVoices = speechSynthesis.getVoices();
      if (speechVoices.length > 0 || tries > 10) clearInterval(poll);
      tries++;
    }, 200);
  }
}

let currentAudioElement = null;
let isPlayingAll = false;

function stopAllAudio() {
  isPlayingAll = false;
  if (currentAudioElement) {
    currentAudioElement.pause();
    currentAudioElement.currentTime = 0;
    currentAudioElement = null;
  }
  if ('speechSynthesis' in window) {
    speechSynthesis.cancel();
  }
}

// Pre-loaded audio cache for current day's sentences
let sentenceAudioCache = {};
let wordAudioObjectCache = {}; // word -> Audio object (preloaded)

function preloadSentenceAudio() {
  if (!todayData || !todayData.sentences) return;
  sentenceAudioCache = {};
  todayData.sentences.forEach((sent, i) => {
    const path = audioSrc(`${todayData.date}_s${i}.mp3`);
    const audio = new Audio(path);
    audio.preload = 'auto';
    // Force browser to start downloading by setting src explicitly
    audio.src = path;
    audio.load();
    sentenceAudioCache[i] = audio;
  });
  // Also preload full text audio
  if (todayData.english_text) {
    const fullPath = audioSrc(`${todayData.date}_full.mp3`);
    const fullAudio = new Audio(fullPath);
    fullAudio.preload = 'auto';
    fullAudio.src = fullPath;
    fullAudio.load();
    sentenceAudioCache[-1] = fullAudio; // use -1 as key for full text
  }
}

// Preload word audio when audio_url is known (called from prepareVocabLearning and loadVocab)
function preloadWordAudio(word, audioUrl) {
  const wordLower = word.toLowerCase();
  const src = audioSrc(audioUrl);
  if (!wordAudioObjectCache[wordLower] && src) {
    const audio = new Audio(src);
    audio.preload = 'auto';
    audio.src = src;
    audio.load();
    wordAudioObjectCache[wordLower] = audio;
  }
}

// Internal speak - does NOT reset isPlayingAll (used by playAllSentences chain)
function speakInternal(text, rate, onend) {
  if (!text) return;
  // Stop any current single playback (but don't touch isPlayingAll)
  if (currentAudioElement) {
    currentAudioElement.pause();
    currentAudioElement.currentTime = 0;
    currentAudioElement = null;
  }
  if ('speechSynthesis' in window) {
    speechSynthesis.cancel();
  }
  const r = rate || 1;

  // Sentence audio: use pre-loaded MP3 files
  if (todayData && todayData.sentences) {
    const sentIdx = todayData.sentences.indexOf(text);
    if (sentIdx >= 0) {
      let audio = sentenceAudioCache[sentIdx] || new Audio(audioSrc(`${todayData.date}_s${sentIdx}.mp3`));
      audio.currentTime = 0;
      currentAudioElement = audio;
      audio.addEventListener('loadedmetadata', () => { audio.playbackRate = r; });
      audio.playbackRate = r;
      audio.onended = () => { currentAudioElement = null; if (onend) onend(); };
      audio.onerror = () => { currentAudioElement = null; if (onend) onend(); };
      audio.play().catch(() => { currentAudioElement = null; if (onend) onend(); });
      return;
    }
  }
  // Full text audio
  if (todayData && text === todayData.english_text) {
    let audio = sentenceAudioCache[-1] || new Audio(audioSrc(`${todayData.date}_full.mp3`));
    audio.currentTime = 0;
    currentAudioElement = audio;
    audio.addEventListener('loadedmetadata', () => { audio.playbackRate = r; });
    audio.playbackRate = r;
    audio.onended = () => { currentAudioElement = null; if (onend) onend(); };
    audio.onerror = () => { currentAudioElement = null; if (onend) onend(); };
    audio.play().catch(() => { currentAudioElement = null; if (onend) onend(); });
    return;
  }

  // Word audio: priority is word_dictionary table (via cache or async query)
  if (text && /^[a-zA-Z]+$/.test(text.trim())) {
    // Step 1: Check memory cache first
    const cachedUrl = getWordAudioUrl(text);
    if (cachedUrl) {
      // Use preloaded Audio object if available (instant playback)
      const wordLower = text.trim().toLowerCase();
      let audio = wordAudioObjectCache[wordLower];
      if (audio) {
        audio.currentTime = 0;
        currentAudioElement = audio;
        audio.playbackRate = r;
        audio.onended = () => { currentAudioElement = null; if (onend) onend(); };
        audio.onerror = () => { currentAudioElement = null; if (onend) onend(); };
        audio.play().catch(() => { currentAudioElement = null; if (onend) onend(); });
      } else {
        playOnlineAudio(cachedUrl, r, onend, text);
      }
      return;
    }
    // Step 2: Cache miss - async query word_dictionary table
    speakWordFromDB(text, r, onend);
    return;
  }

  // Not a word and not a sentence - try Web Speech (desktop only)
  ttsApiFallback(text, r, onend);
}

// Play audio from an online URL (dictionary API) - reuse preloaded Audio if available
function playOnlineAudio(url, rate, onend, fallbackText) {
  try {
    url = audioSrc(url);
    if (!url) {
      showNoAudio(fallbackText);
      if (onend) onend();
      return;
    }
    // Try to reuse preloaded Audio object for word audio
    let audio = null;
    if (fallbackText && /^[a-zA-Z]+$/.test(fallbackText.trim())) {
      const wordLower = fallbackText.trim().toLowerCase();
      audio = wordAudioObjectCache[wordLower];
    }
    if (!audio) {
      audio = new Audio(url);
      audio.preload = 'auto';
      // Cache for future use
      if (fallbackText && /^[a-zA-Z]+$/.test(fallbackText.trim())) {
        wordAudioObjectCache[fallbackText.trim().toLowerCase()] = audio;
      }
    }
    audio.currentTime = 0;
    currentAudioElement = audio;
    audio.addEventListener('loadedmetadata', () => { audio.playbackRate = rate; });
    audio.playbackRate = rate;
    audio.onended = () => { currentAudioElement = null; if (onend) onend(); };
    audio.onerror = () => { currentAudioElement = null; showNoAudio(fallbackText); if (onend) onend(); };
    audio.play().catch(() => { currentAudioElement = null; showNoAudio(fallbackText); if (onend) onend(); });
  } catch (e) {
    showNoAudio(fallbackText);
    if (onend) onend();
  }
}

// No audio available - notify user
function showNoAudio(text) {
  if (text && /^[a-zA-Z]+$/.test(text.trim())) {
    showToast('\u8BE5\u5355\u8BCD\u6682\u65E0\u53D1\u97F3');
  }
}

// Fallback: try Web Speech if available (desktop only), otherwise silent
function ttsApiFallback(text, rate, onend) {
  if ('speechSynthesis' in window && speechSynthesis.getVoices().length > 0) {
    webSpeechFallback(text, rate || 1, onend);
  } else {
    showNoAudio(text);
    if (onend) onend();
  }
}

function speak(text, rate, onend) {
  if (!text) return;
  stopAllAudio();
  speakInternal(text, rate, onend);
}

// Get audio path for sentences only (words use word_dictionary table)
function getAudioPath(text) {
  if (todayData && todayData.sentences) {
    const sentIdx = todayData.sentences.indexOf(text);
    if (sentIdx >= 0) return audioSrc(`${todayData.date}_s${sentIdx}.mp3`);
  }
  if (todayData && text === todayData.english_text) {
    return audioSrc(`${todayData.date}_full.mp3`);
  }
  return null;
}

// Check if a word has an audio URL (from cache)
// If not in cache, async query word_dictionary table and play when ready
function getWordAudioUrl(text) {
  if (text && /^[a-zA-Z]+$/.test(text.trim())) {
    return wordAudioCache.get(text.trim().toLowerCase()) || null;
  }
  return null;
}

// Async: query word_dictionary table for audio_url, then play
async function speakWordFromDB(text, rate, onend) {
  const word = text.trim().toLowerCase();
  try {
    if (!db) { if (!await initCloud()) { showNoAudio(text); if (onend) onend(); return; } }
    const rows = await dbSelect('word_dictionary', 'audio_url', { word });
    if (rows.length > 0 && rows[0].audio_url) {
      wordAudioCache.set(word, rows[0].audio_url);
      // Preload and cache the Audio object for instant playback next time
      preloadWordAudio(word, rows[0].audio_url);
      playOnlineAudio(rows[0].audio_url, rate, onend, text);
      return;
    }
  } catch (e) {}
  showNoAudio(text);
  if (onend) onend();
}

// For texts without pre-generated audio, use the /tts backend API
function getTTSUrl(text, rate) {
  const r = rate || 1;
  return `/tts?text=${encodeURIComponent(text)}&rate=${r}`;
}

function webSpeechFallback(text, rate, onend) {
  if ('speechSynthesis' in window) {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US'; u.rate = rate || 1; u.volume = 1; u.pitch = 1;
      const voices = speechVoices.length > 0 ? speechVoices : speechSynthesis.getVoices();
      if (voices.length > 0) {
        u.voice = voices.find(v => v.lang === 'en-US') || voices.find(v => v.lang.startsWith('en')) || voices[0];
      }
      if (onend) u.onend = onend;
      u.onerror = () => { if (onend) onend(); };
      speechSynthesis.speak(u);
      return;
    } catch (e) { console.warn('Web Speech failed', e); }
  }
  if (onend) onend();
}

function playAllSentences(rate) {
  stopAllAudio();
  const r = rate || parseFloat(document.getElementById('listenSpeed')?.value || 1);
  const sents = todayData?.sentences || [];
  if (sents.length === 0) return;
  isPlayingAll = true;
  let i = 0;
  function playNext() {
    if (!isPlayingAll || i >= sents.length) { isPlayingAll = false; return; }
    // Use speakInternal (NOT speak) to avoid resetting isPlayingAll
    speakInternal(sents[i], r, () => {
      if (!isPlayingAll) return;
      i++;
      if (i < sents.length) playNext();
      else isPlayingAll = false;
    });
  }
  playNext();
}

function stopPlayback() {
  stopAllAudio();
  showToast('\u5DF2\u505C\u6B62\u64AD\u653E');
}

// ========================================================================
// LLM WORD LOOKUP - Optimized for speed
// ========================================================================
async function getLLMModel() {
  if (llmModelId) return llmModelId;
  if (!llm) return null;
  try {
    const models = await llm.models.list();
    const model = models.find(m => m.disabled !== true);
    if (model) { llmModelId = model.id; return llmModelId; }
  } catch (e) { console.error('LLM model list failed:', e); }
  return null;
}

// Batch LLM lookup: send ALL words in ONE request, get back array of results
async function llmLookupWordsBatch(words) {
  // 每日配额：超出后直接返回空结果，前端会退回到「暂无释义」
  const quota = llmQuota();
  if (quota.exceeded) {
    console.warn(`LLM 每日配额已用完（${quota.count}/${quota.limit}），今日不再补充释义`);
    return words.map(w => ({ word: w, result: null, quotaExceeded: true }));
  }
  quota.consume();

  const modelId = await getLLMModel();
  if (!modelId) return words.map(w => ({ word: w, result: null }));
  try {
    let answer = '';
    const sysPrompt = 'For each English word, return a JSON object: {"results":[{"word":"","phonetic":"","pos":"","definition":"中文释义","example_sentence":"","example_translation":"中文翻译","memory_tips":{"root_analysis":"","mnemonic":""}}]}. Definition must be in Chinese. Return ONLY the JSON.';
    const userContent = words.join(', ');

    const streamPromise = llm.chat.completions.create({
      model: modelId,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userContent }
      ],
      stream: true,
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    // 60s timeout - batch call needs more time
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('LLM batch timeout')), 60000));
    const stream = await Promise.race([streamPromise, timeoutPromise]);

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) answer += delta;
    }

    // Parse JSON
    let parsed;
    try {
      parsed = JSON.parse(answer);
    } catch (e) {
      const jsonMatch = answer.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      else throw e;
    }

    // Extract results array
    const resultsArr = parsed.results || parsed.words || (Array.isArray(parsed) ? parsed : [parsed]);
    const resultMap = {};
    for (const r of resultsArr) {
      if (r.word) resultMap[r.word.toLowerCase()] = r;
    }

    // Map back to input words
    return words.map(w => ({ word: w, result: resultMap[w.toLowerCase()] || null }));
  } catch (e) {
    console.error('LLM batch lookup failed:', e.message);
    return words.map(w => ({ word: w, result: null }));
  }
}

// Enrich words via LLM, then save to word_dictionary table
// (prepareVocabLearning already checked the table, so we skip re-querying here)
async function enrichWordsFromDBorLLM(words) {
  if (!db) { if (!await initCloud()) return words.map(w => ({ word: w, result: null })); }
  const results = [];

  // Call LLM in ONE batch request for all words
  if (words.length > 0) {
    const llmResults = await llmLookupWordsBatch(words);
    for (const { word, result } of llmResults) {
      if (result) {
        // Attach audio_url: prefer cache, fallback to local pre-generated file path
        let audioUrl = wordAudioCache.get(word.toLowerCase()) || '';
        if (!audioUrl) {
          // Assume local pre-generated file exists (server.js will have checked)
          // Use relative path - if file doesn't exist, playback will gracefully fail
          audioUrl = `/audio/${wordAudioFile(word)}`;
        }
        result.audio_url = audioUrl;
        results.push({ word, result });
        // Save to word_dictionary table for future use (all users benefit)
        try {
          await db.from('word_dictionary').upsert({
            word: word,
            phonetic: result.phonetic || '',
            pos: result.pos || '',
            definition: result.definition || '',
            example_sentence: result.example_sentence || '',
            example_translation: result.example_translation || '',
            memory_tips: result.memory_tips || {},
            audio_url: audioUrl
          }, { onConflict: 'word' });
        } catch (e) {
          console.log('Failed to save to word_dictionary:', word, e.message);
        }
      } else {
        results.push({ word, result: null });
      }
    }
  }

  return results;
}

// ========================================================================
// TODAY MODULE - Fixed: don't reset phase on tab switch
// ========================================================================
async function loadToday() {
  if (!await initCloud()) return;

  // Query cloud database daily_sentences table for today's content
  let corpusData = null;
  try {
    let rows = await dbSelect('daily_sentences', '*', { date: todayDate });
    if (rows.length === 0) {
      // Today not available - find the nearest future date, or nearest past date
      const allRows = await dbSelect('daily_sentences', 'date, english_text, chinese_translation, source, source_type, difficulty, sentences', {}, { col: 'date', ascending: true });
      const future = allRows.filter(r => r.date >= todayDate);
      if (future.length > 0) {
        rows = await dbSelect('daily_sentences', '*', { date: future[0].date });
      } else if (allRows.length > 0) {
        // No future dates - use the last available
        rows = await dbSelect('daily_sentences', '*', { date: allRows[allRows.length - 1].date });
      }
    }
    if (rows.length > 0) {
      const row = rows[0];
      corpusData = {
        date: row.date,
        english_text: row.english_text,
        chinese_translation: row.chinese_translation,
        source: row.source,
        source_type: row.source_type,
        difficulty: row.difficulty,
        sentences: typeof row.sentences === 'string' ? JSON.parse(row.sentences) : (row.sentences || []),
        vocabulary: []
      };
    }
  } catch (e) { console.log('Cloud daily_sentences query failed:', e.message); }

  if (!corpusData) {
    document.getElementById('todayContent').innerHTML = '<div class="empty-state"><div class="icon">\uD83D\uDCED</div><div class="msg">\u6682\u65E0\u5B66\u4E60\u5185\u5BB9\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5</div></div>';
    return;
  }
  todayData = corpusData;
  todayDate = corpusData.date;
  if (typeof todayData.sentences === 'string') { try { todayData.sentences = JSON.parse(todayData.sentences); } catch(e) {} }

  if (!isPhaseInitialized) {
    const logs = await dbSelect('study_log', '*', { date: todayDate });
    const savedPhase = sessionStorage.getItem('currentPhase');
    if (savedPhase !== null) {
      currentPhase = Math.max(0, Math.min(parseInt(savedPhase), 5));
    } else if (logs.length > 0 && logs[0].completed_phases) {
      try { const p = typeof logs[0].completed_phases === 'string' ? JSON.parse(logs[0].completed_phases) : logs[0].completed_phases; currentPhase = Math.max(0, Math.min(p.length - 1, 5)); } catch(e) {}
    }
    if (currentPhase >= 2) {
      const savedVocab = sessionStorage.getItem('todayVocab');
      if (savedVocab) {
        try { todayVocab = JSON.parse(savedVocab); } catch(e) { todayVocab = []; }
      }
      const dbVocab = await dbSelect('vocabulary', '*', { source_date: todayDate });
      const existingWords = new Set(todayVocab.map(v => v.word.toLowerCase()));
      for (const v of dbVocab) {
        if (!existingWords.has(v.word.toLowerCase())) {
          todayVocab.push(v);
        }
      }
    }
    isPhaseInitialized = true;
  }
  preloadSentenceAudio();
  renderTodayPhases();
}

function renderTodayPhases() {
  if (!todayData) return;
  const phases = ['\u76F2\u542C', '\u7CBE\u8BFB', '\u751F\u8BCD\u5B66\u4E60', '\u8DDF\u8BFB', '\u9ED8\u5199', '\u590D\u76D8'];
  const icons = ['\uD83D\uDC42', '\uD83D\uDCD6', '\uD83D\uDCDD', '\uD83C\uDFA4', '\u270D\uFE0F', '\uD83D\uDCCA'];
  document.getElementById('todayContent').innerHTML = `<div class="card"><div class="card-header"><div class="card-title">${esc(todayData.source)}</div><div class="card-meta">${esc(todayData.date)} \u00B7 ${difficultyLabel(todayData.difficulty)} \u00B7 ${esc(todayData.source_type)}</div></div><div class="phase-steps">${phases.map((p, i) => `<div class="phase-step ${i === currentPhase ? 'active' : ''} ${i < currentPhase ? 'completed' : ''}" onclick="goToPhase(${i})"><div class="step-num">\u9636\u6BB5${i+1}</div>${icons[i]} ${p}</div>`).join('')}</div></div><div id="phaseContent"></div>`;
  renderPhaseContent();
}

function difficultyLabel(d) { return { beginner: '\u521D\u7EA7', intermediate: '\u4E2D\u7EA7', advanced: '\u9AD8\u7EA7' }[d] || d; }

function renderPhaseContent() {
  const c = document.getElementById('phaseContent');
  switch(currentPhase) {
    case 0: c.innerHTML = renderBlindListen(); break;
    case 1: c.innerHTML = renderReadPhase(); break;
    case 2: c.innerHTML = renderVocabLearning(); break;
    case 3: c.innerHTML = renderReadAlong(); break;
    case 4: c.innerHTML = renderDictation(); break;
    case 5: c.innerHTML = renderReviewSummary(); break;
  }
}

function renderBlindListen() {
  return `<div class="card"><div class="card-title" style="margin-bottom:16px;">\u9636\u6BB51 \u00B7 \u76F2\u542C</div><div class="blind-listen-box"><div class="blind-listen-instruction">\uD83C\uDFA7 \u8BF7\u95ED\u4E0A\u773C\u775B\u6216\u79BB\u5F00\u5C4F\u5E55\uFF0C\u4EC5\u51ED\u8033\u6735\u542C\u82F1\u6587\u97F3\u9891\u3002<br>\u5C1D\u8BD5\u6293\u4F4F\u5173\u952E\u8BCD\u548C\u5927\u610F\uFF0C\u542C2-3\u904D\u540E\u8FDB\u5165\u7CBE\u8BFB\u9636\u6BB5\u5BF9\u7167\u539F\u6587\u3002</div><div class="listen-controls"><button class="btn btn-primary" onclick="playAllSentences()">\u25B6 \u64AD\u653E\u5168\u6587</button><button class="btn btn-danger" onclick="stopPlayback()">\u23F9 \u505C\u6B62</button><div class="speed-control"><label>\u8BED\u901F:</label><select id="listenSpeed"><option value="0.5">0.5x</option><option value="0.8">0.8x</option><option value="1" selected>1.0x</option><option value="1.5">1.5x</option><option value="2">2.0x</option><option value="3">3.0x</option></select></div></div></div><div class="phase-actions"><button class="btn btn-success" onclick="stopAllAudio(); nextPhase()">\u5DF2\u542C\u5B8C\uFF0C\u8FDB\u5165\u7CBE\u8BFB \u2192</button></div></div>`;
}

function renderReadPhase() {
  const sents = todayData.sentences || [];
  return `<div class="card"><div class="card-title" style="margin-bottom:16px;">\u9636\u6BB52 \u00B7 \u7CBE\u8BFB</div><p style="color:var(--text-secondary);margin-bottom:20px;font-size:15px;">\u9605\u8BFB\u82F1\u6587\u539F\u6587\uFF0C\u70B9\u51FB\u4E0D\u8BA4\u8BC6\u7684\u5355\u8BCD\u6807\u8BB0\u4E3A\u751F\u8BCD\uFF08\u9EC4\u8272\u9AD8\u4EAE\uFF09\u3002\u6807\u8BB0\u5B8C\u6210\u540E\u8FDB\u5165\u751F\u8BCD\u5B66\u4E60\u9636\u6BB5\u3002</p>${sents.map((s, i) => `<div class="sentence-block"><div class="sentence-en" id="sent-${i}">${s.split(/\s+/).map(w => `<span class="word" onclick="toggleWordMark(this)">${esc(w)}</span>`).join(' ')}</div><div class="sentence-zh">${esc(getSentenceTranslation(i))}</div><div class="sentence-actions"><button class="btn-icon" onclick="speak('${escAttr(s)}')">\uD83D\uDD0A \u6717\u8BFB\u672C\u53E5</button></div></div>`).join('')}<div class="phase-actions"><button class="btn btn-secondary" onclick="prevPhase()">\u2190 \u8FD4\u56DE\u76F2\u542C</button><button class="btn btn-success" onclick="prepareVocabLearning()">\u8FDB\u5165\u751F\u8BCD\u5B66\u4E60 \u2192</button></div></div>`;
}

function getSentenceTranslation(idx) {
  const parts = todayData.chinese_translation.split(/[\u3002\uFF01\uFF1F\n]/).filter(p => p.trim());
  return parts[idx] || '';
}

function toggleWordMark(el) { el.classList.toggle('marked'); }

// Fix: prepare vocab list WITHOUT saving to DB yet. Save happens after user removes known words.
async function prepareVocabLearning() {
  if (!db) { if (!await initCloud()) return; }
  // Collect marked words from DOM
  markedWords.clear();
  document.querySelectorAll('.sentence-en .word.marked').forEach(el => {
    const w = el.textContent.replace(/[^a-zA-Z-]/g, '').toLowerCase();
    if (w) markedWords.add(w);
  });

  // Get predefined vocab from today's data (loaded from backend API)
  const corpusVocab = todayData.vocabulary || [];

  // Build vocab list in memory (NOT saving to DB yet)
  todayVocab = [];

  // Collect all unique words that need looking up (user-marked + predefined)
  const allWordsToLookup = new Set();
  for (const word of markedWords) allWordsToLookup.add(word);
  for (const v of corpusVocab) allWordsToLookup.add(v.word.toLowerCase());

  // Query word_dictionary table for each word individually (reliable, avoids .in() issues)
  const dictEntries = {};
  if (allWordsToLookup.size > 0) {
    const wordList = Array.from(allWordsToLookup);
    const results = await Promise.all(wordList.map(async word => {
      try {
        const { data, error } = await db.from('word_dictionary').select('*').eq('word', word).limit(1);
        if (!error && data && data.length > 0) return { word, row: data[0] };
      } catch (e) {}
      return { word, row: null };
    }));
    for (const { word, row } of results) {
      if (row) dictEntries[word.toLowerCase()] = row;
    }
  }

  // Add predefined vocab FIRST (these are the default words for today)
  for (const v of corpusVocab) {
    const wordLower = v.word.toLowerCase();
    const dictEntry = dictEntries[wordLower];
    if (dictEntry && dictEntry.definition) {
      // Use dictionary table data (single source of truth)
      todayVocab.push({
        word: dictEntry.word, phonetic: dictEntry.phonetic || '', pos: dictEntry.pos || '',
        definition: dictEntry.definition, example_sentence: dictEntry.example_sentence || '',
        example_translation: dictEntry.example_translation || '',
        memory_tips: JSON.stringify(dictEntry.memory_tips || {}),
        audio_url: dictEntry.audio_url || '',
        difficulty_level: dictEntry.difficulty_level || todayData.difficulty,
        isNew: true, needEnrich: false, source: 'predefined'
      });
      if (dictEntry.audio_url) { wordAudioCache.set(wordLower, dictEntry.audio_url); preloadWordAudio(wordLower, dictEntry.audio_url); }
    } else {
      // Fallback to corpus vocab data if dictionary table doesn't have it
      todayVocab.push({
        word: v.word, phonetic: v.phonetic || '', pos: v.pos || '',
        definition: v.definition || '', example_sentence: v.example_sentence || '',
        example_translation: v.example_translation || '',
        memory_tips: JSON.stringify(v.memory_tips || {}),
        audio_url: '',
        difficulty_level: v.difficulty_level || todayData.difficulty,
        isNew: true, needEnrich: !v.definition, source: 'predefined'
      });
    }
  }

  // Add user-marked words AFTER predefined vocab (skip words already added as predefined)
  for (const word of markedWords) {
    // Skip if this word was already added as a predefined vocab
    if (todayVocab.some(v => v.word.toLowerCase() === word)) continue;
    const dictEntry = dictEntries[word];
    if (dictEntry && dictEntry.definition) {
      todayVocab.push({
        word: dictEntry.word, phonetic: dictEntry.phonetic || '', pos: dictEntry.pos || '',
        definition: dictEntry.definition, example_sentence: dictEntry.example_sentence || '',
        example_translation: dictEntry.example_translation || '',
        memory_tips: JSON.stringify(dictEntry.memory_tips || {}),
        audio_url: dictEntry.audio_url || '',
        difficulty_level: dictEntry.difficulty_level || todayData.difficulty,
        isNew: true, needEnrich: false, source: 'user'
      });
      // Cache and preload audio for pronunciation
      if (dictEntry.audio_url) { wordAudioCache.set(word, dictEntry.audio_url); preloadWordAudio(word, dictEntry.audio_url); }
    } else {
      // Not in dictionary table - mark for enrichment
      todayVocab.push({
        word: word, phonetic: '', pos: '', definition: '', example_sentence: '',
        example_translation: '', memory_tips: JSON.stringify({}),
        difficulty_level: todayData.difficulty, isNew: true, needEnrich: true, source: 'user'
      });
    }
  }

  // Save todayVocab to sessionStorage for refresh recovery
  sessionStorage.setItem('todayVocab', JSON.stringify(todayVocab));

  // Enter vocab learning phase immediately with whatever data we have
  nextPhase();

  // Auto-enrich words missing definitions IN BACKGROUND (non-blocking)
  // First try backend /api/lookup (fast, no LLM cost), then fallback to LLM
  const missingDef = todayVocab.filter(v => v.needEnrich).map(v => v.word);
  if (missingDef.length > 0) {
    // Both API lookup and LLM enrichment start simultaneously (parallel)
    // API returns fast with English def + audio, LLM returns slow with Chinese def + memory tips
    // Status is shown on each card (needEnrich=true shows "AI补充中" badge)

    // --- LLM enrichment (fire immediately, don't wait for API) ---
    enrichWordsFromDBorLLM(missingDef).then(enriched => {
      console.log('[Vocab] LLM done:', enriched.map(r => ({ word: r.word, ok: !!r.result })));
      for (const { word, result } of enriched) {
        if (result) {
          const idx = todayVocab.findIndex(v => v.word.toLowerCase() === word.toLowerCase());
          if (idx >= 0) {
            todayVocab[idx].phonetic = result.phonetic || todayVocab[idx].phonetic || '';
            todayVocab[idx].pos = result.pos || todayVocab[idx].pos || '';
            todayVocab[idx].definition = result.definition || todayVocab[idx].definition || '';
            todayVocab[idx].example_sentence = result.example_sentence || todayVocab[idx].example_sentence || '';
            todayVocab[idx].example_translation = result.example_translation || todayVocab[idx].example_translation || '';
            todayVocab[idx].memory_tips = JSON.stringify(result.memory_tips || {});
            if (result.audio_url) {
              todayVocab[idx].audio_url = result.audio_url;
              wordAudioCache.set(word.toLowerCase(), result.audio_url);
            }
            todayVocab[idx].needEnrich = false;
            todayVocab[idx].enriched = true;
          }
        } else {
          // LLM failed - mark as failed on card
          const idx = todayVocab.findIndex(v => v.word.toLowerCase() === word.toLowerCase());
          if (idx >= 0) {
            todayVocab[idx].needEnrich = false;
            todayVocab[idx].enrichFailed = true;
          }
        }
      }
      sessionStorage.setItem('todayVocab', JSON.stringify(todayVocab));
      if (currentPhase === 2) renderPhaseContent();
    });

    // --- API lookup (also fire immediately, parallel with LLM) ---
    Promise.all(missingDef.map(async word => {
      try {
        const resp = await fetch(`/api/lookup?word=${encodeURIComponent(word)}`);
        const data = await resp.json();
        if (data.found) return { word, result: data };
      } catch (e) {}
      return { word, result: null };
    })).then(lookupResults => {
      // Apply API results - only update fields that LLM hasn't filled yet
      for (const { word, result } of lookupResults) {
        if (result) {
          const idx = todayVocab.findIndex(v => v.word.toLowerCase() === word.toLowerCase());
          if (idx >= 0) {
            // Only fill in if LLM hasn't provided Chinese definition yet
            if (!todayVocab[idx].example_translation) {
              todayVocab[idx].phonetic = todayVocab[idx].phonetic || result.phonetic || '';
              todayVocab[idx].pos = todayVocab[idx].pos || result.pos || '';
              todayVocab[idx].definition = todayVocab[idx].definition || result.definition || '';
              todayVocab[idx].example_sentence = todayVocab[idx].example_sentence || result.example_sentence || '';
            }
            if (result.audio_url) {
              wordAudioCache.set(word.toLowerCase(), result.audio_url);
              todayVocab[idx].audio_url = result.audio_url;
            }
          }
        }
      }
      // Re-render with API results
      sessionStorage.setItem('todayVocab', JSON.stringify(todayVocab));
      if (currentPhase === 2) renderPhaseContent();
    });
  }
}

function renderVocabLearning() {
  if (todayVocab.length === 0) return `<div class="card"><div class="empty-state"><div class="icon">\uD83D\uDCDD</div><div class="msg">\u6682\u65E0\u751F\u8BCD\uFF0C\u8DF3\u8FC7\u6B64\u9636\u6BB5<br><button class="btn btn-success" style="margin-top:12px;" onclick="nextPhase()">\u8FDB\u5165\u8DDF\u8BFB \u2192</button></div></div></div>`;
  return `<div class="card"><div class="card-title" style="margin-bottom:16px;">\u9636\u6BB53 \u00B7 \u751F\u8BCD\u5B66\u4E60</div><p style="color:var(--text-secondary);margin-bottom:20px;font-size:15px;">\u9010\u4E2A\u5B66\u4E60\u4ECA\u65E5\u751F\u8BCD\u3002\u5DF2\u638C\u63E1\u7684\u8BCD\u70B9\u51FB"\u79FB\u9664"\u5220\u6389\uFF0C\u53EA\u7559\u4E0B\u9700\u8981\u91CD\u70B9\u5B66\u4E60\u7684\u8BCD\u3002\u5B66\u5B8C\u540E\u70B9\u51FB"\u4FDD\u5B58\u5230\u751F\u8BCD\u672C"\u3002</p>${todayVocab.map((v, i) => {
    let tips = {};
    try { tips = typeof v.memory_tips === 'string' ? JSON.parse(v.memory_tips) : v.memory_tips || {}; } catch(e) {}
    // Determine definition display state
    let defHtml;
    if (v.definition) {
      defHtml = `<div class="vocab-learning-def">${esc(v.definition)}</div>`;
    } else if (v.needEnrich) {
      defHtml = `<div class="vocab-learning-def" style="color:var(--text-muted);">\uD83D\uDD04 \u91CA\u4E49\u52A0\u8F7D\u4E2D\u2026\u2026</div>`;
    } else if (v.enrichFailed) {
      defHtml = `<div class="vocab-learning-def" style="color:var(--text-muted);">\u6682\u65E0\u91CA\u4E49\uFF08AI\u8865\u5145\u5931\u8D25\uFF09</div>`;
    } else {
      defHtml = `<div class="vocab-learning-def" style="color:var(--text-muted);">\u6682\u65E0\u91CA\u4E49</div>`;
    }
    // Show enrichment status badge on card
    let statusBadge = '';
    if (v.needEnrich) {
      statusBadge = `<span style="font-size:12px;color:var(--accent-blue);margin-left:8px;">\uD83D\uDD04 AI\u8865\u5145\u4E2D</span>`;
    } else if (v.enrichFailed) {
      statusBadge = `<span style="font-size:12px;color:var(--accent-red);margin-left:8px;">\u26A0 \u8865\u5145\u5931\u8D25</span>`;
    } else if (v.enriched) {
      statusBadge = `<span style="font-size:12px;color:var(--accent-green);margin-left:8px;">\u2705 \u5DF2\u8865\u5145</span>`;
    }
    return `<div class="vocab-learning-card" id="vlearn-${i}"><div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px;"><div><span class="vocab-learning-word">${esc(v.word)}</span>${statusBadge}${v.phonetic ? `<span class="vocab-learning-phonetic">${esc(v.phonetic)}</span>` : ''}${v.pos ? `<span class="vocab-pos">${esc(v.pos)}</span>` : ''}</div><button class="btn-icon" onclick="speak('${escAttr(v.word)}')">\uD83D\uDD0A \u53D1\u97F3</button></div><div>${defHtml}${v.example_sentence ? `<div class="vocab-learning-example">&quot;${esc(v.example_sentence)}&quot;<br><span style="color:var(--text-muted);">${esc(v.example_translation)}</span></div>` : ''}<div class="vocab-learning-tips"><div class="tip-row"><span class="tip-label">\u8BCD\u6839:</span> ${tips.root_analysis ? esc(tips.root_analysis) : '<span style="color:var(--text-muted);">\u6682\u65E0</span>'}</div><div class="tip-row"><span class="tip-label">\u8054\u60F3:</span> ${tips.mnemonic ? esc(tips.mnemonic) : '<span style="color:var(--text-muted);">\u6682\u65E0</span>'}</div></div></div><div class="vocab-card-actions"><button class="btn-danger-sm" onclick="removeVocabFromLearning(${i})">\u2716 \u79FB\u9664</button></div></div>`;
  }).join('')}<div class="phase-actions"><button class="btn btn-secondary" onclick="prevPhase()">\u2190 \u8FD4\u56DE\u7CBE\u8BFB</button><button class="btn btn-success" onclick="saveVocabAndNext()">\u4FDD\u5B58\u5230\u751F\u8BCD\u672C\uFF0C\u8FDB\u5165\u8DDF\u8BFB \u2192</button></div></div>`;
}

// Remove word from learning list (before saving)
function removeVocabFromLearning(idx) {
  todayVocab.splice(idx, 1);
  sessionStorage.setItem('todayVocab', JSON.stringify(todayVocab));
  showToast('\u5DF2\u79FB\u9664');
  renderPhaseContent();
}

// Fix: NOW save to DB after user has reviewed and removed known words
async function saveVocabAndNext() {
  let savedCount = 0;
  for (const v of todayVocab) {
    // Check if already in DB
    const existing = await dbSelect('vocabulary', 'id', { word: v.word });
    if (existing.length > 0) continue;
    await dbInsert('vocabulary', {
      word: v.word, phonetic: v.phonetic || '', pos: v.pos || '',
      definition: v.definition || '', example_sentence: v.example_sentence || '',
      example_translation: v.example_translation || '',
      memory_tips: typeof v.memory_tips === 'string' ? v.memory_tips : JSON.stringify(v.memory_tips || {}),
      audio_url: v.audio_url || '',
      difficulty_level: v.difficulty_level || todayData.difficulty,
      srs_level: 1, next_review: todayDate, review_count: 0, status: 'new',
      added_date: todayDate, source_date: todayDate, source_text: todayData.source
    });
    savedCount++;
  }
  if (savedCount > 0) showToast(`\u5DF2\u4FDD\u5B58 ${savedCount} \u4E2A\u751F\u8BCD\u5230\u751F\u8BCD\u672C`);
  // Refresh todayVocab from DB for consistency
  todayVocab = await dbSelect('vocabulary', '*', { source_date: todayDate });
  await updateStudyPhases();
  nextPhase();
}

function renderReadAlong() {
  const sents = todayData.sentences || [];
  return `<div class="card"><div class="card-title" style="margin-bottom:16px;">\u9636\u6BB54 \u00B7 \u8DDF\u8BFB</div><p style="color:var(--text-secondary);margin-bottom:20px;font-size:15px;">\u9010\u53E5\u8DDF\u8BFB\uFF0C\u6A21\u4EFF\u8BED\u901F\u548C\u8BED\u8C03\u3002\u70B9\u51FB\uD83D\uDD0A\u64AD\u653E\u8BE5\u53E5\u97F3\u9891\u3002</p><div class="speed-control" style="margin-bottom:16px;"><label>\u8BED\u901F:</label><select id="readAlongSpeed"><option value="0.5">0.5x</option><option value="0.8">0.8x</option><option value="1" selected>1.0x</option><option value="1.5">1.5x</option><option value="2">2.0x</option><option value="3">3.0x</option></select></div>${sents.map((s, i) => `<div class="read-along-sentence" id="ra-${i}"><div><div class="en">${esc(s)}</div><div class="zh">${esc(getSentenceTranslation(i))}</div></div><button class="btn-icon" onclick="playRA(${i})">\uD83D\uDD0A</button></div>`).join('')}<div class="phase-actions"><button class="btn btn-secondary" onclick="prevPhase()">\u2190 \u8FD4\u56DE</button><button class="btn btn-success" onclick="nextPhase()">\u8FDB\u5165\u9ED8\u5199 \u2192</button></div></div>`;
}

function playRA(idx) {
  document.querySelectorAll('.read-along-sentence').forEach(el => el.classList.remove('highlight'));
  const el = document.getElementById(`ra-${idx}`);
  if (el) el.classList.add('highlight');
  speak(todayData.sentences[idx], parseFloat(document.getElementById('readAlongSpeed')?.value || 1), () => { if (el) el.classList.remove('highlight'); });
}

function renderDictation() {
  const sents = todayData.sentences || [];
  return `<div class="card"><div class="card-title" style="margin-bottom:16px;">\u9636\u6BB55 \u00B7 \u770B\u4E2D\u6587\u9ED8\u82F1\u6587</div><p style="color:var(--text-secondary);margin-bottom:20px;font-size:15px;">\u6839\u636E\u4E2D\u6587\u7FFB\u8BD1\u9ED8\u5199\u82F1\u6587\u53E5\u5B50\uFF0C\u63D0\u4EA4\u540E\u7CFB\u7EDF\u9010\u8BCD\u6BD4\u5BF9\u5E76\u6807\u8BB0\u9519\u8BEF\u3002</p>${sents.map((s, i) => `<div class="sentence-block" id="dict-block-${i}"><div class="sentence-zh" style="font-size:16px;color:var(--text-primary);font-weight:500;">${i+1}. ${esc(getSentenceTranslation(i))}</div><div style="margin-top:12px;"><textarea class="dictation-input" id="dict-input-${i}" placeholder="\u5728\u6B64\u8F93\u5165\u82F1\u6587\u53E5\u5B50..." rows="3"></textarea></div><div id="dict-result-${i}"></div></div>`).join('')}<div class="phase-actions" id="dictActions"><button class="btn btn-secondary" onclick="prevPhase()">\u2190 \u8FD4\u56DE\u8DDF\u8BFB</button><button class="btn btn-primary" id="submitDictBtn" onclick="submitDictation()">\u63D0\u4EA4\u6BD4\u5BF9</button></div></div>`;
}

function submitDictation() {
  const submitBtn = document.getElementById('submitDictBtn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '\u6BD4\u5BF9\u4E2D...'; }
  const sents = todayData.sentences || [];
  let totalCorrect = 0, totalWords = 0;
  sents.forEach((original, i) => {
    const inputEl = document.getElementById(`dict-input-${i}`); const resultEl = document.getElementById(`dict-result-${i}`);
    if (!inputEl || !resultEl) return;
    const userInput = inputEl.value.trim();
    if (!userInput) { resultEl.innerHTML = '<div style="color:var(--accent-orange);font-size:14px;">\u672A\u586B\u5199</div>'; return; }
  const origWords = original.replace(/[.,!?;:"'()]/g, '').split(/\s+/).filter(w => w);
  const userWords = userInput.replace(/[.,!?;:"'()]/g, '').split(/\s+/).filter(w => w);
  totalWords += origWords.length;
  const result = compareWords(origWords, userWords);
  totalCorrect += result.correctCount;
  let html = '<div class="dictation-result"><div class="comparison-line">';
  result.comparison.forEach(c => { const cls = c.status === 'correct' ? 'word-correct' : c.status === 'wrong' ? 'word-wrong' : c.status === 'missing' ? 'word-missing' : 'word-extra'; html += `<span class="${cls}">${esc(c.word)}</span> `; });
  html += '</div></div>';
  resultEl.innerHTML = html;
  const acc = Math.round((result.correctCount / origWords.length) * 100);
  dbInsert('dictation_history', { date: todayDate, sentence_index: i, original_text: original, user_input: userInput, errors: JSON.stringify(result.errors), accuracy: acc / 100 });
  });
  const overall = totalWords > 0 ? Math.round((totalCorrect / totalWords) * 100) : 0;
  dbUpdate('study_log', { dictation_score: overall / 100 }, { date: todayDate });
  showToast(`\u9ED8\u5199\u5B8C\u6210\uFF01\u603B\u6B63\u786E\u7387: ${overall}%`);
  // Replace action buttons: remove "提交比对", keep "返回跟读" + add "进入复盘"
  const actionsDiv = document.getElementById('dictActions');
  if (actionsDiv) { actionsDiv.innerHTML = '<button class="btn btn-secondary" onclick="prevPhase()">\u2190 \u8FD4\u56DE\u8DDF\u8BFB</button><button class="btn btn-success" onclick="nextPhase()">\u8FDB\u5165\u590D\u76D8 \u2192</button>'; }
}

function compareWords(original, user) {
  const m = original.length, n = user.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = original[i-1].toLowerCase() === user[j-1].toLowerCase() ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const comparison = []; let i = m, j = n, correctCount = 0; const errors = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && original[i-1].toLowerCase() === user[j-1].toLowerCase()) { comparison.unshift({ word: original[i-1], status: 'correct' }); correctCount++; i--; j--; }
    else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) { comparison.unshift({ word: user[j-1], status: 'extra' }); errors.push({ type: 'spelling', label: '\u591A\u4F59\u8BCD' }); j--; }
    else if (i > 0) { const w = original[i-1]; comparison.unshift({ word: w, status: 'missing' }); if (['the','a','an','in','on','at','to','of','for'].includes(w.toLowerCase())) errors.push({ type: 'article', label: '\u51A0\u8BCD/\u4ECB\u8BCD\u9057\u6F0F' }); else { let found = false; for (let k = 0; k < user.length; k++) { if (levenshtein(w.toLowerCase(), user[k].toLowerCase()) <= 2) { errors.push({ type: 'spelling', label: '\u62FC\u5199\u9519\u8BEF' }); found = true; break; } } if (!found) errors.push({ type: 'spelling', label: '\u9057\u6F0F' }); } i--; }
  }
  return { comparison, correctCount, errors };
}

function levenshtein(a, b) {
  const m = a.length, n = b.length; const d = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i; for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = a[i-1] === b[j-1] ? d[i-1][j-1] : Math.min(d[i-1][j], d[i][j-1], d[i-1][j-1]) + 1;
  return d[m][n];
}

function renderReviewSummary() {
  const sents = todayData.sentences || [];
  return `<div class="card"><div class="card-title" style="margin-bottom:16px;">\u9636\u6BB56 \u00B7 \u590D\u76D8</div><div class="review-summary"><h3 style="font-size:20px;">\u4ECA\u65E5\u5B66\u4E60\u603B\u7ED3</h3><div class="stat-grid"><div class="stat-item"><div class="stat-value">${todayVocab.length || markedWords.size}</div><div class="stat-label">\u65B0\u5B66\u751F\u8BCD</div></div><div class="stat-item"><div class="stat-value">${sents.length}</div><div class="stat-label">\u5B66\u4E60\u53E5\u5B50</div></div><div class="stat-item"><div class="stat-value">${formatDuration(getStudyDuration())}</div><div class="stat-label">\u5B66\u4E60\u65F6\u957F</div></div></div><p style="color:var(--text-secondary);margin-top:24px;font-size:15px;">\uD83D\uDCCC \u6309 <strong>1\u5929/3\u5929/7\u5929</strong> \u95F4\u9694\u590D\u4E60\u4ECA\u5929\u7684\u751F\u8BCD\uFF0C\u660E\u5929\u7CFB\u7EDF\u4F1A\u81EA\u52A8\u63A8\u9001\u5230\u671F\u590D\u4E60\u3002</p><button class="btn btn-success" style="margin-top:24px;" onclick="completeStudy()">\u5B8C\u6210\u4ECA\u65E5\u6253\u5361 \u2713</button></div></div>`;
}

async function completeStudy() {
  await dbUpdate('study_log', { study_duration: getStudyDuration(), completed_phases: JSON.stringify([0,1,2,3,4,5]) }, { date: todayDate });
  await updateStreak(); showToast('\uD83C\uDF89 \u6253\u5361\u6210\u529F\uFF01'); loadStreak(); switchTab('dashboard');
}

// ===== PHASE NAV =====
function nextPhase() {
  if (currentPhase < 5) {
    currentPhase++;
    sessionStorage.setItem('currentPhase', currentPhase);
    // Track the furthest phase reached
    const maxPhase = parseInt(sessionStorage.getItem('maxPhase') || 0);
    if (currentPhase > maxPhase) sessionStorage.setItem('maxPhase', currentPhase);
    renderTodayPhases();
    updateStudyPhases();
    window.scrollTo({top: 0, behavior: 'smooth'});
  }
}
function prevPhase() { if (currentPhase > 0) { currentPhase--; sessionStorage.setItem('currentPhase', currentPhase); renderTodayPhases(); window.scrollTo({top:0,behavior:'smooth'}); } }
function goToPhase(idx) {
  // Allow jumping to any phase up to the furthest reached phase
  const maxPhase = parseInt(sessionStorage.getItem('maxPhase') || currentPhase);
  if (idx <= maxPhase) {
    currentPhase = idx;
    sessionStorage.setItem('currentPhase', currentPhase);
    renderTodayPhases();
    window.scrollTo({top: 0, behavior: 'smooth'});
  }
}
async function updateStudyPhases() { const p = []; for (let i = 0; i <= currentPhase; i++) p.push(i); await dbUpdate('study_log', { completed_phases: JSON.stringify(p) }, { date: todayDate }); }

// ===== TIMER =====
let durationSaveInterval = null;

// Initialize timer immediately on app show - async, doesn't block UI
async function initStudyTimer() {
  if (!db) { if (!await initCloud()) return; }
  // Show 00:00 immediately to avoid blank
  const el = document.getElementById('timerDisplay');
  if (el) el.textContent = '00:00';
  // Try to restore start_time from DB
  try {
    const logs = await dbSelect('study_log', '*', { date: todayDate });
    if (logs.length > 0 && logs[0].start_time) {
      studyStartTime = new Date(logs[0].start_time);
    } else {
      studyStartTime = new Date();
      await dbInsert('study_log', { date: todayDate, start_time: studyStartTime.toISOString(), study_duration: 0, completed_phases: JSON.stringify([]) });
    }
  } catch (e) {
    studyStartTime = new Date();
  }
  // Immediately update display with restored time
  if (el) el.textContent = formatDuration(getStudyDuration());
  startTimer();
}

function startTimer() {
  if (studyTimerInterval) clearInterval(studyTimerInterval);
  // Update immediately, then every second
  const update = () => { const el = document.getElementById('timerDisplay'); if (el) el.textContent = formatDuration(getStudyDuration()); };
  update();
  studyTimerInterval = setInterval(update, 1000);
  // Auto-save study_duration to DB every 30 seconds
  if (durationSaveInterval) clearInterval(durationSaveInterval);
  durationSaveInterval = setInterval(() => { if (db) dbUpdate('study_log', { study_duration: getStudyDuration() }, { date: todayDate }); }, 30000);
}
function getStudyDuration() { return studyStartTime ? Math.floor((new Date() - studyStartTime) / 1000) : 0; }
function formatDuration(s) { return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }

// ===== VOCAB MODULE (no synonyms/antonyms/collocations) =====
async function loadVocab() {
  if (!db) { if (!await initCloud()) return; }
  const vocab = await dbSelect('vocabulary', '*', {}, { col: 'added_date', ascending: false });
  document.getElementById('vocabCount').textContent = `${vocab.length} \u4E2A\u751F\u8BCD`;
  // Cache and preload audio URLs for pronunciation
  for (const v of vocab) {
    if (v.audio_url) { wordAudioCache.set(v.word.toLowerCase(), v.audio_url); preloadWordAudio(v.word, v.audio_url); }
  }
  if (vocab.length === 0) { document.getElementById('vocabList').innerHTML = '<div class="empty-state"><div class="icon">\uD83D\uDCDA</div><div class="msg">\u8FD8\u6CA1\u6709\u751F\u8BCD\uFF0C\u53BB\u4ECA\u65E5\u5B66\u4E60\u4E2D\u6807\u8BB0\u5427\uFF01</div></div>'; return; }
  document.getElementById('vocabList').innerHTML = vocab.map(v => {
    let tips = {};
    try { tips = typeof v.memory_tips === 'string' ? JSON.parse(v.memory_tips) : v.memory_tips || {}; } catch(e) {}
    return `<div class="vocab-item"><div class="vocab-header"><div class="vocab-word">${esc(v.word)}${v.phonetic ? `<span class="vocab-phonetic">${esc(v.phonetic)}</span>` : ''}${v.pos ? `<span class="vocab-pos">${esc(v.pos)}</span>` : ''}</div><div style="display:flex;align-items:center;gap:8px;"><span class="vocab-status ${escAttr(v.status)}">${statusLabel(v.status)}</span><button class="btn-icon" onclick="speak('${escAttr(v.word)}')">\uD83D\uDD0A</button><button class="btn-danger-sm" onclick="removeVocabFromList(${escAttr(v.id)})">\u2716 \u79FB\u9664</button></div></div><div class="vocab-body">${v.definition ? `<div class="definition">${esc(v.definition)}</div>` : '<div class="definition" style="color:var(--text-muted);">\u6682\u65E0\u91CA\u4E49</div>'}${v.example_sentence ? `<div class="example">&quot;${esc(v.example_sentence)}&quot;</div>` : ''}${v.example_translation ? `<div style="color:var(--text-muted);">${esc(v.example_translation)}</div>` : ''}${tips.root_analysis || tips.mnemonic ? `<div class="vocab-tips">${tips.root_analysis ? `<div class="tip-row"><span class="tip-label">\u8BCD\u6839:</span> ${esc(tips.root_analysis)}</div>` : ''}${tips.mnemonic ? `<div class="tip-row"><span class="tip-label">\u8054\u60F3:</span> ${esc(tips.mnemonic)}</div>` : ''}</div>` : ''}</div></div>`;
  }).join('');
}

async function removeVocabFromList(vocabId) { await dbDelete('vocabulary', { id: vocabId }); showToast('\u5DF2\u79FB\u51FA\u751F\u8BCD\u672C'); loadVocab(); }
function statusLabel(s) { return { new: '\u65B0\u8BCD', learning: '\u5B66\u4E60\u4E2D', mastered: '\u5DF2\u638C\u63E1', permanent: '\u6C38\u4E45\u8BB0\u5FC6' }[s] || s; }

// ===== REVIEW (SRS) =====
let reviewQueue = [], reviewIdx = 0, currentReviewWord = null;
async function loadReview() {
  if (!db) { if (!await initCloud()) return; }
  const due = await dbSelect('vocabulary', '*', {}, { col: 'next_review', ascending: true }, 50);
  // Cache and preload audio URLs for pronunciation
  for (const w of due) {
    if (w.audio_url) { wordAudioCache.set(w.word.toLowerCase(), w.audio_url); preloadWordAudio(w.word, w.audio_url); }
  }
  const today = new Date().toISOString().slice(0, 10);
  reviewQueue = due.filter(w => w.next_review && w.next_review <= today && w.status !== 'permanent');
  reviewIdx = 0; renderReview();
}
function shuffle(a) { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i+1)); [r[i],r[j]] = [r[j],r[i]]; } return r; }

function renderReview() {
  const c = document.getElementById('reviewContent');
  if (reviewQueue.length === 0) { c.innerHTML = '<div class="card"><div class="empty-state"><div class="icon">\u2705</div><div class="msg">\u6682\u65E0\u5230\u671F\u590D\u4E60\u7684\u5355\u8BCD\uFF01</div></div></div>'; return; }
  if (reviewIdx >= reviewQueue.length) { c.innerHTML = `<div class="card"><div class="review-summary"><h3 style="font-size:20px;">\uD83C\uDF89 \u590D\u4E60\u5B8C\u6210\uFF01</h3><div class="stat-grid"><div class="stat-item"><div class="stat-value">${reviewQueue.length}</div><div class="stat-label">\u672C\u6B21\u590D\u4E60</div></div></div><button class="btn btn-primary" style="margin-top:20px;" onclick="switchTab('today')">\u56DE\u5230\u4ECA\u65E5\u5B66\u4E60</button></div></div>`; return; }
  currentReviewWord = reviewQueue[reviewIdx];
  let tips = {};
  try { tips = typeof currentReviewWord.memory_tips === 'string' ? JSON.parse(currentReviewWord.memory_tips) : currentReviewWord.memory_tips || {}; } catch(e) {}
  c.innerHTML = `<div class="card"><div class="card-header"><div class="card-title">SRS \u95F4\u9694\u590D\u4E60</div><div class="card-meta">${reviewIdx+1} / ${reviewQueue.length}</div></div><div class="review-progress">${reviewQueue.map((_, i) => `<div class="review-dot ${i < reviewIdx ? 'done' : ''} ${i === reviewIdx ? 'current' : ''}"></div>`).join('')}</div><div class="review-card"><div style="margin-bottom:12px;"><span class="vocab-status ${escAttr(currentReviewWord.status)}">${statusLabel(currentReviewWord.status)}</span><span style="font-size:13px;color:var(--text-muted);margin-left:8px;">Level ${esc(currentReviewWord.srs_level)} \u00B7 \u5DF2\u590D\u4E60${esc(currentReviewWord.review_count)}\u6B21</span></div><div class="word-display">${esc(currentReviewWord.word)}</div>${currentReviewWord.phonetic ? `<div class="phonetic-display">${esc(currentReviewWord.phonetic)}</div>` : ''}<button class="btn-icon" onclick="speak('${escAttr(currentReviewWord.word)}')">\uD83D\uDD0A \u53D1\u97F3</button><div class="reveal-area" id="revealArea" style="display:none;"><div class="definition-display">${currentReviewWord.pos ? `<span style="color:var(--text-muted);">(${esc(currentReviewWord.pos)})</span> ` : ''}${esc(currentReviewWord.definition) || '\u6682\u65E0\u91CA\u4E49'}</div>${currentReviewWord.example_sentence ? `<div class="example-display">&quot;${esc(currentReviewWord.example_sentence)}&quot;</div>` : ''}${tips.root_analysis ? `<div style="margin-top:8px;font-size:14px;color:var(--accent-purple);">\uD83D\uDCA1 ${esc(tips.root_analysis)}</div>` : ''}${tips.mnemonic ? `<div style="font-size:14px;color:var(--accent-purple);">\uD83E\uDDE0 ${esc(tips.mnemonic)}</div>` : ''}</div><div id="revealBtn" style="margin-top:20px;"><button class="btn btn-secondary" onclick="revealAnswer()">\u70B9\u51FB\u663E\u793A\u7B54\u6848</button></div><div id="reviewButtons" style="display:none;"><div style="margin-bottom:12px;color:var(--text-secondary);font-size:15px;">\u4F60\u8BB0\u5F97\u8FD9\u4E2A\u8BCD\u5417\uFF1F\u8BDA\u5B9E\u81EA\u8BC4\u53EF\u4EE5\u4F18\u5316\u590D\u4E60\u95F4\u9694\u3002</div><div class="review-buttons"><button class="review-btn forgot" onclick="reviewAnswer('forgotten')">\uD83D\uDE2E \u5FD8\u4E86</button><button class="review-btn fuzzy" onclick="reviewAnswer('fuzzy')">\uD83D\uDE10 \u6A21\u7CCA</button><button class="review-btn remembered" onclick="reviewAnswer('remembered')">\uD83D\uDE0A \u8BB0\u4F4F\u4E86</button></div></div></div></div>`;
}

function revealAnswer() { document.getElementById('revealArea').style.display = 'block'; document.getElementById('revealBtn').style.display = 'none'; document.getElementById('reviewButtons').style.display = 'block'; }

async function reviewAnswer(result) {
  if (!currentReviewWord) return;
  document.querySelectorAll('.review-btn').forEach(b => b.disabled = true);
  let lvl = currentReviewWord.srs_level, st = currentReviewWord.status, days = 1;
  if (result === 'remembered') { const iv = SRS_INTERVALS[lvl] || SRS_INTERVALS[4]; const rc = currentReviewWord.review_count + 1; days = iv[Math.min(rc - 1, iv.length - 1)] || iv[iv.length - 1]; if (lvl < 4) lvl++; st = lvl >= 4 ? 'permanent' : lvl >= 3 ? 'mastered' : 'learning'; }
  else if (result === 'fuzzy') { const iv = SRS_INTERVALS[lvl] || SRS_INTERVALS[2]; days = Math.max(1, Math.ceil((iv[0] || 1) * 0.5)); }
  else { lvl = 1; st = 'learning'; days = 0.02; }
  const nd = new Date(); nd.setDate(nd.getDate() + Math.ceil(days));
  await dbUpdate('vocabulary', { srs_level: lvl, next_review: nd.toISOString().slice(0,10), review_count: currentReviewWord.review_count + 1, status: st, last_reviewed: todayDate }, { id: currentReviewWord.id });
  reviewIdx++; setTimeout(() => renderReview(), 200);
}

// ===== DASHBOARD =====
let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();

async function loadDashboard() {
  if (!db) { if (!await initCloud()) return; }
  const logs = await dbSelect('study_log', '*', {}, { col: 'date', ascending: false });
  const vocab = await dbSelect('vocabulary', '*');
  const dictations = await dbSelect('dictation_history', '*');
  const mastered = vocab.filter(v => v.status === 'mastered' || v.status === 'permanent').length;
  const learning = vocab.length - mastered;
  const avgAcc = dictations.length > 0 ? Math.round(dictations.reduce((s, d) => s + (d.accuracy || 0), 0) / dictations.length * 100) : 0;
  const streak = await calculateStreak(logs);
  const vocabChart = generateVocabGrowth(vocab).map(d => '<div class="chart-bar" style="height:' + d.height + '%"><div class="bar-value">' + d.count + '</div><div class="bar-label">' + d.shortDate + '</div></div>').join('');
  const accChart = generateAccuracyTrend(dictations).map(d => '<div class="chart-bar" style="height:' + d.height + '%;background:var(--accent-green)"><div class="bar-value">' + d.accuracy + '%</div><div class="bar-label">' + d.shortDate + '</div></div>').join('');
  document.getElementById('dashboardContent').innerHTML =
    '<div class="dashboard-stats"><div class="dash-stat"><div class="value">' + streak + '</div><div class="label">\u8FDE\u7EED\u6253\u5361</div></div>' +
    '<div class="dash-stat"><div class="value">' + vocab.length + '</div><div class="label">\u751F\u8BCD\u603B\u6570</div></div>' +
    '<div class="dash-stat"><div class="value">' + mastered + '</div><div class="label">\u5DF2\u638C\u63E1</div></div>' +
    '<div class="dash-stat"><div class="value">' + learning + '</div><div class="label">\u5F85\u590D\u4E60</div></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">\uD83D\uDCC5 <span id="calMonthLabel"></span></div><div style="display:flex;gap:8px;"><button class="btn-icon" onclick="changeMonth(-1)">\u2039</button><button class="btn-icon" onclick="changeMonth(1)">\u203A</button></div></div>' +
    '<div class="calendar-grid" id="calendarGrid"></div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">\uD83D\uDCCA \u751F\u8BCD\u589E\u957F</div><div class="card-meta">\u8FD17\u5929</div></div>' +
    '<div class="simple-chart">' + vocabChart + '</div></div>' +
    '<div class="card"><div class="card-header"><div class="card-title">\uD83D\uDCC8 \u9ED8\u5199\u6B63\u786E\u7387</div><div class="card-meta">\u8FD17\u5929 \u00B7 \u5747' + avgAcc + '%</div></div>' +
    '<div class="simple-chart">' + accChart + '</div></div>';
  // Render calendar after DOM is ready
  renderCalendar(logs);
  // Store logs for month navigation
  window._dashboardLogs = logs;
}

function changeMonth(delta) {
  calendarMonth += delta;
  if (calendarMonth < 0) { calendarMonth = 11; calendarYear--; }
  if (calendarMonth > 11) { calendarMonth = 0; calendarYear++; }
  renderCalendar(window._dashboardLogs || []);
}

// Format date as YYYY-MM-DD in local timezone (not UTC)
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function renderCalendar(logs) {
  const label = document.getElementById('calMonthLabel');
  if (label) label.textContent = calendarYear + '\u5E74' + (calendarMonth + 1) + '\u6708';
  const grid = document.getElementById('calendarGrid');
  if (!grid) return;
  const studied = new Set(logs.filter(l => l.study_duration > 0).map(l => l.date));
  const todayStr = localDateStr(new Date());
  const firstDay = new Date(calendarYear, calendarMonth, 1);
  const lastDay = new Date(calendarYear, calendarMonth + 1, 0);
  const startWeekday = firstDay.getDay();
  const daysInMonth = lastDay.getDate();
  const days = [];
  const prevLastDay = new Date(calendarYear, calendarMonth, 0).getDate();
  for (let i = startWeekday - 1; i >= 0; i--) {
    days.push({ day: prevLastDay - i, studied: false, today: false, otherMonth: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(calendarYear, calendarMonth, d);
    const ds = localDateStr(date);
    days.push({ day: d, studied: studied.has(ds), today: ds === todayStr, otherMonth: false });
  }
  let nextDay = 1;
  while (days.length < 42) {
    days.push({ day: nextDay++, studied: false, today: false, otherMonth: true });
  }
  const weekHeaders = ['\u65E5','\u4E00','\u4E8C','\u4E09','\u56DB','\u4E94','\u516D'].map(d => '<div class="calendar-day-header">' + d + '</div>').join('');
  grid.innerHTML = weekHeaders + days.map(d => '<div class="calendar-day ' + (d.studied ? 'studied' : '') + ' ' + (d.today ? 'today' : '') + ' ' + (d.otherMonth ? 'other-month' : '') + '">' + (d.day || '') + '</div>').join('');
}

function generateVocabGrowth(vocab) { const today = new Date(), days = []; for (let i = 6; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); const ds = localDateStr(d); const c = vocab.filter(v => v.added_date <= ds).length; days.push({ shortDate: `${d.getMonth()+1}/${d.getDate()}`, count: c, height: c > 0 ? Math.max(5, Math.min(100, c * 5)) : 2 }); } return days; }
function generateAccuracyTrend(dictations) { const today = new Date(), days = []; for (let i = 6; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); const ds = localDateStr(d); const dd = dictations.filter(dt => dt.date === ds); const avg = dd.length > 0 ? Math.round(dd.reduce((s,x) => s + (x.accuracy||0), 0) / dd.length * 100) : 0; days.push({ shortDate: `${d.getMonth()+1}/${d.getDate()}`, accuracy: avg, height: avg > 0 ? avg : 2 }); } return days; }
async function calculateStreak(logs) { const studied = new Set(logs.filter(l => l.study_duration > 0).map(l => l.date)); let streak = 0; const today = new Date(); for (let i = 0; i < 365; i++) { const d = new Date(today); d.setDate(d.getDate() - i); if (studied.has(localDateStr(d))) streak++; else if (i > 0) break; } return streak; }
async function updateStreak() { if (!db) return; const logs = await dbSelect('study_log', '*'); const el = document.getElementById('streakCount'); if (el) el.textContent = await calculateStreak(logs); }
async function loadStreak() { if (!db) { if (!await initCloud()) return; } const logs = await dbSelect('study_log', '*'); const el = document.getElementById('streakCount'); if (el) el.textContent = await calculateStreak(logs); }

// ===== TAB =====
function switchTab(tab) {
  sessionStorage.setItem('activeTab', tab);
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.nav-tab[data-tab="${tab}"]`).classList.add('active');
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  if (tab === 'today') { if (!isPhaseInitialized || !todayData) loadToday(); else renderTodayPhases(); }
  else if (tab === 'vocab') loadVocab();
  else if (tab === 'review') loadReview();
  else if (tab === 'dashboard') loadDashboard();
}

// Restore the tab the user was on before refresh
function restoreTab() {
  const savedTab = sessionStorage.getItem('activeTab') || 'today';
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const tabBtn = document.querySelector(`.nav-tab[data-tab="${savedTab}"]`);
  if (tabBtn) tabBtn.classList.add('active');
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const tabContent = document.getElementById(`tab-${savedTab}`);
  if (tabContent) tabContent.classList.add('active');
  return savedTab;
}

// ===== TOAST =====
function showToast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3000); }

// Persistent enrichment status bar (shows loading/success/error for LLM background work)
function showEnrichStatus(type, msg) {
  let bar = document.getElementById('enrichStatus');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'enrichStatus';
    bar.style.cssText = 'position:fixed;top:56px;left:50%;transform:translateX(-50%);padding:8px 20px;border-radius:8px;font-size:14px;z-index:200;max-width:90%;text-align:center;transition:opacity 0.3s;';
    document.body.appendChild(bar);
  }
  const colors = {
    loading: 'background:var(--accent-blue);color:#fff;',
    success: 'background:var(--accent-green);color:#fff;',
    partial: 'background:var(--accent-orange);color:#fff;',
    error: 'background:var(--accent-red);color:#fff;'
  };
  bar.style.cssText += colors[type] || colors.loading;
  bar.textContent = type === 'loading' ? '\uD83D\uDD04 ' + msg : type === 'success' ? '\u2705 ' + msg : type === 'partial' ? '\u26A0\uFE0F ' + msg : '\u274C ' + msg;
  bar.style.opacity = '1';
  // Auto-hide success/error after 5 seconds, keep loading visible
  if (type !== 'loading') {
    setTimeout(() => { if (bar) bar.style.opacity = '0'; }, 5000);
  }
}

// ===== INIT =====
window.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  const hasSession = await checkSession();
  if (hasSession) showApp(); else showAuth();
});
