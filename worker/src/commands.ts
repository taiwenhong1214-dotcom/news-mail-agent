import { clearHistory } from "./agent";
import { GROUPS } from "./config";
import type { Env } from "./env";
import { dispatchPipeline } from "./github";
import type { Telegram } from "./telegram";
import { listSettings } from "./tools";
import { escapeHtml, fmtMyt, mytDate } from "./util";

const HELP = `<b>我能做的事</b>
直接用中文问我就行，比如：
• 今天有什么大事？
• 最近 AI 基础设施有什么新闻
• 搜一下马来西亚数据中心招聘
• 发一张图片：识别内容、找出处（可以附文字说明想问什么）
• 发一个链接：帮你读全文、总结
• 屏蔽关键词 crypto
• 添加信源 https://example.com/feed 到 DevOps

<b>快捷命令</b>
/digest [YYYY-MM-DD] 看日报（默认今天）
/run 立即运行一次新闻流水线
/status 上次流水线运行情况
/settings 对话里加过的信源和屏蔽词
/reset 清空对话记忆
/help 显示这条说明`;

interface CmdContext {
  env: Env;
  tg: Telegram;
  chatId: number;
  now: number;
  fetchImpl: typeof fetch;
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
      const err = await dispatchPipeline(env, {}, ctx.fetchImpl);
      await tg.sendHtml(chatId, err ? `❌ 触发失败：${escapeHtml(err)}` : "🚀 已触发流水线，大约 3-6 分钟跑完，有高分新闻会直接推送");
      return true;
    }

    case "/status": {
      await tg.sendHtml(chatId, await statusText(env));
      return true;
    }

    case "/settings": {
      const s = await listSettings({ env, now: ctx.now, fetchImpl: ctx.fetchImpl });
      const lines = ["<b>对话添加的信源</b>"];
      lines.push(...(s.feeds.length ? s.feeds.map((f) => `• ${escapeHtml(f.name)}（${f.group}，${f.tier}）\n  ${escapeHtml(f.url)}`) : ["（无）"]));
      lines.push("", "<b>屏蔽词</b>", s.muted_keywords.length ? escapeHtml(s.muted_keywords.join("、")) : "（无）");
      lines.push("", "<i>基线信源和过滤词在仓库的 config/*.yaml</i>");
      await tg.sendHtml(chatId, lines.join("\n"));
      return true;
    }

    default:
      return false;
  }
}

async function statusText(env: Env): Promise<string> {
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
  lines.push(`分组：${Object.values(GROUPS).join(" / ")}`);
  return lines.join("\n");
}
