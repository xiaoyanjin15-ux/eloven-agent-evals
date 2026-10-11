import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "builtin-judges-ui-"));
const gateway = createServer(async (request, response) => {
  if (request.url !== "/v1/chat/completions" || request.headers.authorization !== "Bearer fixture-only-key") {
    response.writeHead(401); response.end(); return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
});
await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
const gatewayAddress = gateway.address();
if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("Mock gateway did not start");
const port = 19500 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [join(root, "dist/src/server.js")], { cwd: root, stdio: "pipe", env: {
  ...process.env, PORT: String(port), AGENT_EVAL_DB: join(temporary, "test.db"),
  JUDGE_MODELS_FILE: join(temporary, "judges.json"), PI_PROVIDER: "openai", PI_MODEL: "deepseek-v4-pro",
  PI_BASE_URL: `http://127.0.0.1:${gatewayAddress.port}/v1`, PI_API_KEY: "fixture-only-key",
  LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "",
} });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, "server did not start");
  const created = await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "视频理解agent", project_key: "VIDEO" }) }).then(response => response.json());
  const modelUrl = `${base}/api/projects/${created.id}/judge-models`;
  const models = await fetch(modelUrl).then(response => response.json());
  assert.equal(models.filter(item => item.source === "builtin").length, 6);
  assert.equal(JSON.stringify(models).includes("fixture-only-key"), false);
  const browserTarget = process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : { channel: process.env.PLAYWRIGHT_CHANNEL || "chrome" };
  browser = await chromium.launch({ ...browserTarget, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(base);
  await page.locator('[data-section="workbench"]').click();
  await page.locator('[data-view="judge-models"]').click();
  await page.locator('.judge-model-group').first().locator('.judge-model-row').first().waitFor();
  assert.equal(await page.locator('.judge-model-group').first().locator('.judge-model-row').count(), 6);
  assert.equal(await page.locator('.judge-model-group').first().locator('[data-action="edit"]').count(), 0);
  assert.equal((await page.locator('#view-judge-models').innerText()).includes("fixture-only-key"), false);
  const flash = models.find(item => item.model_id === "deepseek-v4-flash");
  await page.locator(`[data-model-id="${flash.id}"] [data-action="test"]`).click();
  await page.locator("#toast").filter({ hasText: "接口连通且返回文本" }).waitFor();
  await page.locator(`[data-model-id="${flash.id}"] [data-action="default"]`).click();
  await page.waitForFunction(async ({ url, id }) => (await fetch(url).then(response => response.json())).find(item => item.is_default)?.id === id, { url: modelUrl, id: flash.id });
  assert.equal((await fetch(modelUrl).then(response => response.json())).find(item => item.is_default).id, flash.id);
  await page.locator('.section-tab[data-view="run-setup"]').click();
  const gpt = models.find(item => item.model_id === "jinxiaoyan-gpt-5.5-yjs-ym");
  await page.locator('#run-judge-model-select').selectOption(gpt.id);
  await page.waitForFunction(async url => (await fetch(url).then(response => response.json())).find(item => item.is_default)?.model_id === "jinxiaoyan-gpt-5.5-yjs-ym", modelUrl);
  await page.locator('[data-view="judge-models"]').click();
  const screenshots = join(root, ".codex-tmp", "agent-ui-qa"); await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, "builtin-models.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log("Built-in judge UI verification passed.");
} finally {
  await browser?.close();
  const exited = new Promise(resolve => child.once("exit", resolve)); child.kill(); await exited;
  await new Promise(resolve => gateway.close(resolve));
  const resolvedTemporary = await realpath(temporary);
  assert.equal(dirname(resolvedTemporary), await realpath(tmpdir()));
  await rm(resolvedTemporary, { recursive: true, force: true });
}
