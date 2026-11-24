/**
 * 금지 표현 검사기 — 걸리면 자동 등록 차단(사람 확인 필요).
 * 근거: 의료기기·건강 표현 규칙(개발 요구사항 9장), 담당자 응대 규칙 R15·R21·R22·R23.
 */
export interface ForbiddenRule {
  id: string;
  label: string;
  re: RegExp;
}

export const FORBIDDEN_RULES: ForbiddenRule[] = [
  { id: "cure", label: "치료·완치 효과 단정", re: /완치|치료(?:해|됩|되|합|효과|가\s*됩)|낫(?:습니다|게|아요)|고쳐/ },
  { id: "prevent", label: "질환 예방 효과 단정", re: /예방(?:합니다|됩니다|효과|해\s*드)/ },
  { id: "medical", label: "의학적 효능 표현", re: /의학적|임상적으로\s*(?:입증|증명)|효능/ },
  { id: "absolute", label: "100%·절대 보장 표현", re: /100\s*%|백\s*퍼센트|절대(?:로)?\s*(?:안|없|새지)|무조건|완벽(?:하게|히)?\s*(?:막|차단|방지)/ },
  { id: "no-side-effect", label: "부작용 없음 단정", re: /부작용(?:이)?\s*(?:전혀\s*)?없/ },
  { id: "no-leak", label: "샘·누수 없음 보장 (R21)", re: /(?:절대|전혀|하나도)\s*(?:안\s*)?새(?:지|어)?\s*(?:않|없)|샘(?:이)?\s*(?:전혀\s*)?없(?:습니다|어요|음)|누수(?:가)?\s*(?:전혀\s*)?없/ },
  { id: "stool", label: "대변·변실금 흡수 보장 (R21)", re: /(?:대변|변실금)[^.\n]{0,15}(?:흡수|막아|가능)/ },
  { id: "permanent", label: "기능 영구·기간 보장 (R15)", re: /영구(?:적)?|평생|반영구|\d+\s*개월\s*(?:동안\s*)?(?:유지|지속)\s*(?:됩|보장)/ },
  { id: "discount-promise", label: "할인·가격 인하 약속 (R22)", re: /할인(?:해\s*드리겠|해드릴게|약속)|가격(?:을)?\s*(?:내려|인하해)\s*드리/ },
  { id: "internal", label: "내부 판단·규칙 노출 (R23)", re: /지식\s*DB|규칙\s*R\d|분류\s*결과|AI\s*(?:가|초안)|자동\s*생성/ },
];

export interface ForbiddenHit {
  id: string;
  label: string;
  match: string;
}

export function checkForbidden(text: string): ForbiddenHit[] {
  const hits: ForbiddenHit[] = [];
  for (const r of FORBIDDEN_RULES) {
    const m = r.re.exec(text);
    if (m) hits.push({ id: r.id, label: r.label, match: m[0] });
  }
  return hits;
}
