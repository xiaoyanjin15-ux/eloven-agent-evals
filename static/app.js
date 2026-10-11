const state = { projects: [], project: null, datasets: [], dataset: null, judgeModels: [], cases: [], runs: [], portfolioCases: {}, officePlans: [], filter: "all", selectedCases: new Set(), browserJob: null, jobPoll: null, importInspection: null, officeRunMode: "auto", activeRoute: "overview" };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const NAV_SECTIONS = {
  overview: [],
  datasets: [
    { view: "brief", label: "评测集列表" },
    { view: "cases", label: "测试用例" },
    { view: "review", label: "审核与发布" },
    { view: "rules", label: "评测规则" },
  ],
  workbench: [
    { view: "run-setup", label: "新建跑测" },
    { view: "rag", label: "RAG 自动采集" },
    { view: "agent", label: "Agent 链路跑测" },
    { view: "judge-models", label: "评测模型" },
    { view: "runs", label: "运行任务" },
  ],
  analysis: [
    { view: "reports", label: "评测报告" },
    { view: "bad-cases", label: "Bad Case" },
    { view: "root-cause", label: "失败归因" },
    { view: "compare", label: "版本对比" },
    { view: "regression", label: "回归验证" },
  ],
};

const VIEW_SECTIONS = Object.fromEntries(Object.entries(NAV_SECTIONS).flatMap(([section, items]) => items.map(item => [item.view, section])));
VIEW_SECTIONS.overview = "overview";

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try { const data = await response.json(); message = data.detail || message; } catch (_) {}
    throw new Error(message);
  }
  return response.json();
}

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = error ? "show error" : "show";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.className = "", 2600);
}

async function loadHarnessStatus() {
  try {
    const status = await api("/api/harness/status");
    const live = Boolean(status.configured || state.judgeModels.length);
    $("#harness-status").textContent = `pi-mono · ${live ? "真实模型" : "本地演示"}`;
    $("#pi-mode").textContent = `PI-AGENT-CORE · ${live ? "LIVE MODEL" : "FAUX PROVIDER"}`;
    $("#pi-mode").classList.toggle("live", live);
  } catch (_) {
    $("#harness-status").textContent = "pi-mono 连接失败";
    $("#pi-mode").textContent = "PI · UNAVAILABLE";
  }
}

function renderSectionTabs(section, route) {
  const tabBar = $("#section-tabs");
  const items = NAV_SECTIONS[section] || [];
  tabBar.hidden = !items.length;
  tabBar.innerHTML = items.map(item => `<button type="button" class="section-tab ${item.view === route ? "active" : ""}" data-route="${item.view}" data-view="${item.view}" aria-current="${item.view === route ? "page" : "false"}">${item.label}</button>`).join("");
  $$(".section-tab", tabBar).forEach(button => button.addEventListener("click", () => showView(button.dataset.route)));
}

function setCasePageMode(review) {
  state.filter = review ? "pending" : "all";
  $$(".filter").forEach(button => button.classList.toggle("active", button.dataset.filter === state.filter));
  $("#case-page-title").textContent = review ? "审核与发布" : "测试用例";
  $("#case-page-description").textContent = review ? "人工确认输入、预期结果和评分要求；系统只执行已审核用例。" : "编辑输入、预期回答、工具要求与执行方式。";
  renderCases();
}

function showView(name) {
  const section = VIEW_SECTIONS[name] || "overview";
  const actualView = name === "review" ? "cases" : name;
  state.activeRoute = name;
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.section === section));
  $$(".view").forEach(view => view.classList.toggle("active", view.id === `view-${actualView}`));
  renderSectionTabs(section, name);
  if (name === "cases" || name === "review") setCasePageMode(name === "review");
  if (name === "runs") loadRuns();
  if (name === "bad-cases") loadBadCases();
  if (name === "rules") renderRulesSummary();
  if (name === "agent") window.agentEvaluation?.refresh();
  if (name === "judge-models") loadJudgeModels().catch(error => toast(error.message, true));
  if (name === "brief" && state.project) loadQuestions().catch(error => toast(error.message, true));
  history.replaceState(null, "", `#${name}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function loadProjects() {
  state.projects = await api("/api/projects");
  const select = $("#project-select");
  select.innerHTML = state.projects.map(item => `<option value="${item.id}">[${escapeHtml(item.project_key || `PRJ-${item.id}`)}] ${escapeHtml(item.name)}</option>`).join("");
  const saved = Number(localStorage.getItem("agent-eval-project"));
  const first = state.projects.find(item => item.id === saved) || state.projects[0];
  if (first) { select.value = first.id; await selectProject(first.id); }
  else { state.project = null; state.datasets = []; state.dataset = null; state.judgeModels = []; state.cases = []; select.innerHTML = '<option value="">请新建项目</option>'; $("#delete-project").disabled = true; renderDatasets(); renderDatasetContext(); renderJudgeModels(); renderCases(); renderOverview(); }
}

async function refreshProjectIndex() {
  state.projects = await api("/api/projects");
  renderOverview();
}

async function selectProject(id) {
  localStorage.setItem("agent-eval-project", id);
  state.selectedCases.clear();
  [state.project, state.datasets] = await Promise.all([api(`/api/projects/${id}`), api(`/api/projects/${id}/evaluation-sets`)]);
  const savedSet = Number(localStorage.getItem(`agent-eval-dataset-${id}`));
  const selectedSet = state.datasets.find(item => item.id === savedSet) || state.datasets[0] || null;
  state.dataset = selectedSet;
  $("#delete-project").disabled = false;
  state.cases = selectedSet ? await api(`/api/projects/${id}/cases?evaluation_set_id=${selectedSet.id}`) : [];
  $("#html-report").href = `/reports/${id}.html`;
  $("#xlsx-report").href = `/reports/${id}.xlsx`;
  $("#report-center-html").href = `/reports/${id}.html`;
  $("#report-center-xlsx").href = `/reports/${id}.xlsx`;
  renderSummary();
  renderBrief();
  renderCases();
  renderTargetConfig();
  renderOverview();
  renderDatasets();
  renderDatasetContext();
  renderRulesSummary();
  await loadJudgeModels();
  window.agentEvaluation?.refresh(true);
}

async function selectEvaluationSet(id, navigate = false) {
  const selected = state.datasets.find(item => item.id === Number(id));
  if (!selected) return;
  state.dataset = selected;
  localStorage.setItem(`agent-eval-dataset-${state.project.id}`, selected.id);
  state.selectedCases.clear();
  state.cases = await api(`/api/projects/${state.project.id}/cases?evaluation_set_id=${selected.id}`);
  renderDatasets(); renderDatasetContext(); renderCases(); renderSummary();
  window.agentEvaluation?.refresh(true);
  if (navigate) showView("cases");
}

function renderDatasetContext() {
  const name = state.dataset?.name || "未选择";
  if ($("#case-dataset-name")) $("#case-dataset-name").textContent = name;
  if ($("#run-dataset-name")) $("#run-dataset-name").textContent = name;
  const select = $("#run-dataset-select");
  if (select) {
    select.innerHTML = state.datasets.map(item => `<option value="${item.id}">${escapeHtml(item.name)} · ${item.case_count || 0} 条</option>`).join("") || `<option value="">暂无评测集</option>`;
    select.value = state.dataset?.id || "";
  }
}

function renderDatasets() {
  const root = $("#dataset-list");
  if (!root) return;
  root.innerHTML = state.datasets.length ? state.datasets.map(item => `<article class="dataset-row ${item.id === state.dataset?.id ? "current" : ""}" data-dataset-id="${item.id}">
    <button class="dataset-open" type="button"><span>${item.status === "published" ? "已发布" : "草稿"}</span><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.description || "暂无说明")}</small></button>
    <div class="dataset-count"><b>${item.case_count || 0}</b><span>条用例 · ${item.approved_count || 0} 条已审核</span></div>
    <div class="dataset-actions"><button type="button" class="dataset-rename">重命名</button><button type="button" class="dataset-publish" title="目前只改变草稿/已发布标记，不锁定用例或限制跑测">${item.status === "published" ? "撤回发布" : "标记发布"}</button><button type="button" class="dataset-delete" aria-label="删除评测集 ${escapeHtml(item.name)}">删除</button></div>
  </article>`).join("") : `<div class="panel empty-state compact-empty"><h2>当前项目还没有评测集</h2><p>先新建并命名评测集，再把 Excel 用例导入其中。</p></div>`;
  $("#delete-all-datasets").disabled = !state.project || !state.datasets.length;
  $$(".dataset-open", root).forEach(button => button.addEventListener("click", () => selectEvaluationSet(Number(button.closest(".dataset-row").dataset.datasetId), true)));
  $$(".dataset-rename", root).forEach(button => button.addEventListener("click", () => openDatasetDialog(Number(button.closest(".dataset-row").dataset.datasetId))));
  $$(".dataset-delete", root).forEach(button => button.addEventListener("click", () => deleteOneDataset(Number(button.closest(".dataset-row").dataset.datasetId)).catch(error => toast(error.message, true))));
  $$(".dataset-publish", root).forEach(button => button.addEventListener("click", async () => {
    const id = Number(button.closest(".dataset-row").dataset.datasetId); const item = state.datasets.find(value => value.id === id);
    await api(`/api/projects/${state.project.id}/evaluation-sets/${id}`, { method: "PATCH", body: JSON.stringify({ status: item.status === "published" ? "draft" : "published" }) });
    state.datasets = await api(`/api/projects/${state.project.id}/evaluation-sets`); renderDatasets(); renderDatasetContext(); toast(item.status === "published" ? "评测集已转为草稿" : "评测集已发布");
  }));
}

function renderRulesSummary() {
  if (!state.project || !$("#rules-summary")) return;
  $("#rules-summary").textContent = state.project.scoring_standard?.trim() || "当前项目还没有填写评分要求。进入评测集列表补充后，可在跑测中作为回答评判依据。";
}

function renderTargetConfig() {
  $("#adapter-overview").value = state.project.target_adapter || "mock";
  $("#office-base-url").value = state.project.target_base_url || "";
  $("#browser-office-url").value = state.project.target_base_url || state.cases.find(item => item.start_url)?.start_url || "";
  $("#office-agent-id").value = state.project.target_agent_id || "";
  $("#office-profile").value = state.project.target_profile || "";
  $("#office-jwt").value = "";
  refreshTargetConfig();
  updateWorkflowNote();
}

function updateWorkflowNote() {
  const collect = $("#workflow-mode").value === "collect_first";
  $("#workflow-note").textContent = collect
    ? "先把问题、回答和完整截图回填到原始 Excel；评测模型恢复后，再从批次详情统一补评。"
    : "每条用例完成截图后立即调用评测 Agent；评测成功后才继续下一条。";
}

function renderSummary() {
  renderOverview();
}

function renderOverview() {
  const batchCount = state.projects.reduce((sum, item) => sum + Number(item.batch_count || 0), 0);
  const runCount = state.projects.reduce((sum, item) => sum + Number(item.run_count || 0), 0);
  $("#overview-project-count").textContent = state.projects.length;
  $("#overview-batch-count").textContent = batchCount;
  $("#overview-run-count").textContent = runCount;
  if (!state.project) {
    $("#overview-current-key").textContent = "—";
    $("#overview-current-name").textContent = "新建项目后开始评测";
    $("#launch-project-name").textContent = "未选择项目";
    return;
  }
  $("#overview-current-key").textContent = state.project.project_key;
  $("#overview-current-name").textContent = state.project.name;
  $("#launch-project-name").textContent = state.project.name;
  renderDatasets();
}

function bindPortfolioEvents() {
  $$(".switch-project").forEach(button => button.addEventListener("click", async () => {
    const id = Number(button.closest(".portfolio-project").dataset.projectId);
    $("#project-select").value = id;
    await selectProject(id);
    toast("已切换项目");
  }));
  $$(".batch-row").forEach(button => button.addEventListener("click", () => openBatchDetail(Number(button.dataset.batchId)).catch(error => toast(error.message, true))));
  $$(".project-case-fold").forEach(fold => fold.addEventListener("toggle", async () => {
    if (!fold.open) return;
    const projectId = Number(fold.closest(".portfolio-project").dataset.projectId);
    if (!state.portfolioCases[projectId]) state.portfolioCases[projectId] = projectId === state.project.id ? state.cases : await api(`/api/projects/${projectId}/cases`);
    const node = $(`[data-project-cases="${projectId}"]`);
    node.innerHTML = state.portfolioCases[projectId].map(item => `<div><span>${escapeHtml(item.code)}</span><b>${escapeHtml(item.title)}</b><em class="${item.approved ? "ok" : ""}">${item.approved ? "已审核" : "待审核"}</em></div>`).join("") || `<p class="project-empty">还没有测试用例</p>`;
  }));
}

async function openBatchDetail(id) {
  const batch = await api(`/api/batches/${id}`);
  $("#batch-detail-title").textContent = `${batch.project_key} · 第 ${batch.id} 次评测`;
  const collected = batch.workflow_mode === "collect_first";
  $("#batch-detail-content").innerHTML = `<div class="batch-mode"><b>${collected ? "先统一采集，再补评" : "逐条采集并立即评测"}</b><span>${collected && batch.evaluation_status !== "completed" ? "回答与证据已保存，尚未调用评测 Agent" : "本批次已完成评测"}</span></div>
    <div class="batch-summary"><span><b>${batch.total}</b>计划用例</span><span><b>${batch.completed}</b>已采集</span><span><b>${batch.passed}</b>通过</span><span><b>${batch.failed}</b>未通过/失败</span></div>
    <div class="batch-runs">${batch.runs.map(run => { const shots = Array.isArray(run.screenshot_paths) ? run.screenshot_paths : (run.screenshot_path ? [run.screenshot_path] : []); return `<article><div><span>${escapeHtml(run.source_sheet_name || "手工用例")} · ${escapeHtml(run.source_case_code || run.code)}</span><b>${escapeHtml(run.title)}</b><small>问题：${escapeHtml(run.query)}</small><small>回复：${escapeHtml(run.actual_answer || "未捕获回复")}</small></div><strong class="${run.status === "collected" ? "pending" : run.passed ? "ok" : "fail"}">${run.status === "collected" ? "已采集 · 待评测" : run.status === "completed" ? `${Number(run.score).toFixed(0)} · ${run.passed ? "通过" : "未通过"}` : "执行失败"}</strong><p>${escapeHtml(run.summary || "暂无评测结论")}</p>${shots.length ? `<div class="shot-links">${shots.map((shot, index) => `<a href="${escapeHtml(shot)}" target="_blank">截图 ${index + 1} ↗</a>`).join("")}</div>` : ""}</article>`; }).join("")}</div>
    <div class="batch-report-link">${batch.result_workbook_path ? `<a class="button signal" href="${escapeHtml(batch.result_workbook_path)}" target="_blank">下载截图回填 Excel</a>` : ""}${collected && batch.evaluation_status !== "completed" ? `<button class="button ink" id="evaluate-collected" data-batch-id="${batch.id}">统一评测已采集回答</button>` : ""}<a class="button ghost" href="/reports/${batch.project_id}.html?batch=${batch.id}" target="_blank">打开本次完整报告</a></div>`;
  $("#evaluate-collected")?.addEventListener("click", event => evaluateCollectedBatch(Number(event.currentTarget.dataset.batchId), event.currentTarget));
  $("#batch-dialog").showModal();
}

async function evaluateCollectedBatch(batchId, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "正在调用评测 Agent…";
  try {
    await api(`/api/batches/${batchId}/evaluate`, { method: "POST" });
    toast("统一补评已完成");
    await refreshProjectIndex();
    await openBatchDetail(batchId);
  } catch (error) {
    toast(`补评未完成：${error.message}`, true);
    button.disabled = false;
    button.textContent = original;
  }
}

function renderBrief() {
  const form = $("#brief-form");
  ["name", "background", "capabilities", "boundaries", "scoring_standard"].forEach(name => form.elements[name].value = state.project[name] || "");
}

async function loadQuestions() {
  const data = await api(`/api/projects/${state.project.id}/clarify`, { method: "POST" });
  $("#questions").innerHTML = data.questions.map((item, index) => `<div class="question-card"><b>Q${String(index + 1).padStart(2, "0")}</b><span>${escapeHtml(item.question)}</span></div>`).join("");
  return data;
}

function renderCases() {
  const cases = state.cases.filter(item => state.filter === "all" || (state.filter === "approved" ? item.approved : !item.approved));
  $("#case-list").innerHTML = cases.length ? cases.map(item => `
    <article class="case-row" data-case-id="${item.id}" tabindex="0">
      <label class="case-select-control" aria-label="选择 ${escapeHtml(item.code)}"><input class="case-select" type="checkbox" value="${item.id}" ${state.selectedCases.has(item.id) ? "checked" : ""}><span></span></label>
      <span class="case-code">${escapeHtml(item.code)}</span>
      <div class="case-main"><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.query)}</span></div>
      <span class="tag">${escapeHtml(item.category)} · ${escapeHtml(item.execution_type || "dialogue")}</span><span class="priority">${item.priority}</span>
      <div class="case-actions"><span class="review-state ${item.approved ? "ok" : ""}">${item.approved ? "● 已审核" : "○ 待审核"}</span><button type="button" class="case-edit" aria-label="编辑 ${escapeHtml(item.code)}">编辑</button></div>
    </article>`).join("") : `<div class="panel empty-state"><h2>当前筛选下没有用例</h2></div>`;
  $$(".case-row").forEach(row => {
    row.addEventListener("click", event => { if (!event.target.closest("input,button,label")) openCase(Number(row.dataset.caseId)); });
    row.addEventListener("keydown", event => { if (event.key === "Enter" && !event.target.closest("input,button,label")) openCase(Number(row.dataset.caseId)); });
  });
  $$(".case-select").forEach(input => input.addEventListener("change", () => {
    const id = Number(input.value);
    if (input.checked) state.selectedCases.add(id); else state.selectedCases.delete(id);
    updateCaseSelectionBar(cases);
  }));
  $$(".case-edit").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    openCase(Number(button.closest(".case-row").dataset.caseId));
  }));
  updateCaseSelectionBar(cases);
}

function updateCaseSelectionBar(visibleCases = state.cases.filter(item => state.filter === "all" || (state.filter === "approved" ? item.approved : !item.approved))) {
  const selected = state.selectedCases.size;
  const visibleIds = visibleCases.map(item => item.id);
  const selectedVisible = visibleIds.filter(id => state.selectedCases.has(id)).length;
  $("#selected-case-count").textContent = selected ? `已选择 ${selected} 条用例` : "未选择用例";
  $("#delete-selected-cases").disabled = !selected;
  $("#clear-case-selection").disabled = !selected;
  const selectAll = $("#select-visible-cases");
  selectAll.checked = Boolean(visibleIds.length && selectedVisible === visibleIds.length);
  selectAll.indeterminate = Boolean(selectedVisible && selectedVisible < visibleIds.length);
}

function openCase(id) {
  const item = state.cases.find(value => value.id === id) || {
    id: "", title: "", category: "基础能力", priority: "P0", query: "", expected_answer: "",
    expected_keywords: [], forbidden_keywords: [], approved: false, execution_type: "browser",
    start_url: state.project.target_base_url || "", browser_steps: [],
  };
  const form = $("#case-form");
  form.elements.id.value = item.id;
  form.elements.category.value = item.category || "基础能力";
  form.elements.title.value = item.title;
  form.elements.priority.value = item.priority;
  form.elements.query.value = item.query;
  form.elements.expected_answer.value = item.expected_answer;
  const trace = item.expected_trace || {};
  form.elements.required_tools.value = (trace.required_tools || []).join("，");
  form.elements.forbidden_tools.value = (trace.forbidden_tools || []).join("，");
  form.elements.tool_ordered.checked = Boolean(trace.ordered);
  form.elements.parameter_constraints.value = trace.parameter_constraints || "";
  form.elements.max_tool_calls.value = trace.max_tool_calls ?? "";
  form.elements.trace_notes.value = trace.notes || "";
  form.elements.expected_keywords.value = item.expected_keywords.join("，");
  form.elements.forbidden_keywords.value = item.forbidden_keywords.join("，");
  form.elements.approved.checked = Boolean(item.approved);
  form.elements.execution_type.value = item.execution_type || "dialogue";
  form.elements.start_url.value = item.start_url || "";
  form.elements.browser_steps.value = JSON.stringify(item.browser_steps || [], null, 2);
  const sourceFields = Object.entries(item.source_fields || {});
  const sourceWrap = $("#case-source-fields-wrap");
  sourceWrap.hidden = !sourceFields.length;
  $("#case-source-fields").innerHTML = sourceFields.map(([name, value]) =>
    `<div class="source-field"><b>${escapeHtml(name)}</b><span>${escapeHtml(value ?? "")}</span></div>`).join("");
  $("#case-dialog").showModal();
}

async function saveCase(event) {
  event.preventDefault();
  const form = $("#case-form");
  const id = form.elements.id.value;
  const split = value => value.split(/[，,]/).map(item => item.trim()).filter(Boolean);
  const query = form.elements.query.value.trim();
  const payload = {
    category: form.elements.category.value,
    title: form.elements.title.value.trim() || query.slice(0, 42),
    priority: form.elements.priority.value,
    query,
    expected_answer: form.elements.expected_answer.value,
    expected_trace_json: { required_tools: split(form.elements.required_tools.value), forbidden_tools: split(form.elements.forbidden_tools.value),
      ordered: form.elements.tool_ordered.checked, parameter_constraints: form.elements.parameter_constraints.value.trim(),
      max_tool_calls: form.elements.max_tool_calls.value === "" ? null : Number(form.elements.max_tool_calls.value), notes: form.elements.trace_notes.value.trim() },
    expected_keywords: split(form.elements.expected_keywords.value),
    forbidden_keywords: split(form.elements.forbidden_keywords.value),
    execution_type: form.elements.execution_type.value,
    start_url: form.elements.start_url.value.trim(),
    browser_steps: parseBrowserStepsInput(form.elements.browser_steps.value),
    approved: form.elements.approved.checked,
    evaluation_set_id: state.dataset?.id,
  };
  if (id) await api(`/api/cases/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
  else await api(`/api/projects/${state.project.id}/cases`, { method: "POST", body: JSON.stringify(payload) });
  $("#case-dialog").close();
  state.cases = state.dataset ? await api(`/api/projects/${state.project.id}/cases?evaluation_set_id=${state.dataset.id}`) : [];
  state.project = await api(`/api/projects/${state.project.id}`);
  await refreshProjectIndex();
  renderCases(); renderSummary(); toast("用例已保存");
}

function openProjectDialog() {
  const form = $("#project-form");
  form.reset();
  $("#project-dialog").showModal();
}

async function loadJudgeModels() {
  if (!state.project) { state.judgeModels = []; renderJudgeModels(); return; }
  const projectId = state.project.id;
  const models = await api(`/api/projects/${projectId}/judge-models`);
  if (state.project?.id !== projectId) return;
  state.judgeModels = models;
  renderJudgeModels();
  window.agentEvaluation?.refreshModelOptions?.();
  loadHarnessStatus().catch(() => {});
}

function renderJudgeModels() {
  const root = $("#judge-model-list");
  if (!root) return;
  const models = state.judgeModels;
  const group = (source, title, description) => `<section class="judge-model-group"><header><h2>${title}<span>${models.filter(item => item.source === source).length}</span></h2><p>${description}</p></header>${models.filter(item => item.source === source).map(item => `<article class="judge-model-row" data-model-id="${escapeHtml(item.id)}">
    <div><div class="judge-model-label"><b>${escapeHtml(item.name)}</b>${item.is_default ? '<span>项目默认</span>' : ""}</div><small>${escapeHtml(item.base_url)} · ${source === "builtin" ? "沿用后台密钥" : "本项目密钥已保存"}</small></div>
    <div class="judge-model-actions"><button type="button" data-action="test">测试连接</button>${item.is_default ? "" : '<button type="button" data-action="default">设为默认</button>'}${source === "custom" ? '<button type="button" data-action="edit">编辑</button><button type="button" data-action="delete" class="judge-danger">删除</button>' : ""}</div>
  </article>`).join("") || `<p class="judge-group-empty">${source === "builtin" ? "后台未配置共用网关与密钥；检查 .env 中的 PI_PROVIDER、PI_BASE_URL 和 PI_API_KEY。" : "还没有自定义模型；需要其他接口时可在这里添加。"}</p>`}</section>`;
  root.innerHTML = group("builtin", "内置模型", "后端预设模型 ID，共用 .env 网关与密钥；无需重复填写 Key。") + group("custom", "自定义模型", "为当前项目添加另一组 OpenAI 兼容接口、模型 ID 和密钥。");
  const picker = $("#run-judge-model-select");
  picker.disabled = !models.length;
  picker.innerHTML = models.length ? ["builtin", "custom"].map(source => {
    const items = models.filter(item => item.source === source);
    return items.length ? `<optgroup label="${source === "builtin" ? "内置模型" : "自定义模型"}">${items.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</optgroup>` : "";
  }).join("") : '<option value="">尚未配置评测模型</option>';
  picker.value = models.find(item => item.is_default)?.id || "";
}

function openJudgeModelForm(id = "") {
  const form = $("#judge-model-form");
  const item = state.judgeModels.find(value => value.id === id);
  if (item?.source === "builtin") throw new Error("内置模型请在后台 .env 配置，页面不可编辑");
  form.reset();
  form.elements.id.value = item?.id || "";
  form.elements.name.value = item?.name || "";
  form.elements.model_id.value = item?.model_id || "";
  form.elements.base_url.value = item?.base_url || "";
  form.elements.api_key.required = !item;
  form.elements.is_default.checked = Boolean(item?.is_default);
  $("#judge-key-hint").textContent = item ? "留空表示保留已保存的密钥；不会回显" : "只保存在本机，不会回显";
  $("#judge-model-form-title").textContent = item ? "编辑自定义模型" : "新增自定义模型";
  form.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function saveJudgeModel(event) {
  event.preventDefault();
  if (!state.project) throw new Error("请先选择项目");
  const form = event.currentTarget, id = form.elements.id.value;
  const body = { name: form.elements.name.value.trim(), model_id: form.elements.model_id.value.trim(),
    base_url: form.elements.base_url.value.trim(), api_key: form.elements.api_key.value.trim(),
    is_default: form.elements.is_default.checked };
  await api(`/api/projects/${state.project.id}/judge-models${id ? `/${id}` : ""}`, {
    method: id ? "PATCH" : "POST", body: JSON.stringify(body),
  });
  form.hidden = true;
  await loadJudgeModels();
  await loadHarnessStatus();
  toast(id ? "评测模型已更新" : "评测模型已保存");
}

async function handleJudgeModelAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button || !state.project) return;
  const id = button.closest("[data-model-id]").dataset.modelId;
  const item = state.judgeModels.find(value => value.id === id);
  if (!item) return;
  if (button.dataset.action === "edit") { openJudgeModelForm(id); return; }
  if (button.dataset.action === "delete") {
    if (!window.confirm(`删除评测模型「${item.name}」？已保存的历史评测结果保留；新的评测将不能再选择此配置。`)) return;
    await api(`/api/projects/${state.project.id}/judge-models/${id}`, { method: "DELETE" });
    await loadJudgeModels(); toast("评测模型已删除"); return;
  }
  if (button.dataset.action === "default") {
    await api(`/api/projects/${state.project.id}/judge-models/${id}`, { method: "PATCH", body: JSON.stringify({ is_default: true }) });
    await loadJudgeModels(); toast("已设为当前项目默认评测模型"); return;
  }
  if (button.dataset.action === "test") {
    button.disabled = true; button.textContent = "连接中…";
    try { const result = await api(`/api/projects/${state.project.id}/judge-models/${id}/test`, { method: "POST" }); toast(result.message); }
    finally { button.disabled = false; button.textContent = "测试连接"; }
  }
}

async function createProject(event) {
  event.preventDefault();
  const form = $("#project-form");
  const name = form.elements.name.value.trim();
  const project_key = form.elements.project_key.value.trim().toUpperCase();
  const start_url = form.elements.start_url.value.trim();
  if (!name || !project_key) throw new Error("请填写项目名称和项目代码");
  const created = await api("/api/projects", { method: "POST", body: JSON.stringify({ name, project_key }) });
  if (start_url) await api(`/api/projects/${created.id}`, { method: "PATCH", body: JSON.stringify({ target_adapter: "browser", target_base_url: start_url }) });
  $("#project-dialog").close();
  state.projects = await api("/api/projects");
  $("#project-select").innerHTML = state.projects.map(item => `<option value="${item.id}">[${escapeHtml(item.project_key || `PRJ-${item.id}`)}] ${escapeHtml(item.name)}</option>`).join("");
  $("#project-select").value = created.id;
  await selectProject(created.id);
  showView("brief");
  toast(`已创建独立项目 ${project_key}`);
}

function openDatasetDialog(id = 0) {
  const item = state.datasets.find(value => value.id === id);
  const form = $("#dataset-form"); form.reset();
  form.elements.id.value = item?.id || "";
  form.elements.name.value = item?.name || "";
  form.elements.description.value = item?.description || "";
  $("#dataset-dialog-title").textContent = item ? "编辑评测集" : "新建评测集";
  $("#dataset-dialog").showModal();
}

async function saveDataset(event) {
  event.preventDefault();
  const form = $("#dataset-form"); const id = Number(form.elements.id.value || 0);
  const payload = { name: form.elements.name.value.trim(), description: form.elements.description.value.trim() };
  if (!payload.name) throw new Error("请填写评测集名称");
  const saved = id
    ? await api(`/api/projects/${state.project.id}/evaluation-sets/${id}`, { method: "PATCH", body: JSON.stringify(payload) })
    : await api(`/api/projects/${state.project.id}/evaluation-sets`, { method: "POST", body: JSON.stringify(payload) });
  state.datasets = await api(`/api/projects/${state.project.id}/evaluation-sets`);
  await selectEvaluationSet(saved.id);
  $("#dataset-dialog").close();
  toast(id ? "评测集名称已更新" : `已创建评测集「${saved.name}」`);
}

async function deleteCurrentProject() {
  if (!state.project) return;
  const project = state.project;
  const confirmation = window.prompt(`删除项目「${project.name}」会删除它的全部评测集、用例、运行记录和 Agent 评测。此操作无法撤销。\n请输入完整项目名称确认：`);
  if (confirmation === null) return;
  if (confirmation.trim() !== project.name) { toast("项目名称不一致，未删除", true); return; }
  await api(`/api/projects/${project.id}`, { method: "DELETE", body: JSON.stringify({ confirm_name: confirmation.trim() }) });
  localStorage.removeItem(`agent-eval-dataset-${project.id}`);
  localStorage.removeItem("agent-eval-project");
  delete state.portfolioCases[project.id];
  await loadProjects();
  showView("overview");
  toast(`项目「${project.name}」已删除`);
}

async function deleteAllDatasets() {
  if (!state.project || !state.datasets.length) return;
  const projectId = state.project.id;
  const caseCount = state.datasets.reduce((sum, item) => sum + Number(item.case_count || 0), 0);
  if (!window.confirm(`确定清空「${state.project.name}」的全部 ${state.datasets.length} 个评测集和约 ${caseCount} 条用例吗？\n依赖这些用例的执行记录也会删除；项目本身和项目资料保留。此操作无法撤销。`)) return;
  const result = await api(`/api/projects/${projectId}/evaluation-sets`, { method: "DELETE", body: JSON.stringify({ confirm: true }) });
  localStorage.removeItem(`agent-eval-dataset-${projectId}`);
  state.datasets = []; state.dataset = null; state.cases = []; state.selectedCases.clear();
  delete state.portfolioCases[projectId];
  await refreshProjectIndex();
  renderDatasets(); renderDatasetContext(); renderCases();
  window.agentEvaluation?.refresh(true);
  toast(`已清空 ${result.deleted_sets} 个评测集、${result.deleted_cases} 条用例及 ${result.deleted_runs} 条执行记录`);
}

async function deleteOneDataset(id) {
  const item = state.datasets.find(value => value.id === id);
  if (!item || !state.project) return;
  if (!window.confirm(`确定删除评测集「${item.name}」吗？\n仅属于它的用例及关联执行记录会删除；其他评测集共用的用例会保留。此操作无法撤销。`)) return;
  const projectId = state.project.id;
  const result = await api(`/api/projects/${projectId}/evaluation-sets/${id}`, { method: "DELETE", body: JSON.stringify({ confirm: true }) });
  state.datasets = await api(`/api/projects/${projectId}/evaluation-sets`);
  if (state.dataset?.id === id) {
    state.dataset = state.datasets[0] || null;
    if (state.dataset) localStorage.setItem(`agent-eval-dataset-${projectId}`, state.dataset.id);
    else localStorage.removeItem(`agent-eval-dataset-${projectId}`);
  }
  state.cases = state.dataset ? await api(`/api/projects/${projectId}/cases?evaluation_set_id=${state.dataset.id}`) : [];
  state.selectedCases.clear();
  delete state.portfolioCases[projectId];
  state.project = await api(`/api/projects/${projectId}`);
  await refreshProjectIndex();
  renderDatasets(); renderDatasetContext(); renderCases(); renderSummary();
  window.agentEvaluation?.refresh(true);
  const shared = result.retained_shared_cases ? `；${result.retained_shared_cases} 条共用用例保留在其他评测集` : "";
  toast(`已删除「${item.name}」及 ${result.deleted_cases} 条专属用例${shared}`);
}

function parseBrowserStepsInput(value) {
  if (!value.trim()) return [];
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("浏览器步骤必须是有效的 JSON"); }
  if (!Array.isArray(parsed)) throw new Error("浏览器步骤必须是数组");
  return parsed;
}

async function runApproved(button) {
  const adapter = $("#adapter-overview").value;
  const original = button.innerHTML;
  button.disabled = true;
  try {
    if (adapter === "browser") {
      button.textContent = "正在读取办公室分组…";
      await saveTargetConfig();
      const start_url = $("#browser-office-url").value.trim();
      if (!start_url) throw new Error("请填写 Office 页面地址");
      const preferredMode = state.officeRunMode === "manual" ? "manual" : "auto";
      const preferredRadio = $(`#office-run-mode input[value="${preferredMode}"]`);
      if (preferredRadio) preferredRadio.checked = true;
      await populateOfficePlan(preferredMode, true);
      button.textContent = "正在打开 Office…";
      await api("/api/browser/session", { method: "POST", body: JSON.stringify({ start_url }) });
      $("#confirm-browser-run").disabled = false;
      $("#confirm-browser-run").textContent = state.officeRunMode === "manual" ? "开始执行" : "保存映射并开始执行";
      $("#browser-ready-dialog").showModal();
      toast("请确认实际 Office 映射和本次用例范围");
      return;
    }
    await executeApproved(adapter, button);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.innerHTML = original; }
}

async function populateOfficePlan(mode = "auto", fallbackToManual = false) {
  const mappedPlans = await api(`/api/projects/${state.project.id}/offices`);
  const approved = state.cases.filter(item => item.approved);
  const assignedIds = new Set(mappedPlans.flatMap(plan => plan.cases.map(item => item.id)));
  const unassigned = approved.filter(item => !assignedIds.has(item.id));
  if (mode === "auto" && fallbackToManual && !mappedPlans.length) {
    mode = "manual";
    const manualRadio = $('#office-run-mode input[value="manual"]');
    if (manualRadio) manualRadio.checked = true;
  }
  state.officeRunMode = mode;
  if (mode === "manual") {
    const bySheet = new Map();
    approved.forEach(item => {
      const sheetName = item.source_sheet_name || "未命名分组";
      if (!bySheet.has(sheetName)) bySheet.set(sheetName, []);
      bySheet.get(sheetName).push(item);
    });
    state.officePlans = [...bySheet.entries()].map(([sheetName, cases]) => ({
      office_key: `__manual__:${sheetName}`, generated_name: sheetName, actual_office_name: "", actual_office_url: "", cases,
    }));
  } else state.officePlans = [...mappedPlans];
  $("#confirm-browser-run").textContent = mode === "manual" ? "开始执行" : "保存映射并开始执行";
  $("#office-mode-note").textContent = mode === "manual"
    ? "请先在测试浏览器中手动进入目标 Agent。系统不会切换 Office，点击开始之前不会发送问题。"
    : `系统将按名称自动切换 Office。${unassigned.length ? `${unassigned.length} 条缺少办公室字段的用例不会在自动模式执行。` : ""}`;
  const root = $("#office-run-plan");
  root.innerHTML = state.officePlans.map((plan, index) => {
    const currentOffice = plan.office_key.startsWith("__manual__:");
    return `<section class="office-plan-grid office-plan-row" data-office-index="${index}">
    <div class="actual-office-cell">${currentOffice ? `<div class="current-office-note"><b>无需办公室字段</b><small>将在你当前手动打开的 Office / Agent 中执行</small></div>` : `
      <label>名称<input class="actual-office-name" value="${escapeHtml(plan.actual_office_name || plan.generated_name)}" placeholder="输入已创建的 Office 名称"></label>
      <details><summary>直达地址（可选）</summary><input class="actual-office-url" type="url" value="${escapeHtml(plan.actual_office_url || "")}" placeholder="https://…"></details>`}
    </div>
    <label class="generated-office-cell"><input class="office-group-check" type="checkbox" checked><span><b>${escapeHtml(plan.generated_name)}</b><small>${plan.cases.length} 条已审核用例 · 第 ${index + 1} 组</small></span></label>
    <details class="office-case-cell"><summary><span>查看并选择用例</span><b>${plan.cases.length}/${plan.cases.length}</b></summary>
      <div class="office-case-list">${plan.cases.map(item => `<label><input class="office-case-check" type="checkbox" value="${item.id}" checked><span><b>${escapeHtml(item.source_case_code || item.code)}</b><small>${escapeHtml(item.query)}</small></span></label>`).join("")}</div>
    </details>
  </section>`; }).join("") || `<div class="office-plan-empty"><b>没有可执行用例</b><span>请先导入并审核测试用例。</span></div>`;
  $$(".office-group-check", root).forEach(input => input.addEventListener("change", () => {
    const row = input.closest(".office-plan-row");
    $$(".office-case-check", row).forEach(item => { item.checked = input.checked; });
    updateOfficeSelection();
  }));
  $$(".office-case-check", root).forEach(input => input.addEventListener("change", updateOfficeSelection));
  updateOfficeSelection();
}

function selectedRunCaseIds() {
  return $$("#office-run-plan .office-case-check:checked").map(input => Number(input.value));
}

function updateOfficeSelection() {
  $$("#office-run-plan .office-plan-row").forEach(row => {
    const group = $(".office-group-check", row);
    const cases = $$(".office-case-check", row);
    const selected = cases.filter(item => item.checked).length;
    group.checked = Boolean(cases.length && selected === cases.length);
    group.indeterminate = Boolean(selected && selected < cases.length);
    const count = $(".office-case-cell summary b", row);
    if (count) count.textContent = `${selected}/${cases.length}`;
    row.classList.toggle("selected", Boolean(selected));
  });
  const count = selectedRunCaseIds().length;
  const offices = $$("#office-run-plan .office-plan-row").filter(row => $$(".office-case-check:checked", row).length).length;
  $("#run-scope-summary").textContent = count ? `已选择 ${offices} 个 Office，共 ${count} 条用例` : "请至少选择一条用例";
}

function officeMappingPayload() {
  return $$("#office-run-plan .office-plan-row").map(row => {
    const plan = state.officePlans[Number(row.dataset.officeIndex)];
    if (!plan || plan.office_key.startsWith("__manual__:")) return null;
    return {
      office_key: plan?.office_key || "",
      generated_name: plan?.generated_name || "",
      actual_office_name: $(".actual-office-name", row).value.trim(),
      actual_office_url: $(".actual-office-url", row).value.trim(),
    };
  }).filter(Boolean);
}

async function executeApproved(adapter, button) {
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = "正在发送问题、截图并评分…";
  try {
    const target = adapter === "office_agent" ? officeTargetPayload() : undefined;
    const result = await api("/api/runs", { method: "POST", body: JSON.stringify({ project_id: state.project.id, adapter, target, case_ids: [] }) });
    toast(`已完成 ${result.count} 条用例`);
    state.project = await api(`/api/projects/${state.project.id}`);
    await refreshProjectIndex(); renderSummary(); await loadRuns(); showView("runs");
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

async function confirmBrowserRun(event) {
  event.preventDefault();
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "正在创建执行任务…";
  try {
    const case_ids = selectedRunCaseIds();
    if (!case_ids.length) throw new Error("请至少选择一条要执行的用例");
    const office_mode = $('#office-run-mode input[name="office_run_mode"]:checked')?.value === "manual" ? "manual" : "auto";
    const mappings = officeMappingPayload();
    const selectedSet = new Set(case_ids);
    if (office_mode === "auto") {
      for (const plan of state.officePlans) {
        if (plan.office_key.startsWith("__manual__:") || !plan.cases.some(item => selectedSet.has(item.id))) continue;
        const mapping = mappings.find(item => item.office_key === plan.office_key);
        if (!mapping?.actual_office_name) throw new Error(`请为“${plan.generated_name}”填写实际 Office 名称`);
      }
      if (mappings.length) state.officePlans = await api(`/api/projects/${state.project.id}/offices`, { method: "PATCH", body: JSON.stringify({ mappings }) });
    }
    const workflow_mode = $("#workflow-mode").value;
    const job = await api("/api/browser-jobs", { method: "POST", body: JSON.stringify({ project_id: state.project.id, case_ids, workflow_mode, office_mode }) });
    state.browserJob = job;
    $("#browser-ready-dialog").close();
    $("#browser-progress-dialog").showModal();
    renderBrowserJob(job);
    startJobPolling();
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
    button.textContent = office_mode === "manual" ? "开始执行" : "保存映射并开始执行";
  }
}

function startJobPolling() {
  clearInterval(state.jobPoll);
  state.jobPoll = setInterval(async () => {
    if (!state.browserJob) return;
    try {
      const job = await api(`/api/browser-jobs/${state.browserJob.id}`);
      state.browserJob = job;
      renderBrowserJob(job);
      if (["completed", "failed"].includes(job.status)) {
        clearInterval(state.jobPoll);
        state.jobPoll = null;
        state.project = await api(`/api/projects/${state.project.id}`);
        await refreshProjectIndex(); renderSummary();
      }
    } catch (error) { clearInterval(state.jobPoll); toast(error.message, true); }
  }, 1000);
}

function renderBrowserJob(job) {
  const percent = job.total ? Math.round(job.completed / job.total * 100) : 0;
  $("#job-progress-count").textContent = `${job.completed} / ${job.total}`;
  $("#job-progress-percent").textContent = `${percent}%`;
  $("#job-progress-bar").style.width = `${percent}%`;
  $("#job-current-code").textContent = job.current_code || (job.status === "completed" ? "全部完成" : "准备中");
  $("#job-current-title").textContent = [job.current_office_name, job.current_title].filter(Boolean).join(" · ");
  $("#job-stage").textContent = job.error || job.warning || job.stage;
  $("#job-passed").textContent = job.workflow_mode === "collect_first" ? "—" : job.passed;
  $("#job-failed").textContent = job.failed;
  const pause = $("#toggle-job-pause");
  pause.textContent = job.status === "paused" || job.status === "pausing" ? "继续执行" : "当前用例完成后暂停";
  pause.disabled = ["completed", "failed"].includes(job.status);
  $("#close-job-progress").disabled = !["completed", "failed"].includes(job.status);
}

async function toggleJobPause() {
  const job = state.browserJob;
  if (!job) return;
  const action = job.status === "paused" || job.status === "pausing" ? "resume" : "pause";
  state.browserJob = await api(`/api/browser-jobs/${job.id}/${action}`, { method: "POST" });
  renderBrowserJob(state.browserJob);
}

async function closeJobProgress() {
  $("#browser-progress-dialog").close();
  await loadRuns();
  showView("runs");
}

function openImportDialog() {
  if (!state.dataset) { toast("请先新建或选择一个评测集", true); return; }
  const form = $("#import-form");
  form.reset();
  $("#import-current-project").textContent = state.project.name;
  $("#import-current-dataset").textContent = state.dataset.name;
  state.importInspection = null;
  $("#import-schema-preview").hidden = true;
  $("#import-schema-preview").innerHTML = "";
  $("#confirm-import").disabled = true;
  $("#import-dialog").showModal();
}

function closeImportDialog() {
  $("#import-dialog").close();
  state.importInspection = null;
}

function readExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("读取 Excel 文件失败"));
    reader.readAsDataURL(file);
  });
}

async function inspectImportFile() {
  const file = $("#import-form").elements.excel_file.files[0];
  const preview = $("#import-schema-preview");
  const button = $("#confirm-import");
  state.importInspection = null;
  button.disabled = true;
  if (!file) { preview.hidden = true; return; }
  if (!/\.xlsx$/i.test(file.name)) throw new Error("请选择 .xlsx 格式的 Excel 文件");
  preview.hidden = false;
  preview.innerHTML = "<p class=\"schema-loading\">正在检查表头…</p>";
  try {
    const file_base64 = await readExcelFile(file);
    const result = await api("/api/cases/import/inspect", { method: "POST", body: JSON.stringify({ filename: file.name, file_base64 }) });
    state.importInspection = result;
    const sheets = result.sheets.map(sheet => {
      const pairs = Object.entries(sheet.matched).map(([field, header]) => `<span>${escapeHtml(header)}</span>`).join("");
      const problem = sheet.missing.length ? `<small>缺少：${escapeHtml(sheet.missing.join("、"))}</small>`
        : `<small>识别为用例表，共 ${sheet.columns?.length || 0} 列；所有列都会保留</small>`;
      return `<div class=\"schema-sheet ${sheet.importable ? "ok" : "error"}\"><b>${escapeHtml(sheet.sheet_name)}</b><div>${pairs}</div>${problem}</div>`;
    }).join("");
    const ignored = result.ignored_sheets.length ? `<p class=\"schema-ignored\">忽略非用例分表：${escapeHtml(result.ignored_sheets.join("、"))}</p>` : "";
    preview.innerHTML = `${sheets}${ignored}`;
    button.disabled = !result.valid;
  } catch (error) {
    preview.innerHTML = `<div class=\"schema-sheet error\"><b>无法解析该文件</b><small>${escapeHtml(error.message)}</small></div>`;
    throw error;
  }
}

async function importExcel(event) {
  event.preventDefault();
  const form = $("#import-form");
  const file = form.elements.excel_file.files[0];
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) throw new Error("请选择 .xlsx 格式的 Excel 文件");
  if (!state.importInspection?.valid) throw new Error("请先选择文件并通过表头检查");
  const file_base64 = await readExcelFile(file);
  const targetSetId = state.dataset?.id;
  if (!targetSetId) throw new Error("请先选择评测集");
  const button = $("#confirm-import");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "正在读取并导入…";
  try {
    try {
      const result = await api(`/api/projects/${state.project.id}/cases/import`, { method: "POST",
        body: JSON.stringify({ filename: file.name, file_base64, evaluation_set_id: targetSetId }) });
      state.datasets = await api(`/api/projects/${state.project.id}/evaluation-sets`);
      state.dataset = state.datasets.find(item => item.id === targetSetId);
      state.cases = result.cases;
      state.project = await api(`/api/projects/${state.project.id}`);
      state.selectedCases.clear();
      $("#import-dialog").close();
      await refreshProjectIndex();
      renderDatasets(); renderDatasetContext(); renderCases(); renderSummary(); showView("cases");
      toast(importResultMessage(result, `已导入「${state.dataset.name}」`), Boolean(result.skipped));
    } catch (error) { throw error; }
  } finally { button.disabled = false; button.textContent = original; }
}

function importResultMessage(result, prefix) {
  const office = result.office_count ? `，生成 ${result.office_count} 个办公室分组` : "";
  const skipped = result.skipped ? `，跳过 ${result.skipped} 条不完整行` : "";
  return `${prefix}：导入 ${result.imported} 条用例${office}${skipped}`;
}

async function deleteSelectedCases() {
  const ids = [...state.selectedCases];
  if (!ids.length) return;
  const message = `确定删除当前项目中选中的 ${ids.length} 条用例吗？\n如果用例已有执行记录，相关对话、评分和截图索引也会一并清理。\n此操作无法撤销。`;
  if (!window.confirm(message)) return;
  const button = $("#delete-selected-cases");
  button.disabled = true;
  try {
    const result = await api(`/api/projects/${state.project.id}/cases`, { method: "DELETE", body: JSON.stringify({ case_ids: ids }) });
    state.cases = state.dataset ? await api(`/api/projects/${state.project.id}/cases?evaluation_set_id=${state.dataset.id}`) : [];
    state.selectedCases.clear();
    state.portfolioCases[state.project.id] = state.cases;
    state.project = await api(`/api/projects/${state.project.id}`);
    await refreshProjectIndex();
    renderCases(); renderSummary();
    toast(`已删除 ${result.deleted} 条用例${result.deleted_runs ? `及 ${result.deleted_runs} 条关联执行记录` : ""}`);
  } finally { button.disabled = false; }
}

function officeTargetPayload() {
  const base_url = $("#office-base-url").value.trim().replace(/\/+$/, "");
  const agent_id = $("#office-agent-id").value.trim();
  const profile = $("#office-profile").value.trim();
  const jwt = $("#office-jwt").value.trim();
  if (!base_url) throw new Error("请填写 Office Agent Base URL");
  if (!agent_id) throw new Error("请填写本次评测的 Agent ID");
  return { base_url, agent_id, profile, jwt, model: "default" };
}

async function refreshTargetConfig(event) {
  const office = $("#adapter-overview").value === "office_agent";
  const browser = $("#adapter-overview").value === "browser";
  $("#office-target").hidden = !office;
  $("#browser-target").hidden = !browser;
  if (office) updateEndpointPreview();
  if (browser) await loadBrowserStatus();
  if (event?.type === "change" && state.project) await saveTargetConfig();
}

async function loadBrowserStatus() {
  try {
    const status = await api("/api/browser/status");
    $("#browser-state").textContent = status.connected
      ? "● 测试浏览器已连接，可开始执行"
      : status.configured ? "○ 浏览器已配置，首次使用请先打开并登录" : "× 没有找到 Playwright 浏览器";
    $("#browser-state").classList.toggle("ready", Boolean(status.connected));
  } catch (error) {
    $("#browser-state").textContent = error.message;
  }
}

async function openTestBrowser() {
  const button = $("#open-test-browser");
  const start_url = $("#browser-office-url").value.trim();
  if (!start_url) throw new Error("请填写 Office 页面地址");
  button.disabled = true;
  button.textContent = "正在打开测试浏览器…";
  try {
    await saveTargetConfig();
    const status = await api("/api/browser/session", { method: "POST", body: JSON.stringify({ start_url }) });
    $("#browser-state").textContent = status.message;
    $("#browser-state").classList.add("ready");
    toast("浏览器进程已启动；如果没有窗口，请使用桌面启动脚本重启系统");
  } finally {
    button.disabled = false;
    button.textContent = "打开测试浏览器 / 登录";
  }
}

function updateEndpointPreview() {
  const base = $("#office-base-url").value.trim().replace(/\/+$/, "") || "{Base URL}";
  const id = $("#office-agent-id").value.trim() || "{Agent ID}";
  const profile = $("#office-profile").value.trim();
  $("#office-endpoint-preview").textContent = `${base}/${id}/${profile ? `${profile}/` : ""}v1/chat/completions`;
}

function saveOfficeTargetDraft() {
  updateEndpointPreview();
  clearTimeout(saveOfficeTargetDraft.timer);
  saveOfficeTargetDraft.timer = setTimeout(() => saveTargetConfig().catch(error => toast(error.message, true)), 450);
}

async function saveTargetConfig() {
  if (!state.project) return;
  const adapter = $("#adapter-overview").value;
  const payload = {
    target_adapter: adapter,
    target_base_url: adapter === "browser" ? $("#browser-office-url").value.trim() : $("#office-base-url").value.trim().replace(/\/+$/, ""),
    target_agent_id: $("#office-agent-id").value.trim(),
    target_profile: $("#office-profile").value.trim(),
  };
  state.project = await api(`/api/projects/${state.project.id}`, { method: "PATCH", body: JSON.stringify(payload) });
}

async function loadRuns() {
  if (!state.project) return;
  state.runs = await api(`/api/projects/${state.project.id}/runs`);
  $("#run-list").innerHTML = state.runs.length ? state.runs.map(run => `
    <div class="run-item" data-run-id="${run.id}"><b>${escapeHtml(run.code)} · ${escapeHtml(run.title)}</b>
    <span>${formatTime(run.started_at)} · ${run.turn_count} 轮 · ${run.total_latency_ms}ms</span>
    <strong class="run-score ${run.passed ? "pass" : "fail"}">${run.status === "completed" ? Number(run.score).toFixed(0) : "!"}</strong></div>`).join("") : `<div class="empty-state"><p>还没有执行记录</p></div>`;
  $$(".run-item").forEach(item => item.addEventListener("click", () => loadRunDetail(Number(item.dataset.runId))));
  if (state.runs[0]) await loadRunDetail(state.runs[0].id);
}

async function loadBadCases() {
  if (!state.project) return;
  state.runs = await api(`/api/projects/${state.project.id}/runs`);
  const failed = state.runs.filter(run => run.status !== "completed" || !run.passed);
  const list = $("#bad-case-list");
  list.innerHTML = failed.length ? failed.map(run => `<article class="bad-case-row" data-run-id="${run.id}" tabindex="0">
    <div><span>${escapeHtml(run.code)}</span><b>${escapeHtml(run.title)}</b><small>${escapeHtml(run.summary || (run.status === "completed" ? "未通过当前评分规则" : "执行未完成"))}</small></div>
    <strong>${run.status === "completed" ? `${Number(run.score || 0).toFixed(0)} 分` : "执行失败"}</strong>
    <button type="button">查看证据 →</button>
  </article>`).join("") : `<div class="panel empty-state compact-empty"><span>✓</span><h2>当前没有失败记录</h2><p>完成跑测后，未通过和执行失败的用例会集中显示在这里。</p></div>`;
  $$(".bad-case-row", list).forEach(row => {
    const open = async () => { showView("runs"); await loadRunDetail(Number(row.dataset.runId)); };
    row.addEventListener("click", open);
    row.addEventListener("keydown", event => { if (event.key === "Enter") open(); });
  });
}

async function loadRunDetail(id) {
  $$(".run-item").forEach(item => item.classList.toggle("active", Number(item.dataset.runId) === id));
  const run = await api(`/api/runs/${id}`);
  if (run.status !== "completed") {
    $("#run-detail").innerHTML = `<div class="empty-state"><h2>执行失败</h2><p>${escapeHtml(run.summary)}</p></div>`; return;
  }
  const dimensions = Object.entries(run.score_detail.dimensions || {}).map(([name, score]) => `<div class="dimension"><b>${score}</b><span>${escapeHtml(name)}</span></div>`).join("");
  const semantic = run.score_detail.semantic_evaluation || {};
  const findings = [
    ...(semantic.capability_matches || []).map(item => `<li class="positive">匹配能力：${escapeHtml(item)}</li>`),
    ...(semantic.missing_capabilities || []).map(item => `<li>缺失能力：${escapeHtml(item)}</li>`),
    ...(semantic.hallucinations || []).map(item => `<li class="negative">越界/幻觉：${escapeHtml(item)}</li>`),
  ].join("");
  const messages = run.messages.map(message => {
    const tools = (message.tool_calls || []).map(tool => `<span class="tool-chip">↳ ${escapeHtml(tool.name || "tool")} · ${escapeHtml(tool.status || "called")}</span>`).join("");
    return `<div class="message ${message.role}"><div class="message-meta"><b>${message.role === "assistant" ? "被测 Agent" : "测试用户"}</b><span>${message.latency_ms ? `${message.latency_ms} ms` : "输入"}</span></div><p>${escapeHtml(message.content)}</p>${tools}</div>`;
  }).join("");
  $("#run-detail").innerHTML = `
    <div class="evidence-head"><div><p class="eyebrow">${escapeHtml(run.code)} · ${run.adapter}</p><h2>${escapeHtml(run.title)}</h2><span class="review-state ${run.passed ? "ok" : ""}">${run.passed ? "● 通过" : "● 未通过"} · ${run.turn_count} 轮 · ${run.total_latency_ms}ms</span></div><div class="score-seal"><b>${run.score}</b><span>总分 / 100</span></div></div>
    <div class="dimension-grid">${dimensions}</div>
    <div class="reason-box"><b>评分归因：</b>${escapeHtml((run.score_detail.reasons || []).join("；"))}</div>
    ${findings ? `<ul class="semantic-findings">${findings}</ul>` : ""}
    ${run.screenshot_path ? `<figure class="evidence-shot"><img src="${escapeHtml(run.screenshot_path)}" alt="该测试问题及 Agent 回复截图"><figcaption>Playwright 保存的对话证据</figcaption></figure>` : ""}
    <div class="trail"><div class="trail-title">CONVERSATION TRAIL · 对话证据轨道</div>${messages}</div>`;
}

function escapeHtml(value = "") { const node = document.createElement("div"); node.textContent = String(value); return node.innerHTML; }
function formatTime(value) { return value ? new Date(value).toLocaleString("zh-CN", { month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" }) : "—"; }

document.addEventListener("DOMContentLoaded", async () => {
  $$(".nav-item").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
  $$('[data-jump]').forEach(button => button.addEventListener("click", () => showView(button.dataset.jump)));
  $("#project-select").addEventListener("change", event => selectProject(Number(event.target.value)));
  $("#new-project").addEventListener("click", openProjectDialog);
  $("#delete-project").addEventListener("click", () => deleteCurrentProject().catch(error => toast(error.message, true)));
  $("#project-form").addEventListener("submit", event => createProject(event).catch(error => toast(error.message, true)));
  $$("#project-dialog [data-close-dialog], #dataset-dialog [data-close-dialog]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  $("#new-dataset").addEventListener("click", () => openDatasetDialog());
  $("#delete-all-datasets").addEventListener("click", () => deleteAllDatasets().catch(error => toast(error.message, true)));
  $("#dataset-form").addEventListener("submit", event => saveDataset(event).catch(error => toast(error.message, true)));
  $("#new-judge-model").addEventListener("click", () => openJudgeModelForm());
  $("#judge-model-form").addEventListener("submit", event => saveJudgeModel(event).catch(error => toast(error.message, true)));
  $("#judge-model-list").addEventListener("click", event => handleJudgeModelAction(event).catch(error => toast(error.message, true)));
  $("#run-judge-model-select").addEventListener("change", async event => {
    const projectId = state.project?.id, id = event.currentTarget.value;
    if (!projectId || !id) return;
    try {
      await api(`/api/projects/${projectId}/judge-models/${id}`, { method: "PATCH", body: JSON.stringify({ is_default: true }) });
      if (state.project?.id === projectId) { await loadJudgeModels(); toast("已切换项目默认评测模型"); }
    } catch (error) { renderJudgeModels(); toast(error.message, true); }
  });
  $("#cancel-judge-model").addEventListener("click", () => $("#judge-model-form").hidden = true);
  $("#cancel-judge-model-bottom").addEventListener("click", () => $("#judge-model-form").hidden = true);
  $("#import-dataset").addEventListener("click", openImportDialog);
  $("#run-dataset-select").addEventListener("change", event => selectEvaluationSet(Number(event.target.value)));
  $("#new-case").addEventListener("click", () => openCase(null));
  $("#import-excel").addEventListener("click", openImportDialog);
  $("#excel-file").addEventListener("change", () => inspectImportFile().catch(error => toast(error.message, true)));
  $$("#import-dialog .import-cancel").forEach(button => button.addEventListener("click", closeImportDialog));
  $("#confirm-import").addEventListener("click", event => importExcel(event).catch(error => toast(error.message, true)));
  $("#select-visible-cases").addEventListener("change", event => {
    const visible = state.cases.filter(item => state.filter === "all" || (state.filter === "approved" ? item.approved : !item.approved));
    visible.forEach(item => event.currentTarget.checked ? state.selectedCases.add(item.id) : state.selectedCases.delete(item.id));
    renderCases();
  });
  $("#clear-case-selection").addEventListener("click", () => { state.selectedCases.clear(); renderCases(); });
  $("#delete-selected-cases").addEventListener("click", () => deleteSelectedCases().catch(error => toast(error.message, true)));
  $("#confirm-browser-run").addEventListener("click", confirmBrowserRun);
  $$('#office-run-mode input[name="office_run_mode"]').forEach(input => input.addEventListener("change", event => {
    populateOfficePlan(event.currentTarget.value).catch(error => toast(error.message, true));
  }));
  $("#select-all-run-cases").addEventListener("click", () => { $$("#office-run-plan .office-case-check").forEach(input => { input.checked = true; }); updateOfficeSelection(); });
  $("#clear-run-cases").addEventListener("click", () => { $$("#office-run-plan .office-case-check").forEach(input => { input.checked = false; }); updateOfficeSelection(); });
  $("#toggle-job-pause").addEventListener("click", () => toggleJobPause().catch(error => toast(error.message, true)));
  $("#close-job-progress").addEventListener("click", () => closeJobProgress().catch(error => toast(error.message, true)));
  $("#close-batch-detail").addEventListener("click", () => $("#batch-dialog").close());
  $("#adapter-overview").addEventListener("change", refreshTargetConfig);
  $("#workflow-mode").addEventListener("change", updateWorkflowNote);
  $("#office-base-url").addEventListener("input", saveOfficeTargetDraft);
  $("#office-agent-id").addEventListener("input", saveOfficeTargetDraft);
  $("#office-profile").addEventListener("input", saveOfficeTargetDraft);
  $("#browser-office-url").addEventListener("input", () => {
    clearTimeout(saveOfficeTargetDraft.timer);
    saveOfficeTargetDraft.timer = setTimeout(() => saveTargetConfig().catch(error => toast(error.message, true)), 450);
  });
  $("#open-test-browser").addEventListener("click", () => openTestBrowser().catch(error => toast(error.message, true)));
  refreshTargetConfig();
  $("#brief-form").addEventListener("submit", async event => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
    state.project = await api(`/api/projects/${state.project.id}`, { method:"PATCH", body:JSON.stringify(data) });
    await loadQuestions(); renderSummary(); toast("项目资料已保存");
  });
  $("#ask-questions").addEventListener("click", async () => { await loadQuestions(); toast("资料缺口已更新"); });
  $("#generate-cases").addEventListener("click", async event => {
    event.currentTarget.disabled = true;
    try {
      if (!state.dataset) throw new Error("请先新建或选择一个评测集");
      state.cases = await api(`/api/projects/${state.project.id}/cases/generate`, { method:"POST", body: JSON.stringify({ evaluation_set_id: state.dataset.id }) });
      state.datasets = await api(`/api/projects/${state.project.id}/evaluation-sets`); renderDatasets(); renderDatasetContext(); renderCases(); renderSummary(); showView("cases"); toast("候选测试用例已加入当前评测集");
    }
    catch(error){toast(error.message,true)} finally{event.currentTarget.disabled=false}
  });
  $$(".filter").forEach(button => button.addEventListener("click", () => { state.filter=button.dataset.filter; $$(".filter").forEach(item=>item.classList.toggle("active",item===button)); renderCases(); }));
  $("#save-case").addEventListener("click", saveCase);
  $$(".run-all").forEach(button => button.addEventListener("click", () => runApproved(button)));
  $("#refresh-runs").addEventListener("click", loadRuns);
  try {
    await Promise.all([loadProjects(), loadHarnessStatus()]);
    const requested = location.hash.slice(1);
    showView(VIEW_SECTIONS[requested] ? requested : "overview");
  } catch(error) { toast(error.message, true); }
});
