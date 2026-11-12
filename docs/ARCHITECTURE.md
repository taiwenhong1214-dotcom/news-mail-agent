# News Agent — 架构（v1）

## 范围与阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 新闻流水线（GitHub Actions + D1 + Telegram 推送） | ✅ 完成 |
| 2 | 邮件（Gmail / Outlook） | ⏸ 暂不做 |
| 3 | 对话 Worker（Cloudflare Workers + function calling） | ✅ 完成 |

已确认的决定：公开仓库、每 30 分钟一次；LLM 用 Gemini（OpenAI 兼容接口）；实时搜索用 Tavily；领域共 10 组（见 `config/feeds.yaml`）。

## 1. 架构

```
 GitHub Actions (Python 3.12)  每 30 min，concurrency 组防重叠
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ fetch   feeds.yaml + D1 config_feeds → 并发抓取(10s 超时) → 规范化 → 48h 窗口 │
 │         → URL hash 判重 → SimHash(标题, ≤3, 24h) → 预筛 → 入库               │
 │ score   pending 条目 10 条一批 → LLM 打分 → JSON 容错解析（失败条目下次重试，≤3 次）│
 │ merge   最近 24h ≥6 分的主条目 → LLM 按事件分组 → 合并为一条                  │
 │ push    score≥7 且 12h 内且未推送 → Telegram（每次 ≤8 条）                    │
 │ digest  MYT ≥ 08:00 且今天未发 → Top 10 + 分类汇总 → Telegram                 │
 │ 每个阶段独立 try/except：出错发 Telegram 告警，后面的阶段照常跑                 │
 └───────────────┬──────────────────────────────────────────────┬──────────┘
                 │ D1 HTTP API                                  │ sendMessage
                 ▼                                              ▼
        ┌──────────────────┐                             ┌──────────────┐
        │  Cloudflare D1   │◄──── binding ───┐            │  Telegram    │
        └──────────────────┘                 │            └──────┬───────┘
                                    ┌────────┴────────────────────▼───────┐
                                    │ 阶段 3：Cloudflare Worker (TS)       │
                                    │ webhook 校验 → function calling      │
                                    │ search_news / get_digest / web_search│
                                    │ add_feed / mute_keyword              │
                                    │ + Cron Trigger 触发 workflow_dispatch │
                                    └──────────────────────────────────────┘
```

LLM 客户端：主模型 `gemini-3.5-flash-lite`，过载（429/5xx）或不存在（404）时依次切到 `gemini-3.1-flash-lite`、`gemini-2.5-flash`。服务商不支持 `reasoning_effort` 或 `response_format` 参数（返回 400）时，自动去掉该参数重试。

## 2. D1 表

见 `migrations/0001_init.sql`。

| 表 | 用途 |
|---|---|
| `news_items` | 所有条目。`url_hash UNIQUE` 兜底 URL 判重；`cluster_id` / `source_count` 记录事件聚类；`status`：pending / filtered / dup / scored / llm_failed |
| `news_fts` | FTS5 trigram 全文检索（标题、中文摘要、原始摘要），由触发器同步；已在 wrangler 本地 D1 上验证 |
| `digests` | 每日日报（date = MYT 日期） |
| `config_feeds` / `muted_keywords` | 对话里加的信源和屏蔽词，每次运行时和 yaml 里的配置合并 |
| `chat_history` / `tg_updates` | 阶段 3：对话历史（保留 20 轮）、webhook 去重 |
| `runs` | 每次运行的统计（JSON）和错误 |

## 3. 关键设计决定

| 问题 | 做法 | 原因 |
|---|---|---|
| SimHash 用什么文本 | **只用标题**（摘要权重默认 0） | 用 564 条真实数据实测：标题 + 摘要只找出 2 对重复，只用标题找出 19 对，0 误判。不同来源的摘要措辞差异太大 |
| SimHash 比较窗口 | 24h，比 48h 抓取窗口短 | 避免把每天都会出现的同类标题（如"Bursa Malaysia opens higher"）跨天合并 |
| 同一事件不同角度的报道 | 新增 LLM 事件合并（`prompts/events.md`），每次运行一次调用 | 实测在大新闻当天，8 条即时推送全是同一件事；合并后同一事件变成 1 条，显示「18 个来源报道」 |
| 合并时保留哪条 | 已推送的 > 分数高的 > T1 > 发布早的 | 已推送过的事件不会被重复推送 |
| 首次运行刷屏 | 只推 12h 内的条目，每次最多 8 条，每次最多打分 80 条 | 第一次运行时 48h 内的存量有 500 多条 |
| 日报准时 | 每次运行检查"已过 08:00 且今天没发" | 不依赖 GitHub 定时任务准点 |
| 聚合站链接 | `original_link: true`：从摘要里取第一个站外链接 | AIHOT 的条目链接指向站内页面，取原文链接才能和原始信源按 URL 判重 |
| 公开仓库日志 | 只打统计数字和信源名 | Actions 日志任何人都能看 |
| 退出码 | 0 正常 / 2 出错但已告警 / 1 崩溃（workflow 兜底告警） | 避免重复告警 |

## 4. 对话 Worker（阶段 3）

- **入口**：`POST /telegram`（校验 `X-Telegram-Bot-Api-Secret-Token`，chat_id 白名单，`update_id` 去重）；`GET /setup?secret=` 一键设置 webhook；Cron `7,37 * * * *` 触发 GitHub `workflow_dispatch`，失败时最多每 6 小时告警一次（`app_state` 表节流）
- **命令**（不经过 LLM）：`/digest` `/run` `/status` `/settings` `/reset` `/help`
- **工具**：`search_news`（FTS trigram；少于 3 个字的词走 LIKE；先 AND，没结果再 OR）、`top_news`、`get_digest`、`web_search`（Tavily，可选 `time_range`）、`read_page`（Jina Reader，失败时直接抓取）、`reverse_image_search`（Cloud Vision Web Detection，只在消息带图且配了 key 时提供）、`add_feed`（先抓取验证是 RSS/Atom）、`remove_feed`、`mute_keyword`、`unmute_keyword`、`list_settings`
- **对话**：`gemini-2.5-flash` 为主，备用 `gemini-3.1-flash-lite`、`gemini-3.5-flash-lite`；最多 4 轮工具调用，用完后强制给出回答；历史只存用户消息和最终回复，保留 20 轮
- **Gemini thought signature**：Gemini 3 要求回传工具调用的签名，代码会原样保留服务商返回的附加字段。中途换模型时，旧模型发起的调用没有签名，遇到 400 时补上官方占位签名再重试
- **Workers 免费版限制**：每次请求 CPU 10ms（等待网络不算），一条消息的子请求约 10–20 个（上限 50）。处理在请求内同步完成，Telegram 超时重发由 `update_id` 去重
- **图片**：照片取最大尺寸，以文件发送的只接受 image/*，上限 1.5MB。Worker 用 `getFile` 下载后转 base64，以 data URI 发给 LLM（文件 URL 含 bot token，不交给任何第三方）。Vision 的 key 放在 `x-goog-api-key` header，不出现在 URL 里。对话历史只存文字（`[发了一张图片] 问题`），不存图
- **CPU 预算**：base64 优先用原生 `Uint8Array.toBase64`，没有时查表写字节数组再一次性解码（300KB 约 1ms；`String.fromCharCode` + `btoa` 要 14ms，会超过免费版的 10ms 上限）
