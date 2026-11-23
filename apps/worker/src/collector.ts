import type { InquirySource } from "./source.ts";
import type { Store } from "./store.ts";
import { log } from "./log.ts";

const DAY = 24 * 3600e3;
/** 지난번 조회 끝 시각보다 1시간 앞에서부터 겹쳐 조회 (늦게 반영된 문의 누락 방지) */
const OVERLAP_MS = 3600e3;

export interface SourceResult {
  label: string;
  fetched: number;
  inserted: number;
  ok: boolean;
  error?: string;
}

/** 조회 구간을 maxDays 이하 조각으로 나눈다 (쿠팡 7일 제한 대응: 6일씩) */
export function splitWindow(from: Date, to: Date, maxDays: number): Array<[Date, Date]> {
  const span = Math.max(1, maxDays - 1) * DAY;
  const out: Array<[Date, Date]> = [];
  let s = from.getTime();
  while (s < to.getTime()) {
    const e = Math.min(s + span, to.getTime());
    out.push([new Date(s), new Date(e)]);
    s = e;
  }
  return out.length ? out : [[from, to]];
}

/** 수집원 하나: 마지막 성공 이후 ~ 지금까지 가져와 DB에 저장 */
export async function collectSource(src: InquirySource, store: Store, now: Date, lookbackDays: number): Promise<SourceResult> {
  const started = new Date();
  const last = await store.lastSuccessfulWindowEnd(src.channel, src.kind);
  const earliest = new Date(now.getTime() - lookbackDays * DAY);
  const from = last ? new Date(Math.max(last.getTime() - OVERLAP_MS, earliest.getTime())) : earliest;

  let fetched = 0;
  let inserted = 0;
  try {
    for (const [a, b] of splitWindow(from, now, src.maxWindowDays)) {
      const { rows } = await src.fetch(a, b);
      fetched += rows.length;
      inserted += await store.upsertInquiries(rows);
    }
    await store.recordRun({
      channel: src.channel,
      kind: src.kind,
      started_at: started.toISOString(),
      finished_at: new Date().toISOString(),
      window_from: from.toISOString(),
      window_to: now.toISOString(),
      fetched,
      inserted,
      ok: true,
      error: null,
    });
    if (inserted) log.info(`${src.label}: 새 문의 ${inserted}건 (조회 ${fetched}건)`);
    return { label: src.label, fetched, inserted, ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`${src.label} 수집 실패`, e);
    await store
      .recordRun({
        channel: src.channel,
        kind: src.kind,
        started_at: started.toISOString(),
        finished_at: new Date().toISOString(),
        window_from: from.toISOString(),
        window_to: now.toISOString(),
        fetched,
        inserted,
        ok: false,
        error: msg.slice(0, 500),
      })
      .catch(() => undefined);
    return { label: src.label, fetched, inserted, ok: false, error: msg };
  }
}

/** 모든 수집원을 차례로 (하나가 실패해도 나머지는 계속) */
export async function collectAll(sources: InquirySource[], store: Store, now: Date, lookbackDays: number): Promise<SourceResult[]> {
  const results: SourceResult[] = [];
  for (const s of sources) results.push(await collectSource(s, store, now, lookbackDays));
  return results;
}
