import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import cron from "node-cron";
import { loadConfig, loadSettingsFile, redactSecrets } from "./config.ts";
import { coupangSources } from "./coupang/sources.ts";
import { HubDb } from "./db.ts";
import { Engine } from "./engine.ts";
import { log, setLogDir, setRedactor } from "./log.ts";
import { naverSources } from "./naver/sources.ts";
import { processDrafts } from "./pipeline.ts";
import { createHubServer } from "./server.ts";
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

  const engine = new Engine({ store: db, sources, workerId: cfg.workerId, lookbackDays: cfg.lookbackDays, dataGoKrKey: cfg.dataGoKrKey, afterCollect: () => void processDrafts(db) });

  // 화면 제공
  const webDir = resolve(import.meta.dirname, "../../web/dist");
  const server = createHubServer({ db, webDir, backup: () => db.backup(cfg.backupDir) });
  server.listen(cfg.port, "0.0.0.0", () => {
    log.info("──────────────────────────────────────────────");
    log.info("DRC CS 허브가 켜졌습니다.");
    log.info(`  이 PC에서:      http://localhost:${cfg.port}`);
    for (const a of lanAddresses(cfg.port)) log.info(`  다른 PC에서:    ${a}`);
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
