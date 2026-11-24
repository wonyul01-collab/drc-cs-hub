import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HubDb } from "../src/db.ts";
import { createHubServer } from "../src/server.ts";

let base = "";
let db: HubDb;
let close: () => void;

beforeAll(async () => {
  const web = mkdtempSync(join(tmpdir(), "drc-web-"));
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "index.html"), "<html>DRC</html>");
  writeFileSync(join(web, "assets", "app.js"), "console.log(1)");
  db = new HubDb(":memory:");
  const server = createHubServer({ db, webDir: web });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());

async function call(path: string, opts: { method?: string; body?: unknown; cookie?: string; raw?: boolean } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? "GET",
    headers: { ...(opts.body !== undefined && !opts.raw ? { "content-type": "application/json" } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: opts.body !== undefined ? (opts.raw ? String(opts.body) : JSON.stringify(opts.body)) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, json, text, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

async function loginAs(login: string, password: string) {
  const r = await call("/api/login", { method: "POST", body: { login, password } });
  expect(r.status).toBe(200);
  return r.cookie;
}

describe("허브 화면 서버", () => {
  let admin = "";
  let agent = "";

  it("처음엔 관리자 만들기 필요 → 메인 PC에서 만들기", async () => {
    expect((await call("/api/setup")).json).toEqual({ needed: true, local: true });
    expect((await call("/api/setup", { method: "POST", body: { login: "boss", name: "대표", password: "short" } })).status).toBe(400);
    expect((await call("/api/setup", { method: "POST", body: { login: "boss", name: "대표", password: "bosspass123" } })).status).toBe(201);
    expect((await call("/api/setup", { method: "POST", body: { login: "x", name: "x", password: "xxxxxxxxxx" } })).status).toBe(409);
    admin = await loginAs("boss", "bosspass123");
  });

  it("로그인 안 하면 데이터 접근 불가", async () => {
    expect((await call("/api/inquiries")).status).toBe(401);
    expect((await call("/api/summary")).status).toBe(401);
    expect((await call("/api/users")).status).toBe(401);
  });

  it("관리자가 담당자 계정 생성 → 담당자 로그인", async () => {
    const r = await call("/api/users", { method: "POST", cookie: admin, body: { login: "kim", name: "김담당", password: "kimpass1234", role: "agent" } });
    expect(r.status).toBe(201);
    expect((await call("/api/users", { method: "POST", cookie: admin, body: { login: "kim", name: "중복", password: "kimpass1234" } })).status).toBe(409);
    agent = await loginAs("kim", "kimpass1234");
    expect(((await call("/api/me", { cookie: agent })).json.user as { role: string }).role).toBe("agent");
  });

  it("담당자는 문의 조회 가능, 관리 기능은 불가", async () => {
    await db.upsertInquiries([
      {
        channel: "coupang", kind: "product_qna", external_id: "1", product_id: null, product_name: null, order_id: null, customer_masked: null,
        title: null, body_masked: "사이즈?", pii_detected: false, received_at: new Date().toISOString(), deadline_at: null, platform_answered: false,
        platform_answer: null, platform_status: null, can_reply: true, meta: {}, last_seen_at: new Date().toISOString(),
      },
    ]);
    const list = await call("/api/inquiries", { cookie: agent });
    expect(list.json.total).toBe(1);
    const id = (list.json.rows as Array<{ id: number }>)[0].id;
    expect((await call(`/api/inquiries/${id}`, { cookie: agent })).json.body_masked).toBe("사이즈?");
    expect((await call("/api/users", { cookie: agent })).status).toBe(403);
    expect((await call("/api/holidays", { method: "POST", cookie: agent, body: { date: "2026-12-31", name: "x" } })).status).toBe(403);
    expect((await call("/api/summary", { cookie: agent })).json.newTotal).toBe(1);
  });

  it("관리자는 자기 권한을 해제할 수 없음", async () => {
    const me = (await call("/api/me", { cookie: admin })).json.user as { id: number };
    expect((await call(`/api/users/${me.id}`, { method: "PATCH", cookie: admin, body: { role: "agent" } })).status).toBe(400);
  });

  it("JSON이 아닌 요청은 거부 (다른 사이트의 몰래 요청 방지)", async () => {
    expect((await call("/api/holidays", { method: "POST", cookie: admin, body: "date=2026-12-31", raw: true })).status).toBe(415);
  });

  it("로그인 10번 실패하면 10분 차단", async () => {
    for (let i = 0; i < 10; i++) await call("/api/login", { method: "POST", body: { login: "kim", password: "wrong" } });
    expect((await call("/api/login", { method: "POST", body: { login: "kim", password: "kimpass1234" } })).status).toBe(429);
  });

  it("화면 파일 제공, 폴더 밖 파일 접근 차단", async () => {
    expect((await call("/")).text).toContain("DRC");
    expect((await call("/inquiries/5")).text).toContain("DRC"); // 화면 주소는 첫 화면으로
    expect((await call("/assets/app.js")).text).toContain("console.log");
    const evil = await call("/..%2f..%2f..%2fetc%2fpasswd");
    expect(evil.text).not.toContain("root:");
  });

  it("로그아웃하면 세션 무효", async () => {
    await call("/api/logout", { method: "POST", cookie: admin, body: {} });
    expect((await call("/api/me", { cookie: admin })).status).toBe(401);
  });
});

describe("비밀번호 최소 7자", () => {
  it("7자는 허용, 6자는 거부", async () => {
    // 앞 테스트에서 로그인 차단이 걸려 있으므로 세션을 직접 발급
    const admin = `drc_session=${db.login("boss", "bosspass123")!.token}`;
    const make = (login: string, password: string) =>
      fetch(base + "/api/users", { method: "POST", headers: { "content-type": "application/json", cookie: admin }, body: JSON.stringify({ login, name: login, password }) });
    expect((await make("park", "abc1234")).status).toBe(201);
    expect((await make("choi", "abc123")).status).toBe(400);
  });
});
