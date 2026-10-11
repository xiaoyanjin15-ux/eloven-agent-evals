import type { AgentReply, DialogueAgent, EvalCase, OfficeAgentConfig } from "./domain.js";

export class MockDialogueAgent implements DialogueAgent {
  private evalCase?: EvalCase;
  private turn = 0;

  reset(evalCase: EvalCase): void { this.evalCase = evalCase; this.turn = 0; }

  async reply(): Promise<AgentReply> {
    if (!this.evalCase) throw new Error("Agent 尚未初始化");
    this.turn += 1;
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (this.evalCase.followups.length && this.turn === 1) return { content: "为了给出准确结果，请补充查询范围或对象名称。", tool_calls: [] };
    const content = this.evalCase.expected_answer || `已完成查询。关键信息包括：${this.evalCase.expected_keywords.join("、")}。`;
    const calls = /查询|文件|工位|列表/.test(this.evalCase.query)
      ? [{ name: "workspace_search", status: "success", arguments: { query: this.evalCase.query } }] : [];
    return { content, tool_calls: calls };
  }
}

export class OpenAICompatibleAgent implements DialogueAgent {
  private baseUrl = (process.env.AGENT_EVAL_BASE_URL || "").replace(/\/$/, "");
  private key = process.env.AGENT_EVAL_API_KEY || "";
  private model = process.env.AGENT_EVAL_MODEL || "";

  reset(): void {
    if (!this.baseUrl || !this.key || !this.model) throw new Error("请设置 AGENT_EVAL_BASE_URL、AGENT_EVAL_API_KEY 和 AGENT_EVAL_MODEL");
  }

  async reply(messages: Array<{ role: string; content: string }>): Promise<AgentReply> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, messages, temperature: 0 }), signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`被测 Agent 接口调用失败：${response.status}`);
    const data = await response.json() as { choices: Array<{ message: { content?: string; tool_calls?: Array<Record<string, unknown>> } }> };
    const message = data.choices[0]?.message;
    return { content: message?.content || "", tool_calls: message?.tool_calls || [] };
  }
}

export class OfficeAgent implements DialogueAgent {
  private readonly endpoint: string;
  private readonly jwt: string;
  private readonly model: string;
  private readonly sessionId: string;
  private readonly hermesAgentId: string;

  constructor(config: OfficeAgentConfig) {
    const baseUrl = validateBaseUrl(config.base_url);
    const agentId = config.agent_id.trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId)) {
      throw new Error("Agent ID 只能包含字母、数字、下划线或连字符");
    }
    const profile = (config.profile || "").trim();
    if (profile && !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) {
      throw new Error("Agent profile 只能包含字母、数字、下划线或连字符");
    }
    const profilePath = profile ? `${encodeURIComponent(profile)}/` : "";
    this.endpoint = `${baseUrl}/${encodeURIComponent(agentId)}/${profilePath}v1/chat/completions`;
    this.jwt = (config.jwt || "").trim();
    this.model = (config.model || "default").trim() || "default";
    this.sessionId = (config.session_id || "").trim();
    this.hermesAgentId = profile || agentId;
  }

  reset(): void {}

  async reply(messages: Array<{ role: string; content: string }>): Promise<AgentReply> {
    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: "Bearer internal" };
    if (this.jwt) headers["X-Hermes-Auth-Token"] = this.jwt;
    if (this.sessionId) headers["X-Hermes-Web-Session-Id"] = this.sessionId;
    headers["X-Hermes-Agent-Id"] = this.hermesAgentId;
    const endpoint = this.jwt ? `${this.endpoint}?token=${encodeURIComponent(this.jwt)}` : this.endpoint;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, hermes_profile: this.hermesAgentId, stream: true, stream_options: { include_usage: true }, messages }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) {
      const hint = response.status === 401 ? "，请重新登录并更新 JWT" : "";
      const allow = response.headers.get("allow");
      const responseType = response.headers.get("content-type") || "";
      const raw = await response.text();
      const compact = raw.replace(/\s+/g, " ").trim().slice(0, 240);
      const routeHint = response.status === 405
        ? "；当前请求已使用 POST，通常表示 Base URL 或接口路径指向了网页路由"
        : "";
      const details = [allow ? `Allow=${allow}` : "", compact && !responseType.includes("text/html") ? compact : ""]
        .filter(Boolean).join("；");
      throw new Error(`Office Agent 接口调用失败：POST ${this.endpoint} → ${response.status}${hint}${routeHint}${details ? `；${details}` : ""}`);
    }
    const responseType = response.headers.get("content-type") || "";
    if (responseType.includes("text/event-stream")) return readEventStream(response);
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string; tool_calls?: Array<Record<string, unknown>> } }>;
    };
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("Office Agent 返回格式不符合 Chat Completions 协议");
    return { content: message.content || "", tool_calls: message.tool_calls || [] };
  }
}

export async function createOfficeSession(config: OfficeAgentConfig): Promise<string> {
  const profile = (config.profile || "").trim();
  const agentId = config.agent_id.trim();
  const supplied = (config.session_id || "").trim();
  return supplied || `default_${profile || agentId}`;
}

async function readEventStream(response: Response): Promise<AgentReply> {
  if (!response.body) throw new Error("Office Agent 流式响应没有可读取的内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", payload = "", finished = false;
  try {
    while (!finished) {
      const { done, value } = await readWithTimeout(reader, 90_000);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { finished = true; break; }
        payload += `${line}\n`;
      }
    }
  } finally {
    if (finished) await reader.cancel().catch(() => undefined);
  }
  return parseEventStream(payload);
}

async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("目标 Agent 90 秒内没有返回流数据；当前环境通常需要有效的 Office 登录 JWT，或改用已登录浏览器执行模式")), timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function parseEventStream(payload: string): AgentReply {
  let content = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const line of payload.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    let event: {
      choices?: Array<{ delta?: { content?: string; tool_calls?: Array<Record<string, unknown>> }; message?: { content?: string; tool_calls?: Array<Record<string, unknown>> } }>;
    };
    try { event = JSON.parse(raw); } catch { continue; }
    const choice = event.choices?.[0];
    content += choice?.delta?.content || choice?.message?.content || "";
    toolCalls.push(...(choice?.delta?.tool_calls || choice?.message?.tool_calls || []));
  }
  if (!content && !toolCalls.length) throw new Error("Office Agent 流式响应中没有可解析的回复");
  return { content, tool_calls: toolCalls };
}

function validateBaseUrl(value: string): string {
  const raw = value.trim().replace(/\/+$/, "");
  if (!raw) throw new Error("请填写 Office Agent Base URL");
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error("Office Agent Base URL 格式不正确"); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Office Agent Base URL 必须使用 HTTP 或 HTTPS");
  if (parsed.search || parsed.hash) throw new Error("Base URL 不能包含查询参数或锚点，请不要填写 Office 页面链接");
  return raw;
}
