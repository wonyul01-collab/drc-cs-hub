/**
 * 리뷰 엑셀 읽기 — 판매자센터에서 내려받은 원본 그대로
 *  스마트스토어센터 리뷰관리 엑셀 (2026-11-25 실물 확인): 상품번호, 상품명, 리뷰구분, 구매자평점, 포토/영상, 리뷰상세내용,
 *    등록자, 리뷰등록일, 리뷰글번호, 관련리뷰글번호, 관련리뷰상세내용, 전시상태, 답글여부, 답글등록일시, 상품주문번호 …
 *  쿠팡 Wing: 실물 파일 확인 후 COLUMN_NAMES에 이름 추가
 */
import ExcelJS from "exceljs";
import { maskPii, type Channel } from "@drc/shared";

export interface ReviewRow {
  channel: Channel;
  review_key: string;
  product_id: string | null;
  product_name: string | null;
  rating: number | null;
  review_type: string | null;
  body_masked: string;
  prev_body_masked: string | null;
  has_photo: boolean;
  author_masked: string | null;
  written_at: string | null;
  platform_replied: boolean;
  hidden: boolean;
}

/** 칸 이름 후보 (판매자센터마다 다름) */
const COLUMN_NAMES = {
  key: ["리뷰글번호", "리뷰번호", "리뷰ID", "리뷰 ID", "상품평번호", "상품평ID"],
  productId: ["상품번호", "노출상품ID", "상품ID", "등록상품ID"],
  productName: ["상품명", "노출상품명", "등록상품명"],
  rating: ["구매자평점", "평점", "별점", "만족도"],
  type: ["리뷰구분", "리뷰유형", "상품평유형"],
  body: ["리뷰상세내용", "리뷰내용", "상품평내용", "상품평", "내용"],
  prev: ["관련리뷰상세내용"],
  photo: ["포토/영상", "포토", "사진", "첨부이미지"],
  author: ["등록자", "작성자", "구매자"],
  date: ["리뷰등록일", "작성일", "등록일", "작성일시"],
  replied: ["답글여부", "답변여부", "판매자답글여부", "댓글여부"],
  status: ["전시상태", "노출상태"],
};

function text(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
    if ("hyperlink" in v) return String((v as { hyperlink: string }).hyperlink);
    if ("result" in v) return String(v.result ?? "");
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
}

/** "2026.11.22. 19:00:16" / "2026-11-22 19:00" → ISO (한국 시각) */
function parseDate(s: string): string | null {
  const m = /(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\.?\s*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  const p = (x: string | undefined, d = "00") => (x ?? d).padStart(2, "0");
  const d = new Date(`${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${p(m[5])}:${p(m[6])}+09:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface ReviewParseResult {
  channel: Channel | null;
  rows: ReviewRow[];
  errors: string[];
  headers: string[];
}

export async function parseReviewXlsx(buf: Buffer, channelHint?: Channel): Promise<ReviewParseResult> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    return { channel: null, rows: [], errors: ["엑셀(.xlsx) 파일을 읽을 수 없습니다. 판매자센터에서 내려받은 파일 그대로 올려주세요."], headers: [] };
  }
  const ws = wb.worksheets[0];
  if (!ws) return { channel: null, rows: [], errors: ["시트가 없습니다."], headers: [] };

  // 제목 줄 찾기 (위쪽 5줄 안에서 '리뷰'·'평점' 같은 칸 이름이 있는 줄)
  let headRow = 1;
  let headers: string[] = [];
  for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
    const h = Array.from(ws.getRow(r).values as ExcelJS.CellValue[], (v) => text(v).trim());
    if (h.some((x) => COLUMN_NAMES.body.includes(x)) && h.some((x) => COLUMN_NAMES.key.includes(x))) {
      headRow = r;
      headers = h;
      break;
    }
  }
  const col = (names: string[]) => headers.findIndex((h) => names.includes(h));
  const idx = Object.fromEntries(Object.entries(COLUMN_NAMES).map(([k, v]) => [k, col(v)])) as Record<keyof typeof COLUMN_NAMES, number>;
  if (idx.key < 0 || idx.body < 0) {
    const seen = Array.from(ws.getRow(1).values as ExcelJS.CellValue[], (v) => text(v).trim()).filter(Boolean);
    return {
      channel: null,
      rows: [],
      errors: [`리뷰 번호·내용 칸을 찾지 못했습니다. 판매자센터 리뷰 엑셀 원본인지 확인해주세요. (첫 줄: ${seen.slice(0, 12).join(", ")})`],
      headers: seen,
    };
  }
  const channel: Channel = channelHint ?? (headers.includes("리뷰글번호") ? "smartstore" : "coupang");

  const rows: ReviewRow[] = [];
  const errors: string[] = [];
  ws.eachRow((row, n) => {
    if (n <= headRow) return;
    const get = (i: number) => (i > 0 ? text(row.getCell(i).value).trim() : "");
    const key = get(idx.key);
    if (!key) return;
    const body = maskPii(get(idx.body));
    const prev = get(idx.prev);
    const ratingNum = Number(get(idx.rating));
    const replied = get(idx.replied).toUpperCase();
    rows.push({
      channel,
      review_key: key,
      product_id: get(idx.productId) || null,
      product_name: get(idx.productName) || null,
      rating: Number.isFinite(ratingNum) && ratingNum > 0 ? ratingNum : null,
      review_type: get(idx.type) || null,
      body_masked: body.text,
      prev_body_masked: prev ? maskPii(prev).text : null,
      has_photo: !!get(idx.photo),
      author_masked: get(idx.author) || null, // 판매자센터가 이미 가려서 줌 (예: on****)
      written_at: parseDate(get(idx.date)),
      platform_replied: replied === "Y" || replied === "답글완료" || replied === "완료",
      hidden: /블라인드|숨김|비노출/.test(get(idx.status)),
    });
  });
  if (!rows.length) errors.push("리뷰가 한 줄도 없습니다.");
  return { channel, rows, errors, headers };
}
