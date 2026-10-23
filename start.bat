@echo off
title Factory SNMP Network Monitor
echo ============================================================
echo   KHOI DONG FACTORY SNMP NETWORK MONITOR
echo ============================================================
echo Dang kiem tra Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [LOI] May tinh cua ban chua cai dat Node.js!
    echo Vui long truy cap https://nodejs.org de tai va cai dat Node.js (LTS).
    pause
    exit /b 1
)

echo Node.js da san sang. Dang khoi dong Web App...
node server.js
pause
