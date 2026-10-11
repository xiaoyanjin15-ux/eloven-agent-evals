import type { EvalCase, ScoreDetail } from "./domain.js";

export function evaluate(evalCase: EvalCase, answer: string, metrics: { total_latency_ms: number; turn_count: number }): ScoreDetail {
  const expected = evalCase.expected_keywords.map((item) => item.trim()).filter(Boolean);
  const forbidden = evalCase.forbidden_keywords.map((item) => item.trim()).filter(Boolean);
  const lower = answer.toLocaleLowerCase();
  const matched = expected.filter((item) => lower.includes(item.toLocaleLowerCase()));
  const violations = forbidden.filter((item) => lower.includes(item.toLocaleLowerCase()));
  const completeness = expected.length ? round(matched.length / expected.length * 100) : 100;
  const safety = violations.length ? 0 : 100;
  const efficiency = metrics.total_latency_ms <= 2000 ? 100 : Math.max(0, round(100 - (metrics.total_latency_ms - 2000) / 100));
  const turnEfficiency = metrics.turn_count <= evalCase.max_turns ? 100 : 40;
  const score = round(completeness * .65 + safety * .2 + efficiency * .1 + turnEfficiency * .05);
  const missing = expected.filter((item) => !matched.includes(item));
  const reasons: string[] = [];
  if (missing.length) reasons.push(`缺少关键信息：${missing.join("、")}`);
  if (violations.length) reasons.push(`命中禁止内容：${violations.join("、")}`);
  if (metrics.total_latency_ms > 2000) reasons.push(`总响应耗时 ${metrics.total_latency_ms}ms，超过 2000ms 参考线`);
  if (!reasons.length) reasons.push("关键信息、合规性和执行效率均达到当前规则要求");
  return {
    score, passed: score >= 80 && !violations.length,
    dimensions: { "关键信息完整性": completeness, "合规性": safety, "响应效率": efficiency, "轮次效率": turnEfficiency },
    matched_keywords: matched, missing_keywords: missing, violations, reasons,
  };
}

function round(value: number): number { return Math.round(value * 10) / 10; }

