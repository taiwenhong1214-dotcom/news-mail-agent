import { escapeHtml, htmlToText } from "./util";

const MAX_LEN = 4000; // Telegram 上限 4096，留余量

/**
 * LLM 输出的 Markdown → Telegram 支持的 HTML 子集。
 * 支持：```代码块```、`行内代码`、[文字](链接)、**粗体**、# 标题（转粗体）、- 列表（转 •）。
 * 其余字符全部转义，保证 Telegram 能解析。
 */
export function mdToTelegramHtml(md: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  let s = md.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, code) => hold(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`));
  // 链接在行内代码之前处理：链接文字里的 `code` 直接去掉反引号，不产生嵌套占位符。
  // URL 允许一层成对括号（维基百科的 Foo_(bar) 这类）
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g, (_m, text, url) =>
    hold(`<a href="${escapeHtml(url).replace(/"/g, "&quot;")}">${escapeHtml(text.replace(/\*\*|`/g, ""))}</a>`),
  );
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => hold(`<code>${escapeHtml(code)}</code>`));

  s = escapeHtml(s);
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+?)__/g, "<b>$1</b>");
  s = s.replace(/^(\s*)[-*]\s+/gm, "$1• ");

  // 递归还原：万一占位符里还套着占位符，也不会把 \u0000 漏到消息里
  const restore = (t: string): string => t.replace(/\u0000(\d+)\u0000/g, (_m, i) => restore(slots[Number(i)] ?? ""));
  return restore(s);
}

const MD_CHUNK = 3500; // 转成 HTML 后会变长（链接、转义），留出余量

/**
 * 长 Markdown 先按行切段，每段单独转 HTML、单独发：不会把 HTML 标签切成两半，
 * 某一段解析失败也只需要把那一段改发纯文本。代码块被切开时在切口两边补上 ```。
 */
export function splitMarkdown(md: string, limit = MD_CHUNK): string[] {
  const parts = splitMessage(md, limit);
  if (parts.length === 1) return parts;
  let open = false;
  return parts.map((part) => {
    const startsOpen = open;
    if ((part.match(/```/g) ?? []).length % 2 === 1) open = !open;
    return (startsOpen ? "```\n" : "") + part + (open ? "\n```" : "");
  });
}

/** 按行切分长消息，尽量不切断一行 */
export function splitMessage(text: string, limit = MAX_LEN): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let buf = "";
  for (let line of text.split("\n")) {
    while (line.length > limit) {
      if (buf) {
        parts.push(buf);
        buf = "";
      }
      parts.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    if (buf.length + line.length + 1 > limit) {
      parts.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

export class Telegram {
  constructor(
    private token: string,
    private dryRun = false,
    private fetchImpl: typeof fetch = (...a) => fetch(...a), // 不能直接存 fetch：Workers 里会报 Illegal invocation
  ) {}

  private async call(method: string, body: unknown): Promise<Response | null> {
    if (this.dryRun) {
      console.log(`[telegram dry-run] ${method}`, JSON.stringify(body));
      return null;
    }
    return this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * 发送 HTML 消息；某一段 HTML 解析失败（400）时只把这一段改发纯文本，已发出的段不重发。
   * fallbackText 只在整条消息不用切段时使用（切段后对不上是哪一部分）。
   */
  async sendHtml(chatId: number | string, html: string, fallbackText?: string): Promise<void> {
    const parts = splitMessage(html);
    for (const part of parts) {
      const r = await this.call("sendMessage", {
        chat_id: chatId,
        text: part,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      if (r && r.status === 400) {
        const plain = parts.length === 1 && fallbackText !== undefined ? fallbackText : htmlToText(part);
        for (const p of splitMessage(plain)) {
          await this.call("sendMessage", { chat_id: chatId, text: p, link_preview_options: { is_disabled: true } });
        }
      }
    }
  }

  async sendMarkdown(chatId: number | string, md: string): Promise<void> {
    for (const chunk of splitMarkdown(md)) {
      await this.sendHtml(chatId, mdToTelegramHtml(chunk), chunk);
    }
  }

  async typing(chatId: number | string): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
    } catch {
      // 只是提示，失败无所谓
    }
  }

  /** 按钮点击后必须回应，否则按钮上会一直转圈；text 显示为顶部的短提示 */
  async answerCallback(callbackId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
  }

  async editReplyMarkup(chatId: number | string, messageId: number, replyMarkup: unknown): Promise<void> {
    // 内容没变时 Telegram 返回 400 "message is not modified"，无所谓
    await this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  }

  /** allowed_updates 要包含 callback_query，推送下面的按钮才能用 */
  async setWebhook(url: string, secret: string, dropPending = true): Promise<unknown> {
    const r = await this.call("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: dropPending,
    });
    return r ? r.json() : { ok: true, dry_run: true };
  }
}
