import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_OPERATING, type DraftResult, type InquiryUpsert, type KnowledgeEntry, type OperatingConfig, type ProductInfo, type Role, type Route } from "@drc/shared";

/**
 * 데이터 보관 — 메인 PC 안의 파일 1개 (worker-data/drc-cs-hub.db, SQLite)
 * 작업기(수집)와 화면(웹)이 같은 파일을 쓴다.
 */

export interface CollectRun {
  channel: string;
  kind: string;
  started_at: string;
  finished_at: string;
  window_from: string;
  window_to: string;
  fetched: number;
  inserted: number;
  ok: boolean;
  error: string | null;
}

/** 수집 엔진이 쓰는 저장 기능 (테스트에서는 가짜로 바꿔 끼운다) */
export interface Store {
  /** 새로 들어온 건수를 돌려준다 */
  upsertInquiries(rows: InquiryUpsert[]): Promise<number>;
  lastSuccessfulWindowEnd(channel: string, kind: string): Promise<Date | null>;
  recordRun(run: CollectRun): Promise<void>;
  heartbeat(workerId: string, mode: "operating" | "idle", detail: Record<string, unknown>): Promise<void>;
  loadHolidays(): Promise<Set<string>>;
  saveHolidays(rows: Array<{ date: string; name: string; source: "builtin" | "api" }>): Promise<void>;
  loadOperating(): Promise<{ operating: OperatingConfig; intervalMin: number }>;
  audit(action: string, detail: Record<string, unknown>, actor?: string): Promise<void>;
  /** "최근 N일 다시 가져오기" 요청이 있으면 N을 돌려주고 요청을 지운다 */
  takeBackfill(): Promise<number | null>;
}

export interface User {
  id: number;
  login: string;
  name: string;
  role: Role;
  active: boolean;
  email?: string | null;
  notify?: boolean;
}

export interface InquiryFilter {
  channel?: string;
  kind?: string;
  status?: string;
  route?: string;
  pii?: boolean;
  q?: string;
  sort?: "received" | "deadline";
  page?: number;
  pageSize?: number;
}

const SCHEMA = `
create table if not exists users (
  id integer primary key autoincrement,
  login text not null unique collate nocase,
  name text not null,
  role text not null default 'agent' check (role in ('admin','approver','agent')),
  active integer not null default 1,
  pw_hash text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists sessions (
  token_hash text primary key,
  user_id integer not null references users(id) on delete cascade,
  expires_at text not null
);
create table if not exists inquiries (
  id integer primary key autoincrement,
  channel text not null,
  kind text not null,
  external_id text not null,
  product_id text, product_name text, order_id text, customer_masked text, title text,
  body_masked text not null,
  pii_detected integer not null default 0,
  received_at text not null,
  deadline_at text,
  platform_answered integer not null default 0,
  platform_answer text, platform_status text,
  can_reply integer not null default 1,
  meta text not null default '{}',
  status text not null default 'new' check (status in ('new','answered_on_platform','closed')),
  first_seen_at text not null,
  last_seen_at text not null,
  unique (channel, kind, external_id)
);
create index if not exists inquiries_received_idx on inquiries (received_at desc);
create index if not exists inquiries_status_idx on inquiries (status);
create table if not exists holidays (
  date text primary key,
  name text not null,
  source text not null check (source in ('builtin','api','company'))
);
create table if not exists settings (key text primary key, value text not null);
insert or ignore into settings (key, value) values
  ('operating', '{"start":"09:00","end":"18:00","weekdays":[1,2,3,4,5]}'),
  ('collect_interval_min', '10');
create table if not exists worker_heartbeat (
  worker_id text primary key, beat_at text not null, mode text not null, detail text not null default '{}'
);
create table if not exists collect_runs (
  id integer primary key autoincrement,
  channel text not null, kind text not null,
  started_at text not null, finished_at text, window_from text, window_to text,
  fetched integer not null default 0, inserted integer not null default 0,
  ok integer, error text
);
create index if not exists collect_runs_lookup_idx on collect_runs (channel, kind, started_at desc);
create table if not exists knowledge (
  id integer primary key autoincrement,
  active integer not null default 1,
  category text not null default 'other',
  title text not null,
  products text not null default '[]',
  keywords text not null default '[]',
  example text,
  answer text not null default '',
  conditions text,
  min_route text not null default 'auto' check (min_route in ('auto','approve','human')),
  valid_until text,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by text
);
create table if not exists products (
  name text primary key,
  aliases text not null default '[]',
  absorb_ml text, features text, size_guide text, wash_guide text, caution text
);
create table if not exists drafts (
  id integer primary key autoincrement,
  inquiry_id integer not null references inquiries(id) on delete cascade,
  text text not null,
  route text not null,
  category text,
  confidence real,
  knowledge_ids text not null default '[]',
  detail text not null default '{}',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by text not null default 'system'
);
create index if not exists drafts_inquiry_idx on drafts (inquiry_id, id desc);
create table if not exists approvals (
  id integer primary key autoincrement,
  inquiry_id integer not null references inquiries(id) on delete cascade,
  draft_id integer,
  action text not null,
  actor text not null,
  memo text,
  at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create index if not exists approvals_inquiry_idx on approvals (inquiry_id, id);
create table if not exists post_jobs (
  id integer primary key autoincrement,
  inquiry_id integer not null references inquiries(id) on delete cascade,
  draft_id integer not null,
  idempotency_key text not null unique,
  status text not null,
  payload text not null,
  response text,
  attempts integer not null default 0,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text
);
create table if not exists notifications (
  id integer primary key autoincrement,
  key text not null unique,
  kind text not null,
  recipients text not null,
  subject text not null,
  body text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at text
);
create index if not exists notifications_status_idx on notifications (status);
create table if not exists reviews (
  id integer primary key autoincrement,
  channel text not null,
  review_key text not null,
  product_id text, product_name text, product text,
  rating integer, review_type text,
  body_masked text not null, prev_body_masked text,
  has_photo integer not null default 0,
  author_masked text, written_at text,
  platform_replied integer not null default 0,
  hidden integer not null default 0,
  caution integer not null default 0,
  caution_reasons text not null default '[]',
  draft_text text, draft_templates text not null default '[]', draft_edited_by text,
  status text not null default 'new',
  done_by text, done_at text,
  first_seen_at text not null, last_seen_at text not null,
  unique (channel, review_key)
);
create index if not exists reviews_status_idx on reviews (status, caution, written_at);
create table if not exists review_files (
  id integer primary key autoincrement,
  channel text not null, filename text, uploaded_by text,
  uploaded_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  total integer, inserted integer, auto_done integer
);
create table if not exists audit_log (
  id integer primary key autoincrement,
  at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor text, action text not null, detail text not null default '{}'
);
`;

// ───────── 비밀번호 ─────────
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split("$");
  if (alg !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(pw, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha = (s: string) => scryptSync(s, "drc-session", 32).toString("hex");

type Row = Record<string, unknown>;

function toInquiry(r: Row) {
  return {
    ...r,
    pii_detected: !!r.pii_detected,
    platform_answered: !!r.platform_answered,
    can_reply: !!r.can_reply,
    meta: JSON.parse(String(r.meta ?? "{}")),
  };
}

export class HubDb implements Store {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** 예전 데이터 파일에 새 칸 추가 (Phase 2) */
  private migrate() {
    const cols = new Set((this.db.prepare("pragma table_info(inquiries)").all() as Row[]).map((r) => String(r.name)));
    if (!cols.has("route")) this.db.exec("alter table inquiries add column route text");
    if (!cols.has("category")) this.db.exec("alter table inquiries add column category text");
    if (!cols.has("drafted_at")) this.db.exec("alter table inquiries add column drafted_at text");
    this.db.exec("create index if not exists inquiries_route_idx on inquiries (route)");
    // Phase 3: 승인·잠금·처리 완료
    for (const c of ["approved_at", "approved_by", "closed_at", "closed_by", "locked_by", "locked_name", "locked_at"]) {
      if (!cols.has(c)) this.db.exec(`alter table inquiries add column ${c} text`);
    }
    const ucols = new Set((this.db.prepare("pragma table_info(users)").all() as Row[]).map((r) => String(r.name)));
    if (!ucols.has("email")) this.db.exec("alter table users add column email text");
    if (!ucols.has("notify")) this.db.exec("alter table users add column notify integer not null default 1");
  }

  close() {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("begin");
    try {
      const r = fn();
      this.db.exec("commit");
      return r;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  // ───────── 수집 엔진용 (Store) ─────────
  async upsertInquiries(rows: InquiryUpsert[]): Promise<number> {
    const exists = this.db.prepare("select 1 from inquiries where channel = ? and kind = ? and external_id = ?");
    // status·first_seen_at은 덮어쓰지 않아 처리 상태가 유지된다
    const up = this.db.prepare(`
      insert into inquiries (channel, kind, external_id, product_id, product_name, order_id, customer_masked, title,
        body_masked, pii_detected, received_at, deadline_at, platform_answered, platform_answer, platform_status,
        can_reply, meta, first_seen_at, last_seen_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict (channel, kind, external_id) do update set
        product_id = excluded.product_id, product_name = excluded.product_name, order_id = excluded.order_id,
        customer_masked = excluded.customer_masked, title = excluded.title, body_masked = excluded.body_masked,
        pii_detected = excluded.pii_detected, received_at = excluded.received_at, deadline_at = excluded.deadline_at,
        platform_answered = excluded.platform_answered, platform_answer = excluded.platform_answer,
        platform_status = excluded.platform_status, can_reply = excluded.can_reply, meta = excluded.meta,
        last_seen_at = excluded.last_seen_at,
        status = case when inquiries.status = 'new' and excluded.platform_answered = 1 then 'answered_on_platform' else inquiries.status end
    `);
    return this.tx(() => {
      let inserted = 0;
      for (const r of rows) {
        if (!exists.get(r.channel, r.kind, r.external_id)) inserted++;
        up.run(
          r.channel, r.kind, r.external_id, r.product_id, r.product_name, r.order_id, r.customer_masked, r.title,
          r.body_masked, r.pii_detected ? 1 : 0, r.received_at, r.deadline_at, r.platform_answered ? 1 : 0,
          r.platform_answer, r.platform_status, r.can_reply ? 1 : 0, JSON.stringify(r.meta ?? {}), r.last_seen_at, r.last_seen_at,
        );
      }
      // 새로 들어온 건이 이미 판매자센터에서 답변된 경우
      this.db.prepare("update inquiries set status = 'answered_on_platform' where status = 'new' and platform_answered = 1").run();
      return inserted;
    });
  }

  async lastSuccessfulWindowEnd(channel: string, kind: string): Promise<Date | null> {
    const r = this.db
      .prepare("select window_to from collect_runs where channel = ? and kind = ? and ok = 1 order by id desc limit 1")
      .get(channel, kind) as Row | undefined;
    return r?.window_to ? new Date(String(r.window_to)) : null;
  }

  async recordRun(run: CollectRun): Promise<void> {
    this.db
      .prepare(
        "insert into collect_runs (channel, kind, started_at, finished_at, window_from, window_to, fetched, inserted, ok, error) values (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(run.channel, run.kind, run.started_at, run.finished_at, run.window_from, run.window_to, run.fetched, run.inserted, run.ok ? 1 : 0, run.error);
    // 기록은 90일만 보관
    this.db.prepare("delete from collect_runs where started_at < ?").run(new Date(Date.now() - 90 * 86400e3).toISOString());
  }

  async heartbeat(workerId: string, mode: "operating" | "idle", detail: Record<string, unknown>): Promise<void> {
    this.db
      .prepare(
        "insert into worker_heartbeat (worker_id, beat_at, mode, detail) values (?,?,?,?) on conflict (worker_id) do update set beat_at = excluded.beat_at, mode = excluded.mode, detail = excluded.detail",
      )
      .run(workerId, new Date().toISOString(), mode, JSON.stringify(detail));
  }

  async loadHolidays(): Promise<Set<string>> {
    return new Set((this.db.prepare("select date from holidays").all() as Row[]).map((r) => String(r.date)));
  }

  async saveHolidays(rows: Array<{ date: string; name: string; source: "builtin" | "api" }>): Promise<void> {
    // 회사 휴무일(company)은 덮어쓰지 않는다
    const st = this.db.prepare(
      "insert into holidays (date, name, source) values (?,?,?) on conflict (date) do update set name = excluded.name, source = excluded.source where holidays.source <> 'company'",
    );
    this.tx(() => rows.forEach((r) => st.run(r.date, r.name, r.source)));
  }

  async loadOperating(): Promise<{ operating: OperatingConfig; intervalMin: number }> {
    const op = this.getSetting<OperatingConfig>("operating") ?? DEFAULT_OPERATING;
    const interval = Number(this.getSetting("collect_interval_min") ?? 10);
    return {
      operating: { ...DEFAULT_OPERATING, ...op },
      intervalMin: Number.isFinite(interval) && interval >= 5 ? interval : 10,
    };
  }

  async audit(action: string, detail: Record<string, unknown>, actor = "worker"): Promise<void> {
    this.db.prepare("insert into audit_log (actor, action, detail) values (?,?,?)").run(actor, action, JSON.stringify(detail));
  }

  setSetting(key: string, value: unknown) {
    this.db.prepare("insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(key, JSON.stringify(value));
  }

  /** 수집 기록을 지워서 다음 수집 때 처음부터(N일 전부터) 다시 가져오게 한다. 이미 받은 문의는 중복 저장되지 않음 */
  requestBackfill(days: number, channel?: string) {
    if (channel) this.db.prepare("delete from collect_runs where channel = ?").run(channel);
    else this.db.prepare("delete from collect_runs").run();
    this.setSetting("backfill_days", days);
  }

  async takeBackfill(): Promise<number | null> {
    const days = this.getSetting<number>("backfill_days");
    if (!days) return null;
    this.db.prepare("delete from settings where key = 'backfill_days'").run();
    return Number(days);
  }

  getSetting<T = unknown>(key: string): T | null {
    const r = this.db.prepare("select value from settings where key = ?").get(key) as Row | undefined;
    return r ? (JSON.parse(String(r.value)) as T) : null;
  }

  // ───────── 사용자·로그인 ─────────
  userCount(): number {
    return Number((this.db.prepare("select count(*) n from users").get() as Row).n);
  }

  createUser(login: string, name: string, password: string, role: Role): User {
    const r = this.db
      .prepare("insert into users (login, name, role, pw_hash) values (?,?,?,?) returning id, login, name, role, active")
      .get(login.trim(), name.trim(), role, hashPassword(password)) as Row;
    return { ...(r as unknown as User), active: !!r.active };
  }

  listUsers(): User[] {
    return (this.db.prepare("select id, login, name, role, active, email, notify from users order by id").all() as Row[]).map(
      (r) => ({ ...(r as unknown as User), active: !!r.active, notify: !!r.notify }),
    );
  }

  updateUser(id: number, patch: { role?: Role; active?: boolean; password?: string; name?: string; email?: string | null; notify?: boolean }) {
    if (patch.email !== undefined) this.db.prepare("update users set email = ? where id = ?").run(patch.email ? patch.email.trim() : null, id);
    if (patch.notify !== undefined) this.db.prepare("update users set notify = ? where id = ?").run(patch.notify ? 1 : 0, id);
    if (patch.role) this.db.prepare("update users set role = ? where id = ?").run(patch.role, id);
    if (patch.active !== undefined) {
      this.db.prepare("update users set active = ? where id = ?").run(patch.active ? 1 : 0, id);
      if (!patch.active) this.db.prepare("delete from sessions where user_id = ?").run(id);
    }
    if (patch.name) this.db.prepare("update users set name = ? where id = ?").run(patch.name.trim(), id);
    if (patch.password) {
      this.db.prepare("update users set pw_hash = ? where id = ?").run(hashPassword(patch.password), id);
      this.db.prepare("delete from sessions where user_id = ?").run(id);
    }
  }

  /** 로그인 성공 시 세션 토큰 발급 */
  login(login: string, password: string, days = 14): { token: string; user: User } | null {
    const r = this.db.prepare("select * from users where login = ?").get(login.trim()) as Row | undefined;
    if (!r || !r.active || !verifyPassword(password, String(r.pw_hash))) return null;
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + days * 86400e3).toISOString();
    this.db.prepare("insert into sessions (token_hash, user_id, expires_at) values (?,?,?)").run(sha(token), r.id as number, expires);
    this.db.prepare("delete from sessions where expires_at < ?").run(new Date().toISOString());
    return { token, user: { id: Number(r.id), login: String(r.login), name: String(r.name), role: r.role as Role, active: true } };
  }

  userBySession(token: string | undefined): User | null {
    if (!token) return null;
    const r = this.db
      .prepare(
        "select u.id, u.login, u.name, u.role, u.active from sessions s join users u on u.id = s.user_id where s.token_hash = ? and s.expires_at > ? and u.active = 1",
      )
      .get(sha(token), new Date().toISOString()) as Row | undefined;
    return r ? { ...(r as unknown as User), active: true } : null;
  }

  logout(token: string) {
    this.db.prepare("delete from sessions where token_hash = ?").run(sha(token));
  }

  // ───────── 화면용 조회 ─────────
  listInquiries(f: InquiryFilter): { rows: unknown[]; total: number } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (f.channel) (where.push("channel = ?"), args.push(f.channel));
    if (f.kind) (where.push("kind = ?"), args.push(f.kind));
    if (f.status === "approved") where.push("status = 'new' and approved_at is not null");
    else if (f.status === "new") where.push("status = 'new' and approved_at is null");
    else if (f.status) (where.push("status = ?"), args.push(f.status));
    if (f.route) (where.push("route = ?"), args.push(f.route));
    if (f.pii) where.push("pii_detected = 1");
    if (f.q) {
      where.push("(body_masked like ? or product_name like ? or title like ? or order_id like ?)");
      const like = `%${f.q.replace(/[%_]/g, "")}%`;
      args.push(like, like, like, like);
    }
    const w = where.length ? `where ${where.join(" and ")}` : "";
    const order = f.sort === "deadline" ? "deadline_at is null, deadline_at asc, received_at desc" : "received_at desc";
    const size = Math.min(f.pageSize ?? 30, 100);
    const page = Math.max(1, f.page ?? 1);
    const total = Number((this.db.prepare(`select count(*) n from inquiries ${w}`).get(...args) as Row).n);
    const rows = (this.db.prepare(`select * from inquiries ${w} order by ${order} limit ? offset ?`).all(...args, size, (page - 1) * size) as Row[]).map(toInquiry);
    return { rows, total };
  }

  getInquiry(id: number) {
    const r = this.db.prepare("select * from inquiries where id = ?").get(id) as Row | undefined;
    return r ? toInquiry(r) : null;
  }

  summary(todayStartIso: string) {
    const n = (sql: string, ...a: string[]) => Number((this.db.prepare(sql).get(...a) as Row).n);
    const soon = new Date(Date.now() + 4 * 3600e3).toISOString();
    const runs = this.db
      .prepare(
        `select channel, kind, started_at, ok, inserted, error from collect_runs c
         where id = (select max(id) from collect_runs where channel = c.channel and kind = c.kind) order by channel, kind`,
      )
      .all() as Row[];
    return {
      newTotal: n("select count(*) n from inquiries where status = 'new' and approved_at is null"),
      approved: n("select count(*) n from inquiries where status = 'new' and approved_at is not null"),
      dueSoon: n("select count(*) n from inquiries where status = 'new' and approved_at is null and can_reply = 1 and deadline_at is not null and deadline_at <= ?", soon),
      pii: n("select count(*) n from inquiries where status = 'new' and approved_at is null and pii_detected = 1"),
      today: n("select count(*) n from inquiries where first_seen_at >= ?", todayStartIso),
      routeAuto: n("select count(*) n from inquiries where status = 'new' and approved_at is null and route = 'auto'"),
      routeApprove: n("select count(*) n from inquiries where status = 'new' and approved_at is null and route = 'approve'"),
      routeHuman: n("select count(*) n from inquiries where status = 'new' and approved_at is null and route = 'human'"),
      reviewsTodo: n("select count(*) n from reviews where status = 'new'"),
      reviewsCaution: n("select count(*) n from reviews where status = 'new' and caution = 1"),
      runs: runs.map((r) => ({ ...r, ok: !!r.ok })),
    };
  }

  status() {
    const r = this.db.prepare("select * from worker_heartbeat order by beat_at desc limit 1").get() as Row | undefined;
    return r ? { ...r, detail: JSON.parse(String(r.detail ?? "{}")) } : null;
  }

  listHolidays(fromDate: string) {
    return this.db.prepare("select date, name, source from holidays where date >= ? order by date limit 60").all(fromDate);
  }

  addCompanyHoliday(date: string, name: string): boolean {
    const r = this.db.prepare("insert or ignore into holidays (date, name, source) values (?,?,'company')").run(date, name.trim());
    return Number(r.changes) > 0;
  }

  deleteCompanyHoliday(date: string): boolean {
    return Number(this.db.prepare("delete from holidays where date = ? and source = 'company'").run(date).changes) > 0;
  }

  // ───────── 지식 DB·상품 ─────────
  knowledgeEntries(onlyActive = true): KnowledgeEntry[] {
    const rows = this.db.prepare(`select * from knowledge ${onlyActive ? "where active = 1" : ""} order by id`).all() as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      category: String(r.category),
      products: JSON.parse(String(r.products)),
      keywords: JSON.parse(String(r.keywords)),
      answer: String(r.answer),
      conditions: (r.conditions as string) ?? null,
      minRoute: r.min_route as Route,
      active: !!r.active,
      validUntil: (r.valid_until as string) ?? null,
    }));
  }

  listKnowledge(): Array<Record<string, unknown> & { id: number; title: string; conditions: string | null; products: string[]; keywords: string[]; active: boolean }> {
    return (this.db.prepare("select * from knowledge order by id").all() as Row[]).map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      conditions: (r.conditions as string) ?? null,
      ...r,
      active: !!r.active,
      products: JSON.parse(String(r.products)),
      keywords: JSON.parse(String(r.keywords)),
    }));
  }

  productInfos(): ProductInfo[] {
    return (this.db.prepare("select name, aliases from products").all() as Row[]).map((r) => ({
      name: String(r.name),
      aliases: JSON.parse(String(r.aliases)),
    }));
  }

  listProducts(): Array<Record<string, unknown> & { name: string; aliases: string[] }> {
    return (this.db.prepare("select * from products order by name").all() as Row[]).map((r) => ({ ...r, name: String(r.name), aliases: JSON.parse(String(r.aliases)) }));
  }

  /** 엑셀 올리기: 지식 DB·상품 정보를 통째로 바꾼다 (바꾸기 전 자동 백업은 호출하는 쪽에서) */
  replaceKnowledge(
    entries: Array<Omit<KnowledgeEntry, "id"> & { id?: number; example?: string | null }>,
    products: Array<{ name: string; aliases: string[]; absorb_ml?: string | null; features?: string | null; size_guide?: string | null; wash_guide?: string | null; caution?: string | null }>,
    actor: string,
  ) {
    this.tx(() => {
      this.db.exec("delete from knowledge; delete from products;");
      const ins = this.db.prepare(
        "insert into knowledge (id, active, category, title, products, keywords, example, answer, conditions, min_route, valid_until, updated_by) values (?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const e of entries) {
        ins.run(e.id ?? null, e.active ? 1 : 0, e.category, e.title, JSON.stringify(e.products), JSON.stringify(e.keywords), e.example ?? null, e.answer, e.conditions, e.minRoute, e.validUntil, actor);
      }
      const insP = this.db.prepare("insert or replace into products (name, aliases, absorb_ml, features, size_guide, wash_guide, caution) values (?,?,?,?,?,?,?)");
      for (const p of products) insP.run(p.name, JSON.stringify(p.aliases), p.absorb_ml ?? null, p.features ?? null, p.size_guide ?? null, p.wash_guide ?? null, p.caution ?? null);
    });
  }

  updateKnowledge(id: number, patch: { active?: boolean; answer?: string }, actor: string): boolean {
    const now = new Date().toISOString();
    let changed = 0;
    if (patch.active !== undefined) changed += Number(this.db.prepare("update knowledge set active = ?, updated_at = ?, updated_by = ? where id = ?").run(patch.active ? 1 : 0, now, actor, id).changes);
    if (patch.answer !== undefined) changed += Number(this.db.prepare("update knowledge set answer = ?, updated_at = ?, updated_by = ? where id = ?").run(patch.answer, now, actor, id).changes);
    return changed > 0;
  }

  // ───────── 분류·초안 ─────────
  /** 아직 분류·초안이 없는 신규 문의 */
  pendingForDraft(limit = 200): Array<{ id: number; channel: string; body_masked: string; title: string | null; product_name: string | null; pii_detected: boolean; order_id: string | null; platform_answered: boolean }> {
    return (this.db.prepare("select * from inquiries where drafted_at is null order by id limit ?").all(limit) as Row[]).map((r) => ({
      id: Number(r.id),
      channel: String(r.channel),
      body_masked: String(r.body_masked),
      title: (r.title as string) ?? null,
      product_name: (r.product_name as string) ?? null,
      pii_detected: !!r.pii_detected,
      order_id: (r.order_id as string) ?? null,
      platform_answered: !!r.platform_answered,
    }));
  }

  /** 같은 주문의 다른 불만 문의 수 (반복 불만 → 사람 전용) */
  priorComplaints(orderId: string | null, excludeId: number): number {
    if (!orderId) return 0;
    return Number(
      (this.db
        .prepare("select count(*) n from inquiries where order_id = ? and id <> ? and category in ('exchange','wrong','defect','complaint')")
        .get(orderId, excludeId) as Row).n,
    );
  }

  /** 시스템이 만든 초안 저장 + 문의에 경로·분류 기록 */
  saveSystemDraft(inquiryId: number, r: DraftResult) {
    this.tx(() => {
      this.db
        .prepare("insert into drafts (inquiry_id, text, route, category, confidence, knowledge_ids, detail, created_by) values (?,?,?,?,?,?,?, 'system')")
        .run(inquiryId, r.text, r.route, r.classification.category, r.confidence, JSON.stringify(r.usedIds), JSON.stringify({
          categoryLabel: r.classification.categoryLabel,
          products: r.products,
          matches: r.matches,
          conditions: r.conditions,
          forbidden: r.forbidden,
          warnings: r.warnings,
          reasons: r.reasons,
        }));
      this.db.prepare("update inquiries set route = ?, category = ?, drafted_at = ? where id = ?").run(r.route, r.classification.category, new Date().toISOString(), inquiryId);
    });
  }

  /** 담당자가 고친 초안 저장 (경로는 그대로, 사람 수정본으로 기록) */
  saveEditedDraft(inquiryId: number, text: string, actor: string, check: { forbidden: unknown[]; warnings: string[] }) {
    const last = this.latestDraft(inquiryId);
    this.db
      .prepare("insert into drafts (inquiry_id, text, route, category, confidence, knowledge_ids, detail, created_by) values (?,?,?,?,?,?,?,?)")
      .run(inquiryId, text, (last?.route as string) ?? "approve", (last?.category as string) ?? null, null, JSON.stringify(last?.knowledge_ids ?? []), JSON.stringify({ ...((last?.detail as object) ?? {}), forbidden: check.forbidden, warnings: check.warnings, edited: true }), actor);
  }

  latestDraft(inquiryId: number): Record<string, unknown> | null {
    const r = this.db.prepare("select * from drafts where inquiry_id = ? order by id desc limit 1").get(inquiryId) as Row | undefined;
    if (!r) return null;
    return { ...r, knowledge_ids: JSON.parse(String(r.knowledge_ids)), detail: JSON.parse(String(r.detail)) };
  }

  /** 지식 DB가 바뀌면 사람이 손대지 않은 신규 문의 초안을 다시 만들도록 표시 */
  markForRedraft(): number {
    return Number(
      this.db
        .prepare(
          "update inquiries set drafted_at = null where status = 'new' and approved_at is null and not exists (select 1 from drafts d where d.inquiry_id = inquiries.id and d.created_by <> 'system')",
        )
        .run().changes,
    );
  }

  resetDraft(inquiryId: number) {
    this.db.prepare("update inquiries set drafted_at = null where id = ?").run(inquiryId);
  }

  // ───────── 동시 처리 잠금 (5분, 화면이 열려 있는 동안 1분마다 갱신) ─────────
  static LOCK_MS = 5 * 60_000;

  /** 잠금 잡기·갱신. 다른 사람이 잡고 있으면 그 사람 정보를 돌려준다 */
  lock(inquiryId: number, user: { login: string; name: string }): { mine: boolean; by: string | null; name: string | null } {
    const now = new Date();
    const expired = new Date(now.getTime() - HubDb.LOCK_MS).toISOString();
    const r = this.db
      .prepare(
        "update inquiries set locked_by = ?, locked_name = ?, locked_at = ? where id = ? and (locked_by is null or locked_by = ? or locked_at < ?)",
      )
      .run(user.login, user.name, now.toISOString(), inquiryId, user.login, expired);
    if (Number(r.changes) > 0) return { mine: true, by: user.login, name: user.name };
    const cur = this.db.prepare("select locked_by, locked_name from inquiries where id = ?").get(inquiryId) as Row | undefined;
    return { mine: false, by: (cur?.locked_by as string) ?? null, name: (cur?.locked_name as string) ?? null };
  }

  unlock(inquiryId: number, login: string) {
    this.db.prepare("update inquiries set locked_by = null, locked_name = null, locked_at = null where id = ? and locked_by = ?").run(inquiryId, login);
  }

  /** 지금 다른 사람이 처리 중인가 */
  lockedByOther(inquiryId: number, login: string): string | null {
    const r = this.db.prepare("select locked_by, locked_name, locked_at from inquiries where id = ?").get(inquiryId) as Row | undefined;
    if (!r?.locked_by || r.locked_by === login) return null;
    if (Date.parse(String(r.locked_at)) < Date.now() - HubDb.LOCK_MS) return null;
    return String(r.locked_name ?? r.locked_by);
  }

  // ───────── 승인·반려·처리 완료 ─────────
  /**
   * 승인: 조건부 갱신으로 두 사람이 동시에 승인하는 것을 막는다 (같은 문의 등록 요청은 1건만 — idempotency_key 유일)
   * dryRun이면 "실제로 보냈을 요청"만 기록 (Phase 5 전까지)
   */
  approve(
    inquiryId: number,
    draftId: number,
    actor: string,
    action: "approve" | "approve_edited",
    payload: Record<string, unknown>,
    dryRun: boolean,
  ): boolean {
    return this.tx(() => {
      const now = new Date().toISOString();
      const r = this.db
        .prepare("update inquiries set approved_at = ?, approved_by = ? where id = ? and status = 'new' and approved_at is null")
        .run(now, actor, inquiryId);
      if (Number(r.changes) === 0) return false;
      const q = this.db.prepare("select channel, kind, external_id from inquiries where id = ?").get(inquiryId) as Row;
      this.db
        .prepare("insert into post_jobs (inquiry_id, draft_id, idempotency_key, status, payload) values (?,?,?,?,?)")
        .run(inquiryId, draftId, `${q.channel}:${q.kind}:${q.external_id}`, dryRun ? "dry_run" : "pending", JSON.stringify(payload));
      this.db.prepare("insert into approvals (inquiry_id, draft_id, action, actor) values (?,?,?,?)").run(inquiryId, draftId, action, actor);
      this.db.prepare("update inquiries set locked_by = null, locked_name = null, locked_at = null where id = ?").run(inquiryId);
      return true;
    });
  }

  /** 승인 취소 (아직 마켓에 실제로 등록되지 않은 경우만) */
  unapprove(inquiryId: number, actor: string): boolean {
    return this.tx(() => {
      const job = this.db.prepare("select status from post_jobs where inquiry_id = ?").get(inquiryId) as Row | undefined;
      if (job && !["dry_run", "pending", "failed"].includes(String(job.status))) return false;
      const r = this.db.prepare("update inquiries set approved_at = null, approved_by = null where id = ? and status = 'new' and approved_at is not null").run(inquiryId);
      if (Number(r.changes) === 0) return false;
      this.db.prepare("delete from post_jobs where inquiry_id = ?").run(inquiryId);
      this.db.prepare("insert into approvals (inquiry_id, action, actor) values (?, 'unapprove', ?)").run(inquiryId, actor);
      return true;
    });
  }

  reject(inquiryId: number, draftId: number | null, actor: string, memo: string) {
    this.db.prepare("insert into approvals (inquiry_id, draft_id, action, actor, memo) values (?,?, 'reject', ?, ?)").run(inquiryId, draftId, actor, memo);
  }

  /** 직접 처리 완료 (판매자센터에서 직접 답변했거나 답변이 필요 없는 경우) */
  closeInquiry(inquiryId: number, actor: string, memo: string | null): boolean {
    return this.tx(() => {
      const now = new Date().toISOString();
      const r = this.db
        .prepare("update inquiries set status = 'closed', closed_at = ?, closed_by = ?, locked_by = null, locked_name = null, locked_at = null where id = ? and status <> 'closed'")
        .run(now, actor, inquiryId);
      if (Number(r.changes) === 0) return false;
      this.db.prepare("insert into approvals (inquiry_id, action, actor, memo) values (?, 'close', ?, ?)").run(inquiryId, actor, memo);
      return true;
    });
  }

  history(inquiryId: number) {
    return this.db.prepare("select action, actor, memo, at from approvals where inquiry_id = ? order by id").all(inquiryId);
  }

  postJob(inquiryId: number) {
    const r = this.db.prepare("select * from post_jobs where inquiry_id = ?").get(inquiryId) as Row | undefined;
    return r ? { ...r, payload: JSON.parse(String(r.payload)) } : null;
  }

  // ───────── 알림 ─────────
  /** 같은 key는 한 번만 (중복 알림 금지). 새로 넣었으면 true */
  enqueueNotification(n: { key: string; kind: string; recipients: string[]; subject: string; body: string }): boolean {
    if (!n.recipients.length) return false;
    const r = this.db
      .prepare("insert or ignore into notifications (key, kind, recipients, subject, body) values (?,?,?,?,?)")
      .run(n.key, n.kind, JSON.stringify(n.recipients), n.subject, n.body);
    return Number(r.changes) > 0;
  }

  pendingNotifications(maxAttempts: number) {
    return (this.db.prepare("select * from notifications where status = 'pending' and attempts < ? order by id limit 20").all(maxAttempts) as Row[]).map((r) => ({
      id: Number(r.id),
      kind: String(r.kind),
      recipients: JSON.parse(String(r.recipients)) as string[],
      subject: String(r.subject),
      body: String(r.body),
      attempts: Number(r.attempts),
    }));
  }

  markNotification(id: number, ok: boolean, error: string | null, maxAttempts: number) {
    if (ok) this.db.prepare("update notifications set status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = null where id = ?").run(new Date().toISOString(), id);
    else
      this.db
        .prepare("update notifications set attempts = attempts + 1, last_error = ?, status = case when attempts + 1 >= ? then 'failed' else 'pending' end where id = ?")
        .run(error, maxAttempts, id);
  }

  recentNotifications(limit = 20) {
    return this.db.prepare("select id, kind, subject, status, attempts, last_error, created_at, sent_at from notifications order by id desc limit ?").all(limit);
  }

  failedNotificationCount(sinceIso: string): number {
    return Number((this.db.prepare("select count(*) n from notifications where status = 'failed' and created_at >= ?").get(sinceIso) as Row).n);
  }

  /** 알림 받을 사람 이메일 (adminsOnly면 관리자만) */
  notifyEmails(adminsOnly = false): string[] {
    const rows = this.db
      .prepare(`select email from users where active = 1 and notify = 1 and email is not null and email <> '' ${adminsOnly ? "and role = 'admin'" : ""}`)
      .all() as Row[];
    return [...new Set(rows.map((r) => String(r.email).trim()).filter(Boolean))];
  }

  /** 알림용 숫자 (개인정보 없음) */
  countsForNotify(sinceIso: string | null) {
    const n = (sql: string, ...a: string[]) => Number((this.db.prepare(sql).get(...a) as Row).n);
    const since = sinceIso ?? "1970-01-01T00:00:00Z";
    return {
      newSince: n("select count(*) n from inquiries where first_seen_at > ? and status = 'new'", since),
      newSinceByRoute: {
        auto: n("select count(*) n from inquiries where first_seen_at > ? and status = 'new' and route = 'auto'", since),
        approve: n("select count(*) n from inquiries where first_seen_at > ? and status = 'new' and route = 'approve'", since),
        human: n("select count(*) n from inquiries where first_seen_at > ? and status = 'new' and route = 'human'", since),
      },
      pending: n("select count(*) n from inquiries where status = 'new' and approved_at is null"),
      pendingHuman: n("select count(*) n from inquiries where status = 'new' and approved_at is null and route = 'human'"),
      approvedWaiting: n("select count(*) n from inquiries where status = 'new' and approved_at is not null"),
      reviewsTodo: n("select count(*) n from reviews where status = 'new'"),
    };
  }

  dueSoonCallcenter(withinMs: number): Array<{ id: number; channel: string; deadline_at: string }> {
    const until = new Date(Date.now() + withinMs).toISOString();
    return this.db
      .prepare("select id, channel, deadline_at from inquiries where status = 'new' and approved_at is null and can_reply = 1 and deadline_at is not null and deadline_at <= ? and deadline_at > ?")
      .all(until, new Date().toISOString()) as Array<{ id: number; channel: string; deadline_at: string }>;
  }

  todayStats(startIso: string) {
    const n = (sql: string) => Number((this.db.prepare(sql).get(startIso) as Row).n);
    return {
      received: n("select count(*) n from inquiries where first_seen_at >= ?"),
      approved: n("select count(*) n from approvals where action in ('approve','approve_edited') and at >= ?"),
      closed: n("select count(*) n from approvals where action = 'close' and at >= ?"),
    };
  }

  // ───────── 리뷰 ─────────
  /**
   * 리뷰 엑셀 저장: 리뷰 번호로 중복 제거. 판매자센터에 답글이 달린 리뷰는 자동 '완료'(replied_on_platform),
   * 블라인드는 'hidden'. 담당자 수정 초안·처리 상태는 유지.
   */
  upsertReviews(
    rows: import("./reviewImport.ts").ReviewRow[],
    product: (name: string | null) => string | null,
  ): { inserted: number; autoDone: number } {
    const now = new Date().toISOString();
    const exists = this.db.prepare("select id, status from reviews where channel = ? and review_key = ?");
    const ins = this.db.prepare(`insert into reviews (channel, review_key, product_id, product_name, product, rating, review_type, body_masked, prev_body_masked,
      has_photo, author_masked, written_at, platform_replied, hidden, status, first_seen_at, last_seen_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const upd = this.db.prepare(`update reviews set rating = ?, body_masked = ?, prev_body_masked = ?, has_photo = ?, platform_replied = ?, hidden = ?, last_seen_at = ?,
      status = case when status = 'new' and ? = 1 then 'replied_on_platform' when status = 'new' and ? = 1 then 'hidden' else status end where id = ?`);
    return this.tx(() => {
      let inserted = 0;
      let autoDone = 0;
      for (const r of rows) {
        const cur = exists.get(r.channel, r.review_key) as Row | undefined;
        const status = r.platform_replied ? "replied_on_platform" : r.hidden ? "hidden" : "new";
        if (!cur) {
          ins.run(r.channel, r.review_key, r.product_id, r.product_name, product(r.product_name), r.rating, r.review_type, r.body_masked, r.prev_body_masked,
            r.has_photo ? 1 : 0, r.author_masked, r.written_at, r.platform_replied ? 1 : 0, r.hidden ? 1 : 0, status, now, now);
          inserted++;
        } else {
          if (cur.status === "new" && r.platform_replied) autoDone++;
          upd.run(r.rating, r.body_masked, r.prev_body_masked, r.has_photo ? 1 : 0, r.platform_replied ? 1 : 0, r.hidden ? 1 : 0, now, r.platform_replied ? 1 : 0, r.hidden ? 1 : 0, Number(cur.id));
        }
      }
      return { inserted, autoDone };
    });
  }

  recordReviewFile(channel: string, filename: string, by: string, total: number, inserted: number, autoDone: number) {
    this.db.prepare("insert into review_files (channel, filename, uploaded_by, total, inserted, auto_done) values (?,?,?,?,?,?)").run(channel, filename, by, total, inserted, autoDone);
  }

  lastReviewFiles(limit = 5) {
    return this.db.prepare("select * from review_files order by id desc limit ?").all(limit);
  }

  /** 초안이 아직 없는 처리 대기 리뷰 (오래된 것부터 → 같은 상품 문장 반복 방지가 순서대로 적용) */
  reviewsNeedingDraft(): Array<{ id: number; review_key: string; body_masked: string; rating: number | null; review_type: string | null; has_photo: boolean; product: string | null }> {
    return (this.db.prepare("select * from reviews where status = 'new' and draft_text is null order by written_at, id").all() as Row[]).map((r) => ({
      id: Number(r.id),
      review_key: String(r.review_key),
      body_masked: String(r.body_masked),
      rating: r.rating === null ? null : Number(r.rating),
      review_type: (r.review_type as string) ?? null,
      has_photo: !!r.has_photo,
      product: (r.product as string) ?? null,
    }));
  }

  /** 같은 상품에 최근 쓴 문장 id (반복 방지) */
  recentReviewTemplates(product: string | null, limit = 8): string[] {
    const rows = this.db
      .prepare("select draft_templates from reviews where draft_text is not null and coalesce(product, '') = coalesce(?, '') order by id desc limit ?")
      .all(product, limit) as Row[];
    return rows.flatMap((r) => JSON.parse(String(r.draft_templates)) as string[]);
  }

  saveReviewDraft(id: number, text: string, templates: string[], caution: boolean, reasons: string[]) {
    this.db
      .prepare("update reviews set draft_text = ?, draft_templates = ?, caution = ?, caution_reasons = ? where id = ?")
      .run(text, JSON.stringify(templates), caution ? 1 : 0, JSON.stringify(reasons), id);
  }

  editReviewDraft(id: number, text: string, actor: string): boolean {
    return Number(this.db.prepare("update reviews set draft_text = ?, draft_edited_by = ? where id = ? and status = 'new'").run(text, actor, id).changes) > 0;
  }

  resetReviewDraft(id: number) {
    this.db.prepare("update reviews set draft_text = null, draft_edited_by = null, draft_templates = '[]' where id = ?").run(id);
  }

  setReviewDone(id: number, done: boolean, actor: string): boolean {
    const r = done
      ? this.db.prepare("update reviews set status = 'done', done_by = ?, done_at = ? where id = ? and status = 'new'").run(actor, new Date().toISOString(), id)
      : this.db.prepare("update reviews set status = 'new', done_by = null, done_at = null where id = ? and status = 'done'").run(id);
    return Number(r.changes) > 0;
  }

  listReviews(f: { tab?: string; q?: string; page?: number; channel?: string }) {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (f.tab === "todo" || !f.tab) where.push("status = 'new'");
    else if (f.tab === "caution") where.push("status = 'new' and caution = 1");
    else if (f.tab === "done") where.push("status in ('done','replied_on_platform')");
    if (f.channel) (where.push("channel = ?"), args.push(f.channel));
    if (f.q) {
      where.push("(body_masked like ? or product_name like ?)");
      const like = `%${f.q.replace(/[%_]/g, "")}%`;
      args.push(like, like);
    }
    const w = where.length ? `where ${where.join(" and ")}` : "";
    const page = Math.max(1, f.page ?? 1);
    const total = Number((this.db.prepare(`select count(*) n from reviews ${w}`).get(...args) as Row).n);
    const rows = (this.db
      .prepare(`select * from reviews ${w} order by case when status = 'new' then 0 else 1 end, caution desc, written_at desc limit 30 offset ?`)
      .all(...args, (page - 1) * 30) as Row[]).map((r) => ({
      ...r,
      has_photo: !!r.has_photo,
      caution: !!r.caution,
      platform_replied: !!r.platform_replied,
      caution_reasons: JSON.parse(String(r.caution_reasons)),
    }));
    return { rows, total };
  }

  reviewCounts() {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as Row).n);
    return {
      todo: n("select count(*) n from reviews where status = 'new'"),
      caution: n("select count(*) n from reviews where status = 'new' and caution = 1"),
    };
  }

  // ───────── 백업 ─────────
  /** 지금 상태를 파일로 복사 (사용 중에도 안전한 SQLite 방식) → 30개만 보관 */
  backup(dir: string, keep = 30): string {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const file = join(dir, `drc-cs-hub-${stamp}.db`);
    rmSync(file, { force: true });
    this.db.prepare("vacuum into ?").run(file);
    const old = readdirSync(dir)
      .filter((f) => /^drc-cs-hub-\d{12}\.db$/.test(f))
      .sort()
      .reverse()
      .slice(keep);
    for (const f of old) rmSync(join(dir, f), { force: true });
    return file;
  }
}
