@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DRC CS 허브 (이 창을 닫으면 허브가 꺼집니다)
echo DRC CS 허브를 켭니다... 이 창은 닫지 말고 최소화해 두세요.
call npx -y pnpm@10.28.0 hub
echo.
echo 허브가 꺼졌습니다. 위 메시지를 확인하세요.
pause
