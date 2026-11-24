import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_HOLIDAYS, DEFAULT_OPERATING } from "@drc/shared";
import { HubDb } from "../src/db.ts";
import { flushNotifications, planNotifications, type Notifier } from "../src/notify.ts";
import { processDrafts } from "../src/pipeline.ts";
import { createHubServer } from "../src/server.ts";

const ENTRY = { active: true, category: "size", title: "안심퀸 사이즈", products: ["안심퀸 프리미엄"], keywords: ["사이즈", "95"], answer: "안심퀸 프리미엄은 일반 팬티 사이즈에 맞춰 제작되었습니다.", conditions: null, minRoute: "auto" as const, validUntil: null };

function q(id: string, body: string, extra: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return { channel: "smartstore" as const, kind: "product_qna" as const, external_id: id, product_id: null, product_name: "안심퀸 프리미엄", order_id: null, customer_masked: null, title: null, body_masked: body, pii_detected: false, received_at: now, deadline_at: null, platform_answered: false, platform_answer: null, platform_status: null, can_reply: true, meta: {}, last_seen_at: now, ...extra };
}

let base = "";
let db: HubDb;
let close: () => void;
const cookie: Record<string, string> = {};
const sent: Array<{ to: string[]; subject: string; text: string }> = [];
const notifier: Notifier = { name: "test", send: async (to, subject, text) => void sent.push({ to, subject, text }) };

beforeAll(async () => {
  db = new HubDb(":memory:");
  db.replaceKnowledge([ENTRY], [{ name: "안심퀸 프리미엄", aliases: [] }], "t");
  for (const [login, name] of [["kim", "김담당"], ["lee", "이담당"]]) {
    const u = db.createUser(login, name, "pass1234", "agent");
    db.updateUser(u.id, { email: `${login}@example.com` });
    cookie[login] = `drc_session=${db.login(login, "pass1234")!.token}`;
  }
  const server = createHubServer({ db, webDir: null, dryRun: true, notifier, baseUrl: "http://192.168.0.15:3000" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

const call = async (path: string, who: string, method = "GET", body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { cookie: cookie[who], ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
};
const idOf = (ext: string) => (db.listInquiries({}).rows.find((r) => (r as { external_id: string }).external_id === ext) as { id: number }).id;

describe("동시 처리 잠금", () => {
  it("김담당이 열면 이담당은 '처리 중'으로 보고, 승인·수정 불가", async () => {
    await db.upsertInquiries([q("1", "평소 95 입는데 사이즈 어떻게 해요")]);
    processDrafts(db);
    const id = idOf("1");
    expect((await call(`/api/inquiries/${id}/lock`, "kim", "POST")).json).toMatchObject({ mine: true });
    expect((await call(`/api/inquiries/${id}/lock`, "lee", "POST")).json).toMatchObject({ mine: false, name: "김담당" });
    const r = await call(`/api/inquiries/${id}/decision`, "lee", "POST", { action: "approve" });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("김담당님이 처리 중");
    expect((await call(`/api/inquiries/${id}/draft`, "lee", "POST", { text: "바꿈" })).status).toBe(409);
    await call(`/api/inquiries/${id}/lock`, "kim", "DELETE");
    expect((await call(`/api/inquiries/${id}/lock`, "lee", "POST")).json).toMatchObject({ mine: true });
    await call(`/api/inquiries/${id}/lock`, "lee", "DELETE");
  });
});

describe("승인 흐름 (DRY_RUN — 마켓에 보내지 않고 기록만)", () => {
  it("승인 → 보냈을 요청 기록, 두 번 승인 불가, 처리할 문의에서 빠짐", async () => {
    const id = idOf("1");
    const r = await call(`/api/inquiries/${id}/decision`, "kim", "POST", { action: "approve" });
    expect(r.json).toMatchObject({ ok: true, dryRun: true });
    const d = (await call(`/api/inquiries/${id}`, "kim")).json;
    expect(d.approved_by).toBe("김담당");
    expect(d.job.status).toBe("dry_run");
    expect(d.job.payload.content).toContain("일반 팬티 사이즈에 맞춰");
    expect(d.history.map((h: { action: string }) => h.action)).toEqual(["approve"]);
    expect((await call(`/api/inquiries/${id}/decision`, "lee", "POST", { action: "approve" })).status).toBe(409);
    expect(db.summary(new Date(0).toISOString()).newTotal).toBe(0);
    expect(db.summary(new Date(0).toISOString()).approved).toBe(1);
  });

  it("승인 취소 → 다시 처리 대기", async () => {
    const id = idOf("1");
    expect((await call(`/api/inquiries/${id}/decision`, "kim", "POST", { action: "unapprove" })).json.ok).toBe(true);
    expect((await call(`/api/inquiries/${id}`, "kim")).json.job).toBeNull();
  });

  it("수정 후 승인: 금지 표현·고정문구 누락이면 거부, 고치면 승인", async () => {
    const id = idOf("1");
    const draft = (await call(`/api/inquiries/${id}`, "kim")).json.draft.text as string;
    const bad = await call(`/api/inquiries/${id}/decision`, "kim", "POST", { action: "approve", text: draft.replace("제작되었습니다.", "제작되어 100% 새지 않습니다.") });
    expect(bad.status).toBe(400);
    expect(bad.json.details.join(" ")).toMatch(/100%/);
    const noClose = await call(`/api/inquiries/${id}/decision`, "kim", "POST", { action: "approve", text: "고객님 감사합니다." });
    expect(noClose.status).toBe(400);
    const good = await call(`/api/inquiries/${id}/decision`, "kim", "POST", { action: "approve", text: draft.replace("제작되었습니다.", "제작된 제품입니다.") });
    expect(good.json.ok).toBe(true);
    const d = (await call(`/api/inquiries/${id}`, "kim")).json;
    expect(d.job.payload.content).toContain("제작된 제품입니다.");
    expect(d.history.at(-1).action).toBe("approve_edited");
  });

  it("③ 사람 전용은 승인 불가, 직접 처리 완료만", async () => {
    await db.upsertInquiries([q("2", "수술 후에 입어도 되나요")]);
    processDrafts(db);
    const id = idOf("2");
    const r = await call(`/api/inquiries/${id}/decision`, "kim", "POST", { action: "approve" });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("사람 전용");
    expect((await call(`/api/inquiries/${id}/decision`, "kim", "POST", { action: "close", memo: "판매자센터에서 직접 답변" })).json.ok).toBe(true);
    expect((await call(`/api/inquiries/${id}`, "kim")).json.status).toBe("closed");
  });

  it("반려는 사유 필수, 기록만 남고 문의는 계속 처리 대기", async () => {
    await db.upsertInquiries([q("3", "95 사이즈 문의")]);
    processDrafts(db);
    const id = idOf("3");
    expect((await call(`/api/inquiries/${id}/decision`, "kim", "POST", { action: "reject" })).status).toBe(400);
    expect((await call(`/api/inquiries/${id}/decision`, "kim", "POST", { action: "reject", memo: "답변이 너무 짧음" })).json.ok).toBe(true);
    const d = (await call(`/api/inquiries/${id}`, "kim")).json;
    expect(d.history[0]).toMatchObject({ action: "reject", memo: "답변이 너무 짧음" });
    expect(d.approved_at).toBeNull();
  });

  it("판매자센터에서 답변이 확인되면 승인 건도 '판매자센터 답변됨'", async () => {
    await db.upsertInquiries([q("1", "평소 95 입는데 사이즈 어떻게 해요", { platform_answered: true })]);
    expect((await call(`/api/inquiries/${idOf("1")}`, "kim")).json.status).toBe("answered_on_platform");
  });
});

describe("알림", () => {
  const kst = (s: string) => new Date(`${s}:00+09:00`);
  const H = new Set(BUILTIN_HOLIDAYS.map((h) => h.date));
  const ctx = (now: Date) => ({ now, holidays: H, operating: DEFAULT_OPERATING, baseUrl: "http://192.168.0.15:3000", failingSources: [] as string[], coupangKeyIssuedAt: null });

  it("신규 문의 요약은 15분 단위로 1번만, 개인정보 없이", async () => {
    sent.length = 0;
    const db2 = new HubDb(":memory:");
    const u = db2.createUser("a", "a", "pass1234", "admin");
    db2.updateUser(u.id, { email: "a@example.com" });
    await db2.upsertInquiries([q("9", "연락처 010-1234-5678 홍길동입니다", { customer_masked: "홍*동", order_id: "2026112099" })]);
    processDrafts(db2);
    const t = kst("2026-11-24T10:01");
    expect(planNotifications(db2, ctx(t))).toBe(1);
    expect(planNotifications(db2, ctx(new Date(t.getTime() + 60_000)))).toBe(0); // 같은 15분 안 → 중복 없음
    await flushNotifications(db2, notifier);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("신규 문의 1건");
    expect(sent[0].text).toContain("http://192.168.0.15:3000/inquiries");
    for (const secret of ["010", "홍", "2026112099", "연락처"]) expect(sent[0].text).not.toContain(secret);
  });

  it("발송 실패 → 3번까지 재시도 후 '실패'로 남김", async () => {
    const db3 = new HubDb(":memory:");
    db3.enqueueNotification({ key: "k", kind: "x", recipients: ["a@example.com"], subject: "s", body: "b" });
    const broken: Notifier = { name: "x", send: async () => { throw new Error("SMTP 인증 실패"); } };
    for (let i = 0; i < 5; i++) await flushNotifications(db3, broken);
    const [n] = db3.recentNotifications() as Array<{ status: string; attempts: number; last_error: string }>;
    expect(n).toMatchObject({ status: "failed", attempts: 3, last_error: "SMTP 인증 실패" });
    expect(db3.failedNotificationCount(new Date(0).toISOString())).toBe(1);
  });

  it("금요일 17:30 마감·17:50 일일 요약은 하루 1번", () => {
    const db4 = new HubDb(":memory:");
    const u = db4.createUser("a", "a", "pass1234", "agent");
    db4.updateUser(u.id, { email: "a@example.com" });
    expect(planNotifications(db4, ctx(kst("2026-11-27T17:29")))).toBe(0);
    expect(planNotifications(db4, ctx(kst("2026-11-27T17:30")))).toBe(1); // 마감
    expect(planNotifications(db4, ctx(kst("2026-11-27T17:50")))).toBe(1); // 일일 요약
    expect(planNotifications(db4, ctx(kst("2026-11-27T17:55")))).toBe(0);
  });

  it("관리자 테스트 메일 (관리자만)", async () => {
    expect((await call("/api/notifications/test", "kim", "POST", {})).status).toBe(403);
  });

  it("담당자 이메일 형식 검사", async () => {
    const adm = db.createUser("boss", "대표", "pass1234", "admin");
    cookie.boss = `drc_session=${db.login("boss", "pass1234")!.token}`;
    expect((await call(`/api/users/${adm.id}`, "boss", "PATCH", { email: "잘못된주소" })).status).toBe(400);
    expect((await call(`/api/users/${adm.id}`, "boss", "PATCH", { email: "boss@example.com", notify: true })).status).toBe(200);
    const t = await call("/api/notifications/test", "boss", "POST", {});
    expect(t.json).toMatchObject({ ok: true, sentTo: 3 });
  });
});
