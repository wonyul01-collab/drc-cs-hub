import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { coupangAuthorization, coupangDatetime } from "../src/coupang/auth.ts";
import { naverSign } from "../src/naver/auth.ts";

describe("쿠팡 HMAC 서명", () => {
  const now = new Date("2026-11-23T01:02:03.000Z");

  it("서명 시각 형식은 yyMMddTHHmmssZ (UTC)", () => {
    expect(coupangDatetime(now)).toBe("261123T010203Z");
  });

  it("Authorization 헤더 형식", () => {
    const h = coupangAuthorization("GET", "/v2/path", "a=1", "AK", "SK", now);
    expect(h).toMatch(/^CEA algorithm=HmacSHA256, access-key=AK, signed-date=261123T010203Z, signature=[0-9a-f]{64}$/);
  });

  it("경로·쿼리·메서드가 바뀌면 서명도 바뀐다", () => {
    const a = coupangAuthorization("GET", "/v2/path", "a=1", "AK", "SK", now);
    expect(coupangAuthorization("GET", "/v2/path", "a=2", "AK", "SK", now)).not.toBe(a);
    expect(coupangAuthorization("POST", "/v2/path", "a=1", "AK", "SK", now)).not.toBe(a);
    expect(coupangAuthorization("GET", "/v2/other", "a=1", "AK", "SK", now)).not.toBe(a);
  });

  it("공식 문서 방식(datetime+method+path+query)과 같은 값", async () => {
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", "SK").update("261123T010203ZGET/v2/patha=1").digest("hex");
    expect(coupangAuthorization("GET", "/v2/path", "a=1", "AK", "SK", now)).toContain(`signature=${expected}`);
  });
});

describe("네이버 전자서명", () => {
  it("client_id_timestamp를 시크릿(salt)으로 bcrypt 한 뒤 Base64", () => {
    const secret = bcrypt.genSaltSync(4); // 네이버 시크릿은 bcrypt salt 형식($2a$..)
    const sign = naverSign("myClientId", secret, 1763860000000);
    const hashed = Buffer.from(sign, "base64").toString("utf8");
    expect(hashed.startsWith(secret)).toBe(true);
    expect(bcrypt.compareSync("myClientId_1763860000000", hashed)).toBe(true);
  });
});
