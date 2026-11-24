import { CHANNEL_LABEL, KIND_LABEL, STATUS_LABEL, type Channel, type InquiryKind, type InquiryStatus } from "@drc/shared";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge, ChannelBadge, ErrorBox, KindBadge, StatusBadge } from "../components/ui.tsx";
import { api, fmtDateTime, fmtRemaining } from "../lib.ts";

export interface InquiryRow {
  id: number;
  channel: Channel;
  kind: InquiryKind;
  external_id: string;
  product_name: string | null;
  product_id: string | null;
  order_id: string | null;
  customer_masked: string | null;
  title: string | null;
  body_masked: string;
  pii_detected: boolean;
  received_at: string;
  deadline_at: string | null;
  platform_answered: boolean;
  platform_answer: string | null;
  platform_status: string | null;
  can_reply: boolean;
  status: InquiryStatus;
}

const PAGE = 30;

export default function Inquiries() {
  const [sp, setSp] = useSearchParams();
  const channel = sp.get("channel") ?? "";
  const kind = sp.get("kind") ?? "";
  const status = sp.get("status") ?? "";
  const sort = sp.get("sort") ?? "received";
  const pii = sp.get("pii") === "1";
  const q = sp.get("q") ?? "";
  const page = Math.max(1, Number(sp.get("page") ?? 1));

  const [rows, setRows] = useState<InquiryRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState(q);

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== "page") n.delete("page");
    setSp(n);
  };

  useEffect(() => {
    const p = new URLSearchParams({ channel, kind, status, sort, q, page: String(page), pii: pii ? "1" : "" });
    api<{ rows: InquiryRow[]; total: number }>(`/api/inquiries?${p}`)
      .then((r) => {
        setErr(null);
        setRows(r.rows);
        setTotal(r.total);
      })
      .catch((e) => setErr(`불러오기 실패: ${e.message}`));
  }, [channel, kind, status, sort, pii, q, page]);

  const select = "min-w-0 grow basis-36 rounded-lg border-2 border-gray-300 bg-white px-3 py-2";
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">통합 창구</h1>

      <div className="flex flex-wrap gap-2 rounded-2xl bg-white p-4 shadow-sm">
        <select aria-label="채널" className={select} value={channel} onChange={(e) => set("channel", e.target.value)}>
          <option value="">전체 채널</option>
          {Object.entries(CHANNEL_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <select aria-label="유형" className={select} value={kind} onChange={(e) => set("kind", e.target.value)}>
          <option value="">전체 유형</option>
          {Object.entries(KIND_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <select aria-label="상태" className={select} value={status} onChange={(e) => set("status", e.target.value)}>
          <option value="">전체 상태</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <select aria-label="정렬" className={select} value={sort} onChange={(e) => set("sort", e.target.value)}>
          <option value="received">최신순</option>
          <option value="deadline">기한 임박순</option>
        </select>
        <form
          className="flex min-w-0 basis-full gap-2 lg:basis-auto lg:grow"
          onSubmit={(e) => {
            e.preventDefault();
            set("q", search.trim());
          }}
        >
          <input
            aria-label="검색"
            placeholder="내용·상품명·주문번호 검색"
            className="min-w-0 grow rounded-lg border-2 border-gray-300 px-3 py-2"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="shrink-0 rounded-lg bg-blue-600 px-5 py-2 font-bold whitespace-nowrap text-white">검색</button>
        </form>
      </div>

      {err && <ErrorBox message={err} />}
      {!rows ? (
        <p className="text-lg">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-lg text-gray-600 shadow-sm">조건에 맞는 문의가 없습니다.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const rem = r.can_reply && r.status === "new" ? fmtRemaining(r.deadline_at) : null;
            return (
              <li key={r.id}>
                <Link to={`/inquiries/${r.id}`} className="block rounded-2xl bg-white p-4 shadow-sm hover:ring-2 hover:ring-blue-400">
                  <div className="flex flex-wrap items-center gap-2">
                    <ChannelBadge c={r.channel} />
                    <KindBadge k={r.kind} />
                    <StatusBadge s={r.status} />
                    {r.pii_detected && <Badge tone="amber">개인정보 포함</Badge>}
                    {!r.can_reply && r.status === "new" && <Badge>답변 불가 상태</Badge>}
                    {rem && <Badge tone={rem.level === "ok" ? "gray" : rem.level === "warn" ? "amber" : "red"}>⏰ {rem.text}</Badge>}
                    <span className="ml-auto text-gray-600">{fmtDateTime(r.received_at)}</span>
                  </div>
                  {r.product_name && <div className="mt-2 font-semibold text-gray-700">{r.product_name}</div>}
                  <p className="mt-1 line-clamp-2 text-lg">{r.title ? `[${r.title}] ` : ""}{r.body_masked}</p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button disabled={page <= 1} onClick={() => set("page", String(page - 1))} className="rounded-lg border-2 px-5 py-2 font-semibold disabled:opacity-40">
            ◀ 이전
          </button>
          <span className="font-semibold">{page} / {pages} 쪽 (총 {total}건)</span>
          <button disabled={page >= pages} onClick={() => set("page", String(page + 1))} className="rounded-lg border-2 px-5 py-2 font-semibold disabled:opacity-40">
            다음 ▶
          </button>
        </div>
      )}
    </div>
  );
}
