import { CHANNEL_LABEL, KIND_LABEL, type Channel, type InquiryKind } from "@drc/shared";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, ErrorBox } from "../components/ui.tsx";
import { api, fmtDateTime, fmtRelative } from "../lib.ts";

interface Counts {
  newTotal: number;
  dueSoon: number;
  pii: number;
  today: number;
}

interface Run {
  channel: Channel;
  kind: InquiryKind;
  started_at: string;
  ok: boolean;
  inserted: number;
  error: string | null;
}

export default function Home() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Counts & { runs: Run[] }>("/api/summary")
      .then((r) => {
        setCounts(r);
        setRuns(r.runs);
      })
      .catch((e) => setErr(`불러오기 실패: ${e.message}`));
  }, []);

  if (err) return <ErrorBox message={err} />;
  if (!counts) return <p className="text-lg">불러오는 중…</p>;

  const tiles = [
    { label: "처리할 신규 문의", value: counts.newTotal, to: "/inquiries?status=new", tone: "text-blue-700" },
    { label: "기한 임박 (4시간 이내)", value: counts.dueSoon, to: "/inquiries?status=new&sort=deadline", tone: counts.dueSoon ? "text-red-600" : "text-gray-800" },
    { label: "개인정보 포함 (직접 확인)", value: counts.pii, to: "/inquiries?status=new&pii=1", tone: counts.pii ? "text-amber-700" : "text-gray-800" },
    { label: "오늘 들어온 문의", value: counts.today, to: "/inquiries", tone: "text-gray-800" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">오늘 해야 할 일</h1>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.label} to={t.to} className="rounded-2xl bg-white p-5 shadow-sm hover:ring-2 hover:ring-blue-400">
            <div className="font-semibold text-gray-600">{t.label}</div>
            <div className={`mt-2 text-4xl font-bold ${t.tone}`}>{t.value}</div>
          </Link>
        ))}
      </div>

      <Card>
        <h2 className="text-xl font-bold">채널별 수집 상태</h2>
        {runs.length === 0 ? (
          <p className="mt-3 text-gray-600">아직 수집 기록이 없습니다. 작업기를 켜면 운영 시간에 10분마다 수집합니다.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-200">
            {runs.map((r) => (
              <li key={`${r.channel}${r.kind}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <span className="text-2xl">{r.ok ? "✅" : "❌"}</span>
                <span className="font-semibold">
                  {CHANNEL_LABEL[r.channel]} {KIND_LABEL[r.kind]}
                </span>
                <span className="text-gray-600">
                  {fmtDateTime(r.started_at)} ({fmtRelative(r.started_at)}) · 새 문의 {r.inserted}건
                </span>
                {!r.ok && <span className="w-full text-red-700">{r.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="text-xl font-bold">판매자센터에서 직접 확인할 곳</h2>
        <p className="mt-2 text-gray-700">아래 경로는 API가 없어 이 화면에 모이지 않습니다.</p>
        <ul className="mt-2 list-disc pl-6">
          <li>스마트스토어 「고객센터 문의 관리」, 톡톡 상담</li>
          <li>스마트스토어·쿠팡 리뷰 (Phase 4에서 파일 업로드로 연결 예정)</li>
        </ul>
      </Card>
    </div>
  );
}
