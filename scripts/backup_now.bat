@echo off
title Sri Vinayaga Billing - backup now
cd /d "%~dp0..\backend"
"..\.venv\Scripts\python.exe" manage.py backup_now
pause
