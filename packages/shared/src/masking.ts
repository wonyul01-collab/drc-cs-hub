/**
 * 개인정보 마스킹 — 고객 문의 본문을 DB·화면·알림에 넣기 전에 가린다.
 * 탐지 여부(piiDetected)는 이후 Phase에서 「③ 사람 전용」 분류 근거로 쓴다.
 */

const PATTERNS: Array<{ name: string; re: RegExp; replace: (m: string) => string }> = [
  // 이메일
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replace: () => "[이메일]" },
  // 휴대폰·전화번호 (010-1234-5678, 01012345678, 02-123-4567, 공백 구분 포함)
  { name: "phone", re: /(?<!\d)(0\d{1,2})[-.\s]?(\d{3,4})[-.\s]?(\d{4})(?!\d)/g, replace: () => "[전화번호]" },
  // 주민등록번호
  { name: "rrn", re: /(?<!\d)\d{6}[-\s]?[1-4]\d{6}(?!\d)/g, replace: () => "[주민번호]" },
  // 계좌번호처럼 보이는 긴 숫자열 (하이픈 포함 10~16자리)
  { name: "account", re: /(?<!\d)\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,4})?(?!\d)/g, replace: () => "[계좌번호]" },
  // 주소: 「~로/길 + 번지」 형태
  { name: "address", re: /[가-힣]+(?:로|길)\s?\d+(?:[-번]\s?\d+)?(?:\s?[가-힣0-9]+(?:동|호|층))*/g, replace: () => "[주소]" },
];

export interface MaskResult {
  text: string;
  piiDetected: boolean;
  piiTypes: string[];
}

export function maskPii(input: string | null | undefined): MaskResult {
  let text = (input ?? "").toString();
  const types = new Set<string>();
  for (const p of PATTERNS) {
    text = text.replace(p.re, (m) => {
      types.add(p.name);
      return p.replace(m);
    });
  }
  return { text, piiDetected: types.size > 0, piiTypes: [...types] };
}

/** 이름 마스킹: 홍길동 → 홍*동, 김철 → 김*, 남궁민수 → 남**수, 영문 → J***n */
export function maskName(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name.trim();
  if (n.length <= 1) return "*";
  if (n.length === 2) return n[0] + "*";
  return n[0] + "*".repeat(n.length - 2) + n[n.length - 1];
}

/** 아이디 마스킹: abcd1234 → abc***** */
export function maskId(id: string | null | undefined): string | null {
  if (!id) return null;
  const s = id.trim();
  if (s.length <= 3) return s[0] + "*".repeat(Math.max(s.length - 1, 1));
  return s.slice(0, 3) + "*".repeat(s.length - 3);
}
