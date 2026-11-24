import { maskId, maskName, maskPii, type InquiryUpsert } from "@drc/shared";
import { kstDate, parseKstDate, pick, RateLimiter, requestJson, type FetchLike } from "../http.ts";
import { MAX_PAGES, type InquirySource } from "../source.ts";
import { NAVER_BASE, NaverTokenProvider } from "./auth.ts";

/**
 * 네이버 엔드포인트·파라미터 이름
 * ⚠ 경로는 공식 담당자 답변(GitHub discussions/3563)으로 확인했지만,
 *   파라미터 이름·응답 필드는 공식 원문을 아직 못 열었습니다.
 *   사무실 PC에서 `pnpm worker:probe`로 실제 응답을 확인한 뒤 여기만 고치면 됩니다.
 */
interface NaverEndpoint {
  path: string;
  params: (from: Date, to: Date, page: number) => Record<string, string>;
}

export const NAVER_ENDPOINTS: Record<"productQna" | "orderInquiry", NaverEndpoint> = {
  productQna: {
    path: "/v1/contents/qnas",
    params: (from: Date, to: Date, page: number) => ({
      page: String(page),
      size: "100",
      fromDate: from.toISOString(),
      toDate: to.toISOString(),
    }),
  },
  orderInquiry: {
    path: "/v1/pay-user/inquiries",
    params: (from: Date, to: Date, page: number) => ({
      page: String(page),
      size: "100",
      startSearchDate: kstDate(from),
      endSearchDate: kstDate(to),
    }),
  },
};

type Obj = Record<string, unknown>;

class NaverClient {
  constructor(
    private readonly tokens: NaverTokenProvider,
    private readonly limiter: RateLimiter,
    private readonly fetchImpl?: FetchLike,
  ) {}
  async get(path: string, query: Record<string, string>, label: string): Promise<Obj> {
    const token = await this.tokens.get();
    const qs = new URLSearchParams(query).toString();
    return requestJson<Obj>(`${NAVER_BASE}${path}?${qs}`, { method: "GET", headers: { authorization: `Bearer ${token}` } }, {
      limiter: this.limiter,
      fetchImpl: this.fetchImpl,
      label,
    });
  }
}

/** 응답에서 목록 배열 꺼내기 (contents / content / data / elements 등 여러 형태 대응) */
function listOf(res: Obj): Obj[] {
  for (const k of ["contents", "content", "data", "elements", "items"]) {
    const v = res[k];
    if (Array.isArray(v)) return v as Obj[];
    if (v && typeof v === "object") {
      const inner = listOf(v as Obj);
      if (inner.length) return inner;
    }
  }
  return [];
}

function totalPagesOf(res: Obj): number | undefined {
  const n = pick<number>(res, "totalPages") ?? pick<number>((res.page as Obj) ?? (res.data as Obj), "totalPages");
  return typeof n === "number" ? n : undefined;
}

function keysOf(items: Obj[]): string[] {
  return [...new Set(items.flatMap((i) => Object.keys(i)))].sort();
}

export function mapNaverQna(item: Obj, nowIso: string): InquiryUpsert | null {
  const id = pick<string | number>(item, "questionId", "qnaId", "id");
  if (id === undefined) return null;
  const body = maskPii(pick<string>(item, "question", "content", "questionContent") ?? "");
  const answer = pick<string>(item, "answer", "answerContent", "commentContent") ?? null;
  const answered = Boolean(pick(item, "answered", "isAnswered")) || !!answer;
  return {
    channel: "smartstore",
    kind: "product_qna",
    external_id: String(id),
    product_id: pick<string | number>(item, "productId", "channelProductNo", "originProductNo")?.toString() ?? null,
    product_name: pick<string>(item, "productName") ?? null,
    order_id: null,
    customer_masked: maskId(pick<string>(item, "maskedWriterId", "writerId", "authorId") ?? null),
    title: null,
    body_masked: body.text,
    pii_detected: body.piiDetected,
    received_at: parseKstDate(pick(item, "createDate", "createdDate", "regDate", "questionDate")) ?? nowIso,
    deadline_at: null,
    platform_answered: answered,
    platform_answer: answer ? maskPii(answer).text : null,
    platform_status: answered ? "answered" : "unanswered",
    can_reply: true,
    meta: {},
    last_seen_at: nowIso,
  };
}

export function mapNaverOrderInquiry(item: Obj, nowIso: string): InquiryUpsert | null {
  const id = pick<string | number>(item, "inquiryNo", "inquiryId", "id");
  if (id === undefined) return null;
  const body = maskPii(pick<string>(item, "inquiryContent", "content", "question") ?? "");
  const answer = pick<string>(item, "answerContent", "answer") ?? null;
  const answered = Boolean(pick(item, "answered", "isAnswered")) || !!answer;
  return {
    channel: "smartstore",
    kind: "order_inquiry",
    external_id: String(id),
    product_id: pick<string | number>(item, "productNo", "productId")?.toString() ?? null,
    product_name: pick<string>(item, "productName") ?? null,
    order_id: pick<string | number>(item, "orderId", "productOrderId")?.toString() ?? null,
    customer_masked: maskName(pick<string>(item, "customerName", "ordererName") ?? null),
    title: maskPii(pick<string>(item, "title") ?? "").text || null,
    body_masked: body.text,
    pii_detected: body.piiDetected,
    received_at: parseKstDate(pick(item, "inquiryRegistrationDateTime", "createDate", "regDate")) ?? nowIso,
    deadline_at: null,
    platform_answered: answered,
    platform_answer: answer ? maskPii(answer).text : null,
    platform_status: pick<string>(item, "category", "inquiryCategory") ?? null,
    can_reply: true,
    meta: { category: pick(item, "category", "inquiryCategory") ?? null },
    last_seen_at: nowIso,
  };
}

export function naverSources(cfg: { clientId: string; clientSecret: string }, fetchImpl?: FetchLike): InquirySource[] {
  // 내 스토어 애플리케이션은 모든 API 2회/초 고정 → 0.7초 간격으로 여유 있게
  const limiter = new RateLimiter(700);
  const client = new NaverClient(new NaverTokenProvider(cfg.clientId, cfg.clientSecret, limiter, fetchImpl), limiter, fetchImpl);

  const make = (
    kind: "product_qna" | "order_inquiry",
    label: string,
    ep: NaverEndpoint,
    mapper: (i: Obj, now: string) => InquiryUpsert | null,
  ): InquirySource => ({
    channel: "smartstore",
    kind,
    label,
    maxWindowDays: 30,
    async fetch(from, to) {
      const nowIso = new Date().toISOString();
      const rows: InquiryUpsert[] = [];
      const raw: Obj[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await client.get(ep.path, ep.params(from, to, page), label);
        const items = listOf(res);
        raw.push(...items);
        for (const it of items) {
          const r = mapper(it, nowIso);
          if (r) rows.push(r);
        }
        const total = totalPagesOf(res);
        if (!items.length || (total !== undefined && page >= total) || items.length < 100) break;
      }
      return { rows, rawKeys: keysOf(raw) };
    },
  });

  return [
    make("product_qna", "스마트스토어 상품문의", NAVER_ENDPOINTS.productQna, mapNaverQna),
    make("order_inquiry", "스마트스토어 주문 문의", NAVER_ENDPOINTS.orderInquiry, mapNaverOrderInquiry),
  ];
}
