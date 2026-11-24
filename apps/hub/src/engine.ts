import { isOperatingTime, seoulParts, type OperatingConfig } from "@drc/shared";
import { collectAll, type SourceResult } from "./collector.ts";
import { syncHolidays } from "./holidaysSync.ts";
import type { InquirySource } from "./source.ts";
import type { Store } from "./db.ts";
import { log } from "./log.ts";

const MIN = 60_000;

export interface EngineDeps {
  store: Store;
  sources: InquirySource[];
  workerId: string;
  lookbackDays: number;
  dataGoKrKey: string | null;
  /** 수집 직후 실행 (분류·초안 만들기) */
  afterCollect?: () => void | Promise<void>;
}

/**
 * 1분마다 tick()이 불린다.
 * - 운영 시간 밖: 하트비트(10분마다)만 하고 아무 일도 안 함
 * - 운영 시간 안: 하트비트 + 수집 주기마다 문의 수집
 */
export class Engine {
  private holidays = new Set<string>();
  private operating: OperatingConfig | null = null;
  private intervalMin = 10;
  private settingsLoadedAt = 0;
  private lastCollectAt = 0;
  private lastIdleBeatAt = 0;
  private holidaySyncDate = "";
  private busy = false;
  lastResults: SourceResult[] = [];

  constructor(private readonly d: EngineDeps) {}

  private async refreshSettings(now: Date) {
    if (this.operating && now.getTime() - this.settingsLoadedAt < 5 * MIN) return;
    const s = await this.d.store.loadOperating();
    this.operating = s.operating;
    this.intervalMin = s.intervalMin;
    this.holidays = await this.d.store.loadHolidays();
    this.settingsLoadedAt = now.getTime();
  }

  async tick(now: Date = new Date()): Promise<"collected" | "operating" | "idle" | "busy"> {
    if (this.busy) return "busy";
    this.busy = true;
    try {
      // 하루 한 번 공휴일 갱신 (네트워크 외부 호출이지만 마켓·알림이 아니므로 시간 무관)
      const today = seoulParts(now).date;
      if (this.holidaySyncDate !== today) {
        await syncHolidays(this.d.store, this.d.dataGoKrKey, now).catch((e) => log.warn(`공휴일 갱신 실패: ${e}`));
        this.holidaySyncDate = today;
        this.settingsLoadedAt = 0; // 휴일 다시 읽기
      }
      await this.refreshSettings(now);
      const op = isOperatingTime(now, this.holidays, this.operating!);

      if (!op) {
        if (now.getTime() - this.lastIdleBeatAt >= 10 * MIN) {
          await this.d.store.heartbeat(this.d.workerId, "idle", { note: "운영 시간 외 — 대기 중" });
          this.lastIdleBeatAt = now.getTime();
        }
        return "idle";
      }

      const due = now.getTime() - this.lastCollectAt >= this.intervalMin * MIN;
      if (due) {
        if (this.d.sources.length) this.lastResults = await collectAll(this.d.sources, this.d.store, now, this.d.lookbackDays);
        this.lastCollectAt = now.getTime();
        try {
          await this.d.afterCollect?.();
        } catch (e) {
          log.error("분류·초안 만들기 실패", e);
        }
      }
      await this.d.store.heartbeat(this.d.workerId, "operating", {
        lastCollectAt: this.lastCollectAt ? new Date(this.lastCollectAt).toISOString() : null,
        intervalMin: this.intervalMin,
        sourceCount: this.d.sources.length,
        sources: this.lastResults.map((r) => ({ label: r.label, ok: r.ok, inserted: r.inserted, error: r.error?.slice(0, 200) })),
      });
      return due ? "collected" : "operating";
    } finally {
      this.busy = false;
    }
  }
}
