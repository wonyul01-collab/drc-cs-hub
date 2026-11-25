import type { AddressInfo } from "node:net";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HubDb } from "../src/db.ts";
import { exportKnowledgeXlsx, parseKnowledgeXlsx } from "../src/excel.ts";
import { processDrafts } from "../src/pipeline.ts";
import { createHubServer } from "../src/server.ts";

const ENTRY = {
  active: true, category: "size", title: "안심퀸 사이즈", products: ["안심퀸 프리미엄"], keywords: ["사이즈", "95"], example: "95 입는데요",
  answer: "안심퀸 프리미엄은 일반 팬티 사이즈에 맞춰 제작되었습니다.", conditions: null, minRoute: "auto" as const, validUntil: null,
};
const PRODUCT = { name: "안심퀸 프리미엄", aliases: ["안심퀸"], absorb_ml: "90", features: "면", size_guide: "정사이즈", wash_guide: null, caution: null };

function inquiry(id: string, body: string, productName = "안심퀸 프리미엄 여성 요실금팬티") {
  const now = new Date().toISOString();
  return { channel: "smartstore" as const, kind: "product_qna" as const, external_id: id, product_id: null, product_name: productName, order_id: null, customer_masked: null, title: null, body_masked: body, pii_detected: false, received_at: now, deadline_at: null, platform_answered: false, platform_answer: null, platform_status: null, can_reply: true, meta: {}, last_seen_at: now };
}

describe("지식 DB 엑셀", () => {
  it("내려받은 파일을 그대로 올리면 같은 내용", async () => {
    const db = new HubDb(":memory:");
    db.replaceKnowledge([ENTRY], [PRODUCT], "test");
    const buf = await exportKnowledgeXlsx(db.listKnowledge(), db.listProducts());
    const r = await parseKnowledgeXlsx(buf);
    expect(r.errors).toEqual([]);
    expect(r.knowledge[0]).toMatchObject({ category: "size", title: "안심퀸 사이즈", products: ["안심퀸 프리미엄"], keywords: ["사이즈", "95"], minRoute: "auto", active: true });
    expect(r.products[0]).toMatchObject({ name: "안심퀸 프리미엄", aliases: ["안심퀸"] });
  });

  it("잘못된 질문 유형·날짜·상품은 줄 번호와 함께 알려준다", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("표준답변");
    ws.addRow(["번호", "사용(Y/N)", "질문 유형", "제목", "상품", "키워드", "고객 질문 예시", "표준 답변", "발송 전 확인 조건", "처리 단계", "유효기간"]);
    ws.addRow(["", "Y", "이상한유형", "t", "없는상품", "", "", "답변", "", "자동 가능", "12월"]);
    wb.addWorksheet("상품정보").addRow(["상품", "별칭"]);
    (wb.getWorksheet("상품정보") as ExcelJS.Worksheet).addRow(["안심퀸 프리미엄", ""]);
    const r = await parseKnowledgeXlsx(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.errors.join("\n")).toMatch(/2번째 줄: 질문 유형/);
    expect(r.errors.join("\n")).toMatch(/유효기간/);
    expect(r.errors.join("\n")).toMatch(/없는상품/);
  });

  it("답변이 빈 줄은 '사용 Y'여도 쓰지 않음 (예상 질문 줄)", async () => {
    const db = new HubDb(":memory:");
    db.replaceKnowledge([{ ...ENTRY, answer: "", active: false, title: "빈 답변" }], [PRODUCT], "t");
    const buf = await exportKnowledgeXlsx(db.listKnowledge(), db.listProducts());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    wb.getWorksheet("표준답변")!.getRow(2).getCell(2).value = "Y";
    const r = await parseKnowledgeXlsx(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(r.knowledge[0].active).toBe(false);
  });
});

describe("수집 → 분류·초안 → 화면", () => {
  let base = "";
  let db: HubDb;
  let close: () => void;
  let admin = "";
  let agent = "";

  beforeAll(async () => {
    db = new HubDb(":memory:");
    db.createUser("boss", "대표", "bosspass1", "admin");
    db.createUser("kim", "김", "kimpass1", "agent");
    const server = createHubServer({ db, webDir: null, backup: () => "backup-test" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    admin = `drc_session=${db.login("boss", "bosspass1")!.token}`;
    agent = `drc_session=${db.login("kim", "kimpass1")!.token}`;
  });
  afterAll(() => close());

  const call = async (path: string, cookie: string, method = "GET", body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
  };

  it("지식 DB가 비어 있으면 '확인 후 안내' 초안 + ② 승인", async () => {
    await db.upsertInquiries([inquiry("1", "평소 95 입는데 사이즈 뭐 사요?")]);
    expect(processDrafts(db)).toBe(1);
    const id = (db.listInquiries({}).rows[0] as { id: number }).id;
    const r = await call(`/api/inquiries/${id}`, agent);
    expect(r.json.route).toBe("approve");
    expect(r.json.draft.text).toContain("확인 후 빠르게 안내");
  });

  it("관리자가 엑셀을 올리면 초안이 새로 만들어져 ① 자동 가능", async () => {
    const tmp = new HubDb(":memory:");
    tmp.replaceKnowledge([ENTRY], [PRODUCT], "t");
    const file = (await exportKnowledgeXlsx(tmp.listKnowledge(), tmp.listProducts())).toString("base64");
    expect((await call("/api/knowledge/import", agent, "POST", { file })).status).toBe(403);
    const up = await call("/api/knowledge/import", admin, "POST", { file });
    expect(up.status).toBe(200);
    expect(up.json).toMatchObject({ entries: 1, active: 1, products: 1, redrafted: 1 });
    const id = (db.listInquiries({}).rows[0] as { id: number }).id;
    const r = await call(`/api/inquiries/${id}`, agent);
    expect(r.json.route).toBe("auto");
    expect(r.json.draft.text).toContain("일반 팬티 사이즈에 맞춰");
    expect(r.json.refs[0].title).toBe("안심퀸 사이즈");
    expect(db.listInquiries({ route: "auto" }).total).toBe(1);
  });

  it("담당자가 초안을 고치면 사람 수정본으로 저장되고, 이후 지식 DB가 바뀌어도 덮어쓰지 않음", async () => {
    const id = (db.listInquiries({}).rows[0] as { id: number }).id;
    const draft = (await call(`/api/inquiries/${id}`, agent)).json.draft.text as string;
    const edited = draft.replace("일반 팬티 사이즈에 맞춰", "일반 팬티 사이즈 기준으로");
    const r = await call(`/api/inquiries/${id}/draft`, agent, "POST", { text: edited });
    expect(r.json.draft.created_by).toBe("kim");
    expect(db.markForRedraft()).toBe(0);
  });

  it("고친 문장에 금지 표현이 있으면 경고 저장 (문의 답변은 고정 문구 검사 없음)", async () => {
    const id = (db.listInquiries({}).rows[0] as { id: number }).id;
    const r = await call(`/api/inquiries/${id}/draft`, agent, "POST", { text: "100% 새지 않습니다" });
    expect(r.json.draft.detail.forbidden.length).toBeGreaterThan(0);
    expect(r.json.draft.detail.warnings).toEqual([]);
  });

  it("관리자는 답변을 끌 수 있고, 꺼진 답변은 초안에 안 씀", async () => {
    const k = (await call("/api/knowledge", agent)).json.knowledge[0];
    expect((await call(`/api/knowledge/${k.id}`, agent, "PATCH", { active: false })).status).toBe(403);
    expect((await call(`/api/knowledge/${k.id}`, admin, "PATCH", { active: false })).status).toBe(200);
    await db.upsertInquiries([inquiry("2", "95 사이즈 문의")]);
    processDrafts(db);
    const row = db.listInquiries({}).rows.find((x) => (x as { external_id: string }).external_id === "2") as { id: number };
    expect((await call(`/api/inquiries/${row.id}`, agent)).json.draft.knowledge_ids).toEqual([]);
  });
});
