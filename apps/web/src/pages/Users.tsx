import { ROLE_LABEL, type Role } from "@drc/shared";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Card, ErrorBox } from "../components/ui.tsx";
import { api, useAuth, type User } from "../lib.ts";

const input = "min-w-0 rounded-lg border-2 border-gray-300 px-3 py-2";

export default function Users() {
  const { user: me } = useAuth();
  const [list, setList] = useState<User[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", login: "", password: "", role: "agent" as Role });

  const load = () =>
    api<User[]>("/api/users")
      .then(setList)
      .catch((e) => setErr(e.message));

  useEffect(() => {
    load();
  }, []);

  if (me && me.role !== "admin") return <Navigate to="/" replace />;

  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      setErr(null);
      setOk(done);
      load();
    } catch (e) {
      setOk(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  async function add(e: React.FormEvent) {
    e.preventDefault();
    await run(() => api("/api/users", { method: "POST", body: form }), `${form.name} 계정을 만들었습니다. 아이디·비밀번호를 담당자에게 알려주세요.`);
    setForm({ name: "", login: "", password: "", role: "agent" });
  }

  function resetPw(u: User) {
    const pw = prompt(`${u.name}님의 새 비밀번호 (8자 이상)`);
    if (!pw) return;
    run(() => api(`/api/users/${u.id}`, { method: "PATCH", body: { password: pw } }), `${u.name}님 비밀번호를 바꿨습니다.`);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">담당자 관리</h1>
      {err && <ErrorBox message={err} />}
      {ok && <p className="rounded-lg bg-green-50 p-4 font-semibold text-green-800">{ok}</p>}

      <Card>
        <h2 className="text-xl font-bold">새 담당자 계정 만들기</h2>
        <form onSubmit={add} className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <input required placeholder="이름" aria-label="이름" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
          <input required placeholder="아이디" aria-label="아이디" value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} className={input} />
          <input
            required
            type="password"
            placeholder="비밀번호 (8자 이상)"
            aria-label="비밀번호"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className={input}
          />
          <select aria-label="역할" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })} className={`${input} bg-white`}>
            {Object.entries(ROLE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <button className="rounded-lg bg-blue-600 px-6 py-2 font-bold text-white">만들기</button>
        </form>
      </Card>

      <Card>
        {!list ? (
          <p>불러오는 중…</p>
        ) : (
          <ul className="divide-y divide-gray-200">
            {list.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="grow">
                  <div className="font-semibold">
                    {u.name} {!u.active && <span className="text-red-700">(사용 중지)</span>}
                  </div>
                  <div className="text-gray-600">아이디: {u.login}</div>
                </div>
                <select
                  aria-label={`${u.name} 역할`}
                  value={u.role}
                  disabled={u.id === me?.id}
                  onChange={(e) => run(() => api(`/api/users/${u.id}`, { method: "PATCH", body: { role: e.target.value } }), `${u.name}님 역할을 바꿨습니다.`)}
                  className={`${input} bg-white`}
                >
                  {Object.entries(ROLE_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
                <button onClick={() => resetPw(u)} className="rounded-lg border-2 border-gray-300 px-4 py-2 font-semibold">
                  비밀번호 변경
                </button>
                <button
                  disabled={u.id === me?.id}
                  onClick={() => run(() => api(`/api/users/${u.id}`, { method: "PATCH", body: { active: !u.active } }), u.active ? `${u.name}님 사용을 중지했습니다.` : `${u.name}님을 다시 사용하게 했습니다.`)}
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
