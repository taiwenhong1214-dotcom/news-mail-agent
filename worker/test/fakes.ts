/** 测试用的极简 D1 / fetch 替身 */

type Handler = (sql: string, params: unknown[]) => { results?: unknown[]; changes?: number; first?: unknown };

export class FakeD1 {
  calls: { sql: string; params: unknown[] }[] = [];
  updates = new Set<number>();
  history: { chat_id: number; role: string; content: string }[] = [];

  constructor(private extra: Handler = () => ({})) {}

  private exec(sql: string, params: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes("INSERT OR IGNORE INTO tg_updates")) {
      const id = params[0] as number;
      const isNew = !this.updates.has(id);
      this.updates.add(id);
      return { changes: isNew ? 1 : 0 };
    }
    if (sql.startsWith("SELECT role, content FROM chat_history")) {
      const rows = this.history.filter((h) => h.chat_id === params[0]).slice().reverse();
      return { results: rows.slice(0, params[1] as number) };
    }
    if (sql.startsWith("INSERT INTO chat_history")) {
      this.history.push({ chat_id: params[0] as number, role: params[1] as string, content: params[2] as string });
      return { changes: 1 };
    }
    return this.extra(sql, params);
  }

  prepare(sql: string) {
    const self = this;
    let params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt;
      },
      async run() {
        const r = self.exec(sql, params);
        return { success: true, meta: { changes: r.changes ?? 0 }, results: r.results ?? [] };
      },
      async all() {
        const r = self.exec(sql, params);
        return { success: true, meta: {}, results: r.results ?? [] };
      },
      async first() {
        const r = self.exec(sql, params);
        return (r.first ?? r.results?.[0] ?? null) as unknown;
      },
      _run: () => self.exec(sql, params),
    };
    return stmt;
  }

  async batch(stmts: { _run: () => { results?: unknown[]; changes?: number } }[]) {
    return stmts.map((s) => {
      const r = s._run();
      return { success: true, meta: { changes: r.changes ?? 0 }, results: r.results ?? [] };
    });
  }
}

export interface Recorded {
  url: string;
  body: any;
}

/** 按 URL 分派的假 fetch，记录所有请求 */
export function fakeFetch(routes: (url: string, body: any) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    return routes(url, body);
  }) as typeof fetch;
  return { impl, calls };
}

export function llmReply(message: Record<string, unknown>) {
  return Response.json({ choices: [{ message: { role: "assistant", ...message } }] });
}
