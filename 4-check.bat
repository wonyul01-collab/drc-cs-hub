@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 네이버·쿠팡 연결을 점검합니다 (읽기만 하고 아무것도 저장/등록하지 않습니다)
call npx -y pnpm@10.28.0 hub:probe
echo.
echo 결과 파일: %USERPROFILE%\DRC-CS-Hub-Data\probe-결과.txt  (이 파일을 개발자에게 보내주세요)
pause
