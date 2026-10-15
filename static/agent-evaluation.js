// Agent evaluation is deliberately separate from the existing answer-test workflow.
(() => {
  const local = { project: null, selected: null, request: 0, detailRequest: 0, caseRequest: 0, cases: [], groups: [], history: [] };
  const node = id => document.getElementById(id);
  const esc = value => escapeHtml(String(value ?? ""));
  const labels = { pass: "通过", fail: "不通过", review: "待核验" };
  const names = { "agent.step": "Agent 执行轮次", "model.invoke": "模型调用", video_understand: "视频理解工具", "video.duration": "读取视频时长", "video.extract_frames": "抽取视频帧", "video.frame_batch": "分批分析视频帧", video_trim: "视频裁剪工具", video_speed: "视频调速工具", video_overlay: "水印 / 文字叠加工具", chat: "用户任务" };
  function modelChoices(models, selectedId) {
    if (!models.length) return '<option value="">尚未配置项目模型（可使用后台 PI_*）</option>';
    return ["builtin", "custom"].map(source => {
      const items = models.filter(item => item.source === source);
      return items.length ? `<optgroup label="${source === "builtin" ? "内置模型" : "自定义模型"}">${items.map(item => `<option value="${esc(item.id)}" ${item.id === selectedId ? "selected" : ""}>${esc(item.name)}${item.is_default ? "（默认）" : ""}</option>`).join("")}</optgroup>` : "";
    }).join("");
  }
  function pretty(value) {
    if (value == null || value === "") return "未记录";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }
  function evidence(title, value, description = "") {
    return `<section class="agent-io"><h3>${esc(title)}</h3>${description ? `<p>${esc(description)}</p>` : ""}<pre>${esc(pretty(value))}</pre></section>`;
  }
  const recorded = value => typeof value === "number" && Number.isFinite(value);
  const tokenCount = value => recorded(value) ? Math.round(value).toLocaleString("zh-CN") : "未记录";
  function duration(value) {
    if (!recorded(value)) return "未记录";
    if (value < 1000) return `${Math.round(value)} ms`;
    if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
    return `${Math.floor(value / 60_000)}m ${((value % 60_000) / 1000).toFixed(1)}s`;
  }
  const cost = (value, source) => recorded(value) ? `${source === "estimated" || source === "mixed" ? "≈" : ""}$${value.toFixed(value < 0.01 ? 6 : 4)}` : "未记录";
  const costSource = source => source === "estimated" ? "按官方单价估算" : source === "mixed" ? "包含估算值" : source === "langfuse" ? "Langfuse 实际值" : "没有可用价格";
  function traceSummary(summary = {}) {
    const models = Array.isArray(summary.models) ? summary.models : [];
    const modelTable = models.length ? `<details class="agent-model-usage"><summary>各模型 Token 与成本</summary><div class="agent-usage-scroll"><table><thead><tr><th>模型</th><th>调用</th><th>未命中输入</th><th>缓存命中</th><th>缓存写入</th><th>输出 Token</th><th>总 Token</th><th>成本</th><th>成本依据</th></tr></thead><tbody>${models.map(item => `<tr><td>${esc(item.model)}</td><td>${tokenCount(item.calls)}</td><td>${tokenCount(item.input_tokens)}</td><td>${tokenCount(item.cache_read_input_tokens)}</td><td>${tokenCount(item.cache_write_input_tokens)}</td><td>${tokenCount(item.output_tokens)}</td><td>${tokenCount(item.total_tokens)}</td><td title="${esc(item.cost_note || "")}">${cost(item.total_cost_usd, item.cost_source)}</td><td>${esc(costSource(item.cost_source))}</td></tr>`).join("")}</tbody></table></div></details>` : "";
    return `<section class="agent-trace-summary" aria-label="Trace 运行汇总">
      <div class="agent-metric agent-metric-primary"><small>真实总耗时</small><strong>${duration(summary.duration_ms)}</strong><span>最早开始 → 最晚结束</span></div>
      <div class="agent-metric"><small>模型调用</small><strong>${tokenCount(summary.model_calls)}</strong><span>仅统计模型节点</span></div>
      <div class="agent-metric"><small>总 Token</small><strong>${tokenCount(summary.total_tokens)}</strong><span>未命中 ${tokenCount(summary.input_tokens)} · 命中 ${tokenCount(summary.cache_read_input_tokens)} · 输出 ${tokenCount(summary.output_tokens)}</span></div>
      <div class="agent-metric"><small>模型成本</small><strong>${cost(summary.total_cost_usd, summary.cost_source)}</strong><span>${esc(costSource(summary.cost_source))}</span></div>
    </section>${modelTable}`;
  }
  async function loadCases() {
    const projectId = state.project.id, setId = node("agent-set-id").value, request = ++local.caseRequest;
    local.cases = []; node("agent-case-id").disabled = true;
    node("agent-case-id").innerHTML = '<option value="">请先选择评测集</option>'; previewCase();
    if (!setId) return;
    node("agent-case-id").innerHTML = '<option value="">正在加载用例…</option>';
    try {
      const cases = await api(`/api/projects/${projectId}/cases?evaluation_set_id=${setId}`);
      if (request !== local.caseRequest || projectId !== state.project.id) return;
      local.cases = cases;
      node("agent-case-id").innerHTML = `<option value="">${cases.length ? "请选择测试用例" : "此评测集暂无用例"}</option>` + cases.map(item => `<option value="${item.id}">${esc(item.code)} · ${esc(item.query.slice(0, 60))}</option>`).join("");
      node("agent-case-id").disabled = !cases.length;
    } catch (error) { if (request === local.caseRequest) { node("agent-case-id").innerHTML = '<option value="">加载失败，请重新选择评测集</option>'; toast(error.message, true); } }
  }
  function previewCase() {
    const item = local.cases.find(item => item.id === Number(node("agent-case-id").value));
    const linked = node("agent-association-mode").value === "evaluation_set";
    const hasSet = Boolean(node("agent-set-id").value);
    node("agent-case-preview").textContent = item
      ? "预期结果：" + (item.expected_answer || "未填写") + "　｜　必需工具：" + (item.expected_trace.required_tools.join("、") || "未指定") + "　｜　禁止工具：" + (item.expected_trace.forbidden_tools.join("、") || "未指定")
      : hasSet ? "可以只关联评测集；以后再选择用例并载入对应评测要求。" : "请选择要关联的评测集。";
    node("agent-link-case").textContent = item ? "载入用例要求并关联评测集" : "将当前任务关联到评测集";
    node("agent-link-case").hidden = !linked || !hasSet || !local.selected;
  }
  function applyGroupSelection(body) {
    const selected = node("agent-group-id").value;
    if (selected === "__new__") {
      const name = node("agent-group-name").value.trim();
      if (!name) throw new Error("请填写新分组名称");
      body.group_name = name;
    } else if (selected !== "__auto__") {
      body.group_id = Number(selected);
    } else if (node("agent-association-mode").value !== "evaluation_set") {
      body.group_mode = "uncategorized";
    }
    return body;
  }
  async function linkCase() {
    const saved = local.selected, projectId = state.project.id;
    if (!saved || !node("agent-set-id").value) return;
    const caseId = Number(node("agent-case-id").value || 0);
    const message = caseId ? "载入所选用例将替换当前任务的评测要求，并清除旧评测结论。继续？" : "当前任务将关联到所选评测集，并恢复为项目默认评测要求。继续？";
    if (!confirm(message)) return;
    const button = node("agent-link-case"); button.disabled = true;
    try {
      const body = applyGroupSelection({ case_id: caseId || null, evaluation_set_id: Number(node("agent-set-id").value) });
      const result = await api(`/api/projects/${projectId}/agent-evaluations/${saved.id}`, { method: "PATCH", body: JSON.stringify(body) });
      if (projectId !== state.project.id || local.selected?.id !== saved.id) return;
      local.selected = result; render(result); await refresh(); toast(caseId ? "已载入用例要求并完成关联" : "已关联评测集");
    } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
  }
  function syncGroupFields() {
    const linked = node("agent-association-mode").value === "evaluation_set";
    node("agent-set-field").hidden = !linked;
    node("agent-case-field").hidden = !linked;
    node("agent-group-field").hidden = false;
    node("agent-group-name-field").hidden = node("agent-group-id").value !== "__new__";
    node("agent-case-preview").hidden = !linked;
    node("agent-link-case").hidden = !linked || !node("agent-set-id").value || !local.selected;
  }
  function populateGroupOptions(reset = false) {
    const select = node("agent-group-id");
    const previous = reset ? "__auto__" : select.value;
    const linked = node("agent-association-mode").value === "evaluation_set";
    const selectedSet = (state.datasets || []).find(item => String(item.id) === node("agent-set-id").value);
    const defaultLabel = linked && selectedSet ? `默认：${selectedSet.name}` : "未分类";
    select.innerHTML = `<option value="__auto__">${esc(defaultLabel)}</option>`
      + local.groups.map(item => `<option value="${item.id}">${esc(item.name)}${item.group_type === "evaluation_set" ? "（评测集分组）" : ""}</option>`).join("")
      + '<option value="__new__">＋ 新建分组</option>';
    const valid = previous === "__auto__" || previous === "__new__" || local.groups.some(item => String(item.id) === previous);
    select.value = valid ? previous : "__auto__";
    syncGroupFields();
  }
  function renderHistory() {
    const filter = node("agent-history-filter").value;
    const currentFilter = local.groups.some(item => String(item.id) === filter) ? filter : "";
    node("agent-history-filter").innerHTML = `<option value="">全部 Trace（${local.history.length}）</option>` + local.groups.map(group => `<option value="${group.id}">${esc(group.name)}（${group.trace_count}）</option>`).join("");
    node("agent-history-filter").value = currentFilter;
    const visibleGroups = currentFilter ? local.groups.filter(group => String(group.id) === currentFilter) : local.groups;
    const html = visibleGroups.map(group => {
      const items = local.history.filter(item => Number(item.group_id) === Number(group.id));
      if (!items.length && !currentFilter) return "";
      return `<section class="agent-folder-section"><div class="agent-folder-heading"><b>${esc(group.name)}</b><span>${items.length}</span></div>${items.map(item => {
        const moveOptions = local.groups.filter(target => Number(target.id) !== Number(item.group_id))
          .map(target => `<option value="${target.id}">${esc(target.name)}</option>`).join("");
        return `<div class="agent-history-item ${local.selected?.id === item.id ? "active" : ""}"><button class="agent-history-row" type="button" data-agent-id="${item.id}"><b>${esc(item.trace_id)}</b><small>${item.case_code ? esc(item.case_code) + " · " : ""}${esc(item.source)} · ${esc(formatTime(item.updated_at))}</small><span>${labels[item.result.status] || "未评测"}</span></button><details class="agent-history-actions"><summary aria-label="管理 Trace" title="管理 Trace">···</summary><div class="agent-history-menu"><label>移动到分组<select data-move-group>${moveOptions}</select></label><button type="button" class="button ghost" data-move-agent="${item.id}" ${moveOptions ? "" : "disabled"}>移动</button><button type="button" class="button danger" data-delete-agent="${item.id}">删除本地记录</button></div></details></div>`;
      }).join("") || '<p class="agent-empty">该分组暂无 Trace。</p>'}</section>`;
    }).join("");
    node("agent-history-list").innerHTML = html || '<p class="agent-empty">还没有链路。请先读取一条 Trace。</p>';
    node("agent-history-list").querySelectorAll("[data-agent-id]").forEach(button => button.addEventListener("click", () => select(Number(button.dataset.agentId)).catch(error => toast(error.message, true))));
    node("agent-history-list").querySelectorAll("[data-move-agent]").forEach(button => button.addEventListener("click", () => {
      const selectNode = button.closest(".agent-history-menu").querySelector("[data-move-group]");
      moveTrace(Number(button.dataset.moveAgent), Number(selectNode.value), button).catch(error => toast(error.message, true));
    }));
    node("agent-history-list").querySelectorAll("[data-delete-agent]").forEach(button => button.addEventListener("click", () => {
      deleteTrace(Number(button.dataset.deleteAgent), button).catch(error => toast(error.message, true));
    }));
  }
  async function moveTrace(id, groupId, button) {
    if (!groupId) throw new Error("请选择目标分组");
    const projectId = state.project.id;
    button.disabled = true;
    try {
      const saved = await api(`/api/projects/${projectId}/agent-evaluations/${id}/group`, {
        method: "PATCH", body: JSON.stringify({ group_id: groupId })
      });
      if (projectId !== state.project.id) return;
      if (local.selected?.id === id) { local.selected = saved; render(saved); }
      await refresh();
      toast(`已移动到“${saved.group_name}”`);
    } finally { button.disabled = false; }
  }
  async function deleteTrace(id, button) {
    const item = local.history.find(entry => entry.id === id);
    if (!item) return;
    if (!confirm(`确定删除 Trace ${item.trace_id} 的本地评测记录吗？\n\n不会删除 Langfuse 中的原始 Trace，此操作无法在 Agent Evals 中撤销。`)) return;
    const projectId = state.project.id;
    button.disabled = true;
    try {
      await api(`/api/projects/${projectId}/agent-evaluations/${id}`, { method: "DELETE" });
      if (projectId !== state.project.id) return;
      if (local.selected?.id === id) {
        local.selected = null; local.detailRequest++;
        node("agent-task-detail").innerHTML = `<div class="empty-state"><h2>Trace 已删除</h2><p>请选择左侧其他任务，或重新读取这条 Langfuse Trace。</p></div>`;
      }
      await refresh();
      toast("本地 Trace 记录已删除");
    } finally { button.disabled = false; }
  }
  async function refresh(reset = false) {
    if (!state.project) return;
    const projectId = state.project.id, request = ++local.request;
    if (reset || local.project !== projectId) {
      local.project = projectId; local.selected = null; local.detailRequest++;
      local.caseRequest++; local.cases = []; local.groups = []; local.history = [];
      node("agent-history-filter").value = "";
      const activeSet = (state.datasets || []).find(item => item.id === state.dataset?.id) || (state.datasets || [])[0];
      node("agent-association-mode").value = "none";
      node("agent-set-id").innerHTML = '<option value="">请选择评测集</option>' + (state.datasets || []).map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join("");
      node("agent-set-id").value = activeSet ? String(activeSet.id) : "";
      node("agent-case-id").innerHTML = '<option value="">请先选择评测集</option>'; node("agent-case-id").disabled = true;
      node("agent-task-detail").innerHTML = `<div class="empty-state"><h2>选择或读取一条 Trace</h2><p>先选择左侧任务，再查看每一步的输入和输出。</p></div>`;
      populateGroupOptions(true);
      if (activeSet) await loadCases();
      if (request !== local.request || projectId !== state.project?.id) return;
    }
    const previousSet = node("agent-set-id").value;
    node("agent-set-id").innerHTML = '<option value="">请选择评测集</option>' + (state.datasets || []).map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join("");
    node("agent-set-id").value = previousSet;
    if (previousSet && node("agent-set-id").value !== previousSet) await loadCases();
    previewCase();
    try {
      const [status, history, groups] = await Promise.all([api("/api/langfuse/status"), api(`/api/projects/${projectId}/agent-evaluations`), api(`/api/projects/${projectId}/agent-evaluation-groups`)]);
      if (request !== local.request || state.project.id !== projectId) return;
      local.history = history; local.groups = groups;
      node("agent-langfuse-status").textContent = status.configured ? `后台已配置 · ${status.api_version}` : "未配置 Langfuse · 仍可离线导入 JSON";
      populateGroupOptions();
      renderHistory();
    } catch (error) { if (request === local.request) toast(error.message, true); }
  }
  async function select(id) {
    const projectId = state.project.id, request = ++local.detailRequest;
    const saved = await api(`/api/projects/${projectId}/agent-evaluations/${id}`);
    if (request !== local.detailRequest || projectId !== state.project.id) return;
    local.selected = saved; render(saved); await refresh();
  }
  function render(saved) {
    const trace = saved.trace, expectations = saved.expectations, result = saved.result;
    const models = state.judgeModels || [];
    const defaultModel = models.find(item => item.is_default);
    const previousModelId = result.semantic?.judge_model?.id;
    const selectedModelId = models.some(item => item.id === previousModelId) ? previousModelId : defaultModel?.id || "";
    const modelOptions = modelChoices(models, selectedModelId);
    node("agent-task-detail").innerHTML = `<header class="agent-task-head"><h2>${esc(trace.name)}</h2><p>Trace ID：${esc(trace.trace_id)}</p><div class="agent-identities"><span>用户：${esc(trace.user_id || "未记录")}</span><span>会话：${esc(trace.session_id || "未记录")}</span>${saved.group_name ? `<span>分组：${esc(saved.group_name)}</span>` : ""}${saved.case_id ? `<span>用例：${esc(saved.case_code || "#"+saved.case_id)}</span>` : ""}</div></header>
      ${traceSummary(trace.summary)}
      ${trace.warnings.map(warning => `<p class="agent-warning">${esc(warning)}</p>`).join("")}
      <details class="agent-conversation" open><summary>用户提问与最终回复</summary>${evidence("用户提问", trace.input)}${evidence("最终回复", trace.output)}</details>
      <div class="agent-chain"><section class="agent-tree-panel"><h3>内部调用流程</h3><p class="agent-muted">按执行时间排列；缩进表示包含关系，不代表每个节点直接给下一个节点发消息。</p><div id="agent-node-tree" role="group" aria-label="调用节点"></div></section><article id="agent-node-detail"><p class="agent-empty">点击一个节点，查看它处理的输入和产生的输出。</p></article></div>
      <form id="agent-score-form" class="agent-score-form"><h2>这次任务应该怎么完成？</h2><label>预期结果 / 回复要求<textarea id="agent-expected-answer" rows="3" placeholder="例如：输出原视频 0 至 4 秒的裁剪文件，回复可下载的文件位置。">${esc(expectations.expected_answer || "")}</textarea></label>
      <label>预期轨迹<textarea id="agent-expected-trace" rows="4" placeholder="例如：理解需求 → 定位片段 → 裁剪 → 校验并返回结果">${esc(expectations.expected_trace || "")}</textarea></label>
      <label>必需工具<input id="agent-tools" value="${esc((expectations.tools || []).map(tool => tool.name).join(", "))}" placeholder="例如：video_trim；多个工具用英文逗号分隔"></label>
      <label>禁止工具<input id="agent-forbidden-tools" value="${esc((expectations.forbidden_tools || []).join(", "))}" placeholder="例如：video_speed, video_overlay"></label>
      <label>工具参数约束<textarea id="agent-constraints" rows="2" placeholder="例如：保留第 4 秒至结尾；输出时长约为原视频减 4 秒">${esc(expectations.parameter_constraints || "")}</textarea></label>
      <label class="agent-checkbox"><input id="agent-ordered" type="checkbox" ${expectations.ordered ? "checked" : ""}> 按填写顺序检查工具调用</label>
      <label>评分标准（进行评测前必填）<textarea id="agent-scoring-standard" rows="5" placeholder="请明确评分维度、分值和通过条件。例如：结果满足预期占 60 分，工具与参数符合要求占 40 分；80 分通过，调用禁止工具或虚构成功直接不通过。">${esc(expectations.scoring_standard || "")}</textarea><small>从用例评分标准载入；用例未填写时使用项目评分标准。可修改本次标准，不影响原评测集。</small></label>
      <label>用于语义评判的模型<select id="agent-judge-model">${modelOptions}</select></label>
      <details class="agent-options"><summary>检查具体工具参数（可选）</summary><p class="agent-muted">填写 JSON 数组。只检查你填写的参数，额外参数不影响匹配；同名工具调用多次时，可在这里分开填写。</p><textarea id="agent-tool-parameters" rows="5" spellcheck="false" placeholder='[{"name":"video_trim","parameters":{"startTime":0,"endTime":4}}]'>${esc((expectations.tools || []).some(tool => tool.parameters) ? JSON.stringify(expectations.tools, null, 2) : "")}</textarea></details>
      <div class="agent-score-actions"><button class="button ghost" type="submit">仅检查执行过程</button><button class="button ink" id="agent-semantic" type="button">进行评测</button><a class="button ghost" href="/api/projects/${state.project.id}/agent-evaluations/${saved.id}" target="_blank" rel="noopener">查看评测 JSON ↗</a></div><p class="privacy-note">进行评测会按本次评分标准，结合预期答案、预期轨迹和实际链路调用所选模型评判，并保存要求与结论。仅检查执行过程不调用模型，自然语言轨迹与参数约束需进行评测才能判断。视频文件等实际产物仍需独立核验。</p><p id="agent-score-error" role="alert" hidden></p></form>
      <section class="agent-result" aria-live="polite"><h2>评测结论 · ${labels[result.status] || "未评测"}</h2>${(result.checks || []).map(check => `<div class="agent-check"><span class="agent-check-status ${esc(check.status)}">${labels[check.status]}</span><div><b>${esc(check.title)}</b><p>${esc(check.reason)}</p>${check.node_ids.map(id => `<button type="button" class="agent-evidence-link" data-evidence-id="${esc(id)}">查看节点 ${esc(id.slice(0, 10))} ↗</button>`).join("")}</div></div>`).join("") || `<p class="agent-muted">填写执行要求后开始检查；不会自动猜测正确答案。</p>`}${result.semantic ? evidence("模型评判依据", result.semantic) : ""}</section>`;
    const byId = new Map(trace.nodes.map(item => [item.id, item]));
    function depth(item) { let count = 0, parent = item.parent_id; while (parent && byId.has(parent) && count < 12) { count++; parent = byId.get(parent).parent_id; } return count; }
    node("agent-node-tree").innerHTML = trace.nodes.map((item, index) => `<button type="button" class="agent-node" style="--depth:${depth(item)}" data-node-index="${index}"><span class="agent-node-icon">${item.kind === "model" ? "◇" : item.kind === "tool" ? "⚒" : "↳"}</span><div><b>${esc(names[item.name] || (item.kind === "model" ? "模型调用" : item.kind === "tool" ? "工具调用" : item.name))}</b><small>${esc(item.model || item.name)}</small></div><em>${item.duration_ms == null ? "进行中 / 未记录" : `${(item.duration_ms / 1000).toFixed(2)}s`}</em></button>`).join("");
    function inspect(item) {
      const parent = byId.get(item.parent_id);
      const receiver = item.kind === "model" ? `模型 ${item.model || "（名称未记录）"}` : item.kind === "tool" ? `工具 ${item.name} 的执行代码` : `${names[item.name] || item.name} 的处理代码`;
      node("agent-node-detail").innerHTML = `<h3>${esc(names[item.name] || item.name)}</h3><p class="agent-muted">节点：${esc(item.id)}<br>所属步骤：${esc(parent ? names[parent.name] || parent.name : "用户任务 / 根节点")}<br>开始：${esc(item.start_time)}<br>状态：${esc(item.level)} ${esc(item.status_message)}</p>${evidence("输入 Input", item.input, `这是交给${receiver}处理的数据。`)}${evidence("输出 Output", item.output, "这是该节点返回给调用它的程序的结果；只有任务根节点的最终回复才是交给用户的回答。")}`;
      node("agent-node-tree").querySelectorAll("[data-node-index]").forEach(button => button.classList.toggle("active", trace.nodes[Number(button.dataset.nodeIndex)].id === item.id));
    }
    node("agent-node-tree").querySelectorAll("[data-node-index]").forEach(button => button.addEventListener("click", () => inspect(trace.nodes[Number(button.dataset.nodeIndex)])));
    node("agent-task-detail").querySelectorAll("[data-evidence-id]").forEach(button => button.addEventListener("click", () => { const item = byId.get(button.dataset.evidenceId); if (item) { inspect(item); node("agent-node-detail").scrollIntoView({ block: "nearest" }); } }));
    if (trace.nodes.length) inspect(trace.nodes[0]);
    node("agent-score-form").addEventListener("submit", event => { event.preventDefault(); score(false); });
    node("agent-semantic").addEventListener("click", () => score(true));
  }
  async function score(semantic) {
    const saved = local.selected, projectId = state.project.id;
    const form = node("agent-score-form"), errorNode = node("agent-score-error");
    errorNode.hidden = true;
    try {
      if (semantic && !node("agent-scoring-standard").value.trim()) { node("agent-scoring-standard").focus(); throw new Error("请先填写评分标准，再进行评测"); }
      const parameterText = node("agent-tool-parameters").value.trim();
      const tools = parameterText ? JSON.parse(parameterText) : node("agent-tools").value.split(/[,，]/).map(name => name.trim()).filter(Boolean).map(name => ({ name }));
      const body = { tools, ordered: node("agent-ordered").checked, expected_answer: node("agent-expected-answer").value,
        forbidden_tools: node("agent-forbidden-tools").value.split(/[,，]/).map(name => name.trim()).filter(Boolean),
        expected_trace: node("agent-expected-trace").value, parameter_constraints: node("agent-constraints").value,
        scoring_standard: node("agent-scoring-standard").value, case_query: saved.expectations.case_query,
        evaluation_set_id: saved.expectations.evaluation_set_id,
        semantic, judge_model_id: semantic ? node("agent-judge-model").value : "" };
      form.querySelectorAll("button").forEach(button => button.disabled = true);
      const result = await api(`/api/projects/${projectId}/agent-evaluations/${saved.id}/evaluate`, { method: "POST", body: JSON.stringify(body) });
      if (projectId !== state.project.id || local.selected?.id !== saved.id) return;
      local.selected = result; render(result); await refresh(); toast("Agent 评测结果已保存");
    } catch (error) { errorNode.textContent = error instanceof SyntaxError ? "工具参数 JSON 格式不正确，请检查双引号和逗号。" : error.message; errorNode.hidden = false; }
    finally { form.querySelectorAll("button").forEach(button => button.disabled = false); }
  }
  async function importTrace(extra = {}) {
    if (!state.project) throw new Error("请先选择评测项目");
    const projectId = state.project.id;
    const errorNode = node("agent-import-error"), button = node("agent-import-button");
    errorNode.hidden = true; button.disabled = true; button.textContent = "正在读取…";
    try {
      const linked = node("agent-association-mode").value === "evaluation_set";
      const body = { trace_id: node("agent-trace-id").value.trim(), association_mode: linked ? "evaluation_set" : "none", ...extra };
      if (linked) {
        if (!node("agent-set-id").value) throw new Error("请选择要关联的评测集");
        body.evaluation_set_id = Number(node("agent-set-id").value);
        body.case_id = node("agent-case-id").value || null;
      }
      applyGroupSelection(body);
      if (node("agent-from").value) body.from = new Date(node("agent-from").value).toISOString();
      if (node("agent-to").value) body.to = new Date(node("agent-to").value).toISOString();
      const saved = await api(`/api/projects/${projectId}/agent-evaluations`, { method: "POST", body: JSON.stringify(body) });
      if (projectId !== state.project.id) return;
      local.selected = saved; render(saved); await refresh(); toast("Trace 已读取并保存");
    } catch (error) { errorNode.textContent = error.message; errorNode.hidden = false; }
    finally { button.disabled = false; button.textContent = "读取 Trace"; }
  }
  node("agent-trace-form").addEventListener("submit", event => { event.preventDefault(); importTrace().catch(error => toast(error.message, true)); });
  node("agent-json-file").addEventListener("change", async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      if (file.size > 15_000_000) throw new Error("JSON 文件不能超过 15 MB");
      const value = JSON.parse(await file.text());
      const observations = value.observations || value.data || (Array.isArray(value) ? value : null);
      if (!Array.isArray(observations)) throw new Error("文件中没有 observations 或 data 节点数组");
      const traceId = value.id || value.trace_id || node("agent-trace-id").value.trim() || observations[0]?.traceId;
      if (!traceId) throw new Error("请先填写 Trace ID");
      node("agent-trace-id").value = traceId;
      await importTrace({ trace_id: traceId, observations, trace: value.observations ? value : {} });
    } catch (error) { toast(error instanceof SyntaxError ? "导入文件不是有效 JSON" : error.message, true); }
    finally { event.target.value = ""; }
  });
  node("agent-refresh").addEventListener("click", () => refresh());
  node("agent-history-filter").addEventListener("change", renderHistory);
  node("agent-association-mode").addEventListener("change", () => {
    populateGroupOptions(true);
    if (node("agent-association-mode").value === "evaluation_set") loadCases();
    else previewCase();
  });
  node("agent-group-id").addEventListener("change", syncGroupFields);
  node("agent-set-id").addEventListener("change", () => { populateGroupOptions(true); loadCases(); });
  node("agent-case-id").addEventListener("change", previewCase);
  node("agent-link-case").addEventListener("click", linkCase);
  function refreshModelOptions() {
    const select = node("agent-judge-model");
    if (!select) return;
    const previous = select.value;
    const models = state.judgeModels || [];
    const current = models.some(item => item.id === previous) ? previous : models.find(item => item.is_default)?.id || "";
    select.innerHTML = modelChoices(models, current);
    select.value = current;
  }
  window.agentEvaluation = { refresh, refreshModelOptions };
  if (state.project) refresh(true);
})();
