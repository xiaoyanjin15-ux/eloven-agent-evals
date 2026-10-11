import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_FILE = join(ROOT, "data", "judge-models.local.json");

// The catalog is code; the shared gateway and secret stay in the ignored .env file.
export const BUILTIN_JUDGE_MODEL_IDS = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "jinxiaoyan-gpt-5.5-yjs-ym",
  "jinxiaoyan-claude-opus-4.8-yjs-ym",
  "jinxiaoyan-claude-sonnet-4.6-yjs-ym",
  "jinxiaoyan-claude-haiku-4.5-yjs-ym",
] as const;

export interface JudgeModel {
  id: string;
  project_id: number;
  name: string;
  base_url: string;
  model_id: string;
  api_key: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
  source?: "builtin" | "custom";
}

export type PublicJudgeModel = Omit<JudgeModel, "api_key" | "source"> & { has_api_key: boolean; source: "builtin" | "custom" };
export type JudgeModelInput = { name?: unknown; base_url?: unknown; model_id?: unknown; api_key?: unknown; is_default?: unknown };
export type SharedJudgeConnection = { base_url: string; api_key: string; model_id?: string };
type StoredModels = { custom: JudgeModel[]; defaults: Record<string, string> };

function publicModel(model: JudgeModel, defaultId?: string): PublicJudgeModel {
  const { api_key, source, ...rest } = model;
  return { ...rest, is_default: model.id === defaultId, source: source || "custom", has_api_key: Boolean(api_key) };
}

function validUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("模型接口 URL 格式不正确"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("模型接口 URL 须为不含账号、参数的 HTTP(S) 地址");
  }
  return url.toString().replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

function environmentConnection(): SharedJudgeConnection | null {
  const api_key = process.env.PI_API_KEY || process.env.OPENAI_API_KEY || "";
  const base_url = process.env.PI_BASE_URL || "";
  if (process.env.PI_PROVIDER !== "openai" || !api_key || !base_url) return null;
  return { api_key, base_url, model_id: process.env.PI_MODEL };
}

function builtinId(modelId: string): string {
  return `builtin-${createHash("sha256").update(modelId).digest("hex").slice(0, 24)}`;
}

export function createJudgeModelStore(filePath = process.env.JUDGE_MODELS_FILE || DEFAULT_FILE,
  shared: SharedJudgeConnection | null = environmentConnection()) {
  function read(): StoredModels {
    if (!existsSync(filePath)) return { custom: [], defaults: {} };
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    // Existing installations stored a plain array; keep their models and defaults.
    if (Array.isArray(parsed)) return { custom: parsed as JudgeModel[], defaults: {} };
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as StoredModels).custom)
      || !(parsed as StoredModels).defaults || typeof (parsed as StoredModels).defaults !== "object") {
      throw new Error("本地评测模型配置文件格式不正确");
    }
    return parsed as StoredModels;
  }
  function write(items: StoredModels): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(items, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, filePath);
  }
  function builtin(projectId: number): JudgeModel[] {
    if (!shared) return [];
    const base_url = validUrl(shared.base_url);
    const ids = [...new Set([...BUILTIN_JUDGE_MODEL_IDS, ...(shared.model_id ? [shared.model_id] : [])])];
    return ids.map(model_id => ({ id: builtinId(model_id), project_id: projectId, name: model_id, base_url,
      model_id, api_key: shared.api_key, is_default: false, created_at: "", updated_at: "", source: "builtin" }));
  }
  function defaultId(projectId: number, state: StoredModels, builtins = builtin(projectId)): string | undefined {
    const custom = state.custom.filter(item => item.project_id === projectId);
    const all = [...builtins, ...custom];
    const stored = state.defaults[String(projectId)];
    if (stored && all.some(item => item.id === stored)) return stored;
    return custom.find(item => item.is_default)?.id || builtins.find(item => item.model_id === shared?.model_id)?.id
      || builtins[0]?.id || custom[0]?.id;
  }
  function list(projectId: number): PublicJudgeModel[] {
    const state = read();
    const builtins = builtin(projectId);
    const chosen = defaultId(projectId, state, builtins);
    return [...builtins, ...state.custom.filter(item => item.project_id === projectId)].map(item => publicModel(item, chosen));
  }
  function get(projectId: number, id: string): JudgeModel {
    const state = read();
    const item = [...builtin(projectId), ...state.custom].find(value => value.project_id === projectId && value.id === id);
    if (!item) throw new Error("评测模型不存在或不属于当前项目");
    return { ...item, is_default: item.id === defaultId(projectId, state) };
  }
  function selected(projectId: number, id?: string): JudgeModel | undefined {
    if (id) return get(projectId, id);
    const state = read();
    const chosen = defaultId(projectId, state);
    return chosen ? get(projectId, chosen) : undefined;
  }
  function save(projectId: number, input: JudgeModelInput, id?: string): PublicJudgeModel {
    const state = read();
    const builtinModel = id && builtin(projectId).find(item => item.id === id);
    if (builtinModel) {
      if (input.is_default !== true || Object.keys(input).some(key => key !== "is_default"))
        throw new Error("内置模型由后台配置，只能设为默认；请在 .env 中修改连接参数");
      state.defaults[String(projectId)] = id!;
      write(state);
      return publicModel(builtinModel, id);
    }
    const current = id ? state.custom.find(item => item.project_id === projectId && item.id === id) : undefined;
    if (id && !current) throw new Error("评测模型不存在或不属于当前项目");
    const name = String(input.name ?? current?.name ?? "").trim();
    const base_url = validUrl(String(input.base_url ?? current?.base_url ?? "").trim());
    const model_id = String(input.model_id ?? current?.model_id ?? "").trim();
    const api_key = String(input.api_key ?? "").trim() || current?.api_key || "";
    if (!name || !model_id || !api_key) throw new Error("请填写名称、模型 ID 和 API Key");
    if (name.length > 80 || model_id.length > 180 || api_key.length > 4000) throw new Error("评测模型配置字段过长");
    if (state.custom.some(item => item.project_id === projectId && item.name === name && item.id !== id)) throw new Error("当前项目已有同名评测模型");
    const now = new Date().toISOString();
    const model: JudgeModel = {
      id: current?.id || randomUUID(), project_id: projectId, name, base_url, model_id, api_key,
      is_default: false, created_at: current?.created_at || now, updated_at: now, source: "custom",
    };
    const hadDefault = Boolean(defaultId(projectId, state));
    if (current) state.custom[state.custom.indexOf(current)] = model;
    else state.custom.push(model);
    if (input.is_default === true || (current?.is_default && !state.defaults[String(projectId)]) || (!id && !hadDefault)) {
      state.defaults[String(projectId)] = model.id;
    }
    write(state);
    return publicModel(model, defaultId(projectId, state));
  }
  function remove(projectId: number, id: string): void {
    if (builtin(projectId).some(item => item.id === id)) throw new Error("内置模型不能在页面删除；请修改后台模型目录");
    const state = read();
    const item = state.custom.find(value => value.project_id === projectId && value.id === id);
    if (!item) throw new Error("评测模型不存在或不属于当前项目");
    state.custom = state.custom.filter(value => value.id !== id);
    if (state.defaults[String(projectId)] === id) delete state.defaults[String(projectId)];
    write(state);
  }
  function removeProject(projectId: number): void {
    const state = read();
    const remaining = state.custom.filter(item => item.project_id !== projectId);
    if (remaining.length === state.custom.length && !state.defaults[String(projectId)]) return;
    state.custom = remaining;
    delete state.defaults[String(projectId)];
    write(state);
  }
  return { list, get, selected, save, remove, removeProject };
}

export const judgeModels = createJudgeModelStore();

export async function testJudgeModel(model: JudgeModel): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${model.base_url}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${model.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: model.model_id, messages: [{ role: "user", content: "Reply OK." }], max_tokens: 32 }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("连接失败或超时，请检查接口地址和网络");
  }
  if (!response.ok) throw new Error(`连接失败（HTTP ${response.status}），请检查接口、密钥和模型 ID`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  if (!data.choices?.[0]?.message || typeof data.choices[0].message.content !== "string") {
    throw new Error("接口已连接，但没有返回可读文本");
  }
}
