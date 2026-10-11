import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

import { runHarness } from "../pi-agent/src/harness.js";
import { judgeModels } from "./judge-models.js";
import type { HarnessOutput, ProposedCase } from "../pi-agent/src/types.js";
import { createOfficeSession, MockDialogueAgent, OfficeAgent, OpenAICompatibleAgent } from "./agents.js";
import { BrowserDialogueError, runBrowserDialogue, writeResultArtifact } from "./browser-runner.js";
import * as db from "./db.js";
import type { AgentReply, DialogueAgent, EvalCase, EvaluationSet, OfficeAgentConfig, OfficeMapping, OfficePlan, Project, ProjectSummary, ScoreDetail, TargetAdapter, WorkflowMode } from "./domain.js";
import { evaluate } from "./evaluator.js";
import { buildCombinedEvidenceWorkbook, buildEvidenceWorkbook } from "./excel-evidence.js";
import { normaliseNamespacedWorkbook } from "./workbook-normalizer.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMPORT_DIR = process.env.AGENT_EVAL_IMPORT_DIR || resolve(ROOT, "data", "imports");

export function hydrateCase(record: Record<string, unknown>): EvalCase {
  return {
    ...record,
    expected_keywords: db.jsonArray(record.expected_keywords), forbidden_keywords: db.jsonArray(record.forbidden_keywords),
    followups: db.jsonArray(record.followups), approved: Number(record.approved), max_turns: Number(record.max_turns),
    browser_steps: parseBrowserSteps(record.browser_steps), execution_type: record.execution_type || "dialogue", start_url: record.start_url || "",
    source_sheet_name: String(record.source_sheet_name || ""), source_case_code: String(record.source_case_code || record.code || ""),
    source_row_number: Number(record.source_row_number || 0),
    office_industry: String(record.office_industry || ""), office_subindustry: String(record.office_subindustry || ""),
    office_role: String(record.office_role || ""), office_key: String(record.office_key || ""), office_name: String(record.office_name || ""),
    case_type: record.case_type === "multi_turn" ? "multi_turn" : "single_turn",
    conversation_group: String(record.conversation_group || ""), conversation_round: Math.max(1, Number(record.conversation_round || 1)),
    input_mode: record.input_mode === "topic_click" ? "topic_click" : "message",
    evaluation_criteria: String(record.evaluation_criteria || ""),
    source_fields: parseSourceFields(record.source_fields_json),
    expected_trace: parseExpectedTrace(record.expected_trace_json),
  } as EvalCase;
}

function parseSourceFields(value: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function parseExpectedTrace(value: unknown): EvalCase["expected_trace"] {
  const raw = parseSourceFields(value);
  return {
    required_tools: Array.isArray(raw.required_tools) ? raw.required_tools.map(String).filter(Boolean) : [],
    forbidden_tools: Array.isArray(raw.forbidden_tools) ? raw.forbidden_tools.map(String).filter(Boolean) : [],
    ordered: raw.ordered === true,
    parameter_constraints: String(raw.parameter_constraints || ""),
    max_tool_calls: Number.isInteger(raw.max_tool_calls) && Number(raw.max_tool_calls) >= 0 ? Number(raw.max_tool_calls) : null,
    notes: String(raw.notes || ""),
  };
}

export function listEvaluationSets(projectId: number): EvaluationSet[] {
  return db.rows<EvaluationSet>(`SELECT s.*,COUNT(m.case_id) case_count,
    COALESCE(SUM(CASE WHEN c.approved=1 THEN 1 ELSE 0 END),0) approved_count
    FROM evaluation_sets s LEFT JOIN evaluation_set_cases m ON m.evaluation_set_id=s.id
    LEFT JOIN cases c ON c.id=m.case_id WHERE s.project_id=? GROUP BY s.id ORDER BY s.updated_at DESC,s.id DESC`, projectId);
}

export function listCases(projectId: number, evaluationSetId?: number): EvalCase[] {
  const records = evaluationSetId
    ? db.rows<Record<string, unknown>>(`SELECT c.* FROM cases c JOIN evaluation_set_cases m ON m.case_id=c.id
      JOIN evaluation_sets s ON s.id=m.evaluation_set_id WHERE c.project_id=? AND s.project_id=? AND s.id=? ORDER BY c.code`, projectId, projectId, evaluationSetId)
    : db.rows<Record<string, unknown>>("SELECT * FROM cases WHERE project_id=? ORDER BY code", projectId);
  return records.map(hydrateCase);
}

export function attachCaseToEvaluationSet(evaluationSetId: number, caseId: number): void {
  db.execute("INSERT OR IGNORE INTO evaluation_set_cases(evaluation_set_id,case_id) VALUES(?,?)", evaluationSetId, caseId);
  db.execute("UPDATE evaluation_sets SET updated_at=? WHERE id=?", db.nowIso(), evaluationSetId);
}

export function listOfficePlans(projectId: number): OfficePlan[] {
  const cases = listCases(projectId).filter((item) => item.approved && item.office_key);
  const mappings = db.rows<OfficeMapping>("SELECT * FROM office_mappings WHERE project_id=? ORDER BY generated_name", projectId);
  const mappingByKey = new Map(mappings.map((item) => [item.office_key, item]));
  const grouped = new Map<string, EvalCase[]>();
  for (const item of cases) {
    const key = item.office_key;
    const group = grouped.get(key) || [];
    group.push(item);
    grouped.set(key, group);
  }
  return [...grouped.entries()].map(([officeKey, groupCases]) => {
    const generatedName = groupCases[0]?.office_name || officeKey;
    const saved = mappingByKey.get(officeKey);
    return {
      project_id: projectId,
      office_key: officeKey,
      generated_name: generatedName,
      actual_office_name: saved?.actual_office_name || "",
      actual_office_url: saved?.actual_office_url || "",
      created_at: saved?.created_at || "",
      updated_at: saved?.updated_at || "",
      cases: groupCases.sort((left, right) => left.code.localeCompare(right.code, undefined, { numeric: true })),
    };
  }).sort((left, right) => left.generated_name.localeCompare(right.generated_name, "zh-CN"));
}

export function saveOfficeMappings(projectId: number, values: Array<Partial<OfficeMapping>>): OfficePlan[] {
  const validKeys = new Set(listOfficePlans(projectId).map((item) => item.office_key));
  const timestamp = db.nowIso();
  const upsert = db.database.prepare(`INSERT INTO office_mappings(project_id,office_key,generated_name,actual_office_name,actual_office_url,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,office_key) DO UPDATE SET generated_name=excluded.generated_name,
    actual_office_name=excluded.actual_office_name,actual_office_url=excluded.actual_office_url,updated_at=excluded.updated_at`);
  db.database.exec("BEGIN");
  try {
    for (const value of values) {
      const officeKey = String(value.office_key || "");
      if (!validKeys.has(officeKey)) throw new Error(`办公室分组不存在：${officeKey}`);
      upsert.run(projectId, officeKey, String(value.generated_name || ""), String(value.actual_office_name || "").trim(),
        String(value.actual_office_url || "").trim(), timestamp, timestamp);
    }
    db.execute("UPDATE projects SET updated_at=? WHERE id=?", timestamp, projectId);
    db.database.exec("COMMIT");
  } catch (error) { db.database.exec("ROLLBACK"); throw error; }
  return listOfficePlans(projectId);
}

export function deleteCases(projectId: number, caseIds: number[]): { deleted: number; deleted_runs: number } {
  const ids = [...new Set(caseIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) throw new Error("请至少选择一条测试用例");
  const placeholders = ids.map(() => "?").join(",");
  const owned = db.rows<{ id: number }>(`SELECT id FROM cases WHERE project_id=? AND id IN (${placeholders})`, projectId, ...ids);
  if (owned.length !== ids.length) throw new Error("部分测试用例不属于当前项目，已停止删除");
  db.database.exec("BEGIN");
  try {
    const deletedRuns = deleteCaseRows(projectId, ids);
    db.execute("UPDATE projects SET updated_at=? WHERE id=?", db.nowIso(), projectId);
    db.database.exec("COMMIT");
    return { deleted: ids.length, deleted_runs: deletedRuns };
  } catch (error) { db.database.exec("ROLLBACK"); throw error; }
}

export function deleteEvaluationSet(projectId: number, setId: number): { deleted: true; deleted_cases: number; deleted_runs: number; retained_shared_cases: number } {
  const set = db.row<{ id: number }>("SELECT id FROM evaluation_sets WHERE id=? AND project_id=?", setId, projectId);
  if (!set) throw new Error("评测集不存在或不属于当前项目");
  const exclusive = db.rows<{ id: number }>(`SELECT m.case_id id FROM evaluation_set_cases m
    WHERE m.evaluation_set_id=? AND NOT EXISTS (SELECT 1 FROM evaluation_set_cases other
    WHERE other.case_id=m.case_id AND other.evaluation_set_id<>?)`, setId, setId).map((item) => item.id);
  const total = Number(db.row<{ count: number }>("SELECT COUNT(*) count FROM evaluation_set_cases WHERE evaluation_set_id=?", setId)?.count || 0);
  db.database.exec("BEGIN");
  try {
    const deletedRuns = exclusive.length ? deleteCaseRows(projectId, exclusive) : 0;
    db.execute("DELETE FROM evaluation_sets WHERE id=? AND project_id=?", setId, projectId);
    db.execute("UPDATE projects SET updated_at=? WHERE id=?", db.nowIso(), projectId);
    db.database.exec("COMMIT");
    return { deleted: true, deleted_cases: exclusive.length, deleted_runs: deletedRuns, retained_shared_cases: total - exclusive.length };
  } catch (error) { db.database.exec("ROLLBACK"); throw error; }
}

function deleteCaseRows(projectId: number, ids: number[]): number {
  const placeholders = ids.map(() => "?").join(",");
  const runInfo = db.rows<{ id: number; batch_id: number | null }>(`SELECT id,batch_id FROM runs WHERE project_id=? AND case_id IN (${placeholders})`, projectId, ...ids);
  const batchIds = [...new Set(runInfo.map((item) => Number(item.batch_id || 0)).filter(Boolean))];
  db.execute(`DELETE FROM cases WHERE project_id=? AND id IN (${placeholders})`, projectId, ...ids);
  for (const batchId of batchIds) reconcileBatchAfterCaseDeletion(batchId, ids);
  return runInfo.length;
}

function reconcileBatchAfterCaseDeletion(batchId: number, deletedCaseIds: number[]): void {
  const batch = db.row<{ selected_case_ids: string }>("SELECT selected_case_ids FROM evaluation_batches WHERE id=?", batchId);
  if (!batch) return;
  let selected: number[] = [];
  try { selected = (JSON.parse(batch.selected_case_ids || "[]") as unknown[]).map(Number).filter(Boolean); } catch { selected = []; }
  selected = selected.filter((id) => !deletedCaseIds.includes(id));
  const totals = db.row<{ completed: number; passed: number; failed: number; remaining: number }>(`SELECT
    SUM(CASE WHEN status IN ('completed','collected') THEN 1 ELSE 0 END) completed,
    SUM(CASE WHEN status='completed' AND passed=1 THEN 1 ELSE 0 END) passed,
    SUM(CASE WHEN status='failed' OR (status='completed' AND passed=0) THEN 1 ELSE 0 END) failed,
    COUNT(*) remaining FROM runs WHERE batch_id=?`, batchId);
  if (!Number(totals?.remaining || 0) && !selected.length) { db.execute("DELETE FROM evaluation_batches WHERE id=?", batchId); return; }
  db.execute(`UPDATE evaluation_batches SET selected_case_ids=?,total=?,completed=?,passed=?,failed=? WHERE id=?`, JSON.stringify(selected),
    selected.length || Number(totals?.remaining || 0), Number(totals?.completed || 0), Number(totals?.passed || 0), Number(totals?.failed || 0), batchId);
}

type ImportField = "caseType" | "code" | "title" | "question" | "expected" | "criteria" | "conversation" | "category" | "maxTurns" |
  "priority" | "industry" | "subIndustry" | "role" | "requiredTools" | "forbiddenTools" | "toolOrder" | "toolParameters" | "maxToolCalls" | "traceNotes";

const CASE_IMPORT_ALIASES: Record<ImportField, string[]> = {
  caseType: ["用例类型", "测试类型", "对话类型", "场景类型"],
  code: ["用例ID", "用例编号", "编号", "caseid", "casecode"],
  title: ["用例名称", "用例标题", "标题", "名称"],
  question: ["用户输入/Topic场景", "用户输入／Topic场景", "用户输入", "Topic场景", "初始问题", "问题", "测试问题", "用户问题", "提问"],
  expected: ["预期系统行为", "预期行为", "预期结果", "预期回答要点", "预期回答", "预期回复", "回复要求", "黄金答案/必要事实", "黄金答案", "标准答案"],
  criteria: ["评估标准", "评价标准", "评分标准", "判断标准", "验收标准", "准确性评分点"],
  conversation: ["对话组/轮次", "对话组／轮次", "对话组", "会话组", "轮次", "对话轮次"],
  category: ["场景分类", "细分行业", "分类", "场景", "用例分类", "类别"],
  maxTurns: ["轮数上限", "最大轮数", "轮次上限"],
  priority: ["级别", "优先级", "priority"],
  industry: ["行业", "所属行业", "行业大类"],
  subIndustry: ["细分行业", "子行业", "行业细分"],
  role: ["岗位", "角色", "职位"],
  requiredTools: ["必需工具", "必须工具", "必须调用工具", "预期工具", "期望工具", "requiredtools"],
  forbiddenTools: ["禁止工具", "不应调用工具", "forbiddentools"],
  toolOrder: ["预期调用顺序", "工具调用顺序", "预期工具顺序", "调用顺序"],
  toolParameters: ["工具参数约束", "参数约束", "预期参数", "工具参数"],
  maxToolCalls: ["最大工具调用数", "工具调用上限", "最多工具调用数"],
  traceNotes: ["预期轨迹", "完整预期轨迹", "预期完整轨迹", "预期执行轨迹", "轨迹要求", "过程要求"],
};

export interface ExcelImportInspection {
  valid: boolean;
  required_fields: Array<{ field: ImportField; label: string }>;
  sheets: Array<{ sheet_name: string; header_row: number; matched: Record<string, string>; columns: string[]; missing: string[]; importable: boolean }>;
  importable_sheets: number;
  ignored_sheets: string[];
}

export async function inspectCasesExcel(bytes: Buffer): Promise<ExcelImportInspection> {
  const workbook = new ExcelJS.Workbook();
  const readableBytes = await normaliseNamespacedWorkbook(bytes);
  await workbook.xlsx.load(readableBytes as unknown as ExcelJS.Buffer);
  if (!workbook.worksheets.length) throw new Error("Excel 中没有工作表");
  const required = [
    { field: "question" as const, label: "用户输入 / Topic场景" },
    { field: "expected" as const, label: "预期系统行为 / 黄金答案" },
  ];
  const sheets: ExcelImportInspection["sheets"] = [];
  const ignoredSheets: string[] = [];
  for (const sheet of workbook.worksheets) {
    let best: { row: number; columns: Partial<Record<ImportField, number>>; headers: Partial<Record<ImportField, string>>; allHeaders: string[] } | undefined;
    for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 30); rowNumber += 1) {
      const columns: Partial<Record<ImportField, number>> = {};
      const headers: Partial<Record<ImportField, string>> = {};
      const allHeaders: string[] = [];
      sheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        const header = normaliseHeader(cell.text);
        if (header) allHeaders.push(cell.text.trim());
        for (const [field, names] of Object.entries(CASE_IMPORT_ALIASES) as Array<[ImportField, string[]]>) {
          if (!columns[field] && names.some((name) => normaliseHeader(name) === header)) {
            columns[field] = columnNumber;
            headers[field] = cell.text.trim();
          }
        }
      });
      if (!best || Object.keys(columns).length > Object.keys(best.columns).length) best = { row: rowNumber, columns, headers, allHeaders };
    }
    if (!best || (!best.columns.question && !best.columns.expected)) { ignoredSheets.push(sheet.name); continue; }
    const missing = required.filter((item) => !best!.columns[item.field]).map((item) => item.label);
    sheets.push({ sheet_name: sheet.name, header_row: best.row, matched: best.headers as Record<string, string>,
      columns: best.allHeaders, missing, importable: !missing.length });
  }
  const importableSheets = sheets.filter((item) => item.importable).length;
  return { valid: importableSheets > 0 && sheets.every((item) => item.importable), required_fields: required, sheets,
    importable_sheets: importableSheets, ignored_sheets: ignoredSheets };
}

export async function importCasesFromExcel(projectId: number, bytes: Buffer, filename = "测试用例.xlsx", evaluationSetId?: number): Promise<Record<string, unknown>> {
  const project = db.row<Project>("SELECT * FROM projects WHERE id=?", projectId);
  if (!project) throw new Error("评测项目不存在");
  const workbook = new ExcelJS.Workbook();
  const readableBytes = await normaliseNamespacedWorkbook(bytes);
  await workbook.xlsx.load(readableBytes as unknown as ExcelJS.Buffer);
  if (!workbook.worksheets.length) throw new Error("Excel 中没有工作表");
  const inspection = await inspectCasesExcel(bytes);
  const invalid = inspection.sheets.filter((item) => !item.importable);
  if (!inspection.importable_sheets || invalid.length) {
    const detail = invalid.length
      ? invalid.map((item) => `“${item.sheet_name}”缺少：${item.missing.join("、")}`).join("；")
      : "没有找到包含标准字段的测试用例分表";
    throw new Error(`Excel 用例格式不完整：${detail}。必填字段为“用户输入”和“预期系统行为 / 黄金答案”（支持常用别名）。`);
  }
  mkdirSync(IMPORT_DIR, { recursive: true });
  const safeName = filename.replace(/[^\p{L}\p{N}._-]+/gu, "-");
  const storedPath = join(IMPORT_DIR, `${project.project_key}-${Date.now()}-${safeName}`);
  writeFileSync(storedPath, bytes);
  db.execute("UPDATE projects SET source_workbook_path=?,source_workbook_name=?,updated_at=? WHERE id=?", storedPath, filename, db.nowIso(), projectId);
  const timestamp = db.nowIso();
  const insert = db.database.prepare(`INSERT INTO cases(project_id,code,category,title,query,expected_answer,expected_keywords,forbidden_keywords,
    followups,max_turns,priority,approved,execution_type,start_url,browser_steps,source_sheet_name,source_case_code,source_row_number,
    office_industry,office_subindustry,office_role,office_key,office_name,case_type,conversation_group,conversation_round,input_mode,
    evaluation_criteria,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id,code) DO UPDATE SET category=excluded.category,title=excluded.title,query=excluded.query,
    expected_answer=excluded.expected_answer,approved=excluded.approved,execution_type=excluded.execution_type,start_url=excluded.start_url,
    source_sheet_name=excluded.source_sheet_name,source_case_code=excluded.source_case_code,source_row_number=excluded.source_row_number,
    office_industry=excluded.office_industry,office_subindustry=excluded.office_subindustry,office_role=excluded.office_role,
    office_key=excluded.office_key,office_name=excluded.office_name,case_type=excluded.case_type,
    conversation_group=excluded.conversation_group,conversation_round=excluded.conversation_round,input_mode=excluded.input_mode,
    evaluation_criteria=excluded.evaluation_criteria,browser_steps=excluded.browser_steps,priority=excluded.priority,updated_at=excluded.updated_at`);
  let imported = 0;
  let skipped = 0;
  let structured = 0;
  const officeKeys = new Set<string>();
  const importedSheets: string[] = [];
  db.database.exec("BEGIN");
  try {
    for (const [sheetIndex, sheet] of workbook.worksheets.entries()) {
      let headerRow = 0;
      let columns: Partial<Record<ImportField, number>> = {};
      for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 30); rowNumber += 1) {
        const found: Partial<Record<ImportField, number>> = {};
        sheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
          const header = normaliseHeader(cell.text);
          for (const [field, names] of Object.entries(CASE_IMPORT_ALIASES) as Array<[ImportField, string[]]>) {
            if (!found[field] && names.some((name) => normaliseHeader(name) === header)) found[field] = columnNumber;
          }
        });
        if (found.question && found.expected) { headerRow = rowNumber; columns = found; break; }
      }
      if (!headerRow) continue;
      importedSheets.push(sheet.name);
      let lastIndustry = sheet.name;
      let lastSubIndustry = "";
      let lastRole = "";
      for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        const rawType = cellText(row, columns.caseType);
        const query = cellText(row, columns.question);
        const expected = cellText(row, columns.expected);
        if (!rawType && !query && !expected) continue;
        if (!query || !expected) { skipped += 1; continue; }
        const suppliedCode = columns.code ? cellText(row, columns.code) : "";
        let code = projectCaseCode(project, suppliedCode, imported + 1);
        const conflict = db.row<{ source_sheet_name: string }>("SELECT source_sheet_name FROM cases WHERE project_id=? AND code=?", projectId, code);
        if (conflict && conflict.source_sheet_name && conflict.source_sheet_name !== sheet.name) code = `${code}-S${sheetIndex + 1}`;
        const category = columns.category ? cellText(row, columns.category) : sheet.name;
        const maxTurns = Math.max(1, Number.parseInt(cellText(row, columns.maxTurns), 10) || 1);
        const priority = normalisePriority(cellText(row, columns.priority));
        const caseType = rawType ? parseCaseType(rawType, sheet.name, rowNumber) : "single_turn";
        const conversationLabel = cellText(row, columns.conversation);
        const conversation = parseConversationIdentity(suppliedCode || code, conversationLabel, caseType);
        const inputMode = detectInputMode(query);
        const browserSteps = inputMode === "topic_click"
          ? JSON.stringify([{ action: "click", target: extractTopicTarget(query), description: "点击 Topic 场景" }]) : "[]";
        const criteria = cellText(row, columns.criteria);
        lastIndustry = (columns.industry ? cellText(row, columns.industry) : "") || lastIndustry;
        lastSubIndustry = (columns.subIndustry ? cellText(row, columns.subIndustry) : "") || lastSubIndustry;
        lastRole = (columns.role ? cellText(row, columns.role) : "") || lastRole;
        const hasOfficeHierarchy = Boolean(lastIndustry && lastSubIndustry && lastRole);
        const officeKey = hasOfficeHierarchy ? officeIdentityKey(lastIndustry, lastSubIndustry, lastRole) : "";
        const officeName = hasOfficeHierarchy ? `${lastIndustry}_${lastSubIndustry}_${lastRole}` : "";
        const hasOfficeColumns = Boolean(columns.industry || columns.subIndustry || columns.role);
        const sourceFields = readSourceFields(sheet.getRow(headerRow), row);
        const requiredTools = splitToolNames(cellText(row, columns.requiredTools));
        const orderTools = splitToolNames(cellText(row, columns.toolOrder));
        const expectedTrace: EvalCase["expected_trace"] = {
          required_tools: orderTools.length ? orderTools : requiredTools,
          forbidden_tools: splitToolNames(cellText(row, columns.forbiddenTools)),
          ordered: orderTools.length > 0,
          parameter_constraints: cellText(row, columns.toolParameters),
          max_tool_calls: columns.maxToolCalls ? (Number.parseInt(cellText(row, columns.maxToolCalls), 10) || null) : null,
          notes: cellText(row, columns.traceNotes),
        };
        const title = cellText(row, columns.title) || query.slice(0, 42);
        const approved = hasOfficeColumns ? 1 : 0;
        insert.run(projectId, code, category || sheet.name, title, query, expected, "[]", "[]", "[]", maxTurns, priority, approved,
          hasOfficeColumns ? "browser" : "dialogue", project.target_base_url || "", browserSteps, sheet.name, suppliedCode || code, rowNumber,
          hasOfficeHierarchy ? lastIndustry : "", hasOfficeHierarchy ? lastSubIndustry : "", hasOfficeHierarchy ? lastRole : "",
          officeKey, officeName, caseType, conversation.group, conversation.round, inputMode, criteria, timestamp, timestamp);
        db.execute("UPDATE cases SET source_fields_json=?,expected_trace_json=?,approved=? WHERE project_id=? AND code=?",
          JSON.stringify(sourceFields), JSON.stringify(expectedTrace), approved, projectId, code);
        if (evaluationSetId) {
          const saved = db.row<{ id: number }>("SELECT id FROM cases WHERE project_id=? AND code=?", projectId, code);
          if (saved) attachCaseToEvaluationSet(evaluationSetId, saved.id);
        }
        if (officeKey) { structured += 1; officeKeys.add(officeKey); }
        imported += 1;
      }
    }
    db.database.exec("COMMIT");
  } catch (error) { db.database.exec("ROLLBACK"); throw error; }
  if (!imported) throw new Error("没有找到有效用例。每条用例都需要“用户输入”和“预期系统行为 / 黄金答案”");
  return { filename, sheets: importedSheets, imported, skipped, structured, unassigned: imported - structured,
    office_count: officeKeys.size, source_workbook_path: storedPath, schema: inspection, cases: listCases(projectId, evaluationSetId) };
}

function splitToolNames(value: string): string[] {
  return value.split(/[,，、;；\n→]+/).map((item) => item.trim()).filter(Boolean);
}

function parseCaseType(value: string, sheetName: string, rowNumber: number): EvalCase["case_type"] {
  const normalised = normaliseHeader(value);
  if (/多轮|连续对话|上下文/.test(normalised)) return "multi_turn";
  if (/普通|单轮|独立对话/.test(normalised)) return "single_turn";
  throw new Error(`“${sheetName}”第 ${rowNumber} 行的用例类型“${value}”无法识别；请填写“普通对话用例”或“多轮对话用例”`);
}

function parseConversationIdentity(code: string, label: string, caseType: EvalCase["case_type"]): { group: string; round: number } {
  if (caseType === "single_turn") return { group: "", round: 1 };
  const source = `${code} ${label}`;
  const idMatch = source.match(/(?:^|[-_\s])(M[\p{L}\p{N}-]+?)(?:[-_\s]+R(\d+))(?:$|[-_\s])/iu) || source.match(/\b(M\d+)[-_]?R(\d+)\b/i);
  const roundMatch = source.match(/第\s*(\d+)\s*轮/i) || source.match(/\bR(\d+)\b/i);
  const group = String(idMatch?.[1] || source.match(/\bM\d+\b/i)?.[0] || "").toUpperCase();
  const round = Math.max(1, Number.parseInt(String(idMatch?.[2] || roundMatch?.[1] || "1"), 10) || 1);
  if (!group) throw new Error(`多轮用例“${code}”缺少对话组；请在用例ID或“对话组/轮次”中填写类似 M01-R01`);
  return { group, round };
}

function detectInputMode(query: string): EvalCase["input_mode"] {
  return /点击[\s“”'\"]*[^\n]*topic|topic[^\n]*点击/i.test(query) ? "topic_click" : "message";
}

function extractTopicTarget(query: string): string {
  return query.match(/[“"]([^”"]+)[”"]/u)?.[1]?.replace(/topic/ig, "").trim()
    || query.replace(/[（）()]/g, "").replace(/点击/gi, "").replace(/topic/gi, "").trim();
}

function normalisePriority(value: string): EvalCase["priority"] {
  const match = value.toUpperCase().match(/P[012]/)?.[0];
  return (match || "P1") as EvalCase["priority"];
}

function officeIdentityKey(industry: string, subIndustry: string, role: string): string {
  return [industry, subIndustry, role].map((value) => String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("zh-CN")).join("\u001f");
}

function normaliseHeader(value: string): string {
  return String(value || "").toLowerCase().replace(/[\s_\-：:（）()]/g, "");
}

function cellText(row: ExcelJS.Row, column?: number): string {
  return column ? String(row.getCell(column).text || "").trim() : "";
}

function readSourceFields(headerRow: ExcelJS.Row, dataRow: ExcelJS.Row): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const seen = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (headerCell, columnNumber) => {
    const original = headerCell.text.trim();
    if (!original) return;
    const occurrence = (seen.get(original) || 0) + 1;
    seen.set(original, occurrence);
    const name = occurrence === 1 ? original : `${original} (${occurrence})`;
    const cell = dataRow.getCell(columnNumber);
    const value = cell.value;
    fields[name] = typeof value === "number" || typeof value === "boolean" ? value
      : value instanceof Date ? value.toISOString() : cell.text.trim();
  });
  return fields;
}

function projectCaseCode(project: Project, supplied: string, sequence: number): string {
  const prefix = project.project_key || `PRJ-${project.id}`;
  const raw = supplied.toUpperCase().replace(/[^A-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return raw ? (raw.startsWith(`${prefix}-`) ? raw : `${prefix}-${raw}`) : `${prefix}-${String(sequence).padStart(3, "0")}`;
}

export async function invokeProjectHarness(action: "clarify" | "generate_cases" | "evaluate" | "diagnose", project: Project,
  run?: Record<string, unknown>): Promise<HarnessOutput> {
  const requestedId = typeof run?.judge_model_id === "string" ? run.judge_model_id : undefined;
  const judgeModel = judgeModels.selected(project.id, requestedId);
  const result = await runHarness({ action, project, run, judgeModel });
  if (!result.ok) throw new Error(result.error || "pi Agent 执行失败");
  db.execute(
    "INSERT INTO harness_events(project_id,action,mode,trace_json,output_json,created_at) VALUES(?,?,?,?,?,?)",
    project.id, action, result.trace?.mode || "mock", JSON.stringify(result.trace || {}), JSON.stringify(result), db.nowIso(),
  );
  return result;
}

export async function recordBrowserResult(projectId: number, caseId: number, answer: string,
  trace: Array<Record<string, unknown>>, latencyMs: number, screenshot?: string, batchId?: number,
  screenshots: string[] = screenshot ? [screenshot] : []): Promise<Record<string, unknown>> {
  const project = db.row<Project>("SELECT * FROM projects WHERE id=?", projectId);
  const evalCaseRecord = db.row<Record<string, unknown>>("SELECT * FROM cases WHERE id=? AND project_id=?", caseId, projectId);
  if (!project || !evalCaseRecord) throw new Error("评测项目或测试用例不存在");
  const evalCase = hydrateCase(evalCaseRecord);
  const startedAt = new Date(Date.now() - Math.max(0, latencyMs)).toISOString();
  const runId = db.execute("INSERT INTO runs(project_id,case_id,adapter,status,session_id,started_at,batch_id) VALUES(?,?,?,?,?,?,?)",
    projectId, caseId, "browser", "running", String(trace.find((item) => item.session_id)?.session_id || ""), startedAt, batchId || null);
  saveMessage(runId, 1, "user", evalCase.query, 0, []);
  saveMessage(runId, 1, "assistant", answer, latencyMs, []);
  try {
    const rule = evaluate(evalCase, answer, { total_latency_ms: latencyMs, turn_count: 1 });
    const result = await invokeProjectHarness("evaluate", project, {
      case: evalCase, answer, browser_trace: trace, screenshot: screenshot || "", rule_score: rule,
      instruction: "基于 Agent 定位、预期能力和实际回复进行语义判断。凡声称不具备或无证据支持的能力，必须记录为 hallucinations；不得只按关键词判分。",
    });
    const judgement = result.evaluation;
    const detail: ScoreDetail = judgement ? {
      ...rule, score: judgement.score, passed: judgement.passed && judgement.hallucinations.length === 0,
      violations: [...rule.violations, ...judgement.hallucinations], reasons: [judgement.reason],
      semantic_evaluation: { capability_matches: judgement.capability_matches, missing_capabilities: judgement.missing_capabilities,
        hallucinations: judgement.hallucinations, evidence: judgement.evidence, reason: judgement.reason, evaluator_mode: result.trace?.mode },
    } : rule;
    db.execute(`UPDATE runs SET status='completed',score=?,passed=?,total_latency_ms=?,turn_count=1,summary=?,score_detail=?,screenshot_path=?,screenshot_paths=?,finished_at=? WHERE id=?`,
      detail.score, detail.passed ? 1 : 0, latencyMs, detail.reasons.join("；"), JSON.stringify(detail), screenshot || "", JSON.stringify(screenshots), db.nowIso(), runId);
  } catch (error) {
    db.execute("UPDATE runs SET status='failed',summary=?,finished_at=? WHERE id=?", error instanceof Error ? error.message : String(error), db.nowIso(), runId);
  }
  const saved = getRun(runId);
  writeResultArtifact(screenshot || "", saved);
  return saved;
}

export async function clarifyProject(project: Project): Promise<Record<string, unknown>> {
  const result = await invokeProjectHarness("clarify", project);
  const questions = result.questions || [];
  return { questions, ready: questions[0]?.field === "done", trace: result.trace };
}

export function saveCaseProposals(projectId: number, proposals: ProposedCase[], evaluationSetId?: number): void {
  const project = db.row<Project>("SELECT * FROM projects WHERE id=?", projectId);
  if (!project) throw new Error("评测项目不存在");
  const prefix = project.project_key || `PRJ-${projectId}`;
  const insert = db.database.prepare(`INSERT INTO cases(project_id,code,category,title,query,expected_answer,expected_keywords,
    forbidden_keywords,followups,max_turns,priority,approved,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id,code) DO NOTHING`);
  const timestamp = db.nowIso();
  db.database.exec("BEGIN");
  try {
    for (const [index, item] of proposals.entries()) {
      const rawCode = String(item.code || `${index + 1}`).toUpperCase().replace(/[^A-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      const code = rawCode.startsWith(`${prefix}-`) ? rawCode : `${prefix}-${rawCode || String(index + 1).padStart(3, "0")}`;
      insert.run(
      projectId, code, item.category, item.title, item.query, item.expected_answer,
      JSON.stringify(item.expected_keywords), JSON.stringify(item.forbidden_keywords), JSON.stringify(item.followups),
      item.max_turns, item.priority, 0, timestamp, timestamp,
      );
      if (evaluationSetId) {
        const saved = db.row<{ id: number }>("SELECT id FROM cases WHERE project_id=? AND code=?", projectId, code);
        if (saved) attachCaseToEvaluationSet(evaluationSetId, saved.id);
      }
    }
    db.database.exec("COMMIT");
  } catch (error) { db.database.exec("ROLLBACK"); throw error; }
}

export async function generateCasesWithPi(project: Project, evaluationSetId?: number): Promise<EvalCase[]> {
  const result = await invokeProjectHarness("generate_cases", project);
  if (!result.cases?.length) throw new Error("pi Agent 没有提交候选测试用例");
  saveCaseProposals(project.id, result.cases, evaluationSetId);
  return listCases(project.id, evaluationSetId);
}

export function seedCases(projectId: number): void {
  const templates: ProposedCase[] = [
    { code: "LUI-001", category: "核心能力", title: "直接查询核心信息", query: "请查询我当前工作区可用的全部文件列表。", expected_answer: "应返回当前工作区的完整文件列表，并说明结果范围。", expected_keywords: ["文件", "列表"], forbidden_keywords: ["已删除"], followups: [], max_turns: 2, priority: "P0" },
    { code: "LUI-002", category: "多轮澄清", title: "信息不足时主动追问", query: "帮我查一下那个项目的资料。", expected_answer: "应先询问项目名称或查询范围，再根据补充信息执行查询。", expected_keywords: ["项目", "范围"], forbidden_keywords: ["随便选了一个"], followups: ["项目名是 Agent 自动化评测系统，查询全部相关资料。"], max_turns: 3, priority: "P0" },
    { code: "LUI-003", category: "边界与兜底", title: "超出能力范围时明确说明", query: "请帮我修改一个你没有访问权限的外部系统数据。", expected_answer: "应明确说明权限限制，不得声称已经修改，并给出可行的下一步建议。", expected_keywords: ["权限", "限制"], forbidden_keywords: ["已经修改成功"], followups: [], max_turns: 2, priority: "P0" },
    { code: "LUI-004", category: "长尾表达", title: "口语化表达理解", query: "我这儿都有啥文件，给我一次性捋清楚。", expected_answer: "应理解为查询全部文件列表，完整返回并使用清晰结构展示。", expected_keywords: ["全部", "文件", "列表"], forbidden_keywords: [], followups: [], max_turns: 2, priority: "P1" },
  ];
  saveCaseProposals(projectId, templates);
}

export async function runCases(projectId: number, caseIds: number[], adapterName: TargetAdapter,
  target?: OfficeAgentConfig, batchId?: number, workflowMode: WorkflowMode = "live_eval",
  browserOptions: { newConversation?: boolean } = {}): Promise<Record<string, unknown>[]> {
  if (adapterName === "office_agent") new OfficeAgent(target || { base_url: "", agent_id: "" });
  const allowed = new Set(caseIds);
  const selected = listCases(projectId).filter((item) => caseIds.length ? allowed.has(item.id) : Boolean(item.approved));
  if (adapterName === "browser") {
    if (!selected.length) throw new Error("没有可执行的已审核用例");
    const browserProject = db.row<Project>("SELECT * FROM projects WHERE id=?", projectId);
    if (!browserProject) throw new Error("评测项目不存在");
    const browserResults: Record<string, unknown>[] = [];
    const explicitBrowserCases = selected.filter((item) => item.execution_type !== "dialogue");
    const browserSelection = explicitBrowserCases.length ? explicitBrowserCases : selected;
    for (const original of browserSelection) {
      const evalCase = { ...original, start_url: original.start_url || browserProject.target_base_url };
      try {
        const captured = await runBrowserDialogue(evalCase, browserProject.project_key, browserOptions);
        browserResults.push(workflowMode === "collect_first"
          ? recordBrowserCollection(projectId, evalCase.id, captured.answer, captured.trace, captured.latency_ms, captured.screenshots, batchId)
          : await recordBrowserResult(projectId, evalCase.id, captured.answer, captured.trace,
            captured.latency_ms, captured.screenshot, batchId, captured.screenshots));
      } catch (error) {
        browserResults.push(recordBrowserFailure(projectId, evalCase.id, error, batchId));
      }
    }
    return browserResults;
  }
  const browserCases = selected.filter((item) => item.execution_type !== "dialogue");
  if (browserCases.length) throw new Error(`已选择 ${browserCases.length} 条浏览器/混合用例；请先连接浏览器执行器，系统不会把它们误当作普通对话 API 执行`);
  if (!selected.length) throw new Error("没有可执行的已审核用例");
  const project = db.row<Project>("SELECT * FROM projects WHERE id=?", projectId);
  if (!project) throw new Error("评测项目不存在");
  const results: Record<string, unknown>[] = [];
  for (const evalCase of selected) results.push(await runOneCase(project, evalCase, adapterName, target, batchId));
  return results;
}

function recordBrowserFailure(projectId: number, caseId: number, error: unknown, batchId?: number): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const screenshot = error instanceof BrowserDialogueError ? error.screenshot : "";
  const timestamp = db.nowIso();
  const runId = db.execute("INSERT INTO runs(project_id,case_id,adapter,status,summary,screenshot_path,screenshot_paths,started_at,finished_at,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
    projectId, caseId, "browser", "failed", message, screenshot, JSON.stringify(screenshot ? [screenshot] : []), timestamp, timestamp, batchId || null);
  const saved = getRun(runId);
  writeResultArtifact(screenshot, saved);
  return saved;
}

function recordBrowserCollection(projectId: number, caseId: number, answer: string,
  trace: Array<Record<string, unknown>>, latencyMs: number, screenshots: string[], batchId?: number): Record<string, unknown> {
  const record = db.row<Record<string, unknown>>("SELECT * FROM cases WHERE id=? AND project_id=?", caseId, projectId);
  if (!record) throw new Error("测试用例不存在");
  const evalCase = hydrateCase(record);
  const startedAt = new Date(Date.now() - Math.max(0, latencyMs)).toISOString();
  const first = screenshots[0] || "";
  const runId = db.execute(`INSERT INTO runs(project_id,case_id,adapter,status,total_latency_ms,turn_count,summary,screenshot_path,
    screenshot_paths,session_id,started_at,finished_at,batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, projectId, caseId, "browser", "collected",
    latencyMs, 1, "回答与截图已采集，等待统一评测", first, JSON.stringify(screenshots), String(trace.find((item) => item.session_id)?.session_id || ""),
    startedAt, db.nowIso(), batchId || null);
  saveMessage(runId, 1, "user", evalCase.query, 0, []);
  saveMessage(runId, 1, "assistant", answer, latencyMs, []);
  const saved = getRun(runId);
  writeResultArtifact(first, saved);
  return saved;
}

async function runOneCase(project: Project, evalCase: EvalCase, adapterName: TargetAdapter,
  target?: OfficeAgentConfig, batchId?: number): Promise<Record<string, unknown>> {
  let sessionId = `eval-${project.id}-${evalCase.id}-${randomUUID()}`;
  const runId = db.execute("INSERT INTO runs(project_id,case_id,adapter,status,session_id,started_at,batch_id) VALUES(?,?,?,?,?,?,?)",
    project.id, evalCase.id, adapterName, "running", sessionId, db.nowIso(), batchId || null);
  try {
    if (adapterName === "office_agent") {
      sessionId = await createOfficeSession(target || { base_url: "", agent_id: "" });
      db.execute("UPDATE runs SET session_id=? WHERE id=?", sessionId, runId);
    }
    const agent: DialogueAgent = adapterName === "mock" ? new MockDialogueAgent()
      : adapterName === "office_agent" ? new OfficeAgent({ ...(target || { base_url: "", agent_id: "" }), session_id: sessionId })
      : new OpenAICompatibleAgent();
    await agent.reset(evalCase);
    const conversation = [{ role: "user", content: evalCase.query }];
    saveMessage(runId, 1, "user", evalCase.query, 0, []);
    let totalLatency = 0, toolCount = 0, turns = 0, finalAnswer = "";
    for (let turn = 1; turn <= evalCase.max_turns; turn += 1) {
      const tick = performance.now();
      const reply: AgentReply = await agent.reply(conversation);
      const latency = Math.round(performance.now() - tick);
      totalLatency += latency; toolCount += reply.tool_calls.length; turns += 1; finalAnswer = reply.content;
      conversation.push({ role: "assistant", content: reply.content });
      saveMessage(runId, turn, "assistant", reply.content, latency, reply.tool_calls);
      const followup = evalCase.followups[turn - 1];
      if (!followup) break;
      conversation.push({ role: "user", content: followup });
      saveMessage(runId, turn + 1, "user", followup, 0, []);
    }
    const metrics = { total_latency_ms: totalLatency, turn_count: turns, tool_call_count: toolCount };
    const detail: ScoreDetail = evaluate(evalCase, finalAnswer, metrics);
    if (!detail.passed) {
      try {
        const result = await invokeProjectHarness("diagnose", project, { case: evalCase, answer: finalAnswer, metrics, rule_score: detail });
        if (result.diagnosis) { detail.pi_diagnosis = result.diagnosis; detail.reasons.push(`pi Agent 归因：${result.diagnosis.root_cause}`); }
      } catch (error) { detail.reasons.push(`pi Agent 归因失败：${error instanceof Error ? error.message : String(error)}`); }
    }
    db.execute(`UPDATE runs SET status='completed',score=?,passed=?,total_latency_ms=?,turn_count=?,tool_call_count=?,
      summary=?,score_detail=?,finished_at=? WHERE id=?`, detail.score, detail.passed ? 1 : 0, totalLatency, turns, toolCount,
      detail.reasons.join("；"), JSON.stringify(detail), db.nowIso(), runId);
  } catch (error) {
    db.execute("UPDATE runs SET status='failed',summary=?,finished_at=? WHERE id=?", error instanceof Error ? error.message : String(error), db.nowIso(), runId);
  }
  return getRun(runId);
}

function parseBrowserSteps(value: unknown): EvalCase["browser_steps"] {
  try {
    const parsed = Array.isArray(value) ? value : JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveMessage(runId: number, turn: number, role: string, content: string, latency: number, tools: Array<Record<string, unknown>>): void {
  db.execute("INSERT INTO messages(run_id,turn_index,role,content,latency_ms,tool_calls,created_at) VALUES(?,?,?,?,?,?,?)",
    runId, turn, role, content, latency, JSON.stringify(tools), db.nowIso());
}

export function getRun(runId: number): Record<string, unknown> {
  const result = db.row<Record<string, unknown>>(`SELECT r.*,c.code,c.title,c.query,c.expected_answer,c.evaluation_criteria,
    c.case_type,c.conversation_group,c.conversation_round,c.input_mode FROM runs r
    JOIN cases c ON c.id=r.case_id WHERE r.id=?`, runId);
  if (!result) throw new Error("执行记录不存在");
  try { result.score_detail = JSON.parse(String(result.score_detail || "{}")); } catch { result.score_detail = {}; }
  try { result.screenshot_paths = JSON.parse(String(result.screenshot_paths || "[]")); } catch { result.screenshot_paths = []; }
  result.messages = db.rows<Record<string, unknown>>("SELECT * FROM messages WHERE run_id=? ORDER BY id", runId).map((item) => {
    try { item.tool_calls = JSON.parse(String(item.tool_calls || "[]")); } catch { item.tool_calls = []; }
    return item;
  });
  return result;
}

export function createEvaluationBatch(projectId: number, adapter: TargetAdapter, caseIds: number[], workflowMode: WorkflowMode = "live_eval"): number {
  return db.execute(`INSERT INTO evaluation_batches(project_id,adapter,status,source,selected_case_ids,total,workflow_mode,evaluation_status,started_at)
    VALUES(?,?,?,?,?,?,?,?,?)`, projectId, adapter, "running", "live", JSON.stringify(caseIds), caseIds.length, workflowMode,
    workflowMode === "collect_first" ? "pending" : "running", db.nowIso());
}

export function finishEvaluationBatch(batchId: number, status: "completed" | "failed" = "completed"): void {
  const totals = db.row<{ completed: number; passed: number; failed: number }>(`SELECT
    SUM(CASE WHEN status IN ('completed','collected') THEN 1 ELSE 0 END) completed,
    SUM(CASE WHEN status='completed' AND passed=1 THEN 1 ELSE 0 END) passed,
    SUM(CASE WHEN status='failed' OR (status='completed' AND passed=0) THEN 1 ELSE 0 END) failed FROM runs WHERE batch_id=?`, batchId);
  db.execute(`UPDATE evaluation_batches SET status=?,completed=?,passed=?,failed=?,finished_at=? WHERE id=?`, status,
    Number(totals?.completed || 0), Number(totals?.passed || 0), Number(totals?.failed || 0), db.nowIso(), batchId);
}

export function listEvaluationBatches(projectId: number, limit = 20): Array<Record<string, unknown>> {
  return db.rows<Record<string, unknown>>(`SELECT b.*,
    ROUND(CASE WHEN b.completed>0 THEN b.passed*100.0/b.completed ELSE 0 END,1) pass_rate,
    ROUND(COALESCE((SELECT AVG(r.score) FROM runs r WHERE r.batch_id=b.id AND r.status='completed'),0),1) avg_score
    FROM evaluation_batches b WHERE b.project_id=? ORDER BY b.id DESC LIMIT ?`, projectId, limit);
}

export function getEvaluationBatch(batchId: number): Record<string, unknown> {
  const batch = db.row<Record<string, unknown>>(`SELECT b.*,p.name project_name,p.project_key FROM evaluation_batches b
    JOIN projects p ON p.id=b.project_id WHERE b.id=?`, batchId);
  if (!batch) throw new Error("评测批次不存在");
  batch.runs = db.rows<Record<string, unknown>>(`SELECT r.*,c.code,c.title,c.category,c.query,c.expected_answer,c.evaluation_criteria,
    c.case_type,c.conversation_group,c.conversation_round,c.input_mode,c.source_sheet_name,c.source_case_code,
    (SELECT m.content FROM messages m WHERE m.run_id=r.id AND m.role='assistant' ORDER BY m.id DESC LIMIT 1) actual_answer FROM runs r
    JOIN cases c ON c.id=r.case_id WHERE r.batch_id=? ORDER BY r.id`, batchId).map((run) => {
      try { run.screenshot_paths = JSON.parse(String(run.screenshot_paths || "[]")); } catch { run.screenshot_paths = []; }
      return run;
    });
  return batch;
}

export async function finaliseCollectedWorkbook(batchId: number): Promise<string> {
  const batch = db.row<{ id: number; project_id: number }>("SELECT id,project_id FROM evaluation_batches WHERE id=?", batchId);
  if (!batch) throw new Error("评测批次不存在");
  const project = db.row<Project>("SELECT * FROM projects WHERE id=?", batch.project_id);
  if (!project) throw new Error("评测项目不存在");
  const configuredMaster = Number(project.evidence_master_batch_id || 0);
  const master = configuredMaster
    ? db.row<{ id: number }>("SELECT id FROM evaluation_batches WHERE id=? AND project_id=?", configuredMaster, batch.project_id)
    : undefined;
  const targetBatchId = master?.id || batchId;
  const sourceBatchIds = db.rows<{ id: number }>(`SELECT DISTINCT b.id FROM evaluation_batches b
    JOIN runs r ON r.batch_id=b.id WHERE b.project_id=? AND b.workflow_mode='collect_first'
    AND r.status IN ('collected','completed') ORDER BY b.id`, batch.project_id).map((item) => item.id);
  const result = targetBatchId === batchId && sourceBatchIds.length === 1
    ? await buildEvidenceWorkbook(batchId)
    : await buildCombinedEvidenceWorkbook(targetBatchId, sourceBatchIds);
  if (batchId !== targetBatchId) {
    db.execute("UPDATE evaluation_batches SET result_workbook_path=? WHERE id=?", result, batchId);
  }
  return result;
}

export async function evaluateCollectedBatch(batchId: number): Promise<Record<string, unknown>> {
  const batch = db.row<Record<string, unknown>>("SELECT * FROM evaluation_batches WHERE id=?", batchId);
  if (!batch || batch.workflow_mode !== "collect_first") throw new Error("该批次不是“先采集、后补评”流程");
  const project = db.row<Project>("SELECT * FROM projects WHERE id=?", Number(batch.project_id));
  if (!project) throw new Error("评测项目不存在");
  const runs = db.rows<Record<string, unknown>>(`SELECT r.id run_id,r.total_latency_ms,c.* FROM runs r JOIN cases c ON c.id=r.case_id
    WHERE r.batch_id=? AND r.status='collected' ORDER BY r.id`, batchId);
  if (!runs.length) throw new Error("本批次没有待评测的已采集回答");
  db.execute("UPDATE evaluation_batches SET evaluation_status='running' WHERE id=?", batchId);
  try {
    for (const run of runs) {
      const runId = Number(run.run_id);
      const evalCase = hydrateCase(run);
      const message = db.row<{ content: string }>("SELECT content FROM messages WHERE run_id=? AND role='assistant' ORDER BY id DESC LIMIT 1", runId);
      const answer = message?.content || "";
      const rule = evaluate(evalCase, answer, { total_latency_ms: Number(run.total_latency_ms || 0), turn_count: 1 });
      const result = await invokeProjectHarness("evaluate", project, { case: evalCase, answer, rule_score: rule,
        instruction: "根据预期回答要点判断实际回复是否合格，并明确记录遗漏、事实错误和幻觉。" });
      const judgement = result.evaluation;
      const detail: ScoreDetail = judgement ? { ...rule, score: judgement.score,
        passed: judgement.passed && judgement.hallucinations.length === 0,
        violations: [...rule.violations, ...judgement.hallucinations], reasons: [judgement.reason],
        semantic_evaluation: { capability_matches: judgement.capability_matches, missing_capabilities: judgement.missing_capabilities,
          hallucinations: judgement.hallucinations, evidence: judgement.evidence, reason: judgement.reason, evaluator_mode: result.trace?.mode } } : rule;
      db.execute("UPDATE runs SET status='completed',score=?,passed=?,summary=?,score_detail=?,finished_at=? WHERE id=?",
        detail.score, detail.passed ? 1 : 0, detail.reasons.join("；"), JSON.stringify(detail), db.nowIso(), runId);
    }
    db.execute("UPDATE evaluation_batches SET evaluation_status='completed' WHERE id=?", batchId);
    finishEvaluationBatch(batchId, "completed");
    return getEvaluationBatch(batchId);
  } catch (error) {
    db.execute("UPDATE evaluation_batches SET evaluation_status='failed' WHERE id=?", batchId);
    throw error;
  }
}

export function projectSummary(projectId: number): ProjectSummary {
  const cases = db.row<{ total: number; approved: number | null }>("SELECT COUNT(*) total,SUM(approved) approved FROM cases WHERE project_id=?", projectId);
  const runs = db.row<{ total: number; passed: number | null; avg_score: number | null; avg_latency: number | null }>(
    "SELECT COUNT(*) total,SUM(passed) passed,ROUND(AVG(score),1) avg_score,ROUND(AVG(total_latency_ms),0) avg_latency FROM runs WHERE project_id=? AND status='completed'", projectId);
  const total = Number(runs?.total || 0), passed = Number(runs?.passed || 0);
  return { cases: { total: Number(cases?.total || 0), approved: Number(cases?.approved || 0) },
    runs: { total, passed, pass_rate: total ? Math.round(passed / total * 1000) / 10 : 0,
      avg_score: Number(runs?.avg_score || 0), avg_latency: Number(runs?.avg_latency || 0) } };
}
