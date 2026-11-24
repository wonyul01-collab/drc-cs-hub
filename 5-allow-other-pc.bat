@echo off
chcp 65001 >nul
echo ==============================================
echo  DRC CS 허브 - 다른 PC 접속 허용 (메인 PC에서 한 번만)
echo  같은 사무실 네트워크(같은 공유기)에서만 3000번으로 접속을 허용합니다.
echo ==============================================
net session >nul 2>nul
if errorlevel 1 (
  echo [!] 관리자 권한이 필요합니다.
  echo     이 파일을 오른쪽 클릭 - "관리자 권한으로 실행" 을 눌러주세요.
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="DRC CS Hub" >nul 2>nul
netsh advfirewall firewall add rule name="DRC CS Hub" dir=in action=allow protocol=TCP localport=3000 remoteip=localsubnet profile=any
if errorlevel 1 (
  echo [!] 방화벽 설정에 실패했습니다. 이 창을 캡처해서 보내주세요.
  pause
  exit /b 1
)
echo.
echo 완료! 이 PC의 사내망 주소:
ipconfig | findstr /R /C:"IPv4"
echo.
echo 다른 PC 크롬에서  http://위의주소:3000  으로 접속하세요. (localhost 아님)
pause
