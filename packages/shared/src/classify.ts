/**
 * 문의 분류 — 규칙 기반 (외부 AI 없음).
 *
 * 처리 경로
 *  ① auto     : 자동 처리 가능 (지금은 "후보" 표시만 — 실제 자동 등록은 Phase 5에서 담당자가 켤 때)
 *  ② approve  : 담당자 승인 후 등록
 *  ③ human    : 사람 전용 — 초안은 참고용, 자동 등록 경로 자체 차단
 *
 * 규칙이 항상 우선: ③ 키워드가 하나라도 있으면 다른 판단과 상관없이 ③.
 * 근거: 개발 요구사항 8장 + 담당자 응대 규칙 R25 ("재고·배송·환불·교환·불량·건강 문의는 사람 확인 전 자동 발송 금지")
 */
import type { Channel } from "./types.ts";

export type Route = "auto" | "approve" | "human";

export const ROUTE_LABEL: Record<Route, string> = {
  auto: "① 자동 가능",
  approve: "② 승인 필요",
  human: "③ 사람 전용",
};

export interface CategoryRule {
  id: string;
  label: string;
  route: Route;
  keywords: RegExp;
}

/** ③ 사람 전용 */
export const HUMAN_RULES: CategoryRule[] = [
  {
    id: "health",
    label: "건강·의료",
    route: "human",
    keywords:
      /증상|질환|질병|수술|병원|의사|진료|처방|치료|효능|의학|피부|발진|두드러기|가려(?:워|움|운)|간지러|알레르기|알러지|트러블|부작용|염증|상처|짓무|진물|따가|쓰라|통증|아파|아프|전립선|방광|변실금|대변|임신|출산|산후|치매|욕창|당뇨|암\s*환자|항암|재활/,
  },
  { id: "welfare", label: "복지용구·장기요양", route: "human", keywords: /복지\s*용구|장기\s*요양|요양\s*등급|등급\s*판정|본인\s*부담|급여\s*(?:품목|대상|적용)|공단|바우처/ },
  { id: "dispute", label: "분쟁·신고", route: "human", keywords: /소비자\s*(?:원|보호)|고발|신고(?:하|할)|소송|변호사|고소|언론|기자|방송|제보|민원|공정위|사기|법적/ },
  { id: "abuse", label: "욕설·위협", route: "human", keywords: /씨발|시발|ㅅㅂ|ㅆㅂ|개새|병신|ㅂㅅ|존나|좆|꺼져|죽(?:여|일)|가만\s*안\s*둬/ },
];

/** ② 승인 필요 */
export const APPROVE_RULES: CategoryRule[] = [
  { id: "exchange", label: "교환·반품·환불·취소", route: "approve", keywords: /교환|반품|환불|취소|반송|회수|수거|돌려\s*(?:보내|받)/ },
  { id: "wrong", label: "오배송·누락", route: "approve", keywords: /오배송|잘못\s*(?:온|왔|배송|보내)|다른\s*(?:제품|상품|색|사이즈)(?:이|가)?\s*(?:왔|와)|(?:알\s*수\s*없는|엉뚱한|이상한)[^.?!]{0,6}(?:제품|상품)|(?:제품|상품)이\s*왔(?:네|어|는데)|누락|빠져\s*(?:있|왔)|안\s*(?:들어|왔)|덜\s*왔|맞는지\s*확인/ },
  { id: "defect", label: "불량·파손", route: "approve", keywords: /불량|파손|찢어|뜯어져|터졌|터져|구멍|하자|실밥|박음질|오염|얼룩|냄새(?:가)?\s*(?:너무\s*|많이\s*|좀\s*|계속\s*)?(?:심|나)/ },
  { id: "delivery", label: "배송·출고", route: "approve", keywords: /배송(?!비)|택배|출고|발송|도착|언제\s*(?:와|오|받)|송장|운송장/ },
  { id: "stock", label: "재고·재입고", route: "approve", keywords: /재고|재입고|품절|입고\s*(?:예정|언제)/ },
  { id: "complaint", label: "불만·아쉬움", route: "approve", keywords: /효과(?:가|는)?\s*없|별로|실망|불만|아쉬|불편(?:해|하|했)|안\s*좋|달라(?:요|졌|진)|다른\s*것\s*같|(?:예전|작년|전에\s*산)[^.?!]{0,10}(?:이랑|과|보다|하고)|문제(?:가|있)/ },
  { id: "price", label: "가격·할인·대량구매", route: "approve", keywords: /가격|할인|쿠폰|적립|비싸|대량|단체|납품|도매|b2b|견적|제휴|세금\s*계산서|사업자|기관/i },
];

/** ① 자동 가능 후보 (지식 DB 근거가 있어야 ①) */
export const AUTO_RULES: CategoryRule[] = [
  { id: "size", label: "사이즈", route: "auto", keywords: /사이즈|치수|호수|\b(?:S|M|L|XL|XXL|2XL|3XL)\b|(?:85|90|95|100|105|110|115|120)\s*(?:사이즈|호|입|으로|이면|인데|를|요)|허리\s*둘레|작(?:아|은|게)|크(?:게|다|ㄴ|면)|넉넉|타이트|끼(?:어|는|다)/i },
  { id: "wash", label: "세탁·관리", route: "auto", keywords: /세탁|빨(?:아|래|면|았)|손빨래|건조|드라이|삶아|표백|섬유\s*유연제|세탁망|세탁기/ },
  { id: "material", label: "소재·기능", route: "auto", keywords: /소재|원단|면\s*(?:재질|100)|텐셀|모달|오가닉|흡수(?:량|력)?|\d+\s*ml|패드|소취|냄새|항균|통기|방수|샘\s*방지|흡습\s*속건/i },
  { id: "usage", label: "사용법·제품 선택", route: "auto", keywords: /사용\s*(?:법|방법)|착용\s*(?:법|방법)|어떻게\s*(?:입|사용|착용)|추천|어떤\s*(?:제품|상품|걸)|차이|비교|남성용|여성용|생리/ },
];

export const ALL_RULES = [...HUMAN_RULES, ...APPROVE_RULES, ...AUTO_RULES];

export interface ClassifyInput {
  channel: Channel;
  text: string;
  piiDetected: boolean;
  /** 같은 고객·주문에서 이전 불만 문의 수 (교환·불량·오배송 등) */
  priorComplaints?: number;
}

export interface Classification {
  route: Route;
  /** 대표 분류 id (예: size, exchange, health, other) */
  category: string;
  categoryLabel: string;
  /** 걸린 분류 전부 */
  matched: string[];
  reasons: string[];
}

/** 문의 내용을 보고 분류 (지식 DB 매칭 전 단계) */
export function classifyText(input: ClassifyInput): Classification {
  const text = input.text.replace(/\s+/g, " ");
  const hit = (rules: CategoryRule[]) => rules.filter((r) => r.keywords.test(text));
  const human = hit(HUMAN_RULES);
  const approve = hit(APPROVE_RULES);
  const auto = hit(AUTO_RULES);
  const matched = [...human, ...approve, ...auto].map((r) => r.id);
  const reasons: string[] = [];

  // ③ 사람 전용
  if (human.length || input.piiDetected || (input.priorComplaints ?? 0) >= 2) {
    for (const r of human) reasons.push(`${r.label} 관련 표현 → 사람 전용`);
    if (input.piiDetected) reasons.push("문의에 개인정보(전화번호·주소·계좌 등) 포함 → 사람 전용");
    if ((input.priorComplaints ?? 0) >= 2) reasons.push(`같은 주문에서 불만 문의 ${input.priorComplaints}회 → 사람 전용`);
    const top = human[0] ?? approve[0] ?? auto[0];
    return { route: "human", category: top?.id ?? "other", categoryLabel: top?.label ?? "기타", matched, reasons };
  }

  // ② 승인 필요
  if (approve.length) {
    for (const r of approve) reasons.push(`${r.label} 문의 → 사람 확인 후 답변 (응대 규칙 R25)`);
    return { route: "approve", category: approve[0].id, categoryLabel: approve[0].label, matched, reasons };
  }

  if (auto.length) {
    reasons.push(`${auto.map((r) => r.label).join("·")} 문의`);
    const base: Classification = { route: "auto", category: auto[0].id, categoryLabel: auto[0].label, matched, reasons };
    if (input.channel === "coupang") {
      base.route = "approve";
      reasons.push("쿠팡은 답변 수정이 불가해 처음엔 모두 승인 필요");
    }
    return base;
  }

  reasons.push("분류할 수 있는 키워드가 없음 → 사람 확인");
  return { route: "approve", category: "other", categoryLabel: "기타", matched, reasons };
}
