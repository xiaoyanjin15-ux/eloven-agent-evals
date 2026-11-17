import { randomUUID } from "node:crypto";
import { readCheckpoint, saveCheckpoint } from "./browser-checkpoints.js";
import { recoverLegacyBatch } from "./legacy-browser-resume.js";

import { activateBrowserOffice } from "./browser-runner.js";
import * as db from "./db.js";
import { createEvaluationBatch, finishEvaluationBatch, getRun, listCases, listOfficePlans, runCases } from "./services.js";
import { IncrementalWorkbook, normaliseSaveOptions, type SaveOptions, type SavedWorkbook, type WorkbookCheckpoint } from "./incremental-workbook.js";
import type { Project, WorkflowMode } from "./domain.js";

export type BrowserJobStatus = "queued" | "running" | "pausing" | "paused" | "completed" | "failed" | "stopped";
export type OfficeRunMode = "auto" | "manual";

export interface BrowserJob {
  id: string;
  project_id: number;
  batch_id: number;
  workflow_mode: WorkflowMode;
  office_mode: OfficeRunMode;
  result_workbook_path?: string;
  save_options: SaveOptions;
  result_files: SavedWorkbook[];
  awaiting_trial_confirmation: boolean;
  stop_requested: boolean;
  trial_results: Array<{ code: string; answer: string; screenshots: string[]; status: string }>;
  status: BrowserJobStatus;
  stage: string;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  current_case_id?: number;
  current_code?: string;
  current_title?: string;
  current_office_key?: string;
  current_office_name?: string;
  pause_requested: boolean;
  error?: string;
  warning?: string;
  created_at: string;
  updated_at: string;
}

const jobs = new Map<string, BrowserJob>();
const resumeWaiters = new Map<string, () => void>();
type JobCase = { id: number; code: string; title: string; office_key: string; office_name: string; start_url: string;
  case_type: "single_turn" | "multi_turn"; conversation_group: string; conversation_round: number };
interface Checkpoint { job: BrowserJob; cases: JobCase[]; workbook?: WorkbookCheckpoint; pending?: Record<string, unknown> }
const checkpoints = new Map<string, Checkpoint>();
const batchResumes = new Map<number, Promise<BrowserJob>>();

export function startBrowserJob(projectId: number, caseIds: number[] = [], workflowMode: WorkflowMode = "live_eval",
  officeMode: OfficeRunMode = "auto", saveOptions: Partial<SaveOptions> = {}): BrowserJob {
  if ([...jobs.values()].some(job => !["completed", "failed", "stopped"].includes(job.status))) throw new Error("已有浏览器任务正在执行或等待确认，请先完成或停止该任务");
  const save_options = normaliseSaveOptions(saveOptions);
  const requested = new Set(caseIds);
  const approved = listCases(projectId).filter((item) => item.approved && (!caseIds.length || requested.has(item.id)));
  const selected = approved.sort((left, right) =>
    (left.office_name || "").localeCompare(right.office_name || "", "zh-CN") ||
    (left.conversation_group || "").localeCompare(right.conversation_group || "", undefined, { numeric: true }) ||
    left.conversation_round - right.conversation_round || left.source_row_number - right.source_row_number ||
    left.code.localeCompare(right.code, undefined, { numeric: true }));
  if (!selected.length) throw new Error("当前项目没有可执行的已审核浏览器用例");
  if (officeMode === "auto") {
    const officePlans = new Map(listOfficePlans(projectId).map((item) => [item.office_key, item]));
    for (const item of selected) {
      if (!item.office_key) throw new Error(`用例“${item.code}”没有办公室字段；请选择“手动进入 Office”模式`);
      const plan = officePlans.get(item.office_key);
      if (!plan?.actual_office_name) throw new Error(`请先为“${item.office_name}”填写实际 Office 名称`);
    }
  }
  const now = new Date().toISOString();
  const batchId = createEvaluationBatch(projectId, "browser", selected.map((item) => item.id), workflowMode);
  const job: BrowserJob = {
    id: randomUUID(), project_id: projectId, batch_id: batchId, workflow_mode: workflowMode, office_mode: officeMode,
    status: "queued", stage: "准备执行", total: selected.length,
    completed: 0, passed: 0, failed: 0, pause_requested: false, created_at: now, updated_at: now,
    save_options, result_files: [], awaiting_trial_confirmation: false, stop_requested: false, trial_results: [],
  };
  jobs.set(job.id, job);
  checkpoints.set(job.id, { job, cases: selected });
  void executeJob(job, selected.map((item) => ({ id: item.id, code: item.code, title: item.title,
    office_key: item.office_key, office_name: item.office_name, start_url: item.start_url, case_type: item.case_type,
    conversation_group: item.conversation_group, conversation_round: item.conversation_round })));
  return snapshot(job);
}

export function getBrowserJob(id: string): BrowserJob {
  const job = requireActive(id);
  return snapshot(job);
}

export function pauseBrowserJob(id: string): BrowserJob {
  const job = requireActive(id);
  if (["completed", "failed", "paused", "stopped"].includes(job.status)) return snapshot(job);
  job.pause_requested = true;
  job.status = "pausing";
  job.stage = "当前用例完成后暂停";
  touch(job);
  return snapshot(job);
}

export function resumeBrowserJob(id: string, confirmTrial = false): BrowserJob {
  const job = requireActive(id);
  if (job.awaiting_trial_confirmation && !confirmTrial) throw new Error("请先确认前两条采集和 Excel 保存结果，再继续剩余用例");
  if (job.status === "completed") return snapshot(job);
  if ([...jobs.values()].some(other => other.id !== id && !["completed", "failed", "stopped"].includes(other.status))) throw new Error("请先停止其他浏览器任务");
  const restart = ["failed", "stopped"].includes(job.status);
  job.awaiting_trial_confirmation = false;
  job.pause_requested = false;
  job.stop_requested = false;
  delete job.error;
  if (restart) {
    const checkpoint = checkpoints.get(id)!;
    void executeJob(job, checkpoint.cases);
    return snapshot(job);
  }
  if (job.status === "paused" || job.status === "pausing") {
    job.status = "running";
    db.execute("UPDATE evaluation_batches SET status='running',finished_at=NULL WHERE id=?", job.batch_id);
    job.stage = "正在继续执行";
    touch(job);
    resumeWaiters.get(id)?.();
    resumeWaiters.delete(id);
  }
  return snapshot(job);
}

export function stopBrowserJob(id: string): BrowserJob {
  const job = requireActive(id);
  if (["completed", "failed", "stopped"].includes(job.status)) return snapshot(job);
  job.stop_requested = true;
  job.pause_requested = false;
  job.awaiting_trial_confirmation = false;
  resumeWaiters.get(id)?.(); resumeWaiters.delete(id);
  job.stage = "正在停止，保留已保存结果";
  touch(job); return snapshot(job);
}

async function executeJob(job: BrowserJob, cases: Array<{ id: number; code: string; title: string; office_key: string; office_name: string; start_url: string;
  case_type: "single_turn" | "multi_turn"; conversation_group: string; conversation_round: number }>): Promise<void> {
  try {
    job.status = "running";
    db.execute("UPDATE evaluation_batches SET status='running',finished_at=NULL WHERE id=?", job.batch_id);
    job.stage = "正在连接目标 Agent";
    touch(job);
    const project = db.row<Project>("SELECT * FROM projects WHERE id=?", job.project_id);
    if (!project) throw new Error("评测项目不存在");
    job.stage = "正在检查 Excel 来源、回填列和保存目录";
    const writer = new IncrementalWorkbook(job.batch_id, job.id, job.save_options);
    const checkpoint = checkpoints.get(job.id)!;
    if (checkpoint.workbook) await writer.restore(checkpoint.workbook);
    else await writer.prepare(job.project_id, cases.map(item => item.id));
    checkpoint.workbook = writer.checkpoint();
    job.result_files = writer.files;
    touch(job);
    const officePlans = new Map(listOfficePlans(job.project_id).map((item) => [item.office_key, item]));
    let activeOfficeKey = "";
    for (const item of cases.slice(job.completed)) {
      if (job.pause_requested) await waitForResume(job);
      if (job.stop_requested) break;
      if (job.office_mode === "auto" && item.office_key && item.office_key !== activeOfficeKey) {
        const plan = officePlans.get(item.office_key);
        if (!plan) throw new Error(`办公室分组不存在：${item.office_name}`);
        job.current_office_key = item.office_key;
        job.current_office_name = plan.generated_name;
        job.stage = `正在进入 ${plan.actual_office_name || plan.generated_name}`;
        touch(job);
        await activateBrowserOffice(item.start_url || project.target_base_url, plan.actual_office_name, plan.actual_office_url);
        activeOfficeKey = item.office_key;
      }
      if (job.office_mode === "manual") {
        job.current_office_name = "当前已打开的 Office / Agent";
      }
      job.current_case_id = item.id;
      job.current_code = item.code;
      job.current_title = item.title;
      job.stage = job.workflow_mode === "collect_first" ? "正在发送问题、等待回复并保存完整截图" : "正在发送问题、等待回复、截图并评分";
      touch(job);
      const existing = db.row<{id:number}>("SELECT id FROM runs WHERE batch_id=? AND case_id=? AND status IN ('collected','completed') ORDER BY id DESC LIMIT 1", job.batch_id, item.id);
      const result = checkpoint.pending || (existing ? getRun(existing.id) : undefined) || (await runCases(job.project_id, [item.id], "browser", undefined, job.batch_id, job.workflow_mode,
        { newConversation: true }))[0];
      if (!result) throw new Error("未返回执行结果");
      checkpoint.pending = result;
      job.stage = `正在保存 ${item.code} 到 Excel`;
      touch(job);
      await writer.write(item.id, result);
      job.result_workbook_path = writer.files[0]?.url;
      job.completed += 1;
      delete checkpoint.pending;
      if (job.completed <= 2) {
        const messages = result.messages as Array<{ role: string; content: string }> || [];
        job.trial_results.push({ code: item.code, answer: [...messages].reverse().find(message => message.role === "assistant")?.content || String(result.summary || ""),
          screenshots: Array.isArray(result.screenshot_paths) ? result.screenshot_paths.map(String) : [], status: String(result.status) });
      }
      if (result?.status === "collected") { /* collected runs are neither pass nor fail until supplemental evaluation */ }
      else if (result?.status === "completed" && Number(result.passed)) job.passed += 1;
      else job.failed += 1;
      job.stage = `已完成 ${item.code}`;
      touch(job);
      if (job.completed === 2 && job.total > 2 && !job.stop_requested) {
        job.awaiting_trial_confirmation = true;
        await waitForResume(job);
      }
    }
    job.status = job.stop_requested ? "stopped" : "completed";
    job.stage = job.stop_requested ? "已停止，已完成用例的 Excel 已保留" : "全部用例已逐条保存到 Excel";
    delete job.current_case_id;
    delete job.current_code;
    delete job.current_title;
    delete job.current_office_key;
    delete job.current_office_name;
    finishEvaluationBatch(job.batch_id, job.stop_requested ? "stopped" : "completed");
    touch(job);
  } catch (error) {
    job.status = "failed";
    job.stage = "执行任务失败";
    job.error = error instanceof Error ? error.message : String(error);
    finishEvaluationBatch(job.batch_id, "failed");
    touch(job);
  }
}

async function waitForResume(job: BrowserJob): Promise<void> {
  job.status = "paused";
  job.stage = job.awaiting_trial_confirmation ? "前两条已写入并保存 Excel，请确认效果后继续" : "已暂停，等待继续";
  touch(job);
  await new Promise<void>((resolve) => resumeWaiters.set(job.id, resolve));
}

function requireActive(id: string): BrowserJob {
  let job = jobs.get(id);
  if (!job) {
    const checkpoint = readCheckpoint(id) as Checkpoint | undefined;
    if (checkpoint) {
      job = checkpoint.job;
      if (!["completed", "failed", "stopped"].includes(job.status)) { job.status = "stopped"; job.stage = "服务已重启，可从中断处继续"; }
      checkpoints.set(id, checkpoint); jobs.set(id, job);
    }
  }
  if (!job) throw new Error("执行任务不存在或服务已重启");
  return job;
}

export function resumeBrowserBatch(batchId: number): Promise<BrowserJob> {
  const existing = batchResumes.get(batchId);
  if (existing) return existing;
  const promise = restoreBrowserBatch(batchId).finally(() => batchResumes.delete(batchId));
  batchResumes.set(batchId, promise);
  return promise;
}

async function restoreBrowserBatch(batchId: number): Promise<BrowserJob> {
  if ([...jobs.values()].some(job => job.batch_id !== batchId && !["completed", "failed", "stopped"].includes(job.status))) throw new Error("请先停止其他浏览器任务");
  let checkpoint = readCheckpoint(batchId) as Checkpoint | undefined;
  if (!checkpoint) {
    const legacy = await recoverLegacyBatch(batchId);
    const now = new Date().toISOString();
    const job: BrowserJob = { id: randomUUID(), project_id: legacy.batch.project_id, batch_id: batchId,
      workflow_mode: legacy.batch.workflow_mode, office_mode: legacy.cases.every(item => item.office_key) ? "auto" : "manual",
      save_options: legacy.options, result_files: legacy.files, result_workbook_path: legacy.files[0]?.url,
      status: "stopped", stage: "已恢复原结果表", total: legacy.cases.length, completed: legacy.completed,
      passed: 0, failed: 0, pause_requested: false, stop_requested: false, awaiting_trial_confirmation: false,
      trial_results: [], created_at: now, updated_at: now };
    checkpoint = { job, cases: legacy.cases, workbook: legacy.workbook };
    saveCheckpoint(batchId, job.id, checkpoint);
  }
  return resumeBrowserJob(checkpoint.job.id, true);
}

function touch(job: BrowserJob): void {
  job.updated_at = new Date().toISOString();
  const checkpoint = checkpoints.get(job.id);
  if (checkpoint) saveCheckpoint(job.batch_id, job.id, checkpoint);
}
function snapshot(job: BrowserJob): BrowserJob { return { ...job }; }
