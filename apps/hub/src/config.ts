import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
  smtp: { host: string; port: number; secure: boolean; user: string; pass: string; from: string } | null;
  /** 알림 메일 속 링크 주소 (비우면 이 PC의 사내망 주소) */
  hubUrl: string | null;
}

const SMTP_PRESETS: Record<string, { host: string; port: number; secure: boolean }> = {
  naver: { host: "smtp.naver.com", port: 465, secure: true },
  gmail: { host: "smtp.gmail.com", port: 465, secure: true },
};

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
    smtp: (() => {
      const user = opt(env, "MAIL_USER");
      const pass = opt(env, "MAIL_PASSWORD");
      if (!user || !pass) return null;
      const preset = SMTP_PRESETS[(opt(env, "MAIL_SERVICE") ?? (user.endsWith("@gmail.com") ? "gmail" : "naver")).toLowerCase()];
      const host = opt(env, "MAIL_SMTP_HOST") ?? preset?.host;
      if (!host) return null;
      const port = Number(opt(env, "MAIL_SMTP_PORT") ?? preset?.port ?? 465);
      return { host, port, secure: port === 465, user, pass, from: opt(env, "MAIL_FROM") ?? user };
    })(),
    hubUrl: opt(env, "HUB_URL")?.replace(/\/$/, "") ?? null,
  };
}

/** 로그·오류 메시지에 비밀값이 섞이지 않게 가린다 */
export function redactSecrets(text: string, cfg: HubConfig): string {
  const secrets = [cfg.naver?.clientSecret, cfg.coupang?.secretKey, cfg.coupang?.accessKey, cfg.dataGoKrKey, cfg.smtp?.pass].filter(
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
  else {
    // 예전 설정 파일에 새로 생긴 항목(예: 알림 메일)이 없으면 아래에 덧붙인다 — 기존 값은 그대로
    const cur = readFileSync(path, "utf8");
    const have = new Set([...cur.matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]));
    const lines = readFileSync(exampleFile, "utf8").split(/\r?\n/);
    const missing: string[] = [];
    let comments: string[] = [];
    for (const line of lines) {
      if (/^\s*#/.test(line)) comments.push(line);
      else {
        const m = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
        if (m && !have.has(m[1])) missing.push(...comments, line);
        comments = [];
      }
    }
    if (missing.length) appendFileSync(path, `\r\n\r\n# ─── 새 버전에서 추가된 설정 ───\r\n${missing.join("\r\n")}\r\n`, "utf8");
  }
  process.loadEnvFile(path);
  return { path, created };
}
