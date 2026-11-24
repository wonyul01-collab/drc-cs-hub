import { useState } from "react";
import { api } from "../lib.ts";

/** 처음 실행 시 관리자 계정 만들기 (메인 PC에서만 가능) */
export default function Setup({ local, onDone }: { local: boolean; onDone: () => void }) {
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!local) {
    return (
      <div className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-bold">아직 관리자 계정이 없습니다</h1>
        <p className="mt-3 text-lg">
          첫 관리자 계정은 <b>메인 PC</b>의 크롬에서 <code>http://localhost:3000</code> 을 열어 만들어야 합니다.
        </p>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return setError("비밀번호 두 칸이 서로 다릅니다.");
    if (pw.length < 7) return setError("비밀번호는 7자 이상으로 정하세요.");
    try {
      await api("/api/setup", { method: "POST", body: { name, login, password: pw } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const input = "mt-2 w-full rounded-lg border-2 border-gray-300 px-4 py-3 text-lg";
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-8 shadow">
        <h1 className="text-2xl font-bold">처음 설정 — 관리자 계정 만들기</h1>
        <p className="mt-2 text-gray-700">이 계정으로 다른 담당자 계정도 만들 수 있습니다.</p>
        <label className="mt-6 block font-semibold">
          이름
          <input required value={name} onChange={(e) => setName(e.target.value)} className={input} placeholder="예: 김담당" />
        </label>
        <label className="mt-4 block font-semibold">
          아이디
          <input required value={login} onChange={(e) => setLogin(e.target.value)} className={input} autoComplete="username" placeholder="예: admin" />
        </label>
        <label className="mt-4 block font-semibold">
          비밀번호 (7자 이상)
          <input required type="password" value={pw} onChange={(e) => setPw(e.target.value)} className={input} autoComplete="new-password" />
        </label>
        <label className="mt-4 block font-semibold">
          비밀번호 확인
          <input required type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} className={input} autoComplete="new-password" />
        </label>
        {error && <p className="mt-4 rounded-lg bg-red-50 p-3 font-semibold text-red-700">{error}</p>}
        <button className="mt-8 w-full rounded-xl bg-blue-600 py-4 text-lg font-bold text-white">관리자 계정 만들기</button>
      </form>
    </div>
  );
}
