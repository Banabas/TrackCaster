@echo off
cd /d "%~dp0"
title TrackCaster
if not exist node_modules (
  echo Installiere Abhaengigkeiten ...
  call npm install --omit=dev
)
node server.js
pause
