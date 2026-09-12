@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "fzu-oneclick.local.js" (
  copy /Y "fzu-exam-browser.js" "fzu-oneclick.local.js" >nul
  echo Personal config created. Notepad will open now.
  echo Edit phone number and password at the bottom, save, then run this file again.
  start "" notepad "fzu-oneclick.local.js"
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js first.
  pause
  exit /b 1
)
node "fzu-oneclick.local.js"
if errorlevel 1 pause
