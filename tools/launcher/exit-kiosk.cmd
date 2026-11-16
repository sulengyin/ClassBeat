@echo off
rem ClassBeat escape hatch. Double-click to leave kiosk fullscreen.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0exit-kiosk.ps1" %*
if errorlevel 1 (
  echo.
  echo Exit failed. See tools\launcher\exit-kiosk.log for details.
  pause
)
