export type CostSource = "langfuse" | "estimated" | "mixed" | null;
export interface TraceUsage {
  input_tokens: number | null; cache_read_input_tokens: number | null; cache_write_input_tokens: number | null;
  total_input_tokens: number | null; output_tokens: number | null; total_tokens: number | null;
  total_cost_usd: number | null; cost_source: CostSource; cost_note: string;
}
export interface TraceNode {
  id: string; parent_id: string | null; name: string; kind: "model" | "tool" | "step";
  model: string; start_time: string; end_time: string; duration_ms: number | null;
  input: unknown; output: unknown; level: string; status_message: string;
  user_id: string; session_id: string; metadata: unknown; usage: TraceUsage;
}
export interface TraceModelUsage extends TraceUsage { model: string; calls: number }
export interface TraceSummary extends TraceUsage {
  duration_ms: number | null; model_calls: number; models: TraceModelUsage[];
}
export interface AgentTrace {
  trace_id: string; name: string; user_id: string; session_id: string;
  input: unknown; output: unknown; nodes: TraceNode[]; warnings: string[]; summary: TraceSummary;
}
export interface TraceExpectations {
  tools: Array<{ name: string; parameters?: Record<string, unknown> }>;
  ordered: boolean; expected_answer: string;
  forbidden_tools?: string[];
  expected_trace?: string;
  parameter_constraints?: string;
  scoring_standard?: string;
  case_query?: string;
  evaluation_set_id?: number;
}
export interface ProcessCheck {
  title: string; status: "pass" | "fail" | "review"; reason: string; node_ids: string[];
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function parseIo(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}
// Persist only sanitized evidence, never authentication values or image payloads.
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 25) return "[嵌套过深，已省略]";
  if (typeof value === "string") return value
    .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, "[图片或文件数据已省略]")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}/g, "[密钥已隐藏]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [已隐藏]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT 已隐藏]");
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /authorization|api.?key|secret|password|access.?token|refresh.?token|cookie/i.test(key) ? "[已隐藏]" : sanitize(item, depth + 1)]));
  return value ?? null;
}
export const OFFICIAL_MODEL_PRICING = {
  deepseek_flash: { currency: "USD", unit_tokens: 1_000_000,
    off_peak: { input_cache_hit: 0.003, input_cache_miss: 0.15, output: 0.60 },
    peak: { input_cache_hit: 0.006, input_cache_miss: 0.30, output: 1.20 },
    note: "DeepSeek V4.1 Flash；deepseek-v4-flash 为兼容别名" },
  claude_haiku_4_5: { currency: "USD", unit_tokens: 1_000_000, input: 1.00, output: 5.00,
    cache_read: 0.10, cache_write_5m: 1.25, cache_write_1h: 2.00, note: "Claude Haiku 4.5 标准 API 价格" }
} as const;
function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function firstNumeric(...values: unknown[]): number | null {
  for (const value of values) { const parsed = numeric(value); if (parsed !== null) return parsed; }
  return null;
}
function estimatedCost(modelValue: unknown, startValue: unknown, input: number | null, cacheRead: number | null,
  cacheWrite: number | null, output: number | null) {
  if (input === null && cacheRead === null && cacheWrite === null && output === null) return null;
  const model = String(modelValue || "").toLowerCase();
  if (/^(deepseek-v4-flash|deepseek-v4\.1-flash|deepseek-flash)$/.test(model)) {
    const started = new Date(String(startValue || ""));
    const day = started.getUTCDay(), hour = started.getUTCHours() + started.getUTCMinutes() / 60;
    const peak = Number.isFinite(+started) && day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    const price = peak ? OFFICIAL_MODEL_PRICING.deepseek_flash.peak : OFFICIAL_MODEL_PRICING.deepseek_flash.off_peak;
    return { value: (((input || 0) + (cacheWrite || 0)) * price.input_cache_miss
        + (cacheRead || 0) * price.input_cache_hit + (output || 0) * price.output) / 1_000_000,
      note: "DeepSeek 官方" + (peak ? "高峰" : "非高峰") + "单价估算；缓存写入按未命中计，法定节假日需以账单为准" };
  }
  if (/^(claude-haiku-4-5(?:-\d+)?)$/.test(model)) {
    const price = OFFICIAL_MODEL_PRICING.claude_haiku_4_5;
    return { value: ((input || 0) * price.input + (cacheRead || 0) * price.cache_read
        + (cacheWrite || 0) * price.cache_write_5m + (output || 0) * price.output) / 1_000_000,
      note: "Claude Haiku 4.5 官方标准价估算；缓存写入按 5 分钟 TTL 计" };
  }
  return null;
}
function observationUsage(item: Record<string, unknown>): TraceUsage {
  const details = record(item.usageDetails);
  const legacy = record(item.usage);
  const costDetails = record(item.costDetails);
  const rawInput = firstNumeric(details.input, details.prompt, details.input_tokens, item.inputUsage, legacy.input, legacy.promptTokens, legacy.prompt_tokens);
  const cacheRead = firstNumeric(details.cache_read_input_tokens, details.cacheRead, details.cache_read,
    details.prompt_cache_hit_tokens, record(details.input_tokens_details).cached_tokens,
    legacy.cacheRead, legacy.cache_read_input_tokens, legacy.prompt_cache_hit_tokens, record(legacy.prompt_tokens_details).cached_tokens);
  const cacheWrite = firstNumeric(details.cache_creation_input_tokens, details.cacheWrite, details.cache_write,
    legacy.cacheWrite, legacy.cache_creation_input_tokens);
  const output = firstNumeric(item.outputUsage, details.output, details.completion, details.output_tokens, legacy.output, legacy.completionTokens, legacy.completion_tokens);
  const reportedTotal = firstNumeric(item.totalUsage, details.total, details.total_tokens, legacy.total, legacy.totalTokens, legacy.total_tokens);
  // The Agent reports mutually exclusive input/cache buckets. Other providers may
  // report total input plus a cached subset; use the total to avoid double counting.
  const buckets = (rawInput || 0) + (cacheRead || 0) + (cacheWrite || 0) + (output || 0);
  const input = rawInput !== null && reportedTotal !== null && buckets > reportedTotal
    ? Math.max(0, rawInput - (cacheRead || 0) - (cacheWrite || 0)) : rawInput;
  const totalInput = input === null && cacheRead === null && cacheWrite === null ? null
    : (input || 0) + (cacheRead || 0) + (cacheWrite || 0);
  const total = reportedTotal ?? (totalInput !== null && output !== null ? totalInput + output : null);
  const recordedCost = firstNumeric(item.totalCost, costDetails.total, costDetails.total_cost, item.calculatedTotalCost);
  const estimate = recordedCost === null ? estimatedCost(item.model, item.startTime, input, cacheRead, cacheWrite, output) : null;
  return { input_tokens: input, cache_read_input_tokens: cacheRead, cache_write_input_tokens: cacheWrite,
    total_input_tokens: totalInput, output_tokens: output, total_tokens: total,
    total_cost_usd: recordedCost ?? estimate?.value ?? null, cost_source: recordedCost !== null ? "langfuse" : estimate ? "estimated" : null,
    cost_note: recordedCost !== null ? "Langfuse 记录值" : estimate?.note || "" };
}
function sumRecorded(values: Array<number | null>): number | null {
  const recorded = values.filter((value): value is number => value !== null);
  return recorded.length ? recorded.reduce((sum, value) => sum + value, 0) : null;
}
function aggregateCostSource(items: TraceNode[]): CostSource {
  const sources = new Set(items.map(node => node.usage.cost_source).filter((value): value is Exclude<CostSource, null> => value !== null));
  return sources.size > 1 ? "mixed" : sources.values().next().value || null;
}
export function summarizeTrace(nodes: TraceNode[]): TraceSummary {
  const complete = nodes.map(node => ({ start: Date.parse(node.start_time), end: Date.parse(node.end_time) }))
    .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end >= item.start);
  const duration = complete.length ? Math.max(...complete.map(item => item.end)) - Math.min(...complete.map(item => item.start)) : null;
  const modelNodes = nodes.filter(node => node.kind === "model");
  const groups = new Map<string, TraceNode[]>();
  for (const node of modelNodes) {
    const model = node.model || "未记录模型";
    groups.set(model, [...(groups.get(model) || []), node]);
  }
  const summarize = (items: TraceNode[]) => ({
    input_tokens: sumRecorded(items.map(node => node.usage.input_tokens)),
    cache_read_input_tokens: sumRecorded(items.map(node => node.usage.cache_read_input_tokens)),
    cache_write_input_tokens: sumRecorded(items.map(node => node.usage.cache_write_input_tokens)),
    total_input_tokens: sumRecorded(items.map(node => node.usage.total_input_tokens)),
    output_tokens: sumRecorded(items.map(node => node.usage.output_tokens)),
    total_tokens: sumRecorded(items.map(node => node.usage.total_tokens)),
    total_cost_usd: sumRecorded(items.map(node => node.usage.total_cost_usd)),
    cost_source: aggregateCostSource(items),
    cost_note: [...new Set(items.map(node => node.usage.cost_note).filter(Boolean))].join("；")
  });
  return { duration_ms: duration, model_calls: modelNodes.length, ...summarize(modelNodes),
    models: [...groups].map(([model, items]) => ({ model, calls: items.length, ...summarize(items) })) };
}
export function normalizeTrace(traceId: string, observations: unknown[], envelope: unknown = {}): AgentTrace {
  if (!traceId || !observations.length) throw new Error("没有找到该 Trace 的调用节点；请确认 ID、时间范围，或稍后重新读取。");
  const warnings = new Set<string>();
  const ids = new Set<string>();
  const nodes: TraceNode[] = observations.map<TraceNode>(value => {
    const item = record(value);
    const id = String(item.id || "");
    if (!id || ids.has(id)) throw new Error("Trace 中存在空节点 ID 或重复节点 ID");
    ids.add(id);
    if (item.traceId && item.traceId !== traceId) throw new Error("返回的节点不属于指定 Trace，已停止导入");
    const name = String(item.name || "未命名节点");
    const type = String(item.type || "").toUpperCase();
    const start = String(item.startTime || ""), end = String(item.endTime || "");
    const elapsed = Date.parse(end) - Date.parse(start);
    if (!end && type !== "EVENT") warnings.add("有节点尚未结束，当前链路可能仍在执行；请稍后重新读取。");
    return { id, parent_id: item.parentObservationId ? String(item.parentObservationId) : null, name,
      kind: type === "GENERATION" || type === "LLM" || name === "model.invoke" ? "model"
        : type === "TOOL" || /^video_/.test(name) ? "tool" : "step",
      model: String(item.model || ""), start_time: start, end_time: end,
      duration_ms: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
      input: sanitize(parseIo(item.input)), output: sanitize(parseIo(item.output)),
      metadata: sanitize(parseIo(item.metadata)), level: String(item.level || "DEFAULT"),
      status_message: String(sanitize(item.statusMessage || "")), usage: observationUsage(item),
      user_id: String(item.userId || ""), session_id: String(item.sessionId || "") };
  });
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) {
    if ((node.kind === "tool" || node.kind === "model") && (node.input == null || node.output == null)) warnings.add("部分模型或工具的输入输出未记录，相关检查需要补充证据。");
    if (node.parent_id && !byId.has(node.parent_id)) warnings.add("部分父节点未返回，链路可能不完整。");
    const seen = new Set([node.id]);
    let parent = node.parent_id;
    while (parent && byId.has(parent)) {
      if (seen.has(parent)) throw new Error("Trace 父子关系存在循环，不能构建调用树");
      seen.add(parent); parent = byId.get(parent)!.parent_id;
    }
  }
  const depths = new Map<string, number>();
  function depth(node: TraceNode): number {
    if (depths.has(node.id)) return depths.get(node.id)!;
    let count = 0, parent = node.parent_id;
    while (parent && byId.has(parent)) { count++; parent = byId.get(parent)!.parent_id; }
    depths.set(node.id, count); return count;
  }
  // Equal timestamps are common in exporters: always show enclosing nodes first.
  nodes.sort((a, b) => (Date.parse(a.start_time) || 0) - (Date.parse(b.start_time) || 0) || depth(a) - depth(b));
  const roots = nodes.filter(node => !node.parent_id);
  if (roots.length !== 1) warnings.add("没有唯一任务根节点，用户提问与最终回复需要核验。");
  const root = roots[0] || nodes[0];
  const outer = record(envelope);
  if ((outer.input ?? root.input) == null || (outer.output ?? root.output) == null) warnings.add("任务的用户输入或最终输出未记录，不能完整评测任务完成情况。");
  return { trace_id: traceId, name: String(outer.name || root.name),
    user_id: String(outer.userId || nodes.find(node => node.user_id)?.user_id || ""),
    session_id: String(outer.sessionId || nodes.find(node => node.session_id)?.session_id || ""),
    input: sanitize(parseIo(outer.input ?? root.input)), output: sanitize(parseIo(outer.output ?? root.output)),
    nodes, warnings: [...warnings], summary: summarizeTrace(nodes) };
}
function subset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((item, i) => subset(item, actual[i]));
  if (expected && typeof expected === "object") return Object.entries(record(expected)).every(([key, value]) =>
    Object.hasOwn(record(actual), key) && subset(value, record(actual)[key]));
  return Object.is(expected, actual);
}
export function validateExpectations(value: unknown): TraceExpectations {
  const item = record(value);
  if (!Array.isArray(item.tools) || item.tools.length > 100) throw new Error("预期工具必须是数组，最多 100 项");
  const tools = item.tools.map(value => {
    const tool = record(value);
    if (typeof tool.name !== "string" || !tool.name.trim()) throw new Error("每个预期工具都需要 name");
    if (tool.parameters !== undefined && (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters))) throw new Error("parameters 必须是 JSON 对象");
    return { name: tool.name.trim(), ...(tool.parameters === undefined ? {} : { parameters: record(tool.parameters) }) };
  });
  if (item.forbidden_tools !== undefined && (!Array.isArray(item.forbidden_tools) || item.forbidden_tools.length > 100 || item.forbidden_tools.some(name => typeof name !== "string" || !name.trim()))) throw new Error("禁止工具必须是工具名称数组，最多 100 项");
  return { tools, ordered: item.ordered === true, expected_answer: String(item.expected_answer || "").trim(),
    forbidden_tools: (item.forbidden_tools as string[] || []).map(name => name.trim()),
    expected_trace: String(item.expected_trace || "").trim(), parameter_constraints: String(item.parameter_constraints || "").trim(),
    scoring_standard: String(item.scoring_standard || "").trim(), case_query: String(item.case_query || ""),
    evaluation_set_id: Number(item.evaluation_set_id || 0) };
}
export function evaluateProcess(trace: AgentTrace, expectations: TraceExpectations): { status: "pass" | "fail" | "review"; checks: ProcessCheck[] } {
  const checks: ProcessCheck[] = [];
  const incomplete = trace.warnings.length > 0;
  checks.push({ title: "链路完整性", status: incomplete ? "review" : "pass", reason: incomplete ? trace.warnings.join(" ") : "返回节点的父子关系完整，节点均已结束。", node_ids: [] });
  const errors = trace.nodes.filter(node => node.level.toUpperCase() === "ERROR" || record(node.output).isError === true || record(node.output).success === false);
  checks.push({ title: "执行异常", status: errors.length ? "review" : "pass", reason: errors.length ? "发现执行异常，需要结合后续调用判断是否成功恢复。" : "已记录节点中未发现明确的错误标记。", node_ids: errors.map(node => node.id) });
  // Legacy integrations may export tools as plain named SPANs. Explicit test
  // requirements may identify such spans, but never count a model's tool-call
  // proposal alone as an actual tool execution.
  const requiredNames = new Set([...expectations.tools.map(tool => tool.name), ...(expectations.forbidden_tools || [])]);
  const tools = trace.nodes.filter(node => node.kind === "tool" || (node.kind === "step" && requiredNames.has(node.name)));
  let cursor = 0;
  const used = new Set<string>();
  for (const name of expectations.forbidden_tools || []) {
    const found = tools.filter(node => node.name === name);
    checks.push({ title: `禁止工具：${name}`, status: found.length ? "fail" : incomplete ? "review" : "pass",
      reason: found.length ? "实际执行了明确禁止的工具。" : incomplete ? "链路不完整，无法确认禁止工具未执行。" : "未发现禁止工具的执行节点。", node_ids: found.map(node => node.id) });
  }
  for (const expected of expectations.tools) {
    const candidates = tools.filter((node, i) => node.name === expected.name && !used.has(node.id) && (!expectations.ordered || i >= cursor));
    const matching = candidates.find(node => {
      const input = record(node.input);
      return expected.parameters === undefined || subset(expected.parameters, input.arguments ?? input.parameters ?? input);
    });
    const found = matching || candidates[0];
    if (found) { used.add(found.id); cursor = tools.indexOf(found) + 1; }
    checks.push({ title: `工具：${expected.name}`, status: matching ? "pass" : incomplete ? "review" : "fail",
      reason: matching ? "找到对应工具执行节点，已填写的参数匹配。" : found ? "工具被调用，但参数不符合预期。" : "没有找到符合要求的工具执行节点或调用顺序。",
      node_ids: found ? [found.id] : [] });
  }
  if (!expectations.tools.length) checks.push({ title: "工具与参数要求", status: "review", reason: "未设置预期工具；不判断工具选择是否正确。", node_ids: [] });
  checks.push({ title: "任务完成与回答", status: "review", reason: expectations.expected_answer ? "已保存预期结果，需要模型评判或人工核验；文件产物还需单独验证。" : "请填写预期结果，不能仅凭调用成功判断任务完成。", node_ids: [] });
  return { status: checks.some(check => check.status === "fail") ? "fail" : checks.some(check => check.status === "review") ? "review" : "pass", checks };
}
