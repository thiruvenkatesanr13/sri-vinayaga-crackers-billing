@echo off
title Sri Vinayaga Billing - server (keep this window open)
cd /d "%~dp0..\backend"
if not exist "..\.venv\Scripts\python.exe" (
  echo Run scripts\install.bat first.
  pause
  exit /b 1
)
:run
"..\.venv\Scripts\python.exe" serve.py
if errorlevel 3 if not errorlevel 4 goto :already
echo.
echo The billing server stopped. It starts again in 10 seconds. Close this window to keep it stopped.
timeout /t 10 /nobreak >nul
goto :run
:already
echo You can close this window.
pause
exit /b 0
