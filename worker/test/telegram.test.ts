import { describe, expect, it } from "vitest";
import { mdToTelegramHtml, splitMessage } from "../src/telegram";
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
