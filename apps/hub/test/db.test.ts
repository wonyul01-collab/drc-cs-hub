import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InquiryUpsert } from "@drc/shared";
import { describe, expect, it } from "vitest";
import { HubDb } from "../src/db.ts";

function row(id: string, extra: Partial<InquiryUpsert> = {}): InquiryUpsert {
  return {
    channel: "coupang", kind: "callcenter", external_id: id, product_id: null, product_name: "요실금팬티", order_id: "O1",
    customer_masked: null, title: null, body_masked: "반품 문의", pii_detected: false, received_at: "2026-11-24T01:00:00.000Z",
    deadline_at: "2026-11-25T01:00:00.000Z", platform_answered: false, platform_answer: null, platform_status: null,
    can_reply: true, meta: { a: 1 }, last_seen_at: "2026-11-24T01:00:00.000Z", ...extra,
  };
}

describe("데이터 파일 (SQLite)", () => {
  it("같은 문의는 한 번만 저장, 다시 받아도 처리 상태 유지", async () => {
    const db = new HubDb(":memory:");
    expect(await db.upsertInquiries([row("1"), row("2")])).toBe(2);
    db.db.prepare("update inquiries set status = 'closed' where external_id = '1'").run();
    expect(await db.upsertInquiries([row("1", { body_masked: "수정된 내용" }), row("3")])).toBe(1);
    const all = db.listInquiries({});
    expect(all.total).toBe(3);
    const one = all.rows.find((r) => (r as { external_id: string }).external_id === "1") as Record<string, unknown>;
    expect(one.status).toBe("closed");
    expect(one.body_masked).toBe("수정된 내용");
    expect(one.meta).toEqual({ a: 1 });
    expect(one.can_reply).toBe(true);
  });

  it("판매자센터에서 이미 답변된 건은 '판매자센터 답변됨'", async () => {
    const db = new HubDb(":memory:");
    await db.upsertInquiries([row("9", { platform_answered: true })]);
    expect((db.listInquiries({}).rows[0] as { status: string }).status).toBe("answered_on_platform");
  });

  it("검색·필터·기한순 정렬", async () => {
    const db = new HubDb(":memory:");
    await db.upsertInquiries([
      row("a", { body_masked: "사이즈 문의", deadline_at: "2026-11-25T05:00:00.000Z" }),
      row("b", { body_masked: "반품 문의", deadline_at: "2026-11-25T02:00:00.000Z", pii_detected: true }),
      row("c", { channel: "smartstore", kind: "product_qna", body_masked: "세탁", deadline_at: null }),
    ]);
    expect(db.listInquiries({ q: "사이즈" }).total).toBe(1);
    expect(db.listInquiries({ channel: "smartstore" }).total).toBe(1);
    expect(db.listInquiries({ pii: true }).total).toBe(1);
    const sorted = db.listInquiries({ sort: "deadline" }).rows.map((r) => (r as { external_id: string }).external_id);
    expect(sorted).toEqual(["b", "a", "c"]);
  });

  it("공휴일 갱신이 회사 휴무일을 덮어쓰지 않음", async () => {
    const db = new HubDb(":memory:");
    expect(db.addCompanyHoliday("2026-12-31", "종무식")).toBe(true);
    expect(db.addCompanyHoliday("2026-12-31", "중복")).toBe(false);
    await db.saveHolidays([{ date: "2026-12-31", name: "가짜", source: "api" }, { date: "2026-12-25", name: "성탄절", source: "api" }]);
    const list = db.listHolidays("2026-12-01") as Array<{ date: string; name: string; source: string }>;
    expect(list.find((h) => h.date === "2026-12-31")).toMatchObject({ name: "종무식", source: "company" });
    expect(db.deleteCompanyHoliday("2026-12-25")).toBe(false); // 법정 공휴일은 삭제 불가
  });

  it("로그인·세션·비밀번호 변경·사용 중지", () => {
    const db = new HubDb(":memory:");
    const u = db.createUser("kim", "김담당", "password123", "agent");
    expect(db.login("kim", "wrong-pass")).toBeNull();
    const s = db.login("KIM", "password123")!; // 아이디 대소문자 무시
    expect(db.userBySession(s.token)?.name).toBe("김담당");
    expect(db.userBySession("가짜토큰")).toBeNull();

    db.updateUser(u.id, { password: "newpassword1" });
    expect(db.userBySession(s.token)).toBeNull(); // 비밀번호 바꾸면 기존 로그인 해제
    expect(db.login("kim", "password123")).toBeNull();
    const s2 = db.login("kim", "newpassword1")!;
    db.updateUser(u.id, { active: false });
    expect(db.userBySession(s2.token)).toBeNull();
    expect(db.login("kim", "newpassword1")).toBeNull();
  });

  it("비밀번호는 원문으로 저장하지 않음", () => {
    const db = new HubDb(":memory:");
    db.createUser("lee", "이", "secretpass99", "admin");
    const r = db.db.prepare("select pw_hash from users").get() as { pw_hash: string };
    expect(r.pw_hash).not.toContain("secretpass99");
    expect(r.pw_hash.startsWith("scrypt$")).toBe(true);
  });

  it("백업 파일 생성, 30개만 보관", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drc-db-"));
    const db = new HubDb(join(dir, "main.db"));
    await db.upsertInquiries([row("1")]);
    const file = db.backup(join(dir, "backups"));
    const copy = new HubDb(file);
    expect(copy.listInquiries({}).total).toBe(1);
    copy.close();
    expect(readdirSync(join(dir, "backups")).length).toBe(1);
  });
});

describe("다시 가져오기 요청", () => {
  it("채널별 수집 기록을 지우고 30일 요청을 한 번만 돌려준다", async () => {
    const db = new HubDb(":memory:");
    const run = (channel: string) => ({ channel, kind: "product_qna", started_at: "2026-11-24T00:00:00Z", finished_at: "2026-11-24T00:00:01Z", window_from: "2026-11-17T00:00:00Z", window_to: "2026-11-24T00:00:00Z", fetched: 0, inserted: 0, ok: true, error: null });
    await db.recordRun(run("smartstore"));
    await db.recordRun(run("coupang"));
    db.requestBackfill(30, "smartstore");
    expect(await db.lastSuccessfulWindowEnd("smartstore", "product_qna")).toBeNull();
    expect(await db.lastSuccessfulWindowEnd("coupang", "product_qna")).not.toBeNull();
    expect(await db.takeBackfill()).toBe(30);
    expect(await db.takeBackfill()).toBeNull();
  });
});
