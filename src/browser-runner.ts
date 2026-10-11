import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from "playwright-core";

import type { EvalCase } from "./domain.js";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)), "..");
const DEFAULT_EXECUTABLE = "E:\\playwright-browsers\\chromium-1234\\chrome-win64\\chrome.exe";
const PROFILE_DIR = absolutePath(process.env.PLAYWRIGHT_PROFILE_DIR || "./data/playwright-profile");
const SCREENSHOT_DIR = absolutePath(process.env.PLAYWRIGHT_SCREENSHOT_DIR || "./data/screenshots");
const ARTIFACT_DIR = absolutePath(process.env.AGENT_EVAL_ARTIFACT_DIR || "./artifacts");
const EXECUTABLE = process.env.PLAYWRIGHT_EXECUTABLE_PATH || DEFAULT_EXECUTABLE;
const HEADLESS = /^true$/i.test(process.env.PLAYWRIGHT_HEADLESS || "false");
const DEBUG_PORT = Number(process.env.PLAYWRIGHT_DEBUG_PORT || 9333);
const DEBUG_URL = `http://127.0.0.1:${DEBUG_PORT}`;

type BrowserScope = Page | Frame;

export interface BrowserDialogueResult {
  answer: string;
  latency_ms: number;
  screenshot: string;
  screenshots: string[];
  trace: Array<Record<string, unknown>>;
}

export interface BrowserDialogueOptions {
  newConversation?: boolean;
}

export class BrowserDialogueError extends Error {
  constructor(message: string, public screenshot = "", public trace: Array<Record<string, unknown>> = []) { super(message); }
}

let context: BrowserContext | undefined;
let browser: Browser | undefined;
let launching: Promise<BrowserContext> | undefined;
let runQueue: Promise<unknown> = Promise.resolve();

export function browserStatus(): Record<string, unknown> {
  return {
    configured: existsSync(EXECUTABLE),
    connected: Boolean(context && browser?.isConnected()),
    executable: EXECUTABLE,
    profile_dir: PROFILE_DIR,
    headless: HEADLESS,
  };
}

export async function openBrowserSession(startUrl: string): Promise<Record<string, unknown>> {
  const browserContext = await ensureContext();
  const page = await getPage(browserContext, startUrl, true);
  await page.bringToFront();
  return { ...browserStatus(), opened_url: page.url(), message: "测试浏览器进程已启动。若没有看到窗口，请双击项目根目录的“启动评测系统.cmd”重启服务后再试。" };
}

export async function activateBrowserOffice(startUrl: string, actualOfficeName: string, directUrl = ""): Promise<Record<string, unknown>> {
  const targetUrl = directUrl || startUrl;
  if (!targetUrl) throw new Error("办公室缺少 Office 页面地址");
  if (!actualOfficeName.trim() && !directUrl) throw new Error("尚未绑定实际 Office 名称");
  const browserContext = await ensureContext();
  const page = await getLoggedInOfficePage(browserContext, startUrl);
  await page.bringToFront();
  await page.waitForTimeout(800);

  let entry = actualOfficeName.trim() ? await revealAndFindOffice(page, actualOfficeName.trim()) : undefined;
  if (!entry && directUrl) {
    await page.goto(directUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(800);
    if (await findConversationScope(page)) return { opened_url: page.url(), office: actualOfficeName, located_by: "direct_url_fallback" };
    const directAgent = await waitForOfficeTarget(page, actualOfficeName.trim(), "agent", 8_000);
    if (directAgent) {
      await directAgent.click();
      if (await waitForConversationScope(page, 20_000)) return { opened_url: page.url(), office: actualOfficeName, located_by: "direct_url_then_agent" };
    }
    entry = await revealAndFindOffice(page, actualOfficeName.trim()).catch(() => undefined);
  }
  if (!entry) throw new Error(`未在“我的办公室”下拉列表找到“${actualOfficeName}”。请检查实际 Office 名称，或填写该 Office 的直达地址`);
  await entry.click();
  await page.waitForTimeout(1_000);
  if (await waitForConversationScope(page, 2_500)) return { opened_url: page.url(), office: actualOfficeName, located_by: "office_name" };

  const agentEntry = await waitForOfficeTarget(page, actualOfficeName.trim(), "agent", 15_000);
  if (!agentEntry) throw new Error(`已进入“${actualOfficeName}”，但没有找到左侧同名 Agent 入口`);
  await agentEntry.click();
  if (!await waitForConversationScope(page, 20_000)) throw new Error(`已点击“${actualOfficeName}”的 Agent 入口，但没有出现对话框`);
  return { opened_url: page.url(), office: actualOfficeName, located_by: "office_then_agent_name" };
}

async function getLoggedInOfficePage(browserContext: BrowserContext, startUrl: string): Promise<Page> {
  const expectedHost = new URL(startUrl).host;
  const pages = [...browserContext.pages()].reverse();
  for (const candidate of pages) {
    if (candidate.isClosed()) continue;
    let candidateHost = "";
    try { candidateHost = new URL(candidate.url()).host; } catch { /* about:blank */ }
    if (candidateHost !== expectedHost) continue;
    if (/\/(?:login|signin|auth)(?:[/?#]|$)/i.test(candidate.url())) continue;
    return candidate;
  }
  for (const candidate of pages) {
    if (candidate.isClosed()) continue;
    if (await findOfficeSwitcher(candidate) || await findConversationScope(candidate)) return candidate;
  }
  return getPage(browserContext, startUrl, true);
}

export async function runBrowserDialogue(evalCase: EvalCase, projectKey = `project-${evalCase.project_id}`,
  options: BrowserDialogueOptions = {}): Promise<BrowserDialogueResult> {
  const task = runQueue.then(() => executeDialogue(evalCase, projectKey, options));
  runQueue = task.catch(() => undefined);
  return task;
}

export async function closeBrowser(): Promise<void> {
  context = undefined;
  browser = undefined;
  launching = undefined;
}

export function screenshotFilePath(value: string): string | undefined {
  if (!value) return undefined;
  const name = basename(value);
  const path = join(SCREENSHOT_DIR, name);
  return existsSync(path) ? path : undefined;
}

export function artifactFilePath(relative: string): string | undefined {
  const decoded = decodeURIComponent(relative).replace(/^[/\\]+/, "");
  const path = resolve(ARTIFACT_DIR, decoded);
  const root = resolve(ARTIFACT_DIR) + sep;
  return path.startsWith(root) && existsSync(path) ? path : undefined;
}

export function writeResultArtifact(screenshotUrl: string, result: unknown): void {
  if (!screenshotUrl.startsWith("/artifacts/")) return;
  const screenshot = artifactFilePath(screenshotUrl.slice("/artifacts/".length));
  if (!screenshot) return;
  const folder = dirname(screenshot);
  writeFileSync(join(folder, "result.json"), JSON.stringify(result, null, 2), "utf8");
  const run = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const messages = Array.isArray(run.messages) ? run.messages as Array<Record<string, unknown>> : [];
  const question = messages.find((item) => item.role === "user")?.content || run.query || "";
  const answer = [...messages].reverse().find((item) => item.role === "assistant")?.content || "";
  const detail = run.score_detail && typeof run.score_detail === "object" ? run.score_detail as Record<string, unknown> : {};
  const reasons = Array.isArray(detail.reasons) ? detail.reasons.join("；") : run.summary || "";
  const readable = [
    `用例编号：${run.code || ""}`,
    `执行状态：${run.status || ""}`,
    `评测结果：${run.status === "completed" ? (Number(run.passed) ? "通过" : "未通过") : "执行失败"}`,
    `分数：${run.score ?? ""}`,
    `问题：${question}`,
    `实际回答：${answer}`,
    `评测理由：${reasons}`,
    `截图：${basename(screenshot)}`,
  ].join("\r\n\r\n");
  writeFileSync(join(folder, "result.txt"), readable, "utf8");
}

async function executeDialogue(evalCase: EvalCase, projectKey: string, options: BrowserDialogueOptions): Promise<BrowserDialogueResult> {
  if (!evalCase.start_url) throw new Error("浏览器用例缺少 Office 起始页面地址");
  const trace: Array<Record<string, unknown>> = [];
  const started = Date.now();
  const folder = artifactFolder(projectKey, evalCase.code);
  mkdirSync(folder.path, { recursive: true });
  let page: Page | undefined;
  try {
  const browserContext = await ensureContext();
  page = await getPage(browserContext, evalCase.start_url, false);
  await page.bringToFront();
  trace.push({ action: "navigate", target: evalCase.start_url, status: "completed", at: new Date().toISOString() });

  let scope = await findConversationScope(page);
  if (!scope) throw new Error("未找到 Agent 对话区域。请在弹出的测试浏览器中登录 Office、打开目标 Agent 后重新执行");

  if (options.newConversation !== false) {
    const newChat = await findNewChatButton(scope);
    if (newChat) {
      await newChat.click();
      await page.waitForTimeout(700);
      trace.push({ action: "click", target: "新对话", status: "completed" });
      scope = await findConversationScope(page) || scope;
    } else {
      trace.push({ action: "click", target: "新对话", status: "skipped", reason: "页面没有可见的新对话按钮" });
    }
  } else {
    trace.push({ action: "continue_conversation", target: evalCase.conversation_group, round: evalCase.conversation_round, status: "completed" });
  }

  if (evalCase.input_mode === "topic_click") {
    const step = evalCase.browser_steps.find((item) => item.action === "click");
    const target = String(step?.target || evalCase.query).trim();
    await clickVisibleText(page, target);
    await page.waitForTimeout(1_200);
    scope = await findConversationScope(page) || scope;
    const answer = `已点击 Topic「${target}」并进入对应对话场景`;
    const screenshots = await captureDialogueEvidence(page, scope, evalCase.query, folder);
    trace.push({ action: "click_topic", target, status: "completed" });
    trace.push({ action: "screenshot", target: screenshots, status: "completed", count: screenshots.length });
    return { answer, latency_ms: Date.now() - started, screenshot: screenshots[0] || "", screenshots, trace };
  }

  const input = await findMessageInput(scope);
  if (!input) throw new Error("已打开 Agent，但没有找到可输入的对话框");
  await fillMessage(input, evalCase.query);
  const written = await readInputValue(input);
  if (normaliseSpace(written) !== normaliseSpace(evalCase.query)) throw new Error("测试问题未能正确写入对话框");
  trace.push({ action: "fill", target: "消息输入框", value: evalCase.query, status: "completed" });

  const before = await articleTexts(scope);
  const send = await findSendButton(scope);
  if (send) await send.click();
  else await input.press("Enter");
  trace.push({ action: "click", target: send ? "发送" : "按 Enter 发送", status: "completed" });

  const answer = await waitForAnswer(scope, before, evalCase.query, 150_000);
  const latency = Date.now() - started;
  const screenshots = await captureDialogueEvidence(page, scope, evalCase.query, folder);
  const screenshotUrl = screenshots[0] || "";
  trace.push({ action: "screenshot", target: screenshots, status: "completed", count: screenshots.length });
  trace.push({ action: "capture", target: "Agent 回复", status: "completed", answer_length: answer.length });
  return { answer, latency_ms: latency, screenshot: screenshotUrl, screenshots, trace };
  } catch (error) {
    let screenshot = "";
    if (page) {
      try {
        await page.screenshot({ path: join(folder.path, "failure.png"), fullPage: false });
        screenshot = `${folder.url}/failure.png`;
      } catch { /* page may already be closed */ }
    }
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(join(folder.path, "failure.json"), JSON.stringify({ case_code: evalCase.code, error: message, trace, at: new Date().toISOString() }, null, 2), "utf8");
    throw new BrowserDialogueError(message, screenshot, trace);
  }
}

async function clickVisibleText(page: Page, target: string): Promise<void> {
  const exact = new RegExp(`^\\s*${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const scopes: BrowserScope[] = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
  for (const scope of scopes) {
    const found = await firstVisible([
      scope.getByRole("button", { name: exact }), scope.getByRole("link", { name: exact }),
      scope.locator(`[title="${cssAttributeValue(target)}"], [aria-label="${cssAttributeValue(target)}"]`), scope.getByText(exact),
    ]);
    if (found) { await found.click(); return; }
  }
  throw new Error(`未找到可点击的 Topic“${target}”`);
}

function artifactFolder(projectKey: string, caseCode: string): { path: string; url: string } {
  const safeProject = safeSegment(projectKey);
  const safeCase = safeSegment(caseCode);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return { path: join(ARTIFACT_DIR, safeProject, safeCase, stamp), url: `/artifacts/${encodeURIComponent(safeProject)}/${encodeURIComponent(safeCase)}/${stamp}` };
}

function safeSegment(value: string): string {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

async function ensureContext(): Promise<BrowserContext> {
  if (context && browser?.isConnected()) return context;
  if (launching) return launching;
  if (!existsSync(EXECUTABLE)) throw new Error(`找不到 Playwright 浏览器：${EXECUTABLE}`);
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  launching = connectOrLaunch().catch((error) => {
    launching = undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (/ProcessSingleton|profile directory|user data directory/i.test(message)) {
      throw new Error("测试浏览器登录目录正被旧进程占用。请关闭所有测试 Chromium 窗口，然后点击“打开测试浏览器 / 登录”重试");
    }
    throw new Error(`测试浏览器启动失败：${message.split("\n")[0]}`);
  });
  return launching;
}

async function connectOrLaunch(): Promise<BrowserContext> {
  let connected = await connectExisting();
  if (!connected) {
    const args = [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--start-maximized",
      "about:blank",
    ];
    const child = spawn(EXECUTABLE, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    for (let attempt = 0; attempt < 40 && !connected; attempt += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      connected = await connectExisting();
    }
  }
  if (!connected) throw new Error("浏览器进程已启动，但无法建立 Playwright 连接；请关闭残留测试 Chromium 后重试");
  browser = connected;
  browser.on("disconnected", () => { browser = undefined; context = undefined; launching = undefined; });
  context = browser.contexts()[0];
  if (!context) throw new Error("测试浏览器没有可用的页面上下文");
  launching = undefined;
  return context;
}

async function connectExisting(): Promise<Browser | undefined> {
  try { return await chromium.connectOverCDP(DEBUG_URL, { timeout: 1_000 }); }
  catch { return undefined; }
}

async function getPage(browserContext: BrowserContext, startUrl: string, navigate: boolean): Promise<Page> {
  const wanted = new URL(startUrl);
  const existing = browserContext.pages().find((candidate) => {
    try { return new URL(candidate.url()).host === wanted.host; } catch { return false; }
  });
  const page = existing || browserContext.pages()[0] || await browserContext.newPage();
  if ((!existing || navigate) && page.url() !== startUrl) await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return page;
}

async function findConversationScope(page: Page): Promise<BrowserScope | undefined> {
  const scopes: BrowserScope[] = [...page.frames().filter((frame) => frame !== page.mainFrame()), page];
  for (const scope of scopes) {
    if (await findMessageInput(scope)) return scope;
  }
  return undefined;
}

async function findOfficeEntry(page: Page, officeName: string, stage: "office" | "agent"): Promise<Locator | undefined> {
  const scopes: BrowserScope[] = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
  const namePattern = officeNamePattern(officeName);
  for (const scope of scopes) {
    const found = await firstVisible([
      scope.getByRole("link", { name: namePattern }),
      scope.getByRole("button", { name: namePattern }),
      scope.locator(`[title="${cssAttributeValue(officeName)}"], [aria-label="${cssAttributeValue(officeName)}"]`),
      scope.getByText(namePattern),
    ]);
    if (found && (stage === "office" || await isLeftSideTarget(found, page))) return found;
  }
  return undefined;
}

async function revealAndFindOffice(page: Page, officeName: string): Promise<Locator | undefined> {
  const alreadyVisible = await findOfficeEntry(page, officeName, "office");
  if (alreadyVisible) return alreadyVisible;
  const switcher = await findOfficeSwitcher(page);
  if (!switcher) throw new Error("未找到页面顶部的“我的办公室”切换入口");

  await switcher.hover().catch(() => undefined);
  let entry = await waitForOfficeTarget(page, officeName, "office", 3_000);
  if (entry) return entry;

  await switcher.click().catch(() => undefined);
  entry = await waitForOfficeTarget(page, officeName, "office", 3_000);
  return entry;
}

async function findOfficeSwitcher(page: Page): Promise<Locator | undefined> {
  const scopes: BrowserScope[] = [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
  for (const scope of scopes) {
    const found = await firstVisible([
      scope.getByRole("button", { name: /我的办公室/ }),
      scope.getByRole("link", { name: /我的办公室/ }),
      scope.locator('[aria-label*="我的办公室"], [title*="我的办公室"]'),
      scope.getByText(/^\s*我的办公室\s*$/),
    ]);
    if (found) return found;
  }
  return undefined;
}

async function waitForOfficeTarget(page: Page, officeName: string, stage: "office" | "agent", timeoutMs: number): Promise<Locator | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await findOfficeEntry(page, officeName, stage);
    if (found) return found;
    await page.waitForTimeout(500);
  }
  return undefined;
}

async function waitForConversationScope(page: Page, timeoutMs: number): Promise<BrowserScope | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const scope = await findConversationScope(page);
    if (scope) return scope;
    await page.waitForTimeout(500);
  }
  return undefined;
}

async function isLeftSideTarget(locator: Locator, page: Page): Promise<boolean> {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return false;
  const width = await page.evaluate(() => window.innerWidth).catch(() => 0);
  return !width || box.x + box.width / 2 <= Math.max(520, width * 0.42);
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function officeNamePattern(value: string): RegExp {
  const body = [...value.trim()].map((character) => {
    if (/\s/.test(character)) return "\\s*";
    if (character === "|" || character === "｜") return "\\s*[|｜]\\s*";
    return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  return new RegExp(`^\\s*${body}\\s*$`, "i");
}

async function findNewChatButton(scope: BrowserScope): Promise<Locator | undefined> {
  const candidates = [
    scope.getByRole("button", { name: /新对话|新会话|开始新对话/ }),
    scope.locator('[aria-label*="新对话"], [aria-label*="新会话"], [title*="新对话"], [title*="新会话"]'),
    scope.getByText(/^(新对话|新会话|开始新对话)$/),
  ];
  return firstVisible(candidates);
}

async function findMessageInput(scope: BrowserScope): Promise<Locator | undefined> {
  return firstVisible([
    scope.locator('textarea'),
    scope.locator('[contenteditable="true"]'),
    scope.locator('input[type="text"]'),
    scope.getByPlaceholder(/请输入|输入消息|发送消息|问点什么|说点什么/),
  ], true);
}

async function findSendButton(scope: BrowserScope): Promise<Locator | undefined> {
  return firstVisible([
    scope.getByRole("button", { name: /发送|Send/i }),
    scope.locator('[aria-label*="发送"], [title*="发送"], button[type="submit"]'),
  ]);
}

async function firstVisible(candidates: Locator[], requireEnabled = false): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const count = Math.min(await candidate.count().catch(() => 0), 20);
    for (let index = 0; index < count; index += 1) {
      const item = candidate.nth(index);
      if (await item.isVisible().catch(() => false) && (!requireEnabled || await item.isEnabled().catch(() => false))) return item;
    }
  }
  return undefined;
}

async function fillMessage(input: Locator, value: string): Promise<void> {
  try { await input.fill(value); }
  catch {
    await input.click();
    await input.press("Control+A");
    await input.press("Backspace");
    await input.pressSequentially(value);
  }
}

async function readInputValue(input: Locator): Promise<string> {
  return input.evaluate((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
    return element.textContent || "";
  });
}

async function waitForAnswer(scope: BrowserScope, before: string[], query: string, timeoutMs: number): Promise<string> {
  const started = Date.now();
  let stable = "";
  let stableCount = 0;
  while (Date.now() - started < timeoutMs) {
    const articles = await articleTexts(scope);
    const explicit = await assistantTexts(scope);
    const candidate = pickAnswer(explicit.length ? explicit : articles, before, query);
    const generationActive = await hasGenerationActivity(scope);
    if (candidate && !isGenerating(candidate) && !generationActive) {
      if (candidate === stable) stableCount += 1;
      else { stable = candidate; stableCount = 1; }
      // Four unchanged polls avoid capturing a temporary pause between streamed chunks.
      if (stableCount >= 4) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        return cleanAnswer(candidate);
      }
    } else {
      stable = "";
      stableCount = 0;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
  }
  throw new Error("等待 Agent 回复超时（150 秒）");
}

async function hasGenerationActivity(scope: BrowserScope): Promise<boolean> {
  const indicators = [
    scope.getByRole("button", { name: /停止生成|停止回答|停止|Stop generating|Stop response/i }),
    scope.locator('[aria-busy="true"], [data-loading="true"], [data-generating="true"]'),
    scope.locator('.typing-indicator, .generating-indicator, .streaming-indicator, [class~="typing"], [class~="generating"], [class~="streaming"]'),
  ];
  for (const indicator of indicators) {
    const count = Math.min(await indicator.count().catch(() => 0), 12);
    for (let index = 0; index < count; index += 1) {
      if (await indicator.nth(index).isVisible().catch(() => false)) return true;
    }
  }
  return false;
}

async function articleTexts(scope: BrowserScope): Promise<string[]> {
  const texts = await scope.locator("article").allInnerTexts().catch(() => []);
  return texts.map(normaliseSpace).filter(Boolean);
}

async function assistantTexts(scope: BrowserScope): Promise<string[]> {
  const selector = '[data-message-author-role="assistant"], [data-role="assistant"], .assistant-message, .message.assistant, [class*="assistantMessage"]';
  const texts = await scope.locator(selector).allInnerTexts().catch(() => []);
  return texts.map(normaliseSpace).filter(Boolean);
}

function pickAnswer(current: string[], before: string[], query: string): string {
  if (!current.length) return "";
  const baseline = new Set(before.map(normaliseSpace));
  const candidates = current.filter((item) => {
    const cleaned = cleanAnswer(item);
    return cleaned && !baseline.has(item) && normaliseSpace(cleaned) !== normaliseSpace(query) && !looksLikeUserMessage(item, query);
  });
  return candidates.at(-1) || "";
}

function looksLikeUserMessage(value: string, query: string): boolean {
  const compact = normaliseSpace(value).replace(/^(用户|User|我)\s*/i, "");
  return compact === normaliseSpace(query) || compact === `你${normaliseSpace(query)}`;
}

function cleanAnswer(value: string): string {
  return normaliseSpace(value)
    .replace(/^(AI\s*Office\s*助手|AI\s*助手|Agent|助手|AI)\s*[：:]?\s*/i, "")
    .replace(/^思考过程\s*/i, "")
    .trim();
}

function normaliseSpace(value: string): string {
  return String(value || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();
}

function isGenerating(value: string): boolean {
  return /正在生成|生成中|正在思考|思考中|停止生成|loading/i.test(value);
}

async function scrollLatestMessageIntoView(scope: BrowserScope): Promise<void> {
  const articles = scope.locator("article");
  const count = await articles.count().catch(() => 0);
  if (count) await articles.nth(count - 1).scrollIntoViewIfNeeded().catch(() => undefined);
}

async function captureDialogueEvidence(page: Page, scope: BrowserScope, query: string,
  folder: { path: string; url: string }): Promise<string[]> {
  const assistant = await latestAssistantLocator(scope);
  if (!assistant) {
    const name = "evidence.png";
    await scrollLatestMessageIntoView(scope);
    await page.screenshot({ path: join(folder.path, name), fullPage: false });
    return [`${folder.url}/${name}`];
  }

  const plan = await assistant.evaluate((element, requestedQuery) => {
    const win = element.ownerDocument.defaultView || window;
    const doc = element.ownerDocument;
    const normalise = (value: string | null | undefined) => String(value || "").replace(/\s+/g, " ").trim();
    const targetQuery = normalise(String(requestedQuery));
    const visible = (candidate: Element) => {
      const rect = candidate.getBoundingClientRect();
      const style = win.getComputedStyle(candidate);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const question = Array.from(doc.querySelectorAll("body *"))
      .filter((candidate) => visible(candidate) && normalise(candidate.textContent) === targetQuery)
      .sort((a, b) => a.children.length - b.children.length)
      .at(0);

    let scroller: Element = doc.scrollingElement || doc.documentElement;
    let parent = element.parentElement;
    while (parent && parent !== doc.body) {
      const style = win.getComputedStyle(parent);
      if (/(auto|scroll|overlay)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 8) {
        scroller = parent;
        break;
      }
      parent = parent.parentElement;
    }

    const isDocument = scroller === doc.scrollingElement || scroller === doc.documentElement || scroller === doc.body;
    const scrollerRect = isDocument ? { top: 0 } : scroller.getBoundingClientRect();
    const scrollTop = isDocument ? win.scrollY : (scroller as HTMLElement).scrollTop;
    const contentTop = (candidate: Element) => candidate.getBoundingClientRect().top - scrollerRect.top + scrollTop;
    const answerTop = contentTop(element);
    const answerBottom = answerTop + element.getBoundingClientRect().height;
    const questionTop = question ? contentTop(question) : answerTop;
    const viewport = Math.max(280, isDocument ? win.innerHeight : (scroller as HTMLElement).clientHeight);
    const start = Math.max(0, Math.min(questionTop, answerTop) - 70);
    const end = Math.max(start + 1, answerBottom + 70);
    const maxScroll = Math.max(0, (isDocument ? doc.documentElement.scrollHeight : (scroller as HTMLElement).scrollHeight) - viewport);
    const positions: number[] = [];
    const step = Math.max(220, viewport - 140);
    for (let position = start; position < end && positions.length < 12; position += step) {
      positions.push(Math.min(maxScroll, position));
      if (position + viewport >= end || position >= maxScroll) break;
    }
    if (!positions.length) positions.push(Math.min(maxScroll, start));
    const lastNeeded = Math.min(maxScroll, Math.max(start, end - viewport));
    if (positions.at(-1) !== lastNeeded && positions.length < 12) positions.push(lastNeeded);
    return { positions: [...new Set(positions.map((value) => Math.round(value)))], isDocument };
  }, query);

  const urls: string[] = [];
  for (let index = 0; index < plan.positions.length; index += 1) {
    await assistant.evaluate((element, options) => {
      const doc = element.ownerDocument;
      if (options.isDocument) (doc.defaultView || window).scrollTo({ top: options.position, behavior: "instant" });
      else {
        let parent = element.parentElement;
        while (parent && parent !== doc.body) {
          const style = (doc.defaultView || window).getComputedStyle(parent);
          if (/(auto|scroll|overlay)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 8) {
            parent.scrollTop = options.position;
            break;
          }
          parent = parent.parentElement;
        }
      }
    }, { position: plan.positions[index], isDocument: plan.isDocument });
    await page.waitForTimeout(250);
    const name = `evidence-${String(index + 1).padStart(2, "0")}.png`;
    await page.screenshot({ path: join(folder.path, name), fullPage: false });
    urls.push(`${folder.url}/${name}`);
  }
  return urls;
}

async function latestAssistantLocator(scope: BrowserScope): Promise<Locator | undefined> {
  const selector = '[data-message-author-role="assistant"], [data-role="assistant"], .assistant-message, .message.assistant, [class*="assistantMessage"]';
  const explicit = scope.locator(selector);
  const explicitCount = await explicit.count().catch(() => 0);
  if (explicitCount) return explicit.nth(explicitCount - 1);
  const articles = scope.locator("article");
  const articleCount = await articles.count().catch(() => 0);
  return articleCount ? articles.nth(articleCount - 1) : undefined;
}

function absolutePath(value: string): string {
  return isAbsolute(value) ? value : resolve(ROOT, value);
}
