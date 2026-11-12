/** 与 config/feeds.yaml 的分组保持一致（test/config.test.ts 会校验） */
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
