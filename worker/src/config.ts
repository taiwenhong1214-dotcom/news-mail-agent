/** 与 config/feeds.yaml 的分组保持一致（test/webhook.test.ts 的 config 用例会校验） */
export const GROUPS: Record<string, string> = {
  devops: "DevOps",
  "cloud-native": "云原生",
  "ai-infra": "AI 基础设施",
  "my-jobs": "大马科技招聘",
  "my-it": "大马 IT",
  "my-local": "大马本地",
  world: "国际",
  trends: "世界趋势",
  finance: "金融",
  stocks: "马股美股科技",
};

export const MAX_HISTORY_TURNS = 20;   // 对话历史保留轮数（一问一答为一轮）
export const MAX_TOOL_ROUNDS = 4;      // 单条消息最多几轮工具调用
export const TOOL_RESULT_MAX_CHARS = 8000;
// 图片上限。Telegram 压缩后的照片通常 100-300KB；每轮 LLM 请求都要带上整张图，
// 图太大时 JSON 序列化会吃掉 Workers 免费版 10ms CPU 预算
export const MAX_IMAGE_BYTES = 1_500_000;
