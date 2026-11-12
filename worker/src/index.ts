import { loadHistory, runAgent, saveTurn } from "./agent";
import { handleCommand } from "./commands";
import type { Env } from "./env";
import { dispatchPipeline } from "./github";
import { LLM } from "./llm";
import { Telegram } from "./telegram";
import { escapeHtml, nowSec, safeEqual } from "./util";

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string; caption?: string };
}

export interface Deps {
  fetchImpl: typeof fetch;
  now: () => number;
}

const defaultDeps: Deps = { fetchImpl: (...a) => fetch(...a), now: nowSec };

/** 去掉首尾空白：wrangler secret put 粘贴时容易带上空格或换行 */
export function webhookSecret(env: Env): string {
  return (env.TELEGRAM_WEBHOOK_SECRET || "").trim();
}

export function allowedChatIds(env: Env): Set<number> {
  return new Set(
    (env.ALLOWED_CHAT_IDS || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n !== 0),
  );
}

export async function handleWebhook(req: Request, env: Env, deps: Deps = defaultDeps): Promise<Response> {
  const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  const expected = webhookSecret(env);
  if (!expected || !safeEqual(secret, expected)) {
    return new Response("unauthorized", { status: 401 });
  }
  let update: TgUpdate;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }
  const msg = update.message;
  const text = (msg?.text ?? msg?.caption ?? "").trim();
  // 非白名单 / 非文字消息：直接 200，不回应（不暴露 bot 存在）
  if (!msg || !text || !allowedChatIds(env).has(msg.chat.id)) return new Response("ok");

  const now = deps.now();
  // Telegram 超时会重发同一个 update：用 update_id 去重
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO tg_updates (update_id, created_at) VALUES (?, ?)")
    .bind(update.update_id, now)
    .run();
  if (!ins.meta.changes) return new Response("ok");
  if (update.update_id % 50 === 0) {
    await env.DB.prepare("DELETE FROM tg_updates WHERE created_at < ?").bind(now - 7 * 86400).run();
  }

  const chatId = msg.chat.id;
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_DRY_RUN === "1", deps.fetchImpl);
  try {
    if (text.startsWith("/") && (await handleCommand(text, { env, tg, chatId, now, fetchImpl: deps.fetchImpl }))) {
      return new Response("ok");
    }
    await tg.typing(chatId);
    const llm = new LLM({
      baseUrl: env.LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/",
      apiKey: env.LLM_API_KEY,
      models: [env.CHAT_MODEL || "gemini-2.5-flash", ...(env.CHAT_FALLBACK_MODELS || "").split(",").map((s) => s.trim()).filter(Boolean)],
      reasoningEffort: env.CHAT_REASONING_EFFORT,
      fetchImpl: deps.fetchImpl,
    });
    const history = await loadHistory(env.DB, chatId);
    const { reply } = await runAgent(text, {
      llm,
      history,
      toolCtx: { env, now, fetchImpl: deps.fetchImpl },
      onToolRound: () => tg.typing(chatId),
    });
    await tg.sendMarkdown(chatId, reply);
    await saveTurn(env.DB, chatId, text, reply, now);
  } catch (e) {
    console.error("handle message failed", e);
    const detail = e instanceof Error ? e.message : String(e);
    await tg.sendHtml(chatId, `⚠️ 出错了：${escapeHtml(detail.slice(0, 500))}`);
  }
  return new Response("ok");
}

/** 一次性设置 webhook：浏览器打开 https://<worker>/setup?secret=<TELEGRAM_WEBHOOK_SECRET> */
async function handleSetup(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const expected = webhookSecret(env);
  if (!expected || !safeEqual((url.searchParams.get("secret") ?? "").trim(), expected)) {
    return new Response("unauthorized", { status: 401 });
  }
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_DRY_RUN === "1");
  const result = await tg.setWebhook(`${url.origin}/telegram`, expected);
  return Response.json({ webhook: `${url.origin}/telegram`, telegram: result });
}

/** Cron：触发 GitHub 流水线；连续失败时最多每 6 小时告警一次 */
export async function handleCron(env: Env, deps: Deps = defaultDeps): Promise<void> {
  if (!env.GITHUB_TOKEN) return;
  const err = await dispatchPipeline(env, {}, deps.fetchImpl);
  if (!err) return;
  console.error("dispatch failed", err);
  const now = deps.now();
  const last = await env.DB.prepare("SELECT updated_at FROM app_state WHERE key = 'cron_alert'").first<{ updated_at: number }>();
  if (last && now - last.updated_at < 6 * 3600) return;
  await env.DB.prepare(
    "INSERT INTO app_state (key, value, updated_at) VALUES ('cron_alert', ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(err, now)
    .run();
  const chatId = [...allowedChatIds(env)][0];
  if (chatId) {
    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_DRY_RUN === "1", deps.fetchImpl);
    await tg.sendHtml(chatId, `⚠️ <b>定时触发流水线失败</b>（6 小时内不再重复提醒）\n<pre>${escapeHtml(err)}</pre>\n常见原因：GITHUB_TOKEN 过期或权限不足`);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (req.method === "POST" && pathname === "/telegram") return handleWebhook(req, env);
    if (req.method === "GET" && pathname === "/setup") return handleSetup(req, env);
    if (req.method === "GET" && pathname === "/") return new Response("news-agent ok");
    return new Response("not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(env));
  },
} satisfies ExportedHandler<Env>;
