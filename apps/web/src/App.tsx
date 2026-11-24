import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout.tsx";
import { api, AuthContext, type User } from "./lib.ts";
import Holidays from "./pages/Holidays.tsx";
import Home from "./pages/Home.tsx";
import Inquiries from "./pages/Inquiries.tsx";
import Knowledge from "./pages/Knowledge.tsx";
import Reviews from "./pages/Reviews.tsx";
import InquiryDetail from "./pages/InquiryDetail.tsx";
import Login from "./pages/Login.tsx";
import Setup from "./pages/Setup.tsx";
import Users from "./pages/Users.tsx";

type Phase = { kind: "loading" } | { kind: "error"; message: string } | { kind: "setup"; local: boolean } | { kind: "login" } | { kind: "in"; user: User };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  const check = useCallback(async () => {
    try {
      const s = await api<{ needed: boolean; local: boolean }>("/api/setup");
      if (s.needed) return setPhase({ kind: "setup", local: s.local });
      const me = await api<{ user: User }>("/api/me").catch(() => null);
      setPhase(me ? { kind: "in", user: me.user } : { kind: "login" });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    check();
    const onOut = () => setPhase({ kind: "login" });
    window.addEventListener("drc:logged-out", onOut);
    return () => window.removeEventListener("drc:logged-out", onOut);
  }, [check]);

  const logout = useCallback(async () => {
    await api("/api/logout", { method: "POST", body: {} }).catch(() => undefined);
    setPhase({ kind: "login" });
  }, []);

  if (phase.kind === "loading") return <p className="p-8 text-lg">불러오는 중…</p>;
  if (phase.kind === "error")
    return (
      <div className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-bold">연결할 수 없습니다</h1>
        <p className="mt-3 text-lg">{phase.message}</p>
        <button onClick={check} className="mt-6 rounded-xl bg-blue-600 px-6 py-3 font-bold text-white">
          다시 시도
        </button>
      </div>
    );
  if (phase.kind === "setup") return <Setup local={phase.local} onDone={check} />;
  if (phase.kind === "login") return <Login onDone={(user) => setPhase({ kind: "in", user })} />;

  return (
    <AuthContext.Provider value={{ user: phase.user, logout }}>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/inquiries" element={<Inquiries />} />
          <Route path="/inquiries/:id" element={<InquiryDetail />} />
          <Route path="/reviews" element={<Reviews />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/holidays" element={<Holidays />} />
          <Route path="/users" element={<Users />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </AuthContext.Provider>
  );
}
