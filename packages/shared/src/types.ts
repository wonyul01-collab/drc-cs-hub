/** 채널 */
export type Channel = "smartstore" | "coupang";

/** 문의 유형 */
export type InquiryKind =
  | "product_qna" // 스마트스토어 상품문의(Q&A) / 쿠팡 상품별 고객문의
  | "order_inquiry" // 스마트스토어 고객문의(주문 문의)
  | "callcenter"; // 쿠팡 고객센터 문의

/** 우리 시스템 안에서의 처리 상태 */
export type InquiryStatus =
  | "new" // 수집됨
  | "answered_on_platform" // 판매자센터에서 이미 답변됨
  | "closed"; // 처리 완료

export type Role = "admin" | "approver" | "agent";

/** DB `inquiries` 테이블에 쓰는 형태 (작업기 → DB) */
export interface InquiryUpsert {
  channel: Channel;
  kind: InquiryKind;
  external_id: string;
  product_id: string | null;
  product_name: string | null;
  order_id: string | null;
  customer_masked: string | null;
  title: string | null;
  body_masked: string;
  pii_detected: boolean;
  received_at: string; // ISO
  deadline_at: string | null; // ISO
  platform_answered: boolean;
  platform_answer: string | null;
  platform_status: string | null;
  can_reply: boolean;
  meta: Record<string, unknown>;
  last_seen_at: string;
}

export const CHANNEL_LABEL: Record<Channel, string> = {
  smartstore: "스마트스토어",
  coupang: "쿠팡",
};

export const KIND_LABEL: Record<InquiryKind, string> = {
  product_qna: "상품문의",
  order_inquiry: "주문 문의",
  callcenter: "고객센터 문의",
};

export const STATUS_LABEL: Record<InquiryStatus, string> = {
  new: "신규",
  answered_on_platform: "판매자센터 답변됨",
  closed: "처리 완료",
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: "관리자",
  approver: "승인자",
  agent: "담당자",
};
