import { maskPii, type InquiryUpsert } from "@drc/shared";
import { describeShape, kstDate, parseKstDate, pick, RateLimiter, requestJson, type FetchLike } from "../http.ts";
import { MAX_PAGES, type InquirySource } from "../source.ts";
import { COUPANG_BASE, coupangAuthorization } from "./auth.ts";

type Obj = Record<string, unknown>;

/**
 * 쿠팡 엔드포인트 (공식 문서 확인 — docs/api-notes.md 2장)
 *  - 상품별 고객문의 조회: v5 onlineInquiries, 조회 기간 최대 7일
 *  - 고객센터 문의 조회: v4 callCenterInquiries
 */
export const COUPANG_ENDPOINTS = {
  online: (vendorId: string) => `/v2/providers/openapi/apis/api/v5/vendors/${vendorId}/onlineInquiries`,
  callcenter: (vendorId: string) => `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/callCenterInquiries`,
};

export class CoupangClient {
  // 쿠팡은 초당 5회 초과 시 즉시 차단 → 0.5초 간격(초당 2회)
  private readonly limiter = new RateLimiter(500);
  constructor(
    private readonly cfg: { vendorId: string; accessKey: string; secretKey: string },
    private readonly fetchImpl?: FetchLike,
  ) {}

  async get(path: string, query: Record<string, string>, label: string): Promise<Obj> {
    const qs = new URLSearchParams(query).toString();
    return requestJson<Obj>(
      `${COUPANG_BASE}${path}?${qs}`,
      {
        method: "GET",
        headers: {
          authorization: coupangAuthorization("GET", path, qs, this.cfg.accessKey, this.cfg.secretKey),
          "content-type": "application/json;charset=UTF-8",
          "x-requested-by": this.cfg.vendorId,
        },
      },
      { limiter: this.limiter, fetchImpl: this.fetchImpl, label },
    );
  }
}

function dataList(res: Obj): { items: Obj[]; totalPages?: number } {
  const data = (res.data ?? res) as Obj;
  const items = (Array.isArray(data) ? data : (data.content ?? data.items ?? [])) as Obj[];
  const pg = (data.pagination ?? res.pagination) as Obj | undefined;
  const totalPages = pg ? Number(pick(pg, "totalPages")) : undefined;
  return { items: Array.isArray(items) ? items : [], totalPages: Number.isFinite(totalPages) ? totalPages : undefined };
}

function keysOf(items: Obj[]): string[] {
  return [...new Set(items.flatMap((i) => Object.keys(i)))].sort();
}

export function mapCoupangOnline(item: Obj, nowIso: string): InquiryUpsert | null {
  const id = pick<string | number>(item, "inquiryId");
  if (id === undefined) return null;
  const body = maskPii(pick<string>(item, "content") ?? "");
  const comments = (Array.isArray(item.commentDtoList) ? item.commentDtoList : []) as Obj[];
  const lastAnswer = comments.length ? pick<string>(comments[comments.length - 1], "content") : undefined;
  const answered = comments.length > 0 || Boolean(pick(item, "answered"));
  return {
    channel: "coupang",
    kind: "product_qna",
    external_id: String(id),
    product_id: pick<string | number>(item, "sellerProductId", "productId")?.toString() ?? null,
    product_name: pick<string>(item, "productName", "sellerProductName", "itemName") ?? null,
    order_id: Array.isArray(item.orderIds) && item.orderIds.length ? String(item.orderIds[0]) : null,
    customer_masked: null,
    title: null,
    body_masked: body.text,
    pii_detected: body.piiDetected,
    received_at: parseKstDate(pick(item, "inquiryAt", "createdAt")) ?? nowIso,
    deadline_at: null,
    platform_answered: answered,
    platform_answer: lastAnswer ? maskPii(lastAnswer).text : null,
    platform_status: answered ? "answered" : "unanswered",
    // 쿠팡 답변은 등록 후 수정 불가 → 이미 답변된 건은 추가 답변 금지
    can_reply: !answered,
    meta: { vendorItemId: pick(item, "vendorItemId") ?? null },
    last_seen_at: nowIso,
  };
}

export function mapCoupangCallcenter(item: Obj, nowIso: string): InquiryUpsert | null {
  const id = pick<string | number>(item, "inquiryId");
  if (id === undefined) return null;
  const body = maskPii(pick<string>(item, "content") ?? "");
  const receivedAt = parseKstDate(pick(item, "inquiryAt", "receiptAt", "createdAt")) ?? nowIso;
  const inquiryStatus = String(pick(item, "inquiryStatus") ?? "").toLowerCase();
  const transfer = String(pick(item, "partnerTransferStatus") ?? "").toLowerCase();
  const replies = (Array.isArray(item.replies) ? item.replies : []) as Obj[];
  const lastReply = replies.length ? pick<string>(replies[replies.length - 1], "content") : undefined;
  // 답변 가능 조건: 진행중(progress) + 판매자 답변 요청(requestAnswer) — 공식 문서
  const canReply = inquiryStatus === "progress" && transfer === "requestanswer";
  const answered = transfer === "answered" || inquiryStatus === "complete";
  return {
    channel: "coupang",
    kind: "callcenter",
    external_id: String(id),
    product_id: pick<string | number>(item, "vendorItemId", "sellerProductId")?.toString() ?? null,
    product_name: pick<string>(item, "itemName", "productName") ?? null,
    order_id: pick<string | number>(item, "orderId")?.toString() ?? null,
    customer_masked: null,
    title: maskPii(pick<string>(item, "receiptCategory", "category") ?? "").text || null,
    body_masked: body.text,
    pii_detected: body.piiDetected,
    received_at: receivedAt,
    // 미답변 24시간 경과 시 쿠팡이 자동 종료
    deadline_at: new Date(Date.parse(receivedAt) + 24 * 3600e3).toISOString(),
    platform_answered: answered,
    platform_answer: lastReply ? maskPii(lastReply).text : null,
    platform_status: [inquiryStatus, transfer].filter(Boolean).join("/") || null,
    can_reply: canReply,
    meta: {
      inquiryStatus: inquiryStatus || null,
      partnerTransferStatus: transfer || null,
      // 답변 등록 시 필요한 parentAnswerId (Phase 5에서 사용)
      parentAnswerId: replies.length ? (pick(replies[replies.length - 1], "answerId") ?? null) : null,
    },
    last_seen_at: nowIso,
  };
}

export function coupangSources(cfg: { vendorId: string; accessKey: string; secretKey: string }, fetchImpl?: FetchLike): InquirySource[] {
  const client = new CoupangClient(cfg, fetchImpl);

  const online: InquirySource = {
    channel: "coupang",
    kind: "product_qna",
    label: "쿠팡 상품문의",
    maxWindowDays: 7,
    async fetch(from, to) {
      const nowIso = new Date().toISOString();
      const rows: InquiryUpsert[] = [];
      const raw: Obj[] = [];
      let shape: string | undefined;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await client.get(
          COUPANG_ENDPOINTS.online(cfg.vendorId),
          {
            vendorId: cfg.vendorId,
            answeredType: "ALL",
            inquiryStartAt: kstDate(from),
            inquiryEndAt: kstDate(to),
            pageSize: "50",
            pageNum: String(page),
          },
          "쿠팡 상품문의 조회",
        );
        if (page === 1) shape = describeShape(res);
        const { items, totalPages } = dataList(res);
        raw.push(...items);
        for (const it of items) {
          const r = mapCoupangOnline(it, nowIso);
          if (r) rows.push(r);
        }
        if (!items.length || (totalPages !== undefined && page >= totalPages) || items.length < 50) break;
      }
      return { rows, rawKeys: keysOf(raw), shape };
    },
  };

  const callcenter: InquirySource = {
    channel: "coupang",
    kind: "callcenter",
    label: "쿠팡 고객센터 문의",
    maxWindowDays: 7,
    async fetch(from, to) {
      const nowIso = new Date().toISOString();
      const rows: InquiryUpsert[] = [];
      const raw: Obj[] = [];
      let shape: string | undefined;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await client.get(
          COUPANG_ENDPOINTS.callcenter(cfg.vendorId),
          {
            vendorId: cfg.vendorId,
            partnerCounselingStatus: "NONE",
            inquiryStartAt: kstDate(from),
            inquiryEndAt: kstDate(to),
            pageSize: "30",
            pageNum: String(page),
          },
          "쿠팡 고객센터 문의 조회",
        );
        if (page === 1) shape = describeShape(res);
        const { items, totalPages } = dataList(res);
        raw.push(...items);
        for (const it of items) {
          const r = mapCoupangCallcenter(it, nowIso);
          if (r) rows.push(r);
        }
        if (!items.length || (totalPages !== undefined && page >= totalPages) || items.length < 30) break;
      }
      return { rows, rawKeys: keysOf(raw), shape };
    },
  };

  return [online, callcenter];
}
