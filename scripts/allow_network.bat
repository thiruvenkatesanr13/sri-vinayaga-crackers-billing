@echo off
rem Lets phones and other PCs on the shop Wi-Fi open billing on port 8000.
rem Only for "Private" networks. Mark the shop Wi-Fi / hotspot as Private in Windows settings.
net session >nul 2>&1
if errorlevel 1 (
  echo Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="Sri Vinayaga Billing" >nul 2>&1
netsh advfirewall firewall add rule name="Sri Vinayaga Billing" dir=in action=allow protocol=TCP localport=8000 profile=private
if errorlevel 1 (
  echo Could not add the firewall rule.
  pause
  exit /b 1
)
echo Done. Other counters on the shop Wi-Fi can now open billing.
echo Make sure the Wi-Fi network is set to "Private" in Windows Settings, Network and internet.
pause
