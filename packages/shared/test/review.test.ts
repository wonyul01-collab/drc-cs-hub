import { describe, expect, it } from "vitest";
import { analyzeReview, makeReviewDraft, SALIB } from "../src/index.ts";

const draft = (text: string, rating = 5, extra: Partial<Parameters<typeof makeReviewDraft>[0]> = {}) =>
  makeReviewDraft({ key: text, text, rating, reviewType: "일반", hasPhoto: false, ...extra });

describe("리뷰 분석 — 담당자 응대 규칙", () => {
  it("R05 가족관계: 하나일 때만, 시어머니·친정엄마 구분", () => {
    expect(analyzeReview("친정엄마 사드렸어요", 5).relation).toBe("어머님");
    expect(analyzeReview("시어머니 선물했어요", 5).relation).toBe("시어머님");
    expect(analyzeReview("할머니가 좋아하세요", 5).relation).toBe("할머님");
    expect(analyzeReview("엄마랑 아빠 하나씩 샀어요", 5).relation).toBeNull(); // 둘 이상이면 언급 안 함
  });
  it("R04 사용 전/사용 중 구분", () => {
    expect(analyzeReview("아직 안 입어봤어요 잘 입을게요", 5).usage).toBe("before");
    expect(analyzeReview("한 달째 잘 입고 있어요", 5).usage).toBe("using");
    expect(analyzeReview("입어보니 편하네요", 5).usage).toBe("using");
  });
  it("R04 재구매 했음 vs 앞으로 살 생각", () => {
    expect(analyzeReview("좋아서 재구매 했어요", 5)).toMatchObject({ repurchase: true, repurchaseIntent: false });
    expect(analyzeReview("재구매 의사 있습니다", 5)).toMatchObject({ repurchase: false, repurchaseIntent: true });
  });
  it("R09 구매 이유로 말한 '불편'은 불만이 아님", () => {
    expect(analyzeReview("기저귀가 불편해서 구입했는데 좋네요", 4).issues).toEqual([]);
    expect(analyzeReview("기저귀가 불편해서 구입했는데 좋네요", 4).comfort).toBe(false);
  });
  it("R09 실제 불만은 찾아내고 주의 리뷰", () => {
    const a = analyzeReview("편한데 바느질 부분이 배겨요", 4);
    expect(a.issues[0].id).toBe("seam");
    expect(a.caution).toBe(true);
  });
  it("별점 3점 이하는 주의 리뷰지만 불만을 지어내지 않음", () => {
    const a = analyzeReview("잘 받았어요", 3);
    expect(a.caution).toBe(true);
    expect(a.issues).toEqual([]);
  });
});

describe("리뷰 답글 초안", () => {
  it("고정 인사 + 후기 감사 + 본문 + 고정 마무리", () => {
    const d = draft("편하고 좋아요");
    expect(d.text.startsWith(`${SALIB.greeting}\n${SALIB.reviewThanks}\n\n`)).toBe(true);
    expect(d.text.endsWith("12:30~13:30 점심시간")).toBe(true);
  });
  it("R05 가족 선물 + 만족 → 가족 호칭으로 자연스럽게", () => {
    expect(draft("엄마가 좋아하세요").body).toMatch(/어머님/);
  });
  it("R04 아직 안 입은 선물에는 '잘 입고 계신다니' 쓰지 않음", () => {
    expect(draft("엄마 드리려고 샀어요 아직 안 입어보셨어요").body).not.toMatch(/입고\s*계신다니|만족하신다니/);
  });
  it("R06 '빠르다'는 말이 없으면 빠른 배송이라고 쓰지 않음", () => {
    expect(draft("배송 잘 받았습니다").body).not.toMatch(/빠른|빠르/);
    expect(draft("빠른 배송 감사합니다").body).toMatch(/빠른|빠르/);
  });
  it("R08 사진은 실제로 있을 때만 언급", () => {
    for (let i = 0; i < 20; i++) expect(draft(`편해요 ${i}`, 5, { hasPhoto: false }).body).not.toMatch(/사진/);
  });
  it("R22 가격 불만에 할인 약속 없음 · R09 사과와 개선 안내", () => {
    const d = draft("잘 입고 있는데 가격만 조금 내리면 좋겠어요", 4);
    expect(d.body).toMatch(/죄송/);
    expect(d.body).not.toMatch(/할인|내려\s*드리/);
    expect(d.forbidden).toEqual([]);
  });
  it("가족이 전한 불만일 때만 가족을 주어로 (R05)", () => {
    expect(draft("엄마 드렸는데 좀 두껍다 하시네요").body).toMatch(/^어머님께서 두께감/);
    expect(draft("엄마 드릴 건데 색이 좀 짙어요").body).not.toMatch(/어머님께서 색상/);
  });
  it("같은 상품에 같은 문장 반복 금지 (최근 쓴 문장 피함)", () => {
    const first = draft("배송 잘 받았습니다");
    const second = makeReviewDraft({ key: "다른 리뷰", text: "배송 잘 받았습니다", rating: 5, reviewType: "일반", hasPhoto: false, recentTemplateIds: first.templateIds });
    expect(second.body).not.toBe(first.body);
  });
  it("같은 리뷰는 항상 같은 초안 (다시 만들어도 흔들리지 않음)", () => {
    expect(draft("편하고 좋아요").body).toBe(draft("편하고 좋아요").body);
  });
  it("한달사용 후기는 다시 남겨주신 것에 감사", () => {
    expect(draft("한 달 잘 썼어요", 5, { reviewType: "한달사용" }).body).toMatch(/다시 후기/);
  });
});
