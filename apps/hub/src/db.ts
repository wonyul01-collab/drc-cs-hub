import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_OPERATING, type InquiryUpsert, type OperatingConfig, type Role } from "@drc/shared";

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
}

export interface User {
  id: number;
  login: string;
  name: string;
  role: Role;
  active: boolean;
}

export interface InquiryFilter {
  channel?: string;
  kind?: string;
  status?: string;
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
    return (this.db.prepare("select id, login, name, role, active from users order by id").all() as Row[]).map(
      (r) => ({ ...(r as unknown as User), active: !!r.active }),
    );
  }

  updateUser(id: number, patch: { role?: Role; active?: boolean; password?: string; name?: string }) {
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
    if (f.status) (where.push("status = ?"), args.push(f.status));
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
      newTotal: n("select count(*) n from inquiries where status = 'new'"),
      dueSoon: n("select count(*) n from inquiries where status = 'new' and can_reply = 1 and deadline_at is not null and deadline_at <= ?", soon),
      pii: n("select count(*) n from inquiries where status = 'new' and pii_detected = 1"),
      today: n("select count(*) n from inquiries where first_seen_at >= ?", todayStartIso),
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
