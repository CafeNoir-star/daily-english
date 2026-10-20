# B 方案：WorkBuddy 生成语料 + GitHub 同步音频

> 目标：WorkBuddy 定时生成语料并写库；GitHub Actions 只读语料、用 Python edge-tts 预生成音频、提交回仓库。
> 结果：**不需要 WorkBuddy 密码，不需要数据库写权限，0 人工，0 冷启动。**

---

## 一、职责划分

| 角色 | 由谁负责 | 说明 |
|---|---|---|
| 生成语料 + 生词 | WorkBuddy 现有定时任务 | 每周一 03:00，用 LLM 生成并写入 `daily_sentences` / `word_dictionary` |
| 读取语料 | GitHub Actions | 只带 publishable key 匿名读，不需要登录 |
| 生成音频 | GitHub Actions + Python edge-tts | 句子、全文、生词 MP3，全部预生成 |
| 存放音频 | GitHub 仓库 `audio/` | 提交回仓库，jsDelivr 直接提供 CDN |
| 前台 | WorkBuddy Sites | 常驻、国内快、原生登录/DB/LLM |
| 播放音频 | jsDelivr / R2 / COS | 纯静态 CDN，运行时不再调 TTS |

为什么 B 能做到“无密码”：`daily_sentences` 和 `word_dictionary` 的 RLS 允许匿名 SELECT，
Actions 只需要 `WB_KEY`（本来就在前端公开的 publishable key）就能读，完全不碰写接口。

---

## 二、链路

```
┌──────────────── WorkBuddy（每周一 03:00） ────────────────┐
│  LLM 生成语料 + 生词 → 写入 daily_sentences / word_dictionary │
└──────────────────────────┬───────────────────────────────┘
                           │（内容已在云库）
┌──────────────────────────▼───────────────────────────────┐
│ GitHub Actions audio-sync（每天 04:00，兜底）              │
│  1. 匿名读取 daily_sentences / word_dictionary             │
│  2. 计算音频任务，manifest 指纹命中就跳过                   │
│  3. Python edge-tts 只生成缺失的 MP3                       │
│  4. git commit audio/ + manifest.json                     │
└──────────────────────────┬───────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
     jsDelivr CDN                 WorkBuddy 前台
     预生成 MP3                   页面 / 登录 / DB / LLM
              └────────────┬────────────┘
                           ▼
                    浏览器播放音频
```

为什么 Actions 每天跑而不是每周：WorkBuddy 任务如果延迟或失败，第二天的运行会自动补上；
没有新内容时只是两次数据库读 + 487 个文件跳过，约 1 秒结束。

---

## 三、流水线每一步

文件：`pipeline.py`（默认 B 模式）、`tts.py`、`.github/workflows/audio-sync.yml`。

### 1. 匿名读取

```
GET /.cloud/database/rest/daily_sentences?select=...&order=date.asc
GET /.cloud/database/rest/word_dictionary?select=...
Header: x-wb-webapp-access-key: wbpk_...
```

没有 `Authorization`，没有登录，没有密码。

### 2. 音频任务

- 句子：`{date}_s0.mp3`、`{date}_s1.mp3`…
- 全文：`{date}_full.mp3`
- 生词：`vocab_{word}.mp3`
- 语音：`en-US-JennyNeural`（和原有 1144 个音频同音色）

### 3. 去重

`audio/manifest.json` 记录每个文件对应文本的 SHA1 指纹：
文本没变就跳过；文本变了自动重生成。重复运行是幂等的（实测 487 个文件 0 秒跳过）。

### 4. 失败处理

- 每个文件重试 4 次，整批结束后再串行重试一次；
- 并发 3（实测并发 4 会偶发微软接口断连）；
- 单个失败不影响其他文件，下次运行自动补。

### 5. 语料告警

`--fail-if-stale 2`：如果云库里最新日期不足“今天 + 2 天”，任务以退出码 3 结束。
工作流仍然会先提交已生成的音频，再标红告警，提示 WorkBuddy 定时任务可能没跑。

---

## 四、一次性配置

### 1. 建仓库并推送

```bash
cd C:/PycharmProject/自建应用
git init
git add .
git commit -m "feat: B 方案音频同步流水线"
git remote add origin git@github.com:<你的账号>/daily-english.git
git push -u origin main
```

> jsDelivr 只能读**公开仓库**。个人学习数据（`data/export_vocabulary.json` 等）已在 `.gitignore` 排除。
> 如果必须私有，把 `AUDIO_BASE` 换成 Cloudflare R2 / 腾讯云 COS，其它不变。

### 2. 配置 GitHub

Settings → Secrets and variables → Actions：

| 类型 | 名称 | 值 |
|---|---|---|
| Secret | `WB_KEY` | `wbpk_...`（app.js 里那串 publishable key） |
| Variable | `WB_ENDPOINT` | 可选，默认 `https://daily-english-22755.app.workbuddy.host` |

**不需要** `WB_EMAIL` / `WB_PASSWORD`。

### 3. 首次同步音频

Actions → `audio-sync` → Run workflow → Run。
本地已有的 487 个 MP3 会被跳过；如果仓库里没有音频，会全量生成（约 5-10 分钟）。

### 4. 前端指向 CDN

编辑 `config.js`：

```js
window.APP_CONFIG = {
  // 推荐 gcore / testingcf，本机实测比 cdn 更稳
  audioBase: "https://gcore.jsdelivr.net/gh/<账号>/daily-english@main/audio/",
  cloudEndpoint: ""
};
```

重新发布一次 WorkBuddy Sites（只此一次，之后每周不再动前端）。

### 5. 保留 WorkBuddy 定时任务

B 方案依赖它生成语料，**不要停用**：

- 名称：英语学习网站语料自动更新
- ID：`2f24f90d-9169-4a51-b21a-f51022e0e6c5`
- 时间：每周一 03:00

---

## 五、日常运行

- 周一 03:00：WorkBuddy 生成语料并写库。
- 周一 04:00：Actions 同步音频；之后每天 04:00 再兜底检查一次。
- 有新内容：生成缺失 MP3、提交仓库、jsDelivr 生效，前端不用重新部署。
- 没新内容：两次数据库读 + 全部跳过，约 1 秒。
- 语料不足 2 天：Actions 标红告警。

---

## 六、音频发布选择

| 方案 | 成本 | 国内速度 | 额外账号 | 说明 |
|---|---|---|---|---|
| **jsDelivr（gcore / testingcf）** | 0 | 较好 | 无 | 推荐先用；`gcore`、`testingcf` 实测比默认 `cdn` 稳 |
| Cloudflare R2 | 0（10GB + 无出口费） | 一般 | Cloudflare | 私有仓库或音频量大时用 |
| 腾讯云 COS | 少量 | 最快 | 有 | 对国内速度要求极高时用 |

切换只需改 `config.js` 的 `audioBase`，前端代码不用动。

---

## 七、成本

| 项目 | 费用 |
|---|---|
| 前台（WorkBuddy Sites） | 0 |
| 定时任务（GitHub Actions） | 0（公开仓库免费；私有仓库约 10 分钟/月） |
| 音频 CDN（jsDelivr） | 0 |
| TTS（edge-tts） | 0 |
| LLM（WorkBuddy 积分，由 WorkBuddy 任务消耗） | 按原样 |
| **合计** | **0 元** |

---

## 八、为什么不是 Render 做前台

Render 免费 Web Service 15 分钟无请求就休眠，冷启动 30-60 秒；保活只能降低概率：

- 31 天月份 744h，750h 额度只剩 6h 余量，只能有一个免费服务；
- Render 可随时重启免费实例，重启后第一个请求仍会慢；
- 保活器本身可能挂，官方也不推荐保活。

Render 适合做后台批处理（冷启动无所谓），不适合“打开即用”的前台。
如果一定要前台离开 WorkBuddy，免费且真正无冷启动的是 Render Static Site + Cloudflare Worker 反代。

---

## 九、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| Actions 报 `语料覆盖不足` | WorkBuddy 定时任务没跑/延迟 | 检查并手动跑一次 WorkBuddy 任务；Actions 会在下次自动补音频 |
| 音频 404 | push 没成功 / jsDelivr 还没回源 | 看 Actions 的 `Commit audio` 步骤；浏览器直接打开 MP3 URL 验证 |
| 音频没更新 | manifest 认为文本没变 | 确认 `daily_sentences` 真的更新了；必要时 `--force-audio` |
| TTS 部分失败 | 微软接口限流/断连 | 已内置 4 次重试 + 串行二次重试；下次运行自动补 |
| 前端没声音 | `config.js` 的 `audioBase` 没改 | 检查该值，重新发布一次前台 |

---

## 十、验收标准

- Actions 跑一次：匿名读到 30 天语料 + 310 个生词，只补缺失音频，提交回仓库。
- WorkBuddy 新增一天语料后，24 小时内 Actions 自动生成当天句子/全文/生词音频。
- GitHub 中不存在 WorkBuddy 密码。
- 前端播放新音频不需要重新部署。
- 语料不足时 Actions 失败告警。
