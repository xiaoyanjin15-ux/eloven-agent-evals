import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "agent-eval-ui-"));
const base = `http://127.0.0.1:${19000 + Math.floor(Math.random() * 500)}`;
const child = spawn(process.execPath, [join(root, "dist/src/server.js")], { cwd: root,
  env: { ...process.env, PORT: new URL(base).port, AGENT_EVAL_DB: join(temporary, "test.db"), JUDGE_MODELS_FILE: join(temporary, "judge-models.local.json"), PI_PROVIDER: "", PI_MODEL: "", LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" }, stdio: "pipe" });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(ready);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || "E:\\playwright-browsers\\chromium-1234\\chrome-win64\\chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(base); await page.waitForFunction(() => document.querySelector("#project-select")?.options.length > 0);
  assert.deepEqual(await page.locator(".sidebar .nav-item span").allTextContents(), ["总览", "评测集管理", "跑测工作台", "根因分析"]);
  await page.locator("#new-project").click();
  await page.locator('#project-dialog [aria-label="关闭新建项目窗口"]').click();
  assert.equal(await page.locator("#project-dialog").evaluate(element => element.open), false);
  await page.locator("#new-project").click();
  await page.locator("#project-dialog [data-close-dialog]").last().click();
  assert.equal(await page.locator("#project-dialog").evaluate(element => element.open), false);
  await page.locator('[data-section="datasets"]').click();
  assert.deepEqual(await page.locator("#section-tabs .section-tab").allTextContents(), ["评测集列表", "测试用例", "审核与发布", "评测规则"]);
  await page.locator("#dataset-list .dataset-row").first().waitFor();
  assert.ok((await page.locator("#view-brief").innerText()).includes("当前项目的评测集"));
  assert.ok(!(await page.locator("#view-brief").innerText()).includes("全部项目"));
  await page.locator("#new-dataset").click();
  await page.locator('#dataset-form input[name="name"]').fill("UI 回归测试集");
  await page.locator("#save-dataset").click();
  await page.locator("#dataset-list").filter({ hasText: "UI 回归测试集" }).waitFor();
  await page.locator("#new-dataset").click();
  await page.locator('#dataset-form input[name="name"]').fill("待删除测试集");
  await page.locator("#save-dataset").click();
  const deletable = page.locator(".dataset-row", { hasText: "待删除测试集" });
  await deletable.waitFor();
  page.once("dialog", dialog => dialog.accept());
  await deletable.locator(".dataset-delete").click();
  await deletable.waitFor({ state: "detached" });
  await page.locator(".dataset-row", { hasText: "UI 回归测试集" }).locator(".dataset-open").click();
  assert.equal(await page.locator("#case-dataset-name").innerText(), "UI 回归测试集");
  await page.locator('[data-section="workbench"]').click();
  assert.deepEqual(await page.locator("#section-tabs .section-tab").allTextContents(), ["新建跑测", "RAG 自动采集", "Agent 链路跑测", "评测模型", "运行任务"]);
  await page.locator('[data-view="judge-models"]').click();
  await page.locator("#new-judge-model").click();
  await page.locator('#judge-model-form input[name="name"]').fill("UI Judge");
  await page.locator('#judge-model-form input[name="model_id"]').fill("fixture-model");
  await page.locator('#judge-model-form input[name="base_url"]').fill("http://127.0.0.1:1/v1");
  await page.locator('#judge-model-form input[name="api_key"]').fill("ui-private-key");
  await page.locator('#judge-model-form button[type="submit"]').click();
  await page.locator(".judge-model-row").filter({ hasText: "UI Judge" }).waitFor();
  assert.equal((await page.locator(".judge-model-row").innerText()).includes("ui-private-key"), false);
  const judgeQa = join(root, ".codex-tmp", "agent-ui-qa"); await mkdir(judgeQa, { recursive: true });
  await page.screenshot({ path: join(judgeQa, "judge-models.png"), fullPage: true });
  page.once("dialog", dialog => dialog.accept());
  await page.locator('.judge-model-row [data-action="delete"]').click();
  await page.locator(".judge-model-row").waitFor({ state: "detached" });
  await page.locator('[data-view="rag"]').click();
  await page.locator("#view-rag").waitFor({ state: "visible" });
  assert.equal(await page.locator("#open-test-browser").count(), 1);
  await page.locator('[data-view="agent"]').click();
  await page.locator("#agent-langfuse-status").filter({ hasText: "未配置" }).waitFor();
  const projectId = await page.locator("#project-select").inputValue();
  const post = async (path, body) => { const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); assert.ok(response.ok); return response.json(); };
  const sets = await fetch(`${base}/api/projects/${projectId}/evaluation-sets`).then(r => r.json());
  const testSet = sets.find(item => item.name === "UI 回归测试集");
  const testCase = await post(`/api/projects/${projectId}/cases`, { title: "关联裁剪用例", query: "裁剪前4秒", expected_answer: "输出0至4秒文件", evaluation_set_id: testSet.id,
    expected_trace_json: { required_tools: ["video_trim"], forbidden_tools: ["video_speed"], notes: "先裁剪，再返回结果", parameter_constraints: "开始0秒，结束4秒" } });
  // Reload must inherit the dataset selected in dataset management without
  // requiring an extra change event in the trace form.
  await page.reload();
  await page.locator('[data-section="workbench"]').click();
  await page.locator('[data-view="agent"]').click();
  await page.waitForFunction(id => [...document.querySelector("#agent-case-id").options].some(item => item.value === String(id)), testCase.id);
  assert.equal(await page.locator("#agent-set-id").inputValue(), String(testSet.id));
  assert.equal(await page.locator("#agent-case-id").isEnabled(), true);
  await page.locator("#agent-case-id").selectOption(String(testCase.id));
  const makeNode = (id, name, parent, extra = {}) => ({ id, name, traceId: "ui-trace", parentObservationId: parent, startTime: "2026-09-14T01:00:00Z", endTime: "2026-09-14T01:00:01Z", input: {}, output: {}, ...extra });
  const fixture = { id: "ui-trace", name: "裁剪视频前 4 秒", observations: [
    makeNode("root", "chat", null, { input: "请把视频前4秒裁剪出来", output: "已生成裁剪视频 output.mp4", userId: "user-ui", sessionId: "session-ui" }),
    makeNode("step", "agent.step", "root"), makeNode("model", "model.invoke", "step", { model: "deepseek-v4-flash", type: "GENERATION", input: [{ role: "user", content: "裁剪前4秒" }], output: { tool_calls: [{ name: "video_trim", arguments: { startTime: 0, endTime: 4 } }] } }),
    makeNode("trim", "video_trim", "step", { input: { startTime: 0, endTime: 4 }, output: { success: true, outputPath: "output.mp4" } }),
  ] };
  await page.locator("#agent-json-file").setInputFiles({ name: "trace.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.locator(".agent-task-head h2").filter({ hasText: "裁剪视频前 4 秒" }).waitFor();
  assert.equal(await page.locator("#agent-expected-answer").inputValue(), "输出0至4秒文件");
  assert.equal(await page.locator("#agent-expected-trace").inputValue(), "先裁剪，再返回结果");
  assert.equal(await page.locator("#agent-forbidden-tools").inputValue(), "video_speed");
  assert.equal(await page.locator("#agent-constraints").inputValue(), "开始0秒，结束4秒");
  const otherSet = sets.find(item => item.id !== testSet.id);
  if (otherSet) {
    await page.locator("#agent-set-id").selectOption(String(otherSet.id));
    assert.equal(await page.locator("#agent-case-id").inputValue(), "");
    await page.locator("#agent-set-id").selectOption(String(testSet.id));
    await page.waitForFunction(id => [...document.querySelector("#agent-case-id").options].some(item => item.value === String(id)), testCase.id);
    await page.locator("#agent-case-id").selectOption(String(testCase.id));
  }
  await page.locator("#agent-expected-answer").fill("临时修改");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#agent-link-case").click();
  await page.waitForFunction(() => document.querySelector("#agent-expected-answer").value === "输出0至4秒文件");
  assert.ok((await page.locator(".agent-conversation").innerText()).includes("请把视频前4秒裁剪出来"));
  await page.locator('.agent-node').filter({ hasText: "视频裁剪工具" }).click();
  assert.ok((await page.locator("#agent-node-detail").innerText()).includes('"endTime": 4'));
  await page.locator("#agent-expected-answer").fill("生成原视频0至4秒文件，并返回下载地址");
  await page.locator("#agent-tools").fill("video_trim"); await page.locator("#agent-score-form button[type=submit]").click();
  await page.locator(".agent-result h2").filter({ hasText: "待核验" }).waitFor();
  assert.ok((await page.locator(".agent-result").innerText()).includes("找到对应工具执行节点"));
  const qa = join(root, ".codex-tmp", "agent-ui-qa"); await mkdir(qa, { recursive: true });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: join(qa, "desktop.png"), fullPage: true });
  await page.locator("#agent-tool-parameters").evaluate(element => element.closest("details").open = true);
  await page.locator("#agent-tool-parameters").fill('[{"name":"video_trim","parameters":{"endTime":40}}]');
  await page.locator("#agent-score-form button[type=submit]").click(); await page.locator(".agent-result h2").filter({ hasText: "不通过" }).waitFor();
  await page.locator("#agent-scoring-standard").fill("");
  await page.locator("#agent-semantic").click(); await page.locator("#agent-score-error").filter({ hasText: "请先填写评分标准" }).waitFor();
  await page.locator("#agent-scoring-standard").fill("工具及参数符合预期，回答准确才通过。");
  assert.equal(await page.locator("#agent-semantic").innerText(), "进行评测");
  await page.locator("#agent-semantic").click(); await page.locator("#agent-score-error").filter({ hasText: "尚未配置真实评测模型" }).waitFor();
  await page.setViewportSize({ width: 600, height: 1000 }); await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" })); await page.screenshot({ path: join(qa, "mobile.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "mobile layout overflows");
  assert.deepEqual(errors, []); console.log(`UI verification passed. Screenshots: ${qa}`);
} finally {
  await browser?.close(); const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited;
}
