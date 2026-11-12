/**
 * POST /check：给手机快捷指令用的一键核实入口。
 * 刷 Facebook 时轻点手机背面 → 快捷指令截屏 → 压成 JPEG → POST 到这里。
 * Worker 跑核实 → 结果发到 Telegram，同时作为纯文本返回，快捷指令可以直接弹通知显示。
 *
 * 请求：Authorization: Bearer <CHECK_TOKEN>
 *   - body 是图片（Content-Type: image/jpeg|png|webp）：核实截图里的帖子
 *   - body 是文字（text/plain）：核实一段文字或链接
 *   - 可选 ?q=补充问题，例如 ?q=这个优惠是真的吗
 */
import { runAgent, saveTurn } from "./agent";
import { MAX_IMAGE_BYTES } from "./config";
import type { Env } from "./env";
import type { Deps } from "./index";
import { allowedChatIds, makeLLM } from "./index";
import { Telegram } from "./telegram";
import { bytesToBase64, escapeHtml, safeEqual } from "./util";

const MAX_TEXT_CHARS = 4000;

export const CHECK_PROMPT_IMAGE = "请核实这张截图里帖子的说法（我在刷 Facebook 时截的图）。";
export const CHECK_PROMPT_TEXT = "请核实下面这段内容的说法：";

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** 给快捷指令通知用：去掉 Markdown 记号，链接改成「标题 (url)」 */
export function mdToPlain(md: string): string {
  return md
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*\n]+?)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ");
}

export async function handleCheck(
  req: Request,
  env: Env,
  deps: Deps,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<Response> {
  const token = (env.CHECK_TOKEN || "").trim();
  const auth = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !safeEqual(auth, token)) return plain(401, "unauthorized");

  const chatId = [...allowedChatIds(env)][0];
  if (!chatId) return plain(500, "ALLOWED_CHAT_IDS 没有配置");

  const extra = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 300);
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  let image: { mime: string; base64: string } | undefined;
  let userText: string;
  let historyText: string;

  if (type.startsWith("image/")) {
    const mime = type.split(";")[0];
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(mime)) return plain(415, `不支持的图片格式 ${mime}`);
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (!bytes.length) return plain(400, "图片是空的");
    if (bytes.length > MAX_IMAGE_BYTES) {
      return plain(413, `图片太大（${(bytes.length / 1e6).toFixed(1)}MB，上限 ${MAX_IMAGE_BYTES / 1e6}MB）。请在快捷指令里加「转换图像 → JPEG」和「调整图像大小 → 宽 1080」`);
    }
    image = { mime, base64: bytesToBase64(bytes) };
    userText = CHECK_PROMPT_IMAGE + (extra ? `\n我想知道：${extra}` : "");
    historyText = `[核实截图] ${extra}`.trim();
  } else {
    const text = (await req.text()).trim().slice(0, MAX_TEXT_CHARS);
    if (!text) return plain(400, "没有收到图片或文字");
    userText = `${CHECK_PROMPT_TEXT}\n\n${text}` + (extra ? `\n\n我想知道：${extra}` : "");
    historyText = `[核实] ${text.slice(0, 500)}`;
  }

  const now = deps.now();
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_DRY_RUN === "1", deps.fetchImpl);
  const work = (async (): Promise<Response> => {
    try {
      await tg.typing(chatId);
      const { reply } = await runAgent(userText, {
        llm: makeLLM(env, deps),
        history: [], // 每次核实独立，不带之前的闲聊
        toolCtx: { env, now, fetchImpl: deps.fetchImpl, image },
        onToolRound: () => tg.typing(chatId),
      });
      await tg.sendMarkdown(chatId, `🔎 **核实结果**\n\n${reply}`);
      // 存进历史：之后可以在 Telegram 里接着追问「第二点再查查」
      await saveTurn(env.DB, chatId, historyText, reply, now);
      return plain(200, mdToPlain(reply));
    } catch (e) {
      console.error("check failed", e);
      const detail = e instanceof Error ? e.message : String(e);
      await tg.sendHtml(chatId, `⚠️ 核实失败：${escapeHtml(detail.slice(0, 300))}`).catch(() => {});
      return plain(502, `核实失败：${detail.slice(0, 300)}`);
    }
  })();
  // 快捷指令等太久断开时，靠 waitUntil 让核实继续跑完，结果照样发到 Telegram
  waitUntil?.(work);
  return work;
}
