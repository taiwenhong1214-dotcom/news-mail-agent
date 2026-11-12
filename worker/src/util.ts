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
