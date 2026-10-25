@echo off
rem Starts billing (minimised) every time this Windows user logs in. No admin rights needed.
setlocal
set "TARGET=%~dp0start_billing.bat"
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Sri Vinayaga Billing.lnk"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK); $s.TargetPath = $env:TARGET; $s.WorkingDirectory = (Split-Path $env:TARGET); $s.WindowStyle = 7; $s.Description = 'Sri Vinayaga Crackers billing server'; $s.Save()"
if errorlevel 1 (
  echo Could not create the start-up shortcut.
  pause
  exit /b 1
)
echo Billing will now start by itself when this PC is switched on and you log in.
echo To stop that, delete "Sri Vinayaga Billing" from: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
pause
