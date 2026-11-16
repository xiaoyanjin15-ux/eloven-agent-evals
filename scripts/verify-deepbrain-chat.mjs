import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { assistantTexts, startNewConversation, waitForAnswer } from "../dist/src/browser-runner.js";

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || "E:\\playwright-browsers\\chromium-1234\\chrome-win64\\chrome.exe", headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<button aria-label="在新对话中分支" onclick="window.branched=true">分支</button>
    <button aria-label="新建会话" onclick="document.querySelector('#messages').replaceChildren(); document.querySelector('[contenteditable]').textContent=''; window.created=(window.created||0)+1">新会话Ctrl+Alt+N</button>
    <div id="messages"><div data-slot="conversation.chat.assistant.text">继承的旧回答</div></div>
    <div contenteditable="true" aria-label="发消息或创建任务"></div>`);
  for (let question = 1; question <= 2; question++) {
    await startNewConversation(page, page);
    assert.equal(await page.evaluate(() => window.branched || false), false);
    assert.equal(await page.evaluate(() => window.created), question);
    assert.deepEqual(await assistantTexts(page), []);
    const before = await assistantTexts(page);
    await page.evaluate(question => {
      const reply = document.createElement('div');
      reply.dataset.slot = 'conversation.chat.assistant.text';
      reply.style.whiteSpace = 'pre-wrap';
      reply.textContent = `第${question}题完整回答\n包含第二段内容`;
      document.querySelector('#messages').append(reply);
    }, question);
    assert.equal(await waitForAnswer(page, before, `问题${question}`, 10000), `第${question}题完整回答\n包含第二段内容`);
  }
  await page.getByRole('button', { name: '新建会话', exact: true }).evaluate(button => button.remove());
  await assert.rejects(startNewConversation(page, page), /未找到新建空白会话/);
  assert.equal(await page.evaluate(() => window.branched || false), false);
  console.log('PASS: precise new-session button, cleared history, DeepBrain answer capture, no branch fallback');
} finally { await browser.close(); }
