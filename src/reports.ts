import ExcelJS from "exceljs";

import * as db from "./db.js";
import type { Project } from "./domain.js";

interface ReportRow {
  id: number; code: string; category: string; title: string; query: string; expected_answer: string;
  status: string; score: number; passed: number; total_latency_ms: number; turn_count: number;
  tool_call_count: number; summary: string; started_at: string; finished_at: string; screenshot_path: string; actual_answer: string;
}

export function reportRows(projectId: number, batchId?: number): ReportRow[] {
  return db.rows<ReportRow>(`SELECT r.id,c.code,c.category,c.title,c.query,c.expected_answer,r.status,r.score,r.passed,
    r.total_latency_ms,r.turn_count,r.tool_call_count,r.summary,r.started_at,r.finished_at,r.screenshot_path,
    (SELECT m.content FROM messages m WHERE m.run_id=r.id AND m.role='assistant' ORDER BY m.id DESC LIMIT 1) actual_answer FROM runs r
    JOIN cases c ON c.id=r.case_id WHERE r.project_id=? ${batchId ? "AND r.batch_id=?" : ""} ORDER BY r.id DESC`, projectId, ...(batchId ? [batchId] : []));
}

export function buildHtml(project: Project, batchId?: number): string {
  const items = reportRows(project.id, batchId);
  const completed = items.filter((item) => item.status === "completed");
  const passed = completed.filter((item) => item.passed).length;
  const passRate = completed.length ? Math.round(passed / completed.length * 1000) / 10 : 0;
  const avgScore = completed.length ? Math.round(completed.reduce((sum, item) => sum + Number(item.score), 0) / completed.length * 10) / 10 : 0;
  const avgLatency = completed.length ? Math.round(completed.reduce((sum, item) => sum + item.total_latency_ms, 0) / completed.length) : 0;
  const body = items.map((item) => `<article class="run ${item.passed ? "passed" : "failed"}">
    <div class="run-head"><div><span class="code">${escapeHtml(item.code)}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.category)} · ${formatDate(item.started_at)}</p></div>
    <div class="result"><b>${item.status === "completed" ? Number(item.score).toFixed(0) : "—"}</b><span>${item.passed ? "通过" : "未通过"}</span></div></div>
    <div class="facts"><span>耗时 <b>${item.total_latency_ms} ms</b></span><span>对话 <b>${item.turn_count} 轮</b></span><span>工具 <b>${item.tool_call_count} 次</b></span></div>
    <div class="evidence"><div><label>测试问题</label><p>${escapeHtml(item.query)}</p></div><div><label>预期回答</label><p>${escapeHtml(item.expected_answer)}</p></div><div><label>实际回复</label><p>${escapeHtml(item.actual_answer || "未捕获回复")}</p></div></div>
    <div class="reason"><label>评测结论</label><p>${escapeHtml(item.summary || "未生成评测结论")}</p></div>
    ${item.screenshot_path ? `<a class="shot" href="${escapeHtml(item.screenshot_path)}" target="_blank">查看对话截图 ↗</a>` : ""}
  </article>`).join("") || `<div class="empty">该范围内还没有执行记录。</div>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(project.name)} 测试报告</title>
  <style>:root{--bg:#f7f7f5;--surface:#fff;--ink:#20201e;--muted:#73736d;--line:#e2e2dc;--green:#147d64;--red:#b42318}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,"Segoe UI","Microsoft YaHei",sans-serif}.shell{max-width:1080px;margin:auto;padding:38px 28px 70px}.top{display:flex;justify-content:space-between;gap:30px;align-items:flex-start;padding-bottom:28px;border-bottom:1px solid var(--line)}.back{color:var(--muted);text-decoration:none;font-size:12px}.kicker,.code,label{font:700 10px "SFMono-Regular",Consolas,monospace;letter-spacing:.1em;color:var(--green)}h1{margin:9px 0 8px;font-size:38px;letter-spacing:-.045em}.sub{margin:0;color:var(--muted);font-size:13px}.stamp{text-align:right;color:var(--muted);font-size:11px}.stamp b{display:block;color:var(--ink);font-size:12px;margin-bottom:5px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);margin:24px 0 34px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface)}.metric{padding:18px;border-right:1px solid var(--line)}.metric:last-child{border:0}.metric b{display:block;font:650 27px "SFMono-Regular",Consolas,monospace}.metric span{color:var(--muted);font-size:11px}.section-head{display:flex;justify-content:space-between;align-items:end;margin-bottom:12px}.section-head h2{margin:0;font-size:18px}.section-head span{font-size:11px;color:var(--muted)}.runs{display:grid;gap:10px}.run{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px}.run-head{display:flex;justify-content:space-between;gap:20px}.run h3{margin:6px 0 4px;font-size:16px}.run-head p{margin:0;color:var(--muted);font-size:11px}.result{text-align:right}.result b{display:block;font:650 25px "SFMono-Regular",Consolas,monospace}.result span{font-size:11px;color:var(--green)}.failed .result span{color:var(--red)}.facts{display:flex;gap:20px;margin:16px 0;padding:10px 0;border-block:1px solid var(--line);color:var(--muted);font-size:11px}.facts b{color:var(--ink)}.evidence{display:grid;grid-template-columns:1fr 1fr;gap:20px}.evidence p,.reason p{font-size:12px;line-height:1.7;margin:6px 0 0;white-space:pre-wrap}.reason{margin-top:16px;padding:12px 14px;background:#f3f6f3;border-radius:8px}.shot{display:inline-block;margin-top:14px;color:var(--green);font-size:11px;text-decoration:none}.empty{padding:80px;text-align:center;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:12px}@media(max-width:700px){.shell{padding:24px 14px}.top{display:block}.stamp{text-align:left;margin-top:16px}.metrics{grid-template-columns:1fr 1fr}.metric:nth-child(2){border-right:0}.metric:nth-child(-n+2){border-bottom:1px solid var(--line)}.evidence{grid-template-columns:1fr}}@media print{body{background:#fff}.shell{max-width:none;padding:0}.back{display:none}.run{break-inside:avoid}}</style></head>
  <body><main class="shell"><a class="back" href="/">← 返回评测系统</a><header class="top"><div><p class="kicker">AGENT EVALUATION REPORT</p><h1>${escapeHtml(project.name)}</h1><p class="sub">${batchId ? `第 ${batchId} 次评测` : "项目全部历史记录"} · ${escapeHtml(project.project_key)}</p></div><div class="stamp"><b>报告生成时间</b>${formatDate(new Date().toISOString())}</div></header>
  <section class="metrics"><div class="metric"><b>${items.length}</b><span>执行用例</span></div><div class="metric"><b>${passRate}%</b><span>通过率</span></div><div class="metric"><b>${avgScore}</b><span>平均得分</span></div><div class="metric"><b>${avgLatency}</b><span>平均耗时 ms</span></div></section>
  <div class="section-head"><h2>执行明细</h2><span>问题、预期、结果与证据完整保留</span></div><section class="runs">${body}</section></main></body></html>`;
}

export async function buildXlsx(project: Project): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("测试报告", { views: [{ state: "frozen", ySplit: 2 }] });
  const headers = ["编号", "分类", "用例", "测试问题", "预期回答", "结果", "得分", "耗时(ms)", "轮数", "工具调用", "问题归因"];
  sheet.mergeCells(1, 1, 1, headers.length);
  const title = sheet.getCell("A1"); title.value = `${project.name} 自动化评测报告`; title.font = { size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF173B57" } }; title.alignment = { horizontal: "center" };
  sheet.addRow(headers);
  sheet.getRow(2).eachCell((cell) => { cell.font = { bold: true, color: { argb: "FF173B57" } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9F0F4" } }; });
  for (const item of reportRows(project.id)) {
    const row = sheet.addRow([item.code, item.category, item.title, item.query, item.expected_answer, item.passed ? "通过" : "未通过",
      item.score, item.total_latency_ms, item.turn_count, item.tool_call_count, item.summary]);
    row.getCell(6).font = { bold: true, color: { argb: item.passed ? "FF087E68" : "FFC33F32" } };
  }
  [13, 15, 24, 42, 44, 12, 10, 12, 9, 12, 46].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.eachRow((row, rowIndex) => { if (rowIndex >= 2) row.eachCell((cell) => { cell.alignment = { vertical: "top", wrapText: true }; }); });
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] || char);
}

function formatDate(value: string): string {
  try { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" }).format(new Date(value)); }
  catch { return value || "—"; }
}
