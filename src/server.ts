import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { runHarness } from "../pi-agent/src/harness.js";
import * as db from "./db.js";
import { artifactFilePath, browserStatus, closeBrowser, openBrowserSession, screenshotFilePath } from "./browser-runner.js";
import { getBrowserJob, pauseBrowserJob, resumeBrowserJob, startBrowserJob } from "./browser-jobs.js";
import type { EvalCase, OfficeAgentConfig, Project, TargetAdapter } from "./domain.js";
import { buildHtml, buildXlsx } from "./reports.js";
import { attachCaseToEvaluationSet, clarifyProject, createEvaluationBatch, deleteCases, deleteEvaluationSet, evaluateCollectedBatch, finishEvaluationBatch, generateCasesWithPi, getEvaluationBatch, getRun, hydrateCase, importCasesFromExcel, inspectCasesExcel, listCases, listEvaluationBatches, listEvaluationSets, listOfficePlans, projectSummary, recordBrowserResult, runCases, saveOfficeMappings, seedCases } from "./services.js";
import type { WorkflowMode } from "./domain.js";
import { langfuseStatus } from "./langfuse.js";
import { deleteAgentEvaluation, evaluateAgentTrace, getAgentEvaluation, importAgentTrace, listAgentEvaluationGroups, listAgentEvaluations, linkAgentCase, moveAgentEvaluation } from "./agent-evaluation-service.js";
import { judgeModels, testJudgeModel } from "./judge-models.js";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..");
const STATIC = join(ROOT, "static");
const PORT = Number(process.env.PORT || 8000);

db.initDb();
db.execute("UPDATE runs SET status='failed',summary=?,finished_at=? WHERE status='running'", "服务重启，未完成的执行已终止", db.nowIso());
seedDemo();

const server = createServer(async (request, response) => {
  try { await route(request, response); }
  catch (error) { sendJson(response, error instanceof HttpError ? error.status : 500, { detail: error instanceof Error ? error.message : String(error) }); }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`pi-mono Agent 评测系统运行于 http://127.0.0.1:${PORT}\n`);
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const path = decodeURIComponent(url.pathname);
  let match: RegExpMatchArray | null;

  if (method === "GET" && path === "/") return sendFile(response, join(STATIC, "index.html"));
  if (method === "GET" && path.startsWith("/static/")) {
    const relative = normalize(path.slice(8)).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(STATIC, relative);
    if (!filePath.startsWith(STATIC) || !existsSync(filePath)) throw new HttpError(404, "资源不存在");
    return sendFile(response, filePath);
  }
  if (method === "GET" && path === "/api/health") {
    return sendJson(response, 200, { status: "ok", version: "0.4.0", runtime: "pi-mono", harness: await runHarness({ action: "status" }) });
  }
  if (method === "GET" && path === "/api/harness/status") return sendJson(response, 200, await runHarness({ action: "status" }));
  if (method === "GET" && path === "/api/langfuse/status") return sendJson(response, 200, langfuseStatus());
  match = path.match(/^\/api\/projects\/(\d+)\/judge-models(?:\/([a-z0-9-]+)(?:\/(test))?)?$/);
  if (match) {
    const projectId = Number(match[1]); getProject(projectId);
    const id = match[2];
    if (method === "GET" && !id) return sendJson(response, 200, judgeModels.list(projectId));
    if (method === "POST" && !id) return sendJson(response, 201, judgeModels.save(projectId, await readJson(request)));
    if (method === "PATCH" && id && !match[3]) return sendJson(response, 200, judgeModels.save(projectId, await readJson(request), id));
    if (method === "DELETE" && id && !match[3]) { judgeModels.remove(projectId, id); return sendJson(response, 200, { deleted: true }); }
    if (method === "POST" && id && match[3]) {
      await testJudgeModel(judgeModels.get(projectId, id));
      return sendJson(response, 200, { ok: true, message: "接口连通且返回文本；工具调用能力仍需通过实际评测验证" });
    }
  }
  match = path.match(/^\/api\/projects\/(\d+)\/agent-evaluation-groups$/);
  if (match && method === "GET") {
    const projectId = Number(match[1]); getProject(projectId);
    return sendJson(response, 200, listAgentEvaluationGroups(projectId));
  }
  match = path.match(/^\/api\/projects\/(\d+)\/agent-evaluations(?:\/(\d+)(?:\/(evaluate|group))?)?$/);
  if (match) {
    const projectId = Number(match[1]); getProject(projectId);
    const id = Number(match[2]);
    if (id && !db.row("SELECT id FROM agent_evaluations WHERE id=? AND project_id=?", id, projectId)) throw new HttpError(404, "Agent 评测记录不存在");
    if (method === "GET" && !match[3]) return sendJson(response, 200, id ? getAgentEvaluation(projectId, id) : listAgentEvaluations(projectId));
    if (method === "PATCH" && id && !match[3]) return sendJson(response, 200, linkAgentCase(projectId, id, await readJson(request)));
    if (method === "PATCH" && id && match[3] === "group") return sendJson(response, 200, moveAgentEvaluation(projectId, id, await readJson(request)));
    if (method === "DELETE" && id && !match[3]) return sendJson(response, 200, deleteAgentEvaluation(projectId, id));
    if (method === "POST" && !id) return sendJson(response, 201, await importAgentTrace(projectId, await readJson(request, 20_000_000)));
    if (method === "POST" && match[3] === "evaluate") return sendJson(response, 200, await evaluateAgentTrace(projectId, id, await readJson(request)));
  }
  if (method === "GET" && path === "/api/browser/status") return sendJson(response, 200, browserStatus());
  if (method === "POST" && path === "/api/browser/session") {
    const body = await readJson(request);
    const startUrl = text(body.start_url).trim();
    if (!startUrl) throw new HttpError(400, "请填写 Office 页面地址");
    return sendJson(response, 200, await openBrowserSession(startUrl));
  }
  if (method === "POST" && path === "/api/browser-jobs") {
    const body = await readJson(request);
    const workflowMode: WorkflowMode = body.workflow_mode === "collect_first" ? "collect_first" : "live_eval";
    const officeMode = body.office_mode === "manual" ? "manual" : "auto";
    return sendJson(response, 202, startBrowserJob(Number(body.project_id), Array.isArray(body.case_ids) ? body.case_ids.map(Number) : [], workflowMode, officeMode));
  }
  match = path.match(/^\/api\/browser-jobs\/([^/]+)$/);
  if (match && method === "GET") return sendJson(response, 200, getBrowserJob(match[1]));
  match = path.match(/^\/api\/browser-jobs\/([^/]+)\/(pause|resume)$/);
  if (match && method === "POST") return sendJson(response, 200, match[2] === "pause" ? pauseBrowserJob(match[1]) : resumeBrowserJob(match[1]));
  match = path.match(/^\/api\/screenshots\/([^/]+)$/);
  if (match && method === "GET") {
    const screenshot = screenshotFilePath(match[1]);
    if (!screenshot) throw new HttpError(404, "截图不存在");
    return sendFile(response, screenshot);
  }
  if (method === "GET" && path.startsWith("/artifacts/")) {
    const artifact = artifactFilePath(path.slice("/artifacts/".length));
    if (!artifact) throw new HttpError(404, "证据文件不存在");
    return sendFile(response, artifact);
  }

  if (method === "GET" && path === "/api/projects") {
    const projects = db.rows<Project>("SELECT * FROM projects ORDER BY updated_at DESC");
    return sendJson(response, 200, projects.map((project) => ({ ...project, summary: projectSummary(project.id),
      batch_count: Number(db.row<{ count: number }>("SELECT COUNT(*) count FROM evaluation_batches WHERE project_id=?", project.id)?.count || 0),
      run_count: Number(db.row<{ count: number }>("SELECT COUNT(*) count FROM runs WHERE project_id=?", project.id)?.count || 0),
      batches: listEvaluationBatches(project.id, 8) })));
  }
  if (method === "POST" && path === "/api/projects") {
    const body = await readJson(request); requireText(body.name, "项目名称");
    const timestamp = db.nowIso();
    const projectKey = uniqueProjectKey(text(body.project_key) || text(body.name));
    const id = db.execute(`INSERT INTO projects(project_key,name,agent_type,background,capabilities,boundaries,scoring_standard,status,target_adapter,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, projectKey, body.name, body.agent_type === "ppt" ? "ppt" : "dialogue", text(body.background), text(body.capabilities),
      text(body.boundaries), text(body.scoring_standard), "draft", "browser", timestamp, timestamp);
    db.execute(`INSERT INTO evaluation_sets(project_id,name,description,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
      id, "默认评测集", "可重命名或导入新的评测集", "manual", "draft", timestamp, timestamp);
    return sendJson(response, 201, getProject(id));
  }
  if (method === "POST" && path === "/api/projects/import") {
    const body = await readJson(request, 25_000_000);
    requireText(body.name, "项目名称");
    const filename = text(body.filename).trim();
    const base64 = text(body.file_base64).trim();
    if (!/\.xlsx$/i.test(filename)) throw new HttpError(400, "请选择 .xlsx 格式的 Excel 文件");
    if (!base64) throw new HttpError(400, "Excel 文件内容为空");
    const timestamp = db.nowIso();
    const projectKey = uniqueProjectKey(text(body.project_key) || text(body.name));
    const id = db.execute(`INSERT INTO projects(project_key,name,agent_type,status,target_adapter,target_base_url,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`, projectKey, body.name, "dialogue", "draft", "browser", text(body.start_url), timestamp, timestamp);
    try {
      const evaluationSetId = db.execute(`INSERT INTO evaluation_sets(project_id,name,description,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
        id, text(body.dataset_name).trim() || filename.replace(/\.xlsx$/i, "") || "导入评测集", `导入自 ${filename}`, "excel", "draft", timestamp, timestamp);
      const imported = await importCasesFromExcel(id, Buffer.from(base64, "base64"), filename, evaluationSetId);
      return sendJson(response, 201, { project: getProject(id), ...imported });
    } catch (error) {
      db.execute("DELETE FROM projects WHERE id=?", id);
      judgeModels.removeProject(id);
      throw error;
    }
  }
  if (method === "POST" && path === "/api/cases/import/inspect") {
    const body = await readJson(request, 25_000_000);
    const filename = text(body.filename).trim();
    const base64 = text(body.file_base64).trim();
    if (!/\.xlsx$/i.test(filename)) throw new HttpError(400, "请选择 .xlsx 格式的 Excel 文件");
    if (!base64) throw new HttpError(400, "Excel 文件内容为空");
    return sendJson(response, 200, await inspectCasesExcel(Buffer.from(base64, "base64")));
  }

  match = path.match(/^\/api\/projects\/(\d+)$/);
  if (match && method === "GET") return sendJson(response, 200, getProject(Number(match[1])));
  if (match && method === "PATCH") {
    const id = Number(match[1]); getProject(id); const body = await readJson(request);
    const allowed = ["name", "background", "capabilities", "boundaries", "scoring_standard", "status",
      "target_adapter", "target_base_url", "target_agent_id", "target_profile", "evidence_master_batch_id"];
    const entries = Object.entries(body).filter(([key, value]) => allowed.includes(key) && value !== undefined);
    if (entries.length) {
      entries.push(["updated_at", db.nowIso()]);
      db.execute(`UPDATE projects SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`, ...entries.map(([, value]) => sqlValue(value)), id);
    }
    return sendJson(response, 200, getProject(id));
  }
  if (match && method === "DELETE") {
    const id = Number(match[1]); const project = getProject(id); const body = await readJson(request);
    if (text(body.confirm_name).trim() !== project.name) throw new HttpError(400, "请输入完整项目名称以确认删除");
    db.execute("DELETE FROM projects WHERE id=?", id);
    judgeModels.removeProject(id);
    return sendJson(response, 200, { deleted: true, project_id: id });
  }

  match = path.match(/^\/api\/projects\/(\d+)\/clarify$/);
  if (match && method === "POST") return sendJson(response, 200, await clarifyProject(getProject(Number(match[1]))));
  match = path.match(/^\/api\/projects\/(\d+)\/evaluation-sets(?:\/(\d+))?$/);
  if (match) {
    const projectId = Number(match[1]); getProject(projectId); const setId = Number(match[2] || 0);
    if (setId) getEvaluationSet(projectId, setId);
    if (method === "GET" && !setId) return sendJson(response, 200, listEvaluationSets(projectId));
    if (method === "DELETE" && !setId) {
      const body = await readJson(request);
      if (body.confirm !== true) throw new HttpError(400, "请确认删除当前项目的所有评测集及用例");
      const setCount = Number(db.row<{ count: number }>("SELECT COUNT(*) count FROM evaluation_sets WHERE project_id=?", projectId)?.count || 0);
      const caseCount = Number(db.row<{ count: number }>("SELECT COUNT(*) count FROM cases WHERE project_id=?", projectId)?.count || 0);
      const runCount = Number(db.row<{ count: number }>("SELECT COUNT(*) count FROM runs WHERE project_id=?", projectId)?.count || 0);
      db.database.exec("BEGIN");
      try {
        db.execute("DELETE FROM evaluation_sets WHERE project_id=?", projectId);
        db.execute("DELETE FROM cases WHERE project_id=?", projectId);
        db.execute("DELETE FROM evaluation_batches WHERE project_id=?", projectId);
        db.execute("UPDATE projects SET source_workbook_path='',source_workbook_name='',evidence_master_batch_id=0,updated_at=? WHERE id=?", db.nowIso(), projectId);
        db.database.exec("COMMIT");
      } catch (error) { db.database.exec("ROLLBACK"); throw error; }
      return sendJson(response, 200, { deleted_sets: setCount, deleted_cases: caseCount, deleted_runs: runCount });
    }
    if (method === "POST" && !setId) {
      const body = await readJson(request); requireText(body.name, "评测集名称"); const name = body.name.trim(); const timestamp = db.nowIso();
      try {
        const id = db.execute(`INSERT INTO evaluation_sets(project_id,name,description,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
          projectId, name, text(body.description), text(body.source) || "manual", "draft", timestamp, timestamp);
        return sendJson(response, 201, getEvaluationSet(projectId, id));
      } catch (error) { if (String(error).includes("UNIQUE")) throw new HttpError(409, "当前项目已经存在同名评测集"); throw error; }
    }
    if (method === "PATCH" && setId) {
      const body = await readJson(request); const entries = Object.entries(body).filter(([key]) => ["name", "description", "status"].includes(key));
      if (entries.some(([key, value]) => key === "name" && !text(value).trim())) throw new HttpError(400, "请填写评测集名称");
      if (entries.length) {
        entries.push(["updated_at", db.nowIso()]);
        try { db.execute(`UPDATE evaluation_sets SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`, ...entries.map(([, value]) => sqlValue(value)), setId); }
        catch (error) { if (String(error).includes("UNIQUE")) throw new HttpError(409, "当前项目已经存在同名评测集"); throw error; }
      }
      return sendJson(response, 200, getEvaluationSet(projectId, setId));
    }
    if (method === "DELETE" && setId) {
      const body = await readJson(request);
      if (body.confirm !== true) throw new HttpError(400, "请确认删除此评测集及仅属于它的用例");
      return sendJson(response, 200, deleteEvaluationSet(projectId, setId));
    }
  }
  match = path.match(/^\/api\/projects\/(\d+)\/cases$/);
  if (match && method === "GET") {
    const projectId = Number(match[1]); getProject(projectId); const setId = Number(url.searchParams.get("evaluation_set_id") || 0);
    if (setId) getEvaluationSet(projectId, setId);
    return sendJson(response, 200, listCases(projectId, setId || undefined));
  }
  if (match && method === "DELETE") {
    const projectId = Number(match[1]); getProject(projectId); const body = await readJson(request);
    const caseIds = Array.isArray(body.case_ids) ? body.case_ids.map(Number) : [];
    return sendJson(response, 200, { ...deleteCases(projectId, caseIds), cases: listCases(projectId) });
  }
  if (match && method === "POST") {
    const projectId = Number(match[1]); getProject(projectId); const body = await readJson(request);
    requireText(body.title, "用例标题"); requireText(body.query, "测试问题");
    const timestamp = db.nowIso();
    const project = getProject(projectId);
    const code = caseCode(project, text(body.code));
    const id = db.execute(`INSERT INTO cases(project_id,code,category,title,query,expected_answer,expected_keywords,forbidden_keywords,
      followups,max_turns,priority,approved,execution_type,start_url,browser_steps,expected_trace_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      projectId, code, text(body.category) || "Agent 专属能力", text(body.title), text(body.query), text(body.expected_answer),
      JSON.stringify(body.expected_keywords || []), JSON.stringify(body.forbidden_keywords || []), JSON.stringify(body.followups || []),
      Number(body.max_turns || 1), text(body.priority) || "P0", body.approved ? 1 : 0,
      ["browser", "hybrid"].includes(text(body.execution_type)) ? text(body.execution_type) : "dialogue", text(body.start_url), JSON.stringify(body.browser_steps || []), JSON.stringify(body.expected_trace_json || {}), timestamp, timestamp);
    const evaluationSetId = Number(body.evaluation_set_id || 0);
    if (evaluationSetId) { getEvaluationSet(projectId, evaluationSetId); attachCaseToEvaluationSet(evaluationSetId, id); }
    return sendJson(response, 201, hydrateCase(db.row<Record<string, unknown>>("SELECT * FROM cases WHERE id=?", id)!));
  }
  match = path.match(/^\/api\/projects\/(\d+)\/offices$/);
  if (match && method === "GET") {
    const projectId = Number(match[1]); getProject(projectId);
    return sendJson(response, 200, listOfficePlans(projectId));
  }
  if (match && method === "PATCH") {
    const projectId = Number(match[1]); getProject(projectId); const body = await readJson(request);
    const mappings = Array.isArray(body.mappings) ? body.mappings.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
    return sendJson(response, 200, saveOfficeMappings(projectId, mappings));
  }
  match = path.match(/^\/api\/projects\/(\d+)\/cases\/generate$/);
  if (match && method === "POST") {
    const project = getProject(Number(match[1])); const body = await readJson(request); const setId = Number(body.evaluation_set_id || 0);
    if (setId) getEvaluationSet(project.id, setId);
    return sendJson(response, 200, await generateCasesWithPi(project, setId || undefined));
  }
  match = path.match(/^\/api\/projects\/(\d+)\/batches$/);
  if (match && method === "GET") { getProject(Number(match[1])); return sendJson(response, 200, listEvaluationBatches(Number(match[1]), 100)); }
  match = path.match(/^\/api\/batches\/(\d+)$/);
  if (match && method === "GET") return sendJson(response, 200, getEvaluationBatch(Number(match[1])));
  match = path.match(/^\/api\/batches\/(\d+)\/evaluate$/);
  if (match && method === "POST") return sendJson(response, 200, await evaluateCollectedBatch(Number(match[1])));
  match = path.match(/^\/api\/projects\/(\d+)\/cases\/import$/);
  if (match && method === "POST") {
    const projectId = Number(match[1]); getProject(projectId);
    const body = await readJson(request, 25_000_000);
    const filename = text(body.filename).trim();
    const base64 = text(body.file_base64).trim();
    if (!/\.xlsx$/i.test(filename)) throw new HttpError(400, "请选择 .xlsx 格式的 Excel 文件");
    if (!base64) throw new HttpError(400, "Excel 文件内容为空");
    const setId = Number(body.evaluation_set_id || 0); if (setId) getEvaluationSet(projectId, setId);
    return sendJson(response, 200, await importCasesFromExcel(projectId, Buffer.from(base64, "base64"), filename, setId || undefined));
  }

  match = path.match(/^\/api\/cases\/(\d+)$/);
  if (match && method === "PATCH") {
    const id = Number(match[1]); const current = db.row<Record<string, unknown>>("SELECT * FROM cases WHERE id=?", id);
    if (!current) throw new HttpError(404, "测试用例不存在");
    const body = await readJson(request);
    const allowed = ["title", "category", "query", "expected_answer", "expected_keywords", "forbidden_keywords", "followups", "max_turns", "priority", "approved",
      "execution_type", "start_url", "browser_steps", "case_type", "conversation_group", "conversation_round", "input_mode", "evaluation_criteria", "expected_trace_json"];
    const entries = Object.entries(body).filter(([key, value]) => allowed.includes(key) && value !== undefined).map(([key, value]) => {
      if (["expected_keywords", "forbidden_keywords", "followups", "browser_steps", "expected_trace_json"].includes(key)) return [key, JSON.stringify(value)];
      if (key === "approved") return [key, value ? 1 : 0];
      return [key, value];
    });
    if (entries.length) {
      entries.push(["updated_at", db.nowIso()]);
      db.execute(`UPDATE cases SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`, ...entries.map(([, value]) => sqlValue(value)), id);
    }
    return sendJson(response, 200, hydrateCase(db.row<Record<string, unknown>>("SELECT * FROM cases WHERE id=?", id)!));
  }

  if (method === "POST" && path === "/api/runs") {
    const body = await readJson(request); const projectId = Number(body.project_id);
    const project = getProject(projectId);
    const requestedAdapter = body.adapter || project.target_adapter;
    const adapter: TargetAdapter = requestedAdapter === "browser" ? "browser" : requestedAdapter === "office_agent" ? "office_agent"
      : requestedAdapter === "openai_compatible" ? "openai_compatible" : "mock";
    const suppliedTarget = body.target && typeof body.target === "object" ? body.target as Record<string, unknown> : {};
    const target = adapter === "office_agent" ? officeTarget({
      base_url: project.target_base_url, agent_id: project.target_agent_id, profile: project.target_profile, ...suppliedTarget,
    }) : undefined;
    if (target) db.execute(`UPDATE projects SET target_adapter=?,target_base_url=?,target_agent_id=?,target_profile=?,updated_at=? WHERE id=?`,
      adapter, target.base_url, target.agent_id, target.profile || "", db.nowIso(), projectId);
    const ids = Array.isArray(body.case_ids) ? body.case_ids.map(Number) : [];
    const selectedIds = ids.length ? ids : listCases(projectId).filter((item) => item.approved).map((item) => item.id);
    const batchId = createEvaluationBatch(projectId, adapter, selectedIds);
    const runs = await runCases(projectId, ids, adapter, target, batchId);
    finishEvaluationBatch(batchId, "completed");
    return sendJson(response, 200, { batch_id: batchId, count: runs.length, runs });
  }
  if (method === "POST" && path === "/api/browser-results") {
    const body = await readJson(request);
    const answer = text(body.answer).trim();
    if (!answer) throw new HttpError(400, "没有捕获到被测 Agent 回复");
    const trace = Array.isArray(body.trace) ? body.trace.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
    const screenshots = Array.isArray(body.screenshots) ? body.screenshots.map(text).filter(Boolean) : [];
    const run = await recordBrowserResult(Number(body.project_id), Number(body.case_id), answer, trace, Number(body.latency_ms || 0), text(body.screenshot), Number(body.batch_id || 0) || undefined, screenshots);
    return sendJson(response, 201, run);
  }
  match = path.match(/^\/api\/projects\/(\d+)\/runs$/);
  if (match && method === "GET") {
    const id = Number(match[1]); getProject(id);
    return sendJson(response, 200, db.rows(`SELECT r.*,c.code,c.title,c.category FROM runs r JOIN cases c ON c.id=r.case_id
      WHERE r.project_id=? ORDER BY r.id DESC`, id));
  }
  match = path.match(/^\/api\/runs\/(\d+)$/);
  if (match && method === "GET") return sendJson(response, 200, getRun(Number(match[1])));

  match = path.match(/^\/reports\/(\d+)\.html$/);
  if (match && method === "GET") return sendText(response, 200, buildHtml(getProject(Number(match[1])), Number(url.searchParams.get("batch") || 0) || undefined), "text/html; charset=utf-8");
  match = path.match(/^\/reports\/(\d+)\.xlsx$/);
  if (match && method === "GET") {
    const id = Number(match[1]), buffer = await buildXlsx(getProject(id));
    response.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename=agent-eval-report-${id}.xlsx`, "Content-Length": buffer.byteLength });
    response.end(buffer); return;
  }
  throw new HttpError(404, "页面或接口不存在");
}

function officeTarget(value: unknown): OfficeAgentConfig {
  const target = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const base_url = text(target.base_url).trim();
  const agent_id = text(target.agent_id).trim();
  if (!base_url) throw new HttpError(400, "请填写 Office Agent Base URL");
  if (!agent_id) throw new HttpError(400, "请填写本次评测的 Agent ID");
  return { base_url, agent_id, profile: text(target.profile), jwt: text(target.jwt), model: text(target.model) || "default" };
}

function getProject(id: number): Project {
  const project = db.row<Project>("SELECT * FROM projects WHERE id=?", id);
  if (!project) throw new HttpError(404, "评测项目不存在");
  return { ...project, summary: projectSummary(id) };
}

function getEvaluationSet(projectId: number, id: number): Record<string, unknown> {
  const set = db.row<Record<string, unknown>>("SELECT * FROM evaluation_sets WHERE id=? AND project_id=?", id, projectId);
  if (!set) throw new HttpError(404, "评测集不存在或不属于当前项目");
  return set;
}

function uniqueProjectKey(value: string): string {
  const base = value.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "AGENT";
  let candidate = base;
  let suffix = 2;
  while (db.row("SELECT id FROM projects WHERE project_key=?", candidate)) candidate = `${base.slice(0, 12)}-${suffix++}`;
  return candidate;
}

function caseCode(project: Project, supplied: string): string {
  const prefix = project.project_key || `PRJ-${project.id}`;
  const cleaned = supplied.toUpperCase().replace(/[^A-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned) return cleaned.startsWith(`${prefix}-`) ? cleaned : `${prefix}-${cleaned}`;
  const count = Number(db.row<{ count: number }>("SELECT COUNT(*) AS count FROM cases WHERE project_id=?", project.id)?.count || 0);
  return `${prefix}-${String(count + 1).padStart(3, "0")}`;
}

function seedDemo(): void {
  if (db.row("SELECT id FROM projects LIMIT 1")) return;
  if (db.row("SELECT seq FROM sqlite_sequence WHERE name='projects'")) return;
  const timestamp = db.nowIso();
  const id = db.execute(`INSERT INTO projects(project_key,name,agent_type,background,capabilities,boundaries,scoring_standard,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, "LUI", "Office LUI 第一期评测", "dialogue", "面向办公用户的对话式 Agent，通过自然语言查询工作区文件、工位和数据资源。",
    "查询全部文件列表；查询工位级资源；理解口语化表达；信息不足时主动追问。", "不得越权访问外部系统；没有权限时必须明确说明；不得编造查询或操作结果。",
    "核心用例必须全部通过；长尾用例通过率不低于 85%；必答要点完整且不得出现严重事实错误。", "ready", timestamp, timestamp);
  const evaluationSetId = db.execute(`INSERT INTO evaluation_sets(project_id,name,description,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
    id, "核心能力测试集", "系统演示评测集，可直接重命名", "generated", "published", timestamp, timestamp);
  seedCases(id);
  db.execute("INSERT OR IGNORE INTO evaluation_set_cases(evaluation_set_id,case_id) SELECT ?,id FROM cases WHERE project_id=?", evaluationSetId, id);
}

async function readJson(request: IncomingMessage, maxSize = 2_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > maxSize) throw new HttpError(413, "请求内容过大"); chunks.push(buffer); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
  catch { throw new HttpError(400, "JSON 格式无效"); }
}

function sendJson(response: ServerResponse, status: number, data: unknown): void { sendText(response, status, JSON.stringify(data), "application/json; charset=utf-8"); }
function sendText(response: ServerResponse, status: number, data: string, type: string): void { const body = Buffer.from(data); response.writeHead(status, { "Content-Type": type, "Content-Length": body.length }); response.end(body); }
function sendFile(response: ServerResponse, path: string): void { const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }; const data = readFileSync(path); response.writeHead(200, { "Content-Type": mime[extname(path)] || "application/octet-stream", "Content-Length": data.length }); response.end(data); }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function requireText(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${label}不能为空`); }
function sqlValue(value: unknown): string | number | null { return typeof value === "number" || typeof value === "string" || value === null ? value : JSON.stringify(value); }
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

function shutdown(): void {
  server.close(() => { void closeBrowser().finally(() => { db.database.close(); process.exit(0); }); });
}
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
