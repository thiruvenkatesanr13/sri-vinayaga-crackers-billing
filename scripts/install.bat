@echo off
setlocal
title Sri Vinayaga Billing - install
cd /d "%~dp0.."

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo Python is not installed. Install Python 3.12 or newer from python.org, tick "Add python.exe to PATH", then run this again.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating the Python environment...
  %PY% -m venv .venv || goto :fail
)
echo Installing the billing software...
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --upgrade pip || goto :fail
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r backend\requirements.txt || goto :fail
".venv\Scripts\python.exe" backend\manage.py migrate --noinput || goto :fail

if not exist "backend\frontend_dist\index.html" (
  echo.
  echo The screens are missing from backend\frontend_dist. Copy the full project folder again.
  goto :fail
)

echo.
echo Installed.
echo Next steps:
echo   1. Right-click scripts\allow_network.bat and choose "Run as administrator" (lets the other counters connect).
echo   2. Double-click scripts\start_billing.bat to start billing.
echo   3. Double-click scripts\setup_autostart.bat so billing starts when this PC is switched on.
pause
exit /b 0

:fail
echo.
echo Something went wrong. Take a photo of this window and send it to ElevateYourself.
pause
exit /b 1
