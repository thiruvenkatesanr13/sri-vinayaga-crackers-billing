@echo off
rem Opens billing in its own browser window that prints bills straight to the
rem default printer (set the 80 mm thermal printer as the Windows default printer).
rem On another counter PC, change the address below to the billing PC's address.
setlocal
set "URL=http://localhost:8000"
if not "%~1"=="" set "URL=%~1"
set "PROFILE=%LOCALAPPDATA%\SriVinayagaBillingBrowser"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if exist "%CHROME%" (
  start "" "%CHROME%" --user-data-dir="%PROFILE%" --kiosk-printing --start-maximized --app=%URL%
  exit /b 0
)
if exist "%EDGE%" (
  start "" "%EDGE%" --user-data-dir="%PROFILE%" --kiosk-printing --start-maximized --app=%URL%
  exit /b 0
)
start "" %URL%
