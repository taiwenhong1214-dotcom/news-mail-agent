import { describe, expect, it } from "vitest";
import { mdToTelegramHtml, splitMarkdown, splitMessage, Telegram } from "../src/telegram";
import { fakeFetch } from "./fakes";
import { htmlToText, safeEqual, fmtMyt, mytDate } from "../src/util";

describe("mdToTelegramHtml", () => {
  it("converts bold, links, code, headings and bullets", () => {
    const md = "# 标题\n**重点**：看 [Nvidia 公告](https://x.com/a?b=1&c=2)\n- 第一条\n* 第二条\n用 `kubectl get pods`";
    expect(mdToTelegramHtml(md)).toBe(
      '<b>标题</b>\n<b>重点</b>：看 <a href="https://x.com/a?b=1&amp;c=2">Nvidia 公告</a>\n• 第一条\n• 第二条\n用 <code>kubectl get pods</code>',
    );
  });

  it("escapes html special chars outside markup", () => {
    expect(mdToTelegramHtml("a < b && c > d")).toBe("a &lt; b &amp;&amp; c &gt; d");
  });

  it("keeps code block content verbatim (escaped, no markdown)", () => {
    expect(mdToTelegramHtml("```yaml\nkey: **not bold** <x>\n```")).toBe("<pre>key: **not bold** &lt;x&gt;</pre>");
  });

  it("does not treat non-http links as links", () => {
    expect(mdToTelegramHtml("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
  });

  it("strips bold markers inside link text", () => {
    expect(mdToTelegramHtml("[**A**](https://a.com)")).toBe('<a href="https://a.com">A</a>');
  });

  it("handles inline code inside link text without leaking placeholders", () => {
    const html = mdToTelegramHtml("看 [`k8s` 发布](https://k.io/r) 和 `kubectl`");
    expect(html).toBe('看 <a href="https://k.io/r">k8s 发布</a> 和 <code>kubectl</code>');
    expect(html).not.toContain("\u0000");
  });

  it("keeps balanced parentheses in urls", () => {
    expect(mdToTelegramHtml("([Foo](https://en.wikipedia.org/wiki/Foo_(bar)))")).toBe(
      '(<a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a>)',
    );
  });
});

describe("splitMarkdown", () => {
  it("leaves short text alone, even with an unbalanced fence", () => {
    expect(splitMarkdown("use ``` here", 100)).toEqual(["use ``` here"]);
  });
  it("closes and reopens a code block cut by the split", () => {
    const parts = splitMarkdown("intro\n```\nline1\nline2\n```\nend", 14);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect((p.match(/```/g) ?? []).length % 2).toBe(0);
    expect(parts.map((p) => mdToTelegramHtml(p)).join("")).not.toContain("```");
  });
});

describe("Telegram.sendMarkdown", () => {
  it("falls back to plain text only for the part that failed", async () => {
    const f = fakeFetch((_url, body) =>
      body.parse_mode === "HTML" && String(body.text).includes("BAD") ? new Response("bad", { status: 400 }) : Response.json({ ok: true }),
    );
    const tg = new Telegram("t", false, f.impl);
    const md = `${"a".repeat(3000)}\n${"BAD **x**".repeat(100)}`;
    await tg.sendMarkdown(1, md);
    const texts = f.calls.map((c) => ({ html: c.body.parse_mode === "HTML", text: String(c.body.text) }));
    expect(texts.filter((t) => t.text.startsWith("aaa")).length).toBe(1); // 第一段只发一次
    expect(texts.at(-1)).toEqual({ html: false, text: "BAD **x**".repeat(100) });
  });
});

describe("splitMessage", () => {
  it("returns short text as-is", () => {
    expect(splitMessage("hello", 10)).toEqual(["hello"]);
  });
  it("splits on line boundaries and hard-splits long lines", () => {
    expect(splitMessage("aaaa\nbbbb\ncccccccccccc", 10)).toEqual(["aaaa\nbbbb", "cccccccccc", "cc"]);
  });
});

describe("util", () => {
  it("htmlToText keeps links", () => {
    expect(htmlToText('1. <b>9</b> <a href="https://a.com/x?a=1&amp;b=2">Title &amp; more</a>')).toBe(
      "1. 9 Title & more (https://a.com/x?a=1&b=2)",
    );
  });
  it("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
  it("formats MYT", () => {
    const ts = Date.UTC(2026, 10, 12, 17, 30) / 1000; // 2026-11-13 01:30 MYT
    expect(fmtMyt(ts)).toBe("2026-11-13 01:30");
    expect(mytDate(ts)).toBe("2026-11-13");
  });
});
