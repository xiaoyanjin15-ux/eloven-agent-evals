import assert from "node:assert/strict";
import test from "node:test";

import { runHarness } from "./harness.js";
import type { ProjectContext } from "./types.js";

const project: ProjectContext = {
  id: 1, name: "LUI", agent_type: "dialogue", background: "简短背景", capabilities: "查询文件",
  boundaries: "", scoring_standard: "",
};

test("pi harness uses tool loop to submit clarification questions", async () => {
  const result = await runHarness({ action: "clarify", project, mode: "mock" });
  assert.equal(result.ok, true);
  assert.ok((result.questions?.length || 0) >= 1);
  assert.equal(result.trace?.runtime, "pi-agent-core");
  assert.ok(result.trace?.tool_calls.some((item) => item.name === "submit_questions" && item.status === "completed"));
});

test("pi harness submits structured candidate cases", async () => {
  const result = await runHarness({ action: "generate_cases", project, mode: "mock" });
  assert.equal(result.cases?.length, 4);
  assert.equal(result.cases?.[0].priority, "P0");
});

