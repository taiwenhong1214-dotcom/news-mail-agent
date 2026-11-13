import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { cacheKey, fetchTavilyUsage, MAX_SEARCHES_PER_MESSAGE, searchParams, webSearch } from "../src/search";
import type { ToolContext } from "../src/tools";
import { FakeD1, fakeFetch } from "./fakes";

const NOW = Date.UTC(2026, 10, 13, 2, 0) / 1000;

/** 带 search_cache 和 app_state 的假 D1 */
function stateDb() {
  const cache = new Map<string, { result: string; created_at: number }>();
  const state = new Map<string, string>();
  const db = new FakeD1((sql, p) => {
    if (sql.startsWith("SELECT result FROM search_cache")) {
      const r = cache.get(p[0] as string);
      return { first: r && r.created_at >= (p[1] as number) ? { result: r.result } : null };
    }
    if (sql.startsWith("INSERT OR REPLACE INTO search_cache")) cache.set(p[0] as string, { result: p[1] as string, created_at: p[2] as number });
    if (sql.includes("FROM app_state WHERE key = 'tavily_quota'")) {
      const v = state.get("tavily_quota");
      return { first: v ? { value: v } : null };
    }
    if (sql.includes("INSERT INTO app_state (key, value, updated_at) VALUES ('tavily_quota'")) state.set("tavily_quota", p[0] as string);
    return { changes: 1 };
  });
  return { db, cache, quota: () => JSON.parse(state.get("tavily_quota") ?? "null") };
}

function tavily(opts: { used?: number; limit?: number; searchStatus?: number } = {}) {
  return fakeFetch((url) => {
    if (url.endsWith("/usage")) return Response.json({ key: { usage: opts.used ?? 0, limit: null }, account: { plan_usage: opts.used ?? 0, plan_limit: opts.limit ?? 1000, paygo_usage: 0, paygo_limit: 0 } });
    if (url.endsWith("/search")) {
      if (opts.searchStatus) return new Response("limit", { status: opts.searchStatus });
      return Response.json({ answer: "A", results: [{ title: "T", url: "https://t.com", content: "c" }] });
    }
    return new Response("", { status: 404 });
  });
}

const ctxFor = (db: FakeD1, f: ReturnType<typeof fakeFetch>, extra: Partial<ToolContext> = {}): ToolContext => ({
  env: { DB: db, TAVILY_API_KEY: "t" } as unknown as Env,
  now: NOW,
  fetchImpl: f.impl,
  ...extra,
});

const searchCalls = (f: ReturnType<typeof fakeFetch>) => f.calls.filter((c) => c.url.endsWith("/search")).length;

describe("web_search budget", () => {
  it("normalizes cache keys", () => {
    expect(cacheKey(searchParams({ query: "  Nvidia   CEO " }))).toBe(cacheKey(searchParams({ query: "nvidia ceo" })));
    expect(cacheKey(searchParams({ query: "x", time_range: "day" }))).not.toBe(cacheKey(searchParams({ query: "x" })));
  });

  it("serves repeated searches from cache without using the per-message budget", async () => {
    const { db } = stateDb();
    const f = tavily();
    const usage = { searches: 0 };
    const r1 = await webSearch({ query: "k8s 1.36" }, ctxFor(db, f, { searchUsage: usage }));
    const r2 = (await webSearch({ query: "K8s  1.36" }, ctxFor(db, f, { searchUsage: usage, now: NOW + 3600 }))) as any;
    expect(searchCalls(f)).toBe(1);
    expect(r2.cached).toBe(true);
    expect(r2.results).toEqual((r1 as any).results);
    expect(usage.searches).toBe(1);
    // 过期后重新搜（time_range=day 只缓存 2 小时）
    await webSearch({ query: "news", time_range: "day" }, ctxFor(db, f));
    await webSearch({ query: "news", time_range: "day" }, ctxFor(db, f, { now: NOW + 3 * 3600 }));
    expect(searchCalls(f)).toBe(3);
  });

  it("caps real searches per message, including parallel calls", async () => {
    const { db } = stateDb();
    const f = tavily();
    const usage = { searches: 0 };
    const results = await Promise.all(["a1", "b1", "c1"].map((q) => webSearch({ query: q }, ctxFor(db, f, { searchUsage: usage }))));
    expect(searchCalls(f)).toBe(MAX_SEARCHES_PER_MESSAGE);
    expect(results.filter((r) => "error" in r).length).toBe(1);
    expect((results.find((r) => "error" in r) as any).error).toContain("已经联网搜索了 2 次");
  });

  it("syncs usage from Tavily hourly, counts locally in between, and warns once at 80%", async () => {
    const { db, quota } = stateDb();
    const f = tavily({ used: 798, limit: 1000 });
    const notices: string[] = [];
    await webSearch({ query: "q1" }, ctxFor(db, f, { notices }));
    expect(quota()).toMatchObject({ used: 799, limit: 1000, synced_at: NOW, warned: false });
    await webSearch({ query: "q2" }, ctxFor(db, f, { notices, now: NOW + 60 }));
    await webSearch({ query: "q3" }, ctxFor(db, f, { notices, now: NOW + 120 }));
    expect(f.calls.filter((c) => c.url.endsWith("/usage")).length).toBe(1); // 一小时内不重复同步
    expect(quota().used).toBe(801);
    expect(notices).toEqual([expect.stringContaining("800/1000")]);
  });

  it("stops calling Tavily when the quota is used up", async () => {
    const { db } = stateDb();
    const f = tavily({ used: 1000, limit: 1000 });
    const r = (await webSearch({ query: "q" }, ctxFor(db, f))) as any;
    expect(r.error).toContain("额度已用完");
    expect(searchCalls(f)).toBe(0);
  });

  it("treats HTTP 432 as quota exhausted and remembers it", async () => {
    const { db, quota } = stateDb();
    const f = tavily({ used: 10, limit: 1000, searchStatus: 432 });
    expect(((await webSearch({ query: "q" }, ctxFor(db, f))) as any).error).toContain("额度已用完");
    expect(quota().used).toBe(1000);
    await webSearch({ query: "q2" }, ctxFor(db, f, { now: NOW + 60 }));
    expect(searchCalls(f)).toBe(1); // 第二次直接拒绝
  });

  it("keeps searching when the usage endpoint fails", async () => {
    const { db, quota } = stateDb();
    const f = fakeFetch((url) => (url.endsWith("/usage") ? new Response("", { status: 500 }) : Response.json({ results: [] })));
    expect(await webSearch({ query: "q" }, ctxFor(db, f))).not.toHaveProperty("error");
    expect(quota()).toMatchObject({ limit: null, synced_at: NOW - 3600 + 600 }); // 10 分钟后再试同步
  });

  it("reads key-level limits from /usage", async () => {
    const f = fakeFetch(() => Response.json({ key: { usage: 5, limit: 100 }, account: { plan_usage: 300, plan_limit: 1000 } }));
    expect(await fetchTavilyUsage("t", f.impl)).toEqual({ used: 5, limit: 100 });
  });
});
