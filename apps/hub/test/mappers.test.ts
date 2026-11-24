import { describe, expect, it } from "vitest";
import { mapCoupangCallcenter, mapCoupangOnline } from "../src/coupang/sources.ts";
import { mapNaverOrderInquiry, mapNaverQna } from "../src/naver/sources.ts";

const NOW = "2026-11-24T01:00:00.000Z";

describe("쿠팡 응답 → 문의 변환", () => {
  it("상품문의: 미답변, 한국 시각 변환, 개인정보 마스킹", () => {
    const r = mapCoupangOnline(
      { inquiryId: 1001, sellerProductId: 55, content: "XL 있나요? 010-1111-2222로 연락주세요", inquiryAt: "2026-11-24 09:30:00", commentDtoList: [] },
      NOW,
    )!;
    expect(r.external_id).toBe("1001");
    expect(r.received_at).toBe("2026-11-24T00:30:00.000Z");
    expect(r.body_masked).toBe("XL 있나요? [전화번호]로 연락주세요");
    expect(r.pii_detected).toBe(true);
    expect(r.platform_answered).toBe(false);
    expect(r.can_reply).toBe(true);
  });

  it("상품문의: 이미 답변된 건은 추가 답변 금지 (쿠팡은 수정 불가)", () => {
    const r = mapCoupangOnline({ inquiryId: 1002, content: "세탁 가능?", inquiryAt: "2026-11-24 09:30:00", commentDtoList: [{ content: "네 가능합니다" }] }, NOW)!;
    expect(r.platform_answered).toBe(true);
    expect(r.can_reply).toBe(false);
    expect(r.platform_answer).toBe("네 가능합니다");
  });

  it("고객센터 문의: 24시간 기한, 판매자 답변 요청 상태일 때만 답변 가능", () => {
    const base = { inquiryId: 2001, content: "반품하고 싶어요", inquiryAt: "2026-11-24 10:00:00", orderId: 777 };
    const open = mapCoupangCallcenter({ ...base, inquiryStatus: "progress", partnerTransferStatus: "requestAnswer" }, NOW)!;
    expect(open.can_reply).toBe(true);
    expect(open.deadline_at).toBe("2026-11-25T01:00:00.000Z");
    expect(open.order_id).toBe("777");

    const notTransferred = mapCoupangCallcenter({ ...base, inquiryStatus: "progress", partnerTransferStatus: "none" }, NOW)!;
    expect(notTransferred.can_reply).toBe(false);

    const done = mapCoupangCallcenter({ ...base, inquiryStatus: "complete", partnerTransferStatus: "answered" }, NOW)!;
    expect(done.platform_answered).toBe(true);
    expect(done.can_reply).toBe(false);
  });

  it("ID 없는 항목은 버린다", () => {
    expect(mapCoupangOnline({ content: "?" }, NOW)).toBeNull();
  });
});

describe("네이버 응답 → 문의 변환", () => {
  it("상품문의", () => {
    const r = mapNaverQna({ questionId: 9, productId: 123, productName: "안심 요실금팬티", question: "L 허리둘레?", answered: false, createDate: "2026-11-24T10:00:00.000+09:00", maskedWriterId: "abcd****" }, NOW)!;
    expect(r.channel).toBe("smartstore");
    expect(r.kind).toBe("product_qna");
    expect(r.received_at).toBe("2026-11-24T01:00:00.000Z");
    expect(r.customer_masked).toBe("abc*****");
  });

  it("주문 문의: 고객 이름 마스킹", () => {
    // 2026-11-24 실측 응답 필드 그대로
    const r = mapNaverOrderInquiry({ inquiryNo: 55, category: "교환", title: "교환", inquiryContent: "사이즈 교환", inquiryRegistrationDateTime: "2026-11-20T14:00:00.000+09:00", customerId: "abc123", customerName: "홍길동", answered: true, answerContent: "확인했습니다", orderId: "2026112012345", productNo: "777", productName: "요실금팬티", productOrderOption: "사이즈: L" }, NOW)!;
    expect(r.customer_masked).toBe("홍*동");
    expect(r.received_at).toBe("2026-11-20T05:00:00.000Z");
    expect(r.meta).toMatchObject({ category: "교환", option: "사이즈: L" });
    expect(JSON.stringify(r)).not.toContain("abc123"); // 고객 아이디는 저장 안 함
    expect(r.platform_answered).toBe(true);
  });
});
