@echo off
rem For the developer: rebuilds the screens into backend\frontend_dist. Needs Node.js 20.19 or newer.
setlocal
cd /d "%~dp0..\frontend"
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from nodejs.org first.
  pause
  exit /b 1
)
call npm.cmd ci --no-audit --no-fund || goto :fail
call npm.cmd run build || goto :fail
echo Screens built into backend\frontend_dist.
exit /b 0
:fail
echo Build failed.
pause
exit /b 1
