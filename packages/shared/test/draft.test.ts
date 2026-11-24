import { describe, expect, it } from "vitest";
import { checkFixedText, checkForbidden, composeInquiryReply, composeReviewReply, makeDraft, SALIB, stripFixedText, type KnowledgeEntry } from "../src/index.ts";

const KB: KnowledgeEntry[] = [
  { id: 1, title: "안심퀸 사이즈", category: "size", products: ["안심퀸 프리미엄"], keywords: ["사이즈", "95"], answer: "안심퀸 프리미엄은 일반 팬티 사이즈에 맞춰 제작되었습니다.", conditions: null, minRoute: "auto", active: true, validUntil: null },
  { id: 2, title: "맥시 사이즈", category: "size", products: ["맥시텐셀"], keywords: ["사이즈"], answer: "맥시 라인은 한 치수 크게 추천드립니다.", conditions: null, minRoute: "auto", active: true, validUntil: null },
  { id: 3, title: "방탄 세탁", category: "wash", products: ["방탄팬티"], keywords: ["세탁", "세탁기"], answer: "세탁망에 넣어 세탁기 사용 가능합니다.", conditions: null, minRoute: "auto", active: true, validUntil: null },
  { id: 4, title: "오배송", category: "wrong", products: [], keywords: ["오배송"], answer: "오배송으로 불편을 드려 죄송합니다.", conditions: "재발송 확인 후 사용", minRoute: "approve", active: true, validUntil: null },
  { id: 5, title: "지난 재입고 안내", category: "stock", products: [], keywords: ["재입고"], answer: "12월 1일 재입고 예정입니다.", conditions: null, minRoute: "auto", active: true, validUntil: "2026-01-01" },
  { id: 6, title: "꺼둔 답변", category: "size", products: [], keywords: ["사이즈"], answer: "쓰면 안 되는 답변", conditions: null, minRoute: "auto", active: false, validUntil: null },
];
const PRODUCTS = [
  { name: "안심퀸 프리미엄", aliases: ["안심퀸"] },
  { name: "맥시텐셀", aliases: ["맥시 텐셀"] },
  { name: "방탄팬티", aliases: ["남성 요실금"] },
];
const draft = (text: string, productName: string | null = null, extra: Partial<Parameters<typeof makeDraft>[0]> = {}) =>
  makeDraft({ channel: "smartstore", text, productName, piiDetected: false, today: "2026-11-24", ...extra }, KB, PRODUCTS);

describe("고정 문구 (응대 규칙 R01, 수정이력 F13·F14·F32)", () => {
  it("문의 답변: 인사 ⏎⏎ 본문 ⏎⏎ 마무리 전문, 마무리 안 빈 줄 없음", () => {
    const t = composeInquiryReply("본문입니다.");
    expect(t.startsWith(`${SALIB.greeting}\n\n본문입니다.\n\n이외 문의 사항`)).toBe(true);
    expect(t.endsWith("-고객센터 : 09:00~17:00 (주말&공휴일 제외) / 12:30~13:30 점심시간")).toBe(true);
    expect(SALIB.closing.includes("\n\n")).toBe(false);
    expect(checkFixedText(t)).toEqual([]);
  });
  it("리뷰 답글은 후기 감사 줄이 들어간다", () => {
    expect(composeReviewReply("감사합니다.").split("\n")[1]).toBe("소중한 후기 남겨주셔서 감사합니다!");
  });
  it("마무리 문구가 빠지면 경고", () => {
    expect(checkFixedText(`${SALIB.greeting}\n\n본문`).length).toBe(1);
  });
  it("기존 답변에서 본문만 꺼내기", () => {
    expect(stripFixedText(composeInquiryReply("가운데 본문"))).toBe("가운데 본문");
  });
});

describe("금지 표현 검사", () => {
  it.each([
    ["요실금이 완치됩니다", "cure"],
    ["100% 샘 방지", "absolute"],
    ["부작용이 전혀 없습니다", "no-side-effect"],
    ["절대 새지 않습니다", "no-leak"],
    ["대변도 흡수 가능합니다", "stool"],
    ["소취 기능은 영구적입니다", "permanent"],
    ["다음 구매 시 할인해 드리겠습니다", "discount-promise"],
  ])("%s → %s", (text, id) => {
    expect(checkForbidden(text).map((h) => h.id)).toContain(id);
  });
  it("평범한 안내 문장은 통과", () => {
    expect(checkForbidden("세탁망에 넣어 세탁기로 세탁하셔도 됩니다. 이중 샘방지 구조입니다.")).toEqual([]);
  });
});

describe("지식 DB 초안", () => {
  it("상품·유형이 맞는 답변으로 ① 자동 가능", () => {
    const r = draft("평소 95 입으시는데 사이즈 어떻게 고르나요?", "여성 요실금팬티 안심퀸 프리미엄 국내산");
    expect(r.route).toBe("auto");
    expect(r.usedIds).toEqual([1]);
    expect(r.text).toContain("일반 팬티 사이즈에 맞춰");
    expect(r.text.startsWith(SALIB.greeting)).toBe(true);
  });
  it("다른 상품 답변은 쓰지 않는다 (맥시 문의에 안심퀸 답변 금지)", () => {
    const r = draft("사이즈 어떻게 골라요?", "맥시 텐셀 3장");
    expect(r.usedIds).toEqual([2]);
  });
  it("꺼둔 답변·유효기간 지난 답변은 쓰지 않는다", () => {
    expect(draft("사이즈 문의", null).usedIds).not.toContain(6);
    expect(draft("재입고 언제 되나요", null).usedIds).not.toContain(5);
  });
  it("발송 전 확인 조건이 있으면 ② 승인 + 조건 표시", () => {
    const r = draft("오배송 된 것 같아요 다른 제품이 왔어요", null);
    expect(r.route).toBe("approve");
    expect(r.conditions).toEqual(["재발송 확인 후 사용"]);
  });
  it("맞는 답변이 없으면 확인 후 안내 문구 + ② 승인", () => {
    const r = draft("손빨래 해야 하나요", "안심퀸 프리미엄");
    expect(r.route).toBe("approve");
    expect(r.usedIds).toEqual([]);
    expect(r.text).toContain("확인 후 빠르게 안내");
  });
  it("③ 사람 전용은 답변이 있어도 ③ 유지 (낮추지 않음)", () => {
    const r = draft("수술 후에 입어도 되나요? 사이즈는 95예요", "안심퀸 프리미엄");
    expect(r.route).toBe("human");
  });
  it("쿠팡은 ① 대상이어도 ②", () => {
    const r = draft("평소 95 사이즈 고르는 법", "안심퀸 프리미엄", { channel: "coupang" });
    expect(r.route).toBe("approve");
  });
  it("지식 DB 답변에 금지 표현이 있으면 ②로 올림", () => {
    const bad: KnowledgeEntry[] = [{ ...KB[2], id: 9, answer: "세탁해도 100% 새지 않습니다." }];
    const r = makeDraft({ channel: "smartstore", text: "세탁기 돌려도 되나요", productName: "방탄팬티", piiDetected: false }, bad, PRODUCTS);
    expect(r.route).toBe("approve");
    expect(r.forbidden.length).toBeGreaterThan(0);
  });
});
