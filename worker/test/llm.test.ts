import { describe, expect, it } from "vitest";
import { LLM, LLMError, withPlaceholderSignatures, type ChatMessage } from "../src/llm";
import { fakeFetch, llmReply } from "./fakes";

const make = (routes: Parameters<typeof fakeFetch>[0], models = ["m1", "m2"], reasoningEffort?: string) => {
  const f = fakeFetch(routes);
  const llm = new LLM({ baseUrl: "https://x/v1/", apiKey: "k", models, reasoningEffort, fetchImpl: f.impl, sleep: async () => {} });
  return { llm, calls: f.calls };
};

describe("LLM", () => {
  it("returns assistant message and posts to chat/completions", async () => {
    const { llm, calls } = make(() => llmReply({ content: "hi" }));
    const m = await llm.chat([{ role: "user", content: "x" }]);
    expect(m.content).toBe("hi");
    expect(calls[0].url).toBe("https://x/v1/chat/completions");
    expect(calls[0].body.model).toBe("m1");
  });

  it("falls back to next model on 503 and sticks", async () => {
    const { llm, calls } = make((_u, b) => (b.model === "m1" ? new Response("busy", { status: 503 }) : llmReply({ content: b.model })));
    expect((await llm.chat([])).content).toBe("m2");
    expect((await llm.chat([])).content).toBe("m2");
    expect(calls.map((c) => c.body.model)).toEqual(["m1", "m1", "m2", "m2"]);
  });

  it("switches immediately on 404", async () => {
    const { llm, calls } = make((_u, b) => (b.model === "m1" ? new Response("", { status: 404 }) : llmReply({ content: "ok" })));
    await llm.chat([]);
    expect(calls.length).toBe(2);
  });

  it("throws when all models down", async () => {
    const { llm } = make(() => new Response("", { status: 500 }));
    await expect(llm.chat([])).rejects.toThrow(LLMError);
  });

  it("drops reasoning_effort on 400", async () => {
    const { llm, calls } = make((_u, b) => ("reasoning_effort" in b ? new Response("bad", { status: 400 }) : llmReply({ content: "ok" })), ["m1"], "low");
    expect((await llm.chat([])).content).toBe("ok");
    await llm.chat([]);
    expect(calls.map((c) => "reasoning_effort" in c.body)).toEqual([true, false, false]);
  });

  it("sends tools and tool_choice", async () => {
    const { llm, calls } = make(() => llmReply({ content: "x" }));
    await llm.chat([], [{ type: "function", function: { name: "t", description: "d", parameters: {} } }], "none");
    expect(calls[0].body.tools.length).toBe(1);
    expect(calls[0].body.tool_choice).toBe("none");
  });

  it("adds placeholder thought_signature when Gemini rejects unsigned tool calls", async () => {
    const hasSig = (b: any) => b.messages.some((m: any) => m.tool_calls?.every((tc: any) => tc.extra_content?.google?.thought_signature));
    const { llm, calls } = make((_u, b) =>
      hasSig(b) ? llmReply({ content: "ok" }) : new Response("Function call is missing a thought_signature", { status: 400 }),
    );
    const msgs: ChatMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "r" },
    ];
    expect((await llm.chat(msgs)).content).toBe("ok");
    expect(calls[1].body.messages[1].tool_calls[0].extra_content.google.thought_signature).toBe("skip_thought_signature_validator");
    expect(msgs[1].tool_calls![0].extra_content).toBeUndefined(); // 不修改调用方的数组
  });

  it("keeps existing signatures untouched", () => {
    const tc = { id: "1", type: "function" as const, function: { name: "t", arguments: "{}" }, extra_content: { google: { thought_signature: "real" } } };
    const out = withPlaceholderSignatures([{ role: "assistant", tool_calls: [tc] }]);
    expect((out[0].tool_calls![0].extra_content as any).google.thought_signature).toBe("real");
  });

  it("raises on other 4xx", async () => {
    const { llm } = make(() => new Response("bad key", { status: 401 }));
    await expect(llm.chat([])).rejects.toThrow(/401/);
  });
});
