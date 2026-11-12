/** OpenAI 兼容 Chat Completions（含 function calling）。主模型过载时切备用模型。 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  [k: string]: unknown; // 保留服务商附加字段（如 Gemini 的 thought signature），回传时原样带上
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  [k: string]: unknown;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export class LLMError extends Error {}

const PLACEHOLDER_SIGNATURE = "skip_thought_signature_validator";

/** 给没有 thought_signature 的工具调用补上占位签名（不修改原数组） */
export function withPlaceholderSignatures(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !m.tool_calls?.length) return m;
    return {
      ...m,
      tool_calls: m.tool_calls.map((tc) => {
        const google = (tc.extra_content as { google?: { thought_signature?: string } } | undefined)?.google;
        if (google?.thought_signature) return tc;
        return { ...tc, extra_content: { google: { ...google, thought_signature: PLACEHOLDER_SIGNATURE } } };
      }),
    };
  });
}

class ModelUnavailable extends Error {}

export interface LLMOptions {
  baseUrl: string;
  apiKey: string;
  models: string[];
  reasoningEffort?: string;
  retries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class LLM {
  private idx = 0;
  private reasoningEffort?: string;
  private url: string;
  private retries: number;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  calls = 0;

  constructor(private opts: LLMOptions) {
    if (!opts.apiKey) throw new LLMError("缺少 LLM_API_KEY");
    this.url = opts.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    this.reasoningEffort = opts.reasoningEffort || undefined;
    this.retries = opts.retries ?? 2;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a)); // 直接存 fetch 再当方法调用，Workers 会报 Illegal invocation
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get model(): string {
    return this.opts.models[this.idx];
  }

  async chat(messages: ChatMessage[], tools?: ToolDef[], toolChoice?: "auto" | "none"): Promise<ChatMessage> {
    const errors: string[] = [];
    for (;;) {
      try {
        return await this.once(this.model, messages, tools, toolChoice);
      } catch (e) {
        if (!(e instanceof ModelUnavailable)) throw e;
        errors.push(`${this.model}: ${e.message}`);
        if (this.idx + 1 >= this.opts.models.length) {
          throw new LLMError("所有模型都不可用 | " + errors.join(" | "));
        }
        this.idx++;
      }
    }
  }

  private async once(model: string, messages: ChatMessage[], tools?: ToolDef[], toolChoice?: string): Promise<ChatMessage> {
    const body: Record<string, unknown> = { model, messages, temperature: 0.3 };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = toolChoice ?? "auto";
    }
    if (this.reasoningEffort) body.reasoning_effort = this.reasoningEffort;

    let failures = 0;
    let last = "";
    let patchedSignatures = false;
    while (failures < this.retries) {
      let r: Response;
      try {
        r = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {
        last = String(e);
        failures++;
        await this.sleep(1000 * failures);
        continue;
      }
      if (r.status === 404) throw new ModelUnavailable("HTTP 404（模型不存在）");
      if (r.status === 429 || r.status >= 500) {
        last = `HTTP ${r.status}`;
        failures++;
        await this.sleep(1500 * failures);
        continue;
      }
      if (r.status === 400) {
        const text = await r.text();
        if (text.includes("thought_signature") && !patchedSignatures) {
          // Gemini 3 要求回传工具调用的 thought_signature。中途换模型时，旧模型（如 2.5）发起的
          // 调用没有签名，用官方提供的占位签名跳过校验
          body.messages = withPlaceholderSignatures(messages);
          patchedSignatures = true;
          continue;
        }
        if ("reasoning_effort" in body) {
          delete body.reasoning_effort; // 模型不支持这个参数：去掉重试，之后也不再传
          this.reasoningEffort = undefined;
          continue;
        }
        throw new LLMError(`LLM HTTP 400: ${text.slice(0, 300)}`);
      }
      if (!r.ok) throw new LLMError(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);

      const data = (await r.json()) as { choices?: { message?: ChatMessage }[] };
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new LLMError(`LLM 响应格式异常: ${JSON.stringify(data).slice(0, 300)}`);
      this.calls++;
      return { ...msg, role: "assistant" };
    }
    throw new ModelUnavailable(`重试 ${this.retries} 次仍失败: ${last}`);
  }
}
