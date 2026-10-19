@echo off
REM Open Industry Project - Simulator launcher (Electron desktop shell).
REM Invoked by launch.vbs with a hidden console, so nothing flashes on screen.
setlocal
set "HERE=%~dp0"
set "ROOT=%HERE%..\.."
REM Clear the flag VS Code/terminals can inherit that makes Electron run as plain Node
REM (require('electron') returns a path string -> "Cannot read properties of undefined (reading 'whenReady')").
set "ELECTRON_RUN_AS_NODE="

REM Start the Vite dev server only if nothing is already serving on :5173.
REM /b keeps it in this (hidden) console so it doesn't pop its own window.
curl -s -o nul http://localhost:5173/
if errorlevel 1 start "" /b cmd /c npm --prefix "%ROOT%" run dev

REM Wait (up to ~90s) for the dev server to respond before opening the window.
for /l %%i in (1,1,90) do (
  curl -s -o nul http://localhost:5173/ && goto ready
  timeout /t 1 /nobreak >nul
)
REM No console is visible, so surface the failure as a dialog instead of a dead `pause`.
mshta "javascript:alert('Open Industry Project: the dev server did not start in time. Open a terminal in the repo root and run: npm run dev');close()"
exit /b 1

:ready
cd /d "%HERE%"
call npm start
