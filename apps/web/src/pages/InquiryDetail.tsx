import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Badge, Card, ChannelBadge, ErrorBox, KindBadge, StatusBadge } from "../components/ui.tsx";
import { api, fmtDateTime, fmtRemaining, platformStatusLabel } from "../lib.ts";
import type { InquiryRow } from "./Inquiries.tsx";

export default function InquiryDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [row, setRow] = useState<InquiryRow | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<InquiryRow>(`/api/inquiries/${Number(id)}`)
      .then(setRow)
      .catch((e) => (e.status === 404 ? setRow(null) : setErr(e.message)));
  }, [id]);

  if (err) return <ErrorBox message={`불러오기 실패: ${err}`} />;
  if (row === undefined) return <p className="text-lg">불러오는 중…</p>;
  if (row === null) return <ErrorBox message="문의를 찾을 수 없습니다." />;

  const rem = row.can_reply && row.status === "new" ? fmtRemaining(row.deadline_at) : null;
  const sellerCenter = row.channel === "coupang" ? "https://wing.coupang.com" : "https://sell.smartstore.naver.com";

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
          <dd>{platformStatusLabel(row.platform_status)}{!row.can_reply && " · 지금은 답변할 수 없는 상태"}</dd>
        </dl>
      </Card>

      <Card>
        <h2 className="text-xl font-bold">문의 내용 {row.title && <span className="text-gray-600">[{row.title}]</span>}</h2>
        <p className="mt-3 whitespace-pre-wrap text-lg leading-relaxed">{row.body_masked}</p>
        <p className="mt-3 text-sm text-gray-600">전화번호·주소·계좌 등은 자동으로 가려서 표시합니다.</p>
      </Card>

      {row.platform_answer && (
        <Card>
          <h2 className="text-xl font-bold">판매자센터에 등록된 답변</h2>
          <p className="mt-3 whitespace-pre-wrap text-lg">{row.platform_answer}</p>
        </Card>
      )}

      <Card className="bg-blue-50">
        <p className="font-semibold">AI 초안·승인 버튼은 Phase 2~3에서 추가됩니다. 지금은 판매자센터에서 직접 답변하세요.</p>
        <a href={sellerCenter} target="_blank" rel="noreferrer" className="mt-3 inline-block rounded-xl bg-gray-800 px-6 py-3 font-bold text-white">
          판매자센터 열기 ↗
        </a>
      </Card>
    </div>
  );
}
