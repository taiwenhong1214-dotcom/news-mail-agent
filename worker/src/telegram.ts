import { escapeHtml } from "./util";

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
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => hold(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text, url) =>
    hold(`<a href="${escapeHtml(url).replace(/"/g, "&quot;")}">${escapeHtml(text.replace(/\*\*/g, ""))}</a>`),
  );

  s = escapeHtml(s);
  s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^_\n]+?)__/g, "<b>$1</b>");
  s = s.replace(/^(\s*)[-*]\s+/gm, "$1• ");

  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => slots[Number(i)]);
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

  /** 发送 HTML 消息；HTML 解析失败时退回纯文本 */
  async sendHtml(chatId: number | string, html: string, fallbackText?: string): Promise<void> {
    for (const part of splitMessage(html)) {
      const r = await this.call("sendMessage", {
        chat_id: chatId,
        text: part,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      if (r && r.status === 400) {
        const plain = fallbackText ?? part.replace(/<[^>]+>/g, "");
        for (const p of splitMessage(plain)) {
          await this.call("sendMessage", { chat_id: chatId, text: p, link_preview_options: { is_disabled: true } });
        }
        return;
      }
    }
  }

  async sendMarkdown(chatId: number | string, md: string): Promise<void> {
    await this.sendHtml(chatId, mdToTelegramHtml(md), md);
  }

  async typing(chatId: number | string): Promise<void> {
    try {
      await this.call("sendChatAction", { chat_id: chatId, action: "typing" });
    } catch {
      // 只是提示，失败无所谓
    }
  }

  async setWebhook(url: string, secret: string): Promise<unknown> {
    const r = await this.call("setWebhook", {
      url,
      secret_token: secret,
      allowed_updates: ["message"],
      drop_pending_updates: true,
    });
    return r ? r.json() : { ok: true, dry_run: true };
  }
}
