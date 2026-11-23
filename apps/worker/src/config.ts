export interface WorkerConfig {
  workerId: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
  naver: { clientId: string; clientSecret: string } | null;
  coupang: { vendorId: string; accessKey: string; secretKey: string; keyIssuedAt: string | null } | null;
  dataGoKrKey: string | null;
  lookbackDays: number;
  dryRun: boolean;
}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`설정 파일(.env)에 ${name} 값이 비어 있습니다.`);
  return v;
}

function opt(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const naverId = opt(env, "NAVER_CLIENT_ID");
  const naverSecret = opt(env, "NAVER_CLIENT_SECRET");
  const cpVendor = opt(env, "COUPANG_VENDOR_ID");
  const cpAccess = opt(env, "COUPANG_ACCESS_KEY");
  const cpSecret = opt(env, "COUPANG_SECRET_KEY");

  const lookback = Number(env.COLLECT_LOOKBACK_DAYS ?? 7);
  return {
    workerId: opt(env, "WORKER_ID") ?? "office-pc",
    supabaseUrl: req(env, "SUPABASE_URL"),
    supabaseSecretKey: req(env, "SUPABASE_SECRET_KEY"),
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
export function redactSecrets(text: string, cfg: WorkerConfig): string {
  const secrets = [
    cfg.supabaseSecretKey,
    cfg.naver?.clientSecret,
    cfg.coupang?.secretKey,
    cfg.coupang?.accessKey,
    cfg.dataGoKrKey,
  ].filter((s): s is string => !!s && s.length >= 6);
  let out = text;
  for (const s of secrets) out = out.split(s).join("[비밀값]");
  return out;
}
