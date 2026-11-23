import { BUILTIN_HOLIDAYS } from "@drc/shared";
import { RateLimiter, requestJson, type FetchLike } from "./http.ts";
import type { Store } from "./store.ts";
import { log } from "./log.ts";

/** 공공데이터포털 「한국천문연구원 특일 정보 — 공휴일 정보 조회」 */
const URL_BASE = "https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo";

type Item = { locdate: number | string; dateName: string; isHoliday?: string };

export async function fetchPublicHolidays(serviceKey: string, year: number, fetchImpl?: FetchLike) {
  // serviceKey는 포털에서 받은 "Decoding" 키를 넣는다 (여기서 인코딩)
  const qs = new URLSearchParams({ serviceKey, solYear: String(year), numOfRows: "100", _type: "json" });
  const res = await requestJson<{ response?: { body?: { items?: { item?: Item | Item[] } | "" } } }>(
    `${URL_BASE}?${qs}`,
    { method: "GET" },
    { limiter: new RateLimiter(300), fetchImpl, label: "공휴일 API" },
  );
  const items = res.response?.body?.items;
  const raw = items && typeof items === "object" ? items.item : undefined;
  const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  return list
    .filter((i) => (i.isHoliday ?? "Y") === "Y")
    .map((i) => {
      const s = String(i.locdate);
      return { date: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, name: i.dateName, source: "api" as const };
    });
}

/** 내장 목록을 먼저 넣고, API 키가 있으면 올해·내년을 API 값으로 덮어쓴다 */
export async function syncHolidays(store: Store, serviceKey: string | null, now: Date, fetchImpl?: FetchLike): Promise<void> {
  await store.saveHolidays(BUILTIN_HOLIDAYS.map((h) => ({ ...h, source: "builtin" as const })));
  if (!serviceKey) {
    log.info("공휴일: 내장 목록 사용 (공공데이터 키 없음)");
    return;
  }
  const year = Number(new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 4));
  for (const y of [year, year + 1]) {
    try {
      const rows = await fetchPublicHolidays(serviceKey, y, fetchImpl);
      await store.saveHolidays(rows);
      log.info(`공휴일: ${y}년 ${rows.length}일 갱신`);
    } catch (e) {
      log.warn(`공휴일 API ${y}년 갱신 실패 — 내장 목록으로 계속합니다. (${e instanceof Error ? e.message : e})`);
    }
  }
}
