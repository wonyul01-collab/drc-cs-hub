@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DRC CS 허브 (이 창을 닫으면 허브가 꺼집니다)
set "FLAG=%USERPROFILE%\DRC-CS-Hub-Data\update-requested"
:loop
if exist "%FLAG%" del "%FLAG%"
if exist ".git" (
  echo 새 버전 확인 중...
  git fetch --quiet origin main
  if errorlevel 1 (
    echo [!] 새 버전 확인 실패 - 지금 버전으로 켭니다.
  ) else (
    git reset --quiet --hard origin/main
    call npx -y pnpm@10.28.0 install --prefer-offline
  )
)
echo.
echo DRC CS 허브를 켭니다... 이 창은 닫지 말고 최소화해 두세요.
call npx -y pnpm@10.28.0 hub
if exist "%FLAG%" (
  echo.
  echo 새 버전으로 다시 켭니다...
  goto loop
)
echo.
echo 허브가 멈췄습니다. 30초 뒤 자동으로 다시 켭니다. (그만두려면 이 창을 닫으세요)
timeout /t 30
goto loop
