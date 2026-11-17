import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";

test("incremental Excel saves each row immediately, isolates source files and supports all output formats", async () => {
  const directory = await mkdtemp(join(tmpdir(), "incremental-excel-"));
  process.env.AGENT_EVAL_DB = join(directory, "test.db");
  process.env.AGENT_EVAL_ARTIFACT_DIR = join(directory, "artifacts");
  const db = await import("./db.js");
  const { IncrementalWorkbook, normaliseSaveOptions } = await import("./incremental-workbook.js");
  try {
    db.initDb();
    const now = db.nowIso();
    const project = db.execute("INSERT INTO projects(name,project_key,created_at,updated_at) VALUES(?,?,?,?)", "Test", "SAVE", now, now);
    const ids: number[] = [];
    for (const name of ["one", "two"]) {
      const path = join(directory, `${name}.xlsx`);
      const source = new ExcelJS.Workbook();
      const sheet = source.addWorksheet("测试集");
      sheet.addRow(["题号", "问题", "标准答案"]);
      for (let row = 2; row <= 3; row++) sheet.addRow([String(row), `${name}-${row}`, "保留"]);
      await source.xlsx.writeFile(path);
      for (let row = 2; row <= 3; row++) ids.push(db.execute(`INSERT INTO cases(project_id,code,category,title,query,source_sheet_name,source_row_number,source_workbook_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        project, `${name}-${row}`, "test", "test", `${name}-${row}`, "测试集", row, path, now, now));
    }
    const image = join(directory, "shot.png");
    await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    for (const format of ["text", "screenshot", "both"] as const) {
      const batch = db.execute("INSERT INTO evaluation_batches(project_id,adapter,status,total,started_at) VALUES(?,?,?,?,?)", project, "browser", "running", 4, now);
      const writer = new IncrementalWorkbook(batch, `job-${batch}`, normaliseSaveOptions({ directory: join(directory, format), column: "J", format }));
      await writer.prepare(project, ids);
      assert.equal(writer.files.length, 2);
      const result = (answer: string) => ({ status: "collected", messages: [{ role: "assistant", content: answer }], screenshot_paths: [image, image] });
      await writer.write(ids[0], result("第一条完整回答"));
      const restored = new IncrementalWorkbook(batch, `job-${batch}`, normaliseSaveOptions({ directory: join(directory, format), column: "J", format }));
      await restored.restore(writer.checkpoint());
      assert.deepEqual(restored.files, writer.files);
      assert.equal(restored.isSaved(ids[0]), true);
      await restored.write(ids[0], result("重复写入不应覆盖旧回答或新增图片"));
      const first = new ExcelJS.Workbook(); await first.xlsx.readFile(writer.files[0].path);
      assert.equal(first.worksheets[0].getCell("C2").text, "保留");
      assert.equal(first.worksheets[0].getCell("J3").text, "");
      assert.equal(first.worksheets[0].getCell("J2").text, format === "screenshot" ? "" : "第一条完整回答");
      assert.equal(first.worksheets[0].getImages().length, format === "text" ? 0 : 2);
      await restored.write(ids[1], result("第二条"));
      await restored.write(ids[2], result("另一测试集"));
      const saved = new ExcelJS.Workbook(); await saved.xlsx.readFile(writer.files[0].path);
      const other = new ExcelJS.Workbook(); await other.xlsx.readFile(writer.files[1].path);
      if (format !== "screenshot") {
        assert.equal(saved.worksheets[0].getCell("J2").text, "第一条完整回答");
        assert.equal(saved.worksheets[0].getCell("J3").text, "第二条");
        assert.equal(other.worksheets[0].getCell("J2").text, "另一测试集");
      }
      const original = new ExcelJS.Workbook(); await original.xlsx.readFile(join(directory, "one.xlsx"));
      assert.equal(original.worksheets[0].getCell("J2").value, null);
      assert.equal(original.worksheets[0].getImages().length, 0);
      const persisted = db.row<{ result_files_json: string }>("SELECT result_files_json FROM evaluation_batches WHERE id=?", batch)!;
      assert.equal(JSON.parse(persisted.result_files_json).length, 2);
      db.execute("UPDATE evaluation_batches SET selected_case_ids=? WHERE id=?", JSON.stringify(ids), batch);
      for (const [index, answer] of ["第一条完整回答", "第二条", "另一测试集", "已采集但未保存"].entries()) {
        const run = db.execute("INSERT INTO runs(project_id,case_id,adapter,status,batch_id,started_at) VALUES(?,?,?,?,?,?)", project, ids[index], "browser", "collected", batch, now);
        db.execute("INSERT INTO messages(run_id,turn_index,role,content,created_at) VALUES(?,?,?,?,?)", run, 1, "assistant", answer, now);
      }
      const { recoverLegacyBatch } = await import("./legacy-browser-resume.js");
      const legacy = await recoverLegacyBatch(batch);
      assert.equal(legacy.completed, 3);
      assert.equal(legacy.options.format, format);
      assert.deepEqual(legacy.files, writer.files);
    }
    assert.throws(() => normaliseSaveOptions({ column: "XFE" }));
    assert.throws(() => normaliseSaveOptions({ directory: "relative/path" }));
    const occupied = new IncrementalWorkbook(999, "occupied", normaliseSaveOptions({ directory, column: "C" }));
    await assert.rejects(occupied.prepare(project, ids), /已有内容/);
  } finally { db.database.close(); await rm(directory, { recursive: true, force: true }); }
});
