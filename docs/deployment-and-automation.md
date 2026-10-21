# A 方案：GitHub Actions 全自动生成语料与音频

> 目标：**0 人工**。GitHub Actions 每天用 WorkBuddy LLM 生成语料、写入云库、用 Python edge-tts 预生成音频，全部提交回仓库。
> 前台常驻 WorkBuddy Sites，浏览器从 jsDelivr 读预生成 MP3，运行时不再调用任何 TTS 或 LLM。

---

## 一、职责划分

| 角色 | 由谁负责 | 说明 |
|---|---|---|
| 生成语料 + 生词 | GitHub Actions | 调 WorkBuddy LLM（`glm-5.3-flash`），消耗 WorkBuddy 积分 |
| 写入云库 | GitHub Actions | 用 WorkBuddy 账号登录拿 token，受 RLS 限制只能写指定表 |
| 读取语料 | GitHub Actions | 匿名读（publishable key），不需要登录 |
| 生成音频 | GitHub Actions + Python edge-tts | 句子、全文、生词 MP3，全部预生成 |
| 存放音频 | GitHub 仓库 `audio/` | 提交回仓库，jsDelivr 直接提供 CDN |
| 前台 | WorkBuddy Sites | 常驻、国内快、原生登录 / DB / LLM |
| 播放音频 | jsDelivr / R2 / COS | 纯静态 CDN，运行时不再调 TTS |

---

## 二、链路

```
┌──────────── GitHub Actions（每天 04:00 CST） ─────────────┐
│  1. 登录 WorkBuddy（WB_EMAIL / WB_PASSWORD）               │
│  2. 读云库最新日期，算出未来 30 天窗口缺哪几天              │
│  3. 逐天调 LLM 生成语料（WorkBuddy 积分）                   │
│  4. 校验后写入 daily_sentences / word_dictionary           │
│  5. 匿名重读语料，算出音频任务                              │
│  6. Python edge-tts 只生成缺失的 MP3                       │
│  7. git commit audio/ + manifest.json                     │
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

**WorkBuddy 和 GitHub 之间没有双向通讯。** 唯一的跨系统调用是 Actions →
WorkBuddy 的公开 REST 接口（读语料、调 LLM、写库），从 GitHub 机房发出，
与你的电脑、你的网络、代理开关都无关。

为什么每天跑而不是每周：单天失败只影响单天，第二天自动补；没有新内容时，
`plan_dates` 判定缓冲区已满，不会调用 LLM（不花积分），只做一次数据库读。

---

## 三、LLM 与密码的分工

这是最容易混淆的一点：

| 动作 | 认证方式 | 需要密码吗 | 计费 |
|---|---|---|---|
| 调 LLM 生成语料 | `x-wb-webapp-access-key: wbpk_...` | 不需要 | **扣 WorkBuddy 积分** |
| 写 `daily_sentences` / `word_dictionary` | 登录得到的 `access_token` | 需要 | 无关 |
| 读语料 | `x-wb-webapp-access-key: wbpk_...` | 不需要 | 无关 |

也就是说密码只用于「以你的身份执行 INSERT」。模型调用走的仍然是 WorkBuddy
自己的 LLM 网关，和浏览器里补词义用的是同一套积分。

---

## 四、安全边界

### 1. 密码怎么存

GitHub → Settings → Secrets and variables → Actions → Secrets。

- 服务端加密保存，**存进去后连你自己也看不到明文**，只能覆盖或删除；
- 只在 workflow 运行时解密为环境变量，日志中出现会自动脱敏成 `***`；
- 仓库代码里只有 `${{ secrets.WB_PASSWORD }}` 占位符，不含真实值；
- GitHub 不会向 fork 的 PR 注入 secrets。

`pipeline.py` 中密码只出现在登录请求的 body 里，没有任何打印语句。

### 2. 数据库权限（RLS）

| 表 | 匿名 | 登录用户 | 你的账号（uid `OWNER_UID`） |
|---|---|---|---|
| `daily_sentences` | 只读 | 只读 | 只读 + 插入 + 更新 |
| `word_dictionary` | 只读 | 只读 | 只读 + 写 |
| `vocabulary` / `study_log` / `dictation_history` / `user_profiles` | 无 | 仅自己的行 | 仅自己的行 |

策略名：`daily_sentences_owner_insert`、`daily_sentences_owner_update`、
`word_dictionary_owner_write`，条件均为 `auth.uid() = 'OWNER_UID'`。

即使密码泄露，攻击者也**只能写这两张内容表**，碰不到你的生词本和学习记录。

### 3. 公开仓库会暴露什么

- 会：源码、音频文件、Actions 日志、`app.js` 里的 publishable key（本来就公开，只能读）。
- 不会：`WB_PASSWORD`、`WB_EMAIL`、`WB_KEY` 的值。

建议给 GitHub 账号开启 2FA，且不要随意添加 Collaborator。

---

## 五、流水线每一步

文件：`pipeline.py`（`--with-corpus` 为 A 模式）、`tts.py`、`.github/workflows/audio-sync.yml`。

### 1. 登录

```
POST /.cloud/auth/v1/signin
Header: x-wb-webapp-access-key: wbpk_...
Body:   {"username": "...", "password": "..."}
```

返回 `access_token`，后续写库带 `Authorization: Bearer <token>`。

### 2. 语料生成

逐天调用，避免长输出被截断：

```
POST /.cloud/llm/chat/completions
Body: {model, messages, stream: true}
```

每天产出：4-5 句英文、中文翻译、来源与难度、8 个生词（含音标 / 词性 / 释义 / 例句）。

### 3. 校验

- 日期连续、不与已有行重复；
- `sentences` 拆分结果与 `english_text` 一致；
- 中文翻译非空、生词字段完整；
- 不满足则重试，超过阈值跳过当天（下次运行再补）。

### 4. 写库

```
POST /.cloud/database/rest/daily_sentences
POST /.cloud/database/rest/word_dictionary
Header: Authorization: Bearer <token>
```

`id` 显式指定（两张表都不带自增默认值）。

### 5. 音频任务

- 句子：`{date}_s0.mp3`、`{date}_s1.mp3`…
- 全文：`{date}_full.mp3`
- 生词：`vocab_{word}.mp3`
- 语音：`en-US-JennyNeural`（和原有音频同音色）

### 6. 去重与重试

`audio/manifest.json` 记录每个文件对应文本的 SHA1 指纹，文本没变就跳过。
每个文件重试 4 次，整批结束后再串行重试一次；并发 3。

### 7. 语料告警

`--fail-if-stale 2`：云库最新日期不足「今天 + 2 天」时以退出码 3 结束，
Actions 标红并邮件通知，说明语料生成环节出了问题。

---

## 六、一次性配置

### 1. 配置 GitHub Secrets

Settings → Secrets and variables → Actions：

| 类型 | 名称 | 值 |
|---|---|---|
| Secret | `WB_KEY` | `app.js` 里 `publishableKey` 那串 `wbpk_...` |
| Secret | `WB_EMAIL` | `your@email.com` |
| Secret | `WB_PASSWORD` | WorkBuddy 登录密码 |
| Variable | `WB_ENDPOINT` | `https://daily-english-38358.app.workbuddy.host` |

三个 Secret 缺任一，`Generate corpus` 会跳过并打警告（音频同步仍照常运行）。

### 2. 触发一次

Actions → `audio-sync` → **Run workflow**（右上角下拉，不是 Re-run）→ Run。

> 注意：**不要用「Re-run all jobs」**。Re-run 会复用原始运行的 SHA 和旧版工作流定义，
> 改了工作流也不会生效，表现为一直报同样的错。

### 3. 前端指向 CDN

`config.js`：

```js
window.APP_CONFIG = {
  audioBase: "https://gcore.jsdelivr.net/gh/<账号>/daily-english@main/audio/",
  cloudEndpoint: ""
};
```

改完重新发布一次 WorkBuddy Sites，之后不再需要动前端。

---

## 七、日常运行

- 每天 04:00：Actions 登录 → 补足 30 天语料窗口 → 写库 → 生成缺失音频 → 提交仓库。
- 有新内容：LLM 生成 + TTS 预生成，jsDelivr 自动生效，前端不用重新部署。
- 没新内容：`plan_dates` 返回空，不调 LLM（不花积分），音频全部跳过，约 1-2 秒。
- 语料不足 2 天：Actions 标红告警。
- 本机 git push 需要代理（`http.proxy` 已设为 `socks5h://127.0.0.1:10808`），
  但**日常运行完全不需要你 push**。

---

## 八、音频发布选择

| 方案 | 成本 | 国内速度 | 额外账号 | 说明 |
|---|---|---|---|---|
| **jsDelivr（gcore / testingcf）** | 0 | 较好 | 无 | 推荐先用；`gcore`、`testingcf` 实测比默认 `cdn` 稳 |
| Cloudflare R2 | 0（10GB + 无出口费） | 一般 | Cloudflare | 私有仓库或音频量大时用 |
| 腾讯云 COS | 少量 | 最快 | 有 | 对国内速度要求极高时用 |

切换只需改 `config.js` 的 `audioBase`，前端代码不用动。

---

## 九、成本

| 项目 | 费用 |
|---|---|
| 前台（WorkBuddy Sites） | 0 |
| 定时任务（GitHub Actions） | 0（公开仓库免费） |
| 音频 CDN（jsDelivr） | 0 |
| TTS（edge-tts） | 0 |
| LLM（WorkBuddy 积分） | 按原样消耗 |
| **合计** | **0 元** |

---

## 十、为什么不是 Render 做前台

Render 免费 Web Service 15 分钟无请求就休眠，冷启动 30-60 秒；保活只能降低概率：

- 31 天月份 744h，750h 额度只剩 6h 余量，只能有一个免费服务；
- Render 可随时重启免费实例，重启后第一个请求仍会慢；
- 保活器本身可能挂，官方也不推荐保活。

Render 适合做后台批处理（冷启动无所谓），不适合「打开即用」的前台。
如果一定要前台离开 WorkBuddy，免费且真正无冷启动的是 Render Static Site + Cloudflare Worker 反代。

---

## 十一、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `Generate corpus` 报缺少 `WB_EMAIL / WB_PASSWORD` | Secrets 没配 | 按第六节补上三个 Secret |
| 登录 401 / 400 | 密码错，或账号被改 | 用浏览器登录一次前台确认密码，再更新 Secret |
| 写库 401 `permission denied` | RLS 策略缺失，或登录的不是 owner 账号 | 检查 `daily_sentences_owner_insert/update` 与 uid 是否匹配 |
| `语料覆盖不足` | 生成环节失败多日 | 看 `Generate corpus` 日志；Actions 会在下次自动补 |
| Commit 步骤 `fetch first` | 用了 Re-run，或仓库有分支保护 | 改用右上角 Run workflow；分支保护则改走 PR |
| 音频 404 | push 没成功 / jsDelivr 未回源 | 看 `Commit audio` 步骤；浏览器直接打开 MP3 URL |
| 音频没更新 | manifest 认为文本没变 | 确认语料真的变了；必要时 `--force-audio` |
| TTS 部分失败 | 微软接口限流/断连 | 已内置重试；下次运行自动补 |
| 前端没声音 | `config.js` 的 `audioBase` 没改 | 检查该值，重新发布一次前台 |

---

## 十二、验收标准

- Actions 跑一次：补足 30 天语料窗口、写入新语料、生成对应音频、提交回仓库。
- 第二天 04:00 再跑：`plan_dates` 判定缓冲区已满，不调 LLM，全部跳过，1-2 秒结束。
- GitHub 中不存在明文密码，日志中不出现密码。
- 匿名用户无法写 `daily_sentences`（返回 401 `permission denied`）。
- 前端播放新音频不需要重新部署。
- 语料不足时 Actions 失败告警。

---

## 十三、安全加固记录（2026-10-21）

| 项目 | 处理 |
|---|---|
| 属性上下文 XSS | `app.js` 新增 `escAttr()`，替换 6 处 `onclick` / `class` 拼接 |
| LLM 调用配额 | `LLM_DAILY_LIMIT = 50`，`llmQuota()` 在批量查词前检查 |
| 安全响应头 | 补 `Strict-Transport-Security`、`Permissions-Policy` |
| CI 供应链 | `actions/checkout` / `setup-python` 固定到 commit SHA |
| 示例配置 | `.env.example` 移除真实邮箱 |

回归测试：`test/security-hardening.test.js`（15 项）+ `test/security.test.js`（23 项）全部通过。

---

## 十四、待补词队列（2026-10-21 起）

**前端不再直接调用大模型。** 这是为了从根上消除「publishableKey 公开 → 任何人可无限刷积分」的风险。

### 改前 vs 改后

| | 改前 | 改后 |
|---|---|---|
| 用户标记的词不在词库 | 前端立即调 LLM 补释义 | 写入 `pending_words` 队列，卡片显示「待补充」 |
| LLM 由谁调用 | **浏览器**（用公开 key） | **GitHub Actions**（用账号密码登录） |
| key 泄露后果 | 可无限刷积分 | 只能读语料（受 RLS 限制） |

### 数据流

```
用户标记生词（词库没有）
  → 前端 upsert 到 pending_words（只有 word 一列，不含用户身份）
        ↓
Actions 每天 04:00
  → 读 pending_words（上限 PENDING_BATCH=50）
  → 调 LLM 补释义
  → 写入 word_dictionary（公共词库，所有人受益）
  → 从 pending_words 删除
        ↓
下次任何人查这个词，都有释义了
```

工作流步骤顺序：`Generate corpus` → **`Enrich pending words`** → `Sync audio`。
放在音频同步之前，是为了让新增的词能在同一次运行里生成读音。

### pending_words 表

```sql
CREATE TABLE public.pending_words (
  word       TEXT PRIMARY KEY CHECK (word ~ '^[a-z][a-z''-]{1,49}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

| 策略 | 角色 | 规则 |
|---|---|---|
| `pending_words_read` | authenticated | `USING (true)` |
| `pending_words_insert` | authenticated | `WITH CHECK (true)`，必须登录才能写 |
| `pending_words_owner_delete` | authenticated | 仅 owner uid 可删除（Actions 清理用） |

匿名既不能读也不能写。`CHECK` 约束只允许小写英文单词，防止垃圾数据注入。

### 取舍

- **代价**：当天新标记的陌生词，释义要等到下一次 Actions 运行（最多 24 小时）。
- **收益**：前端一个 LLM 请求都不发，积分盗刷面归零；补一次所有用户共享。
