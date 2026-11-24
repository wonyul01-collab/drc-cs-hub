import { describe, expect, it } from "vitest";
import { describeShape } from "../src/http.ts";

describe("응답 구조 요약 (점검용)", () => {
  it("값은 숨기고 이름·종류·건수만 보여준다", () => {
    const s = describeShape({
      contents: [{ questionId: 1, question: "고객 문의 원문", writerName: "홍길동" }],
      page: 1,
      totalElements: 37,
      timestamp: "2026-11-24T10:00:00",
    });
    expect(s).toContain("contents: 배열(1)");
    expect(s).toContain("totalElements: 37");
    expect(s).toContain("question: 글자");
    expect(s).not.toContain("고객 문의 원문");
    expect(s).not.toContain("홍길동");
  });
});
