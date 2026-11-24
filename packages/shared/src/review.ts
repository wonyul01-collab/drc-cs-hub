/**
 * 리뷰 답글 초안 (외부 AI 없음) — 담당자 응대 규칙 기준
 *  R03 고객 문장 되풀이 금지 · R04 사용 전/예정/사용 중 구분 · R05 가족관계 정확히(불명확하면 언급 안 함)
 *  R06 사실 반대로 해석 금지(빠르다는 말 없으면 '빠른 배송' 금지) · R07 감사 1~2회, 평가하는 어투 금지
 *  R08 긍정 리뷰는 한두 문장, 사진 있을 때만 사진 언급 · R09 별점 낮아도 불만 지어내지 않음, 불만이 있으면 사과·공감·안내
 *  R21 효능·누수 없음 단정 금지 · R22 가격 불만에 할인 약속 금지
 *  승인된 톤 예시(F26): "아버지께서 편하게 잘 사용하고 계신다니 다행이에요🙂 재구매까지 생각해주셨다니 더 감사드립니다!"
 */
import { composeReviewReply, SALIB, type BrandText } from "./brand.ts";
import { checkForbidden, type ForbiddenHit } from "./forbidden.ts";

export interface ReviewInput {
  key: string;
  text: string;
  rating: number | null;
  /** 한달사용 등 */
  reviewType: string | null;
  hasPhoto: boolean;
  /** 같은 상품에 최근 쓴 문장 id (반복 방지) */
  recentTemplateIds?: string[];
}

export interface ReviewAnalysis {
  relation: string | null;
  usage: "before" | "using" | "unknown";
  satisfied: boolean;
  repurchase: boolean;
  /** 앞으로 재구매할 생각 */
  repurchaseIntent: boolean;
  delivery: boolean;
  fastDelivery: boolean;
  comfort: boolean;
  exercise: boolean;
  issues: Array<{ id: string; label: string; phrase: string; needsSupport: boolean }>;
  /** 불만을 말한 사람이 가족인가 (예: "두껍다 하시네요") */
  issueByRelation: boolean;
  caution: boolean;
  cautionReasons: string[];
}

export interface ReviewDraft {
  text: string;
  body: string;
  templateIds: string[];
  analysis: ReviewAnalysis;
  forbidden: ForbiddenHit[];
}

// 가족관계 (R05) — 하나만 확실할 때만 사용
const RELATIONS: Array<{ label: string; re: RegExp }> = [
  { label: "시어머님", re: /시어머니|시어머님|시모/ },
  { label: "시아버님", re: /시아버지|시아버님/ },
  { label: "할머님", re: /할머니|할머님/ },
  { label: "할아버님", re: /할아버지|할아버님/ },
  { label: "어머님", re: /(?<!시)(?:엄마|어머니|어머님|친정\s*엄마|모친)/ },
  { label: "아버님", re: /(?<!시)(?:아빠|아버지|아버님|친정\s*아빠|부친)/ },
  { label: "남편분", re: /남편|신랑/ },
  { label: "아내분", re: /아내|와이프|집사람/ },
];

const BEFORE = /아직[^.!?]{0,8}(?:안|못|전)|입기\s*전|착용\s*전|사용\s*전|입어\s*볼|입어볼|잘\s*입을|잘입을|입어\s*보겠|입혀\s*볼|써\s*볼|한달\s*후기\s*남길|후기\s*남길/;
const USING = /입어\s*보고|입고\s*(?:있|다니|계)|잘\s*입|잘입|잘\s*쓰|잘쓰|사용\s*(?:하고|중|해보니|해\s*보니)|착용\s*(?:하고|중|해보니|해\s*보니|했)|입어\s*보니|입어보니|입으니|입었|입혀\s*보니|신고|한\s*달|한달|계속\s*입/;
const SATISFIED = /좋아하|만족|좋다고|좋으시|좋다\s*하|좋대|마음에\s*(?:드|들)|(?<!불)편하다|(?<!불)편하시|좋아서|좋네|좋아요|좋습니다|좋구요|좋으네|최고|딱\s*찾던|강추|추천/;
/** 앞으로 살 생각 (R04: 이미 재구매한 것과 구분) */
const REPURCHASE_INTENT = /재구매\s*(?:의사|할|하고\s*싶|예정|각)|또\s*(?:살|사야|구매할)|더\s*(?:사고\s*싶|살\s)|구매해야겠|사야겠|사려고요/;
const REPURCHASE = /재구매|재주문|다시\s*(?:구매|주문|샀|삽|사)|또\s*(?:구매|주문|샀|사)|두\s*번째|두번째|추가\s*(?:구매|주문)|한\s*번\s*더|한번더|또\s*시켰/;
const DELIVERY = /배송|택배|잘\s*받았|잘받았|도착|받았습니다|받았어요/;
const FAST = /빠른\s*배송|빠르|빨리|하루\s*만에|금방\s*(?:왔|도착)/;
const COMFORT = /(?<!불)편하|(?<!불)편안|(?<!불)편해|부드럽|착용감|가볍|얇|쫀쫀|촉감|포근/;
const EXERCISE = /운동|헬스|등산|요가|필라테스|걷기/;

// 불만·아쉬움 (R09) — 고객이 실제로 말한 것만
const ISSUES: Array<{ id: string; label: string; re: RegExp; phrase: string; needsSupport: boolean }> = [
  { id: "pad", label: "패드", re: /패드[^.!?]{0,15}(?:덜|얇|두껍|무겁|불편|다르)|(?:저번|지난번|예전|전에)[^.!?]{0,25}(?:다르|덜|얇|불편)/, phrase: "패드가 이전과 다르게 느껴지셨다니", needsSupport: true },
  { id: "tight", label: "조이는 착용감", re: /쪼여|조여|조이|끼어|끼는|꽉\s*끼|타이트/, phrase: "착용감이 답답하게 느껴지셨다니", needsSupport: true },
  { id: "seam", label: "봉제 부분", re: /바느질|박음질|연결\s*부분|배기|실밥/, phrase: "봉제 부분이 불편하셨다니", needsSupport: true },
  { id: "stiff", label: "원단 촉감", re: /뻣뻣|부드럽지\s*않|거칠|까슬/, phrase: "원단 촉감이 아쉬우셨다니", needsSupport: false },
  { id: "thick", label: "두께", re: /두껍다|두꺼워|두껍고|좀\s*두껍|너무\s*두껍/, phrase: "두께감이 생각과 다르셨다니", needsSupport: false },
  { id: "fit", label: "맞음새", re: /뜨는|들뜨|짧습|짧아|짧은|헐렁|커서|작아서|사이즈가\s*안|안\s*맞|안맞/, phrase: "착용하실 때 불편하셨다니", needsSupport: true },
  { id: "heavy", label: "무게감", re: /무겁/, phrase: "무게감이 불편하게 느껴지셨다니", needsSupport: false },
  { id: "color", label: "색상", re: /색(?:상|깔)?[^.!?]{0,12}(?:짙|진하|다르|어둡)/, phrase: "색상이 생각과 다르셨다니", needsSupport: false },
  { id: "color2", label: "색상 조합", re: /좀\s*튀|같은\s*색이(?:었|였)으면/, phrase: "색상 조합이 아쉬우셨다니", needsSupport: false },
  { id: "pack", label: "포장", re: /포장[^.!?]{0,15}(?:부족|아쉽|아쉬|별로|허술)/, phrase: "포장이 아쉬우셨다니", needsSupport: false },
  { id: "price", label: "가격", re: /가격만|비싸|가격이\s*(?:좀|조금)?\s*(?:높|부담)|가격\s*(?:좀|조금)\s*내/, phrase: "가격이 부담되셨다니", needsSupport: false },
  { id: "soldout", label: "품절", re: /품절/, phrase: "원하시는 상품이 품절이라 불편을 드려", needsSupport: false },
  { id: "uncomfortable", label: "불편함", re: /불편|별로|아쉬|실망|불만/, phrase: "불편하신 점이 있으셨다니", needsSupport: true },
];

/** 리뷰 내용 분석 */
export function analyzeReview(text: string, rating: number | null): ReviewAnalysis {
  const t = text.replace(/\s+/g, " ");
  // 구매 이유로 말한 '불편'(예: 라이너가 불편해서 구입) 은 불만이 아님 (R09)
  const forIssues = t.replace(/불편(?:해서|해|하여|하던\s*차에)\s*(?:구입|구매|샀|주문|사게)/g, " ").replace(/걱정했는데[^.!?]{0,15}좋/g, " ");
  const rels = RELATIONS.filter((r) => r.re.test(t)).map((r) => r.label);
  const relation = rels.length === 1 ? rels[0] : null;
  const before = BEFORE.test(t);
  const using = USING.test(t);
  const usage: ReviewAnalysis["usage"] = before && !/입어\s*보니|입어보니|입으니/.test(t) ? "before" : using ? "using" : "unknown";
  const found: ReviewAnalysis["issues"] = [];
  for (const i of ISSUES) {
    if (!i.re.test(forIssues)) continue;
    if (i.id === "uncomfortable" && found.length) continue; // 구체적인 불만이 있으면 일반 표현은 생략
    found.push({ id: i.id, label: i.label, phrase: i.phrase, needsSupport: i.needsSupport });
  }
  const issues = found.slice(0, 2);
  const cautionReasons: string[] = [];
  if (rating !== null && rating <= 3) cautionReasons.push(`별점 ${rating}점`);
  // 가족이 한 말을 전하는 표현이 있을 때만 불만의 주어를 가족으로 (R05)
  const relayed = /하시네|하셨|다고\s*(?:합|하|해)|라고\s*(?:합|하|해)|하셔|하십니다|시대요|시데요|시네요|다하시|하시더/.test(t);
  if (issues.length) cautionReasons.push(`아쉬운 점: ${issues.map((i) => i.label).join(", ")}`);
  return {
    relation,
    usage,
    satisfied: SATISFIED.test(t),
    repurchase: REPURCHASE.test(t) && !REPURCHASE_INTENT.test(t),
    repurchaseIntent: REPURCHASE_INTENT.test(t),
    delivery: DELIVERY.test(t),
    fastDelivery: FAST.test(t),
    comfort: COMFORT.test(t),
    exercise: EXERCISE.test(t),
    issues,
    issueByRelation: !!relation && relayed,
    caution: cautionReasons.length > 0,
    cautionReasons,
  };
}

type Tpl = { id: string; text: string };

const T = {
  giftHappy: [
    { id: "gh1", text: "{R}께서 편하게 잘 입고 계신다니 다행이에요🙂" },
    { id: "gh2", text: "{R}께서 만족하신다니 저희도 정말 기쁩니다😊" },
    { id: "gh3", text: "{R}께 선물해주신 마음이 잘 전해진 것 같아 감사한 마음입니다😊" },
    { id: "gh4", text: "{R}께서 편안하게 느끼신다니 다행입니다🙂" },
  ],
  giftBefore: [
    { id: "gb1", text: "{R}을 위해 샐리브를 선택해주셔서 감사합니다! 착용해보시고 불편한 점이 있으면 언제든 말씀해주세요." },
    { id: "gb2", text: "{R}께서 편하게 입으셨으면 좋겠습니다😊 사용해보시고 궁금한 점이 있으면 언제든 말씀해주세요." },
    { id: "gb3", text: "{R}께 드릴 제품으로 샐리브를 골라주셔서 감사합니다😊" },
  ],
  selfComfort: [
    { id: "sc1", text: "편하게 잘 입고 계신다니 다행입니다😊 앞으로도 일상에서 부담 없이 착용하셨으면 좋겠습니다." },
    { id: "sc2", text: "착용감이 마음에 드셨다니 감사합니다! 앞으로도 편안하게 입어주세요😊" },
    { id: "sc3", text: "부드럽고 편하게 느껴지셨다니 다행이에요🙂" },
    { id: "sc4", text: "일상에서 편하게 입고 계신다니 저희도 기쁩니다😊" },
  ],
  selfHappy: [
    { id: "sh1", text: "제품이 마음에 드셨다니 감사합니다! 앞으로도 편하게 사용해주세요😊" },
    { id: "sh2", text: "만족스럽게 사용하고 계신다니 다행입니다🙂" },
    { id: "sh3", text: "샐리브와 함께 조금 더 편안한 일상 보내셨으면 좋겠습니다😊" },
  ],
  before: [
    { id: "b1", text: "편하게 입으실 수 있기를 바랍니다. 사용해보시고 궁금한 점이 있으면 언제든 말씀해주세요😊" },
    { id: "b2", text: "착용해보시고 불편한 점이 있으면 언제든 편하게 말씀해주세요😊" },
    { id: "b3", text: "샐리브를 선택해주셔서 감사합니다. 입어보시고 마음에 드셨으면 좋겠습니다😊" },
  ],
  deliveryFast: [
    { id: "df1", text: "빠르게 받아보셨다니 다행입니다! 편하게 사용해주세요😊" },
    { id: "df2", text: "빠른 배송에 만족하셨다니 다행이에요🙂 사용하시면서 궁금한 점은 언제든 말씀해주세요." },
  ],
  delivery: [
    { id: "d1", text: "제품 잘 받아보셨다니 다행입니다! 편하게 사용해주세요😊" },
    { id: "d2", text: "주문해주셔서 감사합니다. 사용해보시고 불편한 점은 언제든 말씀해주세요😊" },
    { id: "d3", text: "무사히 받아보셨다니 다행이에요🙂 편안하게 입으셨으면 좋겠습니다." },
    { id: "d4", text: "샐리브를 선택해주셔서 감사합니다! 사용하시면서 궁금한 점은 언제든 말씀해주세요😊" },
  ],
  generic: [
    { id: "g1", text: "앞으로도 편안하게 사용하실 수 있도록 더 노력하겠습니다😊" },
    { id: "g2", text: "샐리브를 선택해주셔서 감사합니다. 편하게 사용해주세요😊" },
  ],
  repurchase: [
    { id: "r1", text: "다시 찾아주셔서 정말 감사합니다!" },
    { id: "r2", text: "재구매까지 해주셔서 더 감사드립니다!" },
    { id: "r3", text: "또 찾아주신 만큼 앞으로도 편하게 입으실 수 있도록 노력하겠습니다." },
  ],
  repurchaseIntent: [
    { id: "ri1", text: "재구매까지 생각해주셨다니 더 감사드립니다!" },
    { id: "ri2", text: "다음에도 또 찾아주신다니 정말 감사합니다!" },
  ],
  exercise: [
    { id: "e1", text: "운동하실 때도 편하게 입으신다니 다행이에요🙂" },
  ],
  month: [
    { id: "m1", text: "한 달 동안 사용해보시고 다시 후기 남겨주셔서 감사합니다!" },
    { id: "m2", text: "사용해보신 뒤 다시 후기 남겨주셔서 감사합니다!" },
  ],
  photo: [
    { id: "p1", text: "사진까지 함께 남겨주셔서 감사합니다!" },
  ],
  cautionClose: [
    { id: "cc1", text: "말씀해주신 부분은 꼼꼼히 전달해 더 나은 제품으로 보답하겠습니다." },
    { id: "cc2", text: "남겨주신 의견은 제품 개선에 꼭 참고하겠습니다." },
  ],
  cautionSupport: [
    { id: "cs1", text: "불편하신 점은 상담톡이나 고객센터로 연락 주시면 자세히 확인해 도와드리겠습니다." },
  ],
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

/** 같은 상품에 최근 쓴 문장은 피해서 고르기 (같은 리뷰는 항상 같은 결과) */
function pick(list: Tpl[], key: string, recent: Set<string>): Tpl {
  const start = hash(key) % list.length;
  for (let i = 0; i < list.length; i++) {
    const t = list[(start + i) % list.length];
    if (!recent.has(t.id)) return t;
  }
  return list[start];
}

/** 받침 있으면 '을', 없으면 '를' ({R}을 → 어머님을 / 남편분을) */
function fillRelation(text: string, r: string | null): string {
  if (!r) return text;
  const last = r.charCodeAt(r.length - 1);
  const hasBatchim = last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 !== 0;
  return text.replace("{R}을", `${r}${hasBatchim ? "을" : "를"}`).replaceAll("{R}", r);
}

export function makeReviewDraft(input: ReviewInput, brand: BrandText = SALIB): ReviewDraft {
  const a = analyzeReview(input.text, input.rating);
  const recent = new Set(input.recentTemplateIds ?? []);
  const used: Tpl[] = [];
  const take = (list: Tpl[], salt = "") => {
    const t = pick(list, input.key + salt, recent);
    used.push(t);
    recent.add(t.id);
    return fillRelation(t.text, a.relation);
  };
  const parts: string[] = [];
  const month = (input.reviewType ?? "").includes("한달");

  if (a.issues.length) {
    // 주의 리뷰: (긍정 한 줄) + 사과 + 개선 약속 + (필요하면) 고객센터 안내
    if (month) parts.push(take(T.month));
    const who = a.issueByRelation ? `${a.relation}께서 ` : "";
    const issue = a.issues[0];
    const sorry = issue.phrase.endsWith("드려") ? `${issue.phrase} 죄송합니다.` : `${who}${issue.phrase} 죄송합니다.`;
    // 이미 입어본 경우에만 "편하게 입고 계셔서" (R04: 아직 안 입었으면 쓰지 않음)
    if ((input.rating ?? 5) >= 4 && a.usage !== "before" && (a.usage === "using" || a.comfort || a.satisfied)) parts.push(a.relation ? `${a.relation}께서 편하게 입고 계셔서 다행이지만, ${sorry.replace(who, "")}` : `편하게 입어주셔서 감사하지만, ${sorry}`);
    else parts.push(sorry);
    parts.push(take(T.cautionClose));
    if (a.issues.some((i) => i.needsSupport)) parts.push(take(T.cautionSupport));
  } else {
    if (month) parts.push(take(T.month));
    let main: string;
    if (a.relation) main = a.usage === "before" || (!a.satisfied && a.usage !== "using" && !a.comfort) ? take(T.giftBefore) : take(T.giftHappy);
    else if (a.usage === "before") main = take(T.before);
    else if (a.comfort && (a.usage === "using" || a.satisfied || a.comfort)) main = take(T.selfComfort);
    else if (a.satisfied || a.usage === "using") main = take(T.selfHappy);
    else if (a.delivery) main = a.fastDelivery ? take(T.deliveryFast) : take(T.delivery);
    else main = take(T.generic);
    parts.push(main);
    if (a.repurchase) parts.push(take(T.repurchase));
    else if (a.repurchaseIntent) parts.push(take(T.repurchaseIntent));
    else if (a.exercise && !a.relation) parts.push(take(T.exercise));
    else if (input.hasPhoto && !month && hash(input.key) % 2 === 0) parts.push(take(T.photo));
  }

  // 한두 문장(R08) — 주의 리뷰는 최대 4문장
  const body = parts.slice(0, a.issues.length ? 4 : 3).join(" ");
  const text = composeReviewReply(body, brand);
  return { text, body, templateIds: used.map((u) => u.id), analysis: a, forbidden: checkForbidden(body) };
}
