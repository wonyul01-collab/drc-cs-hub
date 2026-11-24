import type { Role } from "@drc/shared";
import { createContext, useContext } from "react";

export interface User {
  id: number;
  login: string;
  name: string;
  role: Role;
  active: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** 메인 PC 허브에 요청 (로그인 쿠키 자동 포함) */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("메인 PC에 연결할 수 없습니다. 메인 PC가 켜져 있는지 확인하세요.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/login") window.dispatchEvent(new Event("drc:logged-out"));
    throw new ApiError((data as { error?: string }).error ?? `오류 (${res.status})`, res.status);
  }
  return data as T;
}

export interface AuthState {
  user: User | null;
  logout: () => void;
}

export const AuthContext = createContext<AuthState>({ user: null, logout: () => {} });
export const useAuth = () => useContext(AuthContext);

const KST = "Asia/Seoul";

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST,
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "-";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}

/** 기한까지 남은 시간 표시 ("3시간 20분 남음" / "기한 지남") */
export function fmtRemaining(iso: string | null | undefined): { text: string; level: "ok" | "warn" | "danger" } | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return { text: "기한 지남", level: "danger" };
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const text = h ? `${h}시간 ${m % 60}분 남음` : `${m}분 남음`;
  return { text, level: h < 4 ? "danger" : h < 8 ? "warn" : "ok" };
}

const PLATFORM_STATUS: Record<string, string> = {
  progress: "진행 중",
  complete: "종료",
  requestanswer: "판매자 답변 요청",
  answered: "답변 완료",
  none: "판매자 이관 전",
  unanswered: "미답변",
};

/** 마켓 상태값(영문)을 한국어로: "progress/requestanswer" → "진행 중 · 판매자 답변 요청" */
export function platformStatusLabel(s: string | null | undefined): string {
  if (!s) return "-";
  return s
    .split("/")
    .map((x) => PLATFORM_STATUS[x.toLowerCase()] ?? x)
    .join(" · ");
}
