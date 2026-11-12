/** 时间、文本等小工具。 */

const MYT_OFFSET = 8 * 3600;

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** unix 秒 → "YYYY-MM-DD HH:MM"（MYT） */
export function fmtMyt(ts: number): string {
  return new Date((ts + MYT_OFFSET) * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** unix 秒 → "YYYY-MM-DD"（MYT） */
export function mytDate(ts: number): string {
  return new Date((ts + MYT_OFFSET) * 1000).toISOString().slice(0, 10);
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function mytWeekday(ts: number): string {
  return "星期" + WEEKDAYS[new Date((ts + MYT_OFFSET) * 1000).getUTCDay()];
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 日报等 Telegram HTML → 给 LLM 看的纯文本（链接保留为 "文字 (url)"） */
export function htmlToText(html: string): string {
  return unescapeHtml(
    html
      .replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, (_m, url, text) => `${text} (${url})`)
      .replace(/<[^>]+>/g, ""),
  );
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** 常量时间比较，防止通过响应时间猜 secret */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) {
    diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  }
  return diff === 0;
}

const B64 = new TextEncoder().encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");

/** 字节 → base64。优先用原生 Uint8Array.toBase64（ES2026）；没有时查表写进字节数组，最后一次性解码。
 *  不用 String.fromCharCode + btoa 或字符串拼接：300KB 图片要 14-19ms CPU，超过 Workers 免费版 10ms 上限 */
export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(bytes);
  const len = bytes.length;
  const out = new Uint8Array(Math.ceil(len / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = B64[n >> 18];
    out[o++] = B64[(n >> 12) & 63];
    out[o++] = B64[(n >> 6) & 63];
    out[o++] = B64[n & 63];
  }
  if (i < len) {
    const two = i + 1 < len;
    const n = (bytes[i] << 16) | ((two ? bytes[i + 1] : 0) << 8);
    out[o++] = B64[n >> 18];
    out[o++] = B64[(n >> 12) & 63];
    out[o++] = two ? B64[(n >> 6) & 63] : 61; // "="
    out[o++] = 61;
  }
  return new TextDecoder().decode(out);
}
