/**
 * 本地音频生成脚本
 * 查询云数据库 daily_sentences 和 word_dictionary，用 edge-tts 生成缺失的 MP3 音频
 * 
 * 用法：node generate_audio.js
 * 需要在本地运行（edge-tts 需要连接微软 TTS WebSocket 服务）
 * 
 * 生成内容：
 * 1. 句子音频：audio/{date}_s{index}.mp3（每个单句）
 * 2. 全文音频：audio/{date}_full.mp3（整段英文）
 * 3. 生词音频：audio/vocab_{word}.mp3（词典表里 audio_url 指向但没有文件的词）
 */

const { EdgeTTS } = require('@travisvn/edge-tts');
const fs = require('fs');
const path = require('path');

const VOICE = 'en-US-JennyNeural';
const AUDIO_DIR = path.join(__dirname, 'audio');

// Cloud SDK setup
const createWorkBuddyCloud = require('@tencent-ai/workbuddy-cloud-sdk').createWorkBuddyCloud;
const cloud = createWorkBuddyCloud({
  endpoint: 'https://daily-english-22755.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_REDACTED'
});
const db = cloud.database;

// Ensure audio directory exists
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Generate one MP3 file using edge-tts
async function generateMP3(text, outputPath, rate) {
  if (fs.existsSync(outputPath)) {
    console.log(`  SKIP (exists): ${path.basename(outputPath)}`);
    return false;
  }
  try {
    const tts = new EdgeTTS(text, VOICE, {
      rate: rate || '+0%',
      volume: '+0%',
      pitch: '+0Hz',
    });
    const result = await tts.synthesize();
    const audioBuffer = Buffer.from(await result.audio.arrayBuffer());
    fs.writeFileSync(outputPath, audioBuffer);
    console.log(`  OK: ${path.basename(outputPath)} (${audioBuffer.length} bytes)`);
    return true;
  } catch (e) {
    console.log(`  FAIL: ${path.basename(outputPath)} - ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('=== Audio Generation Script ===');
  console.log('Time:', new Date().toISOString());

  // Step 1: Get all sentences from daily_sentences table
  console.log('\n--- Step 1: Fetching daily_sentences ---');
  const { data: sentences, error: sErr } = await db.from('daily_sentences').select('date, english_text, sentences').order('date', { ascending: true });
  if (sErr) { console.log('DB error:', sErr); return; }
  console.log(`Found ${sentences.length} days of sentences`);

  let generated = 0;

  // Step 2: Generate sentence audio files
  console.log('\n--- Step 2: Generating sentence audio ---');
  for (const day of sentences) {
    const date = day.date;
    let sents = day.sentences;
    if (typeof sents === 'string') { try { sents = JSON.parse(sents); } catch(e) { continue; } }
    if (!Array.isArray(sents) || sents.length === 0) continue;

    // Full text audio
    const fullPath = path.join(AUDIO_DIR, `${date}_full.mp3`);
    if (await generateMP3(day.english_text, fullPath)) generated++;

    // Per-sentence audio
    for (let i = 0; i < sents.length; i++) {
      const sentPath = path.join(AUDIO_DIR, `${date}_s${i}.mp3`);
      if (await generateMP3(sents[i], sentPath)) generated++;
    }
  }

  // Step 3: Get words from word_dictionary that have audio_url but no local file
  console.log('\n--- Step 3: Generating word audio ---');
  const { data: words, error: wErr } = await db.from('word_dictionary').select('word, audio_url');
  if (wErr) { console.log('DB error:', wErr); return; }
  
  let wordGenerated = 0;
  for (const w of words) {
    if (!w.audio_url) continue;
    const wordLower = w.word.toLowerCase();
    const wordPath = path.join(AUDIO_DIR, `vocab_${wordLower}.mp3`);
    if (fs.existsSync(wordPath)) continue;
    if (await generateMP3(w.word, wordPath)) wordGenerated++;
  }

  console.log(`\n=== Done ===`);
  console.log(`Sentence audio generated: ${generated}`);
  console.log(`Word audio generated: ${wordGenerated}`);
  console.log(`Total new files: ${generated + wordGenerated}`);
  if (generated + wordGenerated > 0) {
    console.log('\n⚠️  Remember to deploy to update cloud audio files:');
    console.log('   Use WorkBuddy Sites deploy to push new audio files to the cloud.');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
