// Export user tables via SQL (bypasses RLS)
const createWorkBuddyCloud = require('@tencent-ai/workbuddy-cloud-sdk').createWorkBuddyCloud;
const fs = require('fs');
const path = require('path');

const cloud = createWorkBuddyCloud({
  endpoint: 'https://daily-english-22755.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_REDACTED'
});
const db = cloud.database;

async function main() {
  // vocabulary, study_log, dictation_history were exported via SQL tool
  // Save them to local files from the known data
  const outDir = path.join(__dirname, 'data');
  
  console.log('Note: vocabulary, study_log, dictation_history were exported via SQL tool.');
  console.log('Run export_db.js first for daily_sentences and word_dictionary.');
  console.log('Then manually save SQL query results to data/export_*.json files.');
}
main();
