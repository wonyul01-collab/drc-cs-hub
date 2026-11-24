import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Badge, Card, ChannelBadge, ErrorBox, KindBadge, RouteBadge, StatusBadge } from "../components/ui.tsx";
import { api, fmtDateTime, fmtRelative, fmtRemaining, platformStatusLabel } from "../lib.ts";
import type { InquiryRow } from "./Inquiries.tsx";

export interface Draft {
  id: number;
  text: string;
  route: "auto" | "approve" | "human";
  category: string | null;
  confidence: number | null;
  created_at: string;
  created_by: string;
  detail: {
    categoryLabel?: string;
    products?: string[];
    reasons?: string[];
    conditions?: string[];
    forbidden?: Array<{ label: string; match: string }>;
    warnings?: string[];
    edited?: boolean;
  };
}

type Detail = InquiryRow & { draft: Draft | null; refs: Array<{ id: number; title: string; conditions: string | null }> };

const MAX = 1000;

export default function InquiryDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [row, setRow] = useState<Detail | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<Detail>(`/api/inquiries/${Number(id)}`)
      .then((r) => {
        setRow(r);
        setText(r.draft?.text ?? "");
      })
      .catch((e) => (e.status === 404 ? setRow(null) : setErr(e.message)));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (err) return <ErrorBox message={`불러오기 실패: ${err}`} />;
  if (row === undefined) return <p className="text-lg">불러오는 중…</p>;
  if (row === null) return <ErrorBox message="문의를 찾을 수 없습니다." />;

  const rem = row.can_reply && row.status === "new" ? fmtRemaining(row.deadline_at) : null;
  const sellerCenter = row.channel === "coupang" ? "https://wing.coupang.com" : "https://sell.smartstore.naver.com";
  const d = row.draft;
  const dirty = !!d && text !== d.text;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // http 주소에서는 클립보드 API가 막힐 수 있어 예전 방식으로
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setMsg("복사했습니다. 판매자센터 답변 칸에 붙여넣기(Ctrl+V) 하세요.");
  }

  async function save() {
    setBusy(true);
    try {
      await api(`/api/inquiries/${row!.id}/draft`, { method: "POST", body: { text } });
      setMsg("고친 답변을 저장했습니다.");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function redraft() {
    if (dirty && !confirm("고친 내용이 사라집니다. 지식 DB로 다시 만들까요?")) return;
    setBusy(true);
    try {
      await api(`/api/inquiries/${row!.id}/redraft`, { method: "POST", body: {} });
      setMsg("지식 DB로 초안을 다시 만들었습니다.");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <button onClick={() => navigate(-1)} className="font-semibold text-blue-700">
        ◀ 목록으로
      </button>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <ChannelBadge c={row.channel} />
          <KindBadge k={row.kind} />
          <StatusBadge s={row.status} />
          {d && <RouteBadge r={d.route} />}
          {row.pii_detected && <Badge tone="amber">개인정보 포함 — 직접 확인 필요</Badge>}
          {rem && <Badge tone={rem.level === "ok" ? "gray" : rem.level === "warn" ? "amber" : "red"}>⏰ {rem.text}</Badge>}
        </div>
        <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-y-2 break-words">
          <dt className="font-semibold text-gray-600">접수</dt>
          <dd>{fmtDateTime(row.received_at)}</dd>
          {row.deadline_at && (
            <>
              <dt className="font-semibold text-gray-600">답변 기한</dt>
              <dd>{fmtDateTime(row.deadline_at)} (쿠팡 24시간 자동 종료)</dd>
            </>
          )}
          <dt className="font-semibold text-gray-600">상품</dt>
          <dd>{row.product_name ?? row.product_id ?? "-"}</dd>
          {row.meta?.option && (
            <>
              <dt className="font-semibold text-gray-600">주문 옵션</dt>
              <dd>{row.meta.option}</dd>
            </>
          )}
          <dt className="font-semibold text-gray-600">주문번호</dt>
          <dd>{row.order_id ?? "-"}</dd>
          <dt className="font-semibold text-gray-600">고객</dt>
          <dd>{row.customer_masked ?? "-"}</dd>
          <dt className="font-semibold text-gray-600">마켓 상태</dt>
          <dd>
            {platformStatusLabel(row.platform_status)}
            {!row.can_reply && " · 지금은 답변할 수 없는 상태"}
          </dd>
        </dl>
      </Card>

      <Card>
        <h2 className="text-xl font-bold">문의 내용 {row.title && <span className="text-gray-600">[{row.title}]</span>}</h2>
        <p className="mt-3 text-lg leading-relaxed whitespace-pre-wrap">{row.body_masked}</p>
        <p className="mt-3 text-sm text-gray-600">전화번호·주소·계좌 등은 자동으로 가려서 표시합니다.</p>
      </Card>

      {row.platform_answer && (
        <Card>
          <h2 className="text-xl font-bold">판매자센터에 등록된 답변</h2>
          <p className="mt-3 text-lg whitespace-pre-wrap">{row.platform_answer}</p>
        </Card>
      )}

      <Card className="border-2 border-blue-200">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-bold">답변 초안</h2>
          {d && <RouteBadge r={d.route} />}
          {d?.detail.categoryLabel && <Badge tone="blue">{d.detail.categoryLabel}</Badge>}
          {d?.created_by !== "system" && d && <Badge tone="green">{d.created_by}님이 고침</Badge>}
        </div>

        {!d ? (
          <p className="mt-3 text-gray-700">아직 초안이 없습니다. 업무시간에 문의를 모은 뒤 자동으로 만들어집니다.</p>
        ) : (
          <>
            {d.route === "human" && (
              <p className="mt-3 rounded-lg bg-red-50 p-3 font-bold text-red-800">
                ③ 사람 전용 문의입니다. 아래 초안은 참고만 하시고, 내용을 직접 확인해서 답변하세요.
              </p>
            )}
            {(d.detail.conditions ?? []).map((c) => (
              <p key={c} className="mt-3 rounded-lg bg-amber-100 p-3 font-semibold text-amber-900">
                ⚠ 보내기 전에 확인: {c}
              </p>
            ))}
            {(d.detail.forbidden ?? []).map((f) => (
              <p key={f.label} className="mt-3 rounded-lg bg-red-100 p-3 font-semibold text-red-800">
                ⛔ 쓰면 안 되는 표현: {f.label} (&ldquo;{f.match}&rdquo;)
              </p>
            ))}
            {(d.detail.warnings ?? []).map((w) => (
              <p key={w} className="mt-3 rounded-lg bg-amber-50 p-3 text-amber-900">
                ⚠ {w}
              </p>
            ))}

            <label className="mt-4 block font-semibold" htmlFor="draft">
              답변 (고쳐서 쓸 수 있습니다)
            </label>
            <textarea
              id="draft"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={14}
              className="mt-2 w-full rounded-xl border-2 border-gray-300 p-4 text-lg leading-relaxed"
            />
            <div className={`text-right ${text.length > MAX ? "font-bold text-red-700" : "text-gray-600"}`}>
              {text.length} / {MAX}자
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={copy} className="rounded-xl bg-blue-600 px-6 py-3 text-lg font-bold text-white">
                📋 복사하기
              </button>
              <a href={sellerCenter} target="_blank" rel="noreferrer" className="rounded-xl bg-gray-800 px-6 py-3 text-lg font-bold text-white">
                판매자센터 열기 ↗
              </a>
              <button onClick={save} disabled={!dirty || busy} className="rounded-xl border-2 border-blue-600 px-5 py-3 font-bold text-blue-700 disabled:opacity-40">
                고친 내용 저장
              </button>
              <button onClick={redraft} disabled={busy} className="rounded-xl border-2 border-gray-300 px-5 py-3 font-semibold">
                지식 DB로 다시 만들기
              </button>
            </div>
            {msg && <p className="mt-3 rounded-lg bg-green-50 p-3 font-semibold text-green-800">{msg}</p>}

            <details className="mt-5 rounded-xl bg-gray-50 p-4">
              <summary className="cursor-pointer font-semibold">이렇게 분류·작성한 이유</summary>
              <ul className="mt-2 list-disc space-y-1 pl-6">
                {(d.detail.reasons ?? []).map((r) => (
                  <li key={r}>{r}</li>
                ))}
                <li>확인된 상품: {(d.detail.products ?? []).join(", ") || "없음"}</li>
                <li>
                  참고한 표준 답변: {row.refs.length ? row.refs.map((r) => `「${r.title}」`).join(", ") : "없음 (지식 DB에 맞는 답변이 없어 '확인 후 안내' 문구 사용)"}
                </li>
                {d.confidence !== null && <li>일치도: {Math.round(d.confidence * 100)}%</li>}
                <li>
                  작성: {d.created_by === "system" ? "자동" : `${d.created_by}님`} · {fmtRelative(d.created_at)}
                </li>
              </ul>
            </details>
          </>
        )}
      </Card>
      <p className="text-gray-600">
        지금은 마켓에 자동으로 등록하지 않습니다. 복사해서 판매자센터에 붙여넣어 주세요. (승인 버튼·자동 등록은 다음 단계에서 추가)
      </p>
    </div>
  );
}
