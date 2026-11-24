/**
 * 알림 — "정확히 도착"이 최우선
 *  - 모든 알림은 notifications 테이블에 기록 (같은 key는 한 번만 → 중복 금지)
 *  - 실패하면 다음 tick(1분 뒤)에 다시, 최대 3번 → 그래도 실패면 'failed' + 화면 상단 경고
 *  - 운영 시간에만 계획·발송 (엔진이 운영 시간에만 부름)
 *  - 고객 개인정보는 넣지 않음: 건수·채널·유형·링크만
 * 1차: 이메일. 텔레그램은 같은 Notifier 형태로 나중에 추가.
 */
import nodemailer from "nodemailer";
import { isLastDayBeforeBreak, isFirstDayAfterBreak, seoulParts, type OperatingConfig } from "@drc/shared";
import type { HubDb } from "./db.ts";
import { log } from "./log.ts";

export const MAX_ATTEMPTS = 3;

export interface Notifier {
  name: string;
  send(to: string[], subject: string, text: string): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export class EmailNotifier implements Notifier {
  name = "이메일";
  private transport;
  constructor(private readonly cfg: SmtpConfig) {
    this.transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 20_000,
    });
  }
  async send(to: string[], subject: string, text: string) {
    // 받는 사람끼리 주소가 보이지 않게 숨은참조로
    await this.transport.sendMail({ from: this.cfg.from, to: this.cfg.from, bcc: to, subject, text });
  }
}

/** 쌓인 알림 보내기 */
export async function flushNotifications(db: HubDb, notifier: Notifier | null): Promise<void> {
  if (!notifier) return;
  for (const n of db.pendingNotifications(MAX_ATTEMPTS)) {
    try {
      await notifier.send(n.recipients, n.subject, n.body);
      db.markNotification(n.id, true, null, MAX_ATTEMPTS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      db.markNotification(n.id, false, msg.slice(0, 300), MAX_ATTEMPTS);
      log.warn(`알림 발송 실패 (${n.attempts + 1}/${MAX_ATTEMPTS}): ${n.subject} — ${msg}`);
    }
  }
}

export interface PlanContext {
  now: Date;
  holidays: ReadonlySet<string>;
  operating: OperatingConfig;
  baseUrl: string;
  /** 수집 실패한 수집원 이름 */
  failingSources: string[];
  coupangKeyIssuedAt: string | null;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const FOOTER = "\n\n※ 이 메일에는 고객 개인정보가 들어 있지 않습니다. 링크를 누르면 로그인 후 해당 화면으로 이동합니다.\n— DRC CS 허브";

/** 이번 tick에 보내야 할 알림을 계획해서 쌓는다 (같은 key는 한 번만) */
export function planNotifications(db: HubDb, ctx: PlanContext): number {
  const p = seoulParts(ctx.now);
  const all = db.notifyEmails();
  const admins = db.notifyEmails(true);
  const url = (path: string) => `${ctx.baseUrl}${path}`;
  let added = 0;
  const add = (key: string, kind: string, to: string[], subject: string, body: string) => {
    if (db.enqueueNotification({ key, kind, recipients: to, subject: `[DRC CS] ${subject}`, body: body + FOOTER })) added++;
  };

  // 1) 신규 문의 요약 — 15분 단위로 묶어서 1건
  const bucket = Math.floor(p.minutes / 15);
  const lastAt = db.getSetting<string>("notify_last_summary_at");
  const c = db.countsForNotify(lastAt);
  if (c.newSince > 0) {
    const key = `new-${p.date}-${bucket}`;
    const ok = db.enqueueNotification({
      key,
      kind: "new_summary",
      recipients: all,
      subject: `[DRC CS] 신규 문의 ${c.newSince}건`,
      body:
        `신규 문의 ${c.newSince}건이 들어왔습니다.\n` +
        `- ③ 사람 전용: ${c.newSinceByRoute.human}건\n- ② 승인 필요: ${c.newSinceByRoute.approve}건\n- ① 자동 가능: ${c.newSinceByRoute.auto}건\n\n` +
        `지금 처리할 문의 전체: ${c.pending}건\n▶ 확인하기: ${url("/inquiries?status=new")}` +
        FOOTER,
    });
    if (ok) {
      added++;
      db.setSetting("notify_last_summary_at", ctx.now.toISOString());
    }
  }

  // 2) 기한 임박 — 쿠팡 고객센터 문의 4시간 이내 (문의별 1번)
  for (const q of db.dueSoonCallcenter(4 * 3600e3)) {
    const left = Math.max(0, Math.round((Date.parse(q.deadline_at) - ctx.now.getTime()) / 60000));
    add(
      `deadline-${q.id}`,
      "deadline",
      all,
      `⏰ 쿠팡 고객센터 문의 답변 기한 ${Math.floor(left / 60)}시간 ${left % 60}분 남음`,
      `쿠팡 고객센터 문의 1건이 답변 기한에 가까워졌습니다. 기한이 지나면 쿠팡이 자동 종료합니다.\n▶ 바로가기: ${url(`/inquiries/${q.id}`)}`,
    );
  }

  // 3) 휴일 다음 날 아침 요약 (운영 시작 후 첫 tick)
  if (isFirstDayAfterBreak(p.date, ctx.holidays, ctx.operating) && p.minutes >= minutes(ctx.operating.start)) {
    add(
      `morning-${p.date}`,
      "morning",
      all,
      "휴일 동안 들어온 문의 요약",
      `휴일 이후 처리할 문의는 ${c.pending}건입니다 (③ 사람 전용 ${c.pendingHuman}건). 답글 대기 리뷰 ${c.reviewsTodo}건.\n▶ 확인하기: ${url("/inquiries?status=new&sort=deadline")}`,
    );
  }

  // 4) 금요일·휴일 전날 17:30 마감 알림
  if (isLastDayBeforeBreak(p.date, ctx.holidays, ctx.operating) && p.minutes >= minutes("17:30")) {
    add(
      `closing-${p.date}`,
      "closing",
      all,
      `휴일 전 마감 — 미처리 ${c.pending}건`,
      `내일은 쉬는 날입니다. 아직 처리하지 않은 문의가 ${c.pending}건 있습니다 (승인 후 판매자센터 등록 대기 ${c.approvedWaiting}건).\n▶ 확인하기: ${url("/inquiries?status=new")}`,
    );
  }

  // 5) 일일 요약 17:50
  if (p.minutes >= minutes("17:50")) {
    const t = db.todayStats(new Date(`${p.date}T00:00:00+09:00`).toISOString());
    add(
      `daily-${p.date}`,
      "daily",
      all,
      `오늘 처리 현황 (${p.date})`,
      `오늘 들어온 문의 ${t.received}건 · 승인 ${t.approved}건 · 직접 처리 완료 ${t.closed}건\n남은 문의 ${c.pending}건\n▶ 확인하기: ${url("/")}`,
    );
  }

  // 5-1) 리뷰 파일 올리기 알림 — 하루 4번 (켜 둔 경우만)
  if (db.getSetting<boolean>("review_reminder")) {
    const rc = db.reviewCounts();
    for (const [slot, label] of [[570, "09:30"], [690, "11:30"], [840, "14:00"], [990, "16:30"]] as const) {
      if (p.minutes >= slot && p.minutes < slot + 60)
        add(
          `review-remind-${p.date}-${label}`,
          "review_reminder",
          all,
          `리뷰 파일 올릴 시간입니다 (${label})`,
          `스마트스토어센터·쿠팡 Wing에서 리뷰 엑셀을 내려받아 허브 [리뷰] 메뉴에 올려주세요.\n지금 답글 대기 리뷰 ${rc.todo}건 (주의 리뷰 ${rc.caution}건)\n▶ ${url("/reviews")}`,
        );
    }
  }

  // 6) 관리자: 수집 실패 (수집원별 하루 1번)
  for (const s of ctx.failingSources) {
    add(`collect-fail-${s}-${p.date}`, "collect_fail", admins, `⚠ ${s} 수집 실패`, `${s} 문의를 가져오지 못하고 있습니다. 홈 화면의 '채널별 수집 상태'를 확인하세요.\n▶ ${url("/")}`);
  }

  // 7) 관리자: 쿠팡 키 만료 14일·3일 전
  if (ctx.coupangKeyIssuedAt) {
    const issued = Date.parse(`${ctx.coupangKeyIssuedAt}T00:00:00+09:00`);
    const left = Math.ceil((issued + 180 * 86400e3 - ctx.now.getTime()) / 86400e3);
    for (const d of [14, 3]) {
      if (!Number.isNaN(left) && left <= d)
        add(
          `coupang-key-${ctx.coupangKeyIssuedAt}-${d}`,
          "key_expiry",
          admins,
          `쿠팡 API 키 만료 ${left}일 전`,
          `쿠팡 Open API 키가 ${left}일 뒤 만료됩니다. Wing에서 재발급 후 3-settings.bat 으로 키와 발급일을 바꿔주세요. (사방넷 연동도 함께 확인)`,
        );
    }
  }
  return added;
}
