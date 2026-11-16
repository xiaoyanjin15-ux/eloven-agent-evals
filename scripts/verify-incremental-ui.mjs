import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const temp = await mkdtemp(join(tmpdir(), "incremental-ui-"));
const port = 20000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["dist/src/server.js"], { env: { ...process.env, PORT: String(port), AGENT_EVAL_DB: join(temp, "test.db"),
  JUDGE_MODELS_FILE: join(temp, "models.json"), LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" }, stdio: "pipe" });
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/projects`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const projects = await fetch(`${base}/api/projects`).then(response => response.json());
  const cases = await fetch(`${base}/api/projects/${projects[0].id}/cases`).then(response => response.json());
  await fetch(`${base}/api/projects/${projects[0].id}/cases`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ case_ids: cases.map(item => item.id) }) });
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || "E:\\playwright-browsers\\chromium-1234\\chrome-win64\\chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/browser/session", route => route.fulfill({ json: { opened_url: "https://example.test" } }));
  let submitted;
  let job = { id: "trial", total: 4, completed: 2, passed: 0, failed: 0, workflow_mode: "collect_first", status: "paused", awaiting_trial_confirmation: true,
    stage: "前两条已写入并保存 Excel", trial_results: [{ code: "Q1", status: "collected", answer: "第一条回答", screenshots: [] }, { code: "Q2", status: "collected", answer: "第二条回答", screenshots: [] }],
    result_files: [{ path: join(temp, "结果.xlsx"), name: "结果.xlsx", url: "/api/batches/1/files/0" }] };
  await page.route("**/api/browser-jobs**", async route => {
    const request = route.request();
    if (request.url().endsWith("/api/browser-jobs")) submitted = request.postDataJSON();
    if (request.url().endsWith("/resume")) {
      assert.equal(request.postDataJSON().confirm_trial, true);
      job = { ...job, status: "completed", completed: 4, awaiting_trial_confirmation: false };
    }
    await route.fulfill({ json: job });
  });
  await page.goto(base);
  await page.locator("#project-select option").first().waitFor({ state: "attached" });
  await page.locator('[data-section="workbench"]').click();
  await page.locator('[data-jump="rag"]').click();
  await page.locator("#adapter-overview").selectOption("browser");
  await page.locator("#browser-office-url").fill("https://example.test");
  await page.locator("#view-rag .run-all").click();
  await page.locator("#browser-ready-dialog").waitFor({ state: "visible" });
  await page.locator('#office-run-mode input[value="manual"]').check();
  await page.locator("#result-directory").fill(temp);
  await page.locator("#result-column").fill("J");
  await page.locator("#result-format").selectOption("text");
  await page.locator("#confirm-browser-run").click();
  await page.locator("#trial-confirm-dialog").waitFor({ state: "visible" });
  assert.equal(submitted.case_ids.length, 4);
  assert.deepEqual(submitted.save_options, { directory: temp, column: "J", format: "text" });
  assert.match(await page.locator("#trial-results").innerText(), /第二条回答/);
  const out = join(process.cwd(), "artifacts", "ui-verification"); await mkdir(out, { recursive: true });
  await page.screenshot({ path: join(out, "trial-confirmation.png") });
  await page.locator("#continue-after-trial").click();
  assert.equal(await page.locator("#trial-confirm-dialog").evaluate(dialog => dialog.open), false);
  assert.equal(await page.locator("#job-progress-count").innerText(), "4 / 4");
  assert.deepEqual(errors, []);
  console.log("PASS: save options, automatic trial modal, explicit continuation and result download UI");
} finally { await browser?.close(); server.kill(); }
