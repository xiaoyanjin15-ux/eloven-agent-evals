import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createOfficeSession, OfficeAgent } from "./agents.js";

test("Office Agent combines Base URL and variable Agent ID without persisting JWT", async () => {
  let observedPath = "";
  let observedAuth = "";
  let observedHermesAuth = "";
  let observedSession = "";
  let observedBody: Record<string, unknown> = {};
  const server = createServer(async (request, response) => {
    observedPath = request.url || "";
    observedAuth = String(request.headers.authorization || "");
    observedHermesAuth = String(request.headers["x-hermes-auth-token"] || "");
    observedSession = String(request.headers["x-hermes-web-session-id"] || "");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    observedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "测试成功" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  try {
    const agent = new OfficeAgent({
      base_url: `http://127.0.0.1:${address.port}`,
      agent_id: "2068882573661888514",
      profile: "xhs",
      jwt: "temporary-jwt",
      session_id: "eval-session-123",
    });
    const reply = await agent.reply([{ role: "user", content: "你好" }]);
    assert.equal(observedPath, "/2068882573661888514/xhs/v1/chat/completions?token=temporary-jwt");
    assert.equal(observedAuth, "Bearer internal");
    assert.equal(observedHermesAuth, "temporary-jwt");
    assert.equal(observedSession, "eval-session-123");
    assert.equal(observedBody.model, "default");
    assert.equal(observedBody.stream, true);
    assert.equal(reply.content, "测试成功");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Office Agent parses SSE responses used by long-running Agents", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end([
      'data: {"choices":[{"delta":{"content":"流式"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"成功"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join("\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  try {
    const agent = new OfficeAgent({ base_url: `http://127.0.0.1:${address.port}`, agent_id: "agent-stream", profile: "xhs" });
    assert.equal((await agent.reply([{ role: "user", content: "hi" }])).content, "流式成功");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Office Agent finishes as soon as SSE sends DONE without waiting for connection close", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"done-fast"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server failed");
  try {
    const started = Date.now();
    const agent = new OfficeAgent({ base_url: `http://127.0.0.1:${address.port}`, agent_id: "agent-stream" });
    assert.equal((await agent.reply([{ role: "user", content: "hi" }])).content, "done-fast");
    assert.ok(Date.now() - started < 1_000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Office Agent can call an authentication-free test deployment", async () => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer internal");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  try {
    const agent = new OfficeAgent({ base_url: `http://127.0.0.1:${address.port}`, agent_id: "agent-2" });
    assert.equal((await agent.reply([{ role: "user", content: "hi" }])).content, "ok");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Office Agent resolves the platform-created default profile session", async () => {
  assert.equal(await createOfficeSession({ base_url: "https://example.test", agent_id: "agent-1", profile: "xhs" }), "default_xhs");
  assert.equal(await createOfficeSession({ base_url: "https://example.test", agent_id: "agent-1", profile: "xhs", session_id: "existing-1" }), "existing-1");
});
