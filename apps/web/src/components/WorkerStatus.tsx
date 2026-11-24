import { useEffect, useState } from "react";
import { api, fmtRelative } from "../lib.ts";

interface Status {
  beat_at: string;
  mode: "operating" | "idle";
  detail: { sourceCount?: number; sources?: Array<{ label: string; ok: boolean; error?: string }> };
}

/** 화면 맨 위 상태 띠 — 1분마다 새로고침 */
export default function WorkerStatus() {
  const [st, setSt] = useState<Status | null | undefined>(undefined);
  const [down, setDown] = useState(false);
  const [notifyFailed, setNotifyFailed] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ status: Status | null; notify?: { failedToday: number } }>("/api/status")
        .then((r) => alive && (setSt(r.status), setDown(false), setNotifyFailed(r.notify?.failedToday ?? 0)))
        .catch(() => alive && setDown(true));
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (down) {
    return (
      <div role="alert" className="bg-red-600 px-4 py-3 text-center text-lg font-bold text-white">
        ⛔ 메인 PC에 연결할 수 없습니다 — 메인 PC가 켜져 있는지 확인하세요
      </div>
    );
  }
  if (st === undefined) return null;

  const ageMin = st ? (Date.now() - Date.parse(st.beat_at)) / 60000 : Infinity;
  const stuck = !st || ageMin > (st.mode === "operating" ? 10 : 25);
  const failing = st?.detail?.sources?.filter((s) => !s.ok) ?? [];

  if (stuck) {
    return (
      <div role="alert" className="bg-red-600 px-4 py-3 text-center text-lg font-bold text-white">
        ⛔ 문의 수집이 멈췄습니다 — 메인 PC의 허브 프로그램을 다시 켜 주세요 (마지막 신호: {st ? fmtRelative(st.beat_at) : "없음"})
      </div>
    );
  }
  if (notifyFailed > 0) {
    return (
      <div role="alert" className="bg-amber-400 px-4 py-3 text-center font-bold text-gray-900">
        ⚠ 알림 메일 {notifyFailed}건을 보내지 못했습니다 — 홈 → 관리 → 알림에서 확인하세요
      </div>
    );
  }
  if (st && st.detail?.sourceCount === 0) {
    return (
      <div role="alert" className="bg-amber-400 px-4 py-3 text-center font-bold text-gray-900">
        ⚠ 마켓 키가 설정되지 않아 문의를 수집하지 않습니다 — 메인 PC에서 3-settings.bat으로 키를 넣고 허브를 다시 켜세요
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
    <div className={`px-4 py-2 text-center font-semibold text-white ${st!.mode === "operating" ? "bg-green-600" : "bg-gray-600"}`}>
      {st!.mode === "operating" ? "● 정상 작동 중 (10분마다 문의 수집)" : "● 운영 시간 외 — 대기 중"} · 마지막 신호 {fmtRelative(st!.beat_at)}
    </div>
  );
}
