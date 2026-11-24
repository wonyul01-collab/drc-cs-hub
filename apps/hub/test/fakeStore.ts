import { BUILTIN_HOLIDAYS, DEFAULT_OPERATING, type InquiryUpsert } from "@drc/shared";
import type { CollectRun, Store } from "../src/db.ts";

/** 메모리에서 동작하는 가짜 DB */
export class FakeStore implements Store {
  inquiries = new Map<string, InquiryUpsert & { status: string }>();
  runs: CollectRun[] = [];
  beats: Array<{ mode: string; at: number }> = [];
  holidays = new Map<string, { name: string; source: string }>();

  async upsertInquiries(rows: InquiryUpsert[]) {
    let n = 0;
    for (const r of rows) {
      const k = `${r.channel}|${r.kind}|${r.external_id}`;
      const prev = this.inquiries.get(k);
      if (!prev) n++;
      const status = prev?.status ?? "new";
      this.inquiries.set(k, { ...r, status: status === "new" && r.platform_answered ? "answered_on_platform" : status });
    }
    return n;
  }
  async lastSuccessfulWindowEnd(channel: string, kind: string) {
    const r = [...this.runs].reverse().find((x) => x.channel === channel && x.kind === kind && x.ok);
    return r ? new Date(r.window_to) : null;
  }
  async recordRun(run: CollectRun) {
    this.runs.push(run);
  }
  async heartbeat(_id: string, mode: "operating" | "idle") {
    this.beats.push({ mode, at: Date.now() });
  }
  async loadHolidays() {
    return new Set([...this.holidays.keys()]);
  }
  async saveHolidays(rows: Array<{ date: string; name: string; source: "builtin" | "api" }>) {
    for (const r of rows) if (this.holidays.get(r.date)?.source !== "company") this.holidays.set(r.date, r);
  }
  async loadOperating() {
    return { operating: DEFAULT_OPERATING, intervalMin: 10 };
  }
  async audit() {}
  backfill: number | null = null;
  async takeBackfill() {
    const b = this.backfill;
    this.backfill = null;
    return b;
  }
}

export const BUILTIN = BUILTIN_HOLIDAYS;
