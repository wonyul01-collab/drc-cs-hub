import { useState } from "react";
import { supabase } from "../lib.ts";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError("이메일 또는 비밀번호가 맞지 않습니다.");
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-8 shadow">
        <h1 className="text-2xl font-bold">DRC CS 허브</h1>
        <p className="mt-1 text-gray-600">디알컴퍼니 담당자 전용</p>

        <label className="mt-8 block font-semibold" htmlFor="email">
          이메일
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-2 w-full rounded-lg border-2 border-gray-300 px-4 py-3 text-lg"
        />

        <label className="mt-5 block font-semibold" htmlFor="pw">
          비밀번호
        </label>
        <input
          id="pw"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-2 w-full rounded-lg border-2 border-gray-300 px-4 py-3 text-lg"
        />

        {error && <p className="mt-4 rounded-lg bg-red-50 p-3 font-semibold text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-8 w-full rounded-xl bg-blue-600 py-4 text-lg font-bold text-white disabled:opacity-60"
        >
          {busy ? "로그인 중…" : "로그인"}
        </button>
        <p className="mt-6 text-sm text-gray-600">계정이 없으면 관리자에게 초대를 요청하세요.</p>
      </form>
    </div>
  );
}
