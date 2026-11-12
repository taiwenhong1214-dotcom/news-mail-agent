# News Agent

个人新闻助手：GitHub Actions 每 30 分钟抓取 RSS → 判重 → 预筛 → LLM 打分 → 高分新闻即时推送到 Telegram，每天 08:00（MYT）发一份日报。
零服务器、零常驻电脑，只付 LLM API 费用（Gemini 有免费额度）。

> 当前进度：**阶段 1（新闻流水线）已完成**。阶段 3（Telegram 对话 Worker）待做；邮件功能暂不做。

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
score ≥ 7 即时推送（每次最多 8 条，只推 12h 内的）  +  08:00 MYT 日报
```

所有条目（包括被过滤的）都写入 D1，阶段 3 的对话 bot 会用来检索。

## 部署（约 20 分钟）

### 1. 仓库

推到 GitHub，**设为公开仓库**：公开仓库的 Actions 分钟数不限量。私有仓库每月只有 2000 分钟，30 分钟一次会超额；如果要私有，就把 `.github/workflows/pipeline.yml` 里的 cron 改成每小时一次（`7 * * * *`）。

密钥都放在 GitHub Secrets 里，公开仓库也不会泄露。但要注意：**公开仓库的 Actions 日志任何人都能看**。代码里只打印统计数字和信源名，不打印密钥。

### 2. Telegram bot

1. 在 Telegram 里找 [@BotFather](https://t.me/BotFather)，发 `/newbot`，按提示起名，拿到 **bot token**（形如 `123456:ABC-...`）。
2. 给你的 bot 随便发一条消息。
3. 浏览器打开 `https://api.telegram.org/bot<你的token>/getUpdates`，在返回的 JSON 里找 `"chat":{"id":...}`，这个数字就是 **chat_id**。

（webhook 在阶段 3 设置，现在只用 bot 往你这里推消息。）

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

仓库 **Settings → Secrets and variables → Actions**：

| Secret | 值 |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare Account ID |
| `CF_API_TOKEN` | 上一步建的 D1 token |
| `D1_DATABASE_ID` | `wrangler d1 create` 输出的 id |
| `TELEGRAM_BOT_TOKEN` | bot token |
| `TELEGRAM_CHAT_ID` | 你的 chat_id |
| `LLM_API_KEY` | Gemini API key |

可选的 **Variables**（不设就用默认值）：`LLM_MODEL`、`LLM_FALLBACK_MODELS`、`LLM_BASE_URL`、`PUSH_THRESHOLD`。

### 6. 试跑

**Actions → news-pipeline → Run workflow**。勾选 `force_digest` 可以立即收到一份日报，确认整条链路是通的。之后它会每 30 分钟自动跑一次。

> GitHub 的定时任务高峰期会延迟 10–30 分钟；公开仓库 60 天没有提交，定时任务还会被自动停用。阶段 3 会改成由 Cloudflare Worker 的 Cron Trigger 来触发，两个问题都能解决。

## 本地开发

```bash
python -m venv .venv
.venv/Scripts/activate            # macOS/Linux: source .venv/bin/activate
pip install -r pipeline/requirements.txt
cp .env.example .env              # 至少填 LLM_API_KEY

cd pipeline
python -m pytest                  # 单元测试 + 端到端测试（SQLite + 假 LLM）
python -m nma all --sqlite --dry-run --force-digest   # 真实抓取和打分，写本地 SQLite，消息只打印不发送
python -m nma fetch --sqlite      # 只跑某一个阶段：fetch / score / merge / push / digest
```

退出码：`0` 表示正常；`2` 表示有阶段出错，但已经发了 Telegram 告警；`1` 表示未捕获的崩溃，由 workflow 兜底告警。

## 调整

| 想改什么 | 改哪里 |
|---|---|
| 信源 | `config/feeds.yaml`。`tier: T1/T2` 是信源权重；`original_link: true` 用于聚合站，从摘要里取原文链接；也支持 `rsshub:/路由` |
| 过滤词 | `config/filters.yaml`。`block` 是全局黑名单，`require_any` 是分组白名单 |
| 打分标准、读者画像 | `prompts/score.md` |
| 怎样算"同一事件" | `prompts/events.md` |
| 推送阈值、频率等 | GitHub Variables 或环境变量，完整列表见 `.env.example` |

## 用量估算

- **Gemini**：每 80 条约 2 万 token。按每天 500 条新条目算，约 13 万 token/天，在免费额度内；付费的话每月也不到 1 美元。
- **D1 免费版**：每天约几千行写入（上限 10 万），每年约 300MB（上限 5GB）。
- **Actions**：公开仓库不限分钟数。Gemini 正常时每次运行 1–2 分钟；主模型过载时会自动切到备用模型，最长约 6 分钟。

## 目录

```
.github/workflows/  pipeline.yml（定时流水线）、ci.yml（测试）
config/             feeds.yaml、filters.yaml
prompts/            score.md、events.md
migrations/         D1 schema
pipeline/nma/       Python 流水线
  news/             fetch、normalize、simhash、prefilter、pipeline（入库 / 打分 / 合并 / 推送）
  digest.py         日报
  llm.py            OpenAI 兼容客户端：重试、备用模型、JSON 容错解析
  db.py             D1 HTTP API / SQLite
worker/             Cloudflare Worker（阶段 3）
docs/ARCHITECTURE.md
```
