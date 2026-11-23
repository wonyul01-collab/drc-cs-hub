import { describe, expect, it } from "vitest";
import { maskId, maskName, maskPii } from "../src/index.ts";

describe("개인정보 마스킹", () => {
  it("휴대폰 번호를 가린다", () => {
    const r = maskPii("연락은 010-1234-5678 또는 01098765432로 주세요");
    expect(r.text).toBe("연락은 [전화번호] 또는 [전화번호]로 주세요");
    expect(r.piiDetected).toBe(true);
    expect(r.piiTypes).toContain("phone");
  });
  it("이메일을 가린다", () => {
    expect(maskPii("hong@example.com 으로 보내주세요").text).toBe("[이메일] 으로 보내주세요");
  });
  it("계좌번호를 가린다", () => {
    expect(maskPii("환불 계좌 110-123-456789 입니다").text).toBe("환불 계좌 [계좌번호] 입니다");
  });
  it("도로명 주소를 가린다", () => {
    const r = maskPii("배송지를 테헤란로 123 5층으로 바꿔주세요");
    expect(r.text).toContain("[주소]");
    expect(r.text).not.toContain("123");
  });
  it("일반 문장은 그대로 두고 탐지 없음", () => {
    const r = maskPii("L 사이즈 허리둘레가 몇 cm인가요? 2개 주문하면 언제 와요?");
    expect(r.text).toBe("L 사이즈 허리둘레가 몇 cm인가요? 2개 주문하면 언제 와요?");
    expect(r.piiDetected).toBe(false);
  });
  it("이름·아이디 마스킹", () => {
    expect(maskName("홍길동")).toBe("홍*동");
    expect(maskName("김철")).toBe("김*");
    expect(maskName("남궁민수")).toBe("남**수");
    expect(maskId("abcd1234")).toBe("abc*****");
    expect(maskName(null)).toBeNull();
  });
});
