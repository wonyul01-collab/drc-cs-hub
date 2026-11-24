import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { seoulParts, type Role } from "@drc/shared";
import type { HubDb, User } from "./db.ts";
import { exportKnowledgeXlsx, parseKnowledgeXlsx } from "./excel.ts";
import { checkEdited, processDrafts } from "./pipeline.ts";

/**
 * 화면 제공 + 데이터 API (메인 PC에서 실행, 같은 사무실 PC는 http://메인PC주소:3000 으로 접속)
 * - 모든 API는 로그인 필요 (첫 관리자 만들기만 예외: 메인 PC 자신에서만 가능)
 */

const COOKIE = "drc_session";
const ROLES: Role[] = ["admin", "approver", "agent"];
/** 비밀번호 최소 길이 (2026-11-24 담당자 요청: 7자) */
export const PASSWORD_MIN = 7;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readJson(req: IncomingMessage, maxBytes = 100_000): Promise<Record<string, unknown>> {
  // 다른 사이트에서 몰래 보내는 요청(CSRF)을 막기 위해 JSON만 받는다
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "잘못된 요청 형식입니다.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, "요청이 너무 큽니다.");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "잘못된 요청 형식입니다.");
  }
}

function isLocal(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function str(v: unknown, label: string, min = 1, max = 100): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < min || s.length > max) throw new HttpError(400, `${label}을(를) 확인하세요.`);
  return s;
}

function todayStartIso(): string {
  return new Date(`${seoulParts(new Date()).date}T00:00:00+09:00`).toISOString();
}

/** 로그인 실패 제한: 같은 PC에서 10분에 10번 */
class LoginLimiter {
  private fails = new Map<string, number[]>();
  blocked(ip: string) {
    const now = Date.now();
    const list = (this.fails.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
    this.fails.set(ip, list);
    return list.length >= 10;
  }
  fail(ip: string) {
    this.fails.set(ip, [...(this.fails.get(ip) ?? []), Date.now()]);
  }
  reset(ip: string) {
    this.fails.delete(ip);
  }
}

export interface ServerOptions {
  db: HubDb;
  webDir: string | null;
  /** 지식 DB 통째로 바꾸기 전 백업 */
  backup?: () => string;
}

export function createHubServer({ db, webDir, backup }: ServerOptions): Server {
  const limiter = new LoginLimiter();
  const webRoot = webDir ? resolve(webDir) : null;

  const sessionCookie = (token: string, maxAgeSec: number) =>
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? "GET";
    const path = url.pathname;
    const token = cookies(req)[COOKIE];
    const ip = req.socket.remoteAddress ?? "?";

    // ── 로그인 없이 가능한 것 ──
    if (path === "/api/setup" && method === "GET") return send(res, 200, { needed: db.userCount() === 0, local: isLocal(req) });
    if (path === "/api/setup" && method === "POST") {
      if (db.userCount() > 0) throw new HttpError(409, "이미 관리자가 있습니다.");
      if (!isLocal(req)) throw new HttpError(403, "첫 관리자는 메인 PC에서만 만들 수 있습니다.");
      const b = await readJson(req);
      const pw = str(b.password, `비밀번호(${PASSWORD_MIN}자 이상)`, PASSWORD_MIN, 200);
      db.createUser(str(b.login, "아이디", 2, 40), str(b.name, "이름", 1, 40), pw, "admin");
      await db.audit("user.setup", { login: b.login }, "setup");
      return send(res, 201, { ok: true });
    }
    if (path === "/api/login" && method === "POST") {
      if (limiter.blocked(ip)) throw new HttpError(429, "로그인 실패가 많아 10분 동안 막혔습니다. 잠시 후 다시 시도하세요.");
      const b = await readJson(req);
      const r = db.login(String(b.login ?? ""), String(b.password ?? ""));
      if (!r) {
        limiter.fail(ip);
        throw new HttpError(401, "아이디 또는 비밀번호가 맞지 않습니다.");
      }
      limiter.reset(ip);
      return send(res, 200, { user: r.user }, { "set-cookie": sessionCookie(r.token, 14 * 86400) });
    }
    if (path === "/api/logout" && method === "POST") {
      if (token) db.logout(token);
      return send(res, 200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
    }

    // ── 여기부터 로그인 필요 ──
    const me = db.userBySession(token);
    if (!me) throw new HttpError(401, "로그인이 필요합니다.");
    const requireAdmin = () => {
      if (me.role !== "admin") throw new HttpError(403, "관리자만 할 수 있습니다.");
    };

    if (path === "/api/me" && method === "GET") return send(res, 200, { user: me });
    if (path === "/api/status" && method === "GET") return send(res, 200, { status: db.status(), now: new Date().toISOString() });
    if (path === "/api/summary" && method === "GET") return send(res, 200, db.summary(todayStartIso()));

    if (path === "/api/inquiries" && method === "GET") {
      const p = url.searchParams;
      return send(
        res,
        200,
        db.listInquiries({
          channel: p.get("channel") || undefined,
          kind: p.get("kind") || undefined,
          status: p.get("status") || undefined,
          route: p.get("route") || undefined,
          pii: p.get("pii") === "1",
          q: p.get("q") || undefined,
          sort: p.get("sort") === "deadline" ? "deadline" : "received",
          page: Number(p.get("page") ?? 1) || 1,
        }),
      );
    }
    const inq = /^\/api\/inquiries\/(\d+)$/.exec(path);
    if (inq && method === "GET") {
      const row = db.getInquiry(Number(inq[1]));
      if (!row) throw new HttpError(404, "문의를 찾을 수 없습니다.");
      const draft = db.latestDraft(Number(inq[1]));
      const used = new Set((draft?.knowledge_ids as number[]) ?? []);
      const refs = db.listKnowledge().filter((k) => used.has(Number(k.id))).map((k) => ({ id: k.id, title: k.title, conditions: k.conditions }));
      return send(res, 200, { ...row, draft, refs });
    }
    const drf = /^\/api\/inquiries\/(\d+)\/(draft|redraft)$/.exec(path);
    if (drf && method === "POST") {
      const id = Number(drf[1]);
      if (!db.getInquiry(id)) throw new HttpError(404, "문의를 찾을 수 없습니다.");
      if (drf[2] === "redraft") {
        db.resetDraft(id);
        processDrafts(db);
        await db.audit("draft.regenerate", { inquiryId: id }, me.login);
      } else {
        const b = await readJson(req);
        const text = str(b.text, "답변", 2, 3000);
        db.saveEditedDraft(id, text, me.login, checkEdited(text));
        await db.audit("draft.edit", { inquiryId: id }, me.login);
      }
      return send(res, 200, { draft: db.latestDraft(id) });
    }

    // ── 지식 DB ──
    if (path === "/api/knowledge" && method === "GET") return send(res, 200, { knowledge: db.listKnowledge(), products: db.listProducts() });
    if (path === "/api/knowledge.xlsx" && method === "GET") {
      const buf = await exportKnowledgeXlsx(db.listKnowledge(), db.listProducts());
      const name = encodeURIComponent(`지식DB_${seoulParts(new Date()).date}.xlsx`);
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="knowledge-db.xlsx"; filename*=UTF-8''${name}`,
        "cache-control": "no-store",
      });
      return res.end(buf);
    }
    if (path === "/api/knowledge/import" && method === "POST") {
      requireAdmin();
      const b = await readJson(req, 15_000_000);
      const file = typeof b.file === "string" ? Buffer.from(b.file, "base64") : null;
      if (!file?.length) throw new HttpError(400, "파일이 비어 있습니다.");
      let parsed;
      try {
        parsed = await parseKnowledgeXlsx(file);
      } catch {
        throw new HttpError(400, "엑셀 파일을 읽을 수 없습니다. .xlsx 파일인지 확인하세요.");
      }
      if (parsed.errors.length) return send(res, 400, { error: "엑셀 내용을 고쳐야 합니다.", details: parsed.errors.slice(0, 30) });
      if (!parsed.knowledge.length) throw new HttpError(400, "표준답변이 한 줄도 없습니다.");
      const backupFile = backup?.();
      db.replaceKnowledge(parsed.knowledge, parsed.products, me.login);
      const redraft = db.markForRedraft();
      processDrafts(db);
      await db.audit("knowledge.import", { entries: parsed.knowledge.length, products: parsed.products.length, backupFile }, me.login);
      return send(res, 200, {
        entries: parsed.knowledge.length,
        active: parsed.knowledge.filter((k) => k.active).length,
        products: parsed.products.length,
        redrafted: redraft,
      });
    }
    const kn = /^\/api\/knowledge\/(\d+)$/.exec(path);
    if (kn && method === "PATCH") {
      requireAdmin();
      const b = await readJson(req);
      const patch: { active?: boolean; answer?: string } = {};
      if (b.active !== undefined) patch.active = !!b.active;
      if (b.answer !== undefined) patch.answer = str(b.answer, "표준 답변", 1, 2000);
      if (!db.updateKnowledge(Number(kn[1]), patch, me.login)) throw new HttpError(404, "답변을 찾을 수 없습니다.");
      db.markForRedraft();
      processDrafts(db);
      await db.audit("knowledge.update", { id: Number(kn[1]), ...patch }, me.login);
      return send(res, 200, { ok: true });
    }

    if (path === "/api/holidays" && method === "GET") return send(res, 200, db.listHolidays(seoulParts(new Date()).date));
    if (path === "/api/holidays" && method === "POST") {
      requireAdmin();
      const b = await readJson(req);
      const date = str(b.date, "날짜", 10, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, "날짜 형식을 확인하세요.");
      if (!db.addCompanyHoliday(date, str(b.name, "이름", 1, 40))) throw new HttpError(409, "이미 휴일로 등록된 날짜입니다.");
      await db.audit("holiday.add", { date, name: b.name }, me.login);
      return send(res, 201, { ok: true });
    }
    const hol = /^\/api\/holidays\/(\d{4}-\d{2}-\d{2})$/.exec(path);
    if (hol && method === "DELETE") {
      requireAdmin();
      if (!db.deleteCompanyHoliday(hol[1])) throw new HttpError(404, "회사 휴무일만 삭제할 수 있습니다.");
      await db.audit("holiday.delete", { date: hol[1] }, me.login);
      return send(res, 200, { ok: true });
    }

    if (path === "/api/users" && method === "GET") {
      requireAdmin();
      return send(res, 200, db.listUsers());
    }
    if (path === "/api/users" && method === "POST") {
      requireAdmin();
      const b = await readJson(req);
      const role = ROLES.includes(b.role as Role) ? (b.role as Role) : "agent";
      try {
        const u = db.createUser(str(b.login, "아이디", 2, 40), str(b.name, "이름", 1, 40), str(b.password, `비밀번호(${PASSWORD_MIN}자 이상)`, PASSWORD_MIN, 200), role);
        await db.audit("user.create", { login: u.login, role }, me.login);
        return send(res, 201, u);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(409, "이미 있는 아이디입니다.");
      }
    }
    const usr = /^\/api\/users\/(\d+)$/.exec(path);
    if (usr && method === "PATCH") {
      requireAdmin();
      const id = Number(usr[1]);
      const b = await readJson(req);
      const patch: { role?: Role; active?: boolean; password?: string } = {};
      if (b.role !== undefined) {
        if (!ROLES.includes(b.role as Role)) throw new HttpError(400, "역할을 확인하세요.");
        patch.role = b.role as Role;
      }
      if (b.active !== undefined) patch.active = !!b.active;
      if (b.password !== undefined) patch.password = str(b.password, `비밀번호(${PASSWORD_MIN}자 이상)`, PASSWORD_MIN, 200);
      if (id === me.id && ((patch.role && patch.role !== "admin") || patch.active === false)) {
        throw new HttpError(400, "자기 자신의 관리자 권한은 해제할 수 없습니다.");
      }
      db.updateUser(id, patch);
      await db.audit("user.update", { id, role: patch.role, active: patch.active, passwordReset: !!patch.password }, me.login);
      return send(res, 200, { ok: true });
    }

    throw new HttpError(404, "없는 기능입니다.");
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!webRoot || !existsSync(join(webRoot, "index.html"))) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      return res.end("화면 파일이 없습니다. 메인 PC에서 'pnpm hub' 로 다시 실행하세요.");
    }
    let file: string;
    try {
      file = normalize(join(webRoot, decodeURIComponent(url.pathname)));
    } catch {
      file = webRoot;
    }
    // 화면 폴더 밖 파일 접근 차단, 없는 주소는 첫 화면으로
    if (!file.startsWith(webRoot + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(webRoot, "index.html");
    const isAsset = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
    createReadStream(file).pipe(res);
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else if (req.method === "GET" || req.method === "HEAD") serveStatic(req, res, url);
      else throw new HttpError(405, "허용되지 않는 요청입니다.");
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.message });
      else {
        console.error(e);
        send(res, 500, { error: "프로그램 오류가 발생했습니다. 잠시 후 다시 시도하세요." });
      }
    }
  });
}

export type { User };
