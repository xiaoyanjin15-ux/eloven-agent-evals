import ExcelJS from "exceljs";
import { basename, extname } from "node:path";
import * as db from "./db.js";
import { getRun, listCases } from "./services.js";
import type { SaveOptions, SavedWorkbook, WorkbookCheckpoint } from "./incremental-workbook.js";

// Older batches did not record their output column. Recover only unambiguous positions.
export async function recoverLegacyBatch(batchId: number) {
  const batch = db.row<any>("SELECT * FROM evaluation_batches WHERE id=?", batchId);
  if (!batch || batch.adapter !== "browser") throw new Error("找不到浏览器批次");
  const files: SavedWorkbook[] = JSON.parse(batch.result_files_json || "[]");
  if (!files.length) throw new Error("旧批次没有原结果表，无法原表续跑");
  const ids: number[] = JSON.parse(batch.selected_case_ids);
  const all = listCases(batch.project_id);
  const cases = ids.map(id => { const item = all.find(item => item.id === id); if (!item) throw new Error("原用例已删除，无法续跑"); return item; });
  const project = db.row<any>("SELECT * FROM projects WHERE id=?", batch.project_id);
  const workbook: WorkbookCheckpoint = { destinations: [], cases: [] };
  const loaded = new Map<string, ExcelJS.Workbook>();
  let format: SaveOptions["format"] | undefined;
  for (const item of cases) {
    const source = db.row<any>("SELECT id,query,source_sheet_name,source_row_number,source_workbook_path FROM cases WHERE id=?", item.id);
    const key = source.source_workbook_path || project.source_workbook_path;
    let dest = workbook.destinations.find(entry => entry.key === key);
    if (!dest) {
      const matches = files.filter(file => file.name.startsWith(`${basename(key, extname(key))}-结果-${batchId}-`));
      if (matches.length !== 1) throw new Error("无法唯一确定原结果文件，已停止，未创建新表");
      const book = new ExcelJS.Workbook(); await book.xlsx.readFile(matches[0].path);
      loaded.set(key, book); dest = { key, file: matches[0], columns: [] }; workbook.destinations.push(dest);
    }
    const sheet = loaded.get(key)!.getWorksheet(source.source_sheet_name);
    if (!sheet || !Object.values(sheet.getRow(source.source_row_number).values).some(value => String(value).trim() === source.query.trim())) throw new Error("原结果表与用例行不匹配");
    if (!dest.columns.some(([name]) => name === sheet.name)) {
      const columns = new Set<number>();
      for (const row of sheet.getRows(1, Math.min(30, source.source_row_number - 1)) || []) row.eachCell((cell, col) => { if (cell.text === "实际回答" || cell.text === "回答截图") columns.add(col); });
      // Explicit columns may have an existing heading: match saved answers instead.
      for (const candidate of cases.filter(c => c.source_sheet_name === sheet.name)) {
        const run = db.row<{ id: number }>("SELECT id FROM runs WHERE batch_id=? AND case_id=? ORDER BY id DESC LIMIT 1", batchId, candidate.id);
        if (!run) continue;
        const result = getRun(run.id); const messages = result.messages as Array<{role:string;content:string}>;
        const answer = [...messages].reverse().find(m => m.role === "assistant")?.content;
        if (answer) sheet.getRow(candidate.source_row_number).eachCell((cell, col) => { if (cell.text === answer) columns.add(col); });
      }
      const sorted = [...columns].sort((a,b) => a-b);
      if (!sorted.length || sorted.length > 2 || (sorted.length === 2 && sorted[1] !== sorted[0] + 1)) throw new Error("无法可靠识别旧结果表回填列，未修改原表");
      const hasImages = sheet.getImages().some(image => Math.floor(image.range.tl.col) + 1 === sorted[sorted.length - 1]);
      const detected = sorted.length === 2 ? "both" : hasImages ? "screenshot" : "text";
      if (format && format !== detected) throw new Error("旧结果表保存格式不一致");
      format = detected; dest.columns.push([sheet.name, sorted[0]]);
    }
    workbook.cases.push({ source, key });
  }
  let completed = 0;
  for (const entry of workbook.cases) {
    const sheet = loaded.get(entry.key)!.getWorksheet(entry.source.source_sheet_name)!;
    const column = workbook.destinations.find(d => d.key === entry.key)!.columns.find(([name]) => name === sheet.name)![1];
    const text = sheet.getRow(entry.source.source_row_number).getCell(column).text;
    const image = sheet.getImages().some(image => Math.floor(image.range.tl.row) + 1 === entry.source.source_row_number && Math.floor(image.range.tl.col) + 1 === column + (format === "both" ? 1 : 0));
    const run = db.row<{id:number}>("SELECT id FROM runs WHERE batch_id=? AND case_id=? ORDER BY id DESC LIMIT 1", batchId, entry.source.id);
    if (!run) break;
    const result = getRun(run.id);
    const answer = [...result.messages as Array<{role:string;content:string}>].reverse().find(m => m.role === "assistant")?.content || "";
    const matches = result.status === "failed" ? text === `执行失败：${result.summary || "未获得回答"}` : format === "screenshot" ? image : !!answer && text === answer && (format !== "both" || image);
    if (!matches) break;
    completed++;
  }
  return { batch, cases, workbook, completed, files, options: { directory: "", column: "", format: format! } };
}
