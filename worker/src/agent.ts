import systemTemplate from "../../prompts/chat_system.md";
import { GROUPS, MAX_HISTORY_TURNS, MAX_TOOL_ROUNDS } from "./config";
import type { ChatMessage, ContentPart, LLM } from "./llm";
import { runToolToString, toolDefs, type ToolContext } from "./tools";
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

/** 取消息里的文字部分（content 可能是字符串，也可能是多模态片段数组） */
export function textOf(content: ChatMessage["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

export async function runAgent(userText: string, deps: AgentDeps): Promise<AgentResult> {
  const image = deps.toolCtx.image;
  const userContent: string | ContentPart[] = image
    ? [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } },
      ]
    : userText;
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(deps.toolCtx.now) },
    ...deps.history,
    { role: "user", content: userContent },
  ];
  const tools = toolDefs(deps.toolCtx);
  const toolsUsed: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const msg = await deps.llm.chat(messages, tools);
    if (!msg.tool_calls?.length) {
      return { reply: textOf(msg.content).trim() || "（没有生成回复，请换个说法再试）", toolsUsed };
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
  const final = await deps.llm.chat(messages, tools, "none");
  return { reply: textOf(final.content).trim() || "（查询步骤太多，没能完成，请把问题拆小一点）", toolsUsed };
}
