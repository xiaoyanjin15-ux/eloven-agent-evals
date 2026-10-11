import { normalizeTrace, record, type AgentTrace } from "./agent-traces.js";

export function langfuseStatus() {
  return { configured: Boolean((process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST) && process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY),
    api_version: process.env.LANGFUSE_API_VERSION === "v1" ? "v1" : "v2" };
}
export async function fetchLangfuseTrace(traceId: string, from?: string, to?: string, fetcher: typeof fetch = fetch): Promise<AgentTrace> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(traceId)) throw new Error("请填写 Trace ID，而不是整段网页地址");
  if (!langfuseStatus().configured) throw new Error("请在本地 .env 配置 LANGFUSE_BASE_URL、LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY，然后重启服务。");
  const base = new URL(process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || "");
  if (base.username || base.password || base.search || base.hash || (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) throw new Error("Langfuse 地址需使用 HTTPS；本机部署可使用 HTTP。请勿在地址中包含密钥。");
  const prefix = base.href.replace(/\/+$/, "").replace(/\/api\/public$/, "");
  const headers = { Authorization: `Basic ${Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64")}` };
  async function get(path: string): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await fetcher(`${prefix}/api/public/${path}`, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error("读取 Langfuse 失败：连接异常或超时，请检查后台配置和网络。"); }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Langfuse 认证失败：检查项目密钥和所属区域地址。" : `读取 Langfuse 失败：HTTP ${response.status}。`);
    try { return record(await response.json()); } catch { throw new Error("Langfuse 返回的不是 JSON，请检查服务地址。"); }
  }
  if (langfuseStatus().api_version === "v1") {
    const body = await get(`traces/${encodeURIComponent(traceId)}`);
    if (body.id && body.id !== traceId) throw new Error("Langfuse 返回了不同的 Trace ID");
    return normalizeTrace(traceId, Array.isArray(body.observations) ? body.observations : [], body);
  }
  const fromTime = new Date(from || Date.now() - 30 * 86_400_000), toTime = new Date(to || Date.now() + 60_000);
  if (!Number.isFinite(+fromTime) || !Number.isFinite(+toTime) || +fromTime >= +toTime) throw new Error("读取时间范围不正确");
  const params = new URLSearchParams({ traceId, fields: "core,basic,io,metadata,model,usage,trace_context", limit: "1000", fromStartTime: fromTime.toISOString(), toStartTime: toTime.toISOString() });
  const observations: unknown[] = [], cursors = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const body = await get(`v2/observations?${params}`);
    if (!Array.isArray(body.data)) throw new Error("Langfuse 节点列表格式不正确");
    observations.push(...body.data);
    const cursor = record(body.meta).cursor;
    if (!cursor) return normalizeTrace(traceId, observations);
    if (typeof cursor !== "string" || cursors.has(cursor)) throw new Error("Langfuse 分页异常，未保存不完整链路");
    cursors.add(cursor); params.set("cursor", cursor);
  }
  throw new Error("Trace 超过读取上限，未保存不完整链路");
}
