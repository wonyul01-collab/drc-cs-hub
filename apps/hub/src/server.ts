import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { seoulParts, type Role } from "@drc/shared";
import type { HubDb, User } from "./db.ts";
import { exportKnowledgeXlsx, parseKnowledgeXlsx } from "./excel.ts";
import { checkEdited, processDrafts } from "./pipeline.ts";
import type { Updater } from "./updater.ts";
import type { Notifier } from "./notify.ts";
import { checkFixedText, checkForbidden, MAX_REPLY_LENGTH } from "@drc/shared";

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

function emailOf(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 120) throw new HttpError(400, "이메일 주소를 확인하세요.");
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
  updater?: Updater;
  /** 관리자가 "지금 업데이트"를 눌렀을 때 */
  onUpdate?: () => void;
  /** true면 승인해도 마켓에 보내지 않고 "보냈을 요청"만 기록 (Phase 5 전까지) */
  dryRun?: boolean;
  notifier?: Notifier | null;
  baseUrl?: string;
}

export function createHubServer({ db, webDir, backup, updater, onUpdate, dryRun = true, notifier = null, baseUrl = "" }: ServerOptions): Server {
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
    if (path === "/api/status" && method === "GET")
      return send(res, 200, {
        status: db.status(),
        now: new Date().toISOString(),
        dryRun,
        notify: { configured: !!notifier, failedToday: db.failedNotificationCount(new Date(Date.now() - 86400e3).toISOString()) },
      });
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
      return send(res, 200, { ...row, draft, refs, history: db.history(Number(inq[1])), job: db.postJob(Number(inq[1])), dryRun });
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
        const other = db.lockedByOther(id, me.login);
        if (other) throw new HttpError(409, `${other}님이 처리 중인 문의입니다.`);
        const b = await readJson(req);
        const text = str(b.text, "답변", 2, 3000);
        db.saveEditedDraft(id, text, me.login, checkEdited(text));
        await db.audit("draft.edit", { inquiryId: id }, me.login);
      }
      return send(res, 200, { draft: db.latestDraft(id) });
    }

    if (path === "/api/collect/backfill" && method === "POST") {
      requireAdmin();
      db.requestBackfill(30);
      await db.audit("collect.backfill", { days: 30 }, me.login);
      return send(res, 200, { ok: true, days: 30 });
    }

    if (path === "/api/update" && method === "GET") {
      requireAdmin();
      if (!updater) return send(res, 200, { available: false, hasUpdate: false });
      return send(res, 200, await updater.check());
    }
    if (path === "/api/update" && method === "POST") {
      requireAdmin();
      if (!updater?.installedWithGit || !onUpdate) throw new HttpError(400, "자동 업데이트가 설정되지 않았습니다. 메인 PC에서 6-auto-update-setup.bat 을 먼저 실행하세요.");
      const st = await updater.check();
      if (st.error) throw new HttpError(502, `새 버전 확인 실패: ${st.error}`);
      if (!st.hasUpdate) return send(res, 200, { ...st, restarting: false });
      backup?.();
      await db.audit("hub.update", { from: st.current, to: st.latest }, me.login);
      send(res, 200, { ...st, restarting: true });
      onUpdate();
      return;
    }

    // ── 동시 처리 잠금 ──
    const lk = /^\/api\/inquiries\/(\d+)\/lock$/.exec(path);
    if (lk && method === "POST") return send(res, 200, db.lock(Number(lk[1]), me));
    const ub = /^\/api\/inquiries\/(\d+)\/unlock-beacon$/.exec(path);
    if (ub && method === "POST") {
      db.unlock(Number(ub[1]), me.login); // 창을 닫을 때 브라우저가 보내는 신호 (본인 잠금만 해제)
      return send(res, 200, { ok: true });
    }
    if (lk && method === "DELETE") {
      db.unlock(Number(lk[1]), me.login);
      return send(res, 200, { ok: true });
    }

    // ── 승인·반려·처리 완료 (모든 담당자 가능) ──
    const dec = /^\/api\/inquiries\/(\d+)\/decision$/.exec(path);
    if (dec && method === "POST") {
      const id = Number(dec[1]);
      const row = db.getInquiry(id) as Record<string, any> | null;
      if (!row) throw new HttpError(404, "문의를 찾을 수 없습니다.");
      const b = await readJson(req);
      const action = String(b.action ?? "");
      const other = db.lockedByOther(id, me.login);
      if (other) throw new HttpError(409, `${other}님이 처리 중인 문의입니다. 잠시 후 다시 시도하세요.`);

      if (action === "approve") {
        if (row.status !== "new" || row.approved_at) throw new HttpError(409, "이미 처리된 문의입니다. 새로고침 해주세요.");
        let draft = db.latestDraft(id) as Record<string, any> | null;
        if (!draft) throw new HttpError(400, "초안이 없습니다.");
        if (draft.route === "human") throw new HttpError(400, "③ 사람 전용 문의는 승인할 수 없습니다. 판매자센터에서 직접 답변한 뒤 [직접 처리 완료]를 눌러주세요.");
        if (!row.can_reply) throw new HttpError(400, "마켓에서 지금 답변할 수 없는 상태입니다 (이미 답변됨·종료·이관 전). 판매자센터에서 확인하세요.");
        let kind: "approve" | "approve_edited" = "approve";
        if (typeof b.text === "string" && b.text !== draft.text) {
          const text = str(b.text, "답변", 2, 3000);
          db.saveEditedDraft(id, text, me.login, checkEdited(text));
          draft = db.latestDraft(id) as Record<string, any>;
          kind = "approve_edited";
        }
        const text = String(draft.text);
        const problems = [
          ...checkForbidden(text).map((f) => `쓰면 안 되는 표현: ${f.label} ("${f.match}")`),
          ...checkFixedText(text),
          ...(text.length > MAX_REPLY_LENGTH ? [`답변이 ${text.length}자로 ${MAX_REPLY_LENGTH}자를 넘습니다.`] : []),
        ];
        if (problems.length) return send(res, 400, { error: "승인할 수 없습니다. 아래를 고쳐주세요.", details: problems });
        const payload = {
          channel: row.channel,
          kind: row.kind,
          externalId: row.external_id,
          content: text,
          parentAnswerId: row.meta?.parentAnswerId ?? null,
        };
        if (!db.approve(id, Number(draft.id), me.name, kind, payload, dryRun)) throw new HttpError(409, "이미 처리된 문의입니다. 새로고침 해주세요.");
        await db.audit("inquiry.approve", { id, edited: kind === "approve_edited", dryRun }, me.login);
        return send(res, 200, { ok: true, dryRun });
      }
      if (action === "unapprove") {
        if (!db.unapprove(id, me.name)) throw new HttpError(409, "승인을 취소할 수 없습니다 (이미 마켓에 등록됐거나 승인 상태가 아님).");
        await db.audit("inquiry.unapprove", { id }, me.login);
        return send(res, 200, { ok: true });
      }
      if (action === "reject") {
        const memo = str(b.memo, "반려 사유", 1, 300);
        const draft = db.latestDraft(id) as Record<string, any> | null;
        db.reject(id, draft ? Number(draft.id) : null, me.name, memo);
        await db.audit("inquiry.reject", { id, memo }, me.login);
        return send(res, 200, { ok: true });
      }
      if (action === "close") {
        const memo = typeof b.memo === "string" && b.memo.trim() ? b.memo.trim().slice(0, 300) : null;
        if (!db.closeInquiry(id, me.name, memo)) throw new HttpError(409, "이미 처리 완료된 문의입니다.");
        await db.audit("inquiry.close", { id }, me.login);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(400, "알 수 없는 처리입니다.");
    }

    // ── 알림 (관리자) ──
    if (path === "/api/notifications" && method === "GET") {
      requireAdmin();
      return send(res, 200, { configured: !!notifier, recipients: db.notifyEmails(), recent: db.recentNotifications(20) });
    }
    if (path === "/api/notifications/test" && method === "POST") {
      requireAdmin();
      if (!notifier) throw new HttpError(400, "알림 메일 계정이 설정되지 않았습니다. 메인 PC에서 3-settings.bat → MAIL_USER, MAIL_PASSWORD 를 넣고 허브를 다시 켜세요.");
      const to = db.notifyEmails();
      if (!to.length) throw new HttpError(400, "알림 받을 이메일이 없습니다. [담당자] 메뉴에서 이메일을 넣어주세요.");
      try {
        await notifier.send(to, "[DRC CS] 테스트 알림", `DRC CS 허브 알림 테스트입니다. 이 메일이 보이면 알림 설정이 정상입니다.\n▶ ${baseUrl}/\n— DRC CS 허브`);
      } catch (e) {
        throw new HttpError(502, `메일 발송 실패: ${e instanceof Error ? e.message : String(e)} — 메일 계정·비밀번호(앱 비밀번호)와 SMTP 사용 설정을 확인하세요.`);
      }
      await db.audit("notify.test", { count: to.length }, me.login);
      return send(res, 200, { ok: true, sentTo: to.length });
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
        if (typeof b.email === "string" && b.email.trim()) db.updateUser(u.id, { email: emailOf(b.email) });
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
      const patch: { role?: Role; active?: boolean; password?: string; email?: string | null; notify?: boolean } = {};
      if (b.email !== undefined) patch.email = b.email ? emailOf(b.email) : null;
      if (b.notify !== undefined) patch.notify = !!b.notify;
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
