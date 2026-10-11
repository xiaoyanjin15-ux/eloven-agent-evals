import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

import { artifactFilePath } from "./browser-runner.js";
import * as db from "./db.js";
import type { Project } from "./domain.js";
import { normaliseNamespacedWorkbook } from "./workbook-normalizer.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ARTIFACT_DIR = process.env.AGENT_EVAL_ARTIFACT_DIR || join(ROOT, "artifacts");

interface EvidenceRow {
  source_sheet_name: string;
  source_case_code: string;
  source_row_number: number;
  screenshot_paths: string;
}

export async function buildEvidenceWorkbook(batchId: number): Promise<string> {
  return buildEvidenceWorkbookFromBatches(batchId, [batchId]);
}

export async function buildCombinedEvidenceWorkbook(targetBatchId: number, sourceBatchIds: number[]): Promise<string> {
  const ids = [...new Set([targetBatchId, ...sourceBatchIds].map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  return buildEvidenceWorkbookFromBatches(targetBatchId, ids);
}

async function buildEvidenceWorkbookFromBatches(batchId: number, sourceBatchIds: number[]): Promise<string> {
  const batch = db.row<{ project_id: number }>("SELECT project_id FROM evaluation_batches WHERE id=?", batchId);
  if (!batch) throw new Error("评测批次不存在");
  const placeholders = sourceBatchIds.map(() => "?").join(",");
  const sourceBatches = db.rows<{ id: number; project_id: number }>(
    `SELECT id,project_id FROM evaluation_batches WHERE id IN (${placeholders})`, ...sourceBatchIds);
  if (sourceBatches.length !== sourceBatchIds.length || sourceBatches.some((item) => item.project_id !== batch.project_id)) {
    throw new Error("合并的评测批次必须完整存在且属于同一项目");
  }
  const project = db.row<Project>("SELECT * FROM projects WHERE id=?", batch.project_id);
  if (!project?.source_workbook_path || !existsSync(project.source_workbook_path)) {
    throw new Error("当前项目没有可回填的原始 Excel；请先重新导入测试集");
  }
  const rows = db.rows<EvidenceRow>(`SELECT c.source_sheet_name,c.source_case_code,c.source_row_number,r.screenshot_paths
    FROM runs r JOIN cases c ON c.id=r.case_id WHERE r.batch_id IN (${placeholders})
    AND r.status IN ('collected','completed') ORDER BY r.batch_id,r.id`, ...sourceBatchIds);
  if (!rows.length) throw new Error("本批次还没有可写入 Excel 的截图");

  const safeProject = safeSegment(project.project_key || `project-${project.id}`);
  // Keep one cumulative evidence workbook per project. Evaluation batches are
  // execution history, not separate spreadsheet destinations.
  const outputDir = join(ARTIFACT_DIR, safeProject);
  mkdirSync(outputDir, { recursive: true });
  const sourceName = basename(project.source_workbook_name || project.source_workbook_path, extname(project.source_workbook_name || project.source_workbook_path));
  const output = join(outputDir, `${safeSegment(sourceName)}-采集结果.xlsx`);

  // The imported workbook is the template and remains untouched. Work only on a byte-for-byte copy.
  copyFileSync(project.source_workbook_path, output);
  const workbook = new ExcelJS.Workbook();
  const readableBytes = await normaliseNamespacedWorkbook(readFileSync(output));
  await workbook.xlsx.load(readableBytes as unknown as ExcelJS.Buffer);
  const nextImageIndex = new Map<string, number>();
  let insertedImages = 0;
  for (const item of rows) {
    const sheet = workbook.getWorksheet(item.source_sheet_name);
    if (!sheet || !item.source_row_number) continue;
    const headers = locateHeaders(sheet);
    if (!headers.code) continue;
    const actualCode = String(sheet.getRow(item.source_row_number).getCell(headers.code).text || "").trim();
    if (actualCode && actualCode !== item.source_case_code) continue;
    const screenshots = parsePaths(item.screenshot_paths).map(localArtifact).filter((path): path is string => Boolean(path));
    const placementKey = `${item.source_sheet_name}\u0000${item.source_row_number}`;
    const startingIndex = nextImageIndex.get(placementKey) || 0;
    screenshots.forEach((path, localIndex) => {
      const index = startingIndex + localIndex;
      const column = ensureResultColumn(sheet, headers.headerRow, headers.result, index);
      const imageId = workbook.addImage({ filename: path, extension: imageExtension(path) });
      const placement = cellFillingImagePlacement(item.source_row_number, column);
      sheet.addImage(imageId, {
        tl: placement.tl as ExcelJS.Anchor,
        br: placement.br as ExcelJS.Anchor,
        editAs: "twoCell",
      });
      insertedImages += 1;
    });
    nextImageIndex.set(placementKey, startingIndex + screenshots.length);
  }
  if (!insertedImages) throw new Error("截图存在，但没有匹配到 Excel 中的分表和用例ID；未生成空结果表");
  await workbook.xlsx.writeFile(output);
  const url = `/artifacts/${encodeURIComponent(safeProject)}/${encodeURIComponent(basename(output))}`;
  db.execute(`UPDATE evaluation_batches SET result_workbook_path=? WHERE id IN (${placeholders})`, url, ...sourceBatchIds);
  return url;
}

function locateHeaders(sheet: ExcelJS.Worksheet): { headerRow: number; code: number; result: number } {
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 30); rowNumber += 1) {
    let code = 0;
    let result = 0;
    sheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      const value = normalise(cell.text);
      if (["用例ID", "用例编号", "编号", "caseid", "casecode"].some((name) => normalise(name) === value)) code = columnNumber;
      if (value === normalise("测试结果")) result = columnNumber;
    });
    if (code) return { headerRow: rowNumber, code, result };
  }
  return { headerRow: 1, code: 0, result: 0 };
}

function ensureResultColumn(sheet: ExcelJS.Worksheet, headerRow: number, firstResult: number, index: number): number {
  const base = firstResult || Math.max(1, sheet.columnCount + 1);
  const column = base + index;
  const header = sheet.getRow(headerRow).getCell(column);
  if (!header.value) {
    header.value = index ? `测试结果-${index + 1}` : "测试结果";
    if (firstResult && index) {
      const sourceHeader = sheet.getRow(headerRow).getCell(firstResult);
      header.style = { ...sourceHeader.style };
      sheet.getColumn(column).width = sheet.getColumn(firstResult).width;
    }
  }
  return column;
}

function cellFillingImagePlacement(row: number, column: number): {
  tl: { col: number; row: number };
  br: { col: number; row: number };
} {
  // Use exact cell boundaries. Fractional offsets inside a custom-width column are
  // serialized by ExcelJS as tiny EMU values and appear as a narrow strip in WPS.
  return { tl: { col: column - 1, row: row - 1 }, br: { col: column, row } };
}

function parsePaths(value: string): string[] {
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed.map(String) : []; }
  catch { return []; }
}

function localArtifact(url: string): string | undefined {
  return url.startsWith("/artifacts/") ? artifactFilePath(url.slice("/artifacts/".length)) : (existsSync(url) ? url : undefined);
}

function imageExtension(path: string): "png" | "jpeg" | "gif" {
  const extension = extname(path).toLowerCase();
  return extension === ".jpg" || extension === ".jpeg" ? "jpeg" : extension === ".gif" ? "gif" : "png";
}

function normalise(value: string): string { return String(value || "").toLowerCase().replace(/[\s_\-：:（）()]/g, ""); }
function safeSegment(value: string): string { return String(value || "unknown").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "unknown"; }
