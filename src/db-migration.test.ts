import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("legacy traces receive stable groups without changing saved evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-group-migration-"));
  const previous = process.env.AGENT_EVAL_DB;
  process.env.AGENT_EVAL_DB = join(directory, "test.db");
  const db = await import("./db.js");
  try {
    db.initDb();
    // Reproduce the public schema before trace groups existed.
    db.database.exec("ALTER TABLE agent_evaluations DROP COLUMN group_id; DROP TABLE agent_evaluation_groups;");
    const projectId = db.execute("INSERT INTO projects(name,created_at,updated_at) VALUES('Migration fixture','now','now')");
    db.execute(`INSERT INTO agent_evaluations(project_id,source,trace_id,trace_json,expectations_json,result_json,created_at,updated_at)
      VALUES(?,'json','fixture','{}','{"expected_answer":"preserved"}','{"status":"review"}','now','now')`, projectId);
    db.initDb();
    const first = db.row<Record<string, unknown>>("SELECT * FROM agent_evaluations");
    assert.ok(first?.group_id);
    assert.equal(first.expectations_json, '{"expected_answer":"preserved"}');
    assert.equal(first.result_json, '{"status":"review"}');
    assert.equal(db.row<{ group_type: string }>("SELECT group_type FROM agent_evaluation_groups")?.group_type, "uncategorized");
    db.initDb();
    assert.deepEqual(db.row("SELECT * FROM agent_evaluations"), first);
    assert.equal(db.rows("SELECT id FROM agent_evaluation_groups").length, 1);
  } finally {
    db.database.close();
    if (previous === undefined) delete process.env.AGENT_EVAL_DB;
    else process.env.AGENT_EVAL_DB = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
