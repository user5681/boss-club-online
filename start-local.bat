@echo off
setlocal
cd /d "%~dp0"
start "" "http://localhost:3000"
where node >nul 2>nul
if %errorlevel%==0 (
  node server.mjs
) else (
  ".tools\node-v24.22.1-win-x64\node.exe" server.mjs
)
pause
