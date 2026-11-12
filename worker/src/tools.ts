import { GROUPS, TOOL_RESULT_MAX_CHARS } from "./config";
import type { Env } from "./env";
import type { ToolDef } from "./llm";
import { fmtMyt, htmlToText, mytDate, truncate, unescapeHtml } from "./util";

export interface ToolContext {
  env: Env;
  now: number;
  fetchImpl: typeof fetch;
  /** 用户这条消息附带的图片（base64，不含 data: 前缀） */
  image?: { mime: string; base64: string };
}

const groupKeys = Object.keys(GROUPS);

export const TOOL_DEFS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "search_news",
      description:
        "在已抓取的新闻库里按关键词检索（数据来自 RSS 流水线，包含打分和中文摘要）。" +
        "英文新闻用英文关键词效果更好，中文关键词能匹配中文摘要。关键词至少 3 个字符时走全文检索。" +
        "查不到时可以换同义词、中英文各试一次。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "关键词，空格分隔，例如 \"Nvidia CEO\" 或 \"数据中心\"" },
          days: { type: "integer", description: "查最近几天，默认 7，最大 90", minimum: 1, maximum: 90 },
          group: { type: "string", enum: groupKeys, description: "只查某个分组（可选）" },
          min_score: { type: "number", description: "只要分数 ≥ 此值的（可选，0-10）" },
          limit: { type: "integer", description: "返回条数，默认 10，最大 20", minimum: 1, maximum: 20 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "top_news",
      description: "按分数取最近一段时间最重要的新闻（不需要关键词）。用于\"今天有什么大事\"\"最近 AI 圈怎么样\"这类问题。",
      parameters: {
        type: "object",
        properties: {
          hours: { type: "integer", description: "最近几小时，默认 24，最大 168", minimum: 1, maximum: 168 },
          group: { type: "string", enum: groupKeys, description: "只看某个分组（可选）" },
          limit: { type: "integer", description: "默认 10，最大 20", minimum: 1, maximum: 20 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_digest",
      description: "取某一天的日报（Top 10 + 分类汇总）。不传日期就取今天（MYT）。",
      parameters: {
        type: "object",
        properties: { date: { type: "string", description: "YYYY-MM-DD（马来西亚时间）" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "联网实时搜索（Tavily）。用户说「搜一下」「查一下」「最新」、新闻库里没有、或需要背景知识时使用。" +
        "问最新进展时设 time_range；结果只有摘要片段，需要细节时再用 read_page 打开最相关的链接。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词。英文话题用英文搜效果更好" },
          topic: { type: "string", enum: ["general", "news"], description: "news = 只搜新闻，默认 general" },
          time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "只要这段时间内的结果（可选）" },
          max_results: { type: "integer", minimum: 1, maximum: 8, description: "默认 5" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description: "打开一个网页，返回正文（Markdown，截断到约 6000 字）。用来读 web_search / 新闻库结果的全文，或用户直接发来的链接。",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "http/https 地址" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_feed",
      description: "添加一个 RSS/Atom 信源。会先抓取验证是不是有效的 feed，下次流水线运行（≤30 分钟）生效。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "feed 地址（http/https）" },
          group: { type: "string", enum: groupKeys, description: "归入哪个分组" },
          name: { type: "string", description: "显示名（可选，默认用 feed 标题）" },
          tier: { type: "string", enum: ["T1", "T2"], description: "T1 = 高质量一手信源，默认 T2" },
        },
        required: ["url", "group"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_feed",
      description: "删除一个通过对话添加的信源（config/feeds.yaml 里的基线信源不能用这个删）。",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
  {
    type: "function",
    function: {
      name: "mute_keyword",
      description: "屏蔽关键词：以后标题或摘要含这个词的新闻在预筛阶段直接过滤（不影响已入库的）。",
      parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
    },
  },
  {
    type: "function",
    function: {
      name: "unmute_keyword",
      description: "取消屏蔽一个关键词。",
      parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_settings",
      description: "列出通过对话添加的信源和屏蔽词。",
      parameters: { type: "object", properties: {} },
    },
  },
];

const REVERSE_IMAGE_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "reverse_image_search",
    description:
      "以图搜图（Google Cloud Vision Web Detection），对象是用户这条消息附带的图片。" +
      "返回：最佳猜测标签、相关实体、含有相同或相似图片的网页（可用来找出处、原始发布者、首次出现的位置）。" +
      "用户问「出处」「原图」「这是哪里 / 谁 / 什么」且看图本身答不准时使用。",
    parameters: { type: "object", properties: {} },
  },
};

/** 本次对话可用的工具：有图片时才提供以图搜图 */
export function toolDefs(ctx: Pick<ToolContext, "image" | "env">): ToolDef[] {
  return ctx.image && ctx.env.GOOGLE_VISION_API_KEY ? [...TOOL_DEFS, REVERSE_IMAGE_TOOL] : TOOL_DEFS;
}

type Args = Record<string, unknown>;

export async function runTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
  switch (name) {
    case "search_news":
      return searchNews(args, ctx);
    case "top_news":
      return topNews(args, ctx);
    case "get_digest":
      return getDigest(args, ctx);
    case "web_search":
      return webSearch(args, ctx);
    case "read_page":
      return readPage(args, ctx);
    case "reverse_image_search":
      return reverseImageSearch(ctx);
    case "add_feed":
      return addFeed(args, ctx);
    case "remove_feed":
      return removeFeed(args, ctx);
    case "mute_keyword":
      return muteKeyword(args, ctx);
    case "unmute_keyword":
      return unmuteKeyword(args, ctx);
    case "list_settings":
      return listSettings(ctx);
    default:
      return { error: `未知工具 ${name}` };
  }
}

/** 运行工具并把结果序列化为字符串（出错也返回字符串，交给 LLM 处理） */
export async function runToolToString(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  let args: Args;
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Args) : {};
  } catch {
    return JSON.stringify({ error: "参数不是合法 JSON" });
  }
  try {
    return truncate(JSON.stringify(await runTool(name, args, ctx)), TOOL_RESULT_MAX_CHARS);
  } catch (e) {
    return JSON.stringify({ error: `工具执行失败: ${e instanceof Error ? e.message : String(e)}` });
  }
}

// ---------------- 新闻检索 ----------------

const clampInt = (v: unknown, def: number, min: number, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v !== undefined && v !== null ? Math.min(max, Math.max(min, n)) : def;
};

/** 把用户关键词拆成词；≥3 个字符的走 FTS（trigram 的限制），其余走 LIKE */
export function splitQuery(query: string): { fts: string[]; short: string[] } {
  const terms = query
    .split(/[\s,，、;；]+/)
    .map((t) => t.replace(/["*^():]/g, "").trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    fts: terms.filter((t) => [...t].length >= 3),
    short: terms.filter((t) => [...t].length < 3),
  };
}

export function ftsMatch(terms: string[], op: "AND" | "OR"): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(` ${op} `);
}

interface NewsRow {
  id: number;
  title: string;
  url: string;
  source: string;
  feed_group: string;
  published_at: number;
  score: number | null;
  summary_zh: string | null;
  status: string;
  source_count: number;
}

const NEWS_COLS =
  "n.id, n.title, n.url, n.source, n.feed_group, n.published_at, n.score, n.summary_zh, n.status, n.source_count";

function formatNews(r: NewsRow) {
  return {
    title: r.title,
    url: r.url,
    source: r.source + (r.source_count > 1 ? `（${r.source_count} 个来源）` : ""),
    group: GROUPS[r.feed_group] ?? r.feed_group,
    published: fmtMyt(r.published_at) + " MYT",
    score: r.score,
    summary_zh: r.summary_zh,
    ...(r.status === "filtered" ? { note: "被预筛过滤，未打分" } : r.status !== "scored" ? { note: "尚未打分" } : {}),
  };
}

async function searchNews(args: Args, ctx: ToolContext) {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query 不能为空" };
  const days = clampInt(args.days, 7, 1, 90);
  const limit = clampInt(args.limit, 10, 1, 20);
  const since = ctx.now - days * 86400;
  const group = typeof args.group === "string" && args.group in GROUPS ? args.group : null;
  const minScore = args.min_score === undefined ? null : Number(args.min_score);

  const extra: string[] = ["n.published_at >= ?", "n.status != 'dup'"];
  const extraParams: unknown[] = [since];
  if (group) {
    extra.push("n.feed_group = ?");
    extraParams.push(group);
  }
  if (minScore !== null && Number.isFinite(minScore)) {
    extra.push("n.score >= ?");
    extraParams.push(minScore);
  }
  const { fts, short } = splitQuery(query);
  for (const t of short) {
    extra.push("(n.title LIKE ? OR n.summary_zh LIKE ?)");
    extraParams.push(`%${t}%`, `%${t}%`);
  }

  let rows: NewsRow[] = [];
  if (fts.length) {
    // 先 AND（精确），没结果再 OR（宽松）
    for (const op of ["AND", "OR"] as const) {
      if (op === "OR" && fts.length === 1) break;
      const sql =
        `SELECT ${NEWS_COLS} FROM news_fts f JOIN news_items n ON n.id = f.rowid ` +
        `WHERE news_fts MATCH ? AND ${extra.join(" AND ")} ORDER BY f.rank LIMIT ?`;
      rows = (await ctx.env.DB.prepare(sql).bind(ftsMatch(fts, op), ...extraParams, limit).all<NewsRow>()).results;
      if (rows.length) break;
    }
  } else {
    const sql =
      `SELECT ${NEWS_COLS} FROM news_items n WHERE ${extra.join(" AND ")} ` +
      `ORDER BY (n.score IS NULL), n.score DESC, n.published_at DESC LIMIT ?`;
    rows = (await ctx.env.DB.prepare(sql).bind(...extraParams, limit).all<NewsRow>()).results;
  }
  return { query, days, count: rows.length, results: rows.map(formatNews) };
}

async function topNews(args: Args, ctx: ToolContext) {
  const hours = clampInt(args.hours, 24, 1, 168);
  const limit = clampInt(args.limit, 10, 1, 20);
  const group = typeof args.group === "string" && args.group in GROUPS ? args.group : null;
  const sql =
    `SELECT ${NEWS_COLS} FROM news_items n WHERE n.status = 'scored' AND n.published_at >= ?` +
    (group ? " AND n.feed_group = ?" : "") +
    " ORDER BY n.score DESC, n.source_count DESC, n.published_at DESC LIMIT ?";
  const params: unknown[] = [ctx.now - hours * 3600, ...(group ? [group] : []), limit];
  const rows = (await ctx.env.DB.prepare(sql).bind(...params).all<NewsRow>()).results;
  return { hours, count: rows.length, results: rows.map(formatNews) };
}

async function getDigest(args: Args, ctx: ToolContext) {
  const date = typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : mytDate(ctx.now);
  const row = await ctx.env.DB.prepare("SELECT content_md FROM digests WHERE date = ?").bind(date).first<{ content_md: string }>();
  if (row) return { date, content: htmlToText(row.content_md) };
  const recent = await ctx.env.DB.prepare("SELECT date FROM digests ORDER BY date DESC LIMIT 7").all<{ date: string }>();
  return { date, error: "这一天没有日报（每天 08:00 MYT 后生成）", available_dates: recent.results.map((r) => r.date) };
}

// ---------------- 联网搜索 ----------------

const TIME_RANGES = new Set(["day", "week", "month", "year"]);
export const PAGE_MAX_CHARS = 6000;

async function webSearch(args: Args, ctx: ToolContext) {
  const key = ctx.env.TAVILY_API_KEY;
  if (!key) return { error: "未配置 TAVILY_API_KEY，无法联网搜索" };
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query 不能为空" };
  const r = await ctx.fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      query,
      topic: args.topic === "news" ? "news" : "general",
      max_results: clampInt(args.max_results, 5, 1, 8),
      search_depth: "basic",
      include_answer: "basic",
      ...(TIME_RANGES.has(String(args.time_range)) ? { time_range: args.time_range } : {}),
    }),
  });
  if (!r.ok) return { error: `Tavily HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
  const data = (await r.json()) as {
    answer?: string;
    results?: { title: string; url: string; content: string; published_date?: string }[];
  };
  return {
    answer: data.answer ?? null,
    results: (data.results ?? []).map((x) => ({
      title: x.title,
      url: x.url,
      content: truncate(x.content ?? "", 500),
      ...(x.published_date ? { published: x.published_date } : {}),
    })),
  };
}

/** 用 Jina Reader 把网页转成正文 Markdown（免 key，有限流）；失败时直接抓 HTML 粗略去标签 */
async function readPage(args: Args, ctx: ToolContext) {
  const url = String(args.url ?? "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return { error: "url 必须是 http/https 地址" };
  let text = "";
  let via = "jina";
  try {
    const r = await ctx.fetchImpl(`https://r.jina.ai/${url}`, {
      headers: { "X-Return-Format": "markdown" },
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) text = await r.text();
  } catch {
    // 落到下面的直接抓取
  }
  if (!text.trim()) {
    via = "direct";
    try {
      const r = await ctx.fetchImpl(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsDigestBot/1.0)" },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return { url, error: `打开失败：HTTP ${r.status}` };
      text = htmlToText(
        (await r.text()).replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " "),
      ).replace(/[ \t]*\n\s*\n\s*/g, "\n\n").replace(/[ \t]{2,}/g, " ");
    } catch (e) {
      return { url, error: `打开失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { url, via, content: truncate(text.trim(), PAGE_MAX_CHARS) };
}

// ---------------- 以图搜图 ----------------

interface WebDetection {
  bestGuessLabels?: { label: string }[];
  webEntities?: { description?: string; score?: number }[];
  fullMatchingImages?: { url: string }[];
  partialMatchingImages?: { url: string }[];
  pagesWithMatchingImages?: { url: string; pageTitle?: string; fullMatchingImages?: unknown[] }[];
  visuallySimilarImages?: { url: string }[];
}

const stripTags = (s: string) => unescapeHtml(s.replace(/<[^>]+>/g, "")).trim();

async function reverseImageSearch(ctx: ToolContext) {
  const key = ctx.env.GOOGLE_VISION_API_KEY;
  if (!key) return { error: "未配置 GOOGLE_VISION_API_KEY，无法以图搜图；请直接根据图片内容判断，必要时用 web_search" };
  if (!ctx.image) return { error: "这条消息没有附带图片" };
  const r = await ctx.fetchImpl("https://vision.googleapis.com/v1/images:annotate", {
    method: "POST",
    // key 放 header，不出现在 URL 里
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          image: { content: ctx.image.base64 },
          features: [{ type: "WEB_DETECTION", maxResults: 15 }],
          imageContext: { webDetectionParams: { includeGeoResults: true } },
        },
      ],
    }),
  });
  if (!r.ok) return { error: `Vision HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
  const data = (await r.json()) as { responses?: { webDetection?: WebDetection; error?: { message?: string } }[] };
  const res = data.responses?.[0];
  if (res?.error) return { error: `Vision: ${res.error.message ?? "unknown error"}` };
  const wd = res?.webDetection ?? {};
  const pages = (wd.pagesWithMatchingImages ?? []).map((p) => ({
    title: stripTags(p.pageTitle ?? ""),
    url: p.url,
    match: p.fullMatchingImages?.length ? "完全相同" : "部分相似",
  }));
  // 含完全相同图片的网页排前面：最可能是出处或转载
  pages.sort((a, b) => Number(b.match === "完全相同") - Number(a.match === "完全相同"));
  return {
    best_guess: (wd.bestGuessLabels ?? []).map((l) => l.label),
    entities: (wd.webEntities ?? [])
      .filter((e) => e.description)
      .slice(0, 10)
      .map((e) => ({ name: e.description, score: Math.round((e.score ?? 0) * 100) / 100 })),
    pages_with_image: pages.slice(0, 10),
    same_image_urls: (wd.fullMatchingImages ?? []).slice(0, 5).map((i) => i.url),
    similar_image_urls: (wd.visuallySimilarImages ?? []).slice(0, 5).map((i) => i.url),
    note: "Vision 不提供首次发布时间；要判断最早出处，可以对候选网页用 read_page 看发布日期",
  };
}

// ---------------- 配置管理 ----------------

async function addFeed(args: Args, ctx: ToolContext) {
  const url = String(args.url ?? "").trim();
  const group = String(args.group ?? "");
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return { error: "url 必须是 http/https 地址" };
  if (!(group in GROUPS)) return { error: `group 必须是 ${groupKeys.join(" / ")} 之一` };
  const tier = args.tier === "T1" ? "T1" : "T2";

  let title: string | null = null;
  try {
    const r = await ctx.fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsDigestBot/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { error: `抓取失败：HTTP ${r.status}，没有添加` };
    const head = (await r.text()).slice(0, 20000);
    if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(head)) {
      return { error: "这个地址返回的不是 RSS/Atom feed，没有添加。可以让我帮你找这个网站的 feed 地址" };
    }
    title = head.match(/<title[^>]*>(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?<\/title>/i)?.[1] ?? null;
  } catch (e) {
    return { error: `抓取失败：${e instanceof Error ? e.message : String(e)}，没有添加` };
  }

  const name = String(args.name ?? "").trim() || title || url;
  const res = await ctx.env.DB.prepare(
    "INSERT OR IGNORE INTO config_feeds (url, name, feed_group, tier, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)",
  )
    .bind(url, name, group, tier, ctx.now)
    .run();
  if (!res.meta.changes) return { ok: false, message: "这个信源已经添加过了" };
  return { ok: true, name, group: GROUPS[group], tier, message: "已添加，下次流水线运行（≤30 分钟）开始抓取" };
}

async function removeFeed(args: Args, ctx: ToolContext) {
  const url = String(args.url ?? "").trim();
  const res = await ctx.env.DB.prepare("DELETE FROM config_feeds WHERE url = ?").bind(url).run();
  return res.meta.changes
    ? { ok: true, message: "已删除" }
    : { ok: false, message: "对话添加的信源里没有这个地址（feeds.yaml 里的基线信源需要改文件）" };
}

async function muteKeyword(args: Args, ctx: ToolContext) {
  const word = String(args.word ?? "").trim().toLowerCase();
  if (!word || word.length > 50) return { error: "关键词长度需在 1-50 之间" };
  const res = await ctx.env.DB.prepare("INSERT OR IGNORE INTO muted_keywords (word, created_at) VALUES (?, ?)")
    .bind(word, ctx.now)
    .run();
  return res.meta.changes
    ? { ok: true, message: `已屏蔽「${word}」，下次运行起生效（已入库的不受影响）` }
    : { ok: false, message: `「${word}」已经在屏蔽列表里` };
}

async function unmuteKeyword(args: Args, ctx: ToolContext) {
  const word = String(args.word ?? "").trim().toLowerCase();
  const res = await ctx.env.DB.prepare("DELETE FROM muted_keywords WHERE word = ?").bind(word).run();
  return res.meta.changes ? { ok: true, message: `已取消屏蔽「${word}」` } : { ok: false, message: `「${word}」不在屏蔽列表里` };
}

export async function listSettings(ctx: ToolContext) {
  const [feeds, words] = await ctx.env.DB.batch([
    ctx.env.DB.prepare("SELECT url, name, feed_group, tier FROM config_feeds WHERE enabled = 1 ORDER BY id"),
    ctx.env.DB.prepare("SELECT word FROM muted_keywords ORDER BY created_at"),
  ]);
  return {
    feeds: (feeds.results as { url: string; name: string; feed_group: string; tier: string }[]).map((f) => ({
      name: f.name,
      url: f.url,
      group: GROUPS[f.feed_group] ?? f.feed_group,
      tier: f.tier,
    })),
    muted_keywords: (words.results as { word: string }[]).map((w) => w.word),
    note: "这里只列出对话里添加的；基线信源和过滤词在仓库的 config/*.yaml",
  };
}
