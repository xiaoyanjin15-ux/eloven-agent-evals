import { randomUUID } from "node:crypto";

import { activateBrowserOffice } from "./browser-runner.js";
import { planConversationTurn } from "./conversation-plan.js";
import * as db from "./db.js";
import { createEvaluationBatch, finaliseCollectedWorkbook, finishEvaluationBatch, listCases, listOfficePlans, runCases } from "./services.js";
import type { Project, WorkflowMode } from "./domain.js";

export type BrowserJobStatus = "queued" | "running" | "pausing" | "paused" | "completed" | "failed";
export type OfficeRunMode = "auto" | "manual";

export interface BrowserJob {
  id: string;
  project_id: number;
  batch_id: number;
  workflow_mode: WorkflowMode;
  office_mode: OfficeRunMode;
  result_workbook_path?: string;
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

export function startBrowserJob(projectId: number, caseIds: number[] = [], workflowMode: WorkflowMode = "live_eval",
  officeMode: OfficeRunMode = "auto"): BrowserJob {
  const requested = new Set(caseIds);
  const approved = listCases(projectId).filter((item) => item.approved && (!caseIds.length || requested.has(item.id)));
  const browserCases = approved.filter((item) => item.execution_type !== "dialogue");
  const selected = (browserCases.length ? browserCases : approved).sort((left, right) =>
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
  };
  jobs.set(job.id, job);
  void executeJob(job, selected.map((item) => ({ id: item.id, code: item.code, title: item.title,
    office_key: item.office_key, office_name: item.office_name, start_url: item.start_url, case_type: item.case_type,
    conversation_group: item.conversation_group, conversation_round: item.conversation_round })));
  return snapshot(job);
}

export function getBrowserJob(id: string): BrowserJob {
  const job = jobs.get(id);
  if (!job) throw new Error("执行任务不存在或服务已重启");
  return snapshot(job);
}

export function pauseBrowserJob(id: string): BrowserJob {
  const job = requireActive(id);
  if (["completed", "failed", "paused"].includes(job.status)) return snapshot(job);
  job.pause_requested = true;
  job.status = "pausing";
  job.stage = "当前用例完成后暂停";
  touch(job);
  return snapshot(job);
}

export function resumeBrowserJob(id: string): BrowserJob {
  const job = requireActive(id);
  job.pause_requested = false;
  if (job.status === "paused" || job.status === "pausing") {
    job.status = "running";
    job.stage = "正在继续执行";
    touch(job);
    resumeWaiters.get(id)?.();
    resumeWaiters.delete(id);
  }
  return snapshot(job);
}

async function executeJob(job: BrowserJob, cases: Array<{ id: number; code: string; title: string; office_key: string; office_name: string; start_url: string;
  case_type: "single_turn" | "multi_turn"; conversation_group: string; conversation_round: number }>): Promise<void> {
  try {
    job.status = "running";
    job.stage = "正在连接目标 Agent";
    touch(job);
    const project = db.row<Project>("SELECT * FROM projects WHERE id=?", job.project_id);
    if (!project) throw new Error("评测项目不存在");
    const officePlans = new Map(listOfficePlans(job.project_id).map((item) => [item.office_key, item]));
    let activeOfficeKey = "";
    let activeConversationGroup = "";
    for (const item of cases) {
      if (job.pause_requested) await waitForResume(job);
      if (job.office_mode === "auto" && item.office_key && item.office_key !== activeOfficeKey) {
        const plan = officePlans.get(item.office_key);
        if (!plan) throw new Error(`办公室分组不存在：${item.office_name}`);
        job.current_office_key = item.office_key;
        job.current_office_name = plan.generated_name;
        job.stage = `正在进入 ${plan.actual_office_name || plan.generated_name}`;
        touch(job);
        await activateBrowserOffice(item.start_url || project.target_base_url, plan.actual_office_name, plan.actual_office_url);
        activeOfficeKey = item.office_key;
        activeConversationGroup = "";
      }
      if (job.office_mode === "manual") {
        job.current_office_name = "当前已打开的 Office / Agent";
      }
      job.current_case_id = item.id;
      job.current_code = item.code;
      job.current_title = item.title;
      job.stage = job.workflow_mode === "collect_first" ? "正在发送问题、等待回复并保存完整截图" : "正在发送问题、等待回复、截图并评分";
      touch(job);
      const conversationPlan = planConversationTurn(item, activeConversationGroup);
      const results = await runCases(job.project_id, [item.id], "browser", undefined, job.batch_id, job.workflow_mode,
        { newConversation: conversationPlan.newConversation });
      activeConversationGroup = conversationPlan.nextGroup;
      const result = results[0] as { status?: string; passed?: number } | undefined;
      job.completed += 1;
      if (result?.status === "collected") { /* collected runs are neither pass nor fail until supplemental evaluation */ }
      else if (result?.status === "completed" && Number(result.passed)) job.passed += 1;
      else job.failed += 1;
      job.stage = `已完成 ${item.code}`;
      touch(job);
    }
    if (job.workflow_mode === "collect_first") {
      job.stage = "正在把截图回填到原始 Excel";
      touch(job);
      try { job.result_workbook_path = await finaliseCollectedWorkbook(job.batch_id); }
      catch (error) { job.warning = error instanceof Error ? error.message : String(error); }
    }
    job.status = "completed";
    job.stage = job.workflow_mode === "collect_first"
      ? (job.result_workbook_path ? "采集完成，Excel 已生成，可稍后统一评测" : "采集完成；截图已保存，但 Excel 回填未生成")
      : "全部用例执行完成";
    delete job.current_case_id;
    delete job.current_code;
    delete job.current_title;
    delete job.current_office_key;
    delete job.current_office_name;
    finishEvaluationBatch(job.batch_id, "completed");
    touch(job);
  } catch (error) {
    job.status = "failed";
    job.stage = "执行任务失败";
    job.error = error instanceof Error ? error.message : String(error);
    if (job.workflow_mode === "collect_first" && job.completed > 0) {
      try { job.result_workbook_path = await finaliseCollectedWorkbook(job.batch_id); }
      catch (workbookError) {
        job.warning = `已采集截图，但主结果表回填失败：${workbookError instanceof Error ? workbookError.message : String(workbookError)}`;
      }
    }
    finishEvaluationBatch(job.batch_id, "failed");
    touch(job);
  }
}

async function waitForResume(job: BrowserJob): Promise<void> {
  job.status = "paused";
  job.stage = "已暂停，等待继续";
  touch(job);
  await new Promise<void>((resolve) => resumeWaiters.set(job.id, resolve));
}

function requireActive(id: string): BrowserJob {
  const job = jobs.get(id);
  if (!job) throw new Error("执行任务不存在或服务已重启");
  return job;
}

function touch(job: BrowserJob): void { job.updated_at = new Date().toISOString(); }
function snapshot(job: BrowserJob): BrowserJob { return { ...job }; }
