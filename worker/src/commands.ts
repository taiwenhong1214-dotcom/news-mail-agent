import { clearHistory } from "./agent";
import { GROUPS } from "./config";
import type { Env } from "./env";
import { dispatchPipeline } from "./github";
import type { Telegram } from "./telegram";
import { fetchTavilyUsage } from "./search";
import { listSettings } from "./tools";
import { escapeHtml, fmtMyt, mytDate } from "./util";

const HELP = `<b>我能做的事</b>
直接用中文问我就行，比如：
• 今天有什么大事？
• 最近 AI 基础设施有什么新闻
• 搜一下马来西亚数据中心招聘（说「搜一下 / 最新」会直接联网）
• 发一个链接：帮你读全文、总结
• 帮我盯着 Kubernetes 1.36（有新闻就推送，默认 30 天）
• 屏蔽关键词 crypto
• 添加信源 https://example.com/feed 到 DevOps

<b>推送节奏</b>：≥8.5 分的新消息单独推；7–8.5 分的每 3 小时合成一条「快讯合集」；23:00–08:00 只推 9.5 分以上的，其余进早上的日报；推送 24 小时后自动删除（收藏或点过 👍/👎 的保留）
<b>回复推送</b>：直接回复某条推送说「展开讲讲」「对大马有什么影响」，或回复合集说「展开第 3 条」，我会读原文再回答
<b>推送下面的按钮</b>：⭐ 收藏（/saved 查看）；👍 / 👎 会影响以后的打分

<b>快捷命令</b>
/digest [YYYY-MM-DD] 看日报（默认今天）
/weekly 看最近一份周报（每周日 20:00 MYT 发）
/saved 收藏的新闻（稍后读）
/run 立即运行一次新闻流水线
/status 上次流水线运行情况
/settings 对话里加的信源、屏蔽词和盯梢
/reset 清空对话记忆
/webhook 重新注册 webhook（按钮点了没反应时用）
/help 显示这条说明`;

interface CmdContext {
  env: Env;
  tg: Telegram;
  chatId: number;
  now: number;
  fetchImpl: typeof fetch;
  origin?: string; // Worker 自己的地址，/webhook 用
}

/** 处理 / 开头的命令；不是已知命令时返回 false（交给 LLM） */
export async function handleCommand(text: string, ctx: CmdContext): Promise<boolean> {
  const [rawCmd, ...rest] = text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@.*$/, ""); // 去掉 /cmd@botname 里的 bot 名
  const arg = rest.join(" ");
  const { env, tg, chatId } = ctx;

  switch (cmd) {
    case "/start":
    case "/help":
      await tg.sendHtml(chatId, HELP);
      return true;

    case "/reset":
      await clearHistory(env.DB, chatId);
      await tg.sendHtml(chatId, "🧹 对话记忆已清空");
      return true;

    case "/digest": {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : mytDate(ctx.now);
      const row = await env.DB.prepare("SELECT content_md FROM digests WHERE date = ?").bind(date).first<{ content_md: string }>();
      if (row) {
        await tg.sendHtml(chatId, row.content_md);
      } else {
        const latest = await env.DB.prepare("SELECT date FROM digests ORDER BY date DESC LIMIT 1").first<{ date: string }>();
        await tg.sendHtml(
          chatId,
          `${date} 还没有日报（每天 08:00 MYT 后生成）。` + (latest ? `\n最近一份：/digest ${latest.date}` : ""),
        );
      }
      return true;
    }

    case "/run": {
      // manual：流水线跑完会回报结果（没有新闻也会说），并立即发出攒着的快讯合集
      const err = await dispatchPipeline(env, { manual: "true" }, ctx.fetchImpl);
      await tg.sendHtml(chatId, err ? `❌ 触发失败：${escapeHtml(err)}` : "🚀 已触发流水线，一般 1-3 分钟跑完，跑完会告诉你结果");
      return true;
    }

    case "/status": {
      await tg.sendHtml(chatId, await statusText(env, ctx.now, ctx.fetchImpl));
      return true;
    }

    case "/settings": {
      const s = await listSettings({ env, now: ctx.now, fetchImpl: ctx.fetchImpl });
      const lines = ["<b>对话添加的信源</b>"];
      lines.push(...(s.feeds.length ? s.feeds.map((f) => `• ${escapeHtml(f.name)}（${f.group}，${f.tier}）\n  ${escapeHtml(f.url)}`) : ["（无）"]));
      lines.push("", "<b>屏蔽词</b>", s.muted_keywords.length ? escapeHtml(s.muted_keywords.join("、")) : "（无）");
      lines.push("", "<b>盯梢</b>");
      lines.push(
        ...(s.watches.length
          ? s.watches.map((w) => `• ${escapeHtml(w.name)}（到 ${w.expires}，已推 ${w.hits} 条）\n  <code>${escapeHtml(w.keywords.join(" | "))}</code>`)
          : ["（无）"]),
      );
      lines.push("", "<i>基线信源和过滤词在仓库的 config/*.yaml</i>");
      await tg.sendHtml(chatId, lines.join("\n"));
      return true;
    }

    case "/saved": {
      const { results } = await env.DB.prepare(
        "SELECT n.title, n.url, n.summary_zh, f.saved_at FROM feedback f JOIN news_items n ON n.id = f.item_id " +
          "WHERE f.saved_at IS NOT NULL ORDER BY f.saved_at DESC LIMIT 20",
      ).all<{ title: string; url: string; summary_zh: string | null; saved_at: number }>();
      if (!results.length) {
        await tg.sendHtml(chatId, "还没有收藏。点推送下面的 ⭐ 收藏就会出现在这里。");
        return true;
      }
      const lines = [`<b>⭐ 收藏（最近 ${results.length} 条）</b>`];
      results.forEach((r, i) => {
        lines.push(`${i + 1}. <a href="${escapeHtml(r.url).replace(/"/g, "&quot;")}">${escapeHtml(r.title)}</a>`);
        lines.push(`    ${escapeHtml(r.summary_zh ?? "")}（${mytDate(r.saved_at).slice(5)}）`);
      });
      lines.push("", "<i>在原推送上再点一次 ⭐ 取消收藏</i>");
      await tg.sendHtml(chatId, lines.join("\n"));
      return true;
    }

    case "/weekly": {
      const row = await env.DB.prepare("SELECT content FROM reports WHERE key LIKE 'weekly:%' ORDER BY key DESC LIMIT 1").first<{
        content: string;
      }>();
      await tg.sendHtml(chatId, row?.content ?? "还没有周报（每周日 20:00 MYT 后生成）");
      return true;
    }

    case "/webhook": {
      // 改了 allowed_updates（加按钮回调）后要重新注册一次；在聊天里做，不用知道 webhook secret
      const secret = (env.TELEGRAM_WEBHOOK_SECRET || "").trim();
      if (!ctx.origin || !secret) {
        await tg.sendHtml(chatId, "❌ 缺少 Worker 地址或 TELEGRAM_WEBHOOK_SECRET");
        return true;
      }
      const r = (await tg.setWebhook(`${ctx.origin}/telegram`, secret, false)) as { ok?: boolean; description?: string };
      await tg.sendHtml(chatId, r?.ok ? "✅ webhook 已重新注册，推送下面的按钮可以用了" : `❌ 注册失败：${escapeHtml(r?.description ?? "未知错误")}`);
      return true;
    }

    default:
      return false;
  }
}

async function statusText(env: Env, now: number, fetchImpl: typeof fetch): Promise<string> {
  const run = await env.DB.prepare("SELECT started_at, finished_at, stats, error FROM runs ORDER BY id DESC LIMIT 1").first<{
    started_at: number;
    finished_at: number | null;
    stats: string | null;
    error: string | null;
  }>();
  if (!run) return "还没有运行记录";
  const lines = [`<b>上次运行</b> ${fmtMyt(run.started_at)} MYT`];
  if (!run.finished_at) lines.push("⏳ 还在运行中（或异常中断）");
  else lines.push(`用时 ${run.finished_at - run.started_at} 秒` + (run.error ? " · ⚠️ 有错误" : " · ✅ 正常"));
  try {
    const st = JSON.parse(run.stats ?? "{}");
    if (st.fetch) lines.push(`抓取：${st.fetch.sources} 个源，新增 ${st.fetch.new ?? 0}，失败源 ${st.fetch.failed_sources?.length ?? 0}`);
    if (st.score) lines.push(`打分：${st.score.scored ?? 0}/${st.score.candidates ?? 0}（${st.score.model ?? "-"}）`);
    if (st.merge?.merged !== undefined) lines.push(`事件合并：${st.merge.merged} 条`);
    if (st.push) lines.push(`推送：${st.push.pushed} 条`);
  } catch {
    // stats 解析失败就不显示
  }
  if (run.error) lines.push(`<pre>${escapeHtml(run.error.slice(0, 800))}</pre>`);
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM news_items WHERE status IN ('pending','llm_failed') AND llm_attempts < 3",
  ).first<{ n: number }>();
  lines.push(`待打分积压：${pending?.n ?? 0} 条`);
  lines.push(await feedbackSummary(env, now));
  if (env.TAVILY_API_KEY) {
    const u = await fetchTavilyUsage(env.TAVILY_API_KEY, fetchImpl);
    lines.push(u ? `联网搜索（Tavily）：本周期已用 ${u.used}/${u.limit ?? "不限"} 次` : "联网搜索（Tavily）：用量查询失败");
  }
  lines.push(`分组：${Object.values(GROUPS).join(" / ")}`);
  return lines.join("\n");
}

/** 近 30 天的 👍 / 👎，以及 👎 最多的信源（看哪些源该删） */
async function feedbackSummary(env: Env, now: number): Promise<string> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT n.source, SUM(CASE WHEN f.vote = 1 THEN 1 ELSE 0 END) AS up, SUM(CASE WHEN f.vote = -1 THEN 1 ELSE 0 END) AS down " +
        "FROM feedback f JOIN news_items n ON n.id = f.item_id WHERE f.vote IS NOT NULL AND f.updated_at >= ? GROUP BY n.source",
    )
      .bind(now - 30 * 86400)
      .all<{ source: string; up: number; down: number }>();
    const up = results.reduce((s, r) => s + (r.up ?? 0), 0);
    const down = results.reduce((s, r) => s + (r.down ?? 0), 0);
    const worst = results
      .filter((r) => r.down >= 2)
      .sort((a, b) => b.down - a.down)
      .slice(0, 3)
      .map((r) => `${escapeHtml(r.source)}(${r.down})`);
    return `近 30 天反馈：👍 ${up} / 👎 ${down}` + (worst.length ? `；👎 最多：${worst.join("、")}` : "");
  } catch {
    return "近 30 天反馈：（feedback 表不存在，迁移还没跑？）";
  }
}
