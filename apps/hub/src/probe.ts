/**
 * 연결 점검 도구 — 사무실 PC에서 한 번 실행:  pnpm worker:probe
 * 각 마켓 API를 "읽기 전용"으로 1번씩 호출해서
 *   - 접속 성공 여부 (IP 등록·키 확인)
 *   - 가져온 건수
 *   - 응답에 들어있는 필드 이름 (값은 출력하지 않음 → 개발자에게 보내도 안전)
 * 을 보여주고 데이터 폴더의 probe-결과.txt 로 저장합니다. DB에는 아무것도 쓰지 않습니다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, loadSettingsFile, redactSecrets } from "./config.ts";
import { coupangSources } from "./coupang/sources.ts";
import { naverSources } from "./naver/sources.ts";
import type { InquirySource } from "./source.ts";

async function main() {
  loadSettingsFile(resolve(import.meta.dirname, "../.env.example"));
  const cfg = loadConfig();
  const sources: InquirySource[] = [];
  if (cfg.naver) sources.push(...naverSources(cfg.naver));
  if (cfg.coupang) sources.push(...coupangSources(cfg.coupang));

  const lines: string[] = [`DRC CS 허브 연결 점검 — ${new Date().toISOString()}`, ""];
  const out = (s: string) => {
    const safe = redactSecrets(s, cfg);
    console.log(safe);
    lines.push(safe);
  };

  if (!sources.length) out("⚠ 네이버·쿠팡 키가 하나도 없습니다. .env 파일을 확인하세요.");

  const to = new Date();
  for (const s of sources) {
    // 조회 가능한 최대 기간으로 (네이버 29일, 쿠팡 6일)
    const days = Math.max(1, s.maxWindowDays - 1);
    const from = new Date(to.getTime() - days * 86400e3);
    out(`■ ${s.label}`);
    try {
      const { rows, rawKeys, shape, request } = await s.fetch(from, to);
      out(`  ✅ 접속 성공 — 최근 ${days}일 ${rows.length}건`);
      if (request) out(`  요청: ${request}`);
      if (shape) out(`  응답 구조: ${shape}`);
      out(`  필드: ${rawKeys.join(", ") || "(문의 없음)"}`);
      const answered = rows.filter((r) => r.platform_answered).length;
      out(`  이미 답변됨: ${answered}건 / 개인정보 포함: ${rows.filter((r) => r.pii_detected).length}건`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out(`  ❌ 실패: ${msg}`);
      if (/IP|403/i.test(msg)) out("  → 이 PC의 IP가 판매자센터 API 설정에 등록되어 있는지 확인하세요.");
      if (/401|auth|token|sign/i.test(msg)) out("  → 키(ID/시크릿)가 정확한지 확인하세요.");
    }
    out("");
  }

  const dir = cfg.dataDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "probe-결과.txt"), lines.join("\n"), "utf8");
  console.log(`결과를 ${join(dir, "probe-결과.txt")} 에 저장했습니다.`);
}

main().catch((e) => {
  console.error("점검 실행 실패:", e instanceof Error ? e.message : e);
  process.exit(1);
});
