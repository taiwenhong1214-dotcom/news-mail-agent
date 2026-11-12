import { describe, expect, it } from "vitest";
import { CHECK_PROMPT_IMAGE, handleCheck, mdToPlain } from "../src/check";
import type { Env } from "../src/env";
import { bytesToBase64 } from "../src/util";
import { FakeD1, fakeFetch, llmReply } from "./fakes";

const NOW = Date.UTC(2026, 10, 13, 2, 0) / 1000;
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);

function env(db = new FakeD1(), extra: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    TELEGRAM_BOT_TOKEN: "TOKEN",
    TELEGRAM_WEBHOOK_SECRET: "s",
    ALLOWED_CHAT_IDS: "111",
    LLM_API_KEY: "k",
    CHECK_TOKEN: " tok\n",
    ...extra,
  };
}

const routes = (reply = "❌ 不实\n- 说法 → [Sebenarnya](https://sebenarnya.my/x)") =>
  fakeFetch((url) => {
    if (url.includes("api.telegram.org")) return Response.json({ ok: true });
    if (url.includes("chat/completions")) return llmReply({ content: reply });
    return new Response("", { status: 404 });
  });

const post = (body: BodyInit, type: string, token = "tok", q = "") =>
  new Request(`https://w.dev/check${q}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": type },
    body,
  });

describe("/check", () => {
  it("rejects bad or missing token", async () => {
    const f = routes();
    expect((await handleCheck(post(JPG, "image/jpeg", "nope"), env(), { fetchImpl: f.impl, now: () => NOW })).status).toBe(401);
    expect((await handleCheck(post(JPG, "image/jpeg"), env(new FakeD1(), { CHECK_TOKEN: "" }), { fetchImpl: f.impl, now: () => NOW })).status).toBe(401);
    expect(f.calls.length).toBe(0);
  });

  it("checks a screenshot: image to LLM, result to Telegram and response", async () => {
    const f = routes();
    const db = new FakeD1();
    const r = await handleCheck(post(JPG, "image/jpeg", "tok", "?q=这个优惠是真的吗"), env(db), { fetchImpl: f.impl, now: () => NOW });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("❌ 不实\n• 说法 → Sebenarnya (https://sebenarnya.my/x)");

    const llm = f.calls.find((c) => c.url.includes("chat/completions"))!.body;
    expect(llm.messages.map((m: any) => m.role)).toEqual(["system", "user"]); // 不带闲聊历史
    const user = llm.messages[1].content;
    expect(user[0].text).toContain(CHECK_PROMPT_IMAGE);
    expect(user[0].text).toContain("这个优惠是真的吗");
    expect(user[1].image_url.url).toBe(`data:image/jpeg;base64,${bytesToBase64(JPG)}`);

    const sent = f.calls.find((c) => c.url.endsWith("/sendMessage"))!.body;
    expect(sent.chat_id).toBe(111);
    expect(sent.text).toContain("核实结果");
    expect(db.history.map((h) => h.content)).toEqual(["[核实截图] 这个优惠是真的吗", "❌ 不实\n- 说法 → [Sebenarnya](https://sebenarnya.my/x)"]);
  });

  it("checks plain text", async () => {
    const f = routes("✅ 属实");
    const r = await handleCheck(post("政府宣布明天全国放假", "text/plain"), env(), { fetchImpl: f.impl, now: () => NOW });
    expect(await r.text()).toBe("✅ 属实");
    const llm = f.calls.find((c) => c.url.includes("chat/completions"))!.body;
    expect(llm.messages[1].content).toContain("政府宣布明天全国放假");
  });

  it("rejects oversized images with a hint, before calling anything", async () => {
    const f = routes();
    const r = await handleCheck(post(new Uint8Array(1_600_000), "image/png"), env(), { fetchImpl: f.impl, now: () => NOW });
    expect(r.status).toBe(413);
    expect(await r.text()).toContain("JPEG");
    expect(f.calls.length).toBe(0);
  });

  it("rejects empty body and unsupported image types", async () => {
    const f = routes();
    expect((await handleCheck(post("", "text/plain"), env(), { fetchImpl: f.impl, now: () => NOW })).status).toBe(400);
    expect((await handleCheck(post(JPG, "image/gif"), env(), { fetchImpl: f.impl, now: () => NOW })).status).toBe(415);
  });

  it("returns 502 with the reason when the LLM fails", async () => {
    const f = fakeFetch((url) => (url.includes("chat/completions") ? new Response("bad key", { status: 401 }) : Response.json({ ok: true })));
    const r = await handleCheck(post("x", "text/plain"), env(), { fetchImpl: f.impl, now: () => NOW });
    expect(r.status).toBe(502);
    expect(await r.text()).toContain("核实失败");
    expect(f.calls.find((c) => c.url.endsWith("/sendMessage"))!.body.text).toContain("核实失败"); // Telegram 也收到

    // 通过 waitUntil 交出同一个任务
    const pending: Promise<unknown>[] = [];
    await handleCheck(post("x", "text/plain"), env(), { fetchImpl: f.impl, now: () => NOW }, (p) => void pending.push(p));
    expect(pending.length).toBe(1);
  });
});

describe("mdToPlain", () => {
  it("strips markdown for notifications", () => {
    expect(mdToPlain("**结论** `x`\n## 标题\n- [a](https://a.com)")).toBe("结论 x\n标题\n• a (https://a.com)");
  });
});
