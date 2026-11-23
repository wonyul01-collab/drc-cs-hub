/**
 * 운영 시간 엔진 — 평일 업무시간(한국 시간)에만 작업기가 일하도록 판단한다.
 * 한국은 서머타임이 없으므로 UTC+9 고정으로 계산한다.
 */

export interface OperatingConfig {
  /** "09:00" */
  start: string;
  /** "18:00" — 이 시각 정각부터는 운영 시간 밖 */
  end: string;
  /** 운영 요일 (0=일 ~ 6=토). 기본 월~금 */
  weekdays: number[];
}

export const DEFAULT_OPERATING: OperatingConfig = {
  start: "09:00",
  end: "18:00",
  weekdays: [1, 2, 3, 4, 5],
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SeoulParts {
  /** "2026-11-23" */
  date: string;
  /** 0=일 ~ 6=토 */
  weekday: number;
  /** 자정부터 지난 분 */
  minutes: number;
}

export function seoulParts(at: Date): SeoulParts {
  const k = new Date(at.getTime() + KST_OFFSET_MS);
  const date = k.toISOString().slice(0, 10);
  return {
    date,
    weekday: k.getUTCDay(),
    minutes: k.getUTCHours() * 60 + k.getUTCMinutes(),
  };
}

function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`시각 형식이 잘못되었습니다: "${hhmm}" (예: 09:00)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** 해당 날짜(한국 날짜 "YYYY-MM-DD")가 운영일인가 — 운영 요일이고 휴일이 아니면 true */
export function isOperatingDay(date: string, holidays: ReadonlySet<string>, cfg: OperatingConfig = DEFAULT_OPERATING): boolean {
  return cfg.weekdays.includes(weekdayOf(date)) && !holidays.has(date);
}

/** 지금이 운영 시간인가 */
export function isOperatingTime(at: Date, holidays: ReadonlySet<string>, cfg: OperatingConfig = DEFAULT_OPERATING): boolean {
  const p = seoulParts(at);
  if (!isOperatingDay(p.date, holidays, cfg)) return false;
  return p.minutes >= toMinutes(cfg.start) && p.minutes < toMinutes(cfg.end);
}

/** 기준 날짜 다음의 첫 운영일 (최대 60일 탐색) */
export function nextOperatingDay(date: string, holidays: ReadonlySet<string>, cfg: OperatingConfig = DEFAULT_OPERATING): string {
  let d = date;
  for (let i = 0; i < 60; i++) {
    d = addDays(d, 1);
    if (isOperatingDay(d, holidays, cfg)) return d;
  }
  throw new Error("60일 안에 운영일이 없습니다. 운영 요일·휴일 설정을 확인하세요.");
}

/** 기준 날짜 이전의 마지막 운영일 */
export function previousOperatingDay(date: string, holidays: ReadonlySet<string>, cfg: OperatingConfig = DEFAULT_OPERATING): string {
  let d = date;
  for (let i = 0; i < 60; i++) {
    d = addDays(d, -1);
    if (isOperatingDay(d, holidays, cfg)) return d;
  }
  throw new Error("60일 안에 운영일이 없습니다. 운영 요일·휴일 설정을 확인하세요.");
}

/** 다음 날이 쉬는 날인 운영일인가 (금요일·휴일 전날 → 마감 알림 대상) */
export function isLastDayBeforeBreak(date: string, holidays: ReadonlySet<string>, cfg: OperatingConfig = DEFAULT_OPERATING): boolean {
  return isOperatingDay(date, holidays, cfg) && !isOperatingDay(addDays(date, 1), holidays, cfg);
}

/** 바로 전날이 쉬는 날이었던 운영일인가 (월요일·휴일 다음 날 → 휴일 요약 대상) */
export function isFirstDayAfterBreak(date: string, holidays: ReadonlySet<string>, cfg: OperatingConfig = DEFAULT_OPERATING): boolean {
  return isOperatingDay(date, holidays, cfg) && !isOperatingDay(addDays(date, -1), holidays, cfg);
}

/** 한국 시각 "HH:MM"이 지금과 같은 분인가 (스케줄 판단용) */
export function isSeoulClock(at: Date, hhmm: string): boolean {
  return seoulParts(at).minutes === toMinutes(hhmm);
}
