@echo off
REM Open Industry Project - Simulator launcher, PROD mode: the built app (dist/), no dev server.
REM Build first with `npm run build` in the repo root. Starts electron.exe directly - no npm, no
REM Vite - and main.cjs serves dist/ over its own oip:// scheme, as an installed app does
REM (OIP_DESKTOP_PROD, distProtocol.cjs). Launch times: launch-times.log
REM under %APPDATA%\<app name>.
setlocal
set "HERE=%~dp0"
set "ELECTRON_RUN_AS_NODE="
set "DESKTOP_URL="
set "OIP_DESKTOP_PROD=1"
if not exist "%HERE%..\..\dist\app\index.html" (
  mshta "javascript:alert('Open Industry Project: no production build yet. Open a terminal in the repo root and run: npm run build');close()"
  exit /b 1
)
start "" "%HERE%node_modules\electron\dist\electron.exe" "%HERE%."
