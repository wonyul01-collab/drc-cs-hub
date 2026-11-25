/**
 * 브랜드 고정 문구 — 담당자 응대 규칙 R01, 수정이력 F13~F19·F32 기준.
 * "고정 인사말로 시작하고 고정 문의 안내 전문으로 끝낸다. 줄 간격은 기존 형식대로. 고정 안내 사이에 빈 줄 금지."
 * (원본: SALIB_CS_dataset.xlsx 「문의FAQ」 권장 답변 전문)
 */
export interface BrandText {
  name: string;
  greeting: string;
  /** 리뷰 답글에서 인사말 바로 다음 줄 */
  reviewThanks: string;
  closing: string;
}

export const SALIB: BrandText = {
  name: "샐리브",
  greeting: "안녕하세요 ! 현대 여성의 자유를 선사하는 기능성 언더웨어 전문 브랜드 샐리브입니다😊",
  reviewThanks: "소중한 후기 남겨주셔서 감사합니다!",
  closing: [
    "이외 문의 사항 있으시면 언제든지 편하실때 문의 부탁드립니다😊",
    "♥ 상담톡 연결 방법",
    "-카카오톡 친구 목록 상단[@샐리브 검색] > 1:1 채팅하기 > 상품문의 > 상담원 연결하기",
    "♥ 샐리브 고객센터 유선연결",
    "-02-862-1237",
    "♥ 운영시간 안내",
    "-고객센터 : 09:00~17:00 (주말&공휴일 제외) / 12:30~13:30 점심시간",
  ].join("\n"),
};

/**
 * 문의 답변: 본문만 (고정 인사·마무리 없음 — 2026-11-25 담당자 결정: 고정 문구는 리뷰 답글에만)
 */
export function composeInquiryReply(body: string, _brand: BrandText = SALIB): string {
  return body.trim();
}

/** 리뷰 답글: 인사말 ⏎ 후기 감사 ⏎⏎ 본문 ⏎⏎ 마무리 전문 */
export function composeReviewReply(body: string, brand: BrandText = SALIB): string {
  return `${brand.greeting}\n${brand.reviewThanks}\n\n${body.trim()}\n\n${brand.closing}`;
}

/** 고정 문구가 빠지거나 바뀌지 않았는지 검사 — 리뷰 답글에만 사용 (수정이력 F13·F14) */
export function checkFixedText(text: string, brand: BrandText = SALIB): string[] {
  const problems: string[] = [];
  if (!text.startsWith(brand.greeting)) problems.push("첫 줄 고정 인사말이 빠졌거나 바뀌었습니다.");
  if (!text.trimEnd().endsWith(brand.closing)) problems.push("마지막 고정 안내 문구(상담톡·고객센터·운영시간)가 빠졌거나 바뀌었습니다.");
  return problems;
}

/** 고정 문구를 떼고 본문만 꺼내기 (기존 답변 가져올 때 사용) */
export function stripFixedText(text: string, brand: BrandText = SALIB): string {
  let t = text.replace(/\r\n/g, "\n").trim();
  if (t.startsWith(brand.greeting)) t = t.slice(brand.greeting.length);
  t = t.trim();
  if (t.startsWith(brand.reviewThanks)) t = t.slice(brand.reviewThanks.length);
  const i = t.indexOf(brand.closing.split("\n")[0]);
  if (i >= 0) t = t.slice(0, i);
  return t.trim();
}
