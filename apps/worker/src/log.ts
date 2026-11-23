import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { seoulParts } from "@drc/shared";

const LOG_DIR = join(process.cwd(), "worker-data", "logs");
let redact: (s: string) => string = (s) => s;

export function setRedactor(fn: (s: string) => string) {
  redact = fn;
}

function stamp(): string {
  const now = new Date();
  const p = seoulParts(now);
  const hh = String(Math.floor(p.minutes / 60)).padStart(2, "0");
  const mm = String(p.minutes % 60).padStart(2, "0");
  const ss = String(new Date(now.getTime() + 9 * 3600e3).getUTCSeconds()).padStart(2, "0");
  return `${p.date} ${hh}:${mm}:${ss}`;
}

function write(level: string, msg: string) {
  const line = redact(`[${stamp()}] ${level} ${msg}`);
  if (level === "오류") console.error(line);
  else console.log(line);
  if (process.env.VITEST) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, `${stamp().slice(0, 10)}.log`), line + "\n", "utf8");
  } catch {
    /* 로그 파일 실패는 무시 */
  }
}

export const log = {
  info: (m: string) => write("정보", m),
  warn: (m: string) => write("주의", m),
  error: (m: string, e?: unknown) => write("오류", e ? `${m} — ${e instanceof Error ? e.message : String(e)}` : m),
};
