import { ROLE_LABEL } from "@drc/shared";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { supabase, useAuth } from "../lib.ts";
import WorkerStatus from "./WorkerStatus.tsx";

export default function Layout({ children }: { children: ReactNode }) {
  const { profile, session } = useAuth();
  const links = [
    { to: "/", label: "홈" },
    { to: "/inquiries", label: "통합 창구" },
    { to: "/holidays", label: "휴무일" },
    ...(profile?.role === "admin" ? [{ to: "/users", label: "담당자" }] : []),
  ];

  return (
    <div className="min-h-screen">
      <WorkerStatus />
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="text-xl font-bold">DRC CS 허브</span>
          <nav className="flex flex-wrap gap-1">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === "/"}
                className={({ isActive }) =>
                  `rounded-lg px-4 py-2 font-semibold ${isActive ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"}`
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-gray-700">
              {profile?.display_name ?? session?.user.email} {profile && `(${ROLE_LABEL[profile.role]})`}
            </span>
            <button className="rounded-lg border-2 border-gray-300 px-4 py-2 font-semibold" onClick={() => supabase.auth.signOut()}>
              로그아웃
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
