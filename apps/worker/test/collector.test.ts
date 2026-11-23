import type { InquiryUpsert } from "@drc/shared";
import { describe, expect, it, vi } from "vitest";
import { collectSource, splitWindow } from "../src/collector.ts";
import { coupangSources } from "../src/coupang/sources.ts";
import { Engine } from "../src/engine.ts";
import type { InquirySource } from "../src/source.ts";
import { FakeStore } from "./fakeStore.ts";

const DAY = 86400e3;

function row(id: string, answered = false): InquiryUpsert {
  return {
    channel: "coupang", kind: "product_qna", external_id: id, product_id: null, product_name: null, order_id: null,
    customer_masked: null, title: null, body_masked: "문의", pii_detected: false, received_at: new Date().toISOString(),
    deadline_at: null, platform_answered: answered, platform_answer: null, platform_status: null, can_reply: true, meta: {},
    last_seen_at: new Date().toISOString(),
  };
}

function fakeSource(rows: InquiryUpsert[], maxWindowDays = 7) {
  const calls: Array<[Date, Date]> = [];
  const src: InquirySource = {
    channel: "coupang", kind: "product_qna", label: "테스트", maxWindowDays,
    fetch: async (a, b) => { calls.push([a, b]); return { rows, rawKeys: [] }; },
  };
  return { src, calls };
}

describe("수집 구간 나누기", () => {
  it("쿠팡 7일 제한 → 6일 이하 조각", () => {
    const to = new Date("2026-11-24T00:00:00Z");
    const parts = splitWindow(new Date(to.getTime() - 14 * DAY), to, 7);
    expect(parts.length).toBe(3);
    for (const [a, b] of parts) expect(b.getTime() - a.getTime()).toBeLessThanOrEqual(6 * DAY);
    expect(parts.at(-1)![1].getTime()).toBe(to.getTime());
  });
});

describe("문의 수집", () => {
  it("처음엔 lookback 기간부터, 두 번째부턴 지난번 끝 1시간 전부터 / 중복 저장 안 함", async () => {
    const store = new FakeStore();
    const { src, calls } = fakeSource([row("1"), row("2"), row("2")]);
    const t1 = new Date("2026-11-24T01:00:00Z");

    const r1 = await collectSource(src, store, t1, 7);
    expect(r1.inserted).toBe(2);
    expect(calls[0][0].getTime()).toBe(t1.getTime() - 7 * DAY);

    const t2 = new Date(t1.getTime() + 10 * 60e3);
    calls.length = 0;
    const r2 = await collectSource(src, store, t2, 7);
    expect(r2.inserted).toBe(0); // 이미 받은 문의
    expect(store.inquiries.size).toBe(2);
    expect(calls[0][0].getTime()).toBe(t1.getTime() - 3600e3);
  });

  it("판매자센터에서 이미 답변된 건은 '판매자센터 답변됨' 상태", async () => {
    const store = new FakeStore();
    await collectSource(fakeSource([row("9", true)]).src, store, new Date(), 7);
    expect([...store.inquiries.values()][0].status).toBe("answered_on_platform");
  });

  it("실패해도 기록을 남기고 다음 수집은 같은 구간부터 다시", async () => {
    const store = new FakeStore();
    const src: InquirySource = { ...fakeSource([]).src, fetch: async () => { throw new Error("403 Not allowed IP"); } };
    const r = await collectSource(src, store, new Date(), 7);
    expect(r.ok).toBe(false);
    expect(store.runs[0].ok).toBe(false);
    expect(await store.lastSuccessfulWindowEnd("coupang", "product_qna")).toBeNull();
  });
});

describe("쿠팡 API 호출 형태 (가짜 응답)", () => {
  it("경로·파라미터·서명 헤더, 여러 페이지", async () => {
    const urls: string[] = [];
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      headers.push(init.headers as Record<string, string>);
      const page = Number(new URL(url).searchParams.get("pageNum"));
      const content = page === 1 ? Array.from({ length: 50 }, (_, i) => ({ inquiryId: i + 1, content: "q", inquiryAt: "2026-11-24 09:00:00" })) : [{ inquiryId: 99, content: "q", inquiryAt: "2026-11-24 09:00:00" }];
      return new Response(JSON.stringify({ code: 200, data: { content, pagination: { currentPage: page, totalPages: 2 } } }));
    });
    const [online] = coupangSources({ vendorId: "A00012345", accessKey: "AK", secretKey: "SK" }, fetchImpl);
    const { rows } = await online.fetch(new Date("2026-11-20T00:00:00Z"), new Date("2026-11-24T00:00:00Z"));

    expect(rows.length).toBe(51);
    expect(urls).toHaveLength(2);
    const u = new URL(urls[0]);
    expect(u.origin).toBe("https://api-gateway.coupang.com");
    expect(u.pathname).toBe("/v2/providers/openapi/apis/api/v5/vendors/A00012345/onlineInquiries");
    expect(u.searchParams.get("inquiryStartAt")).toBe("2026-11-20");
    expect(u.searchParams.get("inquiryEndAt")).toBe("2026-11-24");
    expect(headers[0].authorization).toMatch(/^CEA algorithm=HmacSHA256, access-key=AK/);
  });

  it("403(IP 미등록)은 재시도하지 않고 바로 실패", async () => {
    const fetchImpl = vi.fn(async () => new Response("Not allowed IP", { status: 403 }));
    const [online] = coupangSources({ vendorId: "V", accessKey: "AK", secretKey: "SK" }, fetchImpl);
    await expect(online.fetch(new Date(Date.now() - DAY), new Date())).rejects.toThrow(/403/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("작업기 엔진 — 운영 시간에만 일한다", () => {
  const kst = (s: string) => new Date(`${s}:00+09:00`);

  it("토요일·공휴일: 수집 안 함, 하트비트만", async () => {
    const store = new FakeStore();
    const { src, calls } = fakeSource([row("1")]);
    const engine = new Engine({ store, sources: [src], workerId: "t", lookbackDays: 7, dataGoKrKey: null });
    expect(await engine.tick(kst("2026-11-28T10:00"))).toBe("idle"); // 토
    expect(await engine.tick(kst("2026-10-09T10:00"))).toBe("idle"); // 한글날
    expect(await engine.tick(kst("2026-11-27T18:01"))).toBe("idle"); // 금 18:01
    expect(calls).toHaveLength(0);
    expect(store.inquiries.size).toBe(0);
    expect(store.beats.every((b) => b.mode === "idle")).toBe(true);
  });

  it("평일 운영 시간: 10분마다 수집", async () => {
    const store = new FakeStore();
    const { src, calls } = fakeSource([row("1")]);
    const engine = new Engine({ store, sources: [src], workerId: "t", lookbackDays: 7, dataGoKrKey: null });
    expect(await engine.tick(kst("2026-11-30T09:00"))).toBe("collected");
    expect(await engine.tick(kst("2026-11-30T09:01"))).toBe("operating");
    expect(await engine.tick(kst("2026-11-30T09:09"))).toBe("operating");
    expect(await engine.tick(kst("2026-11-30T09:10"))).toBe("collected");
    // 첫 수집은 7일치라 6일 조각 2번 호출, 두 번째 수집은 짧은 구간 1번 → 수집 기록은 2회
    expect(store.runs).toHaveLength(2);
    expect(calls).toHaveLength(3);
  });
});
