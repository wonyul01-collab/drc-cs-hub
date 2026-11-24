import { CHANNEL_LABEL, KIND_LABEL, STATUS_LABEL, type Channel, type InquiryKind, type InquiryStatus } from "@drc/shared";
import type { ReactNode } from "react";
import { ROUTE_LABEL, type Route } from "@drc/shared";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl bg-white p-5 shadow-sm ${className}`}>{children}</section>;
}

export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: "gray" | "green" | "blue" | "amber" | "red" }) {
  const tones = {
    gray: "bg-gray-100 text-gray-800",
    green: "bg-green-100 text-green-800",
    blue: "bg-blue-100 text-blue-800",
    amber: "bg-amber-100 text-amber-900",
    red: "bg-red-100 text-red-800",
  };
  return <span className={`inline-block rounded-md px-2 py-0.5 text-sm font-semibold ${tones[tone]}`}>{children}</span>;
}

export const ChannelBadge = ({ c }: { c: Channel }) => <Badge tone={c === "coupang" ? "red" : "green"}>{CHANNEL_LABEL[c]}</Badge>;
export const KindBadge = ({ k }: { k: InquiryKind }) => <Badge tone="blue">{KIND_LABEL[k]}</Badge>;
export const StatusBadge = ({ s }: { s: InquiryStatus }) => (
  <Badge tone={s === "new" ? "amber" : s === "closed" ? "gray" : "green"}>{STATUS_LABEL[s]}</Badge>
);

export function ErrorBox({ message }: { message: string }) {
  return <p className="rounded-lg bg-red-50 p-4 font-semibold text-red-700">{message}</p>;
}

export const RouteBadge = ({ r }: { r: Route | null | undefined }) =>
  r ? <Badge tone={r === "auto" ? "green" : r === "approve" ? "amber" : "red"}>{ROUTE_LABEL[r]}</Badge> : null;
