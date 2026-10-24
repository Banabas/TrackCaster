@echo off
rem Gibt den Overlay-Port (Standard 8080) in der Windows-Firewall fuer das lokale Netz frei,
rem damit OBS auf einem zweiten PC das Overlay abrufen kann.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
set PORT=8080
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "(Get-Content -Raw '%~dp0config.json' | ConvertFrom-Json).webPort"`) do set PORT=%%p
netsh advfirewall firewall delete rule name="TrackCaster" >nul 2>&1
netsh advfirewall firewall add rule name="TrackCaster" dir=in action=allow protocol=TCP localport=%PORT% profile=private,domain
echo.
echo Port %PORT% ist fuer private Netzwerke freigegeben.
pause
