export interface Env {
  DB: D1Database;

  // secrets（npx wrangler secret put）
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string; // setWebhook 时的 secret_token，Telegram 每次请求带在 header 里
  ALLOWED_CHAT_IDS: string;        // 逗号分隔的白名单 chat_id
  LLM_API_KEY: string;
  TAVILY_API_KEY?: string;
  GITHUB_TOKEN?: string;
  GOOGLE_VISION_API_KEY?: string;  // 可选：Cloud Vision Web Detection，以图搜图找出处           // fine-grained PAT，Actions: Read and write

  // vars（wrangler.toml）
  LLM_BASE_URL?: string;
  CHAT_MODEL?: string;
  CHAT_FALLBACK_MODELS?: string;
  CHAT_REASONING_EFFORT?: string;
  GITHUB_REPO?: string;
  GITHUB_WORKFLOW?: string;

  // 本地调试：设为 "1" 时不真的调用 Telegram，只打印到控制台
  TELEGRAM_DRY_RUN?: string;
}
