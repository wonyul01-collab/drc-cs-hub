import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_OPERATING, type InquiryUpsert, type OperatingConfig } from "@drc/shared";

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

/** 작업기가 DB에 하는 일 전부 (테스트에서는 가짜로 바꿔 끼운다) */
export interface Store {
  /** 새로 들어온 건수를 돌려준다 */
  upsertInquiries(rows: InquiryUpsert[]): Promise<number>;
  lastSuccessfulWindowEnd(channel: string, kind: string): Promise<Date | null>;
  recordRun(run: CollectRun): Promise<void>;
  heartbeat(workerId: string, mode: "operating" | "idle", detail: Record<string, unknown>): Promise<void>;
  loadHolidays(): Promise<Set<string>>;
  saveHolidays(rows: Array<{ date: string; name: string; source: "builtin" | "api" }>): Promise<void>;
  loadOperating(): Promise<{ operating: OperatingConfig; intervalMin: number }>;
  audit(action: string, detail: Record<string, unknown>): Promise<void>;
}

const CHUNK = 200;

export class SupabaseStore implements Store {
  private readonly db: SupabaseClient;
  constructor(url: string, secretKey: string) {
    this.db = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async upsertInquiries(rows: InquiryUpsert[]): Promise<number> {
    let inserted = 0;
    // 같은 배치 안 중복 제거
    const uniq = [...new Map(rows.map((r) => [`${r.channel}|${r.kind}|${r.external_id}`, r])).values()];
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const chunk = uniq.slice(i, i + CHUNK);
      const { channel, kind } = chunk[0];
      const ids = chunk.map((r) => r.external_id);
      const existing = await this.db
        .from("inquiries")
        .select("external_id")
        .eq("channel", channel)
        .eq("kind", kind)
        .in("external_id", ids);
      if (existing.error) throw new Error(`DB 조회 실패: ${existing.error.message}`);
      const have = new Set((existing.data ?? []).map((r) => r.external_id as string));
      inserted += chunk.filter((r) => !have.has(r.external_id)).length;

      // status·first_seen_at은 보내지 않으므로 기존 처리 상태는 유지된다
      const up = await this.db.from("inquiries").upsert(chunk, { onConflict: "channel,kind,external_id" });
      if (up.error) throw new Error(`DB 저장 실패: ${up.error.message}`);
    }
    // 판매자센터에서 이미 답변된 신규 건 → 상태 반영
    const st = await this.db
      .from("inquiries")
      .update({ status: "answered_on_platform" })
      .eq("status", "new")
      .eq("platform_answered", true);
    if (st.error) throw new Error(`DB 상태 갱신 실패: ${st.error.message}`);
    return inserted;
  }

  async lastSuccessfulWindowEnd(channel: string, kind: string): Promise<Date | null> {
    const { data, error } = await this.db
      .from("collect_runs")
      .select("window_to")
      .eq("channel", channel)
      .eq("kind", kind)
      .eq("ok", true)
      .order("started_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`DB 조회 실패: ${error.message}`);
    return data?.[0]?.window_to ? new Date(data[0].window_to as string) : null;
  }

  async recordRun(run: CollectRun): Promise<void> {
    const { error } = await this.db.from("collect_runs").insert(run);
    if (error) throw new Error(`수집 기록 저장 실패: ${error.message}`);
  }

  async heartbeat(workerId: string, mode: "operating" | "idle", detail: Record<string, unknown>): Promise<void> {
    const { error } = await this.db
      .from("worker_heartbeat")
      .upsert({ worker_id: workerId, beat_at: new Date().toISOString(), mode, version: "phase1", detail });
    if (error) throw new Error(`하트비트 저장 실패: ${error.message}`);
  }

  async loadHolidays(): Promise<Set<string>> {
    const { data, error } = await this.db.from("holidays").select("date");
    if (error) throw new Error(`휴일 조회 실패: ${error.message}`);
    return new Set((data ?? []).map((r) => String(r.date)));
  }

  async saveHolidays(rows: Array<{ date: string; name: string; source: "builtin" | "api" }>): Promise<void> {
    if (!rows.length) return;
    // 회사 휴무일(company)은 덮어쓰지 않는다
    const { data, error } = await this.db.from("holidays").select("date").eq("source", "company");
    if (error) throw new Error(`휴일 조회 실패: ${error.message}`);
    const company = new Set((data ?? []).map((r) => String(r.date)));
    const up = await this.db.from("holidays").upsert(rows.filter((r) => !company.has(r.date)), { onConflict: "date" });
    if (up.error) throw new Error(`휴일 저장 실패: ${up.error.message}`);
  }

  async loadOperating(): Promise<{ operating: OperatingConfig; intervalMin: number }> {
    const { data, error } = await this.db.from("settings").select("key,value").in("key", ["operating", "collect_interval_min"]);
    if (error) throw new Error(`설정 조회 실패: ${error.message}`);
    const map = new Map((data ?? []).map((r) => [r.key as string, r.value]));
    const op = (map.get("operating") as OperatingConfig | undefined) ?? DEFAULT_OPERATING;
    const interval = Number(map.get("collect_interval_min") ?? 10);
    return {
      operating: { ...DEFAULT_OPERATING, ...op },
      intervalMin: Number.isFinite(interval) && interval >= 5 ? interval : 10,
    };
  }

  async audit(action: string, detail: Record<string, unknown>): Promise<void> {
    await this.db.from("audit_log").insert({ actor_label: "worker", action, detail });
  }
}
