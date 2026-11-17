import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import * as db from "./db.js";
import { artifactFilePath } from "./browser-runner.js";
import { normaliseNamespacedWorkbook } from "./workbook-normalizer.js";

export interface SaveOptions { directory: string; column: string; format: "text" | "screenshot" | "both" }
export interface SavedWorkbook { path: string; name: string; url: string }
interface SourceCase { id: number; query: string; source_sheet_name: string; source_row_number: number; source_workbook_path: string }
interface Destination { workbook: ExcelJS.Workbook; file: SavedWorkbook; columns: Map<string, number> }
export interface WorkbookCheckpoint { destinations: Array<{ key: string; file: SavedWorkbook; columns: Array<[string, number]> }>; cases: Array<{ source: SourceCase; key: string }> }

export function normaliseSaveOptions(raw: Partial<SaveOptions> = {}): SaveOptions {
  const directory = String(raw.directory || "").trim();
  const column = String(raw.column || "").trim().toUpperCase();
  const format = raw.format || "both";
  if (directory && !isAbsolute(directory)) throw new Error("结果保存目录必须是本机绝对路径");
  if (column && (!/^[A-Z]{1,3}$/.test(column) || columnNumber(column) > 16384)) throw new Error("回填列请填写 A 至 XFD 的列字母，或留空自动追加");
  if (!["text", "screenshot", "both"].includes(format)) throw new Error("请选择文字、截图或两者都保存");
  return { directory, column, format };
}

export class IncrementalWorkbook {
  readonly files: SavedWorkbook[] = [];
  private destinations = new Map<string, Destination>();
  private cases = new Map<number, { source: SourceCase; destination: Destination }>();
  constructor(private batchId: number, private jobId: string, private options: SaveOptions) {}

  checkpoint(): WorkbookCheckpoint {
    return { destinations: [...this.destinations].map(([key, value]) => ({ key, file: value.file, columns: [...value.columns] })),
      cases: [...this.cases.values()].map(({ source, destination }) => ({ source, key: [...this.destinations].find(([, value]) => value === destination)![0] })) };
  }

  async restore(checkpoint: WorkbookCheckpoint): Promise<void> {
    for (const entry of checkpoint.destinations) {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(entry.file.path);
      this.destinations.set(entry.key, { workbook, file: entry.file, columns: new Map(entry.columns) });
      this.files.push(entry.file);
    }
    for (const entry of checkpoint.cases) this.cases.set(entry.source.id, { source: entry.source, destination: this.destinations.get(entry.key)! });
  }

  isSaved(caseId: number): boolean {
    const entry = this.cases.get(caseId);
    const ledger = entry?.destination.workbook.getWorksheet("__agent_eval_saved");
    return !!ledger?.getColumn(1).values.some(value => Number(value) === caseId);
  }

  async prepare(projectId: number, caseIds: number[]): Promise<void> {
    const project = db.row<{ source_workbook_path: string }>("SELECT source_workbook_path FROM projects WHERE id=?", projectId);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const directory = this.options.directory || join(process.env.AGENT_EVAL_ARTIFACT_DIR || join(root, "artifacts"), `batch-${this.batchId}`);
    mkdirSync(directory, { recursive: true });
    for (const id of caseIds) {
      const source = db.row<SourceCase>("SELECT id,query,source_sheet_name,source_row_number,source_workbook_path FROM cases WHERE id=? AND project_id=?", id, projectId);
      if (!source) throw new Error("用例不存在");
      const path = source.source_workbook_path || project?.source_workbook_path || "";
      if (!path || !existsSync(path)) throw new Error("找不到用例的原始 Excel，请重新导入测试集后再执行");
      let destination = this.destinations.get(path);
      if (!destination) {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(await normaliseNamespacedWorkbook(readFileSync(path)) as unknown as ExcelJS.Buffer);
        const name = `${basename(path, extname(path))}-结果-${this.batchId}-${this.files.length + 1}.xlsx`;
        const output = resolve(directory, name);
        if (output === resolve(path) || existsSync(output)) throw new Error(`结果文件已存在，请更换保存目录：${output}`);
        const file = { path: output, name, url: `/api/batches/${this.batchId}/files/${this.files.length}` };
        destination = { workbook, file, columns: new Map() };
        this.destinations.set(path, destination); this.files.push(file);
      }
      const sheet = destination.workbook.getWorksheet(source.source_sheet_name);
      if (!sheet || source.source_row_number < 1 || !sheet.getRow(source.source_row_number).values
        || !Object.values(sheet.getRow(source.source_row_number).values).some(value => cellText(value) === source.query.trim())) {
        throw new Error(`用例 ${id} 与原始 Excel 行不匹配，请重新导入对应测试集（旧数据可能缺少来源记录）`);
      }
      if (!destination.columns.has(sheet.name)) destination.columns.set(sheet.name, this.options.column ? columnNumber(this.options.column) : sheet.columnCount + 1);
      const column = destination.columns.get(sheet.name)!;
      const count = this.options.format === "both" ? 2 : 1;
      for (let offset = 0; offset < count; offset++) {
        const existing = sheet.getRow(source.source_row_number).getCell(column + offset).value;
        if (column + offset > 16384 || (existing !== null && existing !== "")) {
          throw new Error(`回填位置 ${sheet.name}!${this.options.column || column} 已有内容或超出 Excel 列范围，请选择空白列`);
        }
      }
      const headerRow = sheet.getRows(1, Math.min(30, source.source_row_number - 1))?.find(row =>
        Object.values(row.values).some(value => ["问题", "初始问题", "测试问题", "用户输入"].includes(cellText(value))));
      if (headerRow) {
        if (!headerRow.getCell(column).value) headerRow.getCell(column).value = this.options.format === "screenshot" ? "回答截图" : "实际回答";
        if (count === 2 && !headerRow.getCell(column + 1).value) headerRow.getCell(column + 1).value = "回答截图";
      }
      this.cases.set(id, { source, destination });
    }
    // Verify output permissions before sending any question. Originals remain untouched.
    for (const destination of this.destinations.values()) await this.save(destination);
    db.execute("UPDATE evaluation_batches SET result_files_json=?,result_workbook_path=? WHERE id=?", JSON.stringify(this.files), this.files[0]?.url || "", this.batchId);
  }

  async write(caseId: number, result: Record<string, unknown>): Promise<void> {
    if (this.isSaved(caseId)) return;
    const entry = this.cases.get(caseId);
    if (!entry) throw new Error("用例未配置 Excel 保存位置");
    const { source, destination } = entry;
    const sheet = destination.workbook.getWorksheet(source.source_sheet_name)!;
    const row = sheet.getRow(source.source_row_number);
    const column = destination.columns.get(sheet.name)!;
    const messages = Array.isArray(result.messages) ? result.messages as Array<{ role: string; content: string }> : [];
    const answer = [...messages].reverse().find(message => message.role === "assistant")?.content || "";
    const failed = result.status === "failed";
    if (!failed && !answer.trim()) throw new Error("未采集到回答正文，已停止，未发送下一条问题");
    const text = failed ? `执行失败：${result.summary || "未获得回答"}` : answer;
    if (this.options.format !== "screenshot" || failed) {
      // Excel limits cell text to 32767 characters; keep the full answer alongside it.
      if (text.length > 32767) {
        const fullPath = `${destination.file.path}.case-${caseId}.txt`;
        writeFileSync(fullPath, text, "utf8");
        row.getCell(column).value = `${text.slice(0, 32000)}\n完整回答另存：${fullPath}`;
      } else row.getCell(column).value = text;
      row.getCell(column).alignment = { wrapText: true, vertical: "top" };
      sheet.getColumn(column).width = Math.max(sheet.getColumn(column).width || 0, 65);
      row.height = Math.max(row.height || 0, 120);
    }
    if (this.options.format !== "text" && !failed) {
      const images = Array.isArray(result.screenshot_paths) ? result.screenshot_paths.map(String) : [];
      if (!images.length) throw new Error("该用例没有截图，回答已保存在数据库，未继续下一条");
      const imageColumn = column + (this.options.format === "both" ? 1 : 0);
      sheet.getColumn(imageColumn).width = 80;
      row.height = 409;
      for (let index = 0; index < images.length; index++) {
        const path = images[index].startsWith("/artifacts/") ? artifactFilePath(images[index].slice(11)) : images[index];
        if (!path || !existsSync(path)) throw new Error("截图文件不存在，未继续下一条");
        const imageId = destination.workbook.addImage({ filename: path, extension: /\.jpe?g$/i.test(path) ? "jpeg" : "png" });
        sheet.addImage(imageId, { tl: { col: imageColumn - 1, row: source.source_row_number - 1 + index / images.length } as ExcelJS.Anchor,
          br: { col: imageColumn, row: source.source_row_number - 1 + (index + 1) / images.length } as ExcelJS.Anchor, editAs: "twoCell" });
      }
      row.getCell(imageColumn).note = "完整尺寸截图可在执行记录中查看。多张截图按顺序排列在此单元格中。";
    }
    const ledger = destination.workbook.getWorksheet("__agent_eval_saved") || destination.workbook.addWorksheet("__agent_eval_saved", { state: "veryHidden" });
    ledger.addRow([caseId]);
    await this.save(destination);
    db.execute("UPDATE evaluation_batches SET result_workbook_path=? WHERE id=?", this.files[0].url, this.batchId);
  }

  private async save(destination: Destination): Promise<void> {
    const temporary = `${destination.file.path}.tmp`;
    try {
      await destination.workbook.xlsx.writeFile(temporary);
      renameSync(temporary, destination.file.path);
    } catch (error) {
      throw new Error(`保存 Excel 失败：${destination.file.path}。请关闭占用文件的 Excel/WPS 并检查目录权限。${String(error)}`);
    }
  }
}

function columnNumber(value: string): number { return [...value].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0); }
function cellText(value: unknown): string {
  if (value && typeof value === "object") {
    const cell = value as { richText?: Array<{ text: string }>; text?: string; result?: unknown };
    return cell.richText ? cell.richText.map(part => part.text).join("").trim() : String(cell.text ?? cell.result ?? "").trim();
  }
  return String(value ?? "").trim();
}
