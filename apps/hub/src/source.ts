import type { Channel, InquiryKind, InquiryUpsert } from "@drc/shared";

/** 문의 수집원 하나 (예: 쿠팡 고객센터 문의) */
export interface InquirySource {
  channel: Channel;
  kind: InquiryKind;
  label: string;
  /** 한 번에 조회할 수 있는 최대 기간(일). 넘으면 잘라서 여러 번 조회 */
  maxWindowDays: number;
  fetch(from: Date, to: Date): Promise<{ rows: InquiryUpsert[]; rawKeys: string[]; shape?: string; request?: string }>;
}

/** 페이지 반복 안전장치 */
export const MAX_PAGES = 100;
