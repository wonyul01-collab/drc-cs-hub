import { ALL_RULES, ROUTE_LABEL, type Route } from "@drc/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Card, ErrorBox } from "../components/ui.tsx";
import { api, useAuth } from "../lib.ts";

interface Entry {
  id: number;
  active: boolean;
  category: string;
  title: string;
  products: string[];
  keywords: string[];
  example: string | null;
  answer: string;
  conditions: string | null;
  min_route: Route;
  valid_until: string | null;
  updated_at: string;
  updated_by: string | null;
}
interface Product {
  name: string;
  aliases: string[];
  absorb_ml: string | null;
  features: string | null;
  size_guide: string | null;
  wash_guide: string | null;
  caution: string | null;
}

const CAT: Record<string, string> = Object.fromEntries([...ALL_RULES.map((r) => [r.id, r.label]), ["other", "기타"]]);

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    r.readAsDataURL(file);
  });
}

export default function Knowledge() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [data, setData] = useState<{ knowledge: Entry[]; products: Product[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);
  const [ok, setOk] = useState<string | null>(null);
  const [tab, setTab] = useState<"answers" | "products">("answers");
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"all" | "on" | "off">("all");
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () =>
    api<{ knowledge: Entry[]; products: Product[] }>("/api/knowledge")
      .then(setData)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);

  const list = useMemo(() => {
    const s = q.trim();
    return (data?.knowledge ?? []).filter(
      (k) =>
        (show === "all" || (show === "on" ? k.active : !k.active)) &&
        (!s || [k.title, k.answer, k.example ?? "", k.products.join(" "), k.keywords.join(" "), CAT[k.category] ?? ""].some((x) => x.includes(s))),
    );
  }, [data, q, show]);

  async function upload(f: File) {
    if (!confirm(`'${f.name}' 내용으로 지식 DB 전체를 바꿀까요?\n(바꾸기 전 자동 백업됩니다)`)) return;
    setBusy(true);
    setErr(null);
    setDetails([]);
    setOk(null);
    try {
      const file = await toBase64(f);
      const res = await fetch("/api/knowledge/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error ?? `올리기 실패 (${res.status})`);
        setDetails(j.details ?? []);
      } else {
        setOk(`올리기 완료: 답변 ${j.entries}개 (사용 중 ${j.active}개), 상품 ${j.products}개. 처리 전 문의 ${j.redrafted}건의 초안을 새로 만들었습니다.`);
        load();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function patch(id: number, body: { active?: boolean; answer?: string }, done: string) {
    try {
      await api(`/api/knowledge/${id}`, { method: "PATCH", body });
      setOk(done);
      setErr(null);
      setEditing(null);
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  if (!data && !err) return <p className="text-lg">불러오는 중…</p>;
  const on = data?.knowledge.filter((k) => k.active).length ?? 0;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">지식 DB (표준 답변)</h1>
      <Card className="bg-blue-50">
        <p className="font-semibold">문의가 오면 여기 있는 표준 답변으로 초안을 만듭니다. 고정 인사말·마무리 안내는 자동으로 붙습니다.</p>
        <p className="mt-1">
          여러 개를 한꺼번에 고칠 때는 <b>엑셀로 내려받기 → 엑셀에서 수정·저장 → 엑셀 올리기</b> 순서로 하세요.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href="/api/knowledge.xlsx" download className="rounded-xl bg-green-700 px-5 py-3 font-bold text-white">
            ⬇ 엑셀로 내려받기
          </a>
          {isAdmin && (
            <>
              <button disabled={busy} onClick={() => fileRef.current?.click()} className="rounded-xl bg-blue-600 px-5 py-3 font-bold text-white disabled:opacity-50">
                {busy ? "올리는 중…" : "⬆ 엑셀 올리기 (전체 바꾸기)"}
              </button>
              <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            </>
          )}
        </div>
      </Card>

      {err && <ErrorBox message={err} />}
      {details.length > 0 && (
        <ul className="list-disc space-y-1 rounded-lg bg-red-50 p-4 pl-8 text-red-800">
          {details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
      {ok && <p className="rounded-lg bg-green-50 p-4 font-semibold text-green-800">{ok}</p>}

      <div className="flex gap-2">
        {(["answers", "products"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-5 py-2 font-semibold ${tab === t ? "bg-gray-800 text-white" : "border-2 border-gray-300 bg-white"}`}
          >
            {t === "answers" ? `표준 답변 (사용 중 ${on} / 전체 ${data?.knowledge.length ?? 0})` : `상품 정보 (${data?.products.length ?? 0})`}
          </button>
        ))}
      </div>

      {tab === "answers" ? (
        <>
          <div className="flex flex-wrap gap-2 rounded-2xl bg-white p-4 shadow-sm">
            <input
              aria-label="검색"
              placeholder="제목·답변·상품·키워드 검색"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="min-w-0 grow rounded-lg border-2 border-gray-300 px-3 py-2"
            />
            <select aria-label="사용 여부" value={show} onChange={(e) => setShow(e.target.value as typeof show)} className="rounded-lg border-2 border-gray-300 bg-white px-3 py-2">
              <option value="all">전체</option>
              <option value="on">사용 중</option>
              <option value="off">사용 안 함 (채워야 할 답변 포함)</option>
            </select>
          </div>
          {list.length === 0 && <p className="rounded-2xl bg-white p-8 text-center text-gray-600 shadow-sm">표준 답변이 없습니다. 엑셀을 올려주세요.</p>}
          <ul className="space-y-3">
            {list.map((k) => (
              <li key={k.id} className={`rounded-2xl bg-white p-4 shadow-sm ${k.active ? "" : "opacity-70"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-gray-500">#{k.id}</span>
                  <span className="text-lg font-bold">{k.title}</span>
                  <Badge tone="blue">{CAT[k.category] ?? k.category}</Badge>
                  <Badge tone={k.min_route === "auto" ? "green" : k.min_route === "approve" ? "amber" : "red"}>{ROUTE_LABEL[k.min_route]}</Badge>
                  {!k.active && <Badge>{k.answer ? "사용 안 함" : "답변 비어 있음"}</Badge>}
                  {k.valid_until && <Badge tone="gray">~{k.valid_until}</Badge>}
                </div>
                <div className="mt-1 text-gray-600">
                  상품: {k.products.length ? k.products.join(", ") : "전체"} · 키워드: {k.keywords.join(", ") || "-"}
                </div>
                {k.example && <div className="mt-1 text-gray-600">예) {k.example}</div>}
                {k.conditions && <p className="mt-2 rounded-lg bg-amber-100 p-2 font-semibold text-amber-900">⚠ 보내기 전 확인: {k.conditions}</p>}

                {editing?.id === k.id ? (
                  <div className="mt-2">
                    <textarea
                      aria-label="표준 답변 수정"
                      value={editing.text}
                      onChange={(e) => setEditing({ id: k.id, text: e.target.value })}
                      rows={5}
                      className="w-full rounded-xl border-2 border-blue-400 p-3 text-lg"
                    />
                    <div className="mt-2 flex gap-2">
                      <button onClick={() => patch(k.id, { answer: editing.text }, `「${k.title}」 답변을 고쳤습니다.`)} className="rounded-lg bg-blue-600 px-5 py-2 font-bold text-white">
                        저장
                      </button>
                      <button onClick={() => setEditing(null)} className="rounded-lg border-2 border-gray-300 px-5 py-2 font-semibold">
                        취소
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 rounded-lg bg-gray-50 p-3 text-lg whitespace-pre-wrap">{k.answer || <span className="text-gray-500">(답변을 채워주세요)</span>}</p>
                )}

                {isAdmin && editing?.id !== k.id && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button onClick={() => setEditing({ id: k.id, text: k.answer })} className="rounded-lg border-2 border-gray-300 px-4 py-2 font-semibold">
                      답변 고치기
                    </button>
                    <button
                      disabled={!k.answer}
                      onClick={() => patch(k.id, { active: !k.active }, k.active ? `「${k.title}」 사용을 껐습니다.` : `「${k.title}」 사용을 켰습니다.`)}
                      className={`rounded-lg px-4 py-2 font-semibold disabled:opacity-40 ${k.active ? "border-2 border-red-300 text-red-700" : "bg-green-600 text-white"}`}
                    >
                      {k.active ? "사용 끄기" : "사용 켜기"}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Card>
          {(data?.products.length ?? 0) === 0 ? (
            <p className="text-gray-600">상품 정보가 없습니다. 엑셀의 「상품정보」 시트로 올려주세요.</p>
          ) : (
            <ul className="divide-y divide-gray-200">
              {data!.products.map((p) => (
                <li key={p.name} className="py-3">
                  <div className="text-lg font-bold">
                    {p.name} {p.absorb_ml && <span className="font-normal text-gray-600">· 흡수량 {p.absorb_ml}ml</span>}
                  </div>
                  {p.aliases.length > 0 && <div className="text-gray-600">다른 이름: {p.aliases.join(", ")}</div>}
                  {p.features && <div>특징: {p.features}</div>}
                  {p.size_guide && <div>사이즈: {p.size_guide}</div>}
                  {p.wash_guide && <div>세탁: {p.wash_guide}</div>}
                  {p.caution && <div className="text-amber-800">주의: {p.caution}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
