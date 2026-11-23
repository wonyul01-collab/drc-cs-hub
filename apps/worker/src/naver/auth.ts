import bcrypt from "bcryptjs";
import { requestJson, type FetchLike, RateLimiter } from "../http.ts";

export const NAVER_BASE = "https://api.commerce.naver.com/external";

/**
 * 네이버 커머스API 전자서명:
 *   password = client_id + "_" + timestamp(ms)
 *   hashed   = bcrypt(password, salt = client_secret)
 *   sign     = Base64(hashed)
 * 출처: docs/api-notes.md 1장 (부분확인 — 실제 PC에서 probe로 확인)
 */
export function naverSign(clientId: string, clientSecret: string, timestamp: number): string {
  const hashed = bcrypt.hashSync(`${clientId}_${timestamp}`, clientSecret);
  return Buffer.from(hashed, "utf8").toString("base64");
}

export class NaverTokenProvider {
  private token: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly limiter: RateLimiter,
    private readonly fetchImpl?: FetchLike,
  ) {}

  async get(): Promise<string> {
    // 만료 5분 전이면 새로 발급
    if (this.token && Date.now() < this.expiresAt - 5 * 60_000) return this.token;
    const timestamp = Date.now();
    const body = new URLSearchParams({
      client_id: this.clientId,
      timestamp: String(timestamp),
      client_secret_sign: naverSign(this.clientId, this.clientSecret, timestamp),
      grant_type: "client_credentials",
      type: "SELF",
    });
    const res = await requestJson<{ access_token: string; expires_in: number }>(
      `${NAVER_BASE}/v1/oauth2/token`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
      { limiter: this.limiter, fetchImpl: this.fetchImpl, label: "네이버 토큰 발급", retries: 2 },
    );
    if (!res.access_token) throw new Error("네이버 토큰 응답에 access_token이 없습니다.");
    this.token = res.access_token;
    this.expiresAt = Date.now() + (Number(res.expires_in) || 3600) * 1000;
    return this.token;
  }
}
