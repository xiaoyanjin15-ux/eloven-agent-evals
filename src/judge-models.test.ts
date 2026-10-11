import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJudgeModelStore, testJudgeModel } from "./judge-models.js";

test("judge models are scoped by project and never return saved API keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "judge-models-"));
  try {
    const file = join(directory, "judge-models.local.json");
    const store = createJudgeModelStore(file, null);
    const first = store.save(11, { name: "A", base_url: "https://judge.example/v1/", model_id: "model-a", api_key: "secret-a" });
    const second = store.save(11, { name: "B", base_url: "https://judge.example/v1", model_id: "model-b", api_key: "secret-b" });
    assert.equal(first.is_default, true);
    assert.equal(second.is_default, false);
    assert.equal(JSON.stringify(store.list(11)).includes("secret-a"), false);
    assert.equal(store.list(12).length, 0);
    assert.throws(() => store.get(12, first.id), /不属于当前项目/);
    store.save(11, { is_default: true }, second.id);
    assert.equal(store.selected(11)?.id, second.id);
    store.save(11, { name: "B edited", api_key: "" }, second.id);
    assert.equal(store.get(11, second.id).api_key, "secret-b");
    store.remove(11, second.id);
    assert.equal(store.selected(11)?.id, first.id);
    assert.equal((await readFile(file, "utf8")).includes("secret-a"), true);
    store.removeProject(11);
    assert.equal(store.list(11).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("built-in judges share backend credentials while each project keeps its own default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "judge-builtins-"));
  try {
    const file = join(directory, "judge-models.local.json");
    const store = createJudgeModelStore(file, { base_url: "https://gateway.example/v1", api_key: "shared-secret", model_id: "deepseek-v4-pro" });
    const models = store.list(8);
    assert.equal(models.length, 6);
    assert.equal(models[0].model_id, "deepseek-v4-pro");
    assert.equal(models[0].is_default, true);
    assert.equal(models.every(item => item.source === "builtin"), true);
    assert.equal(JSON.stringify(models).includes("shared-secret"), false);
    const flash = models.find(item => item.model_id === "deepseek-v4-flash")!;
    store.save(8, { is_default: true }, flash.id);
    assert.equal(store.selected(8)?.model_id, "deepseek-v4-flash");
    assert.equal(store.selected(9)?.model_id, "deepseek-v4-pro");
    assert.equal((await readFile(file, "utf8")).includes("shared-secret"), false);
    assert.throws(() => store.remove(8, flash.id), /内置模型不能/);
    assert.throws(() => store.save(8, { name: "changed" }, flash.id), /内置模型由后台配置/);
    const custom = store.save(8, { name: "Custom", base_url: "https://other.example/v1", model_id: "other", api_key: "custom-secret" });
    assert.equal(custom.source, "custom");
    assert.equal(store.selected(8)?.model_id, "deepseek-v4-flash");
    store.save(8, { is_default: true }, custom.id);
    assert.equal(store.selected(8)?.model_id, "other");
    store.remove(8, custom.id);
    assert.equal(store.selected(8)?.model_id, "deepseek-v4-pro");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("judge connection test sends the configured model and bearer key", async () => {
  let seen = { authorization: "", model: "", path: "" };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
    seen = { authorization: request.headers.authorization || "", model: body.model, path: request.url || "" };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not open a port");
    await testJudgeModel({ id: "test", project_id: 1, name: "test", base_url: `http://127.0.0.1:${address.port}/v1`,
      model_id: "judge-test", api_key: "private-token", is_default: true, created_at: "", updated_at: "" });
    assert.deepEqual(seen, { authorization: "Bearer private-token", model: "judge-test", path: "/v1/chat/completions" });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
