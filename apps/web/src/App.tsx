import type { Session } from "@supabase/supabase-js";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout.tsx";
import { AuthContext, configured, supabase, type Profile } from "./lib.ts";
import Holidays from "./pages/Holidays.tsx";
import Home from "./pages/Home.tsx";
import Inquiries from "./pages/Inquiries.tsx";
import InquiryDetail from "./pages/InquiryDetail.tsx";
import Login from "./pages/Login.tsx";
import Users from "./pages/Users.tsx";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setProfile(null);
      return;
    }
    supabase
      .from("profiles")
      .select("id,email,display_name,role,active")
      .eq("id", session.user.id)
      .maybeSingle()
      .then(({ data }) => setProfile((data as Profile) ?? null));
  }, [session]);

  if (!configured) {
    return (
      <div className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-bold">설정이 필요합니다</h1>
        <p className="mt-3">
          웹사이트 환경변수 <code>VITE_SUPABASE_URL</code>, <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>가 비어 있습니다. 설치 안내서(docs/설치가이드.md)
          3단계를 확인하세요.
        </p>
      </div>
    );
  }
  if (!ready) return <p className="p-8 text-lg">불러오는 중…</p>;
  if (!session) return <Login />;

  if (profile && !profile.active) {
    return (
      <div className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-bold">사용이 중지된 계정입니다</h1>
        <p className="mt-3">관리자에게 문의하세요.</p>
        <button className="mt-6 rounded-lg bg-gray-800 px-6 py-3 text-white" onClick={() => supabase.auth.signOut()}>
          로그아웃
        </button>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ session, profile }}>
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/inquiries" element={<Inquiries />} />
          <Route path="/inquiries/:id" element={<InquiryDetail />} />
          <Route path="/holidays" element={<Holidays />} />
          <Route path="/users" element={<Users />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </AuthContext.Provider>
  );
}
