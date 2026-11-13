import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GROUPS } from "../src/config";
import type { Env } from "../src/env";
import { handleCron, handleWebhook } from "../src/index";
import { FakeD1, fakeFetch, llmReply } from "./fakes";

const NOW = Date.UTC(2026, 10, 13, 2, 0) / 1000;

function makeEnv(db: FakeD1, extra: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    TELEGRAM_BOT_TOKEN: "TOKEN",
    TELEGRAM_WEBHOOK_SECRET: "s3cret",
    ALLOWED_CHAT_IDS: "111, 222",
    LLM_API_KEY: "k",
    CHAT_MODEL: "m1",
    ...extra,
  };
}

const req = (body: unknown, secret = "s3cret") =>
  new Request("https://w.dev/telegram", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const update = (id: number, chatId: number, text: string) => ({ update_id: id, message: { chat: { id: chatId }, text } });

function routes() {
  return fakeFetch((url, body) => {
    if (url.includes("api.telegram.org")) return Response.json({ ok: true });
    if (url.includes("chat/completions")) return llmReply({ content: `收到：${body.messages.at(-1).content}` });
    if (url.includes("api.github.com")) return new Response(null, { status: 204 });
    return new Response("", { status: 404 });
  });
}

describe("webhook", () => {
  it("rejects wrong secret", async () => {
    const f = routes();
    const r = await handleWebhook(req(update(1, 111, "hi"), "wrong"), makeEnv(new FakeD1()), { fetchImpl: f.impl, now: () => NOW });
    expect(r.status).toBe(401);
    expect(f.calls.length).toBe(0);
  });

  it("tolerates whitespace around the stored secret", async () => {
    const f = routes();
    const env = makeEnv(new FakeD1(), { TELEGRAM_WEBHOOK_SECRET: "  s3cret\r\n" });
    const r = await handleWebhook(req(update(2, 999, "hi")), env, { fetchImpl: f.impl, now: () => NOW });
    expect(r.status).toBe(200);
  });

  it("ignores chats not in whitelist", async () => {
    const f = routes();
    const db = new FakeD1();
    const r = await handleWebhook(req(update(1, 999, "hi")), makeEnv(db), { fetchImpl: f.impl, now: () => NOW });
    expect(r.status).toBe(200);
    expect(f.calls.length).toBe(0);
    expect(db.calls.length).toBe(0);
  });

  it("answers via LLM, saves history, and dedupes retried updates", async () => {
    const f = routes();
    const db = new FakeD1();
    const env = makeEnv(db);
    await handleWebhook(req(update(7, 111, "今天有什么新闻")), env, { fetchImpl: f.impl, now: () => NOW });
    const sends = f.calls.filter((c) => c.url.endsWith("/sendMessage"));
    expect(sends.length).toBe(1);
    expect(sends[0].body.chat_id).toBe(111);
    expect(sends[0].body.text).toContain("收到：今天有什么新闻");
    expect(db.history.map((h) => h.role)).toEqual(["user", "assistant"]);

    await handleWebhook(req(update(7, 111, "今天有什么新闻")), env, { fetchImpl: f.impl, now: () => NOW });
    expect(f.calls.filter((c) => c.url.endsWith("/sendMessage")).length).toBe(1); // 重发的 update 被忽略

    // 第二条消息带上历史
    await handleWebhook(req(update(8, 111, "继续")), env, { fetchImpl: f.impl, now: () => NOW });
    const llmCalls = f.calls.filter((c) => c.url.includes("chat/completions"));
    expect(llmCalls.at(-1)!.body.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("handles /run command without LLM", async () => {
    const f = routes();
    await handleWebhook(req(update(9, 222, "/run")), makeEnv(new FakeD1(), { GITHUB_TOKEN: "gh", GITHUB_REPO: "u/r" }), {
      fetchImpl: f.impl,
      now: () => NOW,
    });
    const dispatch = f.calls.find((c) => c.url === "https://api.github.com/repos/u/r/actions/workflows/pipeline.yml/dispatches")!;
    expect(dispatch.body).toEqual({ ref: "main", inputs: { manual: "true" } }); // 跑完回报结果
    expect(f.calls.some((c) => c.url.includes("chat/completions"))).toBe(false);
    expect(f.calls.find((c) => c.url.endsWith("/sendMessage"))!.body.text).toContain("已触发");
  });

  it("reports errors to the user instead of failing the webhook", async () => {
    const f = fakeFetch((url) => (url.includes("chat/completions") ? new Response("bad key", { status: 401 }) : Response.json({ ok: true })));
    const r = await handleWebhook(req(update(10, 111, "hi")), makeEnv(new FakeD1()), { fetchImpl: f.impl, now: () => NOW });
    expect(r.status).toBe(200);
    expect(f.calls.find((c) => c.url.endsWith("/sendMessage"))!.body.text).toContain("出错了");
  });
});

describe("cron", () => {
  it("dispatches workflow; alerts once per 6h on failure", async () => {
    let alertAt: number | null = null;
    const db = new FakeD1((sql, params) => {
      if (sql.includes("FROM app_state")) return { first: alertAt === null ? null : { updated_at: alertAt } };
      if (sql.includes("INSERT INTO app_state")) alertAt = params[1] as number;
      return {};
    });
    const f = fakeFetch((url) => (url.includes("api.github.com") ? new Response("expired", { status: 401 }) : Response.json({ ok: true })));
    const env = makeEnv(db, { GITHUB_TOKEN: "gh", GITHUB_REPO: "u/r" });
    await handleCron(env, { fetchImpl: f.impl, now: () => NOW });
    await handleCron(env, { fetchImpl: f.impl, now: () => NOW + 1800 });
    expect(f.calls.filter((c) => c.url.endsWith("/sendMessage")).length).toBe(1);
    await handleCron(env, { fetchImpl: f.impl, now: () => NOW + 7 * 3600 });
    expect(f.calls.filter((c) => c.url.endsWith("/sendMessage")).length).toBe(2);
  });

  it("skips when no GITHUB_TOKEN", async () => {
    const f = routes();
    await handleCron(makeEnv(new FakeD1()), { fetchImpl: f.impl, now: () => NOW });
    expect(f.calls.length).toBe(0);
  });
});

describe("config", () => {
  it("GROUPS matches config/feeds.yaml", () => {
    const yaml = readFileSync(new URL("../../config/feeds.yaml", import.meta.url), "utf8");
    const groupsBlock = yaml.split(/^groups:\s*$/m)[1];
    const keys = [...groupsBlock.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((m) => m[1]);
    const names = [...groupsBlock.matchAll(/^ {4}name:\s*(.+)$/gm)].map((m) => m[1].trim());
    expect(keys).toEqual(Object.keys(GROUPS));
    expect(names).toEqual(Object.values(GROUPS));
  });
});
