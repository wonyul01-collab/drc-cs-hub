import { checkFixedText, checkForbidden, makeDraft, type Channel } from "@drc/shared";
import type { HubDb } from "./db.ts";
import { log } from "./log.ts";

/** 아직 초안이 없는 문의에 분류·초안 만들기 (운영 시간에 수집 직후 실행) */
export function processDrafts(db: HubDb, limit = 200): number {
  const pending = db.pendingForDraft(limit);
  if (!pending.length) return 0;
  const knowledge = db.knowledgeEntries();
  const products = db.productInfos();
  for (const q of pending) {
    const r = makeDraft(
      {
        channel: q.channel as Channel,
        text: [q.title, q.body_masked].filter(Boolean).join(" "),
        productName: q.product_name,
        piiDetected: q.pii_detected,
        priorComplaints: db.priorComplaints(q.order_id, q.id),
      },
      knowledge,
      products,
    );
    db.saveSystemDraft(q.id, r);
  }
  log.info(`분류·초안 ${pending.length}건 만들었습니다.`);
  return pending.length;
}

/** 담당자가 고친 문장 검사 */
export function checkEdited(text: string) {
  return { forbidden: checkForbidden(text), warnings: checkFixedText(text) };
}
