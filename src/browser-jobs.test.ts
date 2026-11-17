import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function fixture(count: number, failSaveAt = 0) {
  const calls: number[] = [], saves: number[] = [];
  const conversationOptions: unknown[] = [];
  const cases = Array.from({ length: count }, (_, index) => ({ id: index + 1, approved: 1, code: `Q${index + 1}`, source_row_number: index + 2, conversation_round: 1 }));
  const source = readFileSync(new URL("../../src/browser-jobs.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  let serial = 0;
  const stored = new Map<string | number, any>();
  let saveFailure = failSaveAt;
  const dependencies: Record<string, unknown> = {
    "node:crypto": { randomUUID: () => `job-${++serial}` },
    "./browser-runner.js": {},
    "./conversation-plan.js": { planConversationTurn: () => ({ newConversation: true, nextGroup: "" }) },
    "./db.js": { row: (sql: string) => sql.includes("FROM runs") ? undefined : ({ id: 1 }), execute() {} },
    "./browser-checkpoints.js": { saveCheckpoint: (batch: number, id: string, value: unknown) => { const copy = JSON.parse(JSON.stringify(value)); stored.set(batch, copy); stored.set(id, copy); }, readCheckpoint: (id: string | number) => stored.get(id) },
    "./legacy-browser-resume.js": {},
    "./incremental-workbook.js": { normaliseSaveOptions: () => ({}), IncrementalWorkbook: class {
      files = [{ path: "result.xlsx", url: "/result", name: "result.xlsx" }];
      async prepare() {}
      checkpoint() { return {}; }
      async restore() {}
      async write(id: number) { if (id === saveFailure) throw new Error("save failed"); saves.push(id); }
    } },
    "./services.js": { createEvaluationBatch: () => 1, finishEvaluationBatch() {}, listCases: () => cases, listOfficePlans: () => [],
      runCases: async (_project: number, ids: number[], ...rest: unknown[]) => { calls.push(ids[0]); conversationOptions.push(rest[4]); return [{ status: "collected", messages: [{ role: "assistant", content: `answer-${ids[0]}` }] }]; } },
  };
  runInNewContext(compiled, { exports, require: (name: string) => { if (!(name in dependencies)) throw new Error(name); return dependencies[name]; } });
  return { api: exports, calls, saves, conversationOptions, unlock: () => { saveFailure = 0; }, reload: () => { const next: any = {}; runInNewContext(compiled, { exports: next, require: (name: string) => dependencies[name] }); return next; } };
}
async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }

test("trial pauses only after two saved rows and requires explicit confirmation before the third", async () => {
  const { api, calls, saves, conversationOptions } = fixture(4);
  const job = api.startBrowserJob(1, [], "collect_first", "manual");
  await settle();
  assert.deepEqual(calls, [1, 2]); assert.deepEqual(saves, [1, 2]);
  assert.equal(api.getBrowserJob(job.id).status, "paused");
  assert.throws(() => api.resumeBrowserJob(job.id), /确认前两条/);
  await settle(); assert.deepEqual(calls, [1, 2]);
  api.resumeBrowserJob(job.id, true); await settle();
  assert.deepEqual(calls, [1, 2, 3, 4]); assert.deepEqual(saves, calls);
  assert.equal(JSON.stringify(conversationOptions), JSON.stringify(Array.from({ length: 4 }, () => ({ newConversation: true }))));
  assert.equal(api.getBrowserJob(job.id).status, "completed");
});

test("resume after file unlock and server restart saves pending answer without repeating questions", async () => {
  const fixtureState = fixture(4, 2);
  const job = fixtureState.api.startBrowserJob(1, [], "collect_first", "manual"); await settle();
  assert.equal(fixtureState.api.getBrowserJob(job.id).completed, 1);
  fixtureState.unlock();
  const api = fixtureState.reload();
  await api.resumeBrowserBatch(1); await settle();
  assert.deepEqual(fixtureState.calls, [1, 2]);
  assert.deepEqual(fixtureState.saves, [1, 2]);
  assert.equal(api.getBrowserJob(job.id).awaiting_trial_confirmation, true);
  api.resumeBrowserJob(job.id, true); await settle();
  assert.deepEqual(fixtureState.calls, [1, 2, 3, 4]);
  assert.deepEqual(fixtureState.saves, [1, 2, 3, 4]);
  assert.equal(api.getBrowserJob(job.id).batch_id, 1);
});
test("small selections finish directly, stopping retains trial rows, save failure prevents further questions", async () => {
  for (const count of [1, 2]) {
    const { api } = fixture(count); const job = api.startBrowserJob(1, [], "collect_first", "manual"); await settle();
    assert.equal(api.getBrowserJob(job.id).status, "completed");
    assert.equal(api.getBrowserJob(job.id).awaiting_trial_confirmation, false);
  }
  const stopped = fixture(4); const job = stopped.api.startBrowserJob(1, [], "collect_first", "manual"); await settle();
  stopped.api.stopBrowserJob(job.id); await settle();
  assert.deepEqual(stopped.calls, [1, 2]); assert.deepEqual(stopped.saves, [1, 2]);
  assert.equal(stopped.api.getBrowserJob(job.id).status, "stopped");
  const failed = fixture(4, 2); const failure = failed.api.startBrowserJob(1, [], "collect_first", "manual"); await settle();
  assert.deepEqual(failed.calls, [1, 2]); assert.deepEqual(failed.saves, [1]);
  assert.equal(failed.api.getBrowserJob(failure.id).status, "failed");
});
