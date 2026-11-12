import { describe, expect, it } from "vitest";
import { buildSystemPrompt, runAgent } from "../src/agent";
import { MAX_TOOL_ROUNDS } from "../src/config";
import type { Env } from "../src/env";
import type { ChatMessage } from "../src/llm";
import { ftsMatch, splitQuery } from "../src/tools";
import { FakeD1 } from "./fakes";

const NOW = Date.UTC(2026, 10, 13, 2, 0) / 1000; // 10:00 MYT

function scriptedLLM(script: ((msgs: ChatMessage[]) => ChatMessage)[]) {
  let i = 0;
  const seen: { msgs: ChatMessage[]; toolChoice?: string }[] = [];
  return {
    seen,
    chat: async (msgs: ChatMessage[], _tools?: unknown, toolChoice?: "auto" | "none") => {
      seen.push({ msgs: [...msgs], toolChoice });
      return script[Math.min(i++, script.length - 1)](msgs);
    },
  };
}

const toolCall = (id: string, name: string, args: object): ChatMessage => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) }, extra_content: { sig: "abc" } }],
});

describe("system prompt", () => {
  it("injects current MYT time and groups", () => {
    const p = buildSystemPrompt(NOW);
    expect(p).toContain("2026-11-13 10:00 星期五");
    expect(p).toContain("AI 基础设施");
    expect(p).not.toContain("{{");
  });
});

describe("runAgent", () => {
  it("answers directly without tools", async () => {
    const llm = scriptedLLM([() => ({ role: "assistant", content: "你好" })]);
    const db = new FakeD1();
    const r = await runAgent("hi", {
      llm,
      history: [{ role: "user", content: "之前" }, { role: "assistant", content: "回复" }],
      toolCtx: { env: { DB: db } as unknown as Env, now: NOW, fetchImpl: fetch },
    });
    expect(r.reply).toBe("你好");
    expect(llm.seen[0].msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("runs a tool, passes results back with provider fields intact", async () => {
    const db = new FakeD1((sql) =>
      sql.includes("FROM news_items n WHERE n.status = 'scored'")
        ? { results: [{ id: 1, title: "Nvidia CEO resigns", url: "https://a.com", source: "A", feed_group: "stocks", published_at: NOW - 3600, score: 9.5, summary_zh: "黄仁勋辞职", status: "scored", source_count: 3 }] }
        : {},
    );
    const llm = scriptedLLM([
      () => toolCall("c1", "top_news", { hours: 24 }),
      (msgs) => {
        const tool = msgs[msgs.length - 1];
        expect(tool.role).toBe("tool");
        expect(tool.tool_call_id).toBe("c1");
        expect(String(tool.content)).toContain("黄仁勋辞职");
        expect((msgs[msgs.length - 2].tool_calls![0] as any).extra_content).toEqual({ sig: "abc" });
        return { role: "assistant", content: "今天最大的新闻：**黄仁勋辞职**" };
      },
    ]);
    const rounds: string[][] = [];
    const r = await runAgent("今天有什么大事", {
      llm,
      history: [],
      toolCtx: { env: { DB: db } as unknown as Env, now: NOW, fetchImpl: fetch },
      onToolRound: (n) => void rounds.push(n),
    });
    expect(r.reply).toContain("黄仁勋");
    expect(r.toolsUsed).toEqual(["top_news"]);
    expect(rounds).toEqual([["top_news"]]);
  });

  it("returns tool errors to the model instead of throwing", async () => {
    const llm = scriptedLLM([
      () => toolCall("c1", "no_such_tool", {}),
      (msgs) => ({ role: "assistant", content: String(msgs[msgs.length - 1].content) }),
    ]);
    const r = await runAgent("x", { llm, history: [], toolCtx: { env: {} as Env, now: NOW, fetchImpl: fetch } });
    expect(r.reply).toContain("未知工具");
  });

  it("stops after MAX_TOOL_ROUNDS and forces a final answer", async () => {
    const llm = scriptedLLM([
      ...Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => () => toolCall(`c${i}`, "list_settings", {})),
      () => ({ role: "assistant", content: "最终回答" }),
    ]);
    const db = new FakeD1();
    const r = await runAgent("x", { llm, history: [], toolCtx: { env: { DB: db } as unknown as Env, now: NOW, fetchImpl: fetch } });
    expect(r.reply).toBe("最终回答");
    expect(llm.seen.at(-1)!.toolChoice).toBe("none");
  });
});

describe("search query helpers", () => {
  it("splits into fts (>=3 chars) and short terms", () => {
    expect(splitQuery('Nvidia "CEO" AI 数据中心, 股')).toEqual({ fts: ["Nvidia", "CEO", "数据中心"], short: ["AI", "股"] });
  });
  it("quotes fts terms", () => {
    expect(ftsMatch(["Nvidia", 'a"b'], "AND")).toBe('"Nvidia" AND "a""b"');
  });
});
