@echo off
chcp 65001 >nul
set "DATA=%USERPROFILE%\DRC-CS-Hub-Data"
if not exist "%DATA%\settings.env" (
  if not exist "%DATA%" mkdir "%DATA%"
  copy "%~dp0apps\hub\.env.example" "%DATA%\settings.env" >nul
)
echo 설정 파일을 엽니다: %DATA%\settings.env
echo 저장한 뒤 허브를 껐다 켜야 적용됩니다.
start "" notepad "%DATA%\settings.env"
