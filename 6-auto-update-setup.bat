@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo  DRC CS 허브 - 자동 업데이트 켜기 (처음 한 번만)
echo  이후로는 ZIP 덮어쓰기 없이 자동으로 새 버전을 받습니다.
echo ==============================================
where git >nul 2>nul
if errorlevel 1 (
  echo [!] Git 이 설치되어 있지 않습니다.
  echo     https://git-scm.com/download/win 에서 설치(계속 [Next])한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
if not exist ".git" (
  git init -q -b main
  git remote add origin https://github.com/wonyul01-collab/drc-cs-hub.git
)
echo.
echo GitHub 로그인 창이 뜨면 로그인해 주세요 (처음 한 번만).
git fetch origin main
if errorlevel 1 (
  echo [!] GitHub 에서 받지 못했습니다. 로그인 했는지, 인터넷 연결을 확인하세요.
  pause
  exit /b 1
)
git reset --hard origin/main
call npx -y pnpm@10.28.0 install
echo.
echo 완료! 이제 열려 있는 허브 검은 창을 닫고 2-start.bat 을 다시 실행하세요.
echo 앞으로는 평일 08:40 에 새 버전이 있으면 자동으로 업데이트됩니다.
pause
