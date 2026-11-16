/**
 * 联网搜索（Tavily）+ 省额度措施。免费额度每月 1000 次（basic 搜索每次 1 credit）：
 * 1. 每条用户消息最多真正搜 MAX_SEARCHES_PER_MESSAGE 次（命中缓存不算）
 * 2. 同样的搜索在 CACHE_TTL 内直接用 D1 缓存
 * 3. 用量以 Tavily 的 GET /usage 为准（每小时同步一次，中间本地 +1），用完就不再调用，
 *    退回只查新闻库；用到 80% 时提醒一次
 */
import type { Env } from "./env";
import type { ToolContext } from "./tools";
import { truncate } from "./util";

export const MAX_SEARCHES_PER_MESSAGE = 2;
const CACHE_TTL = 6 * 3600;
const CACHE_TTL_DAY = 2 * 3600; // time_range=day 要的是最新消息，缓存短一点
const QUOTA_SYNC_INTERVAL = 3600;
const WARN_RATIO = 0.8;
const TIME_RANGES = new Set(["day", "week", "month", "year"]);

type Args = Record<string, unknown>;

export interface SearchUsage {
  searches: number; // 本条消息已经真正调用 Tavily 的次数
}

export interface Quota {
  used: number;
  limit: number | null; // null = 不知道（还没同步成功）或不限
  synced_at: number;
  warned: boolean; // 本周期是否已经发过 80% 提醒
}

const clampInt = (v: unknown, def: number, min: number, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v !== undefined && v !== null ? Math.min(max, Math.max(min, n)) : def;
};

export function searchParams(args: Args) {
  return {
    query: String(args.query ?? "").trim().replace(/\s+/g, " "),
    topic: args.topic === "news" ? "news" : "general",
    max_results: clampInt(args.max_results, 5, 1, 8),
    time_range: TIME_RANGES.has(String(args.time_range)) ? String(args.time_range) : null,
  };
}

export function cacheKey(p: ReturnType<typeof searchParams>): string {
  return [p.topic, p.time_range ?? "", p.max_results, p.query.toLowerCase()].join("|");
}

// ---------------- 用量 ----------------

/** 读 Tavily 当前账单周期的用量。失败返回 null（不影响搜索） */
export async function fetchTavilyUsage(key: string, fetchImpl: typeof fetch): Promise<{ used: number; limit: number | null } | null> {
  try {
    const r = await fetchImpl("https://api.tavily.com/usage", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const d = (await r.json()) as {
      key?: { usage?: number; limit?: number | null };
      account?: { plan_usage?: number; plan_limit?: number | null; paygo_usage?: number; paygo_limit?: number | null };
    };
    const acc = d.account ?? {};
    let used = (acc.plan_usage ?? 0) + (acc.paygo_usage ?? 0);
    let limit = typeof acc.plan_limit === "number" ? acc.plan_limit + (acc.paygo_limit ?? 0) : null;
    // key 自己设了更小的上限时以 key 为准
    if (typeof d.key?.limit === "number" && (limit === null || d.key.limit < limit)) {
      used = d.key.usage ?? used;
      limit = d.key.limit;
    }
    return { used, limit };
  } catch {
    return null;
  }
}

async function loadQuota(env: Env, key: string, now: number, fetchImpl: typeof fetch): Promise<Quota> {
  const row = await env.DB.prepare("SELECT value FROM app_state WHERE key = 'tavily_quota'").first<{ value: string }>();
  let q: Quota = { used: 0, limit: null, synced_at: 0, warned: false };
  if (row) {
    try {
      q = { ...q, ...JSON.parse(row.value) };
    } catch {
      // 坏数据就当没有
    }
  }
  if (now - q.synced_at >= QUOTA_SYNC_INTERVAL) {
    const u = await fetchTavilyUsage(key, fetchImpl);
    if (u) {
      if (u.used < q.used) q.warned = false; // 用量变少 = 新的账单周期
      q = { ...q, used: u.used, limit: u.limit, synced_at: now };
    } else {
      q.synced_at = now - QUOTA_SYNC_INTERVAL + 600; // 同步失败：10 分钟后再试
    }
  }
  return q;
}

async function saveQuota(env: Env, q: Quota, now: number) {
  await env.DB.prepare(
    "INSERT INTO app_state (key, value, updated_at) VALUES ('tavily_quota', ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  )
    .bind(JSON.stringify(q), now)
    .run();
}

const exhaustedError = (q: Quota) => ({
  error:
    `本周期联网搜索额度已用完（${q.used}/${q.limit ?? "?"}），现在不能联网搜索。` +
    "请改用 search_news / top_news 查新闻库，或直接用 read_page 打开已知链接，并告诉用户联网搜索要等 Tavily 额度重置后才能恢复",
});

// ---------------- 搜索 ----------------

export async function webSearch(args: Args, ctx: ToolContext) {
  const key = ctx.env.TAVILY_API_KEY;
  if (!key) return { error: "未配置 TAVILY_API_KEY，无法联网搜索" };
  const p = searchParams(args);
  if (!p.query) return { error: "query 不能为空" };

  // 1) 每条消息的次数上限。先占位再 await：同一轮里并行的多个调用也能正确计数
  const usage = ctx.searchUsage;
  if (usage && usage.searches >= MAX_SEARCHES_PER_MESSAGE) {
    return {
      error: `这条消息已经联网搜索了 ${MAX_SEARCHES_PER_MESSAGE} 次（为了省额度设了上限）。请用已有的搜索结果、read_page 或新闻库回答；信息不够就如实告诉用户，可以让他追问`,
    };
  }
  if (usage) usage.searches++;
  // 只有 Tavily 真的返回了结果才占次数：缓存命中、额度用完、HTTP 出错、网络异常都退还
  const charged = { value: false };
  try {
    return await cachedSearch(p, key, ctx, charged);
  } finally {
    if (usage && !charged.value) usage.searches--;
  }
}

async function cachedSearch(p: ReturnType<typeof searchParams>, key: string, ctx: ToolContext, charged: { value: boolean }) {
  // 2) 缓存
  const ck = cacheKey(p);
  const ttl = p.time_range === "day" ? CACHE_TTL_DAY : CACHE_TTL;
  try {
    const hit = await ctx.env.DB.prepare("SELECT result FROM search_cache WHERE key = ? AND created_at >= ?")
      .bind(ck, ctx.now - ttl)
      .first<{ result: string }>();
    if (hit) return { ...JSON.parse(hit.result), cached: true };
  } catch (e) {
    console.error("search cache read failed", e); // 表不存在（迁移没跑）时照常搜索
  }

  // 3) 额度
  const q = await loadQuota(ctx.env, key, ctx.now, ctx.fetchImpl);
  if (q.limit !== null && q.used >= q.limit) return exhaustedError(q);

  const r = await ctx.fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: p.query,
      topic: p.topic,
      max_results: p.max_results,
      search_depth: "basic", // 1 credit；advanced 是 2 credit
      include_answer: "basic",
      ...(p.time_range ? { time_range: p.time_range } : {}),
    }),
  });
  if (r.status === 432 || r.status === 433) {
    // 432 = 套餐额度用完，433 = 按量付费上限
    q.used = Math.max(q.used, q.limit ?? q.used);
    q.limit = q.limit ?? q.used;
    await saveQuota(ctx.env, q, ctx.now);
    return exhaustedError(q);
  }
  if (!r.ok) return { error: `Tavily HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
  charged.value = true;
  const data = (await r.json()) as {
    answer?: string;
    results?: { title: string; url: string; content: string; published_date?: string }[];
  };
  const result = {
    answer: data.answer ?? null,
    results: (data.results ?? []).map((x) => ({
      title: x.title,
      url: x.url,
      content: truncate(x.content ?? "", 500),
      ...(x.published_date ? { published: x.published_date } : {}),
    })),
  };

  // 4) 记账 + 80% 提醒
  q.used++;
  if (q.limit && !q.warned && q.used >= q.limit * WARN_RATIO) {
    q.warned = true;
    ctx.notices?.push(`⚠️ Tavily 联网搜索本周期已用 ${q.used}/${q.limit} 次（${Math.round((q.used / q.limit) * 100)}%）。用完后 bot 只能查新闻库，额度重置后恢复`);
  }
  await saveQuota(ctx.env, q, ctx.now);

  // 5) 写缓存；顺便清理一天前的（约每 10 次清一次）
  try {
    await ctx.env.DB.prepare("INSERT OR REPLACE INTO search_cache (key, result, created_at) VALUES (?, ?, ?)")
      .bind(ck, JSON.stringify(result), ctx.now)
      .run();
    if (q.used % 10 === 0) {
      await ctx.env.DB.prepare("DELETE FROM search_cache WHERE created_at < ?").bind(ctx.now - 86400).run();
    }
  } catch (e) {
    console.error("search cache write failed", e);
  }
  return result;
}
