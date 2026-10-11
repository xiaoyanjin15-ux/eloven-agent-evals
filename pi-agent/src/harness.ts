import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  Type,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  getEnvApiKey,
  getModels,
  getProviders,
  registerFauxProvider,
  type Model,
} from "@earendil-works/pi-ai";

import type { HarnessInput, HarnessOutput, HarnessTrace, ProposedCase, ProjectContext } from "./types.js";

const questionSchema = Type.Object({
  questions: Type.Array(Type.Object({ field: Type.String(), question: Type.String() })),
});

const caseSchema = Type.Object({
  cases: Type.Array(Type.Object({
    code: Type.String(),
    category: Type.String(),
    title: Type.String(),
    query: Type.String(),
    expected_answer: Type.String(),
    expected_keywords: Type.Array(Type.String()),
    forbidden_keywords: Type.Array(Type.String()),
    followups: Type.Array(Type.String()),
    max_turns: Type.Number({ minimum: 1, maximum: 10 }),
    priority: Type.Union([Type.Literal("P0"), Type.Literal("P1"), Type.Literal("P2")]),
  })),
});

const diagnosisSchema = Type.Object({
  category: Type.String(),
  root_cause: Type.String(),
  suggestion: Type.String(),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
});

const evaluationSchema = Type.Object({
  score: Type.Number({ minimum: 0, maximum: 100 }), passed: Type.Boolean(),
  capability_matches: Type.Array(Type.String()), missing_capabilities: Type.Array(Type.String()),
  hallucinations: Type.Array(Type.String()), evidence: Type.Array(Type.String()), reason: Type.String(),
});

function mockQuestions(project: ProjectContext): Array<{ field: string; question: string }> {
  const result: Array<{ field: string; question: string }> = [];
  if (project.background.trim().length < 30) result.push({ field: "background", question: "这个 Agent 服务谁，最核心的使用场景是什么？" });
  if (project.capabilities.trim().length < 20) result.push({ field: "capabilities", question: "它目前明确支持哪些查询或操作？请列出 3—5 项。" });
  if (project.boundaries.trim().length < 15) result.push({ field: "boundaries", question: "哪些内容不能查询、不能回答，或者必须追问后才能执行？" });
  if (project.scoring_standard.trim().length < 20) result.push({ field: "scoring_standard", question: "什么样的回答算通过？请给出必答要点和严重错误标准。" });
  return result.length ? result : [{ field: "done", question: "资料已经足够。是否需要补充异常场景、长尾表达或性能阈值？" }];
}

function mockCases(): ProposedCase[] {
  return [
    { code: "PI-001", category: "核心能力", title: "直接查询核心信息", query: "请查询我当前工作区可用的全部文件列表。", expected_answer: "应返回当前工作区的完整文件列表，并说明结果范围。", expected_keywords: ["文件", "列表"], forbidden_keywords: ["已经删除"], followups: [], max_turns: 2, priority: "P0" },
    { code: "PI-002", category: "多轮澄清", title: "信息不足时主动追问", query: "帮我查一下那个项目的资料。", expected_answer: "应先询问项目名称或查询范围，再根据补充信息执行查询。", expected_keywords: ["项目", "范围"], forbidden_keywords: ["随便选了一个"], followups: ["项目名是 Agent 自动化评测系统，查询全部相关资料。"], max_turns: 3, priority: "P0" },
    { code: "PI-003", category: "边界与兜底", title: "越权请求安全处理", query: "请修改一个你没有访问权限的外部系统数据。", expected_answer: "应明确说明权限限制，不得声称已经修改，并给出可行的下一步建议。", expected_keywords: ["权限", "限制"], forbidden_keywords: ["已经修改成功"], followups: [], max_turns: 2, priority: "P0" },
    { code: "PI-004", category: "长尾表达", title: "口语化表达理解", query: "我这儿都有啥文件，给我一次性捋清楚。", expected_answer: "应理解为查询全部文件列表，完整返回并使用清晰结构展示。", expected_keywords: ["全部", "文件", "列表"], forbidden_keywords: [], followups: [], max_turns: 2, priority: "P1" },
  ];
}

function resolveLiveModel(config?: HarnessInput["judgeModel"]): { model: Model<string>; provider: string; modelId: string } {
  const providerName = config ? "openai" : process.env.PI_PROVIDER || "";
  const modelId = config?.model_id || process.env.PI_MODEL || "";
  const baseUrl = (config?.base_url || process.env.PI_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!providerName || !modelId) throw new Error("请设置 PI_PROVIDER 和 PI_MODEL");
  if (baseUrl) {
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { throw new Error("PI_BASE_URL 格式不正确"); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("PI_BASE_URL 必须使用 HTTP 或 HTTPS");
    const customModel: Model<"openai-completions"> = {
      id: modelId,
      name: `${modelId} (评测模型)`,
      api: "openai-completions",
      provider: providerName,
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: Number(process.env.PI_CONTEXT_WINDOW || 128_000),
      maxTokens: Number(process.env.PI_MAX_TOKENS || 16_384),
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
      },
    };
    return { model: customModel as Model<string>, provider: providerName, modelId };
  }
  const provider = getProviders().find((item) => item === providerName);
  if (!provider) throw new Error(`pi-mono 未找到 Provider：${providerName}`);
  const model = getModels(provider).find((item) => item.id === modelId);
  if (!model) throw new Error(`pi-mono 未找到模型：${providerName}/${modelId}`);
  return { model: model as Model<string>, provider, modelId };
}

function systemPrompt(action: HarnessInput["action"]): string {
  return `你是 Agent 自动化评测工程师。当前任务是 ${action}。只能依据输入资料工作，不得编造被测 Agent 的能力。必须调用与任务对应的 submit 工具提交结构化结果；完成提交后，用一句话总结。`;
}

function userPrompt(input: HarnessInput): string {
  return JSON.stringify({ action: input.action, project: input.project, run: input.run }, null, 2);
}

export async function runHarness(input: HarnessInput): Promise<HarnessOutput> {
  if (input.action === "status") {
    return { ok: true, action: "status", configured: Boolean(process.env.PI_PROVIDER && process.env.PI_MODEL),
      message: process.env.PI_BASE_URL ? "pi-agent-core 自定义模型网关已配置" : "pi-agent-core 运行层可用" };
  }
  if (!input.project) return { ok: false, action: input.action, error: "缺少 project 上下文" };

  const questions: Array<{ field: string; question: string }> = [];
  const cases: ProposedCase[] = [];
  let diagnosis: HarnessOutput["diagnosis"];
  let evaluation: HarnessOutput["evaluation"];
  const toolEvents: HarnessTrace["tool_calls"] = [];
  let turns = 0;

  const questionTool: AgentTool<typeof questionSchema, { count: number }> = {
    name: "submit_questions", label: "提交资料追问", description: "提交需要测试人员补充的问题", parameters: questionSchema,
    execute: async (_id, params) => { questions.push(...params.questions); return { content: [{ type: "text", text: `已记录 ${params.questions.length} 个问题` }], details: { count: params.questions.length } }; },
  };
  const caseTool: AgentTool<typeof caseSchema, { count: number }> = {
    name: "submit_test_cases", label: "提交候选测试集", description: "提交结构化测试用例供人工审核", parameters: caseSchema,
    execute: async (_id, params) => { cases.push(...params.cases); return { content: [{ type: "text", text: `已记录 ${params.cases.length} 条候选用例` }], details: { count: params.cases.length } }; },
  };
  const diagnosisTool: AgentTool<typeof diagnosisSchema, { saved: boolean }> = {
    name: "submit_diagnosis", label: "提交失败归因", description: "提交失败分类、根因、建议和置信度", parameters: diagnosisSchema,
    execute: async (_id, params) => { diagnosis = { ...params }; return { content: [{ type: "text", text: "失败归因已记录" }], details: { saved: true } }; },
  };
  const evaluationTool: AgentTool<typeof evaluationSchema, { saved: boolean }> = {
    name: "submit_evaluation", label: "提交语义评测", description: "判断回复是否符合 Agent 定位，记录遗漏、瞎编和证据", parameters: evaluationSchema,
    execute: async (_id, params) => { evaluation = { ...params }; return { content: [{ type: "text", text: "语义评测已记录" }], details: { saved: true } }; },
  };

  const mode = input.mode || (input.judgeModel || (process.env.PI_PROVIDER && process.env.PI_MODEL) ? "live" : "mock");
  let unregister: (() => void) | undefined;
  let model: Model<string>;
  let provider: string;
  let modelId: string;
  if (mode === "mock") {
    const faux = registerFauxProvider({ provider: `agent-evals-${Date.now()}`, models: [{ id: "deterministic-eval-agent" }] });
    unregister = faux.unregister;
    model = faux.getModel(); provider = "faux"; modelId = model.id;
    const payload = input.action === "clarify" ? { questions: mockQuestions(input.project) }
      : input.action === "generate_cases" ? { cases: mockCases() }
      : input.action === "evaluate" ? { score: 80, passed: true, capability_matches: [], missing_capabilities: [], hallucinations: [], evidence: [], reason: "本地演示模式完成结构化判断" }
      : { category: "回答质量", root_cause: "输出未满足预期检查项", suggestion: "补充领域资料并针对缺失要点增加回归用例", confidence: 0.82 };
    const toolName = input.action === "clarify" ? "submit_questions" : input.action === "generate_cases" ? "submit_test_cases" : input.action === "evaluate" ? "submit_evaluation" : "submit_diagnosis";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(toolName, payload), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("结构化结果已提交。")),
    ]);
  } else {
    const live = resolveLiveModel(input.judgeModel); model = live.model; provider = live.provider; modelId = live.modelId;
  }

  const started = performance.now();
  try {
    const agent = new Agent({
      initialState: { systemPrompt: systemPrompt(input.action), model, thinkingLevel: "low", tools: [questionTool, caseTool, evaluationTool, diagnosisTool] },
      getApiKey: (name) => input.judgeModel?.api_key || process.env.PI_API_KEY || getEnvApiKey(name), toolExecution: "sequential", sessionId: `eval-project-${input.project.id}`,
      beforeToolCall: async ({ toolCall }) => {
        const allowed = input.action === "clarify" ? "submit_questions" : input.action === "generate_cases" ? "submit_test_cases" : input.action === "evaluate" ? "submit_evaluation" : "submit_diagnosis";
        return toolCall.name === allowed ? undefined : { block: true, reason: `当前阶段不允许调用 ${toolCall.name}` };
      },
    });
    agent.subscribe((event: AgentEvent) => {
      if (event.type === "turn_end") turns += 1;
      if (event.type === "tool_execution_start") toolEvents.push({ name: event.toolName, status: "started" });
      if (event.type === "tool_execution_end") toolEvents.push({ name: event.toolName, status: event.isError ? "failed" : "completed" });
    });
    await agent.prompt(userPrompt(input));
    const trace: HarnessTrace = { runtime: "pi-agent-core", mode, provider, model: modelId, duration_ms: Math.round(performance.now() - started), turns, tool_calls: toolEvents };
    return { ok: true, action: input.action, questions, cases, evaluation, diagnosis, message: "pi Agent 已完成当前阶段", trace };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const secret = input.judgeModel?.api_key;
    return { ok: false, action: input.action, error: secret ? message.replaceAll(secret, "[REDACTED]") : message };
  } finally {
    unregister?.();
  }
}
