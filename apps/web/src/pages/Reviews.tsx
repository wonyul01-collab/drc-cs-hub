import { CHANNEL_LABEL, type Channel } from "@drc/shared";
import { useEffect, useRef, useState } from "react";
import { Badge, Card, ChannelBadge, ErrorBox } from "../components/ui.tsx";
import { api, fmtDateTime, fmtRelative, useAuth } from "../lib.ts";

interface Review {
  id: number;
  channel: Channel;
  review_key: string;
  product_name: string | null;
  rating: number | null;
  review_type: string | null;
  body_masked: string;
  prev_body_masked: string | null;
  has_photo: boolean;
  author_masked: string | null;
  written_at: string | null;
  caution: boolean;
  caution_reasons: string[];
  draft_text: string | null;
  draft_edited_by: string | null;
  status: "new" | "done" | "replied_on_platform" | "hidden";
  done_by: string | null;
  done_at: string | null;
}
interface ListResp {
  rows: Review[];
  total: number;
  counts: { todo: number; caution: number };
  files: Array<{ id: number; channel: string; filename: string; uploaded_by: string; uploaded_at: string; total: number; inserted: number; auto_done: number }>;
  reminder: boolean;
}

const SELLER_REVIEW: Record<Channel, string> = {
  smartstore: "https://sell.smartstore.naver.com/#/review/search",
  coupang: "https://wing.coupang.com",
};

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    r.readAsDataURL(file);
  });
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

const Stars = ({ n }: { n: number | null }) =>
  n === null ? null : (
    <span className={`text-lg font-bold ${n <= 3 ? "text-red-600" : "text-amber-500"}`} aria-label={`별점 ${n}점`}>
      {"★".repeat(n)}
      <span className="text-gray-300">{"★".repeat(5 - n)}</span>
    </span>
  );

function ReviewCard({ r, onChanged }: { r: Review; onChanged: () => void }) {
  const [text, setText] = useState(r.draft_text ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = text !== (r.draft_text ?? "");

  async function act(path: string, body: unknown, done: string) {
    setBusy(true);
    try {
      const res = await api<{ warnings?: string[] }>(`/api/reviews/${r.id}/${path}`, { method: "POST", body });
      setMsg(res.warnings?.length ? `저장했습니다. ⚠ ${res.warnings.join(" / ")}` : done);
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`rounded-2xl bg-white p-4 shadow-sm ${r.caution && r.status === "new" ? "ring-2 ring-red-300" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <ChannelBadge c={r.channel} />
        <Stars n={r.rating} />
        {r.caution && <Badge tone="red">주의 리뷰</Badge>}
        {r.review_type && r.review_type !== "일반" && <Badge tone="blue">{r.review_type}</Badge>}
        {r.has_photo && <Badge>📷 포토</Badge>}
        {r.status === "done" && <Badge tone="green">✔ 등록 완료 · {r.done_by}</Badge>}
        {r.status === "replied_on_platform" && <Badge tone="green">판매자센터 답글 확인됨</Badge>}
        <span className="ml-auto text-gray-600">
          {r.author_masked} · {fmtDateTime(r.written_at)}
        </span>
      </div>
      {r.product_name && <div className="mt-1 font-semibold text-gray-700">{r.product_name}</div>}
      {r.caution_reasons.length > 0 && r.status === "new" && <p className="mt-2 font-semibold text-red-700">⚠ {r.caution_reasons.join(" · ")}</p>}
      {r.prev_body_masked && (
        <p className="mt-2 rounded-lg bg-gray-50 p-2 text-gray-600">
          <span className="font-semibold">이전 리뷰:</span> {r.prev_body_masked}
        </p>
      )}
      <p className="mt-2 text-lg whitespace-pre-wrap">{r.body_masked}</p>

      {r.status === "new" && (
        <>
          <label className="mt-3 block font-semibold" htmlFor={`d${r.id}`}>
            답글 초안 {r.draft_edited_by && <span className="font-normal text-green-700">({r.draft_edited_by}님이 고침)</span>}
          </label>
          <textarea
            id={`d${r.id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={9}
            className="mt-1 w-full rounded-xl border-2 border-gray-300 p-3 text-lg leading-relaxed"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              onClick={async () => {
                await copyText(text);
                setMsg("복사했습니다. 판매자센터 답글 칸에 붙여넣기(Ctrl+V) 하세요.");
              }}
              className="rounded-xl bg-blue-600 px-5 py-3 font-bold text-white"
            >
              📋 복사
            </button>
            <a href={SELLER_REVIEW[r.channel]} target="_blank" rel="noreferrer" className="rounded-xl bg-gray-800 px-5 py-3 font-bold text-white">
              판매자센터 열기 ↗
            </a>
            <button disabled={busy} onClick={() => act("done", {}, "등록 완료로 표시했습니다.")} className="rounded-xl bg-green-600 px-5 py-3 font-bold text-white disabled:opacity-40">
              ✔ 등록 완료
            </button>
            {dirty && (
              <button disabled={busy} onClick={() => act("draft", { text }, "고친 답글을 저장했습니다.")} className="rounded-xl border-2 border-blue-600 px-4 py-3 font-bold text-blue-700">
                고친 내용 저장
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => (!dirty || confirm("고친 내용이 사라집니다. 다시 만들까요?")) && act("redraft", {}, "초안을 다시 만들었습니다.")}
              className="rounded-xl border-2 border-gray-300 px-4 py-3 font-semibold"
            >
              다시 만들기
            </button>
          </div>
        </>
      )}
      {r.status === "done" && (
        <button disabled={busy} onClick={() => act("undo", {}, "처리 대기로 되돌렸습니다.")} className="mt-2 rounded-lg border-2 border-gray-300 px-4 py-2 font-semibold">
          완료 취소
        </button>
      )}
      {msg && <p className="mt-2 rounded-lg bg-green-50 p-2 font-semibold text-green-800">{msg}</p>}
    </li>
  );
}

export default function Reviews() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"todo" | "caution" | "done" | "all">("todo");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [channel, setChannel] = useState<Channel>("smartstore");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () =>
    api<ListResp>(`/api/reviews?${new URLSearchParams({ tab, q, page: String(page) })}`)
      .then((d) => {
        setData(d);
        setErr(null);
      })
      .catch((e) => setErr(e.message));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, page]);

  async function upload(f: File) {
    setBusy(true);
    setErr(null);
    setDetails([]);
    setOk(null);
    try {
      const res = await fetch("/api/reviews/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: await toBase64(f), filename: f.name, channel }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error ?? `올리기 실패 (${res.status})`);
        setDetails(j.details ?? []);
      } else {
        setOk(
          `${CHANNEL_LABEL[j.channel as Channel]} 리뷰 ${j.total}건을 읽었습니다 — 새 리뷰 ${j.inserted}건, 판매자센터 답글 확인으로 자동 완료 ${j.autoDone}건, 답글 초안 ${j.drafted}건 생성. 지금 답글 대기 ${j.counts.todo}건 (주의 ${j.counts.caution}건)`,
        );
        setTab("todo");
        setPage(1);
        load();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / 30));
  const tabs: Array<[typeof tab, string]> = [
    ["todo", `답글 대기 ${data?.counts.todo ?? ""}`],
    ["caution", `주의 리뷰 ${data?.counts.caution ?? ""}`],
    ["done", "완료"],
    ["all", "전체"],
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">리뷰 답글</h1>

      <Card className="bg-blue-50">
        <p className="font-semibold">판매자센터에서 리뷰 엑셀을 내려받아 올리면, 새 리뷰마다 답글 초안이 만들어집니다.</p>
        <p className="mt-1 text-gray-700">
          스마트스토어센터: <b>리뷰 관리 → 엑셀 다운로드</b>. 같은 리뷰는 한 번만 저장되고, 판매자센터에 이미 답글이 달린 리뷰는 자동으로 완료 처리됩니다.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select aria-label="판매처" value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className="rounded-lg border-2 border-gray-300 bg-white px-3 py-3">
            <option value="smartstore">스마트스토어 리뷰</option>
            <option value="coupang">쿠팡 리뷰</option>
          </select>
          <button disabled={busy} onClick={() => fileRef.current?.click()} className="rounded-xl bg-blue-600 px-5 py-3 font-bold text-white disabled:opacity-50">
            {busy ? "읽는 중…" : "⬆ 리뷰 엑셀 올리기"}
          </button>
          <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          {user?.role === "admin" && data && (
            <label className="ml-auto flex items-center gap-2 font-semibold">
              <input
                type="checkbox"
                className="h-5 w-5"
                checked={data.reminder}
                onChange={async (e) => {
                  await api("/api/reviews/reminder", { method: "POST", body: { on: e.target.checked } }).catch(() => undefined);
                  load();
                }}
              />
              하루 4번 &lsquo;리뷰 파일 올려주세요&rsquo; 알림 메일
            </label>
          )}
        </div>
        {data?.files[0] && (
          <p className="mt-2 text-gray-700">
            마지막 올리기: {CHANNEL_LABEL[data.files[0].channel as Channel]} · {data.files[0].uploaded_by}님 · {fmtRelative(data.files[0].uploaded_at)} (리뷰 {data.files[0].total}건, 새 리뷰{" "}
            {data.files[0].inserted}건)
          </p>
        )}
      </Card>

      {err && <ErrorBox message={err} />}
      {details.length > 0 && (
        <ul className="list-disc rounded-lg bg-red-50 p-4 pl-8 text-red-800">
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {ok && <p className="rounded-lg bg-green-50 p-4 font-semibold text-green-800">{ok}</p>}

      <div className="flex flex-wrap gap-2">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              setPage(1);
            }}
            className={`rounded-lg px-5 py-2 font-semibold ${tab === t ? "bg-gray-800 text-white" : "border-2 border-gray-300 bg-white"}`}
          >
            {label}
          </button>
        ))}
        <form
          className="flex min-w-0 grow gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(search.trim());
            setPage(1);
          }}
        >
          <input aria-label="리뷰 검색" placeholder="내용·상품명 검색" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-0 grow rounded-lg border-2 border-gray-300 px-3 py-2" />
          <button className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 font-bold whitespace-nowrap text-white">검색</button>
        </form>
      </div>

      {!data ? (
        <p className="text-lg">불러오는 중…</p>
      ) : data.rows.length === 0 ? (
        <p className="rounded-2xl bg-white p-8 text-center text-lg text-gray-600 shadow-sm">
          {tab === "todo" ? "답글 기다리는 리뷰가 없습니다. 판매자센터에서 리뷰 엑셀을 받아 올려주세요." : "리뷰가 없습니다."}
        </p>
      ) : (
        <ul className="space-y-3">
          {data.rows.map((r) => (
            <ReviewCard key={`${r.id}-${r.status}-${r.draft_text?.length ?? 0}`} r={r} onChanged={load} />
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-lg border-2 px-5 py-2 font-semibold disabled:opacity-40">
            ◀ 이전
          </button>
          <span className="font-semibold">
            {page} / {pages} 쪽 (총 {data?.total}건)
          </span>
          <button disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded-lg border-2 px-5 py-2 font-semibold disabled:opacity-40">
            다음 ▶
          </button>
        </div>
      )}
    </div>
  );
}
