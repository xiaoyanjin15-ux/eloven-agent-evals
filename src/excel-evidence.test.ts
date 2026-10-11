import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";

test("evidence workbook writes multiple screenshots to the matching sheet and case code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-evidence-"));
  process.env.AGENT_EVAL_DB = join(directory, "test.db");
  process.env.AGENT_EVAL_ARTIFACT_DIR = join(directory, "artifacts");
  const db = await import("./db.js");
  const { buildEvidenceWorkbook } = await import("./excel-evidence.js");
  try {
    db.initDb();
    const source = join(directory, "source.xlsx");
    const workbook = new ExcelJS.Workbook();
    for (const name of ["场景甲", "场景乙"]) {
      const sheet = workbook.addWorksheet(name);
      sheet.addRow(["用例ID", "初始问题", "预期回答要点", "测试结果"]);
      sheet.addRow(["F-01", `${name}的问题`, `${name}的要求`, ""]);
      sheet.getColumn(4).width = 31;
      sheet.getRow(2).height = 120;
      sheet.getCell("A2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F3F0" } };
    }
    await workbook.xlsx.writeFile(source);
    const now = new Date().toISOString();
    const projectId = db.execute(`INSERT INTO projects(project_key,name,source_workbook_path,source_workbook_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`, "TEST", "证据回填测试", source, "source.xlsx", now, now);
    const caseId = db.execute(`INSERT INTO cases(project_id,code,category,title,query,expected_answer,approved,execution_type,
      source_sheet_name,source_case_code,source_row_number,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      projectId, "TEST-F-01-S2", "场景乙", "问题", "场景乙的问题", "场景乙的要求", 1, "browser", "场景乙", "F-01", 2, now, now);
    const batchId = db.execute(`INSERT INTO evaluation_batches(project_id,adapter,status,total,workflow_mode,evaluation_status,started_at)
      VALUES(?,?,?,?,?,?,?)`, projectId, "browser", "completed", 1, "collect_first", "pending", now);
    const imageDir = join(directory, "artifacts", "TEST", "case");
    await mkdir(imageDir, { recursive: true });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const imageOne = join(imageDir, "one.png"), imageTwo = join(imageDir, "two.png");
    await writeFile(imageOne, png); await writeFile(imageTwo, png);
    const urls = ["/artifacts/TEST/case/one.png", "/artifacts/TEST/case/two.png"];
    db.execute(`INSERT INTO runs(project_id,case_id,adapter,status,screenshot_path,screenshot_paths,started_at,finished_at,batch_id)
      VALUES(?,?,?,?,?,?,?,?,?)`, projectId, caseId, "browser", "collected", urls[0], JSON.stringify(urls), now, now, batchId);

    const resultUrl = await buildEvidenceWorkbook(batchId);
    assert.match(decodeURIComponent(resultUrl), /采集结果\.xlsx$/);
    assert.doesNotMatch(resultUrl, /\/batches\//);
    const output = join(directory, "artifacts", "TEST", decodeURIComponent(resultUrl.split("/").at(-1)!));
    const result = new ExcelJS.Workbook();
    await result.xlsx.readFile(output);
    const target = result.worksheets[1];
    assert.equal(target.getColumn(4).width, 31);
    assert.equal(target.getRow(2).height, 120);
    assert.equal(target.getCell("A2").fill.type, "pattern");
    assert.equal(target.getRow(2).getCell(4).text, "");
    assert.ok(target.getImages().every((image) => image.range.br), "screenshots should use a compatible two-cell anchor");
    assert.ok(target.getImages().every((image) => image.range.br!.col - image.range.tl.col > 0.9), "screenshots should fill most of the result cell width");
    assert.ok(target.getImages().every((image) => image.range.br!.row - image.range.tl.row > 0.9), "screenshots should fill most of the result cell height");
    assert.equal(result.getWorksheet("场景甲")?.getImages().length, 0);
    assert.equal(result.getWorksheet("场景乙")?.getImages().length, 2);
    assert.equal(result.getWorksheet("场景乙")?.getRow(1).getCell(5).text, "测试结果-2");
  } finally {
    db.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
