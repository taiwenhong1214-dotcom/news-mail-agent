import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { handleWebhook, pickImage } from "../src/index";
import { PAGE_MAX_CHARS, runToolToString, toolDefs, type ToolContext } from "../src/tools";
import { bytesToBase64 } from "../src/util";
import { FakeD1, fakeFetch, llmReply } from "./fakes";

const NOW = Date.UTC(2026, 10, 13, 2, 0) / 1000;
const IMG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function ctx(fetchImpl: typeof fetch, extra: Partial<ToolContext> = {}, env: Partial<Env> = {}): ToolContext {
  return { env: { TAVILY_API_KEY: "tv", GOOGLE_VISION_API_KEY: "gv", ...env } as Env, now: NOW, fetchImpl, ...extra };
}

describe("web_search", () => {
  it("passes time_range only when valid", async () => {
    const f = fakeFetch(() => Response.json({ results: [] }));
    await runToolToString("web_search", JSON.stringify({ query: "k8s", time_range: "week" }), ctx(f.impl));
    await runToolToString("web_search", JSON.stringify({ query: "k8s", time_range: "forever" }), ctx(f.impl));
    expect(f.calls[0].body.time_range).toBe("week");
    expect(f.calls[1].body).not.toHaveProperty("time_range");
  });
});

describe("read_page", () => {
  it("uses Jina Reader and truncates", async () => {
    const f = fakeFetch(() => new Response("# Title\n" + "x".repeat(20000)));
    const out = JSON.parse(await runToolToString("read_page", JSON.stringify({ url: "https://a.com/p" }), ctx(f.impl)));
    expect(f.calls[0].url).toBe("https://r.jina.ai/https://a.com/p");
    expect(out.via).toBe("jina");
    expect(out.content.length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
  });

  it("falls back to direct fetch and strips scripts / tags", async () => {
    const f = fakeFetch((url) =>
      url.startsWith("https://r.jina.ai/")
        ? new Response("rate limited", { status: 429 })
        : new Response("<html><script>evil()</script><h1>Hello</h1><p>World &amp; more</p></html>"),
    );
    const out = JSON.parse(await runToolToString("read_page", JSON.stringify({ url: "https://a.com/p" }), ctx(f.impl)));
    expect(out.via).toBe("direct");
    expect(out.content).toContain("Hello");
    expect(out.content).toContain("World & more");
    expect(out.content).not.toContain("evil");
  });

  it("rejects non-http urls", async () => {
    const f = fakeFetch(() => new Response(""));
    const out = JSON.parse(await runToolToString("read_page", JSON.stringify({ url: "file:///etc/passwd" }), ctx(f.impl)));
    expect(out.error).toBeTruthy();
    expect(f.calls.length).toBe(0);
  });
});

describe("reverse_image_search", () => {
  const vision = {
    responses: [
      {
        webDetection: {
          bestGuessLabels: [{ label: "petronas towers" }],
          webEntities: [{ description: "Petronas Towers", score: 1.234 }, { score: 0.5 }],
          pagesWithMatchingImages: [
            { url: "https://b.com", pageTitle: "Similar <b>KL</b>", partialMatchingImages: [{}] },
            { url: "https://a.com", pageTitle: "Original &amp; <b>photo</b>", fullMatchingImages: [{}] },
          ],
          fullMatchingImages: [{ url: "https://a.com/i.jpg" }],
        },
      },
    ],
  };

  it("sends base64 with key in header and ranks full matches first", async () => {
    const f = fakeFetch(() => Response.json(vision));
    let headers: Headers | undefined;
    const impl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return f.impl(u, init);
    }) as typeof fetch;
    const out = JSON.parse(
      await runToolToString("reverse_image_search", "{}", ctx(impl, { image: { mime: "image/jpeg", base64: "QUJD" } })),
    );
    expect(f.calls[0].url).toBe("https://vision.googleapis.com/v1/images:annotate");
    expect(f.calls[0].url).not.toContain("gv");
    expect(headers!.get("x-goog-api-key")).toBe("gv");
    expect(f.calls[0].body.requests[0].image.content).toBe("QUJD");
    expect(out.best_guess).toEqual(["petronas towers"]);
    expect(out.entities).toEqual([{ name: "Petronas Towers", score: 1.23 }]);
    expect(out.pages_with_image[0]).toEqual({ title: "Original & photo", url: "https://a.com", match: "完全相同" });
    expect(out.same_image_urls).toEqual(["https://a.com/i.jpg"]);
  });

  it("is only offered when there is an image and a key", () => {
    const names = (c: Parameters<typeof toolDefs>[0]) => toolDefs(c).map((t) => t.function.name);
    const env = { GOOGLE_VISION_API_KEY: "gv" } as Env;
    expect(names({ env, image: { mime: "image/png", base64: "" } })).toContain("reverse_image_search");
    expect(names({ env })).not.toContain("reverse_image_search");
    expect(names({ env: {} as Env, image: { mime: "image/png", base64: "" } })).not.toContain("reverse_image_search");
  });
});

describe("image messages", () => {
  it("picks the largest photo size, accepts image documents only", () => {
    const chat = { id: 1 };
    const photo = [
      { file_id: "small", width: 90, height: 90 },
      { file_id: "big", width: 1280, height: 960 },
    ];
    expect(pickImage({ chat, photo })).toEqual({ fileId: "big", mime: "image/jpeg" });
    expect(pickImage({ chat, document: { file_id: "d", mime_type: "image/png" } })).toEqual({ fileId: "d", mime: "image/png" });
    expect(pickImage({ chat, document: { file_id: "d", mime_type: "application/pdf" } })).toBeNull();
    expect(pickImage({ chat, text: "hi" })).toBeNull();
  });

  it("downloads the photo, sends it to the LLM as a data URI, saves text-only history", async () => {
    const f = fakeFetch((url) => {
      if (url.endsWith("/getFile")) return Response.json({ ok: true, result: { file_path: "photos/f.jpg", file_size: IMG.length } });
      if (url === "https://api.telegram.org/file/botTOKEN/photos/f.jpg") return new Response(IMG);
      if (url.includes("api.telegram.org")) return Response.json({ ok: true });
      if (url.includes("chat/completions")) return llmReply({ content: "这是双子塔" });
      return new Response("", { status: 404 });
    });
    const db = new FakeD1();
    const env = {
      DB: db as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: "TOKEN",
      TELEGRAM_WEBHOOK_SECRET: "s",
      ALLOWED_CHAT_IDS: "111",
      LLM_API_KEY: "k",
      GOOGLE_VISION_API_KEY: "gv",
    } as Env;
    const update = { update_id: 1, message: { chat: { id: 111 }, photo: [{ file_id: "p1", width: 800, height: 600 }] } };
    await handleWebhook(
      new Request("https://w.dev/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": "s" },
        body: JSON.stringify(update),
      }),
      env,
      { fetchImpl: f.impl, now: () => NOW },
    );

    expect(f.calls.find((c) => c.url.endsWith("/getFile"))!.body).toEqual({ file_id: "p1" });
    const llm = f.calls.find((c) => c.url.includes("chat/completions"))!.body;
    const user = llm.messages.at(-1);
    expect(user.content[0].text).toContain("出处"); // 没有 caption 时用默认提问
    expect(user.content[1].image_url.url).toBe(`data:image/jpeg;base64,${bytesToBase64(IMG)}`);
    expect(llm.tools.map((t: any) => t.function.name)).toContain("reverse_image_search");
    expect(f.calls.find((c) => c.url.endsWith("/sendMessage"))!.body.text).toContain("双子塔");
    expect(db.history[0].content).toMatch(/^\[发了一张图片\]/);
  });

  it("encodes large buffers without stack overflow", () => {
    const big = new Uint8Array(300_000).map((_, i) => i % 256);
    expect(atob(bytesToBase64(big)).length).toBe(big.length);
  });
});

describe("bytesToBase64 fallback", () => {
  it("matches btoa for every tail length", () => {
    for (let len = 0; len < 40; len++) {
      const b = new Uint8Array(len).map((_, i) => (i * 97 + 13) % 256);
      const plain = Object.assign(new Uint8Array(b), { toBase64: undefined }); // 强制走查表实现
      expect(bytesToBase64(plain)).toBe(btoa(String.fromCharCode(...b)));
    }
  });
  it("matches btoa across chunk boundaries", () => {
    const b = new Uint8Array(3 * 8192 * 2 + 5).map((_, i) => (i * 31) % 256);
    const plain = Object.assign(new Uint8Array(b), { toBase64: undefined });
    let ref = "";
    for (let i = 0; i < b.length; i += 0x8000) ref += String.fromCharCode(...b.subarray(i, i + 0x8000));
    expect(bytesToBase64(plain)).toBe(btoa(ref));
  });
});
