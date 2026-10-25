@echo off
title Sri Vinayaga Billing - restore a backup
echo Close the billing server window before restoring.
echo.
cd /d "%~dp0..\backend"
"..\.venv\Scripts\python.exe" manage.py restore_backup %*
pause
