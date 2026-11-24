/**
 * 오프라인 평가 — 지식 DB 엑셀 + 평가 사례(JSON)로 분류·초안을 만들어 검토용 엑셀로 저장
 *   node --import tsx scripts/evaluate.ts <지식DB.xlsx> <결과.xlsx> <사례1.json> [사례2.json ...]
 * 사례 형식: [{ id, source?, text, product?, expect?("auto"|"approve"|"human"), pii?, priorComplaints?, channel?, reference? }]
 */
import { readFileSync, writeFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { makeDraft, maskPii, ROUTE_LABEL, stripFixedText, type Route } from "@drc/shared";
import { parseKnowledgeXlsx } from "../src/excel.ts";

interface Case {
  id: string;
  source?: string;
  text: string;
  product?: string | null;
  expect?: Route | null;
  pii?: boolean;
  priorComplaints?: number;
  channel?: "smartstore" | "coupang";
  reference?: string | null;
}

const [kbPath, outPath, ...casePaths] = process.argv.slice(2);
if (!kbPath || !outPath || !casePaths.length) {
  console.error("사용법: evaluate.ts <지식DB.xlsx> <결과.xlsx> <사례.json> ...");
  process.exit(1);
}

const parsed = await parseKnowledgeXlsx(readFileSync(kbPath));
if (parsed.errors.length) console.warn("지식 DB 경고:", parsed.errors);
const kb = parsed.knowledge.map((k, i) => ({ ...k, id: k.id ?? 10_000 + i }));
const products = parsed.products.map((p) => ({ name: p.name, aliases: p.aliases }));
const cases: Case[] = casePaths.flatMap((p) => JSON.parse(readFileSync(p, "utf8")));

const RANK: Record<Route, number> = { auto: 0, approve: 1, human: 2 };
const wb = new ExcelJS.Workbook();
const sum = wb.addWorksheet("요약"); // 첫 시트
const ws = wb.addWorksheet("평가 결과");
ws.columns = [
  { header: "번호", key: "id", width: 7 },
  { header: "출처", key: "source", width: 12 },
  { header: "상품", key: "product", width: 18 },
  { header: "고객 문의", key: "text", width: 45 },
  { header: "기대 단계", key: "expect", width: 12 },
  { header: "결과 단계", key: "route", width: 12 },
  { header: "판정", key: "verdict", width: 14 },
  { header: "분류", key: "category", width: 14 },
  { header: "사용한 표준 답변", key: "used", width: 28 },
  { header: "일치도", key: "conf", width: 8 },
  { header: "이렇게 판단한 이유", key: "reasons", width: 50 },
  { header: "만든 초안 (본문만)", key: "draft", width: 60 },
  { header: "담당자 권장 답변 (본문만, 비교용)", key: "reference", width: 60 },
  { header: "검토 의견 (적어주세요)", key: "review", width: 30 },
];

let match = 0;
let safer = 0;
let riskier = 0;
let leaks = 0;
const byRoute: Record<Route, number> = { auto: 0, approve: 0, human: 0 };

for (const c of cases) {
  const masked = maskPii(c.text);
  const r = makeDraft(
    { channel: c.channel ?? "smartstore", text: masked.text, productName: c.product ?? null, piiDetected: c.pii ?? masked.piiDetected, priorComplaints: c.priorComplaints },
    kb,
    products,
  );
  byRoute[r.route]++;
  let verdict = "검토";
  if (c.expect) {
    if (r.route === c.expect) (verdict = "일치", match++);
    else if (RANK[r.route] > RANK[c.expect]) (verdict = "더 조심(올림)", safer++);
    else (verdict = "❌ 덜 조심", riskier++);
    if (c.expect === "human" && r.route === "auto") leaks++;
  }
  const row = ws.addRow({
    id: c.id,
    source: c.source ?? "",
    product: c.product ?? "",
    text: masked.text,
    expect: c.expect ? ROUTE_LABEL[c.expect] : "(담당자 판단)",
    route: ROUTE_LABEL[r.route],
    verdict,
    category: r.classification.categoryLabel,
    used: r.usedIds.map((id) => kb.find((k) => k.id === id)?.title).join(" + ") || "없음",
    conf: Math.round(r.confidence * 100) + "%",
    reasons: [...r.reasons, ...r.conditions.map((x) => `확인 조건: ${x}`), ...r.forbidden.map((f) => `금지 표현: ${f.label}`)].join("\n"),
    draft: stripFixedText(r.text),
    reference: c.reference ? stripFixedText(c.reference) : "",
  });
  const color = verdict.startsWith("❌") ? "FFFECACA" : verdict === "일치" ? "FFDCFCE7" : verdict.startsWith("더") ? "FFFEF3C7" : undefined;
  if (color) row.getCell("verdict").fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
}

ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
ws.views = [{ state: "frozen", ySplit: 1 }];
ws.eachRow((r, i) => {
  if (i > 1) r.alignment = { vertical: "top", wrapText: true };
});

const withExpect = cases.filter((c) => c.expect).length;
sum.columns = [
  { header: "항목", key: "k", width: 46 },
  { header: "값", key: "v", width: 20 },
];
for (const [k, v] of [
  ["평가 사례 수", cases.length],
  ["기대 단계가 정해진 사례", withExpect],
  ["  └ 기대와 일치", match],
  ["  └ 기대보다 더 조심 (안전한 쪽 오차)", safer],
  ["  └ 기대보다 덜 조심 (위험한 쪽 오차)", riskier],
  ["★ ③ 사람 전용인데 ① 자동으로 분류된 건 (완료 기준: 0)", leaks],
  ["결과: ① 자동 가능", byRoute.auto],
  ["결과: ② 승인 필요", byRoute.approve],
  ["결과: ③ 사람 전용", byRoute.human],
  ["지식 DB 답변 (사용 중 / 전체)", `${kb.filter((k) => k.active).length} / ${kb.length}`],
] as Array<[string, string | number]>)
  sum.addRow({ k, v });
sum.getRow(1).font = { bold: true };

writeFileSync(outPath, Buffer.from(await wb.xlsx.writeBuffer()));
console.log(`평가 ${cases.length}건 → 일치 ${match}/${withExpect}, 더 조심 ${safer}, 덜 조심 ${riskier}, ③→① ${leaks}건`);
console.log(`결과: ①${byRoute.auto} ②${byRoute.approve} ③${byRoute.human} → ${outPath}`);
