import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Updater } from "../src/updater.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString().trim();

describe("자동 업데이트", () => {
  it("ZIP 설치(git 없음)면 꺼져 있음", async () => {
    const u = new Updater(mkdtempSync(join(tmpdir(), "zip-")), join(tmpdir(), "flag"));
    expect(u.installedWithGit).toBe(false);
    expect((await u.check()).available).toBe(false);
  });

  it("GitHub에 새 버전이 올라오면 알아채고, 표시 파일을 남긴 뒤 종료", async () => {
    const root = mkdtempSync(join(tmpdir(), "upd-"));
    const origin = join(root, "origin.git");
    const dev = join(root, "dev");
    const pc = join(root, "pc");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, dev);
    writeFileSync(join(dev, "a.txt"), "1");
    git(dev, "add", ".");
    git(dev, "commit", "-q", "-m", "v1");
    git(dev, "push", "-q", "origin", "HEAD:main");
    git(root, "clone", "-q", "-b", "main", origin, pc);

    const flag = join(root, "update-requested");
    const u = new Updater(pc, flag);
    expect(u.installedWithGit).toBe(true);
    expect((await u.check()).hasUpdate).toBe(false);

    writeFileSync(join(dev, "a.txt"), "2");
    git(dev, "commit", "-q", "-am", "v2");
    git(dev, "push", "-q", "origin", "HEAD:main");
    const st = await u.check();
    expect(st.hasUpdate).toBe(true);
    expect(st.current).not.toBe(st.latest);

    let exited = false;
    u.requestRestartForUpdate(() => (exited = true));
    expect(existsSync(flag)).toBe(true);
    await new Promise((r) => setTimeout(r, 1700));
    expect(exited).toBe(true);
  });
});
