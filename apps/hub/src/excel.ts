/**
 * 지식 DB 엑셀 — 내려받기(현재 내용) / 올리기(통째로 바꾸기)
 * 시트 「표준답변」, 「상품정보」 (docs/지식DB-엑셀-안내.md)
 */
import ExcelJS from "exceljs";
import { ALL_RULES, type KnowledgeEntry, type Route } from "@drc/shared";

export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries([...ALL_RULES.map((r) => [r.id, r.label]), ["other", "기타"]]);
const LABEL_TO_CATEGORY = Object.fromEntries(Object.entries(CATEGORY_LABELS).map(([id, label]) => [label.replace(/\s/g, ""), id]));

const ROUTE_TEXT: Record<Route, string> = { auto: "자동 가능", approve: "승인 필요", human: "사람 전용" };
function parseRoute(v: string): Route {
  const s = v.replace(/\s/g, "");
  if (/사람|③|human/i.test(s)) return "human";
  if (/승인|②|approve/i.test(s)) return "approve";
  return "auto";
}

const K_COLS = [
  { header: "번호", key: "id", width: 7 },
  { header: "사용(Y/N)", key: "active", width: 10 },
  { header: "질문 유형", key: "category", width: 18 },
  { header: "제목", key: "title", width: 28 },
  { header: "상품(쉼표로 구분, 비우면 전체)", key: "products", width: 26 },
  { header: "키워드(쉼표로 구분)", key: "keywords", width: 26 },
  { header: "고객 질문 예시", key: "example", width: 40 },
  { header: "표준 답변 (고정 인사·마무리 문구는 빼고 본문만)", key: "answer", width: 70 },
  { header: "발송 전 확인 조건", key: "conditions", width: 34 },
  { header: "처리 단계(자동 가능/승인 필요/사람 전용)", key: "minRoute", width: 18 },
  { header: "유효기간(YYYY-MM-DD)", key: "validUntil", width: 14 },
];
const P_COLS = [
  { header: "상품", key: "name", width: 18 },
  { header: "별칭(쉼표로 구분)", key: "aliases", width: 30 },
  { header: "흡수량_ml", key: "absorb_ml", width: 10 },
  { header: "특징", key: "features", width: 50 },
  { header: "사이즈 안내", key: "size_guide", width: 34 },
  { header: "세탁 안내", key: "wash_guide", width: 34 },
  { header: "주의", key: "caution", width: 40 },
];

type KRow = Omit<KnowledgeEntry, "id"> & { id?: number; example?: string | null };
type PRow = { name: string; aliases: string[]; absorb_ml?: string | null; features?: string | null; size_guide?: string | null; wash_guide?: string | null; caution?: string | null };

function styleHeader(ws: ExcelJS.Worksheet) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
  row.alignment = { vertical: "middle", wrapText: true };
  row.height = 36;
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.eachRow((r, i) => {
    if (i > 1) r.alignment = { vertical: "top", wrapText: true };
  });
}

export async function exportKnowledgeXlsx(
  knowledge: Array<Record<string, unknown>>,
  products: Array<Record<string, unknown>>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("표준답변");
  ws.columns = K_COLS;
  for (const k of knowledge) {
    ws.addRow({
      id: k.id,
      active: k.active ? "Y" : "N",
      category: CATEGORY_LABELS[String(k.category)] ?? k.category,
      title: k.title,
      products: (k.products as string[]).join(", "),
      keywords: (k.keywords as string[]).join(", "),
      example: k.example ?? "",
      answer: k.answer,
      conditions: k.conditions ?? "",
      minRoute: ROUTE_TEXT[k.min_route as Route] ?? "자동 가능",
      validUntil: k.valid_until ?? "",
    });
  }
  styleHeader(ws);
  ws.getColumn("category").eachCell((c, i) => {
    if (i > 1) c.dataValidation = { type: "list", allowBlank: false, formulae: [`"${Object.values(CATEGORY_LABELS).join(",")}"`] };
  });

  const ps = wb.addWorksheet("상품정보");
  ps.columns = P_COLS;
  for (const p of products) ps.addRow({ ...p, aliases: (p.aliases as string[]).join(", ") });
  styleHeader(ps);

  const guide = wb.addWorksheet("사용법");
  guide.columns = [{ header: "지식 DB 엑셀 사용법", key: "t", width: 110 }];
  for (const t of [
    "1. 「표준답변」 시트의 한 줄 = 답변 하나입니다. 고객 문의가 오면 질문 유형·상품·키워드가 맞는 줄의 '표준 답변'으로 초안을 만듭니다.",
    "2. 표준 답변에는 고정 인사말과 마무리 안내(상담톡·고객센터·운영시간)를 넣지 마세요. 프로그램이 자동으로 앞뒤에 붙입니다.",
    "3. 사용(Y/N): N이면 그 답변은 쓰지 않습니다. 새로 만든 '예상 질문' 줄은 답변을 채운 뒤 Y로 바꾸세요.",
    "4. 처리 단계: '자동 가능'이어도 실제 자동 등록은 담당자가 따로 켜기 전까지 하지 않습니다. 확인이 필요한 답변은 '승인 필요'로 두세요.",
    "5. 발송 전 확인 조건: 적어 두면 담당자 화면에 노란 경고로 보이고, 그 답변은 항상 '승인 필요'가 됩니다.",
    "6. 번호는 그대로 두세요. 새 줄은 번호를 비워두면 자동으로 붙습니다.",
    "7. 저장한 뒤 허브 화면 [지식 DB] → [엑셀 올리기]를 누르면 전체가 이 파일 내용으로 바뀝니다. (바꾸기 전 자동 백업)",
  ])
    guide.addRow({ t });
  guide.getRow(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
    if ("result" in v) return String(v.result ?? "");
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
}

const split = (s: string) =>
  s
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean);

export interface ImportResult {
  knowledge: KRow[];
  products: PRow[];
  errors: string[];
}

export async function parseKnowledgeXlsx(buf: Buffer): Promise<ImportResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const errors: string[] = [];
  const knowledge: KRow[] = [];
  const products: PRow[] = [];

  const ws = wb.getWorksheet("표준답변");
  if (!ws) errors.push("'표준답변' 시트가 없습니다. [엑셀로 내려받기]로 받은 파일을 고쳐서 올려주세요.");
  else {
    const head = Array.from(ws.getRow(1).values as ExcelJS.CellValue[], (v) => cellText(v));
    const col = (name: string) => head.findIndex((h) => h.startsWith(name));
    const idx = { id: col("번호"), active: col("사용"), category: col("질문 유형"), title: col("제목"), products: col("상품"), keywords: col("키워드"), example: col("고객 질문"), answer: col("표준 답변"), conditions: col("발송 전"), minRoute: col("처리 단계"), validUntil: col("유효기간") };
    if (idx.answer < 0 || idx.category < 0) errors.push("'표준답변' 시트 첫 줄(제목 줄)이 바뀌었습니다. 내려받은 양식을 그대로 써주세요.");
    else
      ws.eachRow((row, n) => {
        if (n === 1) return;
        const get = (i: number) => (i > 0 ? cellText(row.getCell(i).value).trim() : "");
        const answer = get(idx.answer);
        const example = get(idx.example);
        const title = get(idx.title) || example.slice(0, 30) || `답변 ${n}`;
        if (!answer && !example && !get(idx.title)) return; // 빈 줄
        const catText = get(idx.category).replace(/\s/g, "");
        const category = LABEL_TO_CATEGORY[catText] ?? (CATEGORY_LABELS[catText] ? catText : null);
        if (!category) errors.push(`${n}번째 줄: 질문 유형 '${get(idx.category)}'을(를) 알 수 없습니다. (${Object.values(CATEGORY_LABELS).join(", ")} 중 하나)`);
        const valid = get(idx.validUntil);
        if (valid && !/^\d{4}-\d{2}-\d{2}$/.test(valid)) errors.push(`${n}번째 줄: 유효기간은 2026-12-31 형식으로 써주세요.`);
        const idNum = Number(get(idx.id));
        const wantActive = !/^n/i.test(get(idx.active) || "Y");
        knowledge.push({
          id: Number.isInteger(idNum) && idNum > 0 ? idNum : undefined,
          // 답변이 비어 있으면 사용할 수 없음
          active: wantActive && !!answer,
          category: category ?? "other",
          title,
          products: split(get(idx.products)),
          keywords: split(get(idx.keywords)),
          example: example || null,
          answer,
          conditions: get(idx.conditions) || null,
          minRoute: parseRoute(get(idx.minRoute)),
          validUntil: valid || null,
        });
      });
    const ids = knowledge.map((k) => k.id).filter(Boolean);
    if (new Set(ids).size !== ids.length) errors.push("번호가 겹치는 줄이 있습니다. 새 줄은 번호를 비워두세요.");
  }

  const ps = wb.getWorksheet("상품정보");
  if (ps) {
    const head = Array.from(ps.getRow(1).values as ExcelJS.CellValue[], (v) => cellText(v));
    const col = (name: string) => head.findIndex((h) => h.startsWith(name));
    const idx = { name: col("상품"), aliases: col("별칭"), absorb_ml: col("흡수량"), features: col("특징"), size_guide: col("사이즈"), wash_guide: col("세탁"), caution: col("주의") };
    ps.eachRow((row, n) => {
      if (n === 1) return;
      const get = (i: number) => (i > 0 ? cellText(row.getCell(i).value).trim() : "");
      const name = get(idx.name);
      if (!name) return;
      products.push({
        name,
        aliases: split(get(idx.aliases)),
        absorb_ml: get(idx.absorb_ml) || null,
        features: get(idx.features) || null,
        size_guide: get(idx.size_guide) || null,
        wash_guide: get(idx.wash_guide) || null,
        caution: get(idx.caution) || null,
      });
    });
  }
  // 답변에 적힌 상품이 상품정보에 없으면 알려주기
  const names = new Set(products.map((p) => p.name));
  for (const k of knowledge) for (const p of k.products) if (products.length && !names.has(p)) errors.push(`'${k.title}'의 상품 '${p}'이(가) 상품정보 시트에 없습니다.`);
  return { knowledge, products, errors };
}
