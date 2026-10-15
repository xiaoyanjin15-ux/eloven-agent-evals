import assert from "node:assert/strict";
import test from "node:test";
import { evaluateProcess, normalizeTrace, sanitize, validateExpectations } from "./agent-traces.js";
import { fetchLangfuseTrace } from "./langfuse.js";
const obs = (id: string, name: string, parent: string | null, extra = {}) => ({ id, traceId: "trace-1", name, parentObservationId: parent,
  startTime: "2026-09-14T01:00:00Z", endTime: "2026-09-14T01:00:01Z", input: "{}", output: "{}", ...extra });
const sample = () => [obs("root", "chat", null, { input: "裁剪前4秒", output: "已输出裁剪视频", userId: "user-1", sessionId: "session-1" }),
  obs("step", "agent.step", "root"), obs("model", "model.invoke", "step", { type: "GENERATION", model: "deepseek" }),
  obs("trim", "video_trim", "step", { input: '{"arguments":{"startTime":0,"endTime":4}}', output: '{"success":true}' })];

test("forbidden tools fail with execution evidence, incomplete absence remains review", () => {
  const expectations = validateExpectations({ tools: [], forbidden_tools: ["video_trim"], scoring_standard: "禁止编辑", expected_trace: "只回答" });
  const result = evaluateProcess(normalizeTrace("trace-1", sample()), expectations);
  assert.equal(result.status, "fail");
  assert.deepEqual(result.checks.find(check => check.title === "禁止工具：video_trim")?.node_ids, ["trim"]);
  assert.equal(expectations.scoring_standard, "禁止编辑");
  const partial = normalizeTrace("trace-1", [obs("a", "chat", null, { endTime: null })]);
  assert.equal(evaluateProcess(partial, expectations).checks.find(check => check.title === "禁止工具：video_trim")?.status, "review");
  assert.throws(() => validateExpectations({ tools: [], forbidden_tools: "video_trim" }), /禁止工具/);
});
test("normalizes raw I/O, identities and actual model/tool nodes", () => {
  const trace = normalizeTrace("trace-1", sample().reverse());
  assert.equal(trace.input, "裁剪前4秒"); assert.equal(trace.user_id, "user-1"); assert.equal(trace.session_id, "session-1");
  assert.equal(trace.nodes.find(node => node.id === "trim")?.kind, "tool");
  assert.equal(trace.nodes.find(node => node.id === "model")?.model, "deepseek"); assert.deepEqual(trace.warnings, []);
  assert.equal(trace.nodes[0].id, "root");
});
test("summarizes wall-clock duration and estimates official model costs without TTFT", () => {
  const trace = normalizeTrace("trace-1", [
    obs("root", "chat", null, { startTime: "2026-09-14T01:00:00Z", endTime: "2026-09-14T01:00:05Z" }),
    obs("m1", "model.invoke", "root", { type: "GENERATION", model: "deepseek-v4-flash", startTime: "2026-09-14T01:00:01Z", endTime: "2026-09-14T01:00:03Z",
      usageDetails: { input: 100, output: 20, total: 120 } }),
    obs("m2", "model.invoke", "root", { type: "GENERATION", model: "claude-haiku-4-5", startTime: "2026-09-14T01:00:03Z", endTime: "2026-09-14T01:00:05Z",
      usage: { promptTokens: 80, completionTokens: 10, totalTokens: 90 } })
  ]);
  assert.equal(trace.summary.duration_ms, 5_000);
  assert.equal(trace.summary.model_calls, 2);
  assert.equal(trace.summary.input_tokens, 180);
  assert.equal(trace.summary.output_tokens, 30);
  assert.equal(trace.summary.total_tokens, 210);
  assert.ok(Math.abs((trace.summary.total_cost_usd || 0) - 0.000184) < 1e-12);
  assert.equal(trace.summary.cost_source, "estimated");
  assert.deepEqual(trace.summary.models.map(item => ({ model: item.model, calls: item.calls, total: item.total_tokens })), [
    { model: "deepseek-v4-flash", calls: 1, total: 120 },
    { model: "claude-haiku-4-5", calls: 1, total: 90 }
  ]);
  const recorded = normalizeTrace("trace-1", [obs("root", "model.invoke", null, { type: "GENERATION", model: "deepseek-v4-flash",
    usageDetails: { input: 100, output: 20 }, totalCost: 0.9 })]);
  assert.equal(recorded.summary.total_cost_usd, 0.9);
  assert.equal(recorded.summary.cost_source, "langfuse");
});
test("parses cache buckets and prices DeepSeek and Claude cache usage", () => {
  const trace = normalizeTrace("trace-1", [
    obs("root", "chat", null),
    obs("deepseek", "model.invoke", "root", { type: "GENERATION", model: "deepseek-v4-flash",
      usageDetails: { input: 25, output: 6, cache_read_input_tokens: 75, cache_creation_input_tokens: 0, total: 106 } }),
    obs("claude", "model.invoke", "root", { type: "GENERATION", model: "claude-haiku-4-5",
      usageDetails: { input: 20, output: 7, cache_read_input_tokens: 70, cache_creation_input_tokens: 10, total: 107 } })
  ]);
  assert.equal(trace.summary.input_tokens, 45);
  assert.equal(trace.summary.cache_read_input_tokens, 145);
  assert.equal(trace.summary.cache_write_input_tokens, 10);
  assert.equal(trace.summary.total_input_tokens, 200);
  assert.equal(trace.summary.total_tokens, 213);
  assert.ok(Math.abs((trace.summary.models[0].total_cost_usd || 0) - 0.00001515) < 1e-12);
  assert.ok(Math.abs((trace.summary.models[1].total_cost_usd || 0) - 0.0000745) < 1e-12);
});
test("does not double count providers whose input includes the cached subset", () => {
  const trace = normalizeTrace("trace-1", [obs("model", "model.invoke", null, { type: "GENERATION", model: "deepseek-v4-flash",
    usageDetails: { input: 100, output: 6, cache_read_input_tokens: 75, total: 106 } })]);
  assert.equal(trace.summary.input_tokens, 25);
  assert.equal(trace.summary.cache_read_input_tokens, 75);
  assert.equal(trace.summary.total_input_tokens, 100);
  assert.equal(trace.summary.total_tokens, 106);
});
test("rejects mixed traces, duplicate IDs, empty lists and cycles", () => {
  assert.throws(() => normalizeTrace("other", sample()), /不属于/);
  assert.throws(() => normalizeTrace("trace-1", [sample()[0], sample()[0]]), /重复/);
  assert.throws(() => normalizeTrace("trace-1", []), /没有找到/);
  assert.throws(() => normalizeTrace("trace-1", [obs("a", "x", "b"), obs("b", "y", "a")]), /循环/);
});
test("orphan, running and missing root I/O stay reviewable", () => {
  const trace = normalizeTrace("trace-1", [obs("a", "video_trim", "missing", { endTime: null, input: null })]);
  assert.ok(trace.warnings.length >= 3);
  assert.equal(evaluateProcess(trace, validateExpectations({ tools: [{ name: "missing" }] })).status, "review");
});
test("matching parameters never imply task completion", () => {
  const result = evaluateProcess(normalizeTrace("trace-1", sample()), validateExpectations({ tools: [{ name: "video_trim", parameters: { startTime: 0, endTime: 4 } }] }));
  assert.equal(result.checks.find(check => check.title === "工具：video_trim")?.status, "pass"); assert.equal(result.status, "review");
});
test("wrong parameters and missing tools fail with node evidence", () => {
  const result = evaluateProcess(normalizeTrace("trace-1", sample()), validateExpectations({ tools: [{ name: "video_trim", parameters: { endTime: 40 } }, { name: "video_overlay" }] }));
  assert.equal(result.status, "fail"); assert.deepEqual(result.checks.find(check => check.title === "工具：video_trim")?.node_ids, ["trim"]);
});
test("checks ordered executions, not merely tool membership", () => {
  const trace = normalizeTrace("trace-1", [...sample(), obs("overlay", "video_overlay", "step", { startTime: "2026-09-14T01:00:02Z" })]);
  assert.equal(evaluateProcess(trace, validateExpectations({ ordered: true, tools: [{ name: "video_overlay" }, { name: "video_trim" }] })).status, "fail");
});
test("repeated requirements consume distinct executions", () => {
  assert.equal(evaluateProcess(normalizeTrace("trace-1", sample()), validateExpectations({ tools: [{ name: "video_trim" }, { name: "video_trim" }] })).status, "fail");
});
test("legacy named tool spans can be checked without counting model proposals", () => {
  const trace = normalizeTrace("trace-1", [...sample(), obs("read", "read", "step", { type: "SPAN", input: { path: "file.txt" } })]);
  const result = evaluateProcess(trace, validateExpectations({ tools: [{ name: "read", parameters: { path: "file.txt" } }, { name: "bash" }] }));
  assert.equal(result.checks.find(check => check.title === "工具：read")?.status, "pass");
  assert.equal(result.checks.find(check => check.title === "工具：bash")?.status, "fail");
});
test("tool errors require recovery review", () => {
  const observations = sample(); observations[3] = { ...observations[3], output: '{"success":false}' };
  assert.equal(evaluateProcess(normalizeTrace("trace-1", observations), validateExpectations({ tools: [{ name: "video_trim" }] })).checks[1].status, "review");
});
test("malformed expectations rejected and sensitive evidence redacted", () => {
  assert.throws(() => validateExpectations({ tools: "video_trim" }), /数组/);
  assert.throws(() => validateExpectations({ tools: [{ name: "x", parameters: [] }] }), /对象/);
  const safe = JSON.stringify(sanitize({ api_key: "private", child: { content: "Bearer sensitive-token data:image/png;base64,YWJjZA==" } }));
  assert.ok(!safe.includes("private")); assert.ok(!safe.includes("sensitive-token")); assert.ok(!safe.includes("YWJjZA"));
});
test("Langfuse v2 reads I/O, cursor pages and safe auth errors; v1 is explicit", async () => {
  const previous = { ...process.env };
  Object.assign(process.env, { LANGFUSE_BASE_URL: "https://langfuse.example.test", LANGFUSE_PUBLIC_KEY: "test-public", LANGFUSE_SECRET_KEY: "test-secret", LANGFUSE_API_VERSION: "v2" });
  try {
    const urls: string[] = [];
    const fake = (async (url: string | URL | Request, options?: RequestInit) => {
      urls.push(String(url)); assert.equal(new Headers(options?.headers).get("Authorization"), `Basic ${Buffer.from("test-public:test-secret").toString("base64")}`);
      return Response.json({ data: urls.length === 1 ? sample().slice(0, 2) : sample().slice(2), meta: { cursor: urls.length === 1 ? "next" : null } });
    }) as typeof fetch;
    assert.equal((await fetchLangfuseTrace("trace-1", undefined, undefined, fake)).nodes.length, 4);
    assert.equal(urls.length, 2); const fields = new URL(urls[0]).searchParams.get("fields") || "";
    assert.ok(fields.includes("io")); assert.ok(fields.includes("usage")); assert.ok(!fields.includes("metrics"));
    assert.equal(new URL(urls[1]).searchParams.get("cursor"), "next");
    await assert.rejects(fetchLangfuseTrace("trace-1", undefined, undefined, (async () => new Response("secret", { status: 401 })) as typeof fetch), /认证失败/);
    await assert.rejects(fetchLangfuseTrace("trace-1", undefined, undefined, (async () => new Response("<html>")) as typeof fetch), /不是 JSON/);
    process.env.LANGFUSE_API_VERSION = "v1";
    assert.equal((await fetchLangfuseTrace("trace-1", undefined, undefined, (async () => Response.json({ id: "trace-1", observations: sample() })) as typeof fetch)).nodes.length, 4);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
