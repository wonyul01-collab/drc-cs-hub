/**
 * 리뷰 엑셀 → 답글 초안 검토용 엑셀 (허브에 올리지 않고 미리 보기)
 *   node --import tsx scripts/review-drafts.ts <리뷰.xlsx> <결과.xlsx> [지식DB.xlsx(상품 이름용)]
 */
import { readFileSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { identifyProducts, stripFixedText } from "@drc/shared";
import { HubDb } from "../src/db.ts";
import { parseKnowledgeXlsx } from "../src/excel.ts";
import { processReviewDrafts } from "../src/pipeline.ts";
import { parseReviewXlsx } from "../src/reviewImport.ts";

const [input, output, kbPath] = process.argv.slice(2);
const db = new HubDb(":memory:");
if (kbPath) {
  const kb = await parseKnowledgeXlsx(readFileSync(kbPath));
  db.replaceKnowledge([], kb.products, "script");
}
const parsed = await parseReviewXlsx(readFileSync(input));
if (parsed.errors.length) throw new Error(parsed.errors.join("\n"));
const products = db.productInfos();
db.upsertReviews(parsed.rows, (name) => identifyProducts("", name, products)[0] ?? null);
processReviewDrafts(db);

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("답글 초안");
ws.columns = [
  { header: "번호", key: "n", width: 6 },
  { header: "주의", key: "c", width: 8 },
  { header: "별점", key: "r", width: 6 },
  { header: "유형", key: "t", width: 9 },
  { header: "상품", key: "p", width: 16 },
  { header: "고객 리뷰", key: "b", width: 55 },
  { header: "답글 초안 (본문만 — 앞뒤 고정 문구는 자동)", key: "d", width: 65 },
  { header: "주의 이유", key: "why", width: 22 },
  { header: "검토 의견 (적어주세요)", key: "rv", width: 30 },
];
const { rows } = db.listReviews({ tab: "todo", page: 1 });
const all = [...rows, ...db.listReviews({ tab: "todo", page: 2 }).rows];
all.forEach((r: any, i) =>
  ws.addRow({ n: i + 1, c: r.caution ? "주의" : "", r: r.rating, t: r.review_type, p: r.product ?? "", b: r.body_masked, d: stripFixedText(r.draft_text ?? ""), why: (r.caution_reasons as string[]).join(" / ") }),
);
ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
ws.views = [{ state: "frozen", ySplit: 1 }];
ws.eachRow((r, i) => {
  if (i > 1) {
    r.alignment = { vertical: "top", wrapText: true };
    if (r.getCell("c").value === "주의") r.getCell("c").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFECACA" } };
  }
});
writeFileSync(output, Buffer.from(await wb.xlsx.writeBuffer()));
console.log(`리뷰 ${parsed.rows.length}건 중 답글 대기 ${all.length}건 → ${output}`);
