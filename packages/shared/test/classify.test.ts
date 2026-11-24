import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyText, type Route } from "../src/index.ts";

interface Case {
  id: string;
  text: string;
  expect: Route;
  pii?: boolean;
  priorComplaints?: number;
  channel?: "smartstore" | "coupang";
}
const cases: Case[] = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/classification_cases.json"), "utf8"));
const run = (c: Case) => classifyText({ channel: c.channel ?? "smartstore", text: c.text, piiDetected: !!c.pii, priorComplaints: c.priorComplaints });

describe("분류 회귀 테스트 (fixtures/classification_cases.json)", () => {
  it(`사례 ${cases.length}건 이상`, () => expect(cases.length).toBeGreaterThanOrEqual(50));

  it("★ 사람 전용(③) 사례가 자동(①)으로 분류되는 건 0건 — Phase 2 완료 기준", () => {
    const leaked = cases.filter((c) => c.expect === "human" && run(c).route === "auto");
    expect(leaked.map((c) => c.id)).toEqual([]);
  });

  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = run(c);
    expect(r.route, `${c.text} → ${r.reasons.join(" / ")}`).toBe(c.expect);
  });
});
