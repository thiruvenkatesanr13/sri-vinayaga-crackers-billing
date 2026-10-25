@echo off
rem For a forgotten PIN (also the owner's). Run it on the billing laptop (Counter 1).
title Sri Vinayaga Billing - set a new PIN
cd /d "%~dp0..\backend"
"..\.venv\Scripts\python.exe" manage.py reset_pin %*
pause
