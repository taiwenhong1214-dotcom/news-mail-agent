/**
 * 推送下面的 ⭐ / 👍 / 👎 按钮。按钮由流水线发出（pipeline/nma/telegram.py feedback_keyboard，文字要和这里一致），
 * 点击后 Telegram 发 callback_query 到 webhook，这里记到 feedback 表并更新按钮状态。
 * 👍 / 👎 互斥，再点一次撤销；⭐ 是开关。打分时会参考最近的 👍 / 👎（pipeline.py preference_section）。
 */
import type { Telegram } from "./telegram";

export interface FeedbackState {
  vote: 1 | -1 | null;
  saved: boolean;
}

export function feedbackKeyboard(itemId: number, st: FeedbackState) {
  return {
    inline_keyboard: [
      [
        { text: st.saved ? "⭐ 已收藏" : "⭐ 收藏", callback_data: `fb:${itemId}:s` },
        { text: st.vote === 1 ? "👍 ✓" : "👍", callback_data: `fb:${itemId}:u` },
        { text: st.vote === -1 ? "👎 ✓" : "👎", callback_data: `fb:${itemId}:d` },
      ],
    ],
  };
}

export function parseFeedbackData(data: string | undefined): { itemId: number; kind: "s" | "u" | "d" } | null {
  const m = /^fb:(\d{1,12}):([sud])$/.exec(data ?? "");
  return m ? { itemId: Number(m[1]), kind: m[2] as "s" | "u" | "d" } : null;
}

/** 纯函数：当前状态 + 点了哪个按钮 → 新状态 + 提示文字 */
export function applyFeedback(cur: FeedbackState, kind: "s" | "u" | "d"): { next: FeedbackState; toast: string } {
  if (kind === "s") {
    const saved = !cur.saved;
    return { next: { ...cur, saved }, toast: saved ? "⭐ 已收藏，/saved 查看" : "已取消收藏" };
  }
  const v = kind === "u" ? 1 : -1;
  if (cur.vote === v) return { next: { ...cur, vote: null }, toast: "已撤销" };
  return { next: { ...cur, vote: v }, toast: v === 1 ? "👍 收到，以后类似的会多推一点" : "👎 收到，以后类似的会少推一点" };
}

export interface CallbackQuery {
  id: string;
  from: { id: number };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

export async function handleFeedback(cq: CallbackQuery, db: D1Database, tg: Telegram, now: number): Promise<void> {
  const parsed = parseFeedbackData(cq.data);
  if (!parsed) {
    await tg.answerCallback(cq.id);
    return;
  }
  const { itemId, kind } = parsed;
  const row = await db
    .prepare(
      "SELECT n.id, f.vote, f.saved_at FROM news_items n LEFT JOIN feedback f ON f.item_id = n.id WHERE n.id = ?",
    )
    .bind(itemId)
    .first<{ id: number; vote: number | null; saved_at: number | null }>();
  if (!row) {
    await tg.answerCallback(cq.id, "这条新闻已经不在库里了");
    return;
  }
  const cur: FeedbackState = { vote: row.vote === 1 ? 1 : row.vote === -1 ? -1 : null, saved: row.saved_at !== null };
  const { next, toast } = applyFeedback(cur, kind);

  if (next.vote === null && !next.saved) {
    await db.prepare("DELETE FROM feedback WHERE item_id = ?").bind(itemId).run();
  } else {
    await db
      .prepare(
        "INSERT INTO feedback (item_id, vote, saved_at, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(item_id) DO UPDATE SET vote = excluded.vote, saved_at = excluded.saved_at, updated_at = excluded.updated_at",
      )
      // 收藏时间保持第一次收藏的时间
      .bind(itemId, next.vote, next.saved ? (row.saved_at ?? now) : null, now)
      .run();
  }
  await tg.answerCallback(cq.id, toast);
  if (cq.message) await tg.editReplyMarkup(cq.message.chat.id, cq.message.message_id, feedbackKeyboard(itemId, next));
}
