import { useEffect, useState } from "react";
import { fmtRelative, supabase } from "../lib.ts";

interface Beat {
  worker_id: string;
  beat_at: string;
  mode: "operating" | "idle";
  detail: { sources?: Array<{ label: string; ok: boolean; error?: string }> };
}

/** 화면 맨 위 작업기 상태 띠 — 1분마다 새로고침 */
export default function WorkerStatus() {
  const [beat, setBeat] = useState<Beat | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data } = await supabase.from("worker_heartbeat").select("*").order("beat_at", { ascending: false }).limit(1);
      if (alive) setBeat((data?.[0] as Beat) ?? null);
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (beat === undefined) return null;

  const ageMin = beat ? (Date.now() - Date.parse(beat.beat_at)) / 60000 : Infinity;
  // 운영 중엔 1분마다, 대기 중엔 10분마다 신호 → 각각 10분/25분 넘게 없으면 멈춤
  const stopped = !beat || ageMin > (beat.mode === "operating" ? 10 : 25);
  const failing = beat?.detail?.sources?.filter((s) => !s.ok) ?? [];

  if (stopped) {
    return (
      <div role="alert" className="bg-red-600 px-4 py-3 text-center text-lg font-bold text-white">
        ⛔ 작업기 멈춤 — 사무실 PC를 확인하세요 (마지막 신호: {beat ? fmtRelative(beat.beat_at) : "없음"})
      </div>
    );
  }
  if (failing.length) {
    return (
      <div role="alert" className="bg-amber-400 px-4 py-3 text-center font-bold text-gray-900">
        ⚠ 수집 오류: {failing.map((f) => f.label).join(", ")} — 상세는 홈 화면 참고
      </div>
    );
  }
  return (
    <div className={`px-4 py-2 text-center font-semibold ${beat!.mode === "operating" ? "bg-green-600 text-white" : "bg-gray-600 text-white"}`}>
      {beat!.mode === "operating" ? "● 작업기 정상 작동 중" : "● 운영 시간 외 — 작업기 대기 중"} · 마지막 신호 {fmtRelative(beat!.beat_at)}
    </div>
  );
}
