@echo off
title Sri Vinayaga Billing - delete everything (fresh start)
echo Deletes EVERYTHING on this PC: people and PINs, shop settings, counters, products, stock, bills,
echo bookings, customers, purchases, expenses and day closings. Billing then starts from the Set up screen.
echo Backups stay. A copy of the data is saved first, so this can be undone.
echo.
cd /d "%~dp0..\backend"
"..\.venv\Scripts\python.exe" manage.py clear_data %*
pause
