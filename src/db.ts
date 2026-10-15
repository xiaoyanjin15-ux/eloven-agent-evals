import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DB_PATH = process.env.AGENT_EVAL_DB || join(ROOT, "data", "agent_evals.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const database = new DatabaseSync(DB_PATH, { timeout: 20_000 });
database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

export function nowIso(): string {
  return new Date().toISOString();
}

export function initDb(): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_key TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, agent_type TEXT NOT NULL DEFAULT 'dialogue',
      background TEXT NOT NULL DEFAULT '', capabilities TEXT NOT NULL DEFAULT '', boundaries TEXT NOT NULL DEFAULT '',
      scoring_standard TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
      target_adapter TEXT NOT NULL DEFAULT 'mock', target_base_url TEXT NOT NULL DEFAULT '',
      target_agent_id TEXT NOT NULL DEFAULT '', target_profile TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      code TEXT NOT NULL, category TEXT NOT NULL, title TEXT NOT NULL, query TEXT NOT NULL,
      expected_answer TEXT NOT NULL DEFAULT '', expected_keywords TEXT NOT NULL DEFAULT '[]',
      forbidden_keywords TEXT NOT NULL DEFAULT '[]', followups TEXT NOT NULL DEFAULT '[]', max_turns INTEGER NOT NULL DEFAULT 3,
      priority TEXT NOT NULL DEFAULT 'P1', approved INTEGER NOT NULL DEFAULT 0,
      execution_type TEXT NOT NULL DEFAULT 'dialogue', start_url TEXT NOT NULL DEFAULT '', browser_steps TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id, code)
    );
    CREATE TABLE IF NOT EXISTS evaluation_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id, name)
    );
    CREATE TABLE IF NOT EXISTS evaluation_set_cases (
      evaluation_set_id INTEGER NOT NULL REFERENCES evaluation_sets(id) ON DELETE CASCADE,
      case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      PRIMARY KEY(evaluation_set_id, case_id)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE, adapter TEXT NOT NULL, status TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0, total_latency_ms INTEGER NOT NULL DEFAULT 0,
      turn_count INTEGER NOT NULL DEFAULT 0, tool_call_count INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '',
      score_detail TEXT NOT NULL DEFAULT '{}', session_id TEXT NOT NULL DEFAULT '', screenshot_path TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS evaluation_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      adapter TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', source TEXT NOT NULL DEFAULT 'live',
      selected_case_ids TEXT NOT NULL DEFAULT '[]', total INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0,
      passed INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      turn_index INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, latency_ms INTEGER NOT NULL DEFAULT 0,
      tool_calls TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS harness_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      action TEXT NOT NULL, mode TEXT NOT NULL, trace_json TEXT NOT NULL DEFAULT '{}', output_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_evaluation_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      group_type TEXT NOT NULL CHECK(group_type IN ('evaluation_set','custom','uncategorized')),
      evaluation_set_id INTEGER REFERENCES evaluation_sets(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id,evaluation_set_id)
    );
    CREATE TABLE IF NOT EXISTS agent_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
      run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      source TEXT NOT NULL, trace_id TEXT NOT NULL, trace_json TEXT NOT NULL,
      expectations_json TEXT NOT NULL DEFAULT '{}', result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(project_id,source,trace_id)
    );
    CREATE TABLE IF NOT EXISTS office_mappings (
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      office_key TEXT NOT NULL, generated_name TEXT NOT NULL DEFAULT '', actual_office_name TEXT NOT NULL DEFAULT '',
      actual_office_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, office_key)
    );
  `);
  ensureColumn("projects", "target_adapter", "TEXT NOT NULL DEFAULT 'mock'");
  ensureColumn("projects", "project_key", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("projects", "target_base_url", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("projects", "target_agent_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("projects", "target_profile", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("projects", "source_workbook_path", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("projects", "source_workbook_name", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("projects", "evidence_master_batch_id", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("cases", "execution_type", "TEXT NOT NULL DEFAULT 'dialogue'");
  ensureColumn("cases", "start_url", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("cases", "browser_steps", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("cases", "source_sheet_name", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("cases", "source_case_code", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("cases", "source_row_number", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("cases", "office_industry", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("cases", "office_subindustry", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("cases", "office_role", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("cases", "office_key", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("cases", "office_name", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("cases", "case_type", "TEXT NOT NULL DEFAULT 'single_turn'");
  ensureColumn("cases", "conversation_group", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("cases", "conversation_round", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("cases", "input_mode", "TEXT NOT NULL DEFAULT 'message'");
  ensureColumn("cases", "evaluation_criteria", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("cases", "source_fields_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("cases", "expected_trace_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("runs", "session_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("runs", "screenshot_path", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("runs", "batch_id", "INTEGER");
  ensureColumn("runs", "screenshot_paths", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("evaluation_batches", "workflow_mode", "TEXT NOT NULL DEFAULT 'live_eval'");
  ensureColumn("evaluation_batches", "evaluation_status", "TEXT NOT NULL DEFAULT 'completed'");
  ensureColumn("evaluation_batches", "result_workbook_path", "TEXT NOT NULL DEFAULT ''");
  database.exec("UPDATE projects SET project_key='PRJ-' || id WHERE trim(project_key)='' OR project_key IS NULL");
  ensureColumn("agent_evaluations", "group_id", "INTEGER REFERENCES agent_evaluation_groups(id) ON DELETE SET NULL");
  migrateEvaluationSets();
  migrateAgentEvaluationGroups();
  migrateLegacyRuns();
}

function migrateAgentEvaluationGroups(): void {
  const timestamp = nowIso();
  database.prepare(`INSERT INTO agent_evaluation_groups(project_id,name,group_type,created_at,updated_at)
    SELECT DISTINCT a.project_id,?,'uncategorized',?,? FROM agent_evaluations a
    WHERE a.group_id IS NULL AND NOT EXISTS
      (SELECT 1 FROM agent_evaluation_groups g WHERE g.project_id=a.project_id AND g.group_type='uncategorized')`)
    .run("未分类", timestamp, timestamp);
  database.exec(`UPDATE agent_evaluations SET group_id=(
    SELECT g.id FROM agent_evaluation_groups g
    WHERE g.project_id=agent_evaluations.project_id AND g.group_type='uncategorized' ORDER BY g.id LIMIT 1)
    WHERE group_id IS NULL`);
}

function migrateEvaluationSets(): void {
  const projects = database.prepare("SELECT id FROM projects ORDER BY id").all() as unknown as Array<{ id: number }>;
  const insertSet = database.prepare(`INSERT INTO evaluation_sets(project_id,name,description,source,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`);
  const attach = database.prepare(`INSERT OR IGNORE INTO evaluation_set_cases(evaluation_set_id,case_id)
    SELECT ?,c.id FROM cases c WHERE c.project_id=? AND NOT EXISTS
    (SELECT 1 FROM evaluation_set_cases m WHERE m.case_id=c.id)`);
  for (const project of projects) {
    let set = database.prepare("SELECT id FROM evaluation_sets WHERE project_id=? ORDER BY id LIMIT 1").get(project.id) as { id: number } | undefined;
    if (!set) {
      const timestamp = nowIso();
      const result = insertSet.run(project.id, "默认评测集", "由项目原有测试用例自动整理", "migration", "published", timestamp, timestamp);
      set = { id: Number(result.lastInsertRowid) };
    }
    attach.run(set.id, project.id);
  }
}

function migrateLegacyRuns(): void {
  const legacy = database.prepare(`SELECT id,project_id,adapter,status,passed,started_at,finished_at FROM runs
    WHERE batch_id IS NULL ORDER BY project_id,started_at,id`).all() as unknown as Array<Record<string, unknown>>;
  if (!legacy.length) return;
  let group: Array<Record<string, unknown>> = [];
  const flush = (): void => {
    if (!group.length) return;
    const first = group[0], last = group.at(-1)!;
    const completed = group.filter((item) => item.status === "completed").length;
    const passed = group.filter((item) => Number(item.passed)).length;
    const failed = group.length - passed;
    const result = database.prepare(`INSERT INTO evaluation_batches(project_id,adapter,status,source,selected_case_ids,total,completed,passed,failed,started_at,finished_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(first.project_id as number, String(first.adapter), "completed", "legacy", "[]",
      group.length, completed, passed, failed, String(first.started_at), String(last.finished_at || last.started_at));
    const batchId = Number(result.lastInsertRowid);
    const update = database.prepare("UPDATE runs SET batch_id=? WHERE id=?");
    for (const item of group) update.run(batchId, item.id as number);
    group = [];
  };
  for (const item of legacy) {
    const previous = group.at(-1);
    const gap = previous ? Date.parse(String(item.started_at)) - Date.parse(String(previous.finished_at || previous.started_at)) : 0;
    if (previous && (item.project_id !== previous.project_id || item.adapter !== previous.adapter || gap > 10 * 60_000)) flush();
    group.push(item);
  }
  flush();
}

function ensureColumn(table: string, column: string, definition: string): void {
  const existing = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (!existing.some((item) => item.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function rows<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return database.prepare(sql).all(...params) as unknown as T[];
}

export function row<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return database.prepare(sql).get(...params) as unknown as T | undefined;
}

export function execute(sql: string, ...params: SQLInputValue[]): number {
  return Number(database.prepare(sql).run(...params).lastInsertRowid);
}

export function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  try { return JSON.parse(String(value || "[]")) as string[]; } catch { return []; }
}
