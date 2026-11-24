import { createHmac } from "node:crypto";

export const COUPANG_BASE = "https://api-gateway.coupang.com";

/** 쿠팡 서명 시각: yyMMdd'T'HHmmss'Z' (UTC) */
export function coupangDatetime(d: Date): string {
  const iso = d.toISOString(); // 2026-11-23T01:02:03.456Z
  return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

/**
 * 쿠팡 HMAC 서명 (공식 문서: developers.coupangcorp.com/hc/en-us/articles/360033461914)
 *   message   = datetime + method + path + query(물음표 제외)
 *   signature = hex(HmacSHA256(secretKey, message))
 * 서명은 5분 안에만 유효 → 요청마다 새로 만든다.
 */
export function coupangAuthorization(
  method: string,
  path: string,
  query: string,
  accessKey: string,
  secretKey: string,
  now: Date = new Date(),
): string {
  const datetime = coupangDatetime(now);
  const message = `${datetime}${method.toUpperCase()}${path}${query}`;
  const signature = createHmac("sha256", secretKey).update(message, "utf8").digest("hex");
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}
