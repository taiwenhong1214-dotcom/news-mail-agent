# News Agent

个人新闻助手：GitHub Actions 每 30 分钟抓取 RSS → 判重 → 预筛 → LLM 打分 → 高分新闻即时推送到 Telegram，每天 08:00（MYT）发一份日报，每周日 20:00 发周报；还可以在 Telegram 里直接和它对话：查新闻、联网搜索、读原文、盯梢话题、管理信源。
零服务器、零常驻电脑，只付 LLM API 费用（Gemini 有免费额度）。

> 当前进度：阶段 1（新闻流水线）和阶段 3（Telegram 对话 Worker）已完成；邮件功能暂不做。

## 工作流程

```
config/feeds.yaml + D1 动态信源
        │  并发抓取（单源 10s 超时，失败不影响其他源）
        ▼
规范化 URL / 只保留 48h 内条目
        │
        ├─ URL 判重（规范化 URL 的 hash + D1 UNIQUE）
        ├─ SimHash 判重（标题，汉明距离 ≤ 3，24h 内）→ 合并为"N 个来源报道"
        ├─ 预筛（config/filters.yaml：黑名单 / 广告模式 / 分组白名单 / 标题长度）
        ▼
LLM 打分（10 条一批，prompts/score.md）→ score / 分类 / 中文摘要 / 理由
        ▼
LLM 事件合并（prompts/events.md）：同一事件的不同角度报道归为一条
        ▼
≥ 8.5 分且刚抓到的单独推送（带 ⭐/👍/👎 按钮）；7–8.5 分每 3 小时合成一条「快讯合集」
  + 盯梢话题命中就推（≥4 分即可）  +  08:00 MYT 日报  +  周日 20:00 MYT 周报
  23:00–08:00 免打扰（只推 ≥9.5 分）；推送 24 小时后自动删除（收藏 / 点过 👍👎 的保留）
```

所有条目（包括被过滤的）都写入 D1，对话 bot 从这里检索。

## 部署（约 20 分钟）

### 1. 仓库

推到 GitHub，**设为公开仓库**：公开仓库的 Actions 分钟数不限量。私有仓库每月只有 2000 分钟，30 分钟一次会超额；如果要私有，就把 `.github/workflows/pipeline.yml` 里的 cron 改成每小时一次（`7 * * * *`）。

密钥都放在 GitHub Secrets 里，公开仓库也不会泄露。但要注意：**公开仓库的 Actions 日志任何人都能看**。代码里只打印统计数字和信源名，不打印密钥。

### 2. Telegram bot

1. 在 Telegram 里找 [@BotFather](https://t.me/BotFather)，发 `/newbot`，按提示起名，拿到 **bot token**（形如 `123456:ABC-...`）。
2. 给你的 bot 随便发一条消息。
3. 浏览器打开 `https://api.telegram.org/bot<你的token>/getUpdates`，在返回的 JSON 里找 `"chat":{"id":...}`，这个数字就是 **chat_id**。

（webhook 在第 7 步部署 Worker 后设置。）

### 3. Gemini API key

在 [Google AI Studio](https://aistudio.google.com/apikey) 创建 key。走的是 Gemini 的 OpenAI 兼容接口，换成其他服务商（DeepSeek 等）只需要改 `LLM_BASE_URL`、`LLM_MODEL` 和 key。

### 4. Cloudflare D1

需要 Node.js（用 `npx` 运行 wrangler，不用全局安装）。

```bash
cd worker
npx wrangler login
npx wrangler d1 create news-agent
# 把输出里的 database_id 填进 worker/wrangler.toml
npx wrangler d1 migrations apply news-agent --remote
```

然后在 Cloudflare 控制台创建 API token，给 Actions 写库用：
**My Profile → API Tokens → Create Token → Custom token**，权限选 `Account` / `D1` / `Edit`，保存好 token。
**Account ID** 在 Workers & Pages 概览页的右侧栏可以找到。

### 5. GitHub Secrets

仓库 **Settings → Secrets and variables → Actions → Secrets**，用页面下半部分的 **New repository secret** 按钮添加。
⚠️ 要加在 **Repository secrets**，不是上面的 Environment secrets（workflow 没有声明 environment，读不到那里的值）。每个 secret 的 Name 填下表左列，Secret 填对应的值：

| Secret | 值 |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare Account ID |
| `CF_API_TOKEN` | 上一步建的 D1 token |
| `D1_DATABASE_ID` | `wrangler d1 create` 输出的 id |
| `TELEGRAM_BOT_TOKEN` | bot token |
| `TELEGRAM_CHAT_ID` | 你的 chat_id |
| `LLM_API_KEY` | Gemini API key |

可选的 **Variables**（同一页面的 Variables 标签；不设就用默认值，完整列表和默认值见 `.env.example`）：`MAX_SCORE_BATCHES`、`PUSH_THRESHOLD`、`PUSH_MAX_PER_RUN`、`PUSH_MAX_AGE_HOURS`、`DIGEST_HOUR_MYT`、`WINDOW_HOURS`、`SIMHASH_DISTANCE`、`SIMHASH_WINDOW_HOURS`、`LLM_MODEL`、`LLM_FALLBACK_MODELS`、`LLM_BASE_URL`、`LLM_REASONING_EFFORT`。改了下次运行就生效，不用推送代码。

### 6. 试跑

**Actions → news-pipeline → Run workflow**。勾选 `force_digest` 可以立即收到一份日报，确认整条链路是通的。部署好第 7 步的 Worker 后，由 Worker 每 30 分钟准点触发；workflow 自带的定时任务只是每 6 小时一次的备份。（如果不部署 Worker，请把 `pipeline.yml` 里的 cron 改回 `7,37 * * * *`。）

> GitHub 自带的定时任务高峰期会延迟 10–30 分钟；公开仓库 60 天没有提交，定时任务还会被自动停用。第 7 步部署的 Worker 会用 Cloudflare Cron Trigger 准点触发，解决这两个问题。

### 7. 对话 Worker

需要先准备：
- **Tavily API key**：在 [tavily.com](https://tavily.com) 注册，免费额度每月 1000 次搜索。
- **GitHub fine-grained token**：GitHub → Settings → Developer settings → Fine-grained tokens。Repository access 只选本仓库，Permissions 选 **Actions: Read and write**。Worker 用它触发流水线（定时任务和 `/run` 命令）。
- **webhook secret**：自己生成一个随机字符串（只能用字母、数字、`_`、`-`），例如在 PowerShell 里运行 `[guid]::NewGuid().ToString('N')`。

```bash
cd worker
npm install
npx wrangler d1 migrations apply news-agent --remote   # 应用所有新迁移（0002、0003 …）

# 逐个设置密钥（每条命令会提示你粘贴值）
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # 上面生成的随机字符串
npx wrangler secret put ALLOWED_CHAT_IDS          # 你的 chat_id；多个用逗号分隔
npx wrangler secret put LLM_API_KEY               # Gemini key
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put GITHUB_TOKEN

npx wrangler deploy                               # 输出里有 Worker 地址：https://news-agent.<你的子域>.workers.dev
```

然后在浏览器打开一次 `https://news-agent.<你的子域>.workers.dev/setup?secret=<webhook secret>`，看到 `"ok":true` 就说明 webhook 设置好了。去 Telegram 给 bot 发 `/help` 试试。

Worker 的非敏感配置（对话模型、仓库名等）在 `worker/wrangler.toml` 的 `[vars]` 里。

**Bot 用法**：直接用中文提问，例如「今天有什么大事」「最近 AI 基础设施有什么新闻」「搜一下马来西亚数据中心招聘」「屏蔽 crypto」「把 https://xxx/feed 加到 DevOps」。

- **联网搜索**：说「搜一下 / 查一下 / 最新」会直接联网（Tavily），问最新进展时只搜最近一天或一周，需要细节时用 `read_page` 打开 1–2 个结果读全文。直接发链接也能读。`read_page` 用免 key 的 [Jina Reader](https://jina.ai/reader/)，失败时直接抓网页，不占 Tavily 额度。
- **省搜索额度**：每条消息最多真正搜 2 次；同样的搜索 6 小时内走 D1 缓存（只要最近一天的结果时缓存 2 小时）；用量以 Tavily `/usage` 为准，每小时同步一次。用到 80% 时 bot 提醒一次，用完就只查新闻库，等 Tavily 账单周期重置后自动恢复。`/status` 能看本周期用量。
- **推送节奏**（防止几天没看就堆成一长串）：≥8.5 分、3 小时内抓到的新闻单独推；7–8.5 分的攒起来，每 3 小时发一条「快讯合集」（最多列 15 条）。23:00–08:00 只推 9.5 分以上的，其余交给早上的日报；日报发出后，日报里的条目不会再进合集。推送 24 小时后自动删除，收藏过或点过 👍/👎 的保留，删掉的在日报、周报和搜索里都还在。这些参数都能用 GitHub Variables 调整：`PUSH_INSTANT_MIN`、`BUNDLE_INTERVAL_HOURS`、`QUIET_HOURS`（如 `23-8`，`off` 关闭）、`CLEANUP_AFTER_HOURS`（`0` 不删）。
- **回复推送追问**：回复某条推送或日报，说「展开讲讲」「对大马有什么影响」，bot 会读原文再回答。
- **按钮**：推送下面有 ⭐ 收藏 / 👍 / 👎。收藏用 `/saved` 看；👍 / 👎 会作为读者偏好样本带进打分 prompt（最近 60 天，各取 10 条，少于 3 条不生效）；`/status` 会列出 👎 最多的信源。
- **盯梢**：「帮我盯着 Kubernetes 1.36」「盯着 Google 大马数据中心」。之后抓到命中的新闻就推送，只要 ≥4 分（不用到 7 分），默认 30 天后过期，`/settings` 里能看到。
- **周报**：每周日 20:00 MYT 发：本周 5 件大事 + 趋势判断、各分类条数和上周对比、大马科技招聘雷达（扩张 / 裁员 / 新投资，打分时顺带抽取）。错过 24 小时就跳过这一周；Actions 里勾选 `force_weekly` 可以立即发一份。

快捷命令：

| 命令 | 作用 |
|---|---|
| `/digest [YYYY-MM-DD]` | 看日报（默认今天） |
| `/weekly` | 看最近一份周报 |
| `/saved` | 收藏的新闻（稍后读） |
| `/run` | 立即跑一次流水线：不受免打扰和合集间隔限制，攒着的快讯合集立即发出；跑完回报抓了多少、推了多少（没有可推的也会说） |
| `/status` | 上次运行情况、待打分积压、近 30 天反馈、联网搜索用量 |
| `/settings` | 对话里添加的信源、屏蔽词和盯梢 |
| `/reset` | 清空对话记忆（默认保留最近 20 轮） |
| `/webhook` | 重新注册 webhook（升级后推送按钮点了没反应时发一次） |

## 本地开发

```bash
python -m venv .venv
.venv/Scripts/activate            # macOS/Linux: source .venv/bin/activate
pip install -r pipeline/requirements.txt
cp .env.example .env              # 至少填 LLM_API_KEY

cd pipeline
python -m pytest                  # 单元测试 + 端到端测试（SQLite + 假 LLM）
python -m nma all --sqlite --dry-run --force-digest   # 真实抓取和打分，写本地 SQLite，消息只打印不发送
python -m nma fetch --sqlite      # 只跑某一个阶段：fetch / score / merge / push / digest / weekly
python -m nma weekly --sqlite --dry-run --force-weekly   # 立即生成一份周报看看
```

Worker：

```bash
cd worker
npm install
npx vitest run                    # 单元测试
npx wrangler dev --local          # 本地启动；密钥写在 worker/.dev.vars（已忽略），可加 TELEGRAM_DRY_RUN=1 只打印不发送
```

> Windows 上如果 vitest 报 `failed to find the current suite`，是盘符大小写问题：VS Code 终端的路径是小写 `c:\`，vitest 内部用大写 `C:\`。先 `cd` 到大写盘符的路径再运行。

流水线退出码：`0` 表示正常；`2` 表示有阶段出错，但已经发了 Telegram 告警；`1` 表示未捕获的崩溃，由 workflow 兜底告警。

## 调整

| 想改什么 | 改哪里 |
|---|---|
| 信源 | `config/feeds.yaml`。`tier: T1/T2` 是信源权重；`original_link: true` 用于聚合站，从摘要里取原文链接；也支持 `rsshub:/路由` |
| 过滤词 | `config/filters.yaml`。`block` 是全局黑名单，`require_any` 是分组白名单 |
| 打分标准、读者画像、招聘信息抽取 | `prompts/score.md` |
| 怎样算"同一事件" | `prompts/events.md` |
| 周报的大事和趋势 | `prompts/weekly.md` |
| 对话 bot 的人设和回答风格 | `prompts/chat_system.md`（改完需要 `npx wrangler deploy`） |
| 推送阈值、频率等 | GitHub Variables 或环境变量，完整列表见 `.env.example` |

## 用量估算

- **Gemini**：每 80 条约 2 万 token。按每天 500 条新条目算，约 13 万 token/天，在免费额度内；付费的话每月也不到 1 美元。
- **D1 免费版**：每天约几千行写入（上限 10 万），每年约 300MB（上限 5GB）。
- **Gemini 新增开销**：有反馈样本时每批打分多约 500 token，按每天约 50 批算多 2–3 万 token；周报每周 1 次调用。都在免费额度内。
- **Workers / Tavily**：Workers 免费版每天 10 万次请求；Tavily 免费额度每月 1000 次搜索（每次 basic 搜索 1 credit），有每条消息上限、缓存和用完后的降级，见上面「省搜索额度」。
- **Actions**：公开仓库不限分钟数。Gemini 正常时每次运行 1–2 分钟；主模型过载时会自动切到备用模型，最长约 6 分钟。

## 目录

```
.github/workflows/  pipeline.yml（定时流水线）、ci.yml（测试）
config/             feeds.yaml、filters.yaml
prompts/            score.md、events.md、weekly.md、chat_system.md
migrations/         D1 schema
pipeline/nma/       Python 流水线
  news/             fetch、normalize、simhash、prefilter、pipeline（入库 / 打分 / 合并 / 推送 / 盯梢）
  digest.py         日报
  weekly.py         周报
  llm.py            OpenAI 兼容客户端：重试、备用模型、JSON 容错解析
  db.py             D1 HTTP API / SQLite
worker/src/         Cloudflare Worker（TypeScript）
  index.ts          webhook / setup / cron 入口
  agent.ts          function calling 循环、对话历史
  tools.ts          search_news、top_news、get_digest、read_page、watch_topic、add_feed 等工具
  search.ts         web_search（Tavily）：每条消息上限、缓存、额度同步和降级
  feedback.ts       推送按钮（⭐ / 👍 / 👎）回调
  commands.ts       /digest /weekly /saved /run /status 等命令
docs/ARCHITECTURE.md
```
