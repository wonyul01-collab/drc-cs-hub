/** 마켓 API 호출 공통 — 속도 제한, 시간 초과, 재시도 */

export class RateLimiter {
  private next = 0;
  constructor(private readonly minIntervalMs: number) {}
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.minIntervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RequestOptions {
  limiter: RateLimiter;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  label: string;
}

/** 429·5xx·네트워크 오류는 최대 retries번 재시도 (1s, 3s, 9s ...). 4xx는 즉시 실패 */
export async function requestJson<T = unknown>(url: string, init: RequestInit, opts: RequestOptions): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * 3 ** (attempt - 1)));
    await opts.limiter.wait();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : {}) as T;
      const err = new ApiError(`${opts.label} 응답 오류 ${res.status}: ${text.slice(0, 300)}`, res.status, text);
      if (res.status === 429 || res.status >= 500) {
        lastErr = err;
        continue;
      }
      throw err;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${opts.label} 호출 실패`);
}

/** 값 뽑기 도우미: 여러 후보 필드명 중 처음 있는 값 */
export function pick<T = unknown>(obj: Record<string, unknown> | null | undefined, ...keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v as T;
  }
  return undefined;
}

/** 쿠팡·네이버의 "2026-11-23 10:15:00"(한국 시각, 시간대 없음)과 ISO 문자열을 모두 처리 */
export function parseKstDate(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return new Date(v).toISOString();
  const s = String(v).trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}+09:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Date → 한국 날짜 "YYYY-MM-DD" */
export function kstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}

/**
 * 응답 구조 요약 (점검용) — 값은 숨기고 항목 이름·종류만. 숫자는 건수 계열(total/count/page/size)만 표시.
 * 예: {contents: 배열(0), page: 1, totalElements: 0, timestamp: 글자}
 */
export function describeShape(v: unknown, depth = 3): string {
  if (Array.isArray(v)) {
    const inner = v.length && depth > 0 && v[0] && typeof v[0] === "object" ? ` 첫항목${describeShape(v[0], depth - 1)}` : "";
    return `배열(${v.length})${inner}`;
  }
  if (v && typeof v === "object") {
    if (depth <= 0) return "{…}";
    const parts = Object.entries(v as Record<string, unknown>).map(([k, x]) => {
      if (typeof x === "number") return /total|count|page|size|code/i.test(k) ? `${k}: ${x}` : `${k}: 숫자`;
      if (typeof x === "string") return /code|status|message/i.test(k) && x.length < 60 ? `${k}: "${x}"` : `${k}: 글자`;
      if (typeof x === "boolean") return `${k}: 참거짓`;
      if (x === null) return `${k}: 없음`;
      return `${k}: ${describeShape(x, depth - 1)}`;
    });
    return `{${parts.join(", ")}}`;
  }
  return typeof v;
}
