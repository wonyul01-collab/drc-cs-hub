/**
 * 자동 업데이트 — 프로그램 폴더가 GitHub 저장소(git)로 설치된 경우에만 동작.
 * 새 버전이 있으면 "업데이트 요청" 표시 파일을 남기고 허브를 종료 →
 * 2-start.bat가 새 버전을 받아(git pull + 설치) 다시 켠다.
 * 데이터·설정은 사용자 폴더(DRC-CS-Hub-Data)에 있어 업데이트와 무관.
 */
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface UpdateStatus {
  available: boolean; // git 설치형인가
  current: string | null;
  latest: string | null;
  hasUpdate: boolean;
  error?: string;
}

function git(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repo, timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().slice(0, 300)));
      else resolve(stdout.toString().trim());
    });
  });
}

export class Updater {
  constructor(
    readonly repoDir: string,
    readonly flagFile: string,
  ) {}

  get installedWithGit(): boolean {
    return existsSync(join(this.repoDir, ".git"));
  }

  async check(): Promise<UpdateStatus> {
    if (!this.installedWithGit) return { available: false, current: null, latest: null, hasUpdate: false };
    try {
      await git(this.repoDir, ["fetch", "--quiet", "origin", "main"]);
      const current = await git(this.repoDir, ["rev-parse", "--short", "HEAD"]);
      const latest = await git(this.repoDir, ["rev-parse", "--short", "origin/main"]);
      return { available: true, current, latest, hasUpdate: current !== latest };
    } catch (e) {
      return { available: true, current: null, latest: null, hasUpdate: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 업데이트 표시를 남기고 종료 → 2-start.bat가 받아서 다시 켬 */
  requestRestartForUpdate(exit: () => void) {
    writeFileSync(this.flagFile, new Date().toISOString(), "utf8");
    setTimeout(exit, 1500); // 화면에 응답을 보낼 시간
  }
}
