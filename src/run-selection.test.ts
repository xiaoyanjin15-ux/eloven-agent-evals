import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

test("browser run selection combines chosen datasets, excludes pending cases and deduplicates shared cases", async () => {
  const source = readFileSync(new URL("../../static/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("async function populateOfficePlan("), source.indexOf("function selectedRunCaseIds("));
  const shared = { id: 1, approved: 1, query: "Shared" };
  const state: any = { project: { id: 1 }, runDatasets: [
    { id: 10, name: "A", cases: [shared, { id: 2, approved: 0 }] },
    { id: 20, name: "B", cases: [shared, { id: 3, approved: 1 }] },
    { id: 30, name: "Unselected", cases: [{ id: 4, approved: 1 }] },
  ] };
  let selected = [10, 20];
  const nodes: Record<string, any> = {};
  const populate = runInNewContext(`${code}; populateOfficePlan`, {
    state,
    $: (selector: string) => nodes[selector] ||= {},
    $$: (selector: string) => selector === "#run-datasets input:checked" ? selected.map(value => ({ value })) : [],
    api: async () => [{ office_key: "office", generated_name: "Office", cases: [shared, { id: 2 }, { id: 3 }, { id: 4 }] }],
    escapeHtml: (value: unknown) => String(value ?? ""), updateOfficeSelection: () => {},
  });
  await populate("manual");
  assert.equal(JSON.stringify(state.officePlans.map((plan: any) => plan.cases.map((item: any) => item.id))), "[[1],[3]]");
  await populate("auto");
  assert.equal(JSON.stringify(state.officePlans[0].cases.map((item: any) => item.id)), "[1,3]");
  selected = [20];
  await populate("manual");
  assert.equal(state.officePlans[0].generated_name, "B");
  selected = [];
  await populate("manual");
  assert.equal(state.officePlans.length, 0);
});
