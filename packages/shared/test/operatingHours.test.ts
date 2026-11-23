import { describe, expect, it } from "vitest";
import {
  BUILTIN_HOLIDAYS,
  isFirstDayAfterBreak,
  isLastDayBeforeBreak,
  isOperatingTime,
  nextOperatingDay,
  previousOperatingDay,
  seoulParts,
} from "../src/index.ts";

const H = new Set(BUILTIN_HOLIDAYS.map((h) => h.date));
/** 한국 시각 문자열 → Date */
const kst = (s: string) => new Date(`${s}:00+09:00`);

describe("운영 시간 판단 (평일 09:00~18:00, 한국 시간)", () => {
  it.each([
    ["금요일 17:59 → 운영", "2026-11-27T17:59", true],
    ["금요일 18:00 → 종료", "2026-11-27T18:00", false],
    ["금요일 18:01 → 종료", "2026-11-27T18:01", false],
    ["토요일 낮 → 쉼", "2026-11-28T11:00", false],
    ["일요일 낮 → 쉼", "2026-11-29T11:00", false],
    ["월요일 08:59 → 아직", "2026-11-30T08:59", false],
    ["월요일 09:00 → 운영 시작", "2026-11-30T09:00", true],
    ["공휴일(한글날, 금) → 쉼", "2026-10-09T10:00", false],
    ["대체공휴일(개천절 대체, 월) → 쉼", "2026-10-05T10:00", false],
    ["설 연휴 → 쉼", "2026-02-17T10:00", false],
    ["평일 점심 → 운영", "2026-11-24T12:30", true],
  ])("%s", (_label, at, expected) => {
    expect(isOperatingTime(kst(at), H)).toBe(expected);
  });

  it("UTC 자정 근처에서도 한국 날짜로 계산한다", () => {
    // UTC 2026-11-23 23:30 = 한국 2026-11-24(화) 08:30
    const p = seoulParts(new Date("2026-11-23T23:30:00Z"));
    expect(p.date).toBe("2026-11-24");
    expect(p.weekday).toBe(2);
    expect(p.minutes).toBe(8 * 60 + 30);
  });

  it("회사 휴무일을 추가하면 그날은 쉰다", () => {
    const withCompany = new Set([...H, "2026-11-24"]);
    expect(isOperatingTime(kst("2026-11-24T10:00"), withCompany)).toBe(false);
  });

  it("운영 시간 설정을 바꿀 수 있다 (08:30~17:30)", () => {
    const cfg = { start: "08:30", end: "17:30", weekdays: [1, 2, 3, 4, 5] };
    expect(isOperatingTime(kst("2026-11-24T08:30"), H, cfg)).toBe(true);
    expect(isOperatingTime(kst("2026-11-24T17:30"), H, cfg)).toBe(false);
  });
});

describe("휴일 전후 판단", () => {
  it("금요일은 마감 알림 대상(다음 날 쉼)", () => {
    expect(isLastDayBeforeBreak("2026-11-27", H)).toBe(true);
    expect(isLastDayBeforeBreak("2026-11-26", H)).toBe(false);
  });
  it("공휴일 전날(목)도 마감 알림 대상", () => {
    expect(isLastDayBeforeBreak("2026-10-08", H)).toBe(true);
  });
  it("월요일·연휴 다음 날은 휴일 요약 대상", () => {
    expect(isFirstDayAfterBreak("2026-11-30", H)).toBe(true);
    expect(isFirstDayAfterBreak("2026-10-06", H)).toBe(true); // 10/3~10/5 연휴 다음
    expect(isFirstDayAfterBreak("2026-11-25", H)).toBe(false);
  });
  it("다음/이전 운영일", () => {
    expect(nextOperatingDay("2026-11-27", H)).toBe("2026-11-30");
    expect(nextOperatingDay("2026-02-13", H)).toBe("2026-02-19"); // 설 연휴 건너뜀
    expect(previousOperatingDay("2026-10-06", H)).toBe("2026-10-02");
  });
});
