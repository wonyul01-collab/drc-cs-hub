import cron from "node-cron";
import { loadConfig, redactSecrets } from "./config.ts";
import { coupangSources } from "./coupang/sources.ts";
import { Engine } from "./engine.ts";
import { log, setRedactor } from "./log.ts";
import { naverSources } from "./naver/sources.ts";
import type { InquirySource } from "./source.ts";
import { SupabaseStore } from "./store.ts";

function coupangKeyWarning(issuedAt: string | null) {
  if (!issuedAt) return;
  const issued = Date.parse(`${issuedAt}T00:00:00+09:00`);
  if (Number.isNaN(issued)) return;
  const left = Math.ceil((issued + 180 * 86400e3 - Date.now()) / 86400e3);
  if (left <= 14) log.warn(`쿠팡 Open API 키 만료까지 ${left}일 남았습니다. Wing에서 재발급하세요.`);
}

async function main() {
  const cfg = loadConfig();
  setRedactor((s) => redactSecrets(s, cfg));

  const sources: InquirySource[] = [];
  if (cfg.naver) sources.push(...naverSources(cfg.naver));
  else log.warn("네이버 키가 없어 스마트스토어 수집을 건너뜁니다.");
  if (cfg.coupang) sources.push(...coupangSources(cfg.coupang));
  else log.warn("쿠팡 키가 없어 쿠팡 수집을 건너뜁니다.");

  const store = new SupabaseStore(cfg.supabaseUrl, cfg.supabaseSecretKey);
  const engine = new Engine({ store, sources, workerId: cfg.workerId, lookbackDays: cfg.lookbackDays, dataGoKrKey: cfg.dataGoKrKey });

  log.info(`DRC CS 허브 작업기 시작 — 수집원 ${sources.length}개, DRY_RUN=${cfg.dryRun ? "켜짐(실제 등록 안 함)" : "꺼짐"}`);
  coupangKeyWarning(cfg.coupang?.keyIssuedAt ?? null);
  await store.audit("worker.start", { workerId: cfg.workerId, sources: sources.map((s) => s.label) }).catch(() => undefined);

  const run = () =>
    engine.tick().catch((e) => log.error("작업 중 오류 (1분 뒤 다시 시도합니다)", e));
  await run();
  cron.schedule("* * * * *", run, { timezone: "Asia/Seoul" });
  cron.schedule("0 9 * * *", () => coupangKeyWarning(cfg.coupang?.keyIssuedAt ?? null), { timezone: "Asia/Seoul" });

  const stop = () => {
    log.info("작업기를 종료합니다.");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  log.error("작업기를 시작하지 못했습니다", e);
  process.exit(1);
});
