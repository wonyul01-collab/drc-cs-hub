import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadSettingsFile } from "../src/config.ts";

describe("설정 파일", () => {
  it("예전 설정 파일에 없던 새 항목(알림 메일)만 덧붙이고 기존 값은 그대로", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    process.env.DATA_DIR = dir;
    writeFileSync(join(dir, "settings.env"), "NAVER_CLIENT_ID=abc\nDRY_RUN=true\n");
    const example = join(import.meta.dirname, "../.env.example");
    loadSettingsFile(example);
    const text = readFileSync(join(dir, "settings.env"), "utf8");
    expect(text).toContain("NAVER_CLIENT_ID=abc");
    expect(text).toContain("MAIL_USER=");
    expect(text.match(/NAVER_CLIENT_ID=/g)).toHaveLength(1);
    loadSettingsFile(example); // 두 번째는 아무것도 안 붙임
    expect(readFileSync(join(dir, "settings.env"), "utf8")).toBe(text);
    delete process.env.DATA_DIR;
  });

  it("메일 설정: 네이버·Gmail 자동 인식", () => {
    expect(loadConfig({ MAIL_USER: "a@naver.com", MAIL_PASSWORD: "x" }).smtp).toMatchObject({ host: "smtp.naver.com", port: 465, secure: true });
    expect(loadConfig({ MAIL_USER: "a@gmail.com", MAIL_PASSWORD: "x" }).smtp).toMatchObject({ host: "smtp.gmail.com" });
    expect(loadConfig({}).smtp).toBeNull();
  });
});
