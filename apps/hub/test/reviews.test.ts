import type { AddressInfo } from "node:net";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_HOLIDAYS, DEFAULT_OPERATING } from "@drc/shared";
import { HubDb } from "../src/db.ts";
import { planNotifications } from "../src/notify.ts";
import { parseReviewXlsx } from "../src/reviewImport.ts";
import { createHubServer } from "../src/server.ts";

// 스마트스토어센터 리뷰 엑셀과 같은 칸 구성 (2026-11-25 실물 기준) — 내용은 테스트용 문장
const HEAD = ["상품번호", "상품명", "리뷰구분", "구매자평점", "포토/영상", "리뷰상세내용", "리뷰도움수", "등록자", "리뷰등록일", "최종수정일", "리뷰글번호", "관련리뷰글번호", "관련리뷰상세내용", "전시상태", "답글여부", "답글등록일시", "베스트리뷰", "베스트리뷰선정일시", "이벤트번호", "혜택지급", "혜택지급일시", "유저정보 등록 항목", "상품주문번호", "풀필먼트사", "리뷰이동일"];
type R = { key: string; body: string; rating: number; replied?: "Y" | "N"; type?: string; photo?: boolean; status?: string; product?: string };
async function xlsx(rows: R[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet0");
  ws.addRow(HEAD);
  for (const r of rows) {
    const v: Record<string, unknown> = {
      상품번호: "111", 상품명: r.product ?? "샐리브 안심퀸 여성요실금팬티 프리미엄 면 국내산 90ml", 리뷰구분: r.type ?? "일반", 구매자평점: String(r.rating),
      "포토/영상": r.photo ? "https://example.com/p.jpg" : null, 리뷰상세내용: r.body, 등록자: "ab****", 리뷰등록일: "2026.11.22. 19:00:16",
      리뷰글번호: r.key, 전시상태: r.status ?? "정상", 답글여부: r.replied ?? "N", 상품주문번호: "2026110100000001",
    };
    ws.addRow(HEAD.map((h) => v[h] ?? null));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("리뷰 엑셀 읽기", () => {
  it("스마트스토어 칸 구성 인식, 날짜·답글여부·블라인드·개인정보 마스킹", async () => {
    const p = await parseReviewXlsx(await xlsx([
      { key: "1", body: "편해요 연락 010-1234-5678", rating: 5, photo: true },
      { key: "2", body: "좋아요", rating: 4, replied: "Y" },
      { key: "3", body: "숨김", rating: 1, status: "블라인드" },
    ]));
    expect(p.errors).toEqual([]);
    expect(p.channel).toBe("smartstore");
    expect(p.rows[0]).toMatchObject({ review_key: "1", rating: 5, has_photo: true, platform_replied: false, written_at: "2026-11-22T10:00:16.000Z" });
    expect(p.rows[0].body_masked).toBe("편해요 연락 [전화번호]");
    expect(p.rows[1].platform_replied).toBe(true);
    expect(p.rows[2].hidden).toBe(true);
    expect(JSON.stringify(p.rows)).not.toContain("2026110100000001"); // 주문번호는 저장 안 함
  });
  it("다른 파일이면 친절한 오류", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("x").addRow(["이름", "주소"]);
    const p = await parseReviewXlsx(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(p.errors[0]).toMatch(/리뷰 번호·내용 칸을 찾지 못했습니다/);
  });
});

describe("리뷰 화면 흐름", () => {
  let base = "";
  let db: HubDb;
  let close: () => void;
  let cookie = "";
  beforeAll(async () => {
    db = new HubDb(":memory:");
    db.replaceKnowledge([], [{ name: "안심퀸 프리미엄", aliases: ["안심퀸"] }], "t");
    const u = db.createUser("kim", "김담당", "pass1234", "agent");
    db.updateUser(u.id, { email: "kim@example.com" });
    cookie = `drc_session=${db.login("kim", "pass1234")!.token}`;
    const server = createHubServer({ db, webDir: null });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());
  const call = async (path: string, method = "GET", body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  };

  it("올리기 → 새 리뷰만 초안, 답글 달린 리뷰는 자동 완료, 주의 리뷰가 맨 위", async () => {
    const file = (await xlsx([
      { key: "10", body: "엄마가 좋아하세요", rating: 5 },
      { key: "11", body: "바느질 부분이 배겨요", rating: 3 },
      { key: "12", body: "이미 답글 단 리뷰", rating: 5, replied: "Y" },
    ])).toString("base64");
    const r = await call("/api/reviews/import", "POST", { file, filename: "review.xlsx", channel: "smartstore" });
    expect(r.json).toMatchObject({ total: 3, inserted: 3, drafted: 2, counts: { todo: 2, caution: 1 } });
    const list = (await call("/api/reviews?tab=todo")).json;
    expect(list.rows[0].review_key).toBe("11"); // 주의 리뷰 먼저
    expect(list.rows[0].draft_text).toMatch(/죄송/);
    expect(list.rows[1].draft_text).toMatch(/어머님/);
    expect(list.rows.every((x: { product: string }) => x.product === "안심퀸 프리미엄")).toBe(true);
  });

  it("같은 파일을 다시 올려도 중복 없음, 이후 판매자센터 답글이 확인되면 자동 완료", async () => {
    const again = (await xlsx([{ key: "10", body: "엄마가 좋아하세요", rating: 5, replied: "Y" }])).toString("base64");
    const r = await call("/api/reviews/import", "POST", { file: again, channel: "smartstore" });
    expect(r.json).toMatchObject({ inserted: 0, autoDone: 1, counts: { todo: 1 } });
  });

  it("초안 고치기·등록 완료·완료 취소", async () => {
    const id = (await call("/api/reviews?tab=todo")).json.rows[0].id;
    const d = await call(`/api/reviews/${id}/draft`, "POST", { text: "100% 새지 않습니다" });
    expect(d.json.warnings.join(" ")).toMatch(/100%|고정/);
    expect((await call(`/api/reviews/${id}/done`, "POST", {})).json.ok).toBe(true);
    expect((await call(`/api/reviews/${id}/done`, "POST", {})).status).toBe(409);
    expect((await call("/api/reviews?tab=done")).json.total).toBe(3);
    expect((await call(`/api/reviews/${id}/undo`, "POST", {})).json.ok).toBe(true);
  });

  it("리뷰 올리기 알림은 켜 둔 경우에만 하루 4번", () => {
    const H = new Set(BUILTIN_HOLIDAYS.map((h) => h.date));
    const ctx = (s: string) => ({ now: new Date(`${s}:00+09:00`), holidays: H, operating: DEFAULT_OPERATING, baseUrl: "http://x", failingSources: [], coupangKeyIssuedAt: null });
    db.setSetting("notify_last_summary_at", new Date().toISOString());
    expect(planNotifications(db, ctx("2026-11-24T09:30"))).toBe(0);
    db.setSetting("review_reminder", true);
    expect(planNotifications(db, ctx("2026-11-24T09:30"))).toBe(1);
    expect(planNotifications(db, ctx("2026-11-24T09:40"))).toBe(0);
    expect(planNotifications(db, ctx("2026-11-24T11:30"))).toBe(1);
  });
});
