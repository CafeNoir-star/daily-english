# 每日英语学习应用 - 项目完整说明

## 项目概述

一个英语学习网站，包含盲听、精读、生词学习、跟读、默写、复盘六个学习阶段。支持用户标记生词、AI 补充释义、定时生成新语料。

**线上地址**：https://daily-english-22755.app.workbuddy.host/
**WorkBuddy 应用 ID**：wbapp_6rjFhUddsmXX1zjt5ytvBv

---

## 文件结构

### 核心应用文件（部署到 WorkBuddy Sites）

| 文件 | 说明 | 大小 |
|------|------|------|
| `index.html` | 前端 HTML + CSS | ~30KB |
| `app.js` | 前端 JavaScript（所有交互逻辑） | ~68KB |
| `config.js` | 运行时配置（音频 CDN 前缀 `audioBase`） | ~300B |
| `server.js` | Node.js 后端（静态文件服务 + /api/lookup 词典查询） | ~12KB |
| `package.json` | 依赖声明（@tencent-ai/workbuddy-cloud-sdk + @travisvn/edge-tts） | ~200B |
| `pipeline.py` | 全自动流水线：生成语料 → 写库 → edge-tts 预生成音频（`--with-corpus` 为 A 模式） | ~960 行 |
| `tts.py` | edge-tts 单条合成 CLI（Node / shell 可调用） | ~60 行 |
| `requirements.txt` | Python 依赖（edge-tts + requests） | ~60B |
| `.github/workflows/audio-sync.yml` | GitHub Actions 每日同步（语料 + 音频，每天 04:00） | ~150 行 |
| `audio/` | 预生成 MP3 音频（由 pipeline.py 生成，提交回仓库） | 按语料量增长 |

### 数据文件（本地备份）

| 文件 | 说明 |
|------|------|
| `data/export_daily_sentences.json` | 云数据库 daily_sentences 表导出（30 条语料） |
| `data/export_word_dictionary.json` | 云数据库 word_dictionary 表导出（310 个单词） |
| `data/export_vocabulary.json` | 用户生词本导出（16 条，RLS 限制需 SQL 导出） |
| `data/export_study_log.json` | 学习记录导出（4 条） |
| `data/export_dictation_history.json` | 默写历史导出（30 条） |
| `data/export_schema.json` | 数据库表结构定义 |
| `corpus.js` | 旧版本地语料数据（已停用，保留作备份） |
| `dictionary.js` | 旧版本地词典数据（已停用，数据已导入云数据库） |

### 工具脚本

| 文件 | 说明 |
|------|------|
| `generate_audio.js` | 旧版本地音频生成脚本（已被 `pipeline.py` 取代） |
| `generate_audio_and_deploy.bat` | 旧版一键脚本（已停用） |
| `export_db.js` | 导出云数据库到本地 JSON |
| `generate_dict.js` | 旧版词典生成脚本（已停用） |
| `import_dict.js` | 旧版词典导入脚本（已停用） |
| `fetch_definitions.mjs` | 旧版释义抓取脚本（已停用） |

### 测试

| 文件 | 说明 |
|------|------|
| `test/security.test.js` | 安全测试（23 项，路径穿越/敏感文件/API 验证/Headers） |
| `test/test_pipeline.py` | 流水线单元测试（9 项：匿名读、鉴权读、覆盖检查、CLI） |

### 文档

| 文件 | 说明 |
|------|------|
| `docs/deployment-and-automation.md` | 全自动语料 + 音频链路、GitHub Actions 配置、Render 说明 |
| `docs/tencent-cloud-deploy-guide.md` | 旧版腾讯云 SCF + COS 方案（已不适用） |

### WorkBuddy 配置

| 文件 | 说明 |
|------|------|
| `.wbapp_6rjFhUddsmXX1zjt5ytvBv.genie` | WorkBuddy 应用标记文件 |
| `.workbuddy/memory/` | 工作记忆日志 |

---

## 云数据库表结构

### daily_sentences（语料表，30 条）
- `id` bigint PK（**无自增默认值**，写入时需显式计算 `max(id)+1`）
- `date` text（YYYY-MM-DD）
- `english_text` text（4-5 句英文段落）
- `chinese_translation` text（中文翻译）
- `source` text（来源，如 "VOA News"）
- `source_type` text（news/ted/speech/literature）
- `difficulty` text（beginner/intermediate/advanced）
- `sentences` jsonb（拆分的单句数组）
- `created_at` timestamptz
- RLS：anon / authenticated 可读；仅 owner 账号（uid `OWNER_UID`）可 INSERT / UPDATE

### word_dictionary（词典表，310 条）
- `id` bigint PK
- `word` text UNIQUE
- `phonetic` text（音标）
- `pos` text（词性）
- `definition` text（中文释义）
- `example_sentence` text（英文例句）
- `example_translation` text（中文翻译）
- `memory_tips` jsonb（`{root_analysis, mnemonic}`）
- `audio_url` text（`/audio/vocab_{word}.mp3`）
- `difficulty_level` text
- RLS：authenticated + anon 可读，authenticated 可写

### vocabulary（用户生词本，16 条）
- `id` bigint PK
- `word, phonetic, pos, definition, example_sentence, example_translation, memory_tips, audio_url, difficulty_level`
- `srs_level` int（间隔复习等级，默认 1）
- `next_review` date（下次复习日期）
- `review_count` int
- `status` text（new/learning/mastered/permanent）
- `added_date, last_reviewed, source_date, source_text`
- `owner_id` text（auth.uid()）
- RLS：owner_id = auth.uid()

### study_log（学习记录，4 条）
- `id, date, start_time, study_duration, completed_phases, new_words_count, review_words_count, dictation_score, owner_id`
- RLS：owner_id = auth.uid()

### dictation_history（默写历史，30 条）
- `id, date, sentence_index, original_text, user_input, errors, accuracy, owner_id`
- RLS：owner_id = auth.uid()

---

## WorkBuddy Cloud 配置

```
endpoint: https://daily-english-22755.app.workbuddy.host
publishableKey: wbpk_REDACTED
oauthRelayBaseUrl: https://www.workbuddy.cn/v2/as/genie-baas/oauth
```

---

## 定时任务（A 方案：GitHub Actions 全包）

**GitHub Actions 每天自动生成语料、写库、预生成音频，0 人工。**

- **工作流**：`.github/workflows/audio-sync.yml`
- **时间**：每天 04:00（Asia/Shanghai），支持手动触发
- **步骤**：
  1. 登录 WorkBuddy（`WB_EMAIL` / `WB_PASSWORD`），补足未来 30 天语料窗口
  2. 逐天调 WorkBuddy LLM（`glm-5.3-flash`，消耗积分）生成语料并校验
  3. 写入 `daily_sentences` / `word_dictionary`（RLS 仅允许 owner 账号）
  4. 匿名重读语料，用 `edge-tts` 预生成句子 / 全文 / 生词 MP3
  5. 提交 `audio/` + `manifest.json` 回仓库，前端通过 jsDelivr 播放
  6. 语料不足 2 天时标红告警
- **幂等**：`plan_dates` 在缓冲区已满时不调用 LLM（不花积分）；`manifest.json` 记录文本指纹，未变化不重复生成
- **Secrets**：`WB_KEY`、`WB_EMAIL`、`WB_PASSWORD`；**Variable**：`WB_ENDPOINT`

> 旧的 WorkBuddy 定时任务已随旧应用一并删除，A 方案不再依赖它。

详细说明见 `docs/deployment-and-automation.md`。

---

## 音频文件

`audio/` 目录由 `pipeline.py` 预生成（不是运行时合成）：
- 句子音频：`{date}_s{index}.mp3`（如 `2026-10-19_s0.mp3`）
- 全文音频：`{date}_full.mp3`
- 生词音频：`vocab_{word}.mp3`
- 语音引擎：edge-tts `en-US-JennyNeural`（微软神经语音）
- 播放地址：`app.js` 通过 `config.js` 的 `audioBase` 拼接，可指向 jsDelivr / R2 / 站点本地 `audio/`
- 首次全量回填：`python pipeline.py --from-export`（读 `data/export_*.json`，实测 487 个文件 / 11.7MB / 345 秒）

---

## 迁移到其他平台时的注意事项

1. **数据库**：需要创建 5 张表（schema 见 `data/export_schema.json`），导入数据用 `data/export_*.json`
2. **前端**：`index.html` + `app.js` + `config.js` 需要改数据库连接配置
3. **后端**：`server.js` 提供静态文件服务 + `/api/lookup` 词典查询
4. **LLM**：WorkBuddy Cloud LLM 的浏览器调用受 Origin 白名单限制；服务端（无 Origin 头）调用可用，详见 `docs/deployment-and-automation.md`
5. **音频**：`audio/` 由流水线预生成，可放 CDN / 对象存储，前端用 `config.js` 的 `audioBase` 指向
6. **定时任务**：已迁移到 GitHub Actions，不再依赖平台定时器
7. **用户认证**：WorkBuddy Cloud Auth 需要替换为其他认证方案

> **关于 Render**：免费 Web Service 会在 15 分钟无请求后休眠，冷启动 30-60 秒，
> 无法满足"首次打开不能等"的要求；免费 Static Site 不能运行动态代理。
> 因此前台继续留在 WorkBuddy Sites，Render 不参与前台部署。详见迁移文档。

---

## 当前版本

- app.js 版本：v=20261020a
- 最后更新：2026-10-20
- 前台部署：WorkBuddy Sites（Node.js HTTP 服务）
- 自动化：A 方案（GitHub Actions 每天生成语料 + 写库 + 预生成音频 + jsDelivr）
