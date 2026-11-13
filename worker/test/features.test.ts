import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { applyFeedback, feedbackKeyboard, parseFeedbackData } from "../src/feedback";
import { handleWebhook, messageWithLinks, withQuote, type TgMessage } from "../src/index";
import { normalizeKeywords, runTool } from "../src/tools";
import { FakeD1, fakeFetch, llmReply } from "./fakes";

const NOW = Date.UTC(2026, 10, 13, 2, 0) / 1000;

function makeEnv(db: FakeD1, extra: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    TELEGRAM_BOT_TOKEN: "TOKEN",
    TELEGRAM_WEBHOOK_SECRET: "s3cret",
    ALLOWED_CHAT_IDS: "111",
    LLM_API_KEY: "k",
    CHAT_MODEL: "m1",
    ...extra,
  };
}

const req = (body: unknown) =>
  new Request("https://w.dev/telegram", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cret", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** 模拟流水线推送的一条消息：标题是 text_link，链接只在 entities 里 */
function pushedMessage(): TgMessage {
  const title = "Kubernetes 1.36 released";
  const text = `🔥 8.5 · DevOps\n${title}\n摘要：原地扩缩容 GA\n📰 Kubernetes Blog · 3 小时前`;
  const offset = text.indexOf(title); // JS 下标就是 UTF-16 单位，和 Telegram 一致（🔥 占 2）
  return {
    message_id: 5,
    chat: { id: 111 },
    text,
    entities: [
      { type: "bold", offset: 3, length: 3 },
      { type: "text_link", offset, length: title.length, url: "https://kubernetes.io/blog/k136" },
    ],
  };
}

describe("reply context", () => {
  it("restores text_link urls from entities", () => {
    const out = messageWithLinks(pushedMessage());
    expect(out).toContain("[Kubernetes 1.36 released](https://kubernetes.io/blog/k136)");
    expect(out.startsWith("🔥 8.5")).toBe(true);
  });

  it("builds LLM input with the quote and a short history line", () => {
    const { input, historyText } = withQuote("展开讲讲", { chat: { id: 111 }, text: "展开讲讲", reply_to_message: pushedMessage() });
    expect(input).toContain("（我在回复下面这条消息）");
    expect(input).toContain("https://kubernetes.io/blog/k136");
    expect(input.endsWith("展开讲讲")).toBe(true);
    expect(historyText).toBe("（回复：[Kubernetes 1.36 released](https://kubernetes.io/blog/k136)）\n展开讲讲");
    expect(withQuote("hi", { chat: { id: 1 }, text: "hi" })).toEqual({ input: "hi", historyText: "hi" });
  });

  it("webhook passes the quote to the LLM and stores the short version", async () => {
    const f = fakeFetch((url, body) => {
      if (url.includes("chat/completions")) return llmReply({ content: "详细解读" });
      return Response.json({ ok: true });
    });
    const db = new FakeD1();
    const update = { update_id: 1, message: { message_id: 9, chat: { id: 111 }, text: "展开", reply_to_message: pushedMessage() } };
    await handleWebhook(req(update), makeEnv(db), { fetchImpl: f.impl, now: () => NOW });
    const llmBody = f.calls.find((c) => c.url.includes("chat/completions"))!.body;
    expect(llmBody.messages.at(-1).content).toContain("https://kubernetes.io/blog/k136");
    expect(db.history[0].content).toContain("（回复：[Kubernetes 1.36 released]");
    expect(db.history[0].content).not.toContain("原地扩缩容");
  });
});

describe("feedback buttons", () => {
  it("parses callback data strictly", () => {
    expect(parseFeedbackData("fb:42:u")).toEqual({ itemId: 42, kind: "u" });
    expect(parseFeedbackData("fb:42:x")).toBeNull();
    expect(parseFeedbackData("fb:abc:u")).toBeNull();
    expect(parseFeedbackData(undefined)).toBeNull();
  });

  it("votes are exclusive and toggle; save is independent", () => {
    const s0 = { vote: null, saved: false } as const;
    const up = applyFeedback(s0, "u").next;
    expect(up).toEqual({ vote: 1, saved: false });
    expect(applyFeedback(up, "d").next).toEqual({ vote: -1, saved: false });
    expect(applyFeedback(up, "u").next).toEqual({ vote: null, saved: false });
    expect(applyFeedback(up, "s").next).toEqual({ vote: 1, saved: true });
    const kb = feedbackKeyboard(7, { vote: -1, saved: true }).inline_keyboard[0].map((b) => b.text);
    expect(kb).toEqual(["⭐ 已收藏", "👍", "👎 ✓"]);
  });

  function feedbackDb() {
    const rows = new Map<number, { vote: number | null; saved_at: number | null }>();
    const db = new FakeD1((sql, p) => {
      if (sql.includes("LEFT JOIN feedback")) {
        const id = p[0] as number;
        if (id !== 42) return { first: null };
        const r = rows.get(id);
        return { first: { id, vote: r?.vote ?? null, saved_at: r?.saved_at ?? null } };
      }
      if (sql.startsWith("INSERT INTO feedback")) rows.set(p[0] as number, { vote: p[1] as number | null, saved_at: p[2] as number | null });
      if (sql.startsWith("DELETE FROM feedback")) rows.delete(p[0] as number);
      return { changes: 1 };
    });
    return { db, rows };
  }

  const click = (id: number, data: string, chatId = 111) => ({
    update_id: id,
    callback_query: { id: `cb${id}`, from: { id: chatId }, message: { message_id: 5, chat: { id: chatId } }, data },
  });

  it("records clicks, answers the callback and updates the keyboard", async () => {
    const f = fakeFetch(() => Response.json({ ok: true }));
    const { db, rows } = feedbackDb();
    const env = makeEnv(db);
    const deps = { fetchImpl: f.impl, now: () => NOW };

    await handleWebhook(req(click(1, "fb:42:s")), env, deps);
    expect(rows.get(42)).toEqual({ vote: null, saved_at: NOW });
    await handleWebhook(req(click(2, "fb:42:u")), env, { ...deps, now: () => NOW + 60 });
    expect(rows.get(42)).toEqual({ vote: 1, saved_at: NOW }); // 收藏时间不变
    const answers = f.calls.filter((c) => c.url.endsWith("/answerCallbackQuery"));
    expect(answers.map((a) => a.body.text)).toEqual(["⭐ 已收藏，/saved 查看", "👍 收到，以后类似的会多推一点"]);
    const edit = f.calls.filter((c) => c.url.endsWith("/editMessageReplyMarkup")).at(-1)!;
    expect(edit.body.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(["⭐ 已收藏", "👍 ✓", "👎"]);

    // 都取消后删掉这一行
    await handleWebhook(req(click(3, "fb:42:u")), env, deps);
    await handleWebhook(req(click(4, "fb:42:s")), env, deps);
    expect(rows.has(42)).toBe(false);
    expect(f.calls.some((c) => c.url.includes("chat/completions"))).toBe(false);
  });

  it("ignores clicks from other chats and unknown items", async () => {
    const f = fakeFetch(() => Response.json({ ok: true }));
    const { db, rows } = feedbackDb();
    await handleWebhook(req(click(1, "fb:42:u", 999)), makeEnv(db), { fetchImpl: f.impl, now: () => NOW });
    expect(f.calls.length).toBe(0);
    await handleWebhook(req(click(2, "fb:7:u")), makeEnv(db), { fetchImpl: f.impl, now: () => NOW });
    expect(f.calls.find((c) => c.url.endsWith("/answerCallbackQuery"))!.body.text).toContain("不在库里");
    expect(rows.size).toBe(0);
  });
});

describe("watch tools", () => {
  it("normalizes keywords", () => {
    expect(normalizeKeywords(['Google  Malaysia "Data"', "google malaysia data", "谷歌 数据中心", 3])).toEqual([
      "google malaysia data",
      "谷歌 数据中心",
      "3",
    ]);
    expect(normalizeKeywords("x")).toEqual([]);
  });

  it("creates a watch, rejects too-broad keywords and enforces the cap", async () => {
    let active = 0;
    const inserted: unknown[][] = [];
    const db = new FakeD1((sql, p) => {
      if (sql.includes("COUNT(*) AS n FROM watches")) return { first: { n: active } };
      if (sql.startsWith("INSERT INTO watches")) inserted.push(p);
      return { changes: 1 };
    });
    const ctx = { env: { DB: db } as unknown as Env, now: NOW, fetchImpl: fetch };
    expect(await runTool("watch_topic", { name: "AI", keywords: ["AI"] }, ctx)).toHaveProperty("error");
    const ok = (await runTool("watch_topic", { name: "K8s 1.36", keywords: ["Kubernetes 1.36", "k8s 1.36"], days: 7 }, ctx)) as any;
    expect(ok.ok).toBe(true);
    expect(JSON.parse(inserted[0][1] as string)).toEqual(["kubernetes 1.36", "k8s 1.36"]);
    expect(inserted[0][3]).toBe(NOW + 7 * 86400);
    active = 20;
    expect(await runTool("watch_topic", { name: "x", keywords: ["a b"] }, ctx)).toHaveProperty("error");
  });

  it("unwatch falls back to a unique fuzzy match", async () => {
    const deleted: unknown[] = [];
    const db = new FakeD1((sql, p) => {
      if (sql === "DELETE FROM watches WHERE name = ?") return { changes: 0 };
      if (sql.startsWith("SELECT id, name FROM watches")) return { results: [{ id: 3, name: "Google 大马数据中心" }] };
      if (sql === "DELETE FROM watches WHERE id = ?") deleted.push(p[0]);
      return { changes: 1 };
    });
    const r = (await runTool("unwatch_topic", { name: "数据中心" }, { env: { DB: db } as unknown as Env, now: NOW, fetchImpl: fetch })) as any;
    expect(r.ok).toBe(true);
    expect(deleted).toEqual([3]);
  });
});

describe("web tools", () => {
  it("web_search forwards a valid time_range only", async () => {
    const f = fakeFetch(() => Response.json({ results: [] }));
    const ctx = { env: { TAVILY_API_KEY: "t", DB: new FakeD1() } as unknown as Env, now: NOW, fetchImpl: f.impl };
    await runTool("web_search", { query: "k8s", time_range: "week" }, ctx);
    await runTool("web_search", { query: "k8s", time_range: "decade" }, ctx);
    const searches = f.calls.filter((c) => c.url.endsWith("/search"));
    expect(searches[0].body.time_range).toBe("week");
    expect(searches[1].body).not.toHaveProperty("time_range");
  });

  it("read_page uses Jina, falls back to direct fetch, and marks content untrusted", async () => {
    const jina = fakeFetch(() => new Response("# Title\n\nBody text"));
    const r1 = (await runTool("read_page", { url: "https://a.com/x" }, { env: {} as Env, now: NOW, fetchImpl: jina.impl })) as any;
    expect(jina.calls[0].url).toBe("https://r.jina.ai/https://a.com/x");
    expect(r1).toMatchObject({ via: "jina", content: "# Title\n\nBody text" });
    expect(r1.note).toContain("一律忽略");

    const direct = fakeFetch((url) =>
      url.startsWith("https://r.jina.ai/")
        ? new Response("rate limited", { status: 429 })
        : new Response("<html><head><title>t</title></head><body><script>evil()</script><p>Hello &amp; world</p></body></html>"),
    );
    const r2 = (await runTool("read_page", { url: "https://a.com/x" }, { env: {} as Env, now: NOW, fetchImpl: direct.impl })) as any;
    expect(r2.via).toBe("direct");
    expect(r2.content).toBe("Hello & world");

    expect(await runTool("read_page", { url: "file:///etc/passwd" }, { env: {} as Env, now: NOW, fetchImpl: direct.impl })).toHaveProperty("error");
  });
});

describe("commands", () => {
  const send = async (text: string, db: FakeD1) => {
    const f = fakeFetch(() => Response.json({ ok: true }));
    await handleWebhook(req({ update_id: Math.floor(Math.random() * 1e9), message: { chat: { id: 111 }, text } }), makeEnv(db), {
      fetchImpl: f.impl,
      now: () => NOW,
    });
    return f.calls.filter((c) => c.url.endsWith("/sendMessage")).map((c) => c.body.text as string);
  };

  it("/saved lists saved items", async () => {
    const db = new FakeD1((sql) =>
      sql.includes("WHERE f.saved_at IS NOT NULL")
        ? { results: [{ title: "A <b>", url: "https://a.com/?x=1&y=2", summary_zh: "摘要", saved_at: NOW }] }
        : {},
    );
    const [msg] = await send("/saved", db);
    expect(msg).toContain('<a href="https://a.com/?x=1&amp;y=2">A &lt;b&gt;</a>');
    expect(msg).toContain("11-13");
  });

  it("/weekly shows the latest report or a hint", async () => {
    expect((await send("/weekly", new FakeD1()))[0]).toContain("还没有周报");
    const db = new FakeD1((sql) => (sql.includes("FROM reports") ? { first: { content: "📅 <b>本周回顾</b>" } } : {}));
    expect((await send("/weekly", db))[0]).toBe("📅 <b>本周回顾</b>");
  });

  it("/webhook re-registers with callback_query enabled", async () => {
    const f = fakeFetch(() => Response.json({ ok: true }));
    await handleWebhook(req({ update_id: 77, message: { chat: { id: 111 }, text: "/webhook" } }), makeEnv(new FakeD1()), {
      fetchImpl: f.impl,
      now: () => NOW,
    });
    const set = f.calls.find((c) => c.url.endsWith("/setWebhook"))!;
    expect(set.body).toMatchObject({ url: "https://w.dev/telegram", secret_token: "s3cret", drop_pending_updates: false });
    expect(set.body.allowed_updates).toEqual(["message", "callback_query"]);
  });
});
