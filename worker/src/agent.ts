import systemTemplate from "../../prompts/chat_system.md";
import { GROUPS, MAX_HISTORY_TURNS, MAX_TOOL_ROUNDS } from "./config";
import type { ChatMessage, LLM } from "./llm";
import { TOOL_DEFS, runToolToString, type ToolContext } from "./tools";
import { fmtMyt, mytWeekday } from "./util";

export function buildSystemPrompt(now: number): string {
  return systemTemplate
    .replace("{{now}}", `${fmtMyt(now)} ${mytWeekday(now)}`)
    .replace("{{groups}}", Object.values(GROUPS).join("、"));
}

// ---------------- 对话历史（只存用户消息和最终回复，不存中间的工具调用） ----------------

export async function loadHistory(db: D1Database, chatId: number): Promise<ChatMessage[]> {
  const { results } = await db
    .prepare("SELECT role, content FROM chat_history WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
    .bind(chatId, MAX_HISTORY_TURNS * 2)
    .all<{ role: "user" | "assistant"; content: string }>();
  const msgs = results.reverse().map((r) => ({ role: r.role, content: r.content }) as ChatMessage);
  while (msgs.length && msgs[0].role !== "user") msgs.shift(); // 保证以用户消息开头
  return msgs;
}

export async function saveTurn(db: D1Database, chatId: number, user: string, assistant: string, now: number) {
  const ins = "INSERT INTO chat_history (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)";
  await db.batch([
    db.prepare(ins).bind(chatId, "user", user, now),
    db.prepare(ins).bind(chatId, "assistant", assistant, now),
    db
      .prepare(
        "DELETE FROM chat_history WHERE chat_id = ? AND id NOT IN " +
          "(SELECT id FROM chat_history WHERE chat_id = ? ORDER BY id DESC LIMIT ?)",
      )
      .bind(chatId, chatId, MAX_HISTORY_TURNS * 2),
  ]);
}

export async function clearHistory(db: D1Database, chatId: number) {
  await db.prepare("DELETE FROM chat_history WHERE chat_id = ?").bind(chatId).run();
}

// ---------------- Agent 循环 ----------------

export interface AgentDeps {
  llm: Pick<LLM, "chat">;
  toolCtx: ToolContext;
  history: ChatMessage[];
  onToolRound?: (toolNames: string[]) => Promise<void> | void;
}

export interface AgentResult {
  reply: string;
  toolsUsed: string[];
}

export async function runAgent(userText: string, deps: AgentDeps): Promise<AgentResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(deps.toolCtx.now) },
    ...deps.history,
    { role: "user", content: userText },
  ];
  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const msg = await deps.llm.chat(messages, TOOL_DEFS);
    if (!msg.tool_calls?.length) {
      return { reply: (msg.content ?? "").trim() || "（没有生成回复，请换个说法再试）", toolsUsed };
    }
    messages.push(msg); // 原样回传（保留服务商附加字段）
    const names = msg.tool_calls.map((tc) => tc.function.name);
    toolsUsed.push(...names);
    await deps.onToolRound?.(names);
    const results = await Promise.all(
      msg.tool_calls.map((tc) => runToolToString(tc.function.name, tc.function.arguments, deps.toolCtx)),
    );
    msg.tool_calls.forEach((tc, i) => {
      messages.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: results[i] });
    });
  }

  // 工具轮数用完：要求模型基于已有结果直接回答
  const final = await deps.llm.chat(messages, TOOL_DEFS, "none");
  return { reply: (final.content ?? "").trim() || "（查询步骤太多，没能完成，请把问题拆小一点）", toolsUsed };
}
