import { ROLE_LABEL, type Role } from "@drc/shared";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Card, ErrorBox } from "../components/ui.tsx";
import { supabase, useAuth, type Profile } from "../lib.ts";

export default function Users() {
  const { profile } = useAuth();
  const [list, setList] = useState<Profile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () =>
    supabase
      .from("profiles")
      .select("id,email,display_name,role,active")
      .order("created_at")
      .then(({ data, error }) => {
        if (error) setErr(error.message);
        setList((data ?? []) as Profile[]);
      });

  useEffect(() => {
    load();
  }, []);

  if (profile && profile.role !== "admin") return <Navigate to="/" replace />;

  async function update(id: string, patch: Partial<Profile>) {
    const { error } = await supabase.from("profiles").update(patch).eq("id", id);
    if (error) setErr(`변경 실패: ${error.message}`);
    else setErr(null);
    load();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">담당자 관리</h1>
      <Card className="bg-blue-50">
        <p className="font-semibold">새 담당자 초대</p>
        <p className="mt-1">
          Supabase 대시보드 → Authentication → Users → <b>Invite user</b>에 이메일을 넣으면 초대 메일이 갑니다. 담당자가 비밀번호를 정하고 로그인하면 이 목록에
          &lsquo;담당자&rsquo;로 나타납니다. (설치가이드 4단계)
        </p>
      </Card>
      {err && <ErrorBox message={err} />}
      <Card>
        {!list ? (
          <p>불러오는 중…</p>
        ) : (
          <ul className="divide-y divide-gray-200">
            {list.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="grow">
                  <div className="font-semibold">{u.display_name ?? u.email}</div>
                  <div className="text-gray-600">{u.email}</div>
                </div>
                <select
                  aria-label={`${u.email} 역할`}
                  value={u.role}
                  disabled={u.id === profile?.id}
                  onChange={(e) => update(u.id, { role: e.target.value as Role })}
                  className="rounded-lg border-2 border-gray-300 bg-white px-3 py-2"
                >
                  {Object.entries(ROLE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
                <button
                  disabled={u.id === profile?.id}
                  onClick={() => update(u.id, { active: !u.active })}
                  className={`rounded-lg px-4 py-2 font-semibold disabled:opacity-40 ${u.active ? "border-2 border-red-300 text-red-700" : "bg-green-600 text-white"}`}
                >
                  {u.active ? "사용 중지" : "다시 사용"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
