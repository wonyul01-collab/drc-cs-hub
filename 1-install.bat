@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo  DRC CS 허브 - 설치 (처음 한 번, 새 버전 받은 뒤 한 번)
echo ==============================================
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js 가 설치되어 있지 않습니다.
  echo     https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo [!] Node.js 버전이 낮습니다. https://nodejs.org 에서 최신 LTS 를 설치하세요.
  pause
  exit /b 1
)
call npx -y pnpm@10.28.0 install
if errorlevel 1 (
  echo [!] 설치 중 오류가 났습니다. 이 창을 캡처해서 보내주세요.
  pause
  exit /b 1
)
echo.
echo 설치 완료! 이제 2-start.bat 을 더블클릭하세요.
pause
