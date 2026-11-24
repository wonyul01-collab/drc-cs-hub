import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 데이터·설정 기본 폴더: 사용자 폴더 아래 DRC-CS-Hub-Data (프로그램을 새로 받아도 데이터는 그대로) */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATA_DIR?.trim() ? resolve(env.DATA_DIR.trim()) : join(homedir(), "DRC-CS-Hub-Data");
}

export interface HubConfig {
  workerId: string;
  port: number;
  dataDir: string;
  backupDir: string;
  naver: { clientId: string; clientSecret: string } | null;
  coupang: { vendorId: string; accessKey: string; secretKey: string; keyIssuedAt: string | null } | null;
  dataGoKrKey: string | null;
  lookbackDays: number;
  dryRun: boolean;
}

function opt(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): HubConfig {
  const naverId = opt(env, "NAVER_CLIENT_ID");
  const naverSecret = opt(env, "NAVER_CLIENT_SECRET");
  const cpVendor = opt(env, "COUPANG_VENDOR_ID");
  const cpAccess = opt(env, "COUPANG_ACCESS_KEY");
  const cpSecret = opt(env, "COUPANG_SECRET_KEY");
  const lookback = Number(env.COLLECT_LOOKBACK_DAYS ?? 7);
  const port = Number(env.PORT ?? 3000);
  const dataDir = opt(env, "DATA_DIR") ? resolve(cwd, opt(env, "DATA_DIR")!) : defaultDataDir(env);

  return {
    workerId: opt(env, "WORKER_ID") ?? "main-pc",
    port: Number.isInteger(port) && port > 0 ? port : 3000,
    dataDir,
    backupDir: resolve(cwd, opt(env, "BACKUP_DIR") ?? join(dataDir, "backups")),
    naver: naverId && naverSecret ? { clientId: naverId, clientSecret: naverSecret } : null,
    coupang:
      cpVendor && cpAccess && cpSecret
        ? { vendorId: cpVendor, accessKey: cpAccess, secretKey: cpSecret, keyIssuedAt: opt(env, "COUPANG_KEY_ISSUED_AT") }
        : null,
    dataGoKrKey: opt(env, "DATA_GO_KR_SERVICE_KEY"),
    lookbackDays: Number.isFinite(lookback) ? Math.min(Math.max(lookback, 1), 30) : 7,
    // 안전장치: "false"라고 정확히 써야만 꺼진다
    dryRun: (env.DRY_RUN ?? "true").trim().toLowerCase() !== "false",
  };
}

/** 로그·오류 메시지에 비밀값이 섞이지 않게 가린다 */
export function redactSecrets(text: string, cfg: HubConfig): string {
  const secrets = [cfg.naver?.clientSecret, cfg.coupang?.secretKey, cfg.coupang?.accessKey, cfg.dataGoKrKey].filter(
    (s): s is string => !!s && s.length >= 6,
  );
  let out = text;
  for (const s of secrets) out = out.split(s).join("[비밀값]");
  return out;
}

/**
 * 설정 파일(settings.env) 읽기. 없으면 예시 파일을 복사해 만들어 둔다.
 * 위치: <데이터 폴더>/settings.env  — 키·비밀값은 이 파일에만 둔다.
 */
export function loadSettingsFile(exampleFile: string): { path: string; created: boolean } {
  const dir = defaultDataDir();
  const path = join(dir, "settings.env");
  let created = false;
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(exampleFile, path);
    created = true;
  }
  process.loadEnvFile(path);
  return { path, created };
}
