@echo off
chcp 65001 >nul
title YinShu AI Banking Copilot (keep this window open)
cd /d "%~dp0"
echo ============================================================
echo   YinShu AI Banking Copilot  -  starting local server
echo   URL: http://127.0.0.1:8787
echo   (keep this window open while demonstrating; close it to stop)
echo ============================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js 18+ first.
  pause
  exit /b 1
)
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8787"
node server\index.js
echo.
echo Server stopped. Press any key to close.
pause >nul
