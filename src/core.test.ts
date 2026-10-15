import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

import type { EvalCase } from "./domain.js";
import { evaluate } from "./evaluator.js";

test("rule evaluator preserves scoring behavior", () => {
  const evalCase = { expected_keywords: ["文件", "列表"], forbidden_keywords: ["删除"], max_turns: 2 } as EvalCase;
  const result = evaluate(evalCase, "这是完整文件列表", { total_latency_ms: 80, turn_count: 1 });
  assert.equal(result.score, 100);
  assert.equal(result.passed, true);
});

test("TypeScript pi server completes the main API flow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-evals-pi-"));
  const port = 18_000 + Math.floor(Math.random() * 1_000);
  const serverPath = fileURLToPath(new URL("./server.js", import.meta.url));
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", serverPath], {
    env: { ...process.env, PORT: String(port), AGENT_EVAL_DB: join(directory, "test.db"), JUDGE_MODELS_FILE: join(directory, "judge-models.local.json"), AGENT_EVAL_IMPORT_DIR: join(directory, "imports"),
      AGENT_EVAL_ARTIFACT_DIR: join(directory, "artifacts") }, stdio: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(`${base}/api/health`);
    const health = await fetch(`${base}/api/health`).then((response) => response.json()) as Record<string, unknown>;
    assert.equal(health.runtime, "pi-mono");
    const projects = await fetch(`${base}/api/projects`).then((response) => response.json()) as Array<{ id: number }>;
    assert.equal(projects.length, 1);
    const projectId = projects[0].id;
    const importedProject = await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Excel Agent", project_key: "EXCEL" }) }).then((response) => response.json()) as { id: number };
    const judgeCreated = await fetch(`${base}/api/projects/${importedProject.id}/judge-models`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Judge A", base_url: "http://127.0.0.1:1/v1", model_id: "judge-a", api_key: "private-test-key" }) });
    assert.equal(judgeCreated.status, 201);
    const judge = await judgeCreated.json() as { id: string; is_default: boolean; has_api_key: boolean; api_key?: string };
    assert.equal(judge.is_default, true);
    assert.equal(judge.has_api_key, true);
    assert.equal(judge.api_key, undefined);
    const judgeList = await fetch(`${base}/api/projects/${importedProject.id}/judge-models`).then(response => response.json()) as Array<Record<string, unknown>>;
    assert.equal(judgeList.length, 1);
    assert.equal(JSON.stringify(judgeList).includes("private-test-key"), false);
    const judgeSecond = await fetch(`${base}/api/projects/${importedProject.id}/judge-models`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Judge B", base_url: "http://127.0.0.1:1/v1", model_id: "judge-b", api_key: "second-private-key" }) }).then(response => response.json()) as { id: string };
    await fetch(`${base}/api/projects/${importedProject.id}/judge-models/${judgeSecond.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_default: true }) });
    const switched = await fetch(`${base}/api/projects/${importedProject.id}/judge-models`).then(response => response.json()) as Array<{ id: string; is_default: boolean }>;
    assert.equal(switched.find(item => item.is_default)?.id, judgeSecond.id);
    const judgeDelete = await fetch(`${base}/api/projects/${importedProject.id}/judge-models/${judgeSecond.id}`, { method: "DELETE" });
    assert.equal(judgeDelete.status, 200);
    const restored = await fetch(`${base}/api/projects/${importedProject.id}/judge-models`).then(response => response.json()) as Array<{ id: string; is_default: boolean }>;
    assert.equal(restored.find(item => item.is_default)?.id, judge.id);
    const evaluationSet = await fetch(`${base}/api/projects/${importedProject.id}/evaluation-sets`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "黄金测试集", description: "用户自定义名称", source: "excel" }) }).then((response) => response.json()) as { id: number; name: string };
    assert.equal(evaluationSet.name, "黄金测试集");
    const sourceWorkbook = new ExcelJS.Workbook();
    const sourceSheet = sourceWorkbook.addWorksheet("汽车行业");
    sourceSheet.addRow(["Agent 测试集"]);
    sourceSheet.addRow(["细分行业", "岗位", "场景分类", "用例ID", "用例类型", "用户输入 / Topic场景", "预期行为"]);
    sourceSheet.addRow(["后市场", "CCO｜首席传播官", "基础能力", "F-01", "普通对话用例", "你会干什么？", "准确说明核心能力，不得编造无关能力"]);
    const secondSheet = sourceWorkbook.addWorksheet("权限边界");
    secondSheet.addRow(["细分行业", "用例编号", "测试类型", "对话组/轮次", "用户输入", "轮数上限", "预期系统行为", "评估标准", "测试结果"]);
    secondSheet.addRow(["互联网医疗", "M01-R02", "多轮对话用例", "M01 / 第2轮", "你能访问哪些数据？", "3轮", "说明权限范围，不能虚构访问能力", "不得声称拥有未授权数据", ""]);
    const sourceBytes = await sourceWorkbook.xlsx.writeBuffer();
    const inspected = await fetch(`${base}/api/cases/import/inspect`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "cases.xlsx", file_base64: Buffer.from(sourceBytes).toString("base64") }) }).then((response) => response.json()) as
      { valid: boolean; importable_sheets: number; sheets: Array<{ matched: Record<string, string> }> };
    assert.equal(inspected.valid, true);
    assert.equal(inspected.importable_sheets, 2);
    assert.equal(inspected.sheets[0].matched.question, "用户输入 / Topic场景");
    const imported = await fetch(`${base}/api/projects/${importedProject.id}/cases/import`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "cases.xlsx", file_base64: Buffer.from(sourceBytes).toString("base64"), evaluation_set_id: evaluationSet.id }) }).then((response) => response.json()) as
      { imported: number; sheets: string[]; cases: Array<{ id: number; code: string; query: string; expected_answer: string; approved: number; source_sheet_name: string; source_case_code: string; office_name: string; office_key: string; case_type: string; conversation_group: string; conversation_round: number; evaluation_criteria: string }> };
    assert.equal(imported.imported, 2);
    assert.deepEqual(imported.sheets, ["汽车行业", "权限边界"]);
    assert.equal(imported.cases[0].code, "EXCEL-F-01");
    assert.equal(imported.cases[0].query, "你会干什么？");
    assert.equal(imported.cases[0].expected_answer, "准确说明核心能力，不得编造无关能力");
    assert.equal(imported.cases[0].approved, 1);
    assert.equal(imported.cases[0].case_type, "single_turn");
    assert.equal(imported.cases[0].source_sheet_name, "汽车行业");
    assert.equal(imported.cases[0].office_name, "汽车行业_后市场_CCO｜首席传播官");
    assert.ok(imported.cases[0].office_key);
    assert.equal(imported.cases[1].source_sheet_name, "权限边界");
    assert.equal(imported.cases[1].source_case_code, "M01-R02");
    assert.equal(imported.cases[1].case_type, "multi_turn");
    assert.equal(imported.cases[1].conversation_group, "M01");
    assert.equal(imported.cases[1].conversation_round, 2);
    assert.equal(imported.cases[1].evaluation_criteria, "不得声称拥有未授权数据");
    const namedSetCases = await fetch(`${base}/api/projects/${importedProject.id}/cases?evaluation_set_id=${evaluationSet.id}`).then((response) => response.json()) as unknown[];
    assert.equal(namedSetCases.length, 2);
    assert.equal((await fetch(`${base}/api/projects/${importedProject.id}/evaluation-sets`).then(response => response.json()) as unknown[]).length, 2);
    const officePlans = await fetch(`${base}/api/projects/${importedProject.id}/offices`).then((response) => response.json()) as
      Array<{ office_key: string; generated_name: string; cases: Array<{ id: number }> }>;
    assert.equal(officePlans.length, 1);
    const automotiveOffice = officePlans.find((item) => item.generated_name.includes("首席传播官"))!;
    assert.equal(automotiveOffice.cases.length, 1);
    const savedOffices = await fetch(`${base}/api/projects/${importedProject.id}/offices`, { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mappings: [{ office_key: automotiveOffice.office_key, generated_name: automotiveOffice.generated_name,
        actual_office_name: "汽车后市场传播办公室", actual_office_url: "https://office.example.test/automotive" }] }) }).then((response) => response.json()) as
      Array<{ office_key: string; actual_office_name: string; actual_office_url: string }>;
    assert.equal(savedOffices.find((item) => item.office_key === automotiveOffice.office_key)?.actual_office_name, "汽车后市场传播办公室");
    const isolated = await fetch(`${base}/api/projects/import`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "独立测试集", project_key: "ISOLATED", filename: "isolated.xlsx",
        file_base64: Buffer.from(sourceBytes).toString("base64"), start_url: "https://office.example.test" }) }).then((response) => response.json()) as
      { imported: number; project: { id: number; project_key: string; target_base_url: string } };
    assert.equal(isolated.imported, 2);
    assert.equal(isolated.project.project_key, "ISOLATED");
    assert.equal(isolated.project.target_base_url, "https://office.example.test");
    const deleted = await fetch(`${base}/api/projects/${importedProject.id}/cases`, { method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ case_ids: [imported.cases[0].id] }) }).then((response) => response.json()) as
      { deleted: number; cases: Array<{ id: number }> };
    assert.equal(deleted.deleted, 1);
    assert.equal(deleted.cases.length, 1);
    const goldPost = (url: string, body: unknown) => fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const goldWorkbook = new ExcelJS.Workbook();
    const goldSheet = goldWorkbook.addWorksheet("黄金评测集");
    goldSheet.addRow(["用例ID", "用例名称", "类别", "优先级", "视频文件", "用户输入", "黄金答案/必要事实", "必需工具", "最大工具调用数", "黄金状态", "预期调用顺序", "工具参数约束"]);
    goldSheet.addRow(["EDT-001", "裁剪前4秒", "单工具编辑", "P0", "videos/edit_base_20s.mp4", "帮我裁掉视频前4秒。",
      "保留4-20秒，输出约16秒。", "video_trim", 2, "已标注", "video_understand→video_trim", "start=4秒"]);
    const goldBytes = Buffer.from(await goldWorkbook.xlsx.writeBuffer());
    const goldInspection = await goldPost(`${base}/api/cases/import/inspect`, { filename: "gold.xlsx", file_base64: goldBytes.toString("base64") })
      .then(response => response.json()) as { valid: boolean; sheets: Array<{ columns: string[] }> };
    assert.equal(goldInspection.valid, true);
    assert.equal(goldInspection.sheets[0].columns.length, 12);
    const goldSet = await goldPost(`${base}/api/projects/${importedProject.id}/evaluation-sets`, { name: "视频黄金集", source: "excel" })
      .then(response => response.json()) as { id: number };
    const goldImport = await goldPost(`${base}/api/projects/${importedProject.id}/cases/import`, {
      filename: "gold.xlsx", file_base64: goldBytes.toString("base64"), evaluation_set_id: goldSet.id,
    }).then(response => response.json()) as { imported: number; cases: Array<{ id: number; title: string; approved: number; execution_type: string; source_fields: Record<string, unknown>; expected_trace: { required_tools: string[]; ordered: boolean; max_tool_calls: number; parameter_constraints: string } }> };
    assert.equal(goldImport.imported, 1);
    assert.equal(goldImport.cases[0].title, "裁剪前4秒");
    assert.equal(goldImport.cases[0].approved, 0);
    assert.equal(goldImport.cases[0].execution_type, "dialogue");
    assert.equal(goldImport.cases[0].source_fields["视频文件"], "videos/edit_base_20s.mp4");
    assert.equal(goldImport.cases[0].source_fields["最大工具调用数"], 2);
    assert.equal(Object.keys(goldImport.cases[0].source_fields).length, 12);
    assert.deepEqual(goldImport.cases[0].expected_trace.required_tools, ["video_understand", "video_trim"]);
    assert.equal(goldImport.cases[0].expected_trace.ordered, true);
    assert.equal(goldImport.cases[0].expected_trace.max_tool_calls, 2);
    assert.equal(goldImport.cases[0].expected_trace.parameter_constraints, "start=4秒");
    const clarification = await fetch(`${base}/api/projects/${projectId}/clarify`, { method: "POST" }).then((response) => response.json()) as { trace: { runtime: string } };
    assert.equal(clarification.trace.runtime, "pi-agent-core");
    const cases = await fetch(`${base}/api/projects/${projectId}/cases`).then((response) => response.json()) as Array<{ id: number }>;
    await fetch(`${base}/api/cases/${cases[0].id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: true }) });
    const runResult = await fetch(`${base}/api/runs`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, case_ids: [cases[0].id], adapter: "mock" }) }).then((response) => response.json()) as { count: number };
    assert.equal(runResult.count, 1);
    const traceBody = { trace_id: "integration-trace", case_id: cases[0].id, observations: [
      { id: "task", name: "chat", traceId: "integration-trace", parentObservationId: null, input: "裁剪前4秒", output: "完成",
        startTime: "2026-09-14T01:00:00Z", endTime: "2026-09-14T01:00:02Z" },
      { id: "tool", name: "video_trim", traceId: "integration-trace", parentObservationId: "task", input: { startTime: 0, endTime: 4 }, output: { success: true },
        startTime: "2026-09-14T01:00:00Z", endTime: "2026-09-14T01:00:01Z" },
    ] };
    const agentPath = `${base}/api/projects/${projectId}/agent-evaluations`;
    const jsonPost = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const traceResponse = await jsonPost(agentPath, traceBody);
    assert.equal(traceResponse.status, 201);
    const agentEval = await traceResponse.json() as { id: number; trace: { input: string } };
    assert.equal(agentEval.trace.input, "裁剪前4秒");
    const scored = await jsonPost(`${agentPath}/${agentEval.id}/evaluate`, { tools: [{ name: "video_trim", parameters: { endTime: 40 } }] }).then(response => response.json()) as { result: { status: string } };
    assert.equal(scored.result.status, "fail");
    const reimported = await jsonPost(agentPath, traceBody).then(response => response.json()) as { id: number; result: object };
    assert.equal(reimported.id, agentEval.id); assert.deepEqual(reimported.result, {});
    assert.equal((await fetch(agentPath).then(response => response.json()) as unknown[]).length, 1);
    const baseGroups = await fetch(base + "/api/projects/" + projectId + "/agent-evaluation-groups").then(response => response.json()) as Array<{ name: string; group_type: string; trace_count: number }>;
    assert.equal(baseGroups.find(group => group.group_type === "uncategorized")?.name, "未分类");
    assert.equal(baseGroups.find(group => group.group_type === "uncategorized")?.trace_count, 1);
    assert.equal((await fetch(`${base}/api/projects/${importedProject.id}/agent-evaluations/${agentEval.id}`)).status, 404);
    const linkedTrace = await jsonPost(`${base}/api/projects/${importedProject.id}/agent-evaluations`, { ...traceBody, trace_id: "gold-case-trace",
      observations: traceBody.observations.map(item => ({ ...item, traceId: "gold-case-trace" })), group_mode: "evaluation_set",
      evaluation_set_id: goldSet.id, case_id: goldImport.cases[0].id });
    assert.equal(linkedTrace.status, 201);
    const linkedExpectations = await linkedTrace.json() as { id: number; group_name: string; group_type: string; evaluation_set_id: number; expectations: { tools: Array<{ name: string }>; ordered: boolean } };
    assert.deepEqual(linkedExpectations.expectations.tools.map(tool => tool.name), ["video_understand", "video_trim"]);
    assert.equal(linkedExpectations.expectations.ordered, true);
    assert.equal(linkedExpectations.group_name, "视频黄金集");
    assert.equal(linkedExpectations.group_type, "evaluation_set");
    assert.equal(linkedExpectations.evaluation_set_id, goldSet.id);
    const linkedPath = base + "/api/projects/" + importedProject.id + "/agent-evaluations/" + linkedExpectations.id;
    const missingStandard = await jsonPost(linkedPath + "/evaluate", { tools: [], semantic: true, expected_answer: "完成任务" });
    assert.equal(missingStandard.ok, false);
    assert.match(await missingStandard.text(), /评分标准/);
    const linkResponse = await fetch(linkedPath, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case_id: goldImport.cases[0].id, evaluation_set_id: goldSet.id }) });
    assert.equal(linkResponse.status, 200);
    const loaded = await linkResponse.json() as { expectations: { expected_answer: string; parameter_constraints: string; evaluation_set_id: number }; result: object };
    assert.equal(loaded.expectations.expected_answer, "保留4-20秒，输出约16秒。");
    assert.equal(loaded.expectations.parameter_constraints, "start=4秒");
    assert.equal(loaded.expectations.evaluation_set_id, goldSet.id);
    assert.deepEqual(loaded.result, {});
    const customTrace = await jsonPost(base + "/api/projects/" + importedProject.id + "/agent-evaluations", { ...traceBody, trace_id: "custom-group-trace",
      observations: traceBody.observations.map(item => ({ ...item, traceId: "custom-group-trace" })), case_id: null, group_mode: "custom", group_name: "Prompt 修改验证" })
      .then(response => response.json()) as { id: number; group_name: string; group_type: string; evaluation_set_id: number | null };
    assert.equal(customTrace.group_name, "Prompt 修改验证");
    assert.equal(customTrace.group_type, "custom");
    assert.equal(customTrace.evaluation_set_id, null);
    const grouped = await fetch(base + "/api/projects/" + importedProject.id + "/agent-evaluation-groups").then(response => response.json()) as Array<{ id: number; name: string; group_type: string; trace_count: number }>;
    assert.equal(grouped.find(group => group.name === "视频黄金集")?.trace_count, 1);
    assert.equal(grouped.find(group => group.name === "Prompt 修改验证")?.trace_count, 1);
    const goldGroupId = grouped.find(group => group.name === "视频黄金集")?.id;
    const uncategorizedGroupId = grouped.find(group => group.group_type === "uncategorized")?.id;
    assert.ok(goldGroupId); assert.ok(uncategorizedGroupId);
    const movedTrace = await fetch(base + "/api/projects/" + importedProject.id + "/agent-evaluations/" + customTrace.id + "/group", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group_id: goldGroupId })
    }).then(response => response.json()) as { group_name: string; group_type: string; case_id: number | null; result: object };
    assert.equal(movedTrace.group_name, "视频黄金集");
    assert.equal(movedTrace.group_type, "evaluation_set");
    assert.equal(movedTrace.case_id, null);
    const movedBack = await fetch(base + "/api/projects/" + importedProject.id + "/agent-evaluations/" + customTrace.id + "/group", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group_id: uncategorizedGroupId })
    }).then(response => response.json()) as { group_type: string };
    assert.equal(movedBack.group_type, "uncategorized");
    const wrongGroup = await fetch(base + "/api/projects/" + importedProject.id + "/agent-evaluations/" + customTrace.id + "/group", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group_id: baseGroups[0] && 999999 })
    });
    assert.equal(wrongGroup.ok, false);
    const deleteTrace = await jsonPost(base + "/api/projects/" + importedProject.id + "/agent-evaluations", {
      ...traceBody, trace_id: "delete-local-trace", case_id: null,
      observations: traceBody.observations.map(item => ({ ...item, traceId: "delete-local-trace" })), group_id: uncategorizedGroupId
    }).then(response => response.json()) as { id: number };
    const deleteResponse = await fetch(base + "/api/projects/" + importedProject.id + "/agent-evaluations/" + deleteTrace.id, { method: "DELETE" });
    assert.equal(deleteResponse.status, 200);
    assert.equal((await deleteResponse.json() as { deleted: boolean }).deleted, true);
    assert.equal((await fetch(base + "/api/projects/" + importedProject.id + "/agent-evaluations/" + deleteTrace.id)).status, 404);
    const deferredLink = await fetch(base + "/api/projects/" + importedProject.id + "/agent-evaluations/" + customTrace.id, { method: "PATCH",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ evaluation_set_id: goldSet.id, case_id: null, group_name: "视频理解回归" }) }).then(response => response.json()) as
      { case_id: null; group_name: string; group_type: string; evaluation_set_id: number; expectations: { evaluation_set_id: number } };
    assert.equal(deferredLink.case_id, null);
    assert.equal(deferredLink.group_name, "视频理解回归");
    assert.equal(deferredLink.group_type, "custom");
    assert.equal(deferredLink.evaluation_set_id, goldSet.id);
    assert.equal(deferredLink.expectations.evaluation_set_id, goldSet.id);
    const wrongSet = await fetch(linkedPath, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case_id: goldImport.cases[0].id, evaluation_set_id: evaluationSet.id }) });
    assert.equal(wrongSet.ok, false);
    const wrongProjectCase = await fetch(linkedPath, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case_id: cases[0].id }) });
    assert.equal(wrongProjectCase.ok, false);
    const sharedSet = await goldPost(`${base}/api/projects/${importedProject.id}/evaluation-sets`, { name: "共享视频集" })
      .then(response => response.json()) as { id: number };
    await goldPost(`${base}/api/projects/${importedProject.id}/cases/import`, {
      filename: "gold.xlsx", file_base64: goldBytes.toString("base64"), evaluation_set_id: sharedSet.id,
    });
    const noConfirm = await fetch(`${base}/api/projects/${importedProject.id}/evaluation-sets/${goldSet.id}`, { method: "DELETE" });
    assert.equal(noConfirm.status, 400);
    const deleteGold = await fetch(`${base}/api/projects/${importedProject.id}/evaluation-sets/${goldSet.id}`, { method: "DELETE",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    assert.equal(deleteGold.status, 200);
    const goldDeletion = await deleteGold.json() as { deleted_cases: number; retained_shared_cases: number };
    assert.equal(goldDeletion.deleted_cases, 0);
    assert.equal(goldDeletion.retained_shared_cases, 1);
    assert.equal((await fetch(`${base}/api/projects/${importedProject.id}/cases?evaluation_set_id=${sharedSet.id}`).then(response => response.json()) as unknown[]).length, 1);
    const deleteOriginal = await fetch(`${base}/api/projects/${importedProject.id}/evaluation-sets/${evaluationSet.id}`, { method: "DELETE",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    assert.equal((await deleteOriginal.json() as { deleted_cases: number }).deleted_cases, 1);
    assert.equal((await fetch(`${base}/api/projects/${importedProject.id}/cases?evaluation_set_id=${sharedSet.id}`).then(response => response.json()) as unknown[]).length, 1);
    const clearSets = await fetch(`${base}/api/projects/${importedProject.id}/evaluation-sets`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
    assert.equal(clearSets.status, 200);
    assert.deepEqual(await fetch(`${base}/api/projects/${importedProject.id}/evaluation-sets`).then(response => response.json()), []);
    assert.deepEqual(await fetch(`${base}/api/projects/${importedProject.id}/cases`).then(response => response.json()), []);
    const wrongConfirmation = await fetch(`${base}/api/projects/${importedProject.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm_name: "wrong" }) });
    assert.equal(wrongConfirmation.status, 400);
    const removeProject = await fetch(`${base}/api/projects/${importedProject.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm_name: "Excel Agent" }) });
    assert.equal(removeProject.status, 200);
    assert.equal((await fetch(`${base}/api/projects/${importedProject.id}`)).status, 404);
    const page = await fetch(base).then(response => response.text());
    for (const section of ["总览", "评测集管理", "跑测工作台", "根因分析"]) assert.ok(page.includes(section));
    assert.ok(page.includes('id="view-agent"')); assert.ok(page.includes('id="view-rag"')); assert.ok(page.includes("agent-evaluation.js"));
    assert.ok(page.includes("暂不关联评测集"));
    assert.ok(page.includes("Trace 分组"));
    const workbookData = await fetch(`${base}/reports/${projectId}.xlsx`).then((response) => response.arrayBuffer());
    const workbook = new Uint8Array(workbookData as ArrayBuffer);
    assert.deepEqual([...workbook.slice(0, 2)], [80, 75]);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("测试服务启动超时");
}
