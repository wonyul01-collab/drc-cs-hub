import { createClient, type Session } from "@supabase/supabase-js";
import type { Role } from "@drc/shared";
import { createContext, useContext } from "react";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const configured = Boolean(url && key);
export const supabase = createClient(url ?? "http://localhost", key ?? "missing");

export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  role: Role;
  active: boolean;
}

export interface AuthState {
  session: Session | null;
  profile: Profile | null;
}

export const AuthContext = createContext<AuthState>({ session: null, profile: null });
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
  const diff = Date.now() - Date.parse(iso);
  const m = Math.round(diff / 60000);
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
