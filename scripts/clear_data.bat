@echo off
title Sri Vinayaga Billing - delete all shop data (fresh start)
echo Deletes products, stock, bills, bookings, customers, purchases, expenses and day closings.
echo People, PINs, shop settings, counters and backups stay. A copy of the data is saved first.
echo.
cd /d "%~dp0..\backend"
"..\.venv\Scripts\python.exe" manage.py clear_data %*
pause
