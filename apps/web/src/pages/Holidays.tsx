import { useEffect, useState } from "react";
import { Badge, Card, ErrorBox } from "../components/ui.tsx";
import { api, useAuth } from "../lib.ts";

interface Holiday {
  date: string;
  name: string;
  source: "builtin" | "api" | "company";
}

const SOURCE: Record<Holiday["source"], string> = { builtin: "법정 공휴일", api: "법정 공휴일", company: "회사 휴무" };
const WD = ["일", "월", "화", "수", "목", "금", "토"];

export default function Holidays() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [list, setList] = useState<Holiday[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [name, setName] = useState("");

  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

  const load = () =>
    api<Holiday[]>("/api/holidays")
      .then(setList)
      .catch((e) => setErr(e.message));

  useEffect(() => {
    load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/api/holidays", { method: "POST", body: { date, name } });
      setErr(null);
      setDate("");
      setName("");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  async function remove(d: string) {
    if (!confirm(`${d} 회사 휴무를 삭제할까요?`)) return;
    try {
      await api(`/api/holidays/${d}`, { method: "DELETE" });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">휴무일</h1>
      <p className="text-gray-700">휴무일에는 문의 수집·알림을 하지 않습니다. 법정 공휴일·대체공휴일은 자동으로 들어옵니다.</p>
      {err && <ErrorBox message={err} />}

      {isAdmin && (
        <Card>
          <h2 className="text-xl font-bold">회사 휴무일 추가</h2>
          <form onSubmit={add} className="mt-3 flex flex-wrap gap-2">
            <input type="date" required value={date} min={today} onChange={(e) => setDate(e.target.value)} className="rounded-lg border-2 border-gray-300 px-3 py-2" aria-label="날짜" />
            <input placeholder="예: 창립기념일" required value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 grow rounded-lg border-2 border-gray-300 px-3 py-2" aria-label="이름" />
            <button className="rounded-lg bg-blue-600 px-6 py-2 font-bold text-white">추가</button>
          </form>
        </Card>
      )}

      <Card>
        <h2 className="text-xl font-bold">다가오는 휴무일</h2>
        {!list ? (
          <p className="mt-3">불러오는 중…</p>
        ) : list.length === 0 ? (
          <p className="mt-3 text-gray-600">등록된 휴무일이 없습니다.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-200">
            {list.map((h) => (
              <li key={h.date} className="flex flex-wrap items-center gap-3 py-3">
                <span className="w-36 font-semibold">
                  {h.date} ({WD[new Date(`${h.date}T00:00:00Z`).getUTCDay()]})
                </span>
                <span className="grow">{h.name}</span>
                <Badge tone={h.source === "company" ? "blue" : "gray"}>{SOURCE[h.source]}</Badge>
                {isAdmin && h.source === "company" && (
                  <button onClick={() => remove(h.date)} className="rounded-lg border-2 border-red-300 px-3 py-1 font-semibold text-red-700">
                    삭제
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
