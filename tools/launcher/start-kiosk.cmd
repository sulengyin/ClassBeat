@echo off
rem ClassBeat kiosk launcher. Double-click to start service + full screen page.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-kiosk.ps1" %*
if errorlevel 1 (
  echo.
  echo Start failed. See tools\launcher\launcher.log for details.
  pause
)
