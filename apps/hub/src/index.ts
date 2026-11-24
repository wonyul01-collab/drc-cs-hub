import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import cron from "node-cron";
import { loadConfig, loadSettingsFile, redactSecrets } from "./config.ts";
import { coupangSources } from "./coupang/sources.ts";
import { HubDb } from "./db.ts";
import { Engine } from "./engine.ts";
import { log, setLogDir, setRedactor } from "./log.ts";
import { naverSources } from "./naver/sources.ts";
import { EmailNotifier, flushNotifications, planNotifications } from "./notify.ts";
import { processDrafts } from "./pipeline.ts";
import { createHubServer } from "./server.ts";
import { Updater } from "./updater.ts";
import type { InquirySource } from "./source.ts";

function coupangKeyWarning(issuedAt: string | null) {
  if (!issuedAt) return;
  const issued = Date.parse(`${issuedAt}T00:00:00+09:00`);
  if (Number.isNaN(issued)) return;
  const left = Math.ceil((issued + 180 * 86400e3 - Date.now()) / 86400e3);
  if (left <= 14) log.warn(`쿠팡 Open API 키 만료까지 ${left}일 남았습니다. Wing에서 재발급하세요.`);
}

/** 같은 사무실 다른 PC가 접속할 주소 (192.168.x.x 등) */
function lanAddresses(port: number): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => `http://${a!.address}:${port}`);
}

async function main() {
  const settings = loadSettingsFile(resolve(import.meta.dirname, "../.env.example"));
  const cfg = loadConfig();
  setRedactor((s) => redactSecrets(s, cfg));
  setLogDir(join(cfg.dataDir, "logs"));
  if (settings.created) log.warn(`설정 파일을 새로 만들었습니다: ${settings.path} → 3-settings.bat 으로 열어 마켓 키를 넣고 허브를 다시 켜세요.`);

  const db = new HubDb(join(cfg.dataDir, "drc-cs-hub.db"));

  const sources: InquirySource[] = [];
  if (cfg.naver) sources.push(...naverSources(cfg.naver));
  else log.warn("네이버 키가 없어 스마트스토어 수집을 건너뜁니다.");
  if (cfg.coupang) sources.push(...coupangSources(cfg.coupang));
  else log.warn("쿠팡 키가 없어 쿠팡 수집을 건너뜁니다.");

  // 마켓 키가 바뀌었으면(또는 처음이면) 그 채널은 최근 30일을 다시 가져온다 — 키 자체는 저장하지 않고 지문만 비교
  const fp = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  const keyPrints: Array<[string, string | null]> = [
    ["smartstore", cfg.naver ? fp(cfg.naver.clientId) : null],
    ["coupang", cfg.coupang ? fp(`${cfg.coupang.vendorId}|${cfg.coupang.accessKey}`) : null],
  ];
  for (const [channel, print] of keyPrints) {
    if (!print) continue;
    if (db.getSetting<string>(`key_print_${channel}`) !== print) {
      db.requestBackfill(30, channel);
      db.setSetting(`key_print_${channel}`, print);
      log.info(`${channel === "smartstore" ? "스마트스토어" : "쿠팡"} 키가 새로 설정되어 최근 30일 문의를 다시 가져옵니다 (업무시간에).`);
    }
  }

  // 알림 (1차: 이메일)
  const notifier = cfg.smtp ? new EmailNotifier(cfg.smtp) : null;
  const privateLan = lanAddresses(cfg.port).find((u) => /\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u));
  const baseUrl = cfg.hubUrl ?? privateLan ?? `http://localhost:${cfg.port}`;
  if (!notifier) log.warn("알림 메일 계정이 설정되지 않아 알림을 보내지 않습니다 (3-settings.bat → MAIL_USER, MAIL_PASSWORD).");

  const engine = new Engine({
    store: db,
    sources,
    workerId: cfg.workerId,
    lookbackDays: cfg.lookbackDays,
    dataGoKrKey: cfg.dataGoKrKey,
    afterCollect: () => void processDrafts(db),
    everyOperatingMinute: async (ctx) => {
      if (!notifier) return;
      planNotifications(db, { ...ctx, baseUrl, coupangKeyIssuedAt: cfg.coupang?.keyIssuedAt ?? null });
      await flushNotifications(db, notifier);
    },
  });

  // 화면 제공
  const webDir = resolve(import.meta.dirname, "../../web/dist");
  const updater = new Updater(resolve(import.meta.dirname, "../../.."), join(cfg.dataDir, "update-requested"));
  const restartForUpdate = (why: string) => {
    log.info(`새 버전으로 업데이트합니다 (${why}). 잠시 후 자동으로 다시 켜집니다.`);
    server.close();
    updater.requestRestartForUpdate(() => {
      db.close();
      process.exit(0);
    });
  };
  const server = createHubServer({
    db,
    webDir,
    backup: () => db.backup(cfg.backupDir),
    updater,
    onUpdate: () => restartForUpdate("관리자 요청"),
    dryRun: cfg.dryRun,
    notifier,
    baseUrl,
  });
  server.listen(cfg.port, "0.0.0.0", () => {
    log.info("──────────────────────────────────────────────");
    log.info("DRC CS 허브가 켜졌습니다.");
    log.info(`  이 PC에서:      http://localhost:${cfg.port}`);
    const lan = lanAddresses(cfg.port);
    const isPrivate = (u: string) => /\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u);
    for (const a of lan.filter(isPrivate)) log.info(`  다른 PC에서:    ${a}   ← 다른 PC 크롬 주소창에 이 주소 입력 (localhost 아님)`);
    if (!lan.some(isPrivate)) log.warn("  사내망 주소(192.168… 등)를 찾지 못했습니다. 이 PC가 공유기 없이 인터넷에 직접 연결된 것 같습니다 — 설치가이드 '다른 PC 접속이 안 될 때' 참고");
    log.info(`  데이터 파일:    ${db.path}`);
    log.info(`  설정 파일:      ${settings.path}`);
    log.info(`  백업 폴더:      ${cfg.backupDir}`);
    log.info(`  수집 대상 ${sources.length}개 · DRY_RUN=${cfg.dryRun ? "켜짐(마켓에 실제 등록 안 함)" : "꺼짐"}`);
    if (db.userCount() === 0) log.info(`  ▶ 처음 실행입니다. 이 PC의 크롬에서 http://localhost:${cfg.port} 을 열어 관리자 계정을 만드세요.`);
    log.info("──────────────────────────────────────────────");
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") log.error(`${cfg.port}번 포트를 이미 다른 프로그램이 쓰고 있습니다. 허브가 이미 켜져 있는지 확인하세요.`);
    else log.error("화면 서버 오류", e);
    process.exit(1);
  });

  coupangKeyWarning(cfg.coupang?.keyIssuedAt ?? null);
  await db.audit("hub.start", { workerId: cfg.workerId, sources: sources.map((s) => s.label) });

  const run = () => engine.tick().catch((e) => log.error("작업 중 오류 (1분 뒤 다시 시도합니다)", e));
  await run();
  cron.schedule("* * * * *", run, { timezone: "Asia/Seoul" });
  cron.schedule("0 9 * * *", () => coupangKeyWarning(cfg.coupang?.keyIssuedAt ?? null), { timezone: "Asia/Seoul" });
  // 평일 08:40 새 버전 확인 → 있으면 업무 시작 전에 자동 업데이트 (git 설치형만)
  if (updater.installedWithGit) {
    log.info("자동 업데이트: 켜짐 (평일 08:40 확인)");
    cron.schedule(
      "40 8 * * 1-5",
      async () => {
        const st = await updater.check();
        if (st.error) log.warn(`업데이트 확인 실패: ${st.error}`);
        else if (st.hasUpdate) {
          try {
            db.backup(cfg.backupDir);
          } catch {
            /* 백업 실패해도 업데이트는 진행 */
          }
          restartForUpdate(`${st.current} → ${st.latest}`);
        }
      },
      { timezone: "Asia/Seoul" },
    );
  } else log.info("자동 업데이트: 꺼짐 (ZIP으로 설치됨 — 6-auto-update-setup.bat 로 켤 수 있음)");

  // 매일 18:10 데이터 백업 (30개 보관)
  cron.schedule(
    "10 18 * * *",
    () => {
      try {
        log.info(`백업 완료: ${db.backup(cfg.backupDir)}`);
      } catch (e) {
        log.error("백업 실패", e);
      }
    },
    { timezone: "Asia/Seoul" },
  );

  const stop = () => {
    log.info("허브를 종료합니다.");
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  log.error("허브를 시작하지 못했습니다", e);
  process.exit(1);
});
