/**
 * 지식 DB 기반 답변 초안 (외부 AI 없음)
 *  1) 문의 분류(classify.ts)  2) 상품 식별  3) 지식 항목 점수 매기기
 *  4) 고정 인사 + 표준 답변 + 고정 마무리  5) 금지 표현·고정문구·글자 수 검사  6) 최종 처리 경로
 */
import { composeInquiryReply, checkFixedText, SALIB, type BrandText } from "./brand.ts";
import { AUTO_RULES, classifyText, type Classification, type Route } from "./classify.ts";
import { checkForbidden, type ForbiddenHit } from "./forbidden.ts";
import type { Channel } from "./types.ts";

export interface KnowledgeEntry {
  id: number;
  title: string;
  /** 분류 id (size, wash, material, usage, exchange, wrong, ...) */
  category: string;
  /** 적용 상품 이름들. 비어 있으면 전체 상품 */
  products: string[];
  keywords: string[];
  /** 고정 인사·마무리를 뺀 본문 */
  answer: string;
  /** 발송 전 확인 조건 (있으면 담당자 화면에 경고로 표시) */
  conditions: string | null;
  /** 이 항목으로 만든 초안의 최소 처리 경로 (예: approve면 ①이 될 수 없음) */
  minRoute: Route;
  active: boolean;
  /** "YYYY-MM-DD" 이후 비활성 (재입고 일정 등) */
  validUntil: string | null;
}

export interface ProductInfo {
  name: string;
  aliases: string[];
}

export interface DraftInput {
  channel: Channel;
  text: string;
  productName: string | null;
  piiDetected: boolean;
  priorComplaints?: number;
  today?: string;
}

export interface KnowledgeMatch {
  id: number;
  title: string;
  score: number;
  why: string[];
}

export interface DraftResult {
  route: Route;
  classification: Classification;
  products: string[];
  matches: KnowledgeMatch[];
  /** 초안에 사용한 지식 항목 */
  usedIds: number[];
  text: string;
  confidence: number;
  conditions: string[];
  forbidden: ForbiddenHit[];
  warnings: string[];
  reasons: string[];
}

/** 쿠팡 답변 2~1,000자 (공식 문서). 네이버는 공식 수치 미확인 → 같은 기준으로 경고 */
export const MAX_REPLY_LENGTH = 1000;
export const AUTO_CONFIDENCE = 0.85;
/** 이보다 낮게 맞는 답변은 초안에 넣지 않고 '확인 후 안내' 문구를 쓴다 */
export const USE_MIN_SCORE = 0.55;
const ROUTE_RANK: Record<Route, number> = { auto: 0, approve: 1, human: 2 };
const FALLBACK_BODY = "문의주신 내용 확인 후 빠르게 안내드리겠습니다. 조금만 기다려주시면 감사하겠습니다.";

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** 상품명·문의 내용에서 우리 상품 찾기 (이름·별칭, 띄어쓰기 무시). 긴 이름 우선 */
export function identifyProducts(text: string, productName: string | null, products: ProductInfo[]): string[] {
  const hay = norm(`${productName ?? ""} ${text}`);
  const found: string[] = [];
  const sorted = [...products].sort((a, b) => b.name.length - a.name.length);
  for (const p of sorted) {
    const names = [p.name, ...p.aliases].map(norm).filter(Boolean);
    if (names.some((n) => hay.includes(n)) && !found.some((f) => norm(f).includes(norm(p.name)))) found.push(p.name);
  }
  return found;
}

export function scoreKnowledge(
  entry: KnowledgeEntry,
  text: string,
  cls: Classification,
  products: string[],
  today: string,
): KnowledgeMatch | null {
  if (!entry.active) return null;
  if (entry.validUntil && entry.validUntil < today) return null;
  const why: string[] = [];
  let score = 0;

  const catHit = cls.matched.includes(entry.category);
  if (catHit) {
    score += 0.4;
    why.push("질문 유형 일치");
  }

  if (entry.products.length) {
    const hit = entry.products.some((p) => products.includes(p));
    // 다른 상품용 답변, 또는 상품을 모르는데 특정 상품용 답변 → 쓰지 않음 (엉뚱한 상품 안내 방지)
    if (!hit) return null;
    if (hit) {
      score += 0.3;
      why.push("상품 일치");
    }
  } else {
    score += 0.15;
    why.push("전체 상품 공통");
  }

  const t = norm(text);
  const kw = entry.keywords.filter((k) => k.trim() && t.includes(norm(k)));
  if (kw.length) {
    score += Math.min(0.3, kw.length * 0.15);
    why.push(`키워드: ${kw.join(", ")}`);
  }

  if (!catHit && kw.length < 2) return null;
  return { id: entry.id, title: entry.title, score: Math.min(1, Math.round(score * 100) / 100), why };
}

export function makeDraft(
  input: DraftInput,
  knowledge: KnowledgeEntry[],
  products: ProductInfo[],
  brand: BrandText = SALIB,
): DraftResult {
  const today = input.today ?? new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const cls = classifyText({ channel: input.channel, text: input.text, piiDetected: input.piiDetected, priorComplaints: input.priorComplaints });
  const found = identifyProducts(input.text, input.productName, products);
  const byId = new Map(knowledge.map((k) => [k.id, k]));
  // 문의의 "대표 유형"과 같은 유형의 답변을 먼저, 그다음 점수 순
  // (예: 오배송 문의에 상품명 속 '소취' 때문에 소취 설명이 붙는 것 방지)
  const primary = (m: KnowledgeMatch) => (byId.get(m.id)!.category === cls.category ? 1 : 0);
  const matches = knowledge
    .map((k) => scoreKnowledge(k, input.text, cls, found, today))
    .filter((m): m is KnowledgeMatch => !!m && m.score >= USE_MIN_SCORE)
    .sort((a, b) => primary(b) - primary(a) || b.score - a.score);

  // 가장 잘 맞는 항목 1개. 단, 둘 다 단순 안내(사이즈·세탁·소재·사용법)이고 유형이 다르면 2개까지 합침
  const INFO = new Set(AUTO_RULES.map((r) => r.id));
  const used: KnowledgeEntry[] = [];
  const usedScores: number[] = [];
  for (const m of matches) {
    const k = byId.get(m.id)!;
    if (!used.length) {
      used.push(k);
      usedScores.push(m.score);
    } else if (used.length < 2 && m.score >= 0.7 && INFO.has(k.category) && INFO.has(used[0].category) && k.category !== used[0].category) {
      used.push(k);
      usedScores.push(m.score);
    }
  }

  const body = used.length ? used.map((k) => k.answer.trim()).join("\n\n") : FALLBACK_BODY;
  const text = composeInquiryReply(body, brand);
  const confidence = usedScores.length ? Math.min(...usedScores) : 0;
  const forbidden = checkForbidden(body);
  const warnings = [...checkFixedText(text, brand)];
  if (text.length > MAX_REPLY_LENGTH) warnings.push(`답변이 ${text.length}자로 마켓 제한(${MAX_REPLY_LENGTH}자)을 넘습니다. 줄여주세요.`);
  if (!found.length) warnings.push("어떤 상품 문의인지 확인되지 않았습니다.");
  const conditions = used.map((k) => k.conditions).filter((c): c is string => !!c && !!c.trim());

  // 최종 경로: 분류 경로에서 시작해 "올리기"만 한다 (낮추지 않음)
  let route: Route = cls.route;
  const reasons = [...cls.reasons];
  const raise = (to: Route, why: string) => {
    if (ROUTE_RANK[to] > ROUTE_RANK[route]) route = to;
    reasons.push(why);
  };
  if (route === "auto") {
    if (!used.length) raise("approve", "지식 DB에 맞는 답변이 없음 → 승인 필요");
    else if (confidence < AUTO_CONFIDENCE) raise("approve", `일치도 ${Math.round(confidence * 100)}% (자동 기준 ${AUTO_CONFIDENCE * 100}% 미만) → 승인 필요`);
  }
  for (const k of used) if (ROUTE_RANK[k.minRoute] > ROUTE_RANK.auto) raise(k.minRoute, `「${k.title}」 답변은 담당자 확인 후 사용하도록 지정됨`);
  if (conditions.length) raise("approve", "발송 전 확인 조건이 있는 답변 → 승인 필요");
  if (forbidden.length) raise("approve", `금지 표현 발견: ${forbidden.map((f) => f.label).join(", ")}`);
  if (warnings.some((w) => w.includes("고정") || w.includes("제한"))) raise("approve", "고정 문구·글자 수 문제 → 승인 필요");

  return {
    route,
    classification: cls,
    products: found,
    matches: matches.slice(0, 5),
    usedIds: used.map((k) => k.id),
    text,
    confidence,
    conditions,
    forbidden,
    warnings,
    reasons,
  };
}
